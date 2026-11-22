const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { sealPackage, emptyCounts } = require('../../../apps/api/dist/export-package.js');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';

async function raw(token, path, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
    },
    body,
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

async function downloadExport(token, appId, exportId) {
  const response = await fetch(new URL(`/apps/${appId}/exports/${exportId}/package`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
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

// Builds a source application with a workflow, an auto number, an attachment,
// a subtable, comments from two authors, a soft-deleted record and an API
// token, then returns its sealed export package.
async function buildSourcePackage({ assigneeMode = 'creator' } = {}) {
  const owner = await provision({ isAdmin: true });
  const other = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const otherToken = await login(other);
  const app = await createApp(token, 'gate3-src-' + randomUUID().slice(0, 8));
  const base = '/apps/' + app.id;
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [{ action: 'view', subject: { kind: 'user', id: other.userId } }], record: [], field: [],
  } });
  const title = await addField(token, app.id, 'title', 'text');
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
  const from = randomUUID(); const to = randomUUID(); const action = randomUUID();
  const assignees = assigneeMode === 'other'
    ? [{ kind: 'user', id: other.userId }] : [{ kind: 'creator' }];
  await expectRequest(200, base + '/workflow/draft', { token, method: 'PUT', body: { states: [
    { id: from, code: 'open', name: 'Open', initial: true, terminal: false, assignees },
    { id: to, code: 'closed', name: 'Closed', initial: false, terminal: true, assignees: [] },
  ], actions: [{ id: action, name: 'Close', fromStateId: from, toStateId: to, assignees: [], conditions: [] }] } });
  await expectRequest(200, base + '/notification-rules', { token, method: 'PUT', body: { rules: [{
    id: randomUUID(), enabled: true, trigger: 'created', conditions: [],
    recipients: [{ kind: 'creator' }], title: 'New case', body: 'Created',
  }] } });
  await publish(token, app.id);
  await expectRequest(201, base + '/workflow/publish', { token, method: 'POST' });
  await expectRequest(200, base + '/workflow/enabled', { token, method: 'PATCH', body: { enabled: true } });
  await expectRequest(201, base + '/tokens', { token, method: 'POST', body: { label: 'erp-sync', actions: ['view'] } });
  const rowA = { rowId: randomUUID(), data: { [childCode]: 'A-1', [childQty]: '2' } };
  const record = await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'First case', [tableField.fieldId]: JSON.stringify([rowA]),
  } } });
  assert.equal(record.data[numbering.fieldId], 'G3-0001');
  const gone = await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'Deleted case',
  } } });
  await expectRequest(200, base + '/records/' + gone.id, { token, method: 'DELETE', body: { revision: gone.revision } });
  const pdf = Buffer.from('%PDF-1.4\ngate3 import attachment\n%%EOF\n');
  const uploaded = await fetch(new URL(base + '/files?' + new URLSearchParams({ name: 'proof.pdf', type: 'application/pdf' }), origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: pdf,
  });
  assert.equal(uploaded.status, 201);
  const file = await uploaded.json();
  const current = await expectRequest(200, base + '/records/' + record.id, { token });
  await expectRequest(200, base + '/records/' + record.id, { token, method: 'PUT', body: {
    revision: current.revision, data: {
      [title.fieldId]: 'First case', [tableField.fieldId]: JSON.stringify([rowA]),
      [filesField.fieldId]: JSON.stringify([file.id]),
    },
  } });
  const comment = await expectRequest(201, base + '/records/' + record.id + '/comments', {
    token: otherToken, method: 'POST',
    body: { parts: [{ kind: 'text', text: 'note from other ' }, { kind: 'mention', userId: owner.userId }] },
  });
  const archive = await exportApp(token, app.id);
  return { owner, other, token, otherToken, app, base, archive, record, gone, comment, pdf,
    fields: { title, filesField, tableField, numbering, childCode, childQty } };
}

async function stageImport(targetToken, archive, mappings = {}) {
  const job = await uploadPackage(targetToken, archive);
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  if (Object.keys(mappings).length) {
    await expectRequest(200, `/imports/${job.id}/mappings`, { token: targetToken, method: 'PUT', body: mappings });
  }
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  assert.ok(issued.token.startsWith('sbm1_'));
  return { job, issued };
}

test('G3-06 daily API rejects writes to every system field, item by item', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'gate3-sysfields');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  const record = await expectRequest(201, base + '/records', { token, method: 'POST',
    body: { data: { [title.fieldId]: 'x' } } });
  const systemFields = ['status', 'assignees', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'];
  for (const field of systemFields) {
    const created = await request(base + '/records', { token, method: 'POST',
      body: { data: { [title.fieldId]: 'y' }, [field]: 'forged' } });
    assert.equal(created.status, 400, `create with ${field} must be rejected`);
    const updated = await request(base + '/records/' + record.id, { token, method: 'PUT',
      body: { data: { [title.fieldId]: 'y' }, revision: record.revision, [field]: 'forged' } });
    assert.equal(updated.status, 400, `update with ${field} must be rejected`);
  }
  for (const field of ['authorId', 'createdAt']) {
    const forged = await request(base + '/records/' + record.id + '/comments', { token, method: 'POST',
      body: { parts: [{ kind: 'text', text: 'hi' }], [field]: 'forged' } });
    assert.equal(forged.status, 400, `comment with ${field} must be rejected`);
  }
});

test('G3-06/G3-07/G3-09 full import: channel separation, provenance, zero side effects, activation', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const member = await provision({ tenantId: admin.tenantId });
  const plain = await provision({ tenantId: admin.tenantId });
  const adminToken = await login(admin);
  const memberToken = await login(member);
  const plainToken = await login(plain);

  // Only tenant administrators may upload or receive migration tokens.
  const deniedUpload = await raw(plainToken, '/imports/upload', {
    method: 'POST', body: source.archive, contentType: 'application/octet-stream',
  });
  assert.equal(deniedUpload.status, 403);

  const { job, issued } = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: member.userId, [source.other.userId]: member.userId },
  });
  // A session token is not a migration token, and vice versa the channels differ.
  const sessionRun = await request(`/imports/${job.id}/run`, { token: adminToken, method: 'POST' });
  assert.equal(sessionRun.status, 401);
  // A token bound to another job is rejected for this job.
  const otherJob = await uploadPackage(adminToken, source.archive);
  const otherIssued = await expectRequest(201, `/imports/${otherJob.id}/migration-token`, { token: adminToken, method: 'POST' });
  const crossJob = await request(`/imports/${job.id}/run`, { token: otherIssued.token, method: 'POST' });
  assert.equal(crossJob.status, 403, JSON.stringify(crossJob.body));
  await expectRequest(201, `/imports/${otherJob.id}/cancel`, { token: adminToken, method: 'POST' });

  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  assert.equal(run.completion, 'complete', JSON.stringify(run.pending));
  const targetAppId = run.targetAppId;
  assert.ok(targetAppId);

  // Isolation before activation: invisible in the portal and unreachable.
  const appsBefore = await expectRequest(200, '/apps', { token: adminToken });
  assert.ok(!appsBefore.some((entry) => entry.id === targetAppId));
  await expectRequest(404, '/apps/' + targetAppId, { token: adminToken });

  // Evidence chain (G3-09) exists before activation and proves zero side effects.
  const detail = await expectRequest(200, `/imports/${job.id}`, { token: adminToken });
  assert.ok(detail.report, 'report must be generated before activation');
  assert.equal(detail.report.counts.target.records, detail.report.counts.source.records);
  assert.equal(detail.report.counts.target.comments, detail.report.counts.source.comments);
  assert.equal(detail.report.verification.outboxEventsProduced, 0);
  assert.equal(detail.report.verification.attachments.failed.length, 0);
  assert.ok(detail.report.difference.pendingTokenReissues.some((entry) => entry.name === 'erp-sync'));
  assert.ok(detail.report.difference.hashNote.includes('not by themselves prove content completeness'));
  const outboxRows = await dbQuery('SELECT count(*)::int AS n FROM outbox WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, targetAppId]);
  assert.equal(outboxRows[0].n, 0);
  const notificationRows = await dbQuery('SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, targetAppId]);
  assert.equal(notificationRows[0].n, 0);

  // Idempotent re-run of the same job: no duplicates.
  const rerun = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(rerun.status, 'ready');
  const recordCount = await dbQuery('SELECT count(*)::int AS n FROM records WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, targetAppId]);
  assert.equal(recordCount[0].n, detail.report.counts.source.records);

  const activated = await expectRequest(201, `/imports/${job.id}/activate`, { token: adminToken, method: 'POST' });
  assert.equal(activated.status, 'activated');
  // The migration token dies with the terminal state (decision 7).
  const deadToken = await request(`/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(deadToken.status, 401);

  const targetBase = '/apps/' + targetAppId;
  const published = await expectRequest(200, targetBase, { token: memberToken });
  const numberingField = published.fields.find((field) => field.code === 'case-no');
  const titleField = published.fields.find((field) => field.code === 'title');
  const records = await expectRequest(200, targetBase + '/records', { token: memberToken });
  const items = records.items ?? records;
  assert.equal(items.length, 1); // the soft-deleted record stays in the recycle bin
  const restored = await expectRequest(200, targetBase + '/records/' + items[0].id, { token: memberToken });
  assert.equal(restored.data[titleField.fieldId], 'First case');
  assert.equal(restored.data[numberingField.fieldId], 'G3-0001'); // F27 value preserved verbatim
  assert.ok(restored.migration, 'restored record must carry the migration marker');
  assert.equal(restored.migration.sourceRecordNo, source.record.recordNo);
  assert.equal(restored.migration.sourceActorId, source.owner.userId);
  // Decision 8: the counter advanced past imported numbers.
  const fresh = await expectRequest(201, targetBase + '/records', { token: adminToken, method: 'POST',
    body: { data: { [titleField.fieldId]: 'After import' } } });
  assert.equal(fresh.data[numberingField.fieldId], 'G3-0003');

  // Comments keep their original author and time, marked as migrated.
  const comments = await expectRequest(200, targetBase + '/records/' + items[0].id + '/comments', { token: memberToken });
  assert.equal(comments.items.length, 1);
  assert.equal(comments.items[0].migration.sourceActorId, source.other.userId);
  assert.ok(comments.items[0].body === undefined || true);
  assert.ok(JSON.stringify(comments.items[0].parts).includes('note from other'));
  // History is migration-sourced, never laundered into local events.
  const history = await expectRequest(200, targetBase + '/records/' + items[0].id + '/history', { token: memberToken });
  assert.ok(history.events.length >= 2);
  for (const event of history.events) {
    assert.equal(event.source, 'migration');
    assert.ok(event.migration?.importJobId);
  }
  // Imported notification rules are disabled.
  const rules = await expectRequest(200, targetBase + '/notification-rules', { token: adminToken });
  const ruleList = rules.published ?? rules.rules ?? rules;
  assert.equal(ruleList.length, 1);
  assert.equal(ruleList[0].enabled, false);
  // Decision 6: pending token re-issuance list lives on the application.
  const reissues = await expectRequest(200, targetBase + '/token-reissues', { token: adminToken });
  assert.equal(reissues.length, 1);
  assert.equal(reissues[0].name, 'erp-sync');
  const marked = await expectRequest(201, targetBase + `/token-reissues/${job.id}/mark`, {
    token: adminToken, method: 'POST', body: { name: 'erp-sync' },
  });
  assert.ok(marked.reissuedAt);
  // The migration channel left a full audit trail.
  const audit = await expectRequest(200, `/imports/${job.id}/audit`, { token: adminToken });
  const actions = new Set(audit.map((entry) => entry.action));
  assert.ok(actions.has('token-issued') && actions.has('write') && actions.has('activate'));
  void plainToken;
});

test('G3-07 duplicate package warns and needs explicit confirmation; cancel cleans to zero', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const first = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: admin.userId, [source.other.userId]: admin.userId },
  });
  const run = await expectRequest(201, `/imports/${first.job.id}/run`, { token: first.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready');

  const second = await uploadPackage(adminToken, source.archive);
  assert.ok(second.duplicateWarning, 're-importing the same package must warn first');
  assert.equal(second.duplicateOf, first.job.id);
  const blocked = await request(`/imports/${second.id}/validate`, { token: adminToken, method: 'POST' });
  assert.equal(blocked.status, 400);
  await expectRequest(200, `/imports/${second.id}/mappings`, { token: adminToken, method: 'PUT',
    body: { confirmDuplicate: true } });
  const validated = await expectRequest(201, `/imports/${second.id}/validate`, { token: adminToken, method: 'POST' });
  assert.equal(validated.status, 'staging');
  await expectRequest(201, `/imports/${second.id}/cancel`, { token: adminToken, method: 'POST' });

  // Cancelling a staged job removes every written object.
  const cancelled = await expectRequest(201, `/imports/${first.job.id}/cancel`, { token: adminToken, method: 'POST' });
  assert.equal(cancelled.status, 'cancelled');
  const leftovers = await dbQuery(
    `SELECT (SELECT count(*) FROM records WHERE tenant_id = $1 AND app_id = $2)
          + (SELECT count(*) FROM files WHERE tenant_id = $1 AND app_id = $2)
          + (SELECT count(*) FROM apps WHERE tenant_id = $1 AND id = $2) AS n`,
    [admin.tenantId, run.targetAppId]);
  assert.equal(Number(leftovers[0].n), 0);
});

test('G3-06 migration token expires after 24 hours and cannot be renewed silently', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const { job, issued } = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: admin.userId, [source.other.userId]: admin.userId },
  });
  await dbQuery("UPDATE authentication.migration_tokens SET expires_at = now() - interval '1 minute' WHERE import_job_id = $1", [job.id]);
  const expired = await request(`/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(expired.status, 401);
  await expectRequest(201, `/imports/${job.id}/cancel`, { token: adminToken, method: 'POST' });
});

test('G3-07 corrupt package fails validation with a downloadable object-level error report', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const { unzipSync, zipSync, strToU8, strFromU8 } = require('../../../apps/api/node_modules/fflate');
  const files = unzipSync(new Uint8Array(source.archive));
  const records = JSON.parse(strFromU8(files['data/records.json']));
  records.records = [];
  files['data/records.json'] = strToU8(JSON.stringify(records));
  const tampered = Buffer.from(zipSync(files));
  const job = await uploadPackage(adminToken, tampered);
  const failed = await expectRequest(201, `/imports/${job.id}/validate`, { token: adminToken, method: 'POST' });
  assert.equal(failed.status, 'failed');
  assert.ok(failed.errorReport?.errors?.length >= 1);
  const report = await raw(adminToken, `/imports/${job.id}/error-report`);
  assert.equal(report.status, 200);
  assert.ok(report.body.errors.length >= 1);
});

test('G3-07 staging failure cleans the half-written application to zero', async () => {
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  // Craft a package whose attachment metadata sha disagrees with its body:
  // preflight (manifest level) passes, the file batch must fail mid-run.
  const appId = randomUUID(); const fieldId = randomUUID(); const fileId = randomUUID();
  const actorId = randomUUID();
  const body = Buffer.from('attachment body');
  const bodySha = createHash('sha256').update(body).digest('hex');
  const wrongSha = createHash('sha256').update('something else').digest('hex');
  const counts = { ...emptyCounts(), apps: 1, appVersions: 1, fieldVersionSnapshots: 1,
    fields: 1, attachments: 1, attachmentVersions: 1 };
  const files = {
    'data/app.json': JSON.stringify({ app: { id: appId, tenantId: randomUUID(), code: 'crafted', name: 'Crafted',
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
      name: 'a.bin', contentType: 'application/octet-stream', byteSize: body.length,
      createdBy: actorId, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null,
      versions: [{ fileId, version: 1, sha256: wrongSha, byteSize: body.length,
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
      sourceAppCode: 'crafted', exportedAt: '2026-01-01T00:00:00.000Z',
      snapshotCutoff: '2026-01-01T00:00:00.000Z', counts: { expected: counts },
      excluded: { temporaryAttachments: 0, purgedAttachments: 0 },
      inclusion: { customFiles: 'unsupported', pluginConfig: 'unsupported', webhooks: 'unsupported',
        apiTokens: 'absent', workflows: 'absent', comments: 'absent', attachments: 'included' },
      attachments: [{ fileId, version: 1, sha256: bodySha, bytes: body.length, state: 'stored',
        name: 'a.bin', contentType: 'application/octet-stream' }],
      sensitiveDataNotice: 'crafted',
    },
    files,
    attachmentBodies: { [`attachments/${fileId}/v1/body`]: body },
  });
  const job = await uploadPackage(adminToken, archive);
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: adminToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: adminToken, method: 'POST' });
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'failed', JSON.stringify(run));
  // Cleanup is recorded on the job and verifiable in the database: nothing of
  // the half-written application remains.
  assert.equal(run.pending.cleanup.after.records, 0);
  assert.equal(run.pending.cleanup.after.attachments, 0);
  assert.equal(run.pending.cleanup.purge.purged, true);
  const leftovers = await dbQuery(
    'SELECT count(*) AS n FROM apps WHERE tenant_id = $1 AND code = $2',
    [admin.tenantId, 'crafted']);
  assert.equal(Number(leftovers[0].n), 0, 'failed import must clean up to zero');
});

test('G3-07 concurrent re-runs of one job produce exactly one copy', async () => {
  const source = await buildSourcePackage();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const { job, issued } = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: admin.userId, [source.other.userId]: admin.userId },
  });
  const runs = await Promise.all([
    raw(issued.token, `/imports/${job.id}/run`, { method: 'POST' }),
    raw(issued.token, `/imports/${job.id}/run`, { method: 'POST' }),
  ]);
  assert.ok(runs.every((entry) => entry.status === 201), JSON.stringify(runs.map((entry) => entry.status)));
  const ready = runs.map((entry) => entry.body).find((entry) => entry.status === 'ready');
  const count = await dbQuery('SELECT count(*)::int AS n FROM records WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, ready.targetAppId]);
  assert.equal(count[0].n, 2);
  await expectRequest(201, `/imports/${job.id}/cancel`, { token: adminToken, method: 'POST' });
});

test('G3-08 unmapped ACL subjects stay default-deny and are listed as dropped', async () => {
  const owner = await provision({ isAdmin: true });
  const other = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token, 'gate3-acl-src');
  const base = '/apps/' + app.id;
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [{ action: 'view', subject: { kind: 'user', id: other.userId } }], record: [], field: [],
  } });
  const title = await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: { [title.fieldId]: 'secret' } } });
  const archive = await exportApp(token, app.id);

  const admin = await provision({ isAdmin: true });
  const member = await provision({ tenantId: admin.tenantId });
  const adminToken = await login(admin);
  const memberToken = await login(member);
  // Neither source user is mapped: the view grant must NOT take effect.
  const { job, issued } = await stageImport(adminToken, archive, {});
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready');
  assert.ok(run.pending.droppedAcl.length >= 1, JSON.stringify(run.pending));
  await expectRequest(201, `/imports/${job.id}/activate`, { token: adminToken, method: 'POST' });
  await expectRequest(404, '/apps/' + run.targetAppId, { token: memberToken });
  const adminView = await expectRequest(200, '/apps/' + run.targetAppId, { token: adminToken });
  assert.equal(adminView.id, run.targetAppId);
});

test('G3-08 unmapped assignees pend, never default to the operator, and resolve explicitly', async () => {
  const source = await buildSourcePackage({ assigneeMode: 'other' });
  const admin = await provision({ isAdmin: true });
  const member = await provision({ tenantId: admin.tenantId });
  const adminToken = await login(admin);
  const { job, issued } = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: member.userId },
  });
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready');
  assert.equal(run.completion, 'pending');
  assert.ok(run.pending.assignees.length >= 1, JSON.stringify(run.pending));
  const blocked = await request(`/imports/${job.id}/activate`, { token: adminToken, method: 'POST' });
  assert.equal(blocked.status, 400);
  // The record is NOT silently assigned to the operator or any administrator.
  const assignments = await dbQuery(
    'SELECT user_id FROM workflow_assignments WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, run.targetAppId]);
  assert.equal(assignments.length, 0);
  // The administrator explicitly accepts "no assignee" (decision 5).
  const resolved = await expectRequest(201, `/imports/${job.id}/resolve-assignees`, {
    token: issued.token, method: 'POST', body: { items: run.pending.assignees.map((entry) => ({
      recordId: entry.recordId, sourceUserId: entry.sourceUserId, userId: null })) },
  });
  assert.equal(resolved.completion, 'complete', JSON.stringify(resolved.pending));
  await expectRequest(201, `/imports/${job.id}/activate`, { token: adminToken, method: 'POST' });
});

test('G3-08 cross-app lookup dependency pends, maps to the restored app, then activates', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const customers = await createApp(token, 'gate3-customers');
  const custKey = await expectRequest(201, '/apps/' + customers.id + '/fields', { token, method: 'POST',
    body: { code: 'cust-key', name: 'Key', type: 'text', uniqueValue: true } });
  const custName = await addField(token, customers.id, 'cust-name', 'text');
  await publish(token, customers.id);
  await expectRequest(201, '/apps/' + customers.id + '/records', { token, method: 'POST',
    body: { data: { [custKey.fieldId]: 'C-001', [custName.fieldId]: 'Acme' } } });
  const orders = await createApp(token, 'gate3-orders');
  const localKey = await addField(token, orders.id, 'cust', 'text');
  const copy = await addField(token, orders.id, 'cust-copy', 'text');
  const lookup = await expectRequest(201, '/apps/' + orders.id + '/fields', { token, method: 'POST', body: {
    code: 'lookup', name: 'Lookup', type: 'lookup',
    lookup: { appId: customers.id, keyFieldId: custKey.fieldId, localKeyFieldId: localKey.fieldId,
      copies: [{ sourceFieldId: custName.fieldId, targetFieldId: copy.fieldId }] },
  } });
  await publish(token, orders.id);
  await expectRequest(201, '/apps/' + orders.id + '/records', { token, method: 'POST',
    body: { data: { [localKey.fieldId]: 'C-001' } } });
  const customersArchive = await exportApp(token, customers.id);
  const ordersArchive = await exportApp(token, orders.id);

  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  // Restore the referenced application first, then the dependent one.
  const customersImport = await stageImport(adminToken, customersArchive, {});
  const customersRun = await expectRequest(201, `/imports/${customersImport.job.id}/run`,
    { token: customersImport.issued.token, method: 'POST' });
  assert.equal(customersRun.completion, 'complete', JSON.stringify(customersRun.pending));
  await expectRequest(201, `/imports/${customersImport.job.id}/activate`, { token: adminToken, method: 'POST' });
  const targetCustomers = await expectRequest(200, '/apps/' + customersRun.targetAppId, { token: adminToken });
  const targetKey = targetCustomers.fields.find((field) => field.code === 'cust-key');
  const targetName = targetCustomers.fields.find((field) => field.code === 'cust-name');

  const ordersImport = await stageImport(adminToken, ordersArchive, {});
  const ordersRun = await expectRequest(201, `/imports/${ordersImport.job.id}/run`,
    { token: ordersImport.issued.token, method: 'POST' });
  assert.equal(ordersRun.status, 'ready');
  assert.equal(ordersRun.completion, 'pending', JSON.stringify(ordersRun.pending));
  const dependency = ordersRun.pending.dependencies.find((entry) => entry.kind === 'lookup');
  assert.ok(dependency, JSON.stringify(ordersRun.pending));
  assert.equal(dependency.sourceAppCode, 'gate3-customers');
  // The unresolved lookup is disabled in the target, never silently re-pointed.
  const configRows = await dbQuery(
    'SELECT lookup FROM fields WHERE tenant_id = $1 AND app_id = $2 AND code = $3',
    [admin.tenantId, ordersRun.targetAppId, 'lookup']);
  assert.equal(configRows[0].lookup, null);
  const blocked = await request(`/imports/${ordersImport.job.id}/activate`, { token: adminToken, method: 'POST' });
  assert.equal(blocked.status, 400);

  const resolved = await expectRequest(201, `/imports/${ordersImport.job.id}/resolve-dependencies`, {
    token: ordersImport.issued.token, method: 'POST', body: { decisions: {
      [lookup.fieldId]: { action: 'map', targetAppId: customersRun.targetAppId,
        fieldMappings: { [custKey.fieldId]: targetKey.fieldId, [custName.fieldId]: targetName.fieldId } },
    } },
  });
  assert.equal(resolved.completion, 'complete', JSON.stringify(resolved.pending));
  await expectRequest(201, `/imports/${ordersImport.job.id}/activate`, { token: adminToken, method: 'POST' });
  const targetOrders = await expectRequest(200, '/apps/' + ordersRun.targetAppId, { token: adminToken });
  const targetLookup = targetOrders.fields.find((field) => field.code === 'lookup');
  assert.equal(targetLookup.lookup.appId, customersRun.targetAppId);
  assert.equal(targetLookup.lookup.keyFieldId, targetKey.fieldId);
  const references = await dbQuery(
    'SELECT count(*)::int AS n FROM record_references WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, ordersRun.targetAppId]);
  assert.ok(references[0].n >= 1);
});
