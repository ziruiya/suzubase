const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { existsSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// P4-T5 regression: execution binding between validation and execution.
// Before this fix, validate() persisted only a preflight summary and run()
// re-read the package file from disk without comparing it to the job's
// recorded packageSha256 — replacing the stored file after validation made
// the job execute (and activate) bytes that were never validated. The fix
// (import.ts assertPackageMatchesJob) re-verifies the on-disk bytes against
// job.packageSha256 at validate, run, resolve-dependencies, finalize and
// automation dry-run, failing closed on mismatch.

async function raw(token, pathName, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(pathName, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
      ...(body && !contentType && { 'Content-Type': 'application/json' }),
    },
    body: body ? (contentType ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: response.status, body: parsed, raw: text };
}

async function dbQuery(sqlText, params) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

async function buildPackage(token, appName, recordValue) {
  const app = await createApp(token, appName);
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  await expectRequest(201, base + '/records', {
    token, method: 'POST', body: { data: { [title.fieldId]: recordValue } },
  });
  const job = await expectRequest(201, base + '/exports', { token, method: 'POST' });
  const run = await expectRequest(201, base + '/exports/' + job.id + '/run', { token, method: 'POST' });
  assert.equal(run.status, 'sealed', JSON.stringify(run));
  const response = await fetch(new URL(base + '/exports/' + job.id + '/package', origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

function storedJobFile(tenantId, jobId) {
  const candidates = [
    path.resolve(__dirname, '../../..', 'attachments/imports', tenantId, `${jobId}.zip`),
    path.resolve(process.cwd(), 'attachments/imports', tenantId, `${jobId}.zip`),
    path.resolve(__dirname, '../../..', 'apps/api/attachments/imports', tenantId, `${jobId}.zip`),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function uploadAndValidate(token, archive) {
  const uploaded = await raw(token, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream',
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const validated = await expectRequest(201, `/imports/${uploaded.body.id}/validate`, { token, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  return uploaded.body;
}

test('P4-T5: a package file replaced after validation cannot execute (sha256 binding)', async () => {
  const source = await provision({ isAdmin: true });
  const sourceToken = await login(source);
  const pkgA = await buildPackage(sourceToken, 'p4-t5-bind-src-a', 'alpha');
  const pkgB = await buildPackage(sourceToken, 'p4-t5-bind-src-b', 'beta');
  assert.notEqual(sha256(pkgA), sha256(pkgB));

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const job = await uploadAndValidate(targetToken, pkgA);
  assert.equal(job.packageSha256, sha256(pkgA));

  const stored = storedJobFile(target.tenantId, job.id);
  assert.ok(stored, 'stored package file must be locatable for the swap');
  await writeFile(stored, pkgB);

  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  const run = await raw(issued.token, `/imports/${job.id}/run`, { method: 'POST' });
  assert.equal(run.status, 400, JSON.stringify(run.body));
  assert.match(JSON.stringify(run.body), /sha256 mismatch/);

  const after = await expectRequest(200, `/imports/${job.id}`, { token: targetToken });
  assert.equal(after.status, 'staging', 'job must stay in staging, untouched by the blocked run');
  const apps = await dbQuery('SELECT count(*)::int AS n FROM apps WHERE tenant_id = $1', [target.tenantId]);
  assert.equal(apps[0].n, 0, 'no application may be created from unvalidated bytes');
});

test('P4-T5: the unmodified validated package still executes and activates (control)', async () => {
  const source = await provision({ isAdmin: true });
  const sourceToken = await login(source);
  const pkg = await buildPackage(sourceToken, 'p4-t5-bind-src-control', 'gamma');

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const job = await uploadAndValidate(targetToken, pkg);
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  const activated = await expectRequest(201, `/imports/${job.id}/activate`, { token: targetToken, method: 'POST' });
  assert.equal(activated.status, 'activated', JSON.stringify(activated));
  const records = await dbQuery('SELECT count(*)::int AS n FROM records WHERE tenant_id = $1 AND app_id = $2',
    [target.tenantId, run.targetAppId]);
  assert.equal(records[0].n, 1);
});
