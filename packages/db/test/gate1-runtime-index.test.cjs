const assert = require('node:assert/strict');
const { Client } = require('pg');
const test = require('node:test');
const { configureRuntime, createApp, expectRequest, login, provision } = require('./support.cjs');

test('GF-05 concurrent typed index preflights dirty rows, builds on retry, records use, and retires on deletion', async (t) => {
  configureRuntime();
  const { withIndexDdl } = require('../dist/index.js');
  const { runIndexJob } = require('../../../apps/api/dist/runtime-index-worker.js');
  const owner = await provision();
  const token = await login(owner);
  const outsider = await login(await provision());
  const { id } = await createApp(token);
  const base = '/apps/' + id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { token, method, body });
  const number = await request(201, 'POST', '/fields', { type: 'number', code: 'amount', name: 'Amount' });
  await request(201, 'POST', '/publish');
  const twenty = await request(201, 'POST', '/records', { data: { [number.fieldId]: '20' } });
  await request(201, 'POST', '/records', { data: { [number.fieldId]: '100' } });
  const ownerDb = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await ownerDb.connect();
  try {
    const setValue = (value) => ownerDb.query('UPDATE records SET data = jsonb_set(data, ARRAY[$1::text], to_jsonb($2::text)) WHERE id = $3',
      [number.fieldId, value, twenty.id]);
    await setValue('bad-number');
    const job = await request(201, 'POST', '/indexes', { fieldId: number.fieldId, purpose: 'sort', reason: 'Sort invoices by amount' });
    assert.equal(job.state, 'building');
    await expectRequest(404, base + '/indexes', { token: outsider });
    const run = () => withIndexDdl(process.env.MIGRATION_DATABASE_URL, (ddl) => runIndexJob(owner, ddl));
    assert.equal((await run()).state, 'failed');
    const [failed] = await request(200, 'GET', '/indexes');
    assert.deepEqual(failed.problems, [
      { recordNo: twenty.recordNo, value: 'bad-number', reason: 'Value is incompatible with the published field type' },
    ]);
    await setValue('20');
    assert.equal((await request(201, 'POST', '/indexes/' + job.id + '/retry')).state, 'building');
    const built = await run();
    assert.equal(built.state, 'available');
    const [available] = await request(200, 'GET', '/indexes');
    assert.equal(available.state, 'available');
    assert.equal(available.lastUsedAt, null);
    const { rows: [{ definition }] } = await ownerDb.query(
      'SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indexrelid = $1::regclass', ['public.' + built.index]);
    assert.match(definition, /::numeric/);
    assert.doesNotMatch(definition, /CREATE UNIQUE INDEX/);
    const runtime = new Client({ connectionString: process.env.DATABASE_URL });
    await runtime.connect();
    let plan;
    try {
      await runtime.query('BEGIN');
      await runtime.query("SELECT set_config('suzubase.tenant_id', $1, true)", [owner.tenantId]);
      // Small fixture. Make sort cost high enough to expose index eligibility.
      await runtime.query('SET LOCAL enable_sort = off');
      const query = 'SELECT record_no FROM records WHERE tenant_id = $1 AND app_id = $2 AND deleted_at IS NULL'
        + " ORDER BY NULLIF(data->>$3::text, '')::numeric ASC NULLS LAST, record_no";
      plan = (await runtime.query('EXPLAIN (ANALYZE, FORMAT JSON) ' + query, [owner.tenantId, id, number.fieldId])).rows[0]['QUERY PLAN'];
      assert.match(JSON.stringify(plan), new RegExp(built.index));
      assert.deepEqual((await runtime.query(query, [owner.tenantId, id, number.fieldId])).rows.map(({ record_no }) => record_no), ['1', '2']);
      await runtime.query('COMMIT');
    } finally { await runtime.end(); }
    await ownerDb.query('SELECT pg_stat_clear_snapshot()');
    const [used] = await request(200, 'GET', '/indexes');
    assert.ok(used.lastUsedAt);
    await request(200, 'DELETE', '/draft/fields/' + number.fieldId);
    const body = { migration: { incompatible: 'reject' } };
    const blocked = await request(409, 'POST', '/publish', body);
    assert.equal(blocked.problems[0].dependency, 'runtime-index');
    assert.equal((await run()).retired, true);
    await request(201, 'POST', '/publish', body);
    const [retired] = await request(200, 'GET', '/indexes');
    assert.ok(retired.retiredAt);
    assert.ok(retired.lastUsedAt);
    assert.equal((await ownerDb.query('SELECT to_regclass($1) AS index', ['public.' + built.index])).rows[0].index, null);
    t.diagnostic(JSON.stringify({ building: job.state, failed: failed.problems, available: built, lastUsedAt: used.lastUsedAt,
      indexScan: plan[0].Plan['Node Type'], retiredAt: retired.retiredAt }));
  } finally {
    await ownerDb.end();
  }
});
