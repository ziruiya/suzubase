const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { Client } = require('pg');
const { LocalStorageAdapter } = require('../../../apps/api/dist/storage.js');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-07 local storage satisfies the storage adapter contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'suzubase-files-'));
  try {
    const storage = new LocalStorageAdapter(directory);
    const key = [randomUUID(), randomUUID(), randomUUID(), '1'].join('/');
    const data = Buffer.from('attachment payload');
    const sha256 = createHash('sha256').update(data).digest('hex');
    assert.deepEqual(await storage.put(key, data), { sha256, bytes: data.length });
    await assert.rejects(storage.put(key, Buffer.from('replacement')), { code: 'EEXIST' });
    await assert.rejects(storage.put('../invalid', data), /Invalid storage key/);
    await assert.rejects(storage.read(key, 'invalid'), /checksum mismatch/);
    assert.deepEqual(await storage.read(key, sha256), data);
    await storage.remove(key);
    await storage.remove(key);
    await assert.rejects(storage.read(key, sha256), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('G1-07 attachment authorization, rejected files and record-transaction compensation', async (t) => {
  const owner = await provision();
  const outsider = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const outsiderToken = await login(outsider);
  const app = await createApp(token);
  const field = await addField(token, app.id, 'attachment', 'attachment');
  await publish(token, app.id);
  const base = '/apps/' + app.id;
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const upload = (name, body) => fetch(new URL(base + '/files?' + new URLSearchParams({
    name, type: 'application/pdf',
  }), origin), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body });
  await expectRequest(200, base + '/settings', {
    method: 'PATCH', token, body: { attachmentMaxBytes: 50 },
  });
  const tooBig = await upload('too-big.pdf', Buffer.alloc(51));
  assert.equal(tooBig.status, 400);
  const error = await tooBig.json();
  assert.equal(error.file, 'too-big.pdf');
  const payload = Buffer.from('%PDF-1.4\n%%EOF\n');
  const posted = await upload('receipt.pdf', payload);
  assert.equal(posted.status, 201);
  const file = await posted.json();
  assert.equal(file.state, 'READY');
  const download = base + '/files/' + file.id;
  await expectRequest(404, download, { token });

  const submit = (status, ids) => expectRequest(status, base + '/records', {
    method: 'POST', token, body: { data: { [field.fieldId]: JSON.stringify(ids) } },
  });
  await submit(400, [file.id, randomUUID()]);
  await expectRequest(200, base + '/settings', { method: 'PATCH', token, body: { attachmentMaxCount: 0 } });
  const over = await submit(400, [file.id]);
  assert.deepEqual(over.files, [{ fieldId: field.fieldId, fileId: file.id, name: 'receipt.pdf' }]);
  await expectRequest(200, base + '/settings', { method: 'PATCH', token, body: { attachmentMaxCount: 5 } });
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    const state = await db.query('SELECT state, reference_count FROM files WHERE tenant_id = $1 AND id = $2',
      [owner.tenantId, file.id]);
    assert.deepEqual(state.rows[0], { state: 'READY', reference_count: 0 });
    const record = await submit(201, [file.id]);
    const access = await fetch(new URL(download, origin), { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(access.status, 200);
    assert.deepEqual(Buffer.from(await access.arrayBuffer()), payload);
    const denied = await expectRequest(404, download, { token: outsiderToken });
    assert.equal(denied.message, '无权限');
    await expectRequest(200, base + '/records/' + record.id, { method: 'PUT', token, body: { revision: 1, data: {} } });
    const dropped = await db.query('SELECT state, reference_count FROM files WHERE tenant_id = $1 AND id = $2',
      [owner.tenantId, file.id]);
    assert.deepEqual(dropped.rows[0], { state: 'DELETED', reference_count: 0 });
    t.diagnostic(JSON.stringify({ failedSubmission: state.rows[0], oversized: error, denied, removed: dropped.rows[0] }));
  } finally {
    await db.end();
  }
});

test('GF-04 retention removes expired deleted bytes and crash-left temporary artifacts', async (t) => {
  const { mkdir, writeFile, stat } = require('node:fs/promises');
  const { dirname } = require('node:path');
  const { configureRuntime } = require('./support.cjs');
  configureRuntime();
  const { cleanupFiles } = require('../../../apps/api/dist/file-maintenance.js');
  const directory = await mkdtemp(join(tmpdir(), 'suzubase-cleanup-'));
  const storage = new LocalStorageAdapter(directory);
  const owner = await provision();
  const token = await login(owner);
  const { id: appId } = await createApp(token);
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    const ids = { expired: randomUUID(), fresh: randomUUID(), temporary: randomUUID(), ready: randomUUID() };
    const key = (id) => [owner.tenantId, appId, id, 1].join('/');
    for (const [name, id] of Object.entries(ids)) {
      const old = ['expired', 'temporary', 'ready'].includes(name);
      const state = name === 'temporary' ? 'TEMPORARY' : name === 'ready' ? 'READY' : 'DELETED';
      await db.query(`INSERT INTO files (tenant_id, app_id, id, uploaded_by, name, content_type, bytes, state, created_at, deleted_at)
        VALUES ($1, $2, $3, $4, $5, 'application/pdf', 1, $6::file_state,
          now() - make_interval(hours => $7), CASE WHEN $6 = 'DELETED' THEN now() - make_interval(hours => $7) END)`,
      [owner.tenantId, appId, id, owner.userId, name, state, old ? 100 : 0]);
      await storage.put(key(id), Buffer.from('x'));
    }
    const stage = join(directory, key(ids.temporary)) + '.' + randomUUID();
    await mkdir(dirname(stage), { recursive: true });
    await writeFile(stage, 'partially written');
    const result = await cleanupFiles(owner, { deletedHours: 48, temporaryHours: 24 }, storage);
    assert.deepEqual(result, { expiredTemporary: 1, purgedDeleted: 1, failed: 0 });
    await assert.rejects(stat(stage), { code: 'ENOENT' });
    for (const id of [ids.expired, ids.temporary]) await assert.rejects(stat(join(directory, key(id))), { code: 'ENOENT' });
    for (const id of [ids.fresh, ids.ready]) assert.equal((await stat(join(directory, key(id)))).size, 1);
    const { rows } = await db.query('SELECT name, state, purged_at IS NOT NULL AS purged FROM files WHERE tenant_id = $1 ORDER BY name',
      [owner.tenantId]);
    assert.deepEqual(rows, [
      { name: 'expired', state: 'DELETED', purged: true }, { name: 'fresh', state: 'DELETED', purged: false },
      { name: 'ready', state: 'READY', purged: false }, { name: 'temporary', state: 'DELETED', purged: true },
    ]);
    assert.deepEqual(await cleanupFiles(owner, { deletedHours: 48, temporaryHours: 24 }, storage),
      { expiredTemporary: 0, purgedDeleted: 0, failed: 0 });
    t.diagnostic(JSON.stringify({ result, rows }));
  } finally {
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
