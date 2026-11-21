const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

configureRuntime();
const { records, recordReferences, withTenantTransaction } = require('../dist');

async function fixture(label) {
  const identity = await provision();
  const token = await login(identity);
  const app = await createApp(token, 'same-code');
  const field = await addField(token, app.id, 'note', 'text');
  await publish(token, app.id);
  const path = `/apps/${app.id}/records`;
  const record = await expectRequest(201, path, {
    method: 'POST', token, body: { data: { [field.fieldId]: label } },
  });
  return { identity, token, app, field, record, path };
}

test('two tenants with the same app code remain isolated on all three requested paths', async (t) => {
  const [a, b] = await Promise.all([fixture('Tenant A'), fixture('Tenant B')]);
  assert.equal(a.app.code, b.app.code);
  assert.equal(a.record.recordNo, '1');
  assert.equal(b.record.recordNo, '1');

  await t.test('API denies tenant A access to tenant B’s record', async (t) => {
    assert.deepEqual(await expectRequest(200, `${a.path}/${a.record.id}`, { token: a.token }), a.record);
    assert.deepEqual(await expectRequest(200, `${b.path}/${b.record.id}`, { token: b.token }), b.record);
    const missing = await expectRequest(404, `${b.path}/${b.record.id}?tenant_id=${b.identity.tenantId}`, {
      token: a.token, headers: { 'X-Tenant-Id': b.identity.tenantId },
    });
    assert.equal(missing.message, 'Not Found');
    assert.deepEqual(await expectRequest(404, `${a.path}/${b.record.id}`, { token: a.token }), missing);
    t.diagnostic('A → own record 200. B → own record 200. A → B app/record 404, including with supplied tenant hints.');
  });

  await t.test('tenant-scoped DB query sees A’s row only, even without a tenant predicate', async (t) => {
    const rows = await withTenantTransaction(a.identity, (tx) => tx.select({ id: records.id }).from(records));
    assert.deepEqual(rows, [{ id: a.record.id }]);
    t.diagnostic('A-scoped SELECT id FROM records (no WHERE clause) → one row for A, zero rows for B.');
  });

  await t.test('composite foreign key rejects a cross-tenant record reference', async (t) => {
    const reference = {
      tenantId: a.identity.tenantId, appId: a.app.id, recordId: a.record.id, fieldId: a.field.fieldId,
    };
    await assert.rejects(withTenantTransaction(a.identity, async (tx) => {
      await tx.insert(recordReferences).values({
        ...reference, targetAppId: b.app.id, targetRecordId: b.record.id,
      });
    }), (error) => error.cause?.code === '23503' && error.cause?.constraint === 'record_references_target_fk');
    await withTenantTransaction(a.identity, async (tx) => {
      await tx.insert(recordReferences).values({
        ...reference, targetAppId: a.app.id, targetRecordId: a.record.id,
      });
      const rows = await tx.select().from(recordReferences);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].targetRecordId, a.record.id);
    });
    t.diagnostic('A → B reference rejected by record_references_target_fk (SQLSTATE 23503). A → A reference committed.');
  });
});
