const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

const apiUrl = process.env.TEST_API_URL ?? 'http://api:3000';

function configureRuntime() {
  const runtimeUrl = new URL(process.env.MIGRATION_DATABASE_URL);
  runtimeUrl.username = 'suzubase_runtime';
  runtimeUrl.password = process.env.RUNTIME_DATABASE_PASSWORD;
  process.env.DATABASE_URL = runtimeUrl.toString();
}

async function provision(options = {}) {
  const tenantId = options.tenantId ?? randomUUID();
  const userId = randomUUID();
  const email = options.email ?? `${userId}@example.test`;
  const password = randomUUID();
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (!options.tenantId) {
      await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'Test tenant']);
    }
    await client.query('INSERT INTO users (tenant_id, id, email) VALUES ($1, $2, $3)', [tenantId, userId, email]);
    await client.query('INSERT INTO tenant_members (tenant_id, user_id, can_create_apps, is_admin, can_manage_recycle_bin) VALUES ($1, $2, $3, $4, $5)', [
      tenantId, userId, options.canCreateApps ?? true, options.isAdmin ?? false, options.canManageRecycleBin ?? false,
    ]);
    await client.query(`
      INSERT INTO authentication.login_credentials (tenant_id, user_id, email, password_hash)
      VALUES ($1, $2, $3, authentication.crypt(
        encode(authentication.digest($4::text, 'sha256'), 'hex'), authentication.gen_salt('bf', 12)
      ))
    `, [tenantId, userId, email, password]);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  return { tenantId, userId, email, password };
}

async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(new URL(path, apiUrl), {
    method,
    headers: {
      ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
}

async function expectRequest(status, path, options) {
  const result = await request(path, options);
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}

async function login(identity) {
  const { email, password } = identity;
  const result = await expectRequest(200, '/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(result.expiresIn, 3600);
  return result.accessToken;
}

async function createApp(token, code = 'orders') {
  return expectRequest(201, '/apps', { method: 'POST', token, body: { code, name: 'Orders' } });
}

async function addField(token, appId, code, type) {
  return expectRequest(201, `/apps/${appId}/fields`, {
    method: 'POST', token, body: { code, name: code, type },
  });
}

async function publish(token, appId) {
  return expectRequest(201, `/apps/${appId}/publish`, { method: 'POST', token });
}

module.exports = { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request };
