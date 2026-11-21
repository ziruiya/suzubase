const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('pg');
const {
  addField, configureRuntime, createApp, expectRequest, login, provision, publish,
} = require('./support.cjs');

test('G1-14 P0 tenant isolation also applies to the SQL search projection with overlapping field IDs', async (t) => {
  const a = await provision();
  const b = await provision();
  const aToken = await login(a);
  const bToken = await login(b);
  const aApp = await createApp(aToken, 'same-code');
  const bApp = await createApp(bToken, 'same-code');
  const field = await addField(aToken, aApp.id, 'phone', 'phone');
  await addField(bToken, bApp.id, 'phone', 'phone');
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE fields SET field_id = $1 WHERE tenant_id = $2 AND app_id = $3 AND code = $4',
      [field.fieldId, b.tenantId, bApp.id, 'phone']);
  } finally {
    await db.end();
  }
  await publish(aToken, aApp.id);
  await publish(bToken, bApp.id);
  for (const [token, app, value] of [[aToken, aApp, '090-1111-5678'], [bToken, bApp, '080-2222-5678']]) {
    await expectRequest(201, '/apps/' + app.id + '/records', {
      method: 'POST', token, body: { data: { [field.fieldId]: value } },
    });
  }
  const path = (appId) => '/apps/' + appId + '/records/search?' + new URLSearchParams({
    field: field.fieldId, mode: 'tail', query: '5678',
  });
  const own = await expectRequest(200, path(aApp.id), { token: aToken });
  assert.equal(own.count, '1');
  assert.equal(own.items[0].data[field.fieldId], '090-1111-5678');
  await expectRequest(404, path(bApp.id), { token: aToken });
  configureRuntime();
  const { eq, recordSearchValues, withTenantTransaction } = require('../dist');
  const scoped = await withTenantTransaction(a, (tx) => tx.select({ tenantId: recordSearchValues.tenantId })
    .from(recordSearchValues).where(eq(recordSearchValues.fieldId, field.fieldId)));
  assert.deepEqual(scoped, [{ tenantId: a.tenantId }, { tenantId: a.tenantId }]);
  t.diagnostic('Same app code and field UUID in two tenants. API returned one own match, and runtime RLS omitted both foreign projections.');
});
