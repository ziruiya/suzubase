// Public sample site (migration 0052): guest session issuance via a stubbed
// Turnstile siteverify endpoint, structured-only guest writes, and hard
// blocks on text writes / deletes / uploads / comments. Requires the API to
// run with TURNSTILE_SECRET_KEY set and TURNSTILE_SITEVERIFY_URL pointing at
// the stub started below (see .github/workflows/ci.yaml).
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test, before, after } = require('node:test');
const { createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

const apiUrl = process.env.TEST_API_URL ?? 'http://api:3000';
let stub;
let admin; // provision result for the sample tenant admin
let adminToken;
let guestId;
let app;
let fields = {};
let guestToken;
let otherApp;

before(async () => {
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const token = new URLSearchParams(body).get('response');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: token === 'good-token' }));
    });
  });
  await new Promise((resolve) => stub.listen(18777, '127.0.0.1', resolve));

  admin = await provision({ isAdmin: true, canCreateApps: true });
  adminToken = await login(admin);
  guestId = randomUUID();
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query('INSERT INTO users (tenant_id, id, email) VALUES ($1, $2, $3)',
      [admin.tenantId, guestId, `${guestId}@example.test`]);
    await client.query('INSERT INTO tenant_members (tenant_id, user_id) VALUES ($1, $2)',
      [admin.tenantId, guestId]);
    await client.query(
      'INSERT INTO authentication.sample_site (tenant_id, guest_user_id, site_key, enabled) VALUES ($1, $2, $3, true)',
      [admin.tenantId, guestId, 'test-site-key']);
  } finally {
    await client.end();
  }

  app = await createApp(adminToken, 'sample-app');
  const add = async (code, type, options) => {
    const field = await expectRequest(201, `/apps/${app.id}/fields`, {
      method: 'POST', token: adminToken,
      body: { code, name: code, type, ...(options ? { options } : {}) },
    });
    fields[code] = field;
  };
  await add('title', 'text');
  await add('status', 'select', [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]);
  await add('amount', 'number');
  await add('day', 'date');
  await expectRequest(200, `/apps/${app.id}/draft/acl`, {
    method: 'PUT', token: adminToken,
    body: {
      app: ['view', 'create', 'edit'].map((action) => ({
        action, subject: { kind: 'user', id: guestId },
      })),
      record: [],
      field: [{ action: 'edit', subject: { kind: 'user', id: admin.userId }, fieldId: fields.title.fieldId }],
    },
  });
  await publish(adminToken, app.id);

  // A second tenant whose app the guest must never reach.
  const other = await provision({ isAdmin: true });
  const otherToken = await login(other);
  otherApp = await createApp(otherToken, 'other-app');
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
  // Remove the sample designation again: later suites (browser tests) share
  // this database and expect the plain login entry at the web root.
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM authentication.sample_site WHERE tenant_id = $1', [admin.tenantId]);
  } finally {
    await client.end();
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const info = await request('/auth/sample');
    if (!info.body.enabled) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('sample designation still visible after cleanup');
});

async function guestSession() {
  // The API caches the sample designation briefly; poll until it is visible.
  for (let attempt = 0; attempt < 20; attempt++) {
    const info = await request('/auth/sample');
    if (info.body.enabled) return info.body;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('sample site never became visible');
}

test('sample discovery reports the configured site key', async () => {
  const info = await guestSession();
  assert.equal(info.enabled, true);
  assert.equal(info.siteKey, 'test-site-key');
});

test('sample session requires a passing turnstile token', async () => {
  const bad = await request('/auth/sample-session', {
    method: 'POST', body: { turnstileToken: 'wrong-token' },
  });
  assert.equal(bad.status, 403);
  const good = await request('/auth/sample-session', {
    method: 'POST', body: { turnstileToken: 'good-token' },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.expiresIn, 3600);
  guestToken = good.body.accessToken;
  const profile = await expectRequest(200, '/auth/profile', { token: guestToken });
  assert.equal(profile.sampleGuest, true);
  assert.equal(profile.userId, guestId);
  const adminProfile = await expectRequest(200, '/auth/profile', { token: adminToken });
  assert.equal(adminProfile.sampleGuest, false);
});

test('guest browses the sample app but not other tenants', async () => {
  const apps = await expectRequest(200, '/apps', { token: guestToken });
  assert.ok(apps.some((entry) => entry.id === app.id));
  const denied = await request(`/apps/${otherApp.id}`, { token: guestToken });
  assert.equal(denied.status, 404);
  const deniedRecords = await request(`/apps/${otherApp.id}/records`, { token: guestToken });
  assert.equal(deniedRecords.status, 404);
});

test('guest submits require turnstile and accept structured values only', async () => {
  const noToken = await request(`/apps/${app.id}/records`, {
    method: 'POST', token: guestToken, body: { data: { [fields.status.fieldId]: 'a' } },
  });
  assert.equal(noToken.status, 403);

  const badToken = await request(`/apps/${app.id}/records`, {
    method: 'POST', token: guestToken, headers: { 'x-turnstile-token': 'wrong-token' },
    body: { data: { [fields.status.fieldId]: 'a' } },
  });
  assert.equal(badToken.status, 403);

  const created = await expectRequest(201, `/apps/${app.id}/records`, {
    method: 'POST', token: guestToken, headers: { 'x-turnstile-token': 'good-token' },
    body: {
      data: {
        [fields.status.fieldId]: 'a', [fields.amount.fieldId]: '10', [fields.day.fieldId]: '2026-11-24',
      },
    },
  });
  assert.equal(created.data[fields.status.fieldId], 'a');

  const textWrite = await request(`/apps/${app.id}/records`, {
    method: 'POST', token: guestToken, headers: { 'x-turnstile-token': 'good-token' },
    body: { data: { [fields.title.fieldId]: 'free text from a guest' } },
  });
  assert.ok([400, 403].includes(textWrite.status), `text write status ${textWrite.status}`);

  const updated = await expectRequest(200, `/apps/${app.id}/records/${created.id}`, {
    method: 'PUT', token: guestToken, headers: { 'x-turnstile-token': 'good-token' },
    body: { revision: created.revision, data: { [fields.status.fieldId]: 'b' } },
  });
  assert.equal(updated.data[fields.status.fieldId], 'b');

  const textUpdate = await request(`/apps/${app.id}/records/${created.id}`, {
    method: 'PUT', token: guestToken, headers: { 'x-turnstile-token': 'good-token' },
    body: { revision: updated.revision, data: { [fields.title.fieldId]: 'edited text' } },
  });
  assert.ok([400, 403].includes(textUpdate.status), `text update status ${textUpdate.status}`);
});

test('guest cannot delete, upload, or comment', async () => {
  const list = await expectRequest(200, `/apps/${app.id}/records`, { token: guestToken });
  const record = list.items[0];
  const removed = await request(`/apps/${app.id}/records/${record.id}`, {
    method: 'DELETE', token: guestToken, body: { revision: record.revision },
  });
  assert.equal(removed.status, 403);

  const upload = await fetch(new URL(`/apps/${app.id}/files?name=x.png&type=image/png`, apiUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${guestToken}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from([0x89, 0x50]),
  });
  assert.equal(upload.status, 403);

  const comment = await request(`/apps/${app.id}/records/${record.id}/comments`, {
    method: 'POST', token: guestToken, body: { text: 'spam' },
  });
  assert.equal(comment.status, 403);
});

test('non-guest users are unaffected by sample rules', async () => {
  const created = await expectRequest(201, `/apps/${app.id}/records`, {
    method: 'POST', token: adminToken,
    body: { data: { [fields.title.fieldId]: 'admin text is fine', [fields.status.fieldId]: 'a' } },
  });
  assert.equal(created.data[fields.title.fieldId], 'admin text is fine');
});
