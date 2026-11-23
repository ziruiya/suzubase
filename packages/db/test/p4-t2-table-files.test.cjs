const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');
const { LocalStorageAdapter } = require('../../../apps/api/dist/storage.js');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';
const pdf = (label) => Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function dbQuery(sqlText, params) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

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

async function download(token, appId, fileId) {
  const response = await fetch(new URL(`/apps/${appId}/files/${fileId}`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

async function buildApp(token, code) {
  const app = await createApp(token, code);
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
  return { app, base, title, docs, lines, childSku, childProof };
}

test('P4-T2 subtable FILE: shared attachment lifecycle, counting, download authorization', async () => {
  const owner = await provision({ isAdmin: true });
  const outsider = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const outsiderToken = await login(outsider);
  const { app, base, title, docs, lines, childSku, childProof } = await buildApp(token, 'p4-t2-main');

  const rowFileA = await upload(token, app.id, 'row-a.pdf', pdf('row-a'));
  const rowFileB = await upload(token, app.id, 'row-b.pdf', pdf('row-b'));
  const docFile = await upload(token, app.id, 'doc.pdf', pdf('doc'));
  const row1 = randomUUID(); const row2 = randomUUID(); const row3 = randomUUID();
  const rows = [
    { rowId: row1, data: { [childSku]: 'A-1', [childProof]: JSON.stringify([rowFileA.id]) } },
    { rowId: row2, data: { [childSku]: 'A-2', [childProof]: JSON.stringify([rowFileB.id]) } },
    { rowId: row3, data: { [childSku]: 'A-3' } },
  ];
  const record = await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'Case', [docs.fieldId]: JSON.stringify([docFile.id]),
    [lines.fieldId]: JSON.stringify(rows),
  } } });

  // References land in table_file_references with full cell location.
  const refs = await dbQuery(
    'SELECT row_id, sub_field_id, file_id FROM table_file_references WHERE tenant_id = $1 AND app_id = $2 ORDER BY file_id',
    [owner.tenantId, app.id]);
  assert.equal(refs.length, 2);
  const byFile = new Map(refs.map((row) => [row.file_id, row]));
  assert.equal(byFile.get(rowFileA.id).row_id, row1);
  assert.equal(byFile.get(rowFileA.id).sub_field_id, childProof);
  assert.equal(byFile.get(rowFileB.id).row_id, row2);
  const states = await dbQuery(
    'SELECT id, state, reference_count FROM files WHERE tenant_id = $1 AND app_id = $2 ORDER BY id', [owner.tenantId, app.id]);
  for (const file of [rowFileA, rowFileB, docFile]) {
    const row = states.find(({ id }) => id === file.id);
    assert.deepEqual({ state: row.state, reference_count: row.reference_count },
      { state: 'ATTACHED', reference_count: 1 });
  }

  // Download: owner reads the exact bytes; a tenant member without a
  // grant is refused (404), exactly like record-level files.
  const got = await download(token, app.id, rowFileA.id);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, pdf('row-a'));
  const denied = await download(outsiderToken, app.id, rowFileA.id);
  assert.equal(denied.status, 404);

  // Unknown file ids inside a row are refused.
  const bad = await request(base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'Bad', [lines.fieldId]: JSON.stringify([
      { rowId: randomUUID(), data: { [childSku]: 'B-1', [childProof]: JSON.stringify([randomUUID()]) } },
    ]),
  } } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));

  // Removing the file from its row releases the reference: count drops
  // and the file becomes DELETED (same state machine as record-level).
  const updatedRows = rows.map((row) => row.rowId === row1
    ? { ...row, data: { [childSku]: 'A-1', [childProof]: '[]' } } : row);
  await expectRequest(200, base + '/records/' + record.id, { token, method: 'PUT', body: {
    revision: record.revision, data: { [lines.fieldId]: JSON.stringify(updatedRows) },
  } });
  const after = await dbQuery(
    'SELECT state, reference_count FROM files WHERE tenant_id = $1 AND id = $2', [owner.tenantId, rowFileA.id]);
  assert.deepEqual(after[0], { state: 'DELETED', reference_count: 0 });
  const refsAfter = await dbQuery(
    'SELECT count(*)::int AS n FROM table_file_references WHERE tenant_id = $1 AND app_id = $2', [owner.tenantId, app.id]);
  assert.equal(refsAfter[0].n, 1);
  const goneDownload = await download(token, app.id, rowFileA.id);
  assert.equal(goneDownload.status, 404);

  // The per-record limit counts record-level and subtable files together.
  await expectRequest(200, base + '/settings', { token, method: 'PATCH', body: { attachmentMaxCount: 2 } });
  const extra1 = await upload(token, app.id, 'x1.pdf', pdf('x1'));
  const extra2 = await upload(token, app.id, 'x2.pdf', pdf('x2'));
  const extra3 = await upload(token, app.id, 'x3.pdf', pdf('x3'));
  const over = await request(base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'Over', [docs.fieldId]: JSON.stringify([extra1.id]),
    [lines.fieldId]: JSON.stringify([
      { rowId: randomUUID(), data: { [childSku]: 'O-1', [childProof]: JSON.stringify([extra2.id]) } },
      { rowId: randomUUID(), data: { [childSku]: 'O-2', [childProof]: JSON.stringify([extra3.id]) } },
    ]),
  } } });
  assert.equal(over.status, 400, JSON.stringify(over.body));
  assert.match(JSON.stringify(over.body), /Attachment limit exceeded/);
});

test('P4-T2 export/import round trip: 17 rows, subtable files 2/2 and record files 2/2 by hash', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const { app, base, title, docs, lines, childSku, childProof } = await buildApp(token, 'p4-t2-export');

  const docA = await upload(token, app.id, 'doc-a.pdf', pdf('doc-a'));
  const docB = await upload(token, app.id, 'doc-b.pdf', pdf('doc-b'));
  const rowFile1 = await upload(token, app.id, 'row-03.pdf', pdf('row-03'));
  const rowFile2 = await upload(token, app.id, 'row-11.pdf', pdf('row-11'));
  const rows = Array.from({ length: 17 }, (_, index) => {
    const sku = 'SKU-' + String(index + 1).padStart(2, '0');
    const data = { [childSku]: sku };
    if (index === 2) data[childProof] = JSON.stringify([rowFile1.id]);
    if (index === 10) data[childProof] = JSON.stringify([rowFile2.id]);
    return { rowId: randomUUID(), data };
  });
  await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
    [title.fieldId]: 'App A mirror', [docs.fieldId]: JSON.stringify([docA.id, docB.id]),
    [lines.fieldId]: JSON.stringify(rows),
  } } });

  const job = await expectRequest(201, base + '/exports', { token, method: 'POST' });
  const runExport = await expectRequest(201, base + '/exports/' + job.id + '/run', { token, method: 'POST' });
  assert.equal(runExport.status, 'sealed');
  const packageResponse = await fetch(new URL(base + '/exports/' + job.id + '/package', origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(packageResponse.status, 200);
  const archive = Buffer.from(await packageResponse.arrayBuffer());

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const uploaded = await fetch(new URL('/imports/upload', origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + targetToken, 'Content-Type': 'application/octet-stream' },
    body: archive, signal: AbortSignal.timeout(15000),
  });
  assert.equal(uploaded.status, 201);
  const importJob = await uploaded.json();
  const validated = await expectRequest(201, `/imports/${importJob.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  const issued = await expectRequest(201, `/imports/${importJob.id}/migration-token`, { token: targetToken, method: 'POST' });
  await expectRequest(201, `/imports/${importJob.id}/run`, { token: issued.token, method: 'POST' });
  const activated = await expectRequest(201, `/imports/${importJob.id}/activate`, { token: targetToken, method: 'POST' });
  assert.equal(activated.status, 'activated');
  const detail = await expectRequest(200, `/imports/${importJob.id}`, { token: targetToken });
  const targetAppId = detail.targetAppId;
  assert.ok(targetAppId);
  const targetBase = '/apps/' + targetAppId;
  const importedApp = await expectRequest(200, targetBase, { token: targetToken });
  const targetLines = importedApp.fields.find(({ code }) => code === 'lines');
  const targetSku = targetLines.table.fields.find(({ code }) => code === 'sku');
  const targetProof = targetLines.table.fields.find(({ code }) => code === 'proof');

  const page = await expectRequest(200, targetBase + '/records', { token: targetToken });
  assert.equal(page.items.length, 1);
  const importedRecord = await expectRequest(200, targetBase + '/records/' + page.items[0].id, { token: targetToken });
  const importedRows = JSON.parse(importedRecord.data[targetLines.fieldId]);
  assert.equal(importedRows.length, 17);
  const row03 = importedRows.find((row) => row.data[targetSku.fieldId] === 'SKU-03');
  const row11 = importedRows.find((row) => row.data[targetSku.fieldId] === 'SKU-11');
  const importedRowFile1 = JSON.parse(row03.data[targetProof.fieldId])[0];
  const importedRowFile2 = JSON.parse(row11.data[targetProof.fieldId])[0];
  assert.ok(importedRowFile1 && importedRowFile2 && importedRowFile1 !== importedRowFile2);

  // Every restored file matches its source by SHA-256 and byte size, and
  // the subtable references point at the right rows.
  const targetFiles = await dbQuery(
    'SELECT id, sha256, bytes, state, reference_count FROM files WHERE tenant_id = $1 AND app_id = $2',
    [target.tenantId, targetAppId]);
  const byHash = new Map(targetFiles.map((file) => [file.sha256, file]));
  for (const [label, source] of [['doc-a', docA], ['doc-b', docB], ['row-03', rowFile1], ['row-11', rowFile2]]) {
    const restored = byHash.get(sha256(pdf(label)));
    assert.ok(restored, label + ' restored');
    assert.equal(restored.bytes, pdf(label).length);
    assert.equal(restored.state, 'ATTACHED');
    assert.equal(restored.reference_count, 1);
  }
  assert.equal(byHash.get(sha256(pdf('row-03'))).id, importedRowFile1);
  assert.equal(byHash.get(sha256(pdf('row-11'))).id, importedRowFile2);
  const targetRefs = await dbQuery(
    'SELECT row_id, file_id FROM table_file_references WHERE tenant_id = $1 AND app_id = $2',
    [target.tenantId, targetAppId]);
  assert.equal(targetRefs.length, 2);
  const targetRowIds = await dbQuery(
    'SELECT row_id, data FROM record_table_rows WHERE tenant_id = $1 AND app_id = $2',
    [target.tenantId, targetAppId]);
  const skuByRowId = new Map(targetRowIds.map((row) => [row.row_id, row.data[targetSku.fieldId]]));
  const refSkus = targetRefs.map((ref) => skuByRowId.get(ref.row_id)).sort();
  assert.deepEqual(refSkus, ['SKU-03', 'SKU-11']);

  // The restored subtable file downloads with identical bytes.
  const got = await download(targetToken, targetAppId, importedRowFile1);
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, pdf('row-03'));
});

test('P4-T2 cleanup never purges a file still referenced from a subtable cell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suzubase-t2-cleanup-'));
  const storage = new LocalStorageAdapter(directory);
  try {
    const { cleanupFiles } = require('../../../apps/api/dist/file-maintenance.js');
    const owner = await provision({ isAdmin: true });
    const token = await login(owner);
    const { app, base, title, lines, childSku, childProof } = await buildApp(token, 'p4-t2-cleanup');
    const protectedFile = await upload(token, app.id, 'protected.pdf', pdf('protected'));
    await expectRequest(201, base + '/records', { token, method: 'POST', body: { data: {
      [title.fieldId]: 'Keeper',
      [lines.fieldId]: JSON.stringify([
        { rowId: randomUUID(), data: { [childSku]: 'K-1', [childProof]: JSON.stringify([protectedFile.id]) } },
      ]),
    } } });
    // Simulate count drift: the row still references the file while its
    // counter reads zero and it looks expired. The zero-reference guard
    // must see the subtable reference and leave the file alone.
    const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await db.connect();
    try {
      await db.query(`UPDATE files SET state = 'DELETED', reference_count = 0,
        deleted_at = now() - make_interval(hours => 100) WHERE tenant_id = $1 AND id = $2`,
      [owner.tenantId, protectedFile.id]);
      const controlId = randomUUID();
      await db.query(`INSERT INTO files (tenant_id, app_id, id, uploaded_by, name, content_type, bytes, state, created_at, deleted_at)
        VALUES ($1, $2, $3, $4, 'control.pdf', 'application/pdf', 1, 'DELETED',
          now() - make_interval(hours => 100), now() - make_interval(hours => 100))`,
      [owner.tenantId, app.id, controlId, owner.userId]);
      await storage.put([owner.tenantId, app.id, controlId, 1].join('/'), Buffer.from('x'));
      const result = await cleanupFiles(owner, { deletedHours: 48, temporaryHours: 24 }, storage);
      assert.deepEqual(result, { expiredTemporary: 0, purgedDeleted: 1, failed: 0 });
      const rows = (await db.query('SELECT id, purged_at IS NOT NULL AS purged FROM files WHERE tenant_id = $1 AND app_id = $2',
        [owner.tenantId, app.id])).rows;
      assert.equal(rows.find(({ id }) => id === protectedFile.id).purged, false);
      assert.equal(rows.find(({ id }) => id === controlId).purged, true);
    } finally {
      await db.end();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
