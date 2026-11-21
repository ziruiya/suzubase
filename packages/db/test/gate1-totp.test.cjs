const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');
const { Client } = require('pg');
const { expectRequest, login, provision } = require('./support.cjs');

function codeAt(secret, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const keyBits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(keyBits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('administrator TOTP enrollment, login, recovery and disable revoke sessions and reject replays', async () => {
  const { tenantId, userId, email, password } = await provision();
  const ordinarySession = await login({ email, password });
  await expectRequest(403, '/auth/totp', { token: ordinarySession });
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE tenant_members SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
  } finally {
    await db.end();
  }
  const token = await login({ email, password });
  const post = (status, path, body, session = token) =>
    expectRequest(status, '/auth/totp/' + path, { method: 'POST', token: session, body });
  const { secret, expiresIn } = await post(201, 'enrollment', { password });
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(expiresIn, 600);
  const step = Math.floor(Date.now() / 30_000);
  const factor = codeAt(secret, step);
  const { recoveryCodes } = await post(201, 'enable', { password, factor });
  assert.equal(new Set(recoveryCodes).size, 10);
  await expectRequest(401, '/auth/profile', { token });
  const signIn = (status, code) => expectRequest(status, '/auth/login', {
    method: 'POST', body: { email, password, ...(code && { factor: code }) },
  });
  assert.deepEqual(await signIn(200), { secondFactorRequired: true });
  await signIn(401, factor);
  const nextFactor = codeAt(secret, step + 1);
  const { accessToken } = await signIn(200, nextFactor);
  await signIn(401, nextFactor);
  await signIn(200, recoveryCodes[0]);
  await signIn(401, recoveryCodes[0]);
  assert.deepEqual(await post(201, 'disable', { password, factor: recoveryCodes[1] }, accessToken), { enabled: false });
  await expectRequest(401, '/auth/profile', { token: accessToken });
  await login({ email, password });
});
