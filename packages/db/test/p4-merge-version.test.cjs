const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const {
  sealPackage, emptyCounts, verifyPackage, PACKAGE_FORMAT_VERSION, MINIMUM_PROGRAM_VERSION,
} = require('../../../apps/api/dist/export-package.js');
const { unzipSync, zipSync, strToU8, strFromU8 } = require('../../../apps/api/node_modules/fflate');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';

// P4 merge finalization (brief-p4 §2): the package format is unchanged
// (formatVersion stays '1.0'; P4 data rides additive keys in existing
// sections), so the compatibility lever is the program-version floor:
// MINIMUM_PROGRAM_VERSION rose 1.0.0 -> 1.1.0 and PROGRAM_VERSION rose
// with it. A pre-P4 deployment (PROGRAM_VERSION '1.0.0', main @7dbc9ac
// import.ts) therefore rejects every P4 package explicitly at the
// preflight gate instead of silently dropping category assignments and
// subtable attachment references; packages written before P4 (floor
// '1.0.0') stay importable here.

async function raw(token, path, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
      ...(body && !contentType && { 'Content-Type': 'application/json' }),
    },
    body: body ? (contentType ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: response.status, body: parsed, raw: text };
}

async function uploadPackage(token, archive) {
  const result = await raw(token, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream',
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function dbQuery(sqlText, params) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

// Same dotted-numeric comparison as the import gate (import.ts
// compareVersion): returns > 0 when a is newer than b.
function compareDotted(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

const ROOT = randomUUID(); const CHILD = randomUUID();

// Builds an app that carries BOTH P4 data kinds (a category assignment
// and a subtable attachment reference) and returns its sealed package.
async function buildP4Package() {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p4-merge-src');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  const childSku = randomUUID(); const childProof = randomUUID();
  const lines = await expectRequest(201, base + '/fields', { token, method: 'POST', body: {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: childSku, code: 'sku', name: 'SKU', type: 'text', required: true, uniqueValue: false, options: [] },
      { fieldId: childProof, code: 'proof', name: 'Proof', type: 'attachment', required: false, uniqueValue: false, options: [] },
    ], minRows: 0, maxRows: 10, addRows: true, deleteRows: true, reorderRows: true },
  } });
  await publish(token, app.id);
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: {
    enabled: true,
    nodes: [
      { id: ROOT, parentId: null, name: 'Root', sortOrder: 0 },
      { id: CHILD, parentId: ROOT, name: 'Child', sortOrder: 0 },
    ],
  } });
  await publish(token, app.id);
  const pdf = Buffer.from('%PDF-1.4\np4 merge package\n%%EOF\n');
  const uploaded = await fetch(new URL(base + '/files?' + new URLSearchParams({
    name: 'proof.pdf', type: 'application/pdf',
  }), origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: pdf, signal: AbortSignal.timeout(15000),
  });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  await expectRequest(201, base + '/records', { token, method: 'POST', body: {
    data: {
      [title.fieldId]: 'Merged record',
      [lines.fieldId]: JSON.stringify([
        { rowId: randomUUID(), data: { [childSku]: 'S-1', [childProof]: JSON.stringify([file.id]) } },
      ]),
    },
    categoryIds: [CHILD],
  } });
  const job = await expectRequest(201, base + '/exports', { token, method: 'POST' });
  const run = await expectRequest(201, base + '/exports/' + job.id + '/run', { token, method: 'POST' });
  assert.equal(run.status, 'sealed', JSON.stringify(run));
  const response = await fetch(new URL(base + '/exports/' + job.id + '/package', origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

test('P4 merge: new packages carry the raised floor and import whole (categories + subtable files)', async () => {
  const archive = await buildP4Package();
  const { manifest, problems } = verifyPackage(archive);
  assert.deepEqual(problems, []);
  assert.equal(manifest.formatVersion, '1.0');
  assert.equal(manifest.formatVersion, PACKAGE_FORMAT_VERSION);
  assert.equal(manifest.minimumProgramVersion, '1.1.0');
  assert.equal(manifest.minimumProgramVersion, MINIMUM_PROGRAM_VERSION);

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const job = await uploadPackage(targetToken, archive);
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  const activated = await expectRequest(201, `/imports/${job.id}/activate`, { token: targetToken, method: 'POST' });
  assert.equal(activated.status, 'activated', JSON.stringify(activated));
  const detail = await expectRequest(200, `/imports/${job.id}`, { token: targetToken });
  const targetAppId = detail.targetAppId;
  assert.ok(targetAppId);

  // Both P4 data kinds survived the round trip in the merged build.
  const categories = await dbQuery(
    'SELECT count(*)::int AS n FROM record_categories WHERE tenant_id = $1 AND app_id = $2',
    [target.tenantId, targetAppId]);
  assert.equal(categories[0].n, 1);
  const tableRefs = await dbQuery(
    'SELECT count(*)::int AS n FROM table_file_references WHERE tenant_id = $1 AND app_id = $2',
    [target.tenantId, targetAppId]);
  assert.equal(tableRefs[0].n, 1);
  const imported = await expectRequest(200, '/apps/' + targetAppId, { token: targetToken });
  assert.equal(imported.categories.nodes.length, 2);
  const importedRoot = imported.categories.nodes.find(({ name }) => name === 'Root');
  const filtered = await expectRequest(200, `/apps/${targetAppId}/records?category=${importedRoot.id}`, { token: targetToken });
  assert.equal(filtered.items.length, 1);
});

test('P4 merge: a package whose floor exceeds the deployment is rejected explicitly, never partially imported', async () => {
  const archive = await buildP4Package();
  // The pre-P4 deployment differs from this one only in its gate constant
  // (PROGRAM_VERSION '1.0.0' at main @7dbc9ac vs '1.1.0' here; the gate
  // code is unchanged). The new floor already exceeds the old constant:
  assert.ok(compareDotted(MINIMUM_PROGRAM_VERSION, '1.0.0') > 0,
    'P4 floor must exceed the pre-P4 PROGRAM_VERSION 1.0.0');
  // Exercise the same gate live in the other direction: raise the floor
  // above this deployment and expect the explicit version error at
  // validate time (status failed + object-level error report), which is
  // exactly what a 1.0.0 deployment returns for a genuine P4 package.
  const files = unzipSync(new Uint8Array(archive));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  manifest.minimumProgramVersion = '2.0.0';
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  const tampered = Buffer.from(zipSync(files));

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const job = await uploadPackage(targetToken, tampered);
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'failed', JSON.stringify(validated));
  assert.match(JSON.stringify(validated.errorReport ?? {}),
    /requires program version 2\.0\.0 or newer; this deployment runs 1\.1\.0/);
  const leftovers = await dbQuery(
    'SELECT count(*)::int AS n FROM apps WHERE tenant_id = $1', [target.tenantId]);
  assert.equal(leftovers[0].n, 0, 'rejected package must leave no application behind');
});

test('P4 merge: a pre-P4 package (format 1.0, floor 1.0.0, no P4 keys) still validates', async () => {
  const appId = randomUUID(); const fieldId = randomUUID(); const actorId = randomUUID();
  const counts = { ...emptyCounts(), apps: 1, appVersions: 1, fieldVersionSnapshots: 1, fields: 1 };
  const files = {
    'data/app.json': JSON.stringify({ app: { id: appId, tenantId: randomUUID(), code: 'legacy-floor', name: 'Legacy', description: null, createdBy: actorId, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', publishedSchemaVersion: 1, draftSchemaVersion: null, archivedAt: null }, recordCounter: 0, autoNumberCounters: [] }),
    'data/schema.json': JSON.stringify({ versions: [{ version: 1, aclConfiguration: { app: [], record: [], field: [] }, fieldEdits: {}, formLayout: null, notificationRules: [], viewConfiguration: null, migrationReport: null, fields: [] }], fields: [{ fieldId, appId, code: 'title', name: 'Title', type: 'text', required: false, uniqueValue: false, options: [], configuration: null, introducedIn: 1, sortOrder: 0 }], rawFields: [], deletedFields: [], views: [], viewConfiguration: null, formLayout: null }),
    'data/workflows.json': JSON.stringify({ definitions: [] }),
    'data/records.json': JSON.stringify({ records: [] }),
    'data/table-rows.json': JSON.stringify({ rows: [] }),
    'data/references.json': JSON.stringify({ references: [] }),
    'data/attachments.json': JSON.stringify({ files: [] }),
    'data/comments.json': JSON.stringify({ comments: [] }),
    'data/history.json': JSON.stringify({ recordEvents: [], workflowEvents: [] }),
    'data/config.json': JSON.stringify({ acl: { app: [], record: [], field: [] }, notificationRules: [], relations: [], apiTokens: [] }),
    'data/directory.json': JSON.stringify({ users: [], groups: [], organizations: [] }),
  };
  const { archive } = sealPackage({
    manifestBase: {
      formatVersion: '1.0', minimumProgramVersion: '1.0.0', exportId: randomUUID(),
      sourceInstanceId: randomUUID(), sourceTenantId: randomUUID(), sourceAppId: appId,
      sourceAppCode: 'legacy-floor', exportedAt: '2026-01-01T00:00:00.000Z',
      snapshotCutoff: '2026-01-01T00:00:00.000Z', counts: { expected: counts },
      excluded: { temporaryAttachments: 0, purgedAttachments: 0 },
      inclusion: { customFiles: 'unsupported', pluginConfig: 'unsupported', webhooks: 'unsupported', apiTokens: 'absent', workflows: 'absent', comments: 'absent', attachments: 'included' },
      attachments: [],
      sensitiveDataNotice: 'crafted',
    },
    files,
    attachmentBodies: {},
  });
  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const job = await uploadPackage(targetToken, archive);
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
});
