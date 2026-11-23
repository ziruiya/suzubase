const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolve } = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

configureRuntime();
const execFileAsync = promisify(execFile);
const auditScript = resolve(__dirname, '../../../tools/audit/audit-integrity.mjs');

async function dbQuery(sqlText, params) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

async function runAudit(tenantId) {
  let stdout = ''; let code = 0;
  try {
    ({ stdout } = await execFileAsync(process.execPath,
      [auditScript, '--sample', '20', '--tenant', tenantId],
      { cwd: resolve(__dirname, '../../..'), env: process.env, maxBuffer: 4 * 1024 * 1024 }));
  } catch (error) {
    code = error.code ?? 1;
    stdout = error.stdout ?? '';
  }
  const start = stdout.lastIndexOf('\n{');
  assert.ok(start >= 0, 'audit must print a JSON report:\n' + stdout);
  return { code, report: JSON.parse(stdout.slice(start + 1)) };
}

// P4-T3b: check 1 samples are stratified. Records belonging to an
// application that is the target of a not-yet-activated import job
// form the staged population (zero history events BY DESIGN) and must
// never be sampled into check 1; the formal population is sampled with
// the frozen seed and the sampled ids are written into the report.
// A genuinely broken FORMAL record must still be detected.
test('P4-fix T3b: stratified check-1 ignores staged records, still catches formal defects', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);

  const formal = await createApp(token, 'p4-fix-audit-formal');
  const formalTitle = await addField(token, formal.id, 'title', 'text');
  await publish(token, formal.id);
  const formalIds = [];
  for (const name of ['f1', 'f2', 'f3']) {
    const record = await expectRequest(201, `/apps/${formal.id}/records`, {
      token, method: 'POST', body: { data: { [formalTitle.fieldId]: name } },
    });
    formalIds.push(record.id);
  }

  const staged = await createApp(token, 'p4-fix-audit-staged');
  const stagedTitle = await addField(token, staged.id, 'title', 'text');
  await publish(token, staged.id);
  const jobId = randomUUID();
  await dbQuery(`INSERT INTO import_jobs
    (tenant_id, id, created_by, package_sha256, package_bytes, status, target_app_id)
    VALUES ($1, $2, $3, 'p4fix', 1, 'staging', $4)`,
    [owner.tenantId, jobId, owner.userId, staged.id]);
  // 30 staged records with zero history events — the exact shape that
  // used to false-fail check 1 whenever random sampling reached them.
  for (let index = 1; index <= 30; index++) {
    await dbQuery(`INSERT INTO records
      (tenant_id, app_id, id, record_no, data, schema_version, revision, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5::jsonb, 1, 1, $6, $6)`,
      [owner.tenantId, staged.id, randomUUID(), index,
        JSON.stringify({ [stagedTitle.fieldId]: 'staged-' + index }), owner.userId]);
  }

  for (let run = 0; run < 3; run++) {
    const { code, report } = await runAudit(owner.tenantId);
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(report.failures, 0);
    assert.equal(report.sampleSeed, 0.20261123);
    const check1 = report.checks.find(({ name }) => name === 'history-vs-revision sample');
    assert.ok(check1, 'check 1 must be present');
    assert.equal(check1.ok, true, check1.detail);
    assert.equal(check1.population, 'formal');
    assert.equal(check1.stagedExcluded, 30,
      'all 30 staged records must be excluded by stratification');
    assert.deepEqual([...check1.sampledRecordIds].sort(), [...formalIds].sort(),
      'the fixed-seed formal sample is exactly the formal population here');
    assert.match(check1.detail, /staged/);
  }

  // Anti-overcorrection: a formal record with a broken history
  // (revision 1, zero events, not staged) must still be detected.
  const brokenId = randomUUID();
  await dbQuery(`INSERT INTO records
    (tenant_id, app_id, id, record_no, data, schema_version, revision, created_by, updated_by)
    VALUES ($1, $2, $3, 9001, $4::jsonb, 1, 1, $5, $5)`,
    [owner.tenantId, formal.id, brokenId,
      JSON.stringify({ [formalTitle.fieldId]: 'broken' }), owner.userId]);
  const { code, report } = await runAudit(owner.tenantId);
  assert.equal(code, 1, 'a broken formal record must fail the audit');
  const check1 = report.checks.find(({ name }) => name === 'history-vs-revision sample');
  assert.equal(check1.ok, false);
  assert.match(check1.detail, /1 problem records/);
  assert.ok(check1.sampledRecordIds.includes(brokenId),
    'the planted formal defect must be inside the reported sample');
});
