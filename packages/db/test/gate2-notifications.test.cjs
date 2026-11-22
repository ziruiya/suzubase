const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-09 notification outbox captures authorized recipients and field projection, with CSV silence and live link checks', async (t) => {
  configureRuntime();
  const { deliverNotifications } = require('../../../apps/api/dist/notification-worker.js');
  const owner = await provision();
  const allowed = await provision({ tenantId: owner.tenantId });
  const denied = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(allowed);
  const outsider = await login(denied);
  const app = await createApp(token, 'notice-outbox');
  const base = '/apps/' + app.id;
  const publicField = await addField(token, app.id, 'public_title', 'text');
  const secret = await addField(token, app.id, 'confidential', 'text');
  const user = (identity) => ({ kind: 'user', id: identity.userId });
  const appAcl = [allowed, denied].map((identity) => ({ action: 'view', subject: user(identity) }));
  const ownerView = { action: 'view', subject: user(owner), conditions: [] };
  const fullAcl = {
    app: appAcl, record: [ownerView, { action: 'view', subject: user(allowed), conditions: [] }],
    field: [{ action: 'view', subject: user(owner), fieldId: secret.fieldId }],
  };
  const write = (path, body, method = 'POST', status = 201) => expectRequest(status, base + path, { token, body, method });
  await write('/draft/acl', fullAcl, 'PUT', 200);
  await publish(token, app.id);
  const template = 'Visible {{' + publicField.fieldId + '}} / hidden {{' + secret.fieldId + '}}';
  const rules = [{ id: randomUUID(), enabled: true, trigger: 'created', recipients: [user(allowed), user(denied)],
    conditions: [{ fieldId: publicField.fieldId, operator: 'nonempty' }], title: template, body: template }];
  await write('/notification-rules', { rules }, 'PUT', 200);
  const data = { [publicField.fieldId]: 'approved title', [secret.fieldId]: 'secret-should-never-appear' };
  await write('/records', { data });
  assert.equal((await deliverNotifications(owner, false)).inserted, 0);
  await publish(token, app.id);
  const target = await write('/records', { data });
  const path = '/records/' + target.id + '/comments';
  const comment = await write(path, { parts: [ { kind: 'text', text: 'Review ' },
    { kind: 'mention', userId: allowed.userId }, { kind: 'mention', userId: denied.userId },
  ] });
  const delivered = await deliverNotifications(owner, false);
  assert.equal(delivered.inserted, 2);
  assert.equal((await deliverNotifications(owner, false)).inserted, 0);
  const count = (bearer) => expectRequest(200, '/notifications/unread', { token: bearer });
  assert.equal((await count(reader)).count, '2');
  assert.equal((await count(outsider)).count, '0');
  const inbox = await expectRequest(200, '/notifications?appId=' + app.id + '&read=unread', { token: reader });
  assert.equal(inbox.items.length, 2);
  const created = inbox.items.find(({ title }) => title.startsWith('Visible '));
  assert.equal(created.title, 'Visible approved title / hidden');
  assert.equal(created.body, 'Visible approved title / hidden ');
  assert.ok(inbox.items.some(({ title }) => title === 'You were mentioned'));
  assert.ok(!JSON.stringify(inbox).includes(data[secret.fieldId]));

  const sql = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await sql.connect();
  try {
    const { rows } = await sql.query(
      'SELECT email_state AS "emailState", title, body FROM notifications WHERE tenant_id = $1', [owner.tenantId]);
    assert.ok(rows.every(({ emailState }) => emailState === 'skipped'));
    assert.ok(!JSON.stringify(rows).includes(data[secret.fieldId]));
  } finally { await sql.end(); }

  await expectRequest(201, '/notifications/' + created.id + '/read', { token: reader, method: 'POST' });
  assert.equal((await count(reader)).count, '1');
  const csv = await write('/csv/preflight', { csv: 'Title\nImported\n', mapping: { Title: publicField.fieldId } });
  await write('/csv/' + csv.id + '/apply', { offset: 0 });
  assert.equal((await deliverNotifications(owner, false)).inserted, 0);
  assert.equal((await count(reader)).count, '1');

  await write('/draft/acl', { ...fullAcl, record: [ownerView] }, 'PUT', 200);
  await publish(token, app.id);
  const masked = await expectRequest(200, '/notifications?read=read', { token: reader });
  assert.equal(masked.items[0].title, 'Notification');
  assert.equal(masked.items[0].body, '');
  const revoked = await expectRequest(404, '/notifications/' + created.id + '/open', { token: reader, method: 'POST' });
  assert.equal(revoked.message, '无权限');
  await expectRequest(201, '/notifications/read-all', { token: reader, method: 'POST' });
  assert.equal((await count(reader)).count, '0');
  t.diagnostic(JSON.stringify({ eventId: comment.eventId, authorized: delivered.inserted, unauthorized: 0,
    ruleNotice: created, unreadAfterMark: 1, unreadAfterAll: 0, revoked, csvDelivered: 0, email: 'skipped' }));
});

test('P2-T2 system notifications are tenant-scoped, role-resolved, and deduplicated', async () => {
  configureRuntime();
  const admin = await provision({ isAdmin: true });
  const member = await provision({ tenantId: admin.tenantId });
  const otherTenant = await provision();
  const sourceEventId = randomUUID();
  const dedupKey = `backup:create:${randomUUID()}`;
  const sql = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await sql.connect();
  let duplicateFailed = false;
  try {
    await sql.query(`INSERT INTO notifications (
      tenant_id, source_type, app_id, record_id, event_id, user_id, rule_key,
      title, body, source_event_id, dedup_key, event_type, target_role, payload, email_state
    ) VALUES ($1, 'SYSTEM', NULL, NULL, NULL, $2, 'system:BACKUP_FAILED',
      'Deployment backup failed', 'A backup operation failed.', $3, $4, 'BACKUP_FAILED', 'TENANT_ADMIN',
      '{"operation":"create","status":"failed"}', 'skipped')`, [admin.tenantId, admin.userId, sourceEventId, dedupKey]);
    try {
      await sql.query(`INSERT INTO notifications (
      tenant_id, source_type, app_id, record_id, event_id, user_id, rule_key,
      title, body, source_event_id, dedup_key, event_type, target_role, payload, email_state
    ) VALUES ($1, 'SYSTEM', NULL, NULL, NULL, $2, 'system:BACKUP_FAILED',
      'Deployment backup failed', 'A backup operation failed.', $3, $4, 'BACKUP_FAILED', 'TENANT_ADMIN',
      '{"operation":"create","status":"failed"}', 'skipped')`, [admin.tenantId, admin.userId, sourceEventId, dedupKey])
    } catch (error) {
      duplicateFailed = true;
      assert.equal(error.code, '23505');
    }
    assert.equal(duplicateFailed, true);
  } finally {
    await sql.end();
  }
  const adminToken = await login(admin);
  const memberToken = await login(member);
  const outsiderToken = await login(otherTenant);
  assert.equal((await expectRequest(200, '/notifications/unread', { token: adminToken })).count, '1');
  assert.equal((await expectRequest(200, '/notifications/unread', { token: memberToken })).count, '0');
  assert.equal((await expectRequest(200, '/notifications/unread', { token: outsiderToken })).count, '0');
  const inbox = await expectRequest(200, '/notifications', { token: adminToken });
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].appId, null);
  assert.equal(inbox.items[0].appName, 'System');
});
