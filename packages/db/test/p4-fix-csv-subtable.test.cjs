const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';
const apiRequire = createRequire(require.resolve('../../../apps/api/package.json'));
const { unzipSync } = apiRequire('fflate');
const { parse } = apiRequire('csv-parse/sync');
const pdf = (label) => Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function upload(token, appId, name, body) {
  const response = await fetch(new URL(`/apps/${appId}/files?` + new URLSearchParams({
    name, type: 'application/pdf',
  }), origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201, await response.clone().text().catch(() => ''));
  return response.json();
}

async function exportZip(token, appId) {
  const response = await fetch(new URL(`/apps/${appId}/csv/export?attachments=true`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, await response.clone().text().catch(() => ''));
  assert.match(response.headers.get('content-type'), /^application\/zip/);
  return unzipSync(new Uint8Array(await response.arrayBuffer()));
}

test('P4-fix C3: CSV attachment bundle includes subtable row files; record/field scope cannot leak them', async (t) => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p4-fix-csv');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  const docs = await addField(token, app.id, 'docs', 'attachment');
  const childSku = randomUUID(); const childProof = randomUUID();
  const lines = await expectRequest(201, base + '/fields', { token, method: 'POST', body: {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: childSku, code: 'sku', name: 'SKU', type: 'text', required: true, uniqueValue: false, options: [] },
      { fieldId: childProof, code: 'proof', name: 'Proof', type: 'attachment', required: false, uniqueValue: false, options: [] },
    ], minRows: 0, maxRows: 25, addRows: true, deleteRows: true, reorderRows: true },
  } });
  await publish(token, app.id);

  const recPayload = pdf('record-level');
  const rowPayload = pdf('row-level');
  const recFile = await upload(token, app.id, 'record.pdf', recPayload);
  const rowFile = await upload(token, app.id, 'row.pdf', rowPayload);
  await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'Visible',
    [docs.fieldId]: JSON.stringify([recFile.id]),
    [lines.fieldId]: JSON.stringify([
      { rowId: randomUUID(), data: { [childSku]: 'A-1', [childProof]: JSON.stringify([rowFile.id]) } },
    ]),
  } } });

  // Owner bundle: BOTH the record-level and the subtable-row file are
  // collected, with manifest sha256/bytes matching the source payloads.
  const entries = await exportZip(token, app.id);
  const attachmentKeys = Object.keys(entries).filter((key) => key.startsWith('attachments/')).sort();
  assert.deepEqual(attachmentKeys, ['attachments/' + recFile.id, 'attachments/' + rowFile.id].sort());
  assert.deepEqual(Buffer.from(entries['attachments/' + recFile.id]), recPayload);
  assert.deepEqual(Buffer.from(entries['attachments/' + rowFile.id]), rowPayload);
  const manifest = parse(Buffer.from(entries['attachments.csv']), { columns: true });
  assert.equal(manifest.length, 2);
  const byId = new Map(manifest.map((row) => [row.id, row]));
  assert.deepEqual(byId.get(recFile.id), {
    id: recFile.id, name: 'record.pdf', sha256: sha256(recPayload),
    bytes: String(recPayload.length), path: 'attachments/' + recFile.id,
  });
  assert.deepEqual(byId.get(rowFile.id), {
    id: rowFile.id, name: 'row.pdf', sha256: sha256(rowPayload),
    bytes: String(rowPayload.length), path: 'attachments/' + rowFile.id,
  });
  t.diagnostic(JSON.stringify({ manifestIds: manifest.map(({ id }) => id) }));

  // Record-scope negative: a member who may export but cannot view the
  // record gets an empty bundle — neither file leaks.
  const member = await provision({ tenantId: owner.tenantId });
  const reader = await login(member);
  const subject = { kind: 'user', id: member.userId };
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [{ action: 'view', subject }, { action: 'export', subject }],
    record: [{ action: 'view', subject, conditions: [{ fieldId: title.fieldId, operator: 'eq', value: 'Other' }] }],
    field: [],
  } });
  await publish(token, app.id);
  const deniedEntries = await exportZip(reader, app.id);
  assert.deepEqual(Object.keys(deniedEntries).filter((key) => key.startsWith('attachments/')), []);
  assert.deepEqual(parse(Buffer.from(deniedEntries['attachments.csv']), { columns: true }), []);

  // Field-scope negative: a member who sees the record but NOT the
  // table field gets the record-level file only; the subtable file
  // stays out of the bundle.
  const member2 = await provision({ tenantId: owner.tenantId });
  const reader2 = await login(member2);
  const subject2 = { kind: 'user', id: member2.userId };
  await expectRequest(200, base + '/draft/acl', { token, method: 'PUT', body: {
    app: [{ action: 'view', subject: subject2 }, { action: 'export', subject: subject2 }],
    record: [{ action: 'view', subject: subject2, conditions: [{ fieldId: title.fieldId, operator: 'eq', value: 'Visible' }] }],
    field: [{ fieldId: lines.fieldId, action: 'view', subject: { kind: 'user', id: owner.userId } }],
  } });
  await publish(token, app.id);
  const fieldDenied = await exportZip(reader2, app.id);
  assert.deepEqual(Object.keys(fieldDenied).filter((key) => key.startsWith('attachments/')),
    ['attachments/' + recFile.id]);
  const fieldManifest = parse(Buffer.from(fieldDenied['attachments.csv']), { columns: true });
  assert.deepEqual(fieldManifest.map(({ id }) => id), [recFile.id]);
});
