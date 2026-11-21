const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp, expectRequest, login, provision } = require('./support.cjs');

test('G1-03 preflight blocks incompatible required fields and preserves old record versions', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const old = await request(201, 'POST', '/records', { data: {} });
  const field = await request(201, 'POST', '/fields', { name: 'Title', code: 'title', type: 'text', required: true });
  const blocked = await request(409, 'POST', '/publish');
  assert.deepEqual(blocked.problems, [{
    recordNo: old.recordNo, fieldId: field.fieldId, field: 'Title', value: null, reason: 'required',
  }]);
  assert.equal((await request(200, 'GET', '/draft')).status, 'validation-failed');
  assert.equal((await request(200, 'GET', '')).schemaVersion, old.schemaVersion);
  await request(200, 'PATCH', '/draft/fields/' + field.fieldId, { required: false });
  const published = await request(201, 'POST', '/publish');
  assert.equal(published.publishedSchemaVersion, old.schemaVersion + 1);
  assert.deepEqual(await request(200, 'GET', '/records/' + old.id), old);
  t.diagnostic(JSON.stringify({ blocked, publishedVersion: published.publishedSchemaVersion, oldVersion: old.schemaVersion }));
});

test('G1-03 published scalar and choice types validate and round-trip by field UUID', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  const examples = [
    ['text', 'One line', 'One line'],
    ['multiline', 'First\nSecond', 'First\nSecond'],
    ['number', '+001.250', '1.25'],
    ['radio', 'a', 'a', options],
    ['checkbox', '["b","a"]', '["a","b"]', options],
    ['select', 'b', 'b', options],
    ['multiselect', '["b"]', '["b"]', options],
    ['date', '2026-11-21', '2026-11-21'],
    ['time', '11:30', '11:30:00'],
    ['datetime', '2026-11-21T11:30:00+09:00', '2026-11-21T02:30:00.000Z'],
    ['url', 'https://example.test', 'https://example.test/'],
    ['phone', '０９０-１２３４-５６７８', '０９０-１２３４-５６７８'],
    ['email', 'Example@example.test', 'Example@example.test'],
    ['user', owner.userId, owner.userId],
  ];
  const data = {}, expected = {}, fieldIds = {};
  for (const [type, value, normalized, fieldOptions] of examples) {
    const field = await expectRequest(201, base + '/fields', {
      method: 'POST', token, body: { name: type, code: type, type, ...(fieldOptions && { options: fieldOptions }) },
    });
    data[field.fieldId] = value;
    expected[field.fieldId] = normalized;
    fieldIds[type] = field.fieldId;
  }
  await expectRequest(201, base + '/publish', { method: 'POST', token });
  const record = await expectRequest(201, base + '/records', { method: 'POST', token, body: { data } });
  const read = await expectRequest(200, base + '/records/' + record.id, { token });
  assert.deepEqual(read.data, expected);
  await expectRequest(400, base + '/records', {
    method: 'POST', token, body: { data: { [fieldIds.date]: '2026-02-31', [fieldIds.radio]: 'missing' } },
  });
  t.diagnostic(JSON.stringify({ fieldIds, actual: read.data }));
});

test('GF-02 rich text, calculated results and layout definitions round-trip with read-only enforcement', async (t) => {
  const token = await login(await provision());
  const { id } = await createApp(token);
  const base = '/apps/' + id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const add = (type, code, config) => request(201, 'POST', '/fields', { type, code, name: code, ...config });
  const rich = await add('richText', 'description');
  const quantity = await add('number', 'quantity');
  const formula = [
    { kind: 'field', fieldId: quantity.fieldId }, { kind: 'number', value: '2' }, { kind: 'operator', operator: '*' },
    { kind: 'text', value: ' items' }, { kind: 'operator', operator: '&' },
  ];
  const calculation = await add('calculation', 'total', { formula });
  const elements = [];
  for (const kind of ['label', 'separator', 'blank', 'group']) {
    elements.push(await add('layout', kind, { layoutElement: { kind, text: kind } }));
  }
  await request(201, 'POST', '/publish');
  const html = '<p>First <b>paragraph</b></p><ul><li><a href="https://example.test">Item</a></li></ul>';
  const input = { [rich.fieldId]: html, [quantity.fieldId]: '3.25' };
  const record = await request(201, 'POST', '/records', { data: input });
  const read = await request(200, 'GET', '/records/' + record.id + '/form');
  assert.deepEqual(read.record.data, { ...input, [calculation.fieldId]: '6.5 items' });
  for (const element of elements) {
    assert.deepEqual(read.fields.find(({ fieldId }) => fieldId === element.fieldId)?.layoutElement, element.layoutElement);
    assert.equal(Object.hasOwn(read.record.data, element.fieldId), false);
  }
  await request(400, 'POST', '/records', { data: { [calculation.fieldId]: 'forged' } });
  await request(400, 'POST', '/records', { data: { [elements[0].fieldId]: 'forged' } });
  const updated = await request(200, 'PUT', '/records/' + record.id, { revision: record.revision, data: { ...input, [quantity.fieldId]: '7' } });
  assert.equal(updated.data[calculation.fieldId], '14 items');
  const exportResponse = await fetch(new URL(base + '/csv/export', process.env.TEST_API_URL ?? 'http://api:3000'), {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-disposition'), /plain-text/);
  const csv = await exportResponse.text();
  assert.match(csv, /First paragraph\nItem/);
  assert.doesNotMatch(csv, /<p>|separator/);
  t.diagnostic(JSON.stringify({ layout: elements.map(({ fieldId, layoutElement }) => ({ fieldId, layoutElement })), values: read.record.data }));
});

test('GF-03 publishes rename and layout, blocks formula dependency, and archives removed fields behind a special grant', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const { id } = await createApp(token);
  const base = '/apps/' + id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const quantity = await request(201, 'POST', '/fields', { name: 'Quantity', code: 'quantity', type: 'number' });
  const total = await request(201, 'POST', '/fields', { name: 'Total', code: 'total', type: 'calculation', formula: [
    { kind: 'field', fieldId: quantity.fieldId }, { kind: 'number', value: '2' }, { kind: 'operator', operator: '*' },
  ] });
  await request(201, 'POST', '/publish');
  const record = await request(201, 'POST', '/records', { data: { [quantity.fieldId]: '3' } });
  await request(200, 'PATCH', '/draft/fields/' + quantity.fieldId, { name: 'Units', code: 'units' });
  const formLayout = [{ id: owner.userId, cells: [{ fieldId: quantity.fieldId, width: 6 }, { fieldId: total.fieldId, width: 6 }] }];
  await request(200, 'PUT', '/draft/layout', formLayout);
  assert.equal((await request(200, 'GET', '')).fields.find(({ fieldId }) => fieldId === quantity.fieldId).name, 'Quantity');
  await request(201, 'POST', '/publish');
  const published = await request(200, 'GET', '');
  assert.deepEqual(published.formLayout, formLayout);
  assert.equal(published.fields.find(({ fieldId }) => fieldId === quantity.fieldId).name, 'Units');
  const updated = await request(200, 'PUT', '/records/' + record.id, {
    revision: record.revision, data: { [quantity.fieldId]: '4' },
  });
  assert.equal(updated.data[total.fieldId], '8');
  await request(201, 'POST', '/rollback-display');
  assert.deepEqual((await request(200, 'GET', '')).formLayout, []);
  const summary = await request(201, 'POST', '/draft/views', {
    name: 'Quantity summary', conditions: [], columns: [], aggregateFields: [quantity.fieldId],
  });
  assert.deepEqual((await request(201, 'POST', '/publish')).skippedDependencies, []);
  await request(200, 'PATCH', '/draft/fields/' + quantity.fieldId, { type: 'text' });
  const typeBlocked = await request(409, 'POST', '/publish', { migration: { incompatible: 'reject' } });
  assert.ok(typeBlocked.problems.some(({ dependency }) => dependency === 'formula'));
  assert.ok(typeBlocked.problems.some(({ dependency }) => dependency === 'view-aggregate'));
  await request(200, 'PATCH', '/draft/fields/' + quantity.fieldId, { type: 'number' });
  await request(200, 'DELETE', '/draft/fields/' + quantity.fieldId);
  const blocked = await request(409, 'POST', '/publish', { migration: { incompatible: 'reject' } });
  assert.ok(blocked.problems.some(({ fieldId, dependency }) => fieldId === total.fieldId && dependency === 'formula'));
  await request(200, 'DELETE', '/draft/fields/' + total.fieldId);
  await request(200, 'DELETE', '/draft/views/' + summary.views[0].id);
  const pass = await request(201, 'POST', '/publish', { migration: { incompatible: 'reject' } });
  assert.equal(pass.migrationReport.migrated, 1);
  assert.deepEqual((await request(200, 'GET', '/records/' + record.id)).data, {});
  await request(404, 'GET', '/records/' + record.id + '/archived-fields');
  const historyPath = '/records/' + record.id + '/history/export';
  const normalExport = await request(200, 'GET', historyPath);
  assert.equal(normalExport.archive, undefined);
  assert.ok(normalExport.events.every(({ changes }) => changes.every(({ fieldId }) => fieldId !== quantity.fieldId)));
  await request(404, 'GET', historyPath + '?includeArchived=true');
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE tenant_members SET can_read_archived_fields = true WHERE tenant_id = $1 AND user_id = $2',
      [owner.tenantId, owner.userId]);
  } finally {
    await db.end();
  }
  const archive = await request(200, 'GET', '/records/' + record.id + '/archived-fields');
  assert.equal(archive.data[quantity.fieldId], '4');
  assert.equal(archive.definitions[quantity.fieldId].name, 'Units');
  const historyExport = await request(200, 'GET', historyPath + '?includeArchived=true');
  assert.deepEqual(historyExport.archive, archive);
  assert.equal(historyExport.recordId, record.id);
  assert.deepEqual(historyExport.events.map(({ kind }) => kind), ['created', 'updated', 'schema-migrated']);
  t.diagnostic(JSON.stringify({ typeBlocked, blocked, migrated: pass.migrationReport, archive: archive.data }));
});

test('GF-03 explicitly repairs incompatible values during type migration and preserves deactivated options', async (t) => {
  const token = await login(await provision());
  const { id } = await createApp(token);
  const request = (status, method, path, body) => expectRequest(status, '/apps/' + id + path, { method, token, body });
  const original = await request(201, 'POST', '/fields', { name: 'Cost', code: 'cost', type: 'text' });
  const selected = await request(201, 'POST', '/fields', { name: 'Choice', code: 'choice', type: 'select', options: [
    { value: 'x', label: 'X' }, { value: 'y', label: 'Y' },
  ] });
  await request(201, 'POST', '/publish');
  const value = await request(201, 'POST', '/records', { data: { [original.fieldId]: 'bad', [selected.fieldId]: 'x' } });
  await request(200, 'PATCH', '/draft/fields/' + selected.fieldId, { options: [
    { value: 'x', label: 'X', disabled: true }, { value: 'y', label: 'Y' },
  ] });
  await request(201, 'POST', '/publish');
  const existing = await request(200, 'GET', '/records/' + value.id + '/form');
  assert.equal(existing.fields.find(({ fieldId }) => fieldId === selected.fieldId).options[0].disabled, true);
  await request(400, 'POST', '/records', { data: { [selected.fieldId]: 'x' } });
  await request(200, 'PATCH', '/draft/fields/' + original.fieldId, { type: 'number' });
  const blocked = await request(409, 'POST', '/publish');
  assert.equal(blocked.problems[0].value, 'bad');
  const pass = await request(201, 'POST', '/publish', { migration: { incompatible: 'clear-optional' } });
  const migrated = await request(200, 'GET', '/records/' + value.id);
  assert.deepEqual(migrated.data, { [selected.fieldId]: 'x' });
  assert.equal(pass.migrationReport.incompatibleValues[0].value, 'bad');
  t.diagnostic(JSON.stringify({ blocked, migration: pass.migrationReport }));
});
