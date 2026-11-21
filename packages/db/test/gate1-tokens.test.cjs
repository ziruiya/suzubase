const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp, expectRequest, login, provision } = require('./support.cjs');

test('G1-12 app token scope separates actions, exposes the secret once and honors revocation', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const other = await createApp(token, 'other');
  const path = '/apps/' + app.id;
  await expectRequest(201, path + '/records', { method: 'POST', token, body: { data: {} } });
  const issued = await expectRequest(201, path + '/tokens', {
    method: 'POST', token, body: { label: 'Read integration', actions: ['view'] },
  });
  assert.match(issued.token, /^sb1_[A-Za-z0-9_-]{43}$/);
  const list = await expectRequest(200, path + '/tokens', { token });
  assert.equal(list[0].id, issued.id);
  assert.equal(list[0].token, undefined);
  assert.equal(list[0].secretHash, undefined);
  const apiToken = issued.token;
  assert.equal((await expectRequest(200, path + '/records', { token: apiToken })).items.length, 1);
  await expectRequest(401, path + '/records', { method: 'POST', token: apiToken, body: { data: {} } });
  await expectRequest(401, path + '/settings', { token: apiToken });
  await expectRequest(401, '/apps/' + other.id + '/records', { token: apiToken });
  await expectRequest(401, path + '/tokens', { token: apiToken });
  const revoked = await expectRequest(200, path + '/tokens/' + issued.id, { method: 'DELETE', token });
  assert.ok(revoked.revokedAt);
  const denied = await expectRequest(401, path + '/records', { token: apiToken });
  assert.equal(denied.message, '无权限');
  t.diagnostic(JSON.stringify({ sign: 201, secret: 'sb1_[redacted]', listedWithSecret: false, afterRevocation: denied }));
});
