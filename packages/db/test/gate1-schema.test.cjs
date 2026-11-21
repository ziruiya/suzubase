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
