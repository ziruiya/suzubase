// P4-T4 backup version-stamping discipline: the manifest appVersion must
// always be a semantic version. Deployments previously stamped the git short
// SHA (e.g. "3528953") via SUZUBASE_APP_VERSION, which made every set fail
// the restore version gate (major "3528953" is not in SUPPORTED_APP_MAJORS).
// A non-semver value is build metadata: it lands in buildCommit, never in
// appVersion. The restore gates themselves are unchanged (see gate3-backup).
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const cli = resolve(__dirname, '../../../tools/backup/suzubase-backup.mjs');
const repoRoot = resolve(__dirname, '../../..');
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

async function cliRun(args, env) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  delete env.SUZUBASE_APP_VERSION;
  delete env.SUZUBASE_BUILD_COMMIT;
  return { ...env, ...extra };
}

// Minimal container-mode create: the pg_dump command is stubbed with a file
// copy, migrations are caller-stamped, attachments come from a plain dir.
function createEnv(dir, extra = {}) {
  const attach = join(dir, 'attach-src');
  mkdirSync(attach, { recursive: true });
  writeFileSync(join(attach, 'hello.txt'), 'attachment-body');
  const fakeDump = join(dir, 'fake.dump');
  writeFileSync(fakeDump, 'not-a-real-pg-dump');
  return cleanEnv({
    SUZUBASE_BACKUP_DIR: join(dir, 'backups'),
    ATTACHMENT_DIRECTORY: attach,
    SUZUBASE_PG_DUMP_CMD: `cp ${fakeDump} {file}`,
    // Any value marks container mode: verifySet then skips the host
    // pg_restore readability probe (the stub dump is not a real archive).
    SUZUBASE_PG_RESTORE_CMD: 'true',
    SUZUBASE_DB_MIGRATIONS: '52',
    ...extra,
  });
}

async function createAndReadManifest(env) {
  const result = await cliRun(['create', '--name', 't4-test'], env);
  assert.equal(result.code, 0, result.stderr);
  const backupDir = env.SUZUBASE_BACKUP_DIR;
  const sets = readdirSync(backupDir).filter((entry) => entry.startsWith('backup-'));
  assert.equal(sets.length, 1);
  return JSON.parse(readFileSync(join(backupDir, sets[0], 'manifest.json'), 'utf8'));
}

test('P4-T4 root package.json version stays in sync with PROGRAM_VERSION', () => {
  const importTs = readFileSync(join(repoRoot, 'apps/api/src/import.ts'), 'utf8');
  const match = importTs.match(/PROGRAM_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'/);
  assert.ok(match, 'PROGRAM_VERSION not found in import.ts');
  assert.equal(pkgVersion, match[1]);
});

test('P4-T4 create stamps the semantic package version by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-t4-'));
  const manifest = await createAndReadManifest(createEnv(dir));
  assert.equal(manifest.appVersion, pkgVersion);
  assert.match(manifest.appVersion, /^[0-9]+\.[0-9]+\.[0-9]+/);
  assert.equal(manifest.buildCommit, undefined);
  assert.equal(manifest.databaseMigrations, 52);
});

test('P4-T4 a git short SHA in SUZUBASE_APP_VERSION is diverted to buildCommit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-t4-'));
  const manifest = await createAndReadManifest(createEnv(dir, { SUZUBASE_APP_VERSION: '3528953' }));
  assert.equal(manifest.appVersion, pkgVersion);
  assert.equal(manifest.buildCommit, '3528953');
});

test('P4-T4 an explicit semantic SUZUBASE_APP_VERSION wins; SUZUBASE_BUILD_COMMIT is metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-t4-'));
  const manifest = await createAndReadManifest(createEnv(dir, {
    SUZUBASE_APP_VERSION: '1.2.3',
    SUZUBASE_BUILD_COMMIT: 'abc1234',
  }));
  assert.equal(manifest.appVersion, '1.2.3');
  assert.equal(manifest.buildCommit, 'abc1234');
});

test('P4-T4 restore still refuses a short-SHA-stamped set at gate 1 (gate not loosened)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-t4-'));
  const backupDir = join(dir, 'backups');
  const setDir = join(backupDir, 'backup-old-sha-set');
  mkdirSync(join(setDir, 'config'), { recursive: true });
  const body = 'APP_VERSION=3528953\n';
  writeFileSync(join(setDir, 'config', 'deploy.env'), body);
  const sha = createHash('sha256').update(body).digest('hex');
  writeFileSync(join(setDir, 'manifest.json'), JSON.stringify({
    format: 'suzubase-backup-set/1', name: 'backup-old-sha-set', createdAt: new Date().toISOString(),
    sensitiveData: true, appVersion: '3528953', databaseMigrations: 34,
    files: [{ path: 'config/deploy.env', sha256: sha, bytes: body.length }],
  }, null, 2));
  const result = await cliRun(['restore', setDir], cleanEnv({ SUZUBASE_BACKUP_DIR: backupDir }));
  assert.equal(result.code, 1);
  assert.ok(existsSync(join(backupDir, 'backup.log')), 'deployment log must record the refusal');
  assert.match(readFileSync(join(backupDir, 'backup.log'), 'utf8'),
    /unsupported application version in backup set: 3528953/);
});
