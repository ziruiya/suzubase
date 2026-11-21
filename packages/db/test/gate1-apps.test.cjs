const assert = require('node:assert/strict');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-02 app copy, archive and protected recycle bin preserve published identity', async () => {
  const owner = await provision();
  const token = await login(owner);
  const original = await createApp(token);
  const app = '/apps/' + original.id;
  const title = await addField(token, original.id, 'title', 'text');
  await publish(token, original.id);
  const record = await expectRequest(201, app + '/records', {
    method: 'POST', token, body: { data: { [title.fieldId]: 'Original' } },
  });
  const renamed = await expectRequest(200, app + '/settings', {
    method: 'PATCH', token, body: { name: 'Renamed', titleFieldId: title.fieldId, adminMemo: 'Private' },
  });
  assert.equal(renamed.code, original.code);
  assert.equal((await expectRequest(200, app, { token })).adminMemo, undefined);

  const copy = await expectRequest(201, app + '/copy', { method: 'POST', token, body: { code: 'copy', name: 'Copy' } });
  const copiedSchema = await expectRequest(200, '/apps/' + copy.id, { token });
  assert.equal(copiedSchema.fields.length, 1);
  assert.equal(copiedSchema.fields[0].fieldId, copiedSchema.titleFieldId);
  assert.notEqual(copiedSchema.titleFieldId, title.fieldId);
  await expectRequest(404, '/apps/' + copy.id + '/records/' + record.id, { token });

  await expectRequest(201, app + '/lifecycle', { method: 'POST', token, body: { action: 'archive' } });
  await expectRequest(409, app + '/records', { method: 'POST', token, body: { data: {} } });
  await expectRequest(200, app + '/records/' + record.id, { token });

  await expectRequest(200, app, { method: 'DELETE', token });
  await expectRequest(404, app, { token });
  await expectRequest(403, '/apps?bin=true', { token });
  await expectRequest(403, app + '/lifecycle', { method: 'POST', token, body: { action: 'restore' } });
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE tenant_members SET can_manage_recycle_bin = true WHERE tenant_id = $1 AND user_id = $2',
      [owner.tenantId, owner.userId]);
  } finally {
    await db.end();
  }
  assert.deepEqual((await expectRequest(200, '/apps?bin=true', { token })).map(({ id }) => id), [original.id]);
  await expectRequest(201, app + '/lifecycle', { method: 'POST', token, body: { action: 'restore' } });
  assert.equal((await expectRequest(200, app + '/records/' + record.id, { token })).data[title.fieldId], 'Original');
});
