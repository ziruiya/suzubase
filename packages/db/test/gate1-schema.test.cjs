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
