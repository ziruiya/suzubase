const assert = require('node:assert/strict');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

async function seed() {
  const owner = await provision();
  const reader = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token, 'search-baseline');
  const phone = await addField(token, app.id, 'phone', 'phone');
  const marker = await addField(token, app.id, 'scope', 'text');
  await publish(token, app.id);
  const subject = { kind: 'user', id: reader.userId };
  await expectRequest(200, '/apps/' + app.id + '/draft/acl', {
    method: 'PUT', token, body: {
      app: [{ action: 'view', subject }],
      record: [{ action: 'view', subject, conditions: [{ fieldId: marker.fieldId, operator: 'eq', value: 'allowed' }] }],
      field: [{ action: 'view', fieldId: marker.fieldId, subject: { kind: 'user', id: owner.userId } }],
    },
  });
  const version = (await publish(token, app.id)).publishedSchemaVersion;

  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query(`
      INSERT INTO records (tenant_id, app_id, record_no, data, schema_version, created_by, updated_by)
      SELECT $1::uuid, $2::uuid, n, jsonb_build_object(
        $3::text, '090' || lpad(n::text, 8, '0'),
        $4::text, CASE WHEN n % 5 = 0 THEN 'hidden' ELSE 'allowed' END
      ), $5::int, $6::uuid, $6::uuid
      FROM generate_series(1, 100000) AS source(n)
    `, [owner.tenantId, app.id, phone.fieldId, marker.fieldId, version, owner.userId]);
    await db.query(`
      INSERT INTO record_search_values (tenant_id, app_id, record_id, field_id, kind, value)
      SELECT tenant_id, app_id, id, $3::uuid, kind, CASE kind WHEN 'phone' THEN data->>$3::text ELSE reverse(data->>$3::text) END
      FROM records CROSS JOIN (VALUES ('phone'), ('phone-reverse')) AS modes(kind)
      WHERE tenant_id = $1 AND app_id = $2
    `, [owner.tenantId, app.id, phone.fieldId]);
    await db.query('UPDATE app_counters SET last_value = 100000 WHERE tenant_id = $1 AND app_id = $2', [owner.tenantId, app.id]);
    await db.query('COMMIT');
    await db.query('ANALYZE records');
    await db.query('ANALYZE record_search_values');
  } finally {
    await db.end();
  }

  configureRuntime();
  const { sql, withTenantTransaction } = require('../dist');
  const explain = await withTenantTransaction(reader, (tx) => tx.execute(sql`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT r.record_no
    FROM record_search_values p
    JOIN records r ON r.tenant_id = p.tenant_id AND r.app_id = p.app_id AND r.id = p.record_id
    WHERE p.tenant_id = ${owner.tenantId} AND p.app_id = ${app.id} AND p.field_id = ${phone.fieldId}
      AND p.kind = 'phone-reverse'
      AND p.value OPERATOR(pg_catalog.~>=~) '1800' AND p.value OPERATOR(pg_catalog.~<~) '1801'
      AND r.deleted_at IS NULL AND r.data ->> ${marker.fieldId}::text = 'allowed'
    ORDER BY r.record_no
  `));
  const plan = explain.rows[0]['QUERY PLAN'][0];
  const indexes = [];
  function collect(node) {
    if (node['Index Name']) indexes.push({ name: node['Index Name'], condition: node['Index Cond'] });
    for (const child of node.Plans ?? []) collect(child);
  }
  collect(plan.Plan);
  assert.equal(plan.Plan['Actual Rows'], 10, 'suffix sample must preserve the ACL-scoped count');
  assert.ok(indexes.some(({ name, condition }) =>
    name === 'record_search_values_prefix_idx' && condition?.includes('~>=~') && condition.includes('~<~')),
  'the suffix plan must bound both ends of the prefix index range');
  process.stdout.write(JSON.stringify({
    reader, app, phone, marker, explain: { indexes, executionMs: plan['Execution Time'], rows: plan.Plan['Actual Rows'] },
  }));
}

seed().catch((error) => { console.error(error); process.exitCode = 1; });
