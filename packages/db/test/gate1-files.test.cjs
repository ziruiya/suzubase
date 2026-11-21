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
