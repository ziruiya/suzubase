const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('pg');
const { configureRuntime, expectRequest, login, provision } = require('./support.cjs');

test('email and password authenticate independent tenant accounts and reject a supplied tenant ID', async () => {
  const a = await provision();
  const b = await provision({ email: a.email });
  for (const identity of [a, b]) {
    const token = await login(identity);
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    assert.equal(claims.tenantId, identity.tenantId);
    assert.equal(claims.sub, identity.userId);
  }
  await expectRequest(401, '/auth/login', { method: 'POST', body: { email: a.email, password: 'wrong' } });
  await expectRequest(400, '/auth/login', { method: 'POST', body: { email: a.email, password: 'invalid\0password' } });
  await expectRequest(400, '/auth/login', { method: 'POST', body: { email: a.email, password: a.password, tenant_id: b.tenantId } });

  configureRuntime();
  const runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();
  try {
    await assert.rejects(runtime.query('SELECT password_hash FROM authentication.login_credentials'), { code: '42501' });
  } finally {
    await runtime.end();
  }
});
