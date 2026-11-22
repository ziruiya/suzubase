// Gate 3 Wave C (G3-10..G3-15 acceptance additions):
//  - gap fix 1: import upload route-scoped body limit (>8 MB package accepted,
//    single-attachment routes keep the 8 MB cap)
//  - gap fix 2: worker queue-run + /imports/:id/resume automated coverage
//  - G3-11: package format-version / minimum-program-version rejection,
//    golden package regression, storage portability across deployments
//  - G3-14: least-privilege walk of the migration path, export permission bit
//  - G3-15: second-migration provenance chain fidelity, migration token
//    cross-job / cross-app rejection
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');
const { sealPackage, emptyCounts } = require('../../../apps/api/dist/export-package.js');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';

async function raw(token, path, { method = 'GET', body, contentType, timeout = 30000 } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
    },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: response.status, body: parsed, raw: text };
}

async function uploadPackage(token, archive) {
  const result = await raw(token, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream', timeout: 120000,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body).slice(0, 400));
  return result.body;
}

async function downloadExport(token, appId, exportId) {
  const response = await fetch(new URL(`/apps/${appId}/exports/${exportId}/package`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

async function exportApp(token, appId) {
  const job = await expectRequest(201, `/apps/${appId}/exports`, { token, method: 'POST' });
  const run = await expectRequest(201, `/apps/${appId}/exports/${job.id}/run`, { token, method: 'POST' });
  assert.equal(run.status, 'sealed', JSON.stringify(run));
  return downloadExport(token, appId, job.id);
}

async function dbQuery(sqlText, params) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

const PDF = Buffer.from('%PDF-1.4\nwave-c attachment body\n%%EOF\n');
const PDF_SHA = createHash('sha256').update(PDF).digest('hex');

// Small but complete source app: title + auto-number + attachment + comment.
async function buildSourcePackage() {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'wavec-src-' + randomUUID().slice(0, 8));
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  const docs = await addField(token, app.id, 'docs', 'attachment');
  const numbering = await expectRequest(201, base + '/fields', { token, method: 'POST', body: {
    code: 'case-no', name: 'Case no', type: 'autoNumber',
    autoNumber: { prefix: 'WC-', scopeFieldId: null, nextValue: '1', padding: 4, enabled: true },
  } });
  await publish(token, app.id);
  const record = await expectRequest(201, base + '/records', { token, method: 'POST',
    body: { data: { [title.fieldId]: 'Wave C case' } } });
  const uploaded = await fetch(new URL(base + '/files?' + new URLSearchParams({ name: 'proof.pdf', type: 'application/pdf' }), origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: PDF,
  });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  const current = await expectRequest(200, base + '/records/' + record.id, { token });
  await expectRequest(200, base + '/records/' + record.id, { token, method: 'PUT', body: {
    revision: current.revision,
    data: { [title.fieldId]: 'Wave C case', [docs.fieldId]: JSON.stringify([file.id]) },
  } });
  await expectRequest(201, base + '/records/' + record.id + '/comments', { token, method: 'POST',
    body: { parts: [{ kind: 'text', text: 'wave c note' }] } });
  const archive = await exportApp(token, app.id);
  return { owner, token, app, archive, record, fields: { title, docs, numbering } };
}

async function stageImport(targetToken, archive, mappings = {}, { confirmDuplicateFirst = false } = {}) {
  const job = await uploadPackage(targetToken, archive);
  if (confirmDuplicateFirst) {
    await expectRequest(200, `/imports/${job.id}/mappings`, { token: targetToken, method: 'PUT', body: { confirmDuplicate: true } });
  }
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  if (Object.keys(mappings).length) {
    await expectRequest(200, `/imports/${job.id}/mappings`, { token: targetToken, method: 'PUT', body: mappings });
  }
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  assert.ok(issued.token.startsWith('sbm1_'));
  return { job, issued };
}

async function runAndActivate(adminToken, staged) {
  const run = await expectRequest(201, `/imports/${staged.job.id}/run`, { token: staged.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  const activated = await expectRequest(201, `/imports/${staged.job.id}/activate`, { token: adminToken, method: 'POST' });
  assert.equal(activated.status, 'activated');
  return run;
}

// Minimal crafted package (mirrors the Wave B crafted-package shape).
function craftPackage(manifestOverrides = {}) {
  const appId = randomUUID(); const fieldId = randomUUID(); const actorId = randomUUID();
  const counts = { ...emptyCounts(), apps: 1, appVersions: 1, fieldVersionSnapshots: 1, fields: 1 };
  const files = {
    'data/app.json': JSON.stringify({ app: { id: appId, tenantId: randomUUID(), code: 'crafted-c', name: 'Crafted C',
      description: null, createdBy: actorId, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', publishedSchemaVersion: 1, draftSchemaVersion: null, archivedAt: null },
      recordCounter: 0, autoNumberCounters: [] }),
    'data/schema.json': JSON.stringify({ versions: [{ version: 1, aclConfiguration: { app: [], record: [], field: [] },
      fieldEdits: {}, formLayout: null, notificationRules: [], viewConfiguration: null, migrationReport: null, fields: [] }],
      fields: [{ fieldId, appId, code: 'title', name: 'Title', type: 'text', required: false,
        uniqueValue: false, options: [], configuration: null, introducedIn: 1, sortOrder: 0 }],
      rawFields: [], deletedFields: [], views: [], viewConfiguration: null, formLayout: null }),
    'data/workflows.json': JSON.stringify({ definitions: [] }),
    'data/records.json': JSON.stringify({ records: [] }),
    'data/table-rows.json': JSON.stringify({ rows: [] }),
    'data/references.json': JSON.stringify({ references: [] }),
    'data/attachments.json': JSON.stringify({ files: [] }),
    'data/comments.json': JSON.stringify({ comments: [] }),
    'data/history.json': JSON.stringify({ recordEvents: [], workflowEvents: [] }),
    'data/config.json': JSON.stringify({ acl: { app: [], record: [], field: [] }, notificationRules: [],
      relations: [], apiTokens: [] }),
    'data/directory.json': JSON.stringify({ users: [], groups: [], organizations: [] }),
  };
  const { archive } = sealPackage({
    manifestBase: {
      formatVersion: '1.0', minimumProgramVersion: '1.0.0', exportId: randomUUID(),
      sourceInstanceId: randomUUID(), sourceTenantId: randomUUID(), sourceAppId: appId,
      sourceAppCode: 'crafted-c', exportedAt: '2026-01-01T00:00:00.000Z',
      snapshotCutoff: '2026-01-01T00:00:00.000Z', counts: { expected: counts },
      excluded: { temporaryAttachments: 0, purgedAttachments: 0 },
      inclusion: { customFiles: 'unsupported', pluginConfig: 'unsupported', webhooks: 'unsupported',
        apiTokens: 'absent', workflows: 'absent', comments: 'absent', attachments: 'absent' },
      attachments: [], sensitiveDataNotice: 'crafted',
      ...manifestOverrides,
    },
    files, attachmentBodies: {},
  });
  return archive;
}

test('gap fix: import upload accepts a package larger than the 8 MB attachment cap; attachment route still refuses', async () => {
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  // A sealed package whose single attachment body is 9 MiB of incompressible data.
  const body = randomBytes(9 * 1024 * 1024);
  const sha = createHash('sha256').update(body).digest('hex');
  const appId = randomUUID(); const fieldId = randomUUID(); const fileId = randomUUID(); const actorId = randomUUID();
  const counts = { ...emptyCounts(), apps: 1, appVersions: 1, fieldVersionSnapshots: 1,
    fields: 1, attachments: 1, attachmentVersions: 1 };
  const files = {
    'data/app.json': JSON.stringify({ app: { id: appId, tenantId: randomUUID(), code: 'bigpkg', name: 'Big',
      description: null, createdBy: actorId, createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', publishedSchemaVersion: 1, draftSchemaVersion: null, archivedAt: null },
      recordCounter: 0, autoNumberCounters: [] }),
    'data/schema.json': JSON.stringify({ versions: [{ version: 1, aclConfiguration: { app: [], record: [], field: [] },
      fieldEdits: {}, formLayout: null, notificationRules: [], viewConfiguration: null, migrationReport: null, fields: [] }],
      fields: [{ fieldId, appId, code: 'docs', name: 'Docs', type: 'attachment', required: false,
        uniqueValue: false, options: [], configuration: null, introducedIn: 1, sortOrder: 0 }],
      rawFields: [], deletedFields: [], views: [], viewConfiguration: null, formLayout: null }),
    'data/workflows.json': JSON.stringify({ definitions: [] }),
    'data/records.json': JSON.stringify({ records: [] }),
    'data/table-rows.json': JSON.stringify({ rows: [] }),
    'data/references.json': JSON.stringify({ references: [] }),
    'data/attachments.json': JSON.stringify({ files: [{ id: fileId, tenantId: randomUUID(), appId, recordId: null,
      name: 'big.bin', contentType: 'application/octet-stream', byteSize: body.length,
      createdBy: actorId, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null,
      versions: [{ fileId, version: 1, sha256: sha, byteSize: body.length,
        createdBy: actorId, createdAt: '2026-01-01T00:00:00.000Z' }] }] }),
    'data/comments.json': JSON.stringify({ comments: [] }),
    'data/history.json': JSON.stringify({ recordEvents: [], workflowEvents: [] }),
    'data/config.json': JSON.stringify({ acl: { app: [], record: [], field: [] }, notificationRules: [],
      relations: [], apiTokens: [] }),
    'data/directory.json': JSON.stringify({ users: [], groups: [], organizations: [] }),
  };
  const { archive } = sealPackage({
    manifestBase: {
      formatVersion: '1.0', minimumProgramVersion: '1.0.0', exportId: randomUUID(),
      sourceInstanceId: randomUUID(), sourceTenantId: randomUUID(), sourceAppId: appId,
      sourceAppCode: 'bigpkg', exportedAt: '2026-01-01T00:00:00.000Z',
      snapshotCutoff: '2026-01-01T00:00:00.000Z', counts: { expected: counts },
      excluded: { temporaryAttachments: 0, purgedAttachments: 0 },
      inclusion: { customFiles: 'unsupported', pluginConfig: 'unsupported', webhooks: 'unsupported',
        apiTokens: 'absent', workflows: 'absent', comments: 'absent', attachments: 'included' },
      attachments: [{ fileId, version: 1, sha256: sha, bytes: body.length, state: 'stored',
        name: 'big.bin', contentType: 'application/octet-stream' }],
      sensitiveDataNotice: 'crafted',
    },
    files, attachmentBodies: { [`attachments/${fileId}/v1/body`]: body },
  });
  assert.ok(archive.length > 8 * 1024 * 1024, `package must exceed 8 MiB (got ${archive.length})`);
  const job = await uploadPackage(adminToken, archive);
  assert.equal(job.packageBytes, archive.length);
  await expectRequest(201, `/imports/${job.id}/cancel`, { token: adminToken, method: 'POST' });

  // The single-attachment route keeps its cap: the same 9 MiB body is refused.
  const app = await createApp(adminToken, 'wavec-cap');
  await addField(adminToken, app.id, 'docs', 'attachment');
  await publish(adminToken, app.id);
  const bigPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(9 * 1024 * 1024)]);
  const refused = await raw(adminToken,
    `/apps/${app.id}/files?` + new URLSearchParams({ name: 'big.pdf', type: 'application/pdf' }),
    { method: 'POST', body: bigPdf, contentType: 'application/octet-stream', timeout: 120000 });
  assert.equal(refused.status, 413, JSON.stringify(refused.body).slice(0, 200));
});

test('G3-11 format version above the supported window is rejected with reason and recourse', async () => {
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const job = await uploadPackage(adminToken, craftPackage({ formatVersion: '2.0' }));
  const failed = await expectRequest(201, `/imports/${job.id}/validate`, { token: adminToken, method: 'POST' });
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  const report = JSON.stringify(failed.errorReport ?? {});
  assert.match(report, /format/i);
  assert.match(report, /2\.0/);
  const downloaded = await raw(adminToken, `/imports/${job.id}/error-report`);
  assert.equal(downloaded.status, 200);
});

test('G3-11 package requiring a higher minimum program version is rejected with reason and recourse', async () => {
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const job = await uploadPackage(adminToken, craftPackage({ minimumProgramVersion: '99.0.0' }));
  const failed = await expectRequest(201, `/imports/${job.id}/validate`, { token: adminToken, method: 'POST' });
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  const report = JSON.stringify(failed.errorReport ?? {});
  assert.match(report, /99\.0\.0/);
  assert.match(report, /[Uu]pgrade/);
});

test('gap fix: queue-run requires the migration token, flags the job and audits; worker drains it when present', async (t) => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const staged = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: admin.userId },
  });
  // Session credentials cannot use the migration channel.
  const sessionAttempt = await request(`/imports/${staged.job.id}/queue-run`, { token: adminToken, method: 'POST' });
  assert.equal(sessionAttempt.status, 401);
  const queued = await expectRequest(201, `/imports/${staged.job.id}/queue-run`, { token: staged.issued.token, method: 'POST' });
  assert.equal(queued.status, 'staging');
  const rows = await dbQuery('SELECT execute_requested FROM import_jobs WHERE tenant_id = $1 AND id = $2',
    [admin.tenantId, staged.job.id]);
  assert.equal(rows[0].execute_requested, true);
  const audit = await expectRequest(200, `/imports/${staged.job.id}/audit`, { token: adminToken });
  assert.ok(audit.some((entry) => entry.action === 'execution-queued'));
  if (process.env.WORKER_POLL === '1') {
    // A live worker (compose stack) must drain the queued job to READY.
    let job = null;
    for (let i = 0; i < 40; i++) {
      job = await expectRequest(200, `/imports/${staged.job.id}`, { token: adminToken });
      if (job.status === 'ready' || job.status === 'failed') break;
      await new Promise((done) => setTimeout(done, 3000));
    }
    assert.equal(job.status, 'ready', JSON.stringify(job).slice(0, 400));
    await expectRequest(201, `/imports/${staged.job.id}/activate`, { token: adminToken, method: 'POST' });
  } else {
    t.diagnostic('WORKER_POLL not set: queue flag + audit asserted; worker drain covered by the compose-stack scenario run');
    await expectRequest(201, `/imports/${staged.job.id}/cancel`, { token: adminToken, method: 'POST' });
  }
});

test('gap fix: resume returns an interrupted staging run to validated and the run then completes', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const staged = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: admin.userId },
  });
  // Resume is only legal from the interrupted state.
  const early = await request(`/imports/${staged.job.id}/resume`, { token: adminToken, method: 'POST' });
  assert.equal(early.status, 400);
  // Simulate a worker crash after the atomic claim (stage = writing).
  await dbQuery("UPDATE import_jobs SET stage = 'writing' WHERE tenant_id = $1 AND id = $2",
    [admin.tenantId, staged.job.id]);
  const resumed = await expectRequest(201, `/imports/${staged.job.id}/resume`, { token: adminToken, method: 'POST' });
  assert.equal(resumed.status, 'staging');
  assert.equal(resumed.stage, 'validated');
  const run = await expectRequest(201, `/imports/${staged.job.id}/run`, { token: staged.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  await expectRequest(201, `/imports/${staged.job.id}/cancel`, { token: adminToken, method: 'POST' });
});

test('G3-15 migration token cannot act on another job (cross-job / cross-app scope)', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const first = await stageImport(adminToken, source.archive, { users: { [source.owner.userId]: admin.userId } });
  const second = await stageImport(adminToken, source.archive, { users: { [source.owner.userId]: admin.userId } }, { confirmDuplicateFirst: true });
  const crossRun = await request(`/imports/${second.job.id}/run`, { token: first.issued.token, method: 'POST' });
  assert.equal(crossRun.status, 403, JSON.stringify(crossRun.body));
  const crossResolve = await request(`/imports/${second.job.id}/resolve-assignees`, {
    token: first.issued.token, method: 'POST',
    body: { items: [{ recordId: randomUUID(), sourceUserId: 'someone', userId: null }] },
  });
  assert.equal(crossResolve.status, 403, JSON.stringify(crossResolve.body));
  await expectRequest(201, `/imports/${first.job.id}/cancel`, { token: adminToken, method: 'POST' });
  await expectRequest(201, `/imports/${second.job.id}/cancel`, { token: adminToken, method: 'POST' });
});

test('G3-14 least privilege: app creator without tenant-admin rights cannot upload, view or token-issue import jobs', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const creator = await provision({ tenantId: admin.tenantId, canCreateApps: true });
  const plain = await provision({ tenantId: admin.tenantId });
  const adminToken = await login(admin);
  const creatorToken = await login(creator);
  const plainToken = await login(plain);
  // The creator can build apps but is not a tenant administrator.
  const ownApp = await createApp(creatorToken, 'wavec-creator-app');
  assert.ok(ownApp.id);
  const deniedUpload = await raw(creatorToken, '/imports/upload', {
    method: 'POST', body: source.archive, contentType: 'application/octet-stream',
  });
  assert.equal(deniedUpload.status, 403);
  const staged = await stageImport(adminToken, source.archive, { users: { [source.owner.userId]: admin.userId } });
  for (const token of [creatorToken, plainToken]) {
    const view = await request(`/imports/${staged.job.id}`, { token });
    assert.equal(view.status, 403, JSON.stringify(view.body));
    const list = await request('/imports', { token });
    assert.equal(list.status, 403);
    const issue = await request(`/imports/${staged.job.id}/migration-token`, { token, method: 'POST' });
    assert.equal(issue.status, 403);
  }
  await expectRequest(201, `/imports/${staged.job.id}/cancel`, { token: adminToken, method: 'POST' });
});

test('G3-14 export action is gated by the app ACL export permission bit', async () => {
  const owner = await provision({ isAdmin: true });
  const other = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const otherToken = await login(other);
  const app = await createApp(token, 'wavec-export-bit');
  const base = '/apps/' + app.id;
  await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  // View-only member: no export bit -> export job creation refused (404, no leak).
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [{ action: 'view', subject: { kind: 'user', id: other.userId } }], record: [], field: [],
  } });
  await publish(token, app.id);
  const denied = await request(base + '/exports', { token: otherToken, method: 'POST' });
  assert.equal(denied.status, 404, JSON.stringify(denied.body));
  // Grant the export bit explicitly -> creation succeeds.
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [
      { action: 'view', subject: { kind: 'user', id: other.userId } },
      { action: 'export', subject: { kind: 'user', id: other.userId } },
    ], record: [], field: [],
  } });
  await publish(token, app.id);
  const job = await expectRequest(201, base + '/exports', { token: otherToken, method: 'POST' });
  assert.equal(job.status, 'queued');
});

test('G3-11 storage portability: the same package restored under two tenants yields identical attachment bodies and hashes', async () => {
  const source = await buildSourcePackage();
  const restored = [];
  for (let i = 0; i < 2; i++) {
    const admin = await provision({ isAdmin: true });
    const adminToken = await login(admin);
    const staged = await stageImport(adminToken, source.archive, {
      users: { [source.owner.userId]: admin.userId },
    });
    const run = await runAndActivate(adminToken, staged);
    const targetBase = '/apps/' + run.targetAppId;
    const published = await expectRequest(200, targetBase, { token: adminToken });
    const docsField = published.fields.find((field) => field.code === 'docs');
    const records = await expectRequest(200, targetBase + '/records', { token: adminToken });
    const items = records.items ?? records;
    assert.equal(items.length, 1);
    const record = await expectRequest(200, targetBase + '/records/' + items[0].id, { token: adminToken });
    const fileIds = JSON.parse(record.data[docsField.fieldId]);
    assert.equal(fileIds.length, 1);
    const response = await fetch(new URL(`${targetBase}/files/${fileIds[0]}`, origin), {
      headers: { Authorization: 'Bearer ' + adminToken }, signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200);
    const body = Buffer.from(await response.arrayBuffer());
    restored.push({ sha: createHash('sha256').update(body).digest('hex'), body });
  }
  assert.equal(restored[0].sha, PDF_SHA);
  assert.equal(restored[1].sha, PDF_SHA);
  assert.ok(restored[0].body.equals(restored[1].body));
});

test('G3-15 second migration keeps the first migration provenance chain intact', async () => {
  const source = await buildSourcePackage();
  // First migration: source tenant -> tenant B.
  const adminB = await provision({ isAdmin: true });
  const tokenB = await login(adminB);
  const stagedB = await stageImport(tokenB, source.archive, { users: { [source.owner.userId]: adminB.userId } });
  const runB = await runAndActivate(tokenB, stagedB);
  // Export the restored application from B and migrate it again into tenant C.
  const archiveB = await exportApp(tokenB, runB.targetAppId);
  const { unzipSync } = require(require.resolve('fflate', { paths: [__dirname + '/../../../apps/api'] }));
  const entries = unzipSync(new Uint8Array(archiveB));
  const history = JSON.parse(Buffer.from(entries['data/history.json']).toString('utf8'));
  assert.ok(history.recordEvents.length >= 1);
  for (const event of history.recordEvents) {
    assert.equal(event.importJobId, stagedB.job.id,
      'second export must carry the FIRST import job id, not a laundered local chain');
    assert.equal(event.sourceActorId, source.owner.userId);
  }
  const adminC = await provision({ isAdmin: true });
  const tokenC = await login(adminC);
  const stagedC = await stageImport(tokenC, archiveB, { users: { [adminB.userId]: adminC.userId } });
  const runC = await runAndActivate(tokenC, stagedC);
  const targetBase = '/apps/' + runC.targetAppId;
  const records = await expectRequest(200, targetBase + '/records', { token: tokenC });
  const items = records.items ?? records;
  const historyC = await expectRequest(200, `${targetBase}/records/${items[0].id}/history`, { token: tokenC });
  assert.ok(historyC.events.length >= 1);
  for (const event of historyC.events) {
    assert.equal(event.source, 'migration');
    assert.equal(event.migration?.importJobId, stagedB.job.id);
  }
});

test('G3-11 golden package imports cleanly with current code (regression)', async () => {
  const goldenPath = resolve(__dirname, 'fixtures/golden-app-1.zip');
  const archive = readFileSync(goldenPath);
  const { verifyPackage } = require('../../../apps/api/dist/export-package.js');
  const verified = verifyPackage(archive);
  assert.deepEqual(verified.problems, []);
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const staged = await stageImport(adminToken, archive, {});
  const run = await runAndActivate(adminToken, staged);
  const detail = await expectRequest(200, `/imports/${staged.job.id}`, { token: adminToken });
  assert.equal(detail.report.counts.target.records, verified.manifest.counts.actual.records);
  assert.equal(detail.report.verification.attachments.failed.length, 0);
  const records = await expectRequest(200, '/apps/' + run.targetAppId + '/records', { token: adminToken });
  const items = records.items ?? records;
  assert.ok(items.length >= 1);
});
