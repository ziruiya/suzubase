const assert = require('node:assert/strict');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-08 versioned ACLs are enforced by record reads, aggregate, attachment and the preview', async (t) => {
  const owner = await provision();
  const member = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(member);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const as = (status, method, path, body, bearer = token) =>
    expectRequest(status, base + path, { method, token: bearer, body });
  const assignee = await addField(token, app.id, 'person', 'user');
  const amount = await addField(token, app.id, 'amount', 'number');
  const secret = await addField(token, app.id, 'secret', 'number');
  await publish(token, app.id);
  const create = (userId, value) => as(201, 'POST', '/records', {
    data: { [assignee.fieldId]: userId, [amount.fieldId]: value, [secret.fieldId]: '999' },
  });
  const visible = await create(member.userId, '20');
  const hidden = await create(owner.userId, '50');
  const who = { kind: 'user', id: member.userId };
  const owns = { kind: 'user-field', id: assignee.fieldId };
  const creator = { kind: 'user', id: owner.userId };
  await as(200, 'PUT', '/draft/acl', {
    app: [{ action: 'view', subject: who }, { action: 'edit', subject: who }],
    record: [
      { action: 'view', subject: owns, conditions: [{ fieldId: assignee.fieldId, operator: 'current-user' }] },
      { action: 'view', subject: creator, conditions: [] },
      { action: 'edit', subject: owns, conditions: [{ fieldId: amount.fieldId, operator: 'nonempty' }] },
      { action: 'edit', subject: creator, conditions: [] },
    ],
    field: [{ fieldId: secret.fieldId, action: 'view', subject: creator }, { fieldId: secret.fieldId, action: 'edit', subject: creator }],
  });
  await as(404, 'GET', '/records', undefined, reader);
  await publish(token, app.id);
  const list = await as(200, 'GET', '/records', undefined, reader);
  assert.deepEqual(list.items.map(({ id }) => id), [visible.id]);
  assert.equal(list.items[0].data[secret.fieldId], undefined);
  const direct = await as(200, 'GET', '/records/' + visible.id, undefined, reader);
  assert.deepEqual(direct, list.items[0]);
  const denied = await as(404, 'GET', '/records/' + hidden.id, undefined, reader);
  assert.equal(denied.message, '无权限');
  const aggregate = await as(200, 'GET', '/records/aggregates?fields=' + amount.fieldId, undefined, reader);
  assert.equal(aggregate.count, '1');
  assert.equal(aggregate.fields[0].sum, '20');
  await as(400, 'GET', '/records/aggregates?fields=' + secret.fieldId, undefined, reader);
  await as(403, 'PUT', '/records/' + visible.id, { revision: 1, data: { [secret.fieldId]: '0' } }, reader);
  const edited = await as(200, 'PUT', '/records/' + visible.id, {
    revision: 1, data: { [assignee.fieldId]: member.userId, [amount.fieldId]: '21' },
  }, reader);
  assert.equal(edited.data[secret.fieldId], undefined);
  assert.equal((await as(200, 'GET', '/records/' + visible.id)).data[secret.fieldId], '999');

  const history = await as(200, 'GET', '/records/' + visible.id + '/history', undefined, reader);
  assert.ok(history.events.every(({ changes }) => changes.every(({ fieldId }) => fieldId !== secret.fieldId)));
  assert.ok(!history.schemas[2].some(({ fieldId }) => fieldId === secret.fieldId));
  await as(404, 'GET', '/records/' + visible.id + '/history/export', undefined, reader);
  const preview = await as(201, 'POST', '/permissions/preview', { userId: member.userId, recordId: visible.id });
  const hiddenPreview = await as(201, 'POST', '/permissions/preview', { userId: member.userId, recordId: hidden.id });
  assert.equal(preview.record.view.allowed, true);
  assert.equal(preview.record.edit.allowed, true);
  assert.equal(preview.fields[secret.fieldId].view.allowed, false);
  assert.equal(hiddenPreview.record.view.allowed, false);
  const byCondition = await as(201, 'POST', '/permissions/preview', {
    userId: member.userId, conditions: [{ fieldId: assignee.fieldId, operator: 'current-user' }],
  });
  assert.equal(byCondition.matchedRecords, '1');
  assert.equal(byCondition.record.view.allowedRecords, aggregate.count);
  assert.equal(byCondition.record.edit.allowed, preview.record.edit.allowed);
  assert.deepEqual(byCondition.record.view.matched, preview.record.view.matched);
  assert.equal(byCondition.fields[secret.fieldId].view.allowed, false);
  const excluded = await as(201, 'POST', '/permissions/preview', {
    userId: member.userId, conditions: [{ fieldId: amount.fieldId, operator: 'eq', value: '50' }],
  });
  assert.equal(excluded.matchedRecords, '1');
  assert.equal(excluded.record.view.allowedRecords, '0');
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    const audit = await db.query('SELECT record_id, record_conditions FROM permission_audit WHERE tenant_id = $1 AND app_id = $2', [owner.tenantId, app.id]);
    assert.equal(audit.rows.length, 4);
    assert.equal(audit.rows.filter(({ record_conditions }) => record_conditions !== null).length, 2);
  } finally {
    await db.end();
  }
  t.diagnostic(JSON.stringify({ list: list.items.length, aggregate, visible: preview.record, hidden: hiddenPreview.record, byCondition: byCondition.record, excluded: excluded.record }));
});
