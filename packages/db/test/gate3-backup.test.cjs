// G3-13 backup tool scripted cases: set verification, tamper detection, and
// the pre-restore version-compatibility refusal (non-zero exit + deployment
// log + admin alert record). Full create/restore drills run against real
// deployments (see GATE3-REPORT evidence), because pg_dump/pg_restore are
// deployment-host tools, not test-container tools.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');

const run = promisify(execFile);
const cli = resolve(__dirname, '../../../tools/backup/suzubase-backup.mjs');

function makeSet(dir, { appVersion = '1.0.0', tamper = false } = {}) {
  const setDir = join(dir, 'backup-test-set');
  mkdirSync(join(setDir, 'config'), { recursive: true });
  const configBody = 'APP_VERSION=1\n';
  writeFileSync(join(setDir, 'config', 'deploy.env'), configBody);
  const sha = createHash('sha256').update(configBody).digest('hex');
  writeFileSync(join(setDir, 'manifest.json'), JSON.stringify({
    format: 'suzubase-backup-set/1', name: 'backup-test-set', createdAt: new Date().toISOString(),
    sensitiveData: true, appVersion, databaseMigrations: 34,
    files: [{ path: 'config/deploy.env', sha256: tamper ? 'deadbeef' : sha, bytes: configBody.length }],
  }, null, 2));
  return setDir;
}

async function cliRun(args, env) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('G3-13 backup set verify passes on an intact set and fails on a tampered file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-backup-'));
  const env = { SUZUBASE_BACKUP_DIR: dir };
  const good = makeSet(dir);
  const ok = await cliRun(['verify', good], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /"verified"/);
  const bad = makeSet(dir, { tamper: true });
  const refused = await cliRun(['verify', bad], env);
  assert.equal(refused.code, 1);
});

test('G3-13 restore refuses an unsupported application version with log + alert + non-zero exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-backup-'));
  const env = { SUZUBASE_BACKUP_DIR: dir };
  const setDir = makeSet(dir, { appVersion: '99.0.0' });
  const result = await cliRun(['restore', setDir], env);
  assert.equal(result.code, 1);
  assert.ok(existsSync(join(dir, 'backup.log')), 'deployment log must record the failure');
  assert.match(readFileSync(join(dir, 'backup.log'), 'utf8'), /unsupported application version/);
  assert.ok(existsSync(join(dir, 'alerts.jsonl')), 'admin alert record must be written');
  const alert = JSON.parse(readFileSync(join(dir, 'alerts.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(alert.audience, 'tenant-administrators');
  assert.match(alert.reason, /unsupported application version/);
});

test('G3-13 list reports sets as sensitive data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'suzubase-backup-'));
  makeSet(dir);
  const result = await cliRun(['list'], { SUZUBASE_BACKUP_DIR: dir });
  assert.equal(result.code, 0, result.stderr);
  const sets = JSON.parse(result.stdout);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].sensitiveData, true);
});
