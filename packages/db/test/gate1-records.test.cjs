const assert = require('node:assert/strict');
const { Client } = require('pg');
const { test } = require('node:test');
const { createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-04 soft deletes release normalized uniqueness and a conflicting restore rolls back', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const field = await request(201, 'POST', '/fields', { name: 'Key', code: 'key', type: 'text', uniqueValue: true });
  await publish(token, app.id);
  const first = await request(201, 'POST', '/records', { data: { [field.fieldId]: 'ＡBC' } });
  const item = '/records/' + first.id;
  await request(409, 'DELETE', item, { revision: 2 });
  const removed = await request(200, 'DELETE', item, { revision: 1 });
  assert.equal(removed.revision, 2);
  await request(404, 'GET', item);
  const second = await request(201, 'POST', '/records', { data: { [field.fieldId]: 'abc' } });
  await request(403, 'POST', item + '/restore', { revision: 2 });
  await request(403, 'GET', '/records/recycle');
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE tenant_members SET can_manage_recycle_bin = true WHERE tenant_id = $1 AND user_id = $2',
      [owner.tenantId, owner.userId]);
  } finally {
    await db.end();
  }
  const recycled = await request(200, 'GET', '/records/recycle?limit=1');
  assert.deepEqual(recycled.items.map(({ id, revision }) => ({ id, revision })), [{ id: first.id, revision: 2 }]);
  const conflict = await request(409, 'POST', item + '/restore', { revision: 2 });
  assert.equal(conflict.recordId, second.id);
  await request(404, 'GET', item);
  await request(200, 'DELETE', '/records/' + second.id, { revision: 1 });
  const restored = await request(201, 'POST', item + '/restore', { revision: 2 });
  assert.equal(restored.revision, 3);
  const history = await request(200, 'GET', item + '/history');
  assert.deepEqual(history.events.map(({ kind }) => kind), ['created', 'deleted', 'restored']);
  assert.equal(history.schemas[2][0].fieldId, field.fieldId);
  t.diagnostic(JSON.stringify({ conflict, restoredRevision: restored.revision, history: history.events.map(({ kind }) => kind) }));

  const batch = await request(201, 'POST', '/records/batch', {
    items: [{ data: { [field.fieldId]: 'abc' } }, { data: {} }],
  });
  assert.equal(batch.results[0].status, 409);
  assert.equal(batch.results[1].record.recordNo, '3');
  const page = await request(200, 'GET', '/records?limit=1');
  assert.equal(page.items[0].id, first.id);
  const next = await request(200, 'GET', '/records?after=' + page.nextCursor);
  assert.equal(next.items[0].id, batch.results[1].record.id);
});

test('GF-09 batches a single field with independent revisions and validation per row', async (t) => {
  const token = await login(await provision());
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const call = (status, method, path, body) => expectRequest(status, base + path, { token, method, body });
  const field = await call(201, 'POST', '/fields', { name: 'Name', code: 'name', type: 'text', required: true });
  const note = await call(201, 'POST', '/fields', { name: 'Note', code: 'note', type: 'text' });
  await publish(token, app.id);
  const make = (value) => call(201, 'POST', '/records', { data: { [field.fieldId]: value, [note.fieldId]: 'Keep ' + value } });
  const one = await make('One');
  const two = await make('Two');
  const rows = await call(200, 'PATCH', '/records/batch', { fieldId: field.fieldId, value: 'Renamed', items: [
    { id: one.id, revision: one.revision }, { id: two.id, revision: two.revision + 1 },
  ] });
  assert.deepEqual(rows.results.map(({ status }) => status), [200, 409]);
  assert.equal(rows.results[0].record.data[note.fieldId], 'Keep One');
  assert.equal((await call(200, 'GET', '/records/' + two.id)).data[field.fieldId], 'Two');
  assert.equal(rows.results[1].error.code, 'REVISION_CONFLICT');
  const invalid = await call(200, 'PATCH', '/records/batch', { fieldId: field.fieldId, value: null, items: [{ id: two.id, revision: two.revision }] });
  assert.equal(invalid.results[0].status, 400);
  assert.equal((await call(200, 'GET', '/records/' + two.id)).revision, two.revision);
  t.diagnostic(JSON.stringify({ rowStatuses: rows.results.map(({ status }) => status), clearingRequired: invalid.results[0].status }));
});
