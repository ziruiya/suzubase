const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Client } = require('pg');
const { createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-07 repair requires an independent permission, writes a reasoned event and suppresses approval outbox', async (t) => {
  const owner = await provision();
  const assignee = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token, 'repair');
  const root = '/apps/' + app.id;
  const write = (path, body, method = 'POST', status = 201) => expectRequest(status, root + path, { token, body, method });
  const initial = { id: randomUUID(), code: 'open', name: 'Open', initial: true, terminal: false, assignees: [{ kind: 'creator' }] };
  const review = { id: randomUUID(), code: 'review', name: 'Review', initial: false, terminal: false, assignees: [] };
  await write('/workflow/draft', { states: [initial, review], actions: [] }, 'PUT', 200);
  await write('/workflow/publish');
  await write('/workflow/enabled', { enabled: true }, 'PATCH', 200);
  const record = await write('/records', { data: {} });
  const path = '/records/' + record.id + '/workflow/repair';
  const configuration = { revision: record.revision, stateId: review.id, reason: 'Recovered misrouted request', userIds: [assignee.userId] };
  await write(path, configuration, 'POST', 403);
  await write('/draft/acl', {
    app: [{ action: 'workflow-repair', subject: { kind: 'user', id: owner.userId } }], record: [], field: [],
  }, 'PUT', 200);
  await publish(token, app.id);
  await write(path, { ...configuration, reason: '   ' }, 'POST', 400);
  await write(path, { ...configuration, stateId: randomUUID() }, 'POST', 400);
  await write(path, { ...configuration, userIds: [randomUUID()] }, 'POST', 400);
  await write(path, { ...configuration, userIds: undefined }, 'POST', 400);
  const repaired = await write(path, configuration);
  assert.equal(repaired.state.code, 'review');
  assert.deepEqual(repaired.assigneeIds, [assignee.userId]);
  const workflowHistory = await expectRequest(200, root + '/records/' + record.id + '/workflow/history', { token });
  const event = workflowHistory.at(-1);
  assert.deepEqual({ id: event.eventId, kind: event.kind, reason: event.reason, action: event.action, from: event.from, to: event.to }, {
    id: repaired.eventId, kind: 'WORKFLOW_REPAIR', reason: configuration.reason, action: null, from: 'Open', to: 'Review',
  });
  const history = await expectRequest(200, root + '/records/' + record.id + '/history', { token });
  assert.equal(history.events.find(({ eventId }) => eventId === repaired.eventId).kind, 'WORKFLOW_REPAIR');
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    assert.equal((await db.query('SELECT 1 FROM outbox WHERE event_id = $1', [repaired.eventId])).rowCount, 0);
  } finally { await db.end(); }
  t.diagnostic(JSON.stringify(event));
});
