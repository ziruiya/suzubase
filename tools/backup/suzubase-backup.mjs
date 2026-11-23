#!/usr/bin/env node
// SuzuBase deployment backup / restore CLI (contracts ch.5 SS5.3, Gate 3 G3-13).
//
//   node tools/backup/suzubase-backup.mjs create   [--name <label>]
//   node tools/backup/suzubase-backup.mjs verify   <backup-set-dir>
//   node tools/backup/suzubase-backup.mjs restore  <backup-set-dir>
//   node tools/backup/suzubase-backup.mjs list
//
// A backup set is a directory containing:
//   database.dump   PostgreSQL custom-format dump (pg_dump -Fc, native tooling)
//   attachments/    copy of the attachment directory (Storage Adapter root)
//   config/         copies of the deployment config files listed in
//                   SUZUBASE_CONFIG_FILES (comma-separated host paths)
//   manifest.json   versions, file list with SHA-256 hashes, counts
//
// Boundary (contracts SS5.3.1): a deployment backup set is disaster recovery
// for ONE deployment. It is NOT a migration tool. The M1 single-application
// package (Import/Export) is the migration tool, and an M1 package is NOT a
// disaster backup. Neither substitutes for the other.
//
// Backup sets contain complete business data: handle as SENSITIVE DATA.
//
// Configuration (environment):
//   SUZUBASE_BACKUP_DIR        where backup sets live (default ./backups)
//   SUZUBASE_BACKUP_RETENTION  sets to keep after a successful create (default 7)
//   SUZUBASE_BACKUP_LOG        deployment log file (default <backup dir>/backup.log)
//   ADMIN_DATABASE_URL         admin connection for pg_dump / pg_restore
//   ATTACHMENT_DIRECTORY       attachment root on this host (direct mode)
//   SUZUBASE_CONFIG_FILES      comma-separated config files to include
//   SUZUBASE_APP_VERSION       semantic application version stamped into the
//                              manifest (e.g. "1.1.0"). A non-semver value is
//                              NEVER used as appVersion: deployments have
//                              stamped git short SHAs here, which made every
//                              set fail the restore version gate. A non-semver
//                              value is recorded as buildCommit instead.
//                              Default: the repository root package.json
//                              "version" (kept in sync with PROGRAM_VERSION in
//                              apps/api/src/import.ts), else "unknown".
//   SUZUBASE_BUILD_COMMIT      build commit recorded in the manifest as
//                              metadata only; never used as appVersion.
//   SUZUBASE_HEALTH_URL        health endpoint checked after restore
//   SUZUBASE_PG_DUMP_CMD / SUZUBASE_PG_RESTORE_CMD / SUZUBASE_PGSQL_CMD
//                              command templates for containerised deployments,
//                              e.g. "docker exec -i <pg> pg_dump -U suzubase -d suzubase -Fc".
//                              {file} is replaced by the dump path (host side for
//                              dump/restore streaming through stdio by default).
//   SUZUBASE_ATTACH_EXPORT_CMD / SUZUBASE_ATTACH_IMPORT_CMD
//                              command templates copying attachments out of /
//                              into the running deployment ({dir} = staging dir).
//
// Failure behaviour (decision 9): any failure appends the reason to the
// deployment log, writes an admin alert record to <backup dir>/alerts.jsonl
// (one line per tenant administrator, resolved from the database when
// reachable -- the in-app notification channel for deployment tooling), and
// exits non-zero. Failures never pass silently.
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BACKUP_FORMAT = 'suzubase-backup-set/1';
const SUPPORTED_APP_MAJORS = ['1'];

const backupDir = resolve(process.env.SUZUBASE_BACKUP_DIR ?? './backups');
const retention = Number(process.env.SUZUBASE_BACKUP_RETENTION ?? 7);
const logFile = resolve(process.env.SUZUBASE_BACKUP_LOG ?? join(backupDir, 'backup.log'));

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Resolve the version facts stamped into a new backup set's manifest.
// appVersion must stay a semantic version: the restore gate reads its major.
// A non-semver SUZUBASE_APP_VERSION (e.g. a git short SHA such as "3528953")
// is build metadata and is diverted to buildCommit.
function deploymentVersion() {
  const envVersion = process.env.SUZUBASE_APP_VERSION?.trim();
  let appVersion = null;
  let buildCommit = process.env.SUZUBASE_BUILD_COMMIT?.trim() || null;
  if (envVersion) {
    if (SEMVER_PATTERN.test(envVersion)) appVersion = envVersion;
    else if (!buildCommit) buildCommit = envVersion;
  }
  if (!appVersion) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
      if (pkg.version && SEMVER_PATTERN.test(String(pkg.version))) appVersion = String(pkg.version);
    } catch { /* no readable package.json: fall through to "unknown" */ }
  }
  return { appVersion: appVersion ?? 'unknown', buildCommit };
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.error(stamped);
  try { mkdirSync(backupDir, { recursive: true }); appendFileSync(logFile, stamped + '\n'); } catch { /* log is best-effort */ }
}

function recordStatus(state, details = {}) {
  try {
    mkdirSync(backupDir, { recursive: true });
    let previous = {};
    const statusFile = join(backupDir, 'status.json');
    if (existsSync(statusFile)) {
      try { previous = JSON.parse(readFileSync(statusFile, 'utf8')); } catch { previous = {}; }
    }
    const now = new Date().toISOString();
    writeFileSync(join(backupDir, 'status.json'), JSON.stringify({
      state,
      recentSuccessAt: state === 'success' ? now : previous.recentSuccessAt ?? null,
      recentFailureAt: state === 'failed' ? now : previous.recentFailureAt ?? null,
      ...details,
      updatedAt: now,
    }, null, 2));
  } catch (error) {
    log(`STATUS WRITE FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deliverPendingAlerts() {
  const outboxFile = join(backupDir, 'system-alert-outbox.jsonl');
  const deliveredFile = join(backupDir, 'system-alert-delivered.jsonl');
  if (!existsSync(outboxFile)) return;
  const url = process.env.SUZUBASE_SYSTEM_NOTIFICATION_URL;
  const secret = process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
  if (!url || !secret) {
    log('SYSTEM ALERT: notification service not configured; alert retained for retry');
    return;
  }
  const delivered = new Set(existsSync(deliveredFile)
    ? readFileSync(deliveredFile, 'utf8').split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line).sourceEventId; } catch { return null; }
      }).filter(Boolean)
    : []);
  const lines = readFileSync(outboxFile, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { log('SYSTEM ALERT: malformed pending event retained'); continue; }
    if (delivered.has(event.sourceEventId)) continue;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-suzubase-system-secret': secret },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`notification service returned HTTP ${response.status}`);
      mkdirSync(backupDir, { recursive: true });
      appendFileSync(deliveredFile, JSON.stringify({ sourceEventId: event.sourceEventId, deliveredAt: new Date().toISOString() }) + '\n');
      log(`SYSTEM ALERT delivered: ${event.dedupKey}`);
    } catch (error) {
      log(`SYSTEM ALERT pending retry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function alertAdmins(reason, context) {
  const occurredAt = new Date().toISOString();
  const operation = typeof context.operation === 'string' ? context.operation : 'unknown';
  const sourceEventId = randomUUID();
  const dedupKey = typeof context.name === 'string' && context.name
    ? `backup:${operation}:${context.name}`
    : `backup:${operation}:${sourceEventId}`;
  const alert = { at: occurredAt, kind: 'backup-alert', reason, context, audience: 'tenant-administrators',
    sourceEventId, dedupKey };
  const systemEvent = {
    tenantId: process.env.SUZUBASE_TENANT_ID,
    sourceEventId,
    dedupKey,
    eventType: 'BACKUP_FAILED',
    occurredAt,
    targetRole: 'TENANT_ADMIN',
    payload: { operation: ['create', 'verify', 'restore', 'list'].includes(operation) ? operation : 'list', status: 'failed' },
  };
  try {
    mkdirSync(backupDir, { recursive: true });
    appendFileSync(join(backupDir, 'alerts.jsonl'), JSON.stringify(alert) + '\n');
    if (systemEvent.tenantId) appendFileSync(join(backupDir, 'system-alert-outbox.jsonl'), JSON.stringify(systemEvent) + '\n');
  } catch (error) {
    throw new Error(`local alert evidence/pending delivery write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await deliverPendingAlerts();
  log(`ALERT (tenant administrators): ${reason}`);
}

async function fail(reason, context = {}) {
  log(`FAILED: ${reason}`);
  recordStatus('failed', { reason: String(reason).slice(0, 500) });
  try {
    await alertAdmins(reason, { operation: process.argv[2] === 'create' ? 'create'
      : process.argv[2] === 'verify' ? 'verify'
      : process.argv[2] === 'restore' ? 'restore'
      : 'list', ...context });
  } catch (error) {
    log(`ALERT FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

const sha256File = async (path) => {
  const { createReadStream } = await import('node:fs');
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex'))).on('error', reject);
  });
};

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, base));
    else out.push({ path, rel: path.slice(base.length + 1), bytes: statSync(path).size });
  }
  return out;
}

function shellCommand(template, replacements) {
  let command = template;
  for (const [key, value] of Object.entries(replacements)) command = command.split(`{${key}}`).join(value);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, stdio: ['inherit', 'inherit', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`command failed (${code}): ${command}`))));
    child.on('error', reject);
  });
}

async function dumpDatabase(targetFile) {
  if (process.env.SUZUBASE_PG_DUMP_CMD) {
    await shellCommand(process.env.SUZUBASE_PG_DUMP_CMD, { file: targetFile });
    return;
  }
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('ADMIN_DATABASE_URL is not set and no SUZUBASE_PG_DUMP_CMD was given');
  await run('pg_dump', ['-Fc', '-f', targetFile, url], { maxBuffer: 1024 * 1024 * 64 });
}

async function restoreDatabase(dumpFile) {
  if (process.env.SUZUBASE_PG_RESTORE_CMD) {
    await shellCommand(process.env.SUZUBASE_PG_RESTORE_CMD, { file: dumpFile });
    return;
  }
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('ADMIN_DATABASE_URL is not set and no SUZUBASE_PG_RESTORE_CMD was given');
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '-d', url, dumpFile], { maxBuffer: 1024 * 1024 * 64 });
}

async function databaseFacts() {
  // Migration count + instance id, read through psql when available; in
  // container mode the caller may stamp SUZUBASE_DB_MIGRATIONS instead.
  const facts = { migrations: process.env.SUZUBASE_DB_MIGRATIONS ? Number(process.env.SUZUBASE_DB_MIGRATIONS) : null };
  if (process.env.SUZUBASE_PGSQL_CMD) {
    const out = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.env.SUZUBASE_PGSQL_CMD + ` -Atc "SELECT count(*) FROM drizzle.__drizzle_migrations"`,
        { shell: true });
      let text = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.on('exit', (code) => (code === 0 ? resolvePromise(text.trim()) : reject(new Error('psql facts failed'))));
      child.on('error', reject);
    }).catch(() => null);
    if (out) facts.migrations = Number(out);
  }
  return facts;
}

async function copyAttachmentsOut(stagingDir) {
  if (process.env.SUZUBASE_ATTACH_EXPORT_CMD) {
    await shellCommand(process.env.SUZUBASE_ATTACH_EXPORT_CMD, { dir: stagingDir });
    return;
  }
  const root = process.env.ATTACHMENT_DIRECTORY;
  if (!root || !existsSync(root)) throw new Error('ATTACHMENT_DIRECTORY missing and no SUZUBASE_ATTACH_EXPORT_CMD was given');
  cpSync(root, stagingDir, { recursive: true });
}

async function copyAttachmentsIn(sourceDir) {
  if (process.env.SUZUBASE_ATTACH_IMPORT_CMD) {
    await shellCommand(process.env.SUZUBASE_ATTACH_IMPORT_CMD, { dir: sourceDir });
    return;
  }
  const root = process.env.ATTACHMENT_DIRECTORY;
  if (!root) throw new Error('ATTACHMENT_DIRECTORY missing and no SUZUBASE_ATTACH_IMPORT_CMD was given');
  mkdirSync(root, { recursive: true });
  cpSync(sourceDir, root, { recursive: true });
}

async function buildManifest(setDir) {
  const files = [];
  for (const part of ['database.dump', 'attachments', 'config']) {
    const path = join(setDir, part);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      for (const entry of walk(path)) files.push({ path: `${part}/${entry.rel}`, sha256: await sha256File(entry.path), bytes: entry.bytes });
    } else {
      files.push({ path: part, sha256: await sha256File(path), bytes: statSync(path).size });
    }
  }
  return files;
}

async function verifySet(setDir) {
  const manifestPath = join(setDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('manifest.json missing: not a backup set');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== BACKUP_FORMAT) throw new Error(`unsupported backup format ${manifest.format}`);
  const problems = [];
  for (const file of manifest.files) {
    const path = join(setDir, file.path);
    if (!existsSync(path)) { problems.push(`missing ${file.path}`); continue; }
    const actual = await sha256File(path);
    if (actual !== file.sha256) problems.push(`hash mismatch ${file.path}`);
    if (statSync(path).size !== file.bytes) problems.push(`size mismatch ${file.path}`);
  }
  // Readability of the dump itself (pg_restore --list) when a pg_restore
  // binary is available on this host; in container mode the restore-time
  // pg_restore run is the readability proof, and hashes still apply here.
  const dumpPath = join(setDir, 'database.dump');
  if (existsSync(dumpPath) && !process.env.SUZUBASE_PG_RESTORE_CMD) {
    const available = await run('pg_restore', ['--version']).then(() => true).catch(() => false);
    if (available) {
      await run('pg_restore', ['--list', dumpPath], { maxBuffer: 1024 * 1024 * 64 })
        .catch(() => problems.push('database.dump is not readable by pg_restore'));
    }
  }
  return { manifest, problems };
}

async function create(label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `backup-${stamp}${label ? '-' + label : ''}`;
  const setDir = join(backupDir, name);
  mkdirSync(join(setDir, 'attachments'), { recursive: true });
  mkdirSync(join(setDir, 'config'), { recursive: true });
  try {
    await dumpDatabase(join(setDir, 'database.dump'));
    await copyAttachmentsOut(join(setDir, 'attachments'));
    for (const configFile of (process.env.SUZUBASE_CONFIG_FILES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (existsSync(configFile)) cpSync(configFile, join(setDir, 'config', basename(configFile)));
    }
    const facts = await databaseFacts();
    const versionFacts = deploymentVersion();
    const manifest = {
      format: BACKUP_FORMAT, name, createdAt: new Date().toISOString(),
      sensitiveData: true,
      notice: 'This backup set contains complete business data. Store and transfer it as sensitive data.',
      appVersion: versionFacts.appVersion,
      ...(versionFacts.buildCommit ? { buildCommit: versionFacts.buildCommit } : {}),
      databaseMigrations: facts.migrations,
      files: await buildManifest(setDir),
    };
    writeFileSync(join(setDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    // Automatic integrity verification right after creation (SS5.3.2).
    const { problems } = await verifySet(setDir);
    if (problems.length) throw new Error('post-create verification failed: ' + problems.join('; '));
    log(`created + verified backup set ${name} (${manifest.files.length} files)`);
    recordStatus('success', { operation: 'create', backupSet: name });
    // Retention: keep the newest N sets.
    const sets = readdirSync(backupDir).filter((entry) => entry.startsWith('backup-')).sort();
    for (const stale of sets.slice(0, Math.max(0, sets.length - retention))) {
      rmSync(join(backupDir, stale), { recursive: true, force: true });
      log(`retention: removed old backup set ${stale}`);
    }
    console.log(JSON.stringify({ created: name, files: manifest.files.length, verified: true }));
  } catch (error) {
    rmSync(setDir, { recursive: true, force: true });
    await fail(`backup creation failed: ${error instanceof Error ? error.message : String(error)}`, { name });
  }
}

async function restore(setDir) {
  try {
    const { manifest, problems } = await verifySet(setDir);
    if (problems.length) throw new Error('backup set verification failed: ' + problems.join('; '));
    // Pre-restore version compatibility check (SS5.3.2): refuse unsupported
    // application-version / database-migration combinations explicitly.
    const major = String(manifest.appVersion).split('.')[0];
    if (manifest.appVersion !== 'unknown' && !SUPPORTED_APP_MAJORS.includes(major)) {
      throw new Error(`unsupported application version in backup set: ${manifest.appVersion} (this tool restores majors ${SUPPORTED_APP_MAJORS.join(', ')})`);
    }
    const current = await databaseFacts();
    if (manifest.databaseMigrations != null && current.migrations != null && manifest.databaseMigrations > current.migrations) {
      throw new Error(`backup database is NEWER than this deployment (${manifest.databaseMigrations} > ${current.migrations} migrations): upgrade the deployment first, restore refused`);
    }
    await restoreDatabase(join(setDir, 'database.dump'));
    await copyAttachmentsIn(join(setDir, 'attachments'));
    // Ownership normalization (REQUIRED after every restore — see
    // tools/backup/README.md): pg_restore recreated objects owned by the
    // restoring role; hand them back to the migration role so the restored
    // deployment matches a fresh deployment and can migrate again.
    // SUZUBASE_POST_RESTORE_SQL_CMD receives {file} = the SQL file path.
    if (process.env.SUZUBASE_POST_RESTORE_SQL_CMD) {
      const sqlPath = new URL('./post-restore-normalize.sql', import.meta.url).pathname;
      await shellCommand(process.env.SUZUBASE_POST_RESTORE_SQL_CMD, { file: sqlPath });
    }
    // Health check + core smoke after restore.
    const healthUrl = process.env.SUZUBASE_HEALTH_URL;
    if (healthUrl) {
      let ok = false;
      for (let i = 0; i < 15 && !ok; i++) {
        try { const response = await fetch(healthUrl); ok = response.ok; } catch { /* retry */ }
        if (!ok) await new Promise((done) => setTimeout(done, 2000));
      }
      if (!ok) throw new Error(`health check failed after restore: ${healthUrl}`);
    }
    log(`restored backup set ${manifest.name} and passed post-restore checks`);
    console.log(JSON.stringify({ restored: manifest.name, health: healthUrl ? 'ok' : 'skipped' }));
  } catch (error) {
    await fail(`restore failed: ${error instanceof Error ? error.message : String(error)}`, { setDir });
  }
}

async function list() {
  if (!existsSync(backupDir)) { console.log(JSON.stringify([])); return; }
  const sets = [];
  for (const entry of readdirSync(backupDir).filter((name) => name.startsWith('backup-')).sort()) {
    const manifestPath = join(backupDir, entry, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    sets.push({ name: entry, createdAt: manifest.createdAt, appVersion: manifest.appVersion,
      databaseMigrations: manifest.databaseMigrations, files: manifest.files.length, sensitiveData: true });
  }
  console.log(JSON.stringify(sets, null, 2));
}

await deliverPendingAlerts();
const [command, arg] = process.argv.slice(2);
if (command === 'create') await create(arg === '--name' ? process.argv[4] : undefined);
else if (command === 'verify') {
  if (!arg) await fail('verify requires a backup set directory');
  const { manifest, problems } = await verifySet(resolve(arg)).catch(async (error) => {
    await fail(`verify failed: ${error.message}`, { setDir: arg });
  });
  if (problems.length) await fail('verify problems: ' + problems.join('; '), { setDir: arg });
  console.log(JSON.stringify({ verified: manifest.name, files: manifest.files.length, problems }));
} else if (command === 'restore') {
  if (!arg) await fail('restore requires a backup set directory');
  await restore(resolve(arg));
} else if (command === 'list') await list();
else if (command === 'retry-alerts') {
  await deliverPendingAlerts();
  console.log(JSON.stringify({ retried: true }));
}
else if (command === 'missed-schedule') {
  await fail('scheduled backup did not run within the configured threshold', { name: 'scheduler-watchdog' });
}
else {
  console.error('usage: suzubase-backup.mjs create [--name label] | verify <dir> | restore <dir> | list | retry-alerts | missed-schedule');
  process.exit(2);
}
