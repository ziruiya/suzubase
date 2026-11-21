const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

test('G1-09 concurrent scoped sequences issue distinct immutable numbers and never reuse deleted numbers', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const area = await addField(token, app.id, 'area', 'text');
  const code = await expectRequest(201, base + '/fields', {
    method: 'POST', token, body: { name: 'Number', code: 'auto', type: 'autoNumber',
      autoNumber: { prefix: 'G-', scopeFieldId: area.fieldId, nextValue: '8', padding: 4, enabled: true } },
  });
  await publish(token, app.id);
  function create(value) {
    return request(base + '/records', { method: 'POST', token, body: { data: { [area.fieldId]: value } } });
  }
  const attempts = 20;
  const results = await Promise.all(Array.from({ length: attempts }, () => create('Tokyo')));
  assert.ok(results.every(({ status }) => status === 201), JSON.stringify(results.filter(({ status }) => status !== 201)));
  const issued = results.map(({ body }) => body.data[code.fieldId]).sort();
  assert.equal(new Set(issued).size, attempts);
  assert.equal(issued[0], 'G-0008');
  assert.equal(issued.at(-1), 'G-0027');
  assert.equal((await create('Osaka')).body.data[code.fieldId], 'G-0008');
  const record = results[0].body;
  const path = base + '/records/' + record.id;
  await expectRequest(400, path, { method: 'PUT', token, body: { revision: 1, data: {
    [area.fieldId]: 'Tokyo', [code.fieldId]: 'G-9999',
  } } });
  const edited = await expectRequest(200, path, { method: 'PUT', token, body: { revision: 1, data: { [area.fieldId]: 'Tokyo' } } });
  assert.equal(edited.data[code.fieldId], record.data[code.fieldId]);
  await expectRequest(200, path, { method: 'DELETE', token, body: { revision: 2 } });
  assert.equal((await create('Tokyo')).body.data[code.fieldId], 'G-0028');
  t.diagnostic(JSON.stringify({ attempts, unique: new Set(issued).size, first: issued[0], last: issued.at(-1), afterDelete: 'G-0028' }));
});
