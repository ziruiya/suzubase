const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

async function download(token, url) {
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const response = await fetch(new URL(url, origin), { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  return response.text();
}

test('G2-11 CSV import resolves lookup keys into snapshots and reports misses with the key value', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const source = await createApp(token, 'csv-source');
  const dest = await createApp(token, 'csv-dest');
  const add = (appId, body, status = 201) =>
    expectRequest(status, '/apps/' + appId + '/fields', { token, method: 'POST', body });
  const key = await add(source.id, { code: 'key', name: 'Key', type: 'text', uniqueValue: true });
  const amount = await addField(token, source.id, 'amount', 'number');
  await publish(token, source.id);
  const local = await addField(token, dest.id, 'key', 'text');
  const copy = await addField(token, dest.id, 'copy', 'number');
  const lookup = await add(dest.id, { code: 'lookup', name: 'Lookup', type: 'lookup', lookup: {
    appId: source.id, keyFieldId: key.fieldId, localKeyFieldId: local.fieldId,
    copies: [{ sourceFieldId: amount.fieldId, targetFieldId: copy.fieldId }],
  } });
  await publish(token, dest.id);
  const src = '/apps/' + source.id + '/records';
  const post = (path, body, status = 201) => expectRequest(status, path, { token, method: 'POST', body });
  const first = await post(src, { data: { [key.fieldId]: 'C-1', [amount.fieldId]: '10.5' } });
  await post(src, { data: { [key.fieldId]: 'C-2', [amount.fieldId]: '20' } });

  const base = '/apps/' + dest.id;
  const call = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  // Mapping the snapshot copy column itself is rejected as read-only.
  const rejected = await call(400, 'POST', '/csv/preflight', {
    csv: 'Snap\n1\n', mapping: { Snap: copy.fieldId },
  });
  assert.match(JSON.stringify(rejected), /read-only/);

  // Map through the lookup field id (redirects to the local key field).
  const job = await call(201, 'POST', '/csv/preflight', {
    csv: 'Key\nC-1\nNOPE\nC-2\n', mapping: { Key: lookup.fieldId },
  });
  assert.equal(job.eligible, 2);
  assert.equal(job.failed, 1);
  assert.equal(job.eligibleRows, 2);
  assert.deepEqual(job.lookupColumns, ['Key']);
  const miss = job.errorReport.find(({ line }) => line === 3);
  assert.ok(miss, 'miss row reported');
  assert.match(JSON.stringify(miss.issues), /NOPE/);
  const errorCsv = await download(token, base + '/csv/' + job.id + '/errors');
  assert.match(errorCsv, /NOPE/);

  const applied = await call(201, 'POST', '/csv/' + job.id + '/apply', { offset: 0, size: 50 });
  assert.equal(applied.imported, 2);
  assert.equal(applied.importedRows, 2);
  const list = await call(200, 'GET', '/records');
  assert.equal(list.items.length, 2);
  const byKey = new Map(list.items.map((item) => [item.data[local.fieldId], item]));
  assert.equal(byKey.get('C-1').data[copy.fieldId], '10.5');
  assert.equal(byKey.get('C-2').data[copy.fieldId], '20');

  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT target_record_id FROM record_references WHERE tenant_id = $1 AND app_id = $2 AND record_id = $3 AND field_id = $4',
      [owner.tenantId, dest.id, byKey.get('C-1').id, lookup.fieldId]);
    assert.deepEqual(rows, [{ target_record_id: first.id }]);
  } finally {
    await client.end();
  }
  t.diagnostic('Lookup CSV: 2 hits imported with snapshots + reference rows; miss NOPE listed with its key value; snapshot column mapping rejected.');
});

test('G2-11 subtable CSV export format, grouped REPLACE import, missing-parent errors and round trip', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token, 'csv-lines');
  const base = '/apps/' + app.id;
  const call = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const title = await addField(token, app.id, 'title', 'text');
  const sku = randomUUID();
  const qty = randomUUID();
  const table = await call(201, 'POST', '/fields', {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: sku, name: 'SKU', code: 'sku', type: 'text', required: true },
      { fieldId: qty, name: 'Qty', code: 'qty', type: 'number', required: true },
    ], minRows: 0, maxRows: 10, addRows: true, deleteRows: true, reorderRows: true },
  });
  await publish(token, app.id);
  const row = (s, q) => ({ rowId: randomUUID(), data: { [sku]: s, [qty]: q } });
  const parent = await call(201, 'POST', '/records', {
    data: { [title.fieldId]: 'Parent', [table.fieldId]: JSON.stringify([row('OLD', '9')]) },
  });
  const recordNo = parent.recordNo;

  const exported = await download(token, base + '/csv/export');
  const lines = exported.trim().split('\n');
  assert.deepEqual(lines[0].split(','), ['record_no', '__table', '__table_name', '__row_order', 'field:title', 'lines.sku', 'lines.qty']);
  assert.deepEqual(lines[1].split(','), [recordNo, 'lines', 'Lines', '1', 'Parent', 'OLD', '9']);

  const grouped = [
    'record_no,__table,__table_name,__row_order,field:title,lines.sku,lines.qty',
    recordNo + ',lines,Lines,1,Parent,A,1',
    recordNo + ',lines,Lines,2,Parent,B,2',
    '999999,lines,Lines,1,Ghost,C,3',
  ].join('\n') + '\n';
  const job = await call(201, 'POST', '/csv/preflight', { csv: grouped, mapping: {} });
  assert.equal(job.failed, 1);
  assert.equal(job.eligibleRows, 2);
  assert.match(JSON.stringify(job.errorReport), /999999/);
  const applied = await call(201, 'POST', '/csv/' + job.id + '/apply', { offset: 0, size: 50 });
  assert.equal(applied.importedRows, 2);

  const detail = await call(200, 'GET', '/records/' + parent.id);
  const skus = () => JSON.parse(detail.data[table.fieldId]).map((entry) => entry.data[sku]);
  assert.deepEqual(JSON.parse((await call(200, 'GET', '/records/' + parent.id)).data[table.fieldId])
    .map((entry) => [entry.data[sku], entry.data[qty]]), [['A', '1'], ['B', '2']]);

  // Re-importing the same file replaces instead of duplicating (idempotent round trip).
  const again = await call(201, 'POST', '/csv/preflight', { csv: grouped, mapping: {} });
  await call(201, 'POST', '/csv/' + again.id + '/apply', { offset: 0, size: 50 });
  const after = await call(200, 'GET', '/records/' + parent.id);
  assert.deepEqual(JSON.parse(after.data[table.fieldId]).map((entry) => entry.data[sku]), ['A', 'B']);

  const roundTrip = await download(token, base + '/csv/export');
  const rtLines = roundTrip.trim().split('\n');
  assert.equal(rtLines.length, 3);
  assert.deepEqual(rtLines.slice(1).map((line) => line.split(',').slice(5)), [['A', '1'], ['B', '2']]);
  t.diagnostic('Subtable CSV: export header/row format verified; grouped import replaced [OLD] with [A,B]; missing parent 999999 is a per-line error; re-import stayed [A,B].');
});
