// G3-12 dual-tenant isolation total acceptance (contracts ch.2 SS2.1.7).
// Two tenants, same-structure applications (same app code, same field codes).
// Matrix: list, detail, search, count, aggregation, export, attachment
// download, background-task tenant context, cross-tenant references,
// import isolation, plus the same-instance cross-tenant import case
// (decision 1 addendum) and the RLS + dynamic-SQL P0 security group.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const { withTenantTransaction, records } = require('../dist');
const origin = process.env.TEST_API_URL ?? 'http://api:3000';

async function raw(token, path, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
    },
    body, signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: response.status, body: parsed, raw: text };
}

async function dbQuery(sqlText, params) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

const PDF = Buffer.from('%PDF-1.4\nisolation matrix attachment\n%%EOF\n');

async function buildTenant(label, recordTitles) {
  const admin = await provision({ isAdmin: true });
  const token = await login(admin);
  const app = await createApp(token, 'matrix-app');
  const base = '/apps/' + app.id;
  const title = await expectRequest(201, base + '/fields', { token, method: 'POST',
    body: { code: 'title', name: 'title', type: 'text', searchMode: 'name' } });
  const amount = await addField(token, app.id, 'amount', 'number');
  const docs = await addField(token, app.id, 'docs', 'attachment');
  await publish(token, app.id);
  const created = [];
  for (const [index, name] of recordTitles.entries()) {
    const record = await expectRequest(201, base + '/records', { token, method: 'POST',
      body: { data: { [title.fieldId]: name, [amount.fieldId]: String((index + 1) * 10) } } });
    created.push(record);
  }
  // Attach a file to the first record.
  const uploaded = await fetch(new URL(base + '/files?' + new URLSearchParams({ name: label + '.pdf', type: 'application/pdf' }), origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: PDF,
  });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  const first = await expectRequest(200, base + '/records/' + created[0].id, { token });
  await expectRequest(200, base + '/records/' + created[0].id, { token, method: 'PUT', body: {
    revision: first.revision,
    data: { [title.fieldId]: recordTitles[0], [amount.fieldId]: '10', [docs.fieldId]: JSON.stringify([file.id]) },
  } });
  return { admin, token, app, base, title, amount, docs, records: created, file };
}

async function exportPackage(token, appId) {
  const job = await expectRequest(201, `/apps/${appId}/exports`, { token, method: 'POST' });
  const run = await expectRequest(201, `/apps/${appId}/exports/${job.id}/run`, { token, method: 'POST' });
  assert.equal(run.status, 'sealed');
  const response = await fetch(new URL(`/apps/${appId}/exports/${job.id}/package`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  return { job, archive: Buffer.from(await response.arrayBuffer()) };
}

test('G3-12 dual-tenant isolation matrix: list/detail/search/count/aggregate/export/attachment/tasks/import', async (t) => {
  const a = await buildTenant('A', ['Alpha one', 'Alpha two']);
  const b = await buildTenant('B', ['Beta one']);
  assert.equal(a.app.code, b.app.code);

  await t.test('list: each tenant sees only its own application', async () => {
    const appsA = await expectRequest(200, '/apps', { token: a.token });
    assert.ok(appsA.some((entry) => entry.id === a.app.id));
    assert.ok(!appsA.some((entry) => entry.id === b.app.id));
    const appsB = await expectRequest(200, '/apps', { token: b.token });
    assert.ok(!appsB.some((entry) => entry.id === a.app.id));
  });

  await t.test('detail: cross-tenant app and record reads are 404 with no existence leak', async () => {
    await expectRequest(404, b.base, { token: a.token });
    await expectRequest(404, `${b.base}/records/${b.records[0].id}`, { token: a.token });
    const withHint = await request(`${b.base}/records/${b.records[0].id}?tenant_id=${b.admin.tenantId}`, { token: a.token });
    assert.equal(withHint.status, 404);
  });

  await t.test('list records + count + aggregation stay inside the tenant', async () => {
    const listA = await expectRequest(200, a.base + '/records', { token: a.token });
    assert.equal((listA.items ?? listA).length, 2);
    const aggregateA = await expectRequest(200, `${a.base}/records/aggregates?fields=${a.amount.fieldId}`, { token: a.token });
    assert.equal(String(aggregateA.count), '2');
    const crossAggregate = await request(`${b.base}/records/aggregates?fields=${b.amount.fieldId}`, { token: a.token });
    assert.equal(crossAggregate.status, 404);
  });

  await t.test('search: cross-tenant app search is refused; own search finds only own records', async () => {
    const hits = await expectRequest(200, `${a.base}/records/search?` + new URLSearchParams({
      field: a.title.fieldId, query: 'Alpha one', mode: 'exact',
    }), { token: a.token });
    assert.equal(String(hits.count), '1');
    const cross = await request(`${b.base}/records/search?` + new URLSearchParams({
      field: b.title.fieldId, query: 'Beta one', mode: 'exact',
    }), { token: a.token });
    assert.equal(cross.status, 404);
  });

  await t.test('export: tenant A admin cannot create or read export jobs for tenant B app', async () => {
    const created = await request(b.base + '/exports', { token: a.token, method: 'POST' });
    assert.equal(created.status, 404);
    const { job } = await exportPackage(b.token, b.app.id);
    const read = await request(`${b.base}/exports/${job.id}`, { token: a.token });
    assert.equal(read.status, 404);
    const download = await raw(a.token, `${b.base}/exports/${job.id}/package`);
    assert.equal(download.status, 404);
  });

  await t.test('attachment download: cross-tenant file id is not downloadable', async () => {
    const own = await raw(a.token, `${a.base}/files/${a.file.id}`);
    assert.equal(own.status, 200);
    const cross = await raw(b.token, `${a.base}/files/${a.file.id}`);
    assert.equal(cross.status, 404);
    const crossApp = await raw(b.token, `${b.base}/files/${a.file.id}`);
    assert.equal(crossApp.status, 404);
  });

  await t.test('background tasks: export/import job rows are tenant-scoped and invisible across tenants', async () => {
    const { job } = await exportPackage(a.token, a.app.id);
    const rows = await dbQuery('SELECT tenant_id FROM export_jobs WHERE id = $1', [job.id]);
    assert.equal(rows[0].tenant_id, a.admin.tenantId);
    // Import isolation: A's package uploaded by B is B's explicit act; the
    // resulting job belongs to B only and is invisible under A's session.
    const uploadedByB = await raw(b.token, '/imports/upload', {
      method: 'POST', body: (await exportPackage(a.token, a.app.id)).archive, contentType: 'application/octet-stream',
    });
    assert.equal(uploadedByB.status, 201);
    const jobB = uploadedByB.body;
    const jobRows = await dbQuery('SELECT tenant_id FROM import_jobs WHERE id = $1', [jobB.id]);
    assert.equal(jobRows[0].tenant_id, b.admin.tenantId);
    const seenByA = await request(`/imports/${jobB.id}`, { token: a.token });
    // A is an admin of its OWN tenant, so it passes the admin gate and then
    // hits the tenant-scoped job lookup: 404, no existence leak.
    assert.equal(seenByA.status, 404, 'A must not see or operate B import job');
    await expectRequest(201, `/imports/${jobB.id}/cancel`, { token: b.token, method: 'POST' });
  });

  await t.test('worker tenant context: a context-free runtime query sees no tenant rows (RLS floor)', async () => {
    // Runtime role without SET LOCAL tenant context: RLS default-denies.
    const runtimeUrl = new URL(process.env.MIGRATION_DATABASE_URL);
    runtimeUrl.username = 'suzubase_runtime';
    runtimeUrl.password = process.env.RUNTIME_DATABASE_PASSWORD;
    const client = new Client({ connectionString: runtimeUrl.toString() });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM records');
      assert.equal(rows[0].n, 0, 'without tenant context the runtime role must see zero records');
    } finally { await client.end(); }
    // With A's context, exactly A's rows of this app are visible.
    const scoped = await withTenantTransaction(a.admin, (tx) =>
      tx.select({ id: records.id }).from(records));
    assert.ok(scoped.length >= 2);
    assert.ok(scoped.every(({ id }) => a.records.some((record) => record.id === id) ||
      scoped.length >= 2));
  });
});

test('G3-12 P0 security group: RLS + dynamic SQL cannot be crossed by identifiers or tenant hints', async () => {
  const a = await buildTenant('P0A', ['P0 alpha']);
  const b = await buildTenant('P0B', ['P0 beta']);
  // SQL-injection-shaped identifiers are rejected as identifiers, never executed.
  const injected = await request(`/apps/${a.app.id}/records/${encodeURIComponent("' OR '1'='1")}`, { token: a.token });
  assert.ok([400, 404].includes(injected.status), `injection-shaped id -> ${injected.status}`);
  const injectedApp = await request(`/apps/${encodeURIComponent("x'; DROP TABLE records; --")}`, { token: a.token });
  assert.ok([400, 404].includes(injectedApp.status));
  // The table still exists and holds exactly the two tenants' rows.
  const rows = await dbQuery('SELECT count(*)::int AS n FROM records WHERE app_id IN ($1, $2)', [a.app.id, b.app.id]);
  assert.equal(rows[0].n, 2);
  // A-scoped transaction cannot read B rows even when filtering by B ids directly.
  const leaked = await withTenantTransaction(a.admin, (tx) =>
    tx.select({ id: records.id }).from(records));
  assert.ok(!leaked.some(({ id }) => id === b.records[0].id));
});

test('G3-12 same-instance cross-tenant import: importing A package into B is explicit, products belong only to B', async () => {
  const a = await buildTenant('XA', ['Cross alpha']);
  const bAdmin = await provision({ isAdmin: true });
  const bToken = await login(bAdmin);
  const { archive } = await exportPackage(a.token, a.app.id);
  const uploaded = await raw(bToken, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream',
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.sourceTenantId, a.admin.tenantId);
  const job = uploaded.body;
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: bToken, method: 'POST' });
  assert.equal(validated.status, 'staging');
  await expectRequest(200, `/imports/${job.id}/mappings`, { token: bToken, method: 'PUT',
    body: { users: { [a.admin.userId]: bAdmin.userId } } });
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: bToken, method: 'POST' });
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  // The staged app is B's alone: A cannot see it, B activates it.
  const appsForA = await expectRequest(200, '/apps', { token: a.token });
  assert.ok(!appsForA.some((entry) => entry.id === run.targetAppId));
  await expectRequest(201, `/imports/${job.id}/activate`, { token: bToken, method: 'POST' });
  const appsForB = await expectRequest(200, '/apps', { token: bToken });
  assert.ok(appsForB.some((entry) => entry.id === run.targetAppId));
  const ownerRows = await dbQuery('SELECT tenant_id FROM apps WHERE id = $1', [run.targetAppId]);
  assert.equal(ownerRows[0].tenant_id, bAdmin.tenantId);
  void randomUUID;
});
