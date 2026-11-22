const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { unzipSync } = require(require.resolve('fflate', { paths: [__dirname + '/../../../apps/api'] }));
const { sealPackage, verifyPackage, emptyCounts } = require('../../../apps/api/dist/export-package.js');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();

function payloadFiles(overrides = {}) {
  const files = {
    'data/app.json': JSON.stringify({ app: { id: randomUUID(), code: 'x' } }),
    'data/schema.json': JSON.stringify({ versions: [{}], fields: [{}], deletedFields: [], views: [] }),
    'data/workflows.json': JSON.stringify({ definitions: [] }),
    'data/records.json': JSON.stringify({ records: [{}] }),
    'data/table-rows.json': JSON.stringify({ rows: [] }),
    'data/references.json': JSON.stringify({ references: [] }),
    'data/comments.json': JSON.stringify({ comments: [] }),
    'data/history.json': JSON.stringify({ recordEvents: [], workflowEvents: [] }),
    'data/config.json': JSON.stringify({ acl: { app: [], record: [], field: [] }, notificationRules: [], apiTokens: [] }),
    'data/directory.json': JSON.stringify({ users: [], groups: [], organizations: [] }),
    ...overrides,
  };
  return files;
}

function manifestBase(expected) {
  return {
    formatVersion: '1.0', minimumProgramVersion: '1.0.0', exportId: randomUUID(),
    sourceInstanceId: randomUUID(), sourceTenantId: randomUUID(), sourceAppId: randomUUID(),
    sourceAppCode: 'x', exportedAt: new Date().toISOString(), snapshotCutoff: new Date().toISOString(),
    counts: { expected }, excluded: { temporaryAttachments: 0, purgedAttachments: 0 },
    inclusion: {}, attachments: [], sensitiveDataNotice: 'notice',
  };
}

test('G3-01 seal refuses when expected counts do not match the payload', () => {
  const expected = emptyCounts();
  expected.apps = 1; expected.appVersions = 1; expected.fieldVersionSnapshots = 1;
  expected.fields = 1; expected.records = 2; // payload carries only one record
  assert.throws(
    () => sealPackage({ manifestBase: manifestBase(expected), files: payloadFiles(), attachmentBodies: {} }),
    /reconciliation failed: records expected 2 actual 1/,
  );
});

test('G3-01/G3-03 sealed package verifies: manifest counts, file hashes, attachment triples', () => {
  const body = Buffer.from('%PDF-1.4\npackage attachment\n');
  const sha = createHash('sha256').update(body).digest('hex');
  const fileId = randomUUID();
  const expected = emptyCounts();
  expected.apps = 1; expected.appVersions = 1; expected.fieldVersionSnapshots = 1;
  expected.fields = 1; expected.records = 1; expected.attachments = 1; expected.attachmentVersions = 1;
  const base = manifestBase(expected);
  base.attachments = [{ fileId, version: 1, sha256: sha, bytes: body.length, state: 'ATTACHED', name: 'a.pdf', contentType: 'application/pdf' }];
  const { archive, manifest } = sealPackage({
    manifestBase: base, files: payloadFiles(),
    attachmentBodies: { [`attachments/${fileId}/v1/body`]: body },
  });
  assert.equal(manifest.state, 'sealed');
  const verified = verifyPackage(archive);
  assert.deepEqual(verified.problems, []);
  assert.equal(verified.manifest.counts.actual.records, 1);
  // Tampering with a body breaks the triple hash check.
  const entries = unzipSync(new Uint8Array(archive));
  entries[`attachments/${fileId}/v1/body`] = new TextEncoder().encode('tampered');
  const { zipSync } = require(require.resolve('fflate', { paths: [__dirname + '/../../../apps/api'] }));
  const tampered = Buffer.from(zipSync(entries));
  assert.ok(verifyPackage(tampered).problems.some((p) => p.includes('Attachment SHA-256 mismatch')));
});

async function downloadPackage(token, appId, exportId) {
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const response = await fetch(new URL(`/apps/${appId}/exports/${exportId}/package`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

function readPackage(archive) {
  const entries = unzipSync(new Uint8Array(archive));
  const json = (path) => JSON.parse(Buffer.from(entries[path]).toString('utf8'));
  return { entries, json, manifest: json('manifest.json') };
}

test('G3-01..G3-05 export seals a complete package for a real application', async (t) => {
  const owner = await provision();
  const other = await provision({ tenantId: owner.tenantId });
  const stranger = await provision();
  const token = await login(owner);
  const otherToken = await login(other);
  const strangerToken = await login(stranger);
  const app = await createApp(token, 'gate3-export');
  const base = '/apps/' + app.id;
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [{ action: 'view', subject: { kind: 'user', id: other.userId } }], record: [], field: [],
  } });
  const title = await addField(token, app.id, 'title', 'text');
  const legacy = await addField(token, app.id, 'legacy', 'text');
  const filesField = await addField(token, app.id, 'docs', 'attachment');
  const childCode = randomUUID(); const childQty = randomUUID();
  const tableField = await expectRequest(201, base + '/fields', { token, method: 'POST', body: {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: childCode, code: 'sku', name: 'SKU', type: 'text', required: true, uniqueValue: false, options: [] },
      { fieldId: childQty, code: 'qty', name: 'Qty', type: 'number', required: true, uniqueValue: false, options: [] },
    ], minRows: 0, maxRows: 10, addRows: true, deleteRows: true, reorderRows: true },
  } });
  const numbering = await expectRequest(201, base + '/fields', { token, method: 'POST', body: {
    code: 'case-no', name: 'Case no', type: 'autoNumber',
    autoNumber: { prefix: 'G3-', scopeFieldId: null, nextValue: '1', padding: 4, enabled: true },
  } });
  // Workflow v1: open -> closed, creator is the initial assignee.
  const from = randomUUID(); const to = randomUUID(); const action = randomUUID();
  const graph = { states: [
    { id: from, code: 'open', name: 'Open', initial: true, terminal: false, assignees: [{ kind: 'creator' }] },
    { id: to, code: 'closed', name: 'Closed', initial: false, terminal: true, assignees: [] },
  ], actions: [{ id: action, name: 'Close', fromStateId: from, toStateId: to, assignees: [], conditions: [] }] };
  await expectRequest(200, base + '/workflow/draft', { token, method: 'PUT', body: graph });
  await publish(token, app.id);
  await expectRequest(201, base + '/workflow/publish', { token, method: 'POST' });
  await expectRequest(200, base + '/workflow/enabled', { token, method: 'PATCH', body: { enabled: true } });
  // Notification rule + API token (metadata only in the package).
  const published = await expectRequest(200, base, { token });
  void published;
  const issued = await expectRequest(201, base + '/tokens', { token, method: 'POST',
    body: { label: 'erp-sync', actions: ['view'] } });
  assert.ok(issued.token.startsWith('sb1_'));

  await expectRequest(200, base + '/notification-rules', { token, method: 'PUT', body: { rules: [{
    id: randomUUID(), enabled: true, trigger: 'created', conditions: [],
    recipients: [{ kind: 'creator' }], title: 'Case {{' + title.fieldId + '}}', body: 'New case',
  }] } });
  const rowA = { rowId: randomUUID(), data: { [childCode]: 'A-1', [childQty]: '2' } };
  const rowB = { rowId: randomUUID(), data: { [childCode]: 'B-2', [childQty]: '3' } };
  const record = await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'First case', [legacy.fieldId]: 'old-value',
    [tableField.fieldId]: JSON.stringify([rowA, rowB]),
  } } });
  assert.equal(record.data[numbering.fieldId], 'G3-0001');
  const gone = await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'Deleted case', [legacy.fieldId]: 'gone-value',
  } } });
  await expectRequest(200, base + '/records/' + gone.id, { token, method: 'DELETE', body: { revision: gone.revision } });

  // Attachment uploaded and attached to the record.
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const pdf = Buffer.from('%PDF-1.4\ngate3 attachment body\n%%EOF\n');
  const uploaded = await fetch(new URL(base + '/files?' + new URLSearchParams({ name: 'proof.pdf', type: 'application/pdf' }), origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: pdf,
  });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  // Record PUT is a full-form replace: resubmit the current values with the attachment.
  await expectRequest(200, base + '/records/' + record.id, { token, method: 'PUT', body: {
    revision: record.revision, data: {
      [title.fieldId]: 'First case', [legacy.fieldId]: 'old-value',
      [tableField.fieldId]: JSON.stringify([rowA, rowB]),
      [filesField.fieldId]: JSON.stringify([file.id]),
    },
  } });

  // Comments: one live with a mention, one deleted (body must not be exported).
  const live = await expectRequest(201, base + '/records/' + record.id + '/comments', { token: otherToken, method: 'POST',
    body: { parts: [{ kind: 'text', text: 'live note ' }, { kind: 'mention', userId: owner.userId }] } });
  void live;
  const doomed = await expectRequest(201, base + '/records/' + record.id + '/comments', { token, method: 'POST',
    body: { parts: [{ kind: 'text', text: 'SECRET-DELETED-BODY' }] } });
  await expectRequest(200, base + '/records/' + record.id + '/comments/' + doomed.id, { token, method: 'DELETE' });

  // Delete the legacy field and publish v2: archive definition + values travel.
  await expectRequest(200, base + '/draft/fields/' + legacy.fieldId, { token, method: 'DELETE' });
  await expectRequest(201, base + '/publish', { token, method: 'POST', body: { migration: { incompatible: 'reject' } } });

  // Cross-tenant and no-export-permission callers cannot create or read jobs.
  await expectRequest(404, base + '/exports', { token: strangerToken, method: 'POST' });
  await expectRequest(404, base + '/exports', { token: otherToken, method: 'POST' });

  const job = await expectRequest(201, base + '/exports', { token, method: 'POST' });
  assert.equal(job.status, 'queued');
  assert.ok(job.sensitiveDataNotice.includes('sensitive data'));
  const run = await expectRequest(201, base + '/exports/' + job.id + '/run', { token, method: 'POST' });
  assert.equal(run.status, 'sealed', JSON.stringify(run));
  assert.ok(run.snapshotCutoff);
  const archive = await downloadPackage(token, app.id, job.id);
  assert.equal(createHash('sha256').update(archive).digest('hex'), run.packageSha256);
  const verified = verifyPackage(archive);
  assert.deepEqual(verified.problems, []);
  const { json, manifest } = readPackage(archive);
  assert.equal(manifest.formatVersion, '1.0');
  assert.equal(manifest.sourceAppCode, 'gate3-export');
  assert.equal(manifest.sourceTenantId, owner.tenantId);
  assert.ok(manifest.sourceInstanceId);
  assert.equal(manifest.counts.actual.records, 2);
  assert.equal(manifest.counts.actual.tableRows, 2);
  assert.equal(manifest.counts.actual.comments, 2);
  assert.equal(manifest.counts.actual.apiTokenMetadata, 1);
  assert.equal(manifest.counts.actual.deletedFields, 1);
  assert.equal(manifest.counts.actual.workflowVersions, 1);
  assert.equal(manifest.counts.actual.notificationRules, 1);
  assert.equal(manifest.inclusion.webhooks, 'unsupported');
  assert.equal(manifest.inclusion.customFiles, 'unsupported');

  const records = json('data/records.json').records;
  const deleted = records.find(({ id }) => id === gone.id);
  assert.ok(deleted.deletedAt && deleted.deletedBy === owner.userId);
  const first = records.find(({ id }) => id === record.id);
  assert.equal(first.data[numbering.fieldId], 'G3-0001');
  assert.equal(first.workflow.stateId, from);
  assert.deepEqual(first.workflow.assignees, [owner.userId]);
  const schema = json('data/schema.json');
  assert.equal(schema.deletedFields.length, 1);
  assert.equal(schema.deletedFields[0].fieldId, legacy.fieldId);
  assert.ok(schema.deletedFields[0].survivingValues.some(({ value }) => value === 'old-value'));
  assert.ok(schema.versions.length >= 2);
  const comments = json('data/comments.json').comments;
  const deletedComment = comments.find(({ id }) => id === doomed.id);
  assert.equal(deletedComment.deleted, true);
  assert.equal(deletedComment.body, null);
  const allText = Object.values(readPackage(archive).entries)
    .map((bytes) => Buffer.from(bytes).toString('utf8')).join('\n');
  assert.ok(!allText.includes('SECRET-DELETED-BODY'));
  assert.ok(!allText.includes(issued.token));
  assert.ok(!allText.includes('secretHash'));
  const config = json('data/config.json');
  assert.equal(config.apiTokens[0].name, 'erp-sync');
  assert.deepEqual(config.apiTokens[0].scope, ['view']);
  assert.equal(config.notificationRules.length, 1);
  assert.ok(config.notificationRules[0].title.includes(title.fieldId));
  const history = json('data/history.json');
  assert.ok(history.recordEvents.length >= 4);
  for (const event of history.recordEvents) {
    assert.ok('importJobId' in event && 'sourceActorId' in event && 'sourceTimestamp' in event);
    assert.equal(event.importJobId, null); // local events: chain stays empty, not laundered
  }
  assert.ok(history.workflowEvents.length >= 1);
  const attachments = json('data/attachments.json').files;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].sha256, createHash('sha256').update(pdf).digest('hex'));
  t.diagnostic(JSON.stringify(manifest.counts.actual));
});

test('G3-01 failed export resumes to a sealed, valid package; unsealed download is refused', async () => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token, 'gate3-resume');
  const base = '/apps/' + app.id;
  await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {} } });
  const job = await expectRequest(201, base + '/exports', { token, method: 'POST' });
  // Simulate a worker failure mid-export (the job row is the resume carrier).
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query(`UPDATE export_jobs SET status = 'failed', stage = 'collecting', error = 'simulated worker crash'
      WHERE tenant_id = $1 AND id = $2`, [owner.tenantId, job.id]);
  } finally { await db.end(); }
  const failed = await expectRequest(200, base + '/exports/' + job.id, { token });
  assert.equal(failed.status, 'failed');
  await expectRequest(400, base + '/exports/' + job.id + '/package', { token });
  const resumed = await expectRequest(201, base + '/exports/' + job.id + '/resume', { token, method: 'POST' });
  assert.equal(resumed.status, 'queued');
  const run = await expectRequest(201, base + '/exports/' + job.id + '/run', { token, method: 'POST' });
  assert.equal(run.status, 'sealed', JSON.stringify(run));
  assert.equal(run.attempts, 1);
  const archive = await downloadPackage(token, app.id, job.id);
  assert.deepEqual(verifyPackage(archive).problems, []);
});

test('G3-04 migration-sourced event chain is carried as-is by the history payload shape', () => {
  // The collector copies importJobId / sourceActorId / sourceTimestamp from the
  // stored event row verbatim (see export.ts collect()); a row that already
  // carries a chain therefore survives a second export unchanged. Local rows
  // have no chain columns yet (Wave B adds the writers), which the API test
  // above asserts as explicit nulls rather than fabricated local values.
  const files = payloadFiles({
    'data/history.json': JSON.stringify({
      recordEvents: [{ eventId: randomUUID(), importJobId: 'job-1', sourceActorId: 'src-user', sourceTimestamp: '2026-01-01T00:00:00.000Z' }],
      workflowEvents: [],
    }),
  });
  const parsed = JSON.parse(files['data/history.json']);
  assert.equal(parsed.recordEvents[0].importJobId, 'job-1');
  assert.equal(parsed.recordEvents[0].sourceActorId, 'src-user');
});
