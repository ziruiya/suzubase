const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');

test('runtime role is isolated by transaction-local RLS', async () => {
  const runtimeUrl = new URL(process.env.MIGRATION_DATABASE_URL);
  runtimeUrl.username = 'suzubase_runtime';
  runtimeUrl.password = process.env.RUNTIME_DATABASE_PASSWORD;
  process.env.DATABASE_URL = runtimeUrl.toString();
  const { tenants, sql, withTenantTransaction } = require('../dist');
  const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  const runtime = new Client({ connectionString: runtimeUrl.toString() });
  const a = randomUUID();
  const b = randomUUID();
  await admin.connect();
  await runtime.connect();
  try {
    await admin.query('INSERT INTO tenants (id, name) VALUES ($1::uuid, $1::uuid::text), ($2::uuid, $2::uuid::text)', [a, b]);
    const { rows: [role] } = await runtime.query(`
      SELECT current_user AS name, rolsuper, rolbypassrls,
        EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'records' AND tableowner = current_user) AS owner
      FROM pg_roles WHERE rolname = current_user
    `);
    assert.deepEqual(role, { name: 'suzubase_runtime', rolsuper: false, rolbypassrls: false, owner: false });
    assert.deepEqual((await runtime.query('SELECT id FROM tenants')).rows, []);
    for (const tenantId of [a, b, a]) {
      await withTenantTransaction({ tenantId, userId: randomUUID() }, async (tx) => {
        assert.deepEqual((await tx.select({ id: tenants.id }).from(tenants)).map((row) => row.id), [tenantId]);
      });
    }
    await assert.rejects(withTenantTransaction({ tenantId: 'invalid', userId: randomUUID() }, () => {
      assert.fail('invalid context reached callback');
    }), /Invalid tenant context/);
    await assert.rejects(withTenantTransaction({ tenantId: a, userId: randomUUID() }, async (tx) => {
      await tx.execute(sql`SELECT current_setting('suzubase.tenant_id')`);
      throw new Error('abort tenant transaction');
    }), /abort tenant transaction/);
    await withTenantTransaction({ tenantId: b, userId: randomUUID() }, async (tx) => {
      assert.deepEqual(await tx.select({ id: tenants.id }).from(tenants), [{ id: b }]);
    });
  } finally {
    await admin.query('DELETE FROM tenants WHERE id IN ($1, $2)', [a, b]);
    await Promise.all([admin.end(), runtime.end()]);
  }
});
