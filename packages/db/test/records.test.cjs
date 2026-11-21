const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('published field IDs round-trip text and canonical decimal JSONB values', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const base = `/apps/${app.id}`;
  const text = await addField(token, app.id, 'note', 'text');
  const number = await addField(token, app.id, 'amount', 'number');
  const draft = await expectRequest(200, base, { token });
  assert.equal(draft.schemaVersion, 1);
  assert.deepEqual(draft.fields, []);
  await expectRequest(400, `${base}/records`, { method: 'POST', token, body: { data: { [number.fieldId]: '1' } } });
  assert.equal((await publish(token, app.id)).publishedSchemaVersion, 2);

  const body = { data: { [text.fieldId]: 'Invoice 7', [number.fieldId]: '+000123.45000' } };
  const created = await expectRequest(201, `${base}/records`, { method: 'POST', token, body });
  const read = await expectRequest(200, `${base}/records/${created.id}`, { token });
  assert.deepEqual(read, created);
  assert.deepEqual(read.data, { [text.fieldId]: 'Invoice 7', [number.fieldId]: '123.45' });
  assert.equal(read.schemaVersion, 2);
  assert.equal(read.recordNo, '1');
  assert.equal(read.revision, 1);
  t.diagnostic(`POST ${base}/records ${JSON.stringify(body)}`);
  t.diagnostic(`GET ${base}/records/${created.id} → 200 ${JSON.stringify(read)}`);

  for (const invalid of [
    { data: { [number.fieldId]: 1.25 } },
    { data: { [number.fieldId]: '2e3' } },
    { data: { [text.fieldId]: 'two\nlines' } },
    { data: { [randomUUID()]: 'unknown UUID' } },
    { data: { amount: '2' } },
    { data: {}, createdBy: randomUUID() },
    { data: {}, tenant_id: randomUUID() },
  ]) {
    await expectRequest(400, `${base}/records`, { method: 'POST', token, body: invalid });
  }

  const later = await addField(token, app.id, 'later', 'text');
  assert.equal((await publish(token, app.id)).publishedSchemaVersion, 3);
  assert.deepEqual(await expectRequest(200, `${base}/records/${created.id}`, { token }), created);
  const second = await expectRequest(201, `${base}/records`, {
    method: 'POST', token, body: { data: { [later.fieldId]: 'Version 3', [number.fieldId]: '-000.000' } },
  });
  assert.equal(second.schemaVersion, 3);
  assert.equal(second.recordNo, '2');
  assert.equal(second.data[number.fieldId], '0');

  const denied = await provision({ tenantId: owner.tenantId, canCreateApps: false });
  const deniedToken = await login(denied);
  await expectRequest(403, '/apps', { method: 'POST', token: deniedToken, body: { code: 'denied', name: 'Denied' } });
  await expectRequest(404, `${base}/records/${created.id}`, { token: deniedToken });
  await expectRequest(401, `${base}/records/${created.id}`);
  const [header, payload, signature] = token.split('.');
  const tampered = JSON.parse(Buffer.from(payload, 'base64url'));
  tampered.tenantId = randomUUID();
  await expectRequest(401, `${base}/records/${created.id}`, {
    token: [header, Buffer.from(JSON.stringify(tampered)).toString('base64url'), signature].join('.'),
  });
});
