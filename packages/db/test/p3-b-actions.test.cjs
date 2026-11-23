const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

const emptyGroup = { operator: 'and', groups: [] };
const ruleConfig = (trigger, actions) => ({
  schemaVersion: 1, trigger, conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup }, actions,
});

function buildEngine() {
  const { AppSchemaService } = require('../../../apps/api/dist/app-schema.js');
  const { AuthorizationService } = require('../../../apps/api/dist/authorization.js');
  const { AutomationService } = require('../../../apps/api/dist/automation.js');
  const { NotificationPlanner } = require('../../../apps/api/dist/notification-planner.js');
  const { RecordQueryService } = require('../../../apps/api/dist/record-query.js');
  const { FileService } = require('../../../apps/api/dist/files.js');
  const { RecordService } = require('../../../apps/api/dist/records.js');
  const { WorkflowRuntimeService } = require('../../../apps/api/dist/workflow-runtime.js');
  const authorization = new AuthorizationService();
  const schema = new AppSchemaService(authorization);
  const planner = new NotificationPlanner(schema, authorization);
  const records = new RecordService(schema, authorization,
    new RecordQueryService(schema, authorization), new FileService(schema, authorization), planner);
  const workflows = new WorkflowRuntimeService(schema, authorization, planner);
  return new AutomationService(schema, authorization, records, workflows);
}

async function auditClient() {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  return client;
}

async function makeRule(write, name, config, grant) {
  const saved = await write('/automation/rules', { name, config });
  const version = saved.version.version;
  await write(`/automation/rules/${saved.rule.id}/grants`, { version, ...grant });
  const preflight = await write(`/automation/rules/${saved.rule.id}/preflight`, { version });
  assert.equal(preflight.publishable, true, `preflight must pass for ${name}: ${JSON.stringify(preflight.findings)}`);
  await write(`/automation/rules/${saved.rule.id}/publish`, { version });
  await write(`/automation/rules/${saved.rule.id}/enable`, { enabled: true });
  return { id: saved.rule.id, version };
}

const writer = (token, base) => (path, body, method = 'POST', code = 201) =>
  expectRequest(code, base + path, { token, body, method });

test('P3-B A-1 notify + A-2 field updates execute; V-10 dedup; no-progress writes nothing', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3b-actions-core');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'p3b_title', 'text');
  const status = await addField(token, app.id, 'p3b_status', 'text');
  const count = await addField(token, app.id, 'p3b_count', 'number');
  const assignee = await addField(token, app.id, 'p3b_assignee', 'user');
  const note = await addField(token, app.id, 'p3b_note', 'text');
  await publish(token, app.id);

  const notifyAction = randomUUID();
  const rule = await makeRule(write, 'Triage on create', ruleConfig({ eventType: 'record.created' }, [
    { actionId: notifyAction, type: 'NOTIFY', notify: {
      recipientFieldId: assignee.fieldId, title: 'New: {{' + title.fieldId + '}}', body: 'Count {{' + count.fieldId + '}}',
    } },
    { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [
      { fieldId: status.fieldId, mode: 'set', value: 'triaged' },
      { fieldId: count.fieldId, mode: 'increment', value: 5 },
      { fieldId: note.fieldId, mode: 'copy', sourceFieldId: title.fieldId },
    ] },
  ]), {
    sourceAppId: app.id,
    readableFieldIds: [title.fieldId, count.fieldId, assignee.fieldId, status.fieldId, note.fieldId],
    targetAppIds: [], writableFieldIds: [status.fieldId, count.fieldId, note.fieldId],
    allowedOperations: ['NOTIFY', 'UPDATE_FIELDS'],
  });
  const noopRule = await makeRule(write, 'No-progress guard', ruleConfig({
    eventType: 'record.updated', fieldId: status.fieldId, newValue: 'triaged',
  }, [
    { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [
      { fieldId: status.fieldId, mode: 'set', value: 'triaged' },
    ] },
  ]), {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [],
    writableFieldIds: [status.fieldId], allowedOperations: ['UPDATE_FIELDS'],
  });

  const record = await write('/records', { data: {
    [title.fieldId]: 'Alpha', [count.fieldId]: '10', [assignee.fieldId]: owner.userId, [status.fieldId]: 'draft',
  } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  await engine.processOutbox(context);

  const audit = await auditClient();
  try {
    const runs = await audit.query(
      `SELECT rule_id, status FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY started_at`,
      [owner.tenantId, app.id, record.id]);
    const main = runs.rows.filter((row) => row.rule_id === rule.id);
    assert.equal(main.length, 1);
    assert.equal(main[0].status, 'SUCCEEDED');
    const noop = runs.rows.filter((row) => row.rule_id === noopRule.id);
    assert.equal(noop.length, 1, 'the triaged update triggers the no-progress rule exactly once');
    assert.equal(noop[0].status, 'SUCCEEDED');
    const noopAction = await audit.query(
      `SELECT status, result_ref FROM automation_run_actions WHERE tenant_id=$1 AND run_id IN
         (SELECT id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3)`,
      [owner.tenantId, noopRule.id, record.id]);
    assert.equal(noopAction.rows[0].status, 'SUCCEEDED');
    assert.equal(noopAction.rows[0].result_ref, 'no-progress');

    const notices = await audit.query(
      `SELECT title, body, rule_key FROM notifications WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 AND source_type='RECORD'`,
      [owner.tenantId, app.id, record.id]);
    assert.equal(notices.rowCount, 1, 'V-10: exactly one automation notification after reprocessing');
    assert.equal(notices.rows[0].title, 'New: Alpha');
    assert.equal(notices.rows[0].body, 'Count 10');
    assert.equal(notices.rows[0].rule_key, `automation:${rule.id}:${notifyAction}`);

    const updatedEvents = await audit.query(
      `SELECT count(*)::int AS count FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 AND kind='updated'`,
      [owner.tenantId, app.id, record.id]);
    assert.equal(updatedEvents.rows[0].count, 1, 'no-progress suppression: only the real update produced an event');
  } finally { await audit.end(); }

  const after = await expectRequest(200, `${base}/records/${record.id}`, { token });
  assert.equal(after.data[status.fieldId], 'triaged');
  assert.equal(after.data[count.fieldId], '15');
  assert.equal(after.data[note.fieldId], 'Alpha');
  assert.equal(after.revision, record.revision + 1, 'exactly one revision bump from the update action');
});

test('P3-B A-3 cross-app create is idempotent across retries; failed actions do not replay succeeded ones', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const appA = await createApp(token, 'p3b-orders');
  const appB = await createApp(token, 'p3b-tickets');
  const writeA = writer(token, `/apps/${appA.id}`);
  const titleA = await addField(token, appA.id, 'p3b_order_title', 'text');
  await publish(token, appA.id);
  const titleB = await addField(token, appB.id, 'p3b_ticket_title', 'text');
  const refB = await addField(token, appB.id, 'p3b_ticket_ref', 'text');
  await publish(token, appB.id);

  const createAction = randomUUID();
  const rule = await makeRule(writeA, 'Open ticket', ruleConfig({ eventType: 'record.created' }, [
    { actionId: createAction, type: 'CREATE_RECORD', targetAppId: appB.id, mappings: [
      { targetFieldId: titleB.fieldId, mode: 'source', sourceFieldId: titleA.fieldId },
      { targetFieldId: refB.fieldId, mode: 'constant', value: 'auto' },
    ] },
    { actionId: randomUUID(), type: 'WEBHOOK' },
  ]), {
    sourceAppId: appA.id, readableFieldIds: [titleA.fieldId], targetAppIds: [appB.id],
    writableFieldIds: [titleB.fieldId, refB.fieldId], allowedOperations: ['CREATE_RECORD', 'WEBHOOK'],
  });

  const record = await writeA('/records', { data: { [titleA.fieldId]: 'Order-1' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);

  const audit = await auditClient();
  try {
    const runs = await audit.query(
      `SELECT id, status FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, appA.id, rule.id]);
    assert.equal(runs.rowCount, 1);
    assert.equal(runs.rows[0].status, 'FAILED', 'webhook action fails explicitly in P3-B');
    const runId = runs.rows[0].id;
    const actions = await audit.query(
      `SELECT action_id, status, error_code, attempt_count FROM automation_run_actions
       WHERE tenant_id=$1 AND run_id=$2 ORDER BY position`,
      [owner.tenantId, runId]);
    assert.equal(actions.rows[0].status, 'SUCCEEDED');
    assert.equal(actions.rows[1].status, 'FAILED');
    assert.equal(actions.rows[1].error_code, 'WEBHOOK_NOT_IMPLEMENTED_P3D');
    const created = await audit.query(
      `SELECT count(*)::int AS count FROM records WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, appB.id]);
    assert.equal(created.rows[0].count, 1);
    const keys = await audit.query(
      `SELECT count(*)::int AS count FROM record_create_keys WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, appB.id]);
    assert.equal(keys.rows[0].count, 1, 'C5: the create is anchored by a DB idempotency key');

    const retry = await expectRequest(201, `/apps/${appA.id}/automation/runs/${runId}/retry`, { token, method: 'POST' });
    assert.equal(retry.status, 'FAILED');
    const after = await audit.query(
      `SELECT status, attempt_count FROM automation_run_actions WHERE tenant_id=$1 AND run_id=$2 ORDER BY position`,
      [owner.tenantId, runId]);
    assert.equal(after.rows[0].attempt_count, 1, 'succeeded create action is not replayed on retry');
    assert.equal(after.rows[1].attempt_count, 2, 'only the failed action is retried');
    const createdAfter = await audit.query(
      `SELECT count(*)::int AS count FROM records WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, appB.id]);
    assert.equal(createdAfter.rows[0].count, 1, 'gate: retry does not duplicate the created record');
    assert.equal(record.id !== undefined, true);
  } finally { await audit.end(); }
});

test('P3-B A-4 workflow: automation opt-in enforced, attribution recorded, state-mismatch retry recovers', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3b-workflow');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'p3b_wf_title', 'text');
  await publish(token, app.id);

  const intake = { id: randomUUID(), code: 'intake', name: 'Intake', initial: true, terminal: false, assignees: [{ kind: 'creator' }] };
  const review = { id: randomUUID(), code: 'review', name: 'Review', initial: false, terminal: false, assignees: [{ kind: 'creator' }] };
  const done = { id: randomUUID(), code: 'done', name: 'Done', initial: false, terminal: true, assignees: [] };
  const begin = { id: randomUUID(), name: 'Begin review', fromStateId: intake.id, toStateId: review.id, conditions: [], assignees: [{ kind: 'creator' }] };
  const approve = { id: randomUUID(), name: 'Approve', fromStateId: review.id, toStateId: done.id, conditions: [], assignees: [{ kind: 'creator' }] };
  const autoClose = { id: randomUUID(), name: 'Auto close', fromStateId: review.id, toStateId: done.id, conditions: [], assignees: [], automationAllowed: true };
  await write('/workflow/draft', { states: [intake, review, done], actions: [begin, approve, autoClose] }, 'PUT', 200);
  await write('/workflow/publish');
  await write('/workflow/enabled', { enabled: true }, 'PATCH', 200);

  const grant = {
    sourceAppId: app.id, readableFieldIds: [title.fieldId], targetAppIds: [],
    writableFieldIds: [], allowedOperations: ['ADVANCE_WORKFLOW'],
  };
  const humanOnly = await makeRule(write, 'Approve by automation (must fail)', ruleConfig({ eventType: 'record.created' }, [
    { actionId: randomUUID(), type: 'ADVANCE_WORKFLOW', workflowActionId: approve.id },
  ]), grant);
  const closer = await makeRule(write, 'Auto close from review', ruleConfig({ eventType: 'record.created' }, [
    { actionId: randomUUID(), type: 'ADVANCE_WORKFLOW', workflowActionId: autoClose.id },
  ]), grant);

  const record = await write('/records', { data: { [title.fieldId]: 'Case-1' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);

  const audit = await auditClient();
  try {
    const runs = await audit.query(
      `SELECT rule_id, status FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3`,
      [owner.tenantId, app.id, record.id]);
    const byRule = new Map(runs.rows.map((row) => [row.rule_id, row.status]));
    assert.equal(byRule.get(humanOnly.id), 'FAILED');
    assert.equal(byRule.get(closer.id), 'FAILED');
    const errors = await audit.query(
      `SELECT r.rule_id, a.error_code FROM automation_run_actions a
       JOIN automation_runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
       WHERE a.tenant_id=$1 AND a.app_id=$2 AND r.record_id=$3`,
      [owner.tenantId, app.id, record.id]);
    const codeByRule = new Map(errors.rows.map((row) => [row.rule_id, row.error_code]));
    assert.equal(codeByRule.get(humanOnly.id), 'WORKFLOW_ACTION_NOT_AUTOMATION_ALLOWED',
      'gate: automation never performs a human-only approval action');
    assert.equal(codeByRule.get(closer.id), 'WORKFLOW_STATE_MISMATCH');
    const events = await audit.query(
      `SELECT count(*)::int AS count FROM workflow_events WHERE tenant_id=$1 AND app_id=$2 AND action_id IS NOT NULL`,
      [owner.tenantId, app.id]);
    assert.equal(events.rows[0].count, 0, 'no workflow transition was faked');
  } finally { await audit.end(); }

  // A human moves the record into Review through the normal workflow API,
  // then the failed auto-close run is retried and succeeds.
  const before = await expectRequest(200, `${base}/records/${record.id}`, { token });
  await write(`/records/${record.id}/workflow/actions`, { action_id: begin.id, revision: before.revision }, 'POST', 201);
  const audit2 = await auditClient();
  let closerRunId;
  try {
    const runs = await audit2.query(
      `SELECT id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3`,
      [owner.tenantId, closer.id, record.id]);
    closerRunId = runs.rows[0].id;
  } finally { await audit2.end(); }
  const retry = await expectRequest(201, `${base}/automation/runs/${closerRunId}/retry`, { token, method: 'POST' });
  assert.equal(retry.status, 'SUCCEEDED');

  const audit3 = await auditClient();
  try {
    const events = await audit3.query(
      `SELECT actor_type, rule_id, run_id, action_id FROM workflow_events WHERE tenant_id=$1 AND app_id=$2 AND actor_type='AUTOMATION'`,
      [owner.tenantId, app.id]);
    assert.equal(events.rowCount, 1);
    assert.equal(events.rows[0].rule_id, closer.id);
    assert.equal(events.rows[0].run_id, closerRunId);
    assert.equal(events.rows[0].action_id, autoClose.id);
    const chained = await audit3.query(
      `SELECT root_causation_id, parent_run_id, origin_rule_id, causation_depth FROM outbox
       WHERE tenant_id=$1 AND app_id=$2 AND topic='record.workflow-action' ORDER BY causation_depth DESC LIMIT 1`,
      [owner.tenantId, app.id]);
    assert.equal(chained.rows[0].parent_run_id, closerRunId, 'C3: workflow event causation points at the run');
    assert.equal(chained.rows[0].origin_rule_id, closer.id);
  } finally { await audit3.end(); }
  const after = await expectRequest(200, `${base}/records/${record.id}`, { token });
  assert.equal(after.status, 'done');
});

test('P3-B C3 genuine ping-pong chain terminates as BLOCKED_CYCLE with full causation quintuples', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3b-pingpong');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const flag = await addField(token, app.id, 'p3b_flag', 'text');
  await publish(token, app.id);
  const grant = {
    sourceAppId: app.id, readableFieldIds: [flag.fieldId], targetAppIds: [],
    writableFieldIds: [flag.fieldId], allowedOperations: ['UPDATE_FIELDS'],
  };
  const pingAction = randomUUID();
  const ruleA = await makeRule(write, 'Ping to pong', ruleConfig({
    eventType: 'record.updated', fieldId: flag.fieldId, newValue: 'ping',
  }, [
    { actionId: pingAction, type: 'UPDATE_FIELDS', updates: [{ fieldId: flag.fieldId, mode: 'set', value: 'pong' }] },
  ]), grant);
  const savedB = await write('/automation/rules', { name: 'Pong to ping', config: ruleConfig({
    eventType: 'record.updated', fieldId: flag.fieldId, newValue: 'pong',
  }, [
    { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [{ fieldId: flag.fieldId, mode: 'set', value: 'ping' }] },
  ]) });
  await write(`/automation/rules/${savedB.rule.id}/grants`, { version: savedB.version.version, ...grant });
  const preflightB = await write(`/automation/rules/${savedB.rule.id}/preflight`, { version: savedB.version.version });
  assert.equal(preflightB.publishable, true);
  assert.ok(preflightB.findings.some((finding) => finding.code === 'POTENTIAL_CYCLE'),
    'static analysis warns POTENTIAL_CYCLE but does not block');
  await write(`/automation/rules/${savedB.rule.id}/publish`, { version: savedB.version.version });
  await write(`/automation/rules/${savedB.rule.id}/enable`, { enabled: true });
  const ruleB = { id: savedB.rule.id };

  const record = await write('/records', { data: { [flag.fieldId]: 'init' } });
  await write(`/records/${record.id}`, { revision: record.revision, data: { [flag.fieldId]: 'ping' } }, 'PUT', 200);
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  for (let i = 0; i < 5; i++) await engine.processOutbox(context);

  const audit = await auditClient();
  try {
    const runs = await audit.query(
      `SELECT rule_id, status, causation_depth, root_causation_id, id FROM automation_runs
       WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY causation_depth, started_at`,
      [owner.tenantId, app.id, record.id]);
    const succeeded = runs.rows.filter((row) => row.status === 'SUCCEEDED');
    const blocked = runs.rows.filter((row) => row.status === 'BLOCKED_CYCLE');
    assert.equal(succeeded.length, 2, 'exactly two executions happen before the runtime cycle guard stops the chain');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].rule_id, ruleA.id);
    const runA = succeeded.find((row) => row.rule_id === ruleA.id);
    const runB = succeeded.find((row) => row.rule_id === ruleB.id);
    assert.equal(runA.causation_depth, 1);
    assert.equal(runB.causation_depth, 2);
    assert.equal(runA.root_causation_id, runB.root_causation_id);
    const out = await audit.query(
      `SELECT parent_run_id, origin_rule_id, origin_action_id, causation_depth FROM outbox
       WHERE tenant_id=$1 AND app_id=$2 AND event_id IN
         (SELECT event_id FROM record_events WHERE tenant_id=$1 AND record_id=$3 AND kind='updated')
       ORDER BY causation_depth`,
      [owner.tenantId, app.id, record.id]);
    const automationEvents = out.rows.filter((row) => row.parent_run_id);
    assert.equal(automationEvents.length, 2);
    assert.equal(automationEvents[0].parent_run_id, runA.id);
    assert.equal(automationEvents[0].origin_rule_id, ruleA.id);
    assert.equal(automationEvents[0].origin_action_id, pingAction);
    assert.equal(automationEvents[1].parent_run_id, runB.id);
    assert.equal(automationEvents[1].origin_rule_id, ruleB.id);
  } finally { await audit.end(); }
  const after = await expectRequest(200, `${base}/records/${record.id}`, { token });
  assert.equal(after.data[flag.fieldId], 'ping', 'the blocked third hop never wrote');
});

test('P3-B C3 cross-application chain carries the causation quintuple across apps', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const appE = await createApp(token, 'p3b-chain-source');
  const appF = await createApp(token, 'p3b-chain-target');
  const writeE = writer(token, `/apps/${appE.id}`);
  const writeF = writer(token, `/apps/${appF.id}`);
  const nameE = await addField(token, appE.id, 'p3b_chain_name', 'text');
  await publish(token, appE.id);
  const titleF = await addField(token, appF.id, 'p3b_chain_title', 'text');
  const markerF = await addField(token, appF.id, 'p3b_chain_marker', 'text');
  await publish(token, appF.id);

  const ruleF = await makeRule(writeF, 'Announce F creation', ruleConfig({ eventType: 'record.created' }, [
    { actionId: randomUUID(), type: 'NOTIFY', notify: {
      recipientUserIds: [owner.userId], title: 'F created {{' + titleF.fieldId + '}}',
    } },
  ]), {
    sourceAppId: appF.id, readableFieldIds: [titleF.fieldId], targetAppIds: [],
    writableFieldIds: [], allowedOperations: ['NOTIFY'],
  });
  const ruleE = await makeRule(writeE, 'Create in F', ruleConfig({ eventType: 'record.created' }, [
    { actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: appF.id, mappings: [
      { targetFieldId: titleF.fieldId, mode: 'source', sourceFieldId: nameE.fieldId },
      { targetFieldId: markerF.fieldId, mode: 'constant', value: 'from-e' },
    ] },
  ]), {
    sourceAppId: appE.id, readableFieldIds: [nameE.fieldId], targetAppIds: [appF.id],
    writableFieldIds: [titleF.fieldId, markerF.fieldId], allowedOperations: ['CREATE_RECORD'],
  });

  const record = await writeE('/records', { data: { [nameE.fieldId]: 'Chain-1' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  for (let i = 0; i < 4; i++) await engine.processOutbox(context);

  const audit = await auditClient();
  try {
    const createdF = await audit.query(
      `SELECT data FROM records WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, appF.id]);
    assert.equal(createdF.rowCount, 1);
    assert.equal(createdF.rows[0].data[titleF.fieldId], 'Chain-1');
    assert.equal(createdF.rows[0].data[markerF.fieldId], 'from-e');
    const runE = await audit.query(
      `SELECT id, status, causation_depth FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, ruleE.id]);
    assert.equal(runE.rows[0].status, 'SUCCEEDED');
    assert.equal(runE.rows[0].causation_depth, 1);
    const runF = await audit.query(
      `SELECT status, causation_depth, parent_run_id, root_causation_id FROM automation_runs
       WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, ruleF.id]);
    assert.equal(runF.rowCount, 1);
    assert.equal(runF.rows[0].status, 'SUCCEEDED');
    assert.equal(runF.rows[0].causation_depth, 2, 'depth increments across the application boundary');
    assert.equal(runF.rows[0].parent_run_id, runE.rows[0].id, 'parent points at the creating run');
    const notices = await audit.query(
      `SELECT title FROM notifications WHERE tenant_id=$1 AND app_id=$2 AND source_type='RECORD'`,
      [owner.tenantId, appF.id]);
    assert.equal(notices.rowCount, 1);
    assert.equal(notices.rows[0].title, 'F created Chain-1');
    assert.ok(record.id);
  } finally { await audit.end(); }
});

test('P3-B T-4 manual runs, C4 query APIs and the 90-day retention policy', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3b-manual');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const status = await addField(token, app.id, 'p3b_manual_status', 'text');
  await publish(token, app.id);
  const grant = {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [],
    writableFieldIds: [status.fieldId], allowedOperations: ['UPDATE_FIELDS', 'NOTIFY'],
  };
  const manual = await makeRule(write, 'Manual stamp', ruleConfig({
    eventType: 'record.created', allowManual: true,
  }, [
    { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [
      { fieldId: status.fieldId, mode: 'set', value: 'manual-ok' },
    ] },
    { actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Stamped' } },
  ]), grant);
  const noManual = await makeRule(write, 'No manual runs', ruleConfig({ eventType: 'record.created' }, [
    { actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Hi' } },
  ]), { ...grant, allowedOperations: ['NOTIFY'] });

  const record = await write('/records', { data: { [status.fieldId]: 'draft' } });
  const first = await expectRequest(201, `${base}/automation/rules/${manual.id}/manual-runs`, {
    token, method: 'POST', body: { recordId: record.id, idempotencyKey: 'stamp-1' },
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.run.status, 'SUCCEEDED');
  assert.equal(first.actions.filter((action) => action.status === 'SUCCEEDED').length, 2);
  const stamped = await expectRequest(200, `${base}/records/${record.id}`, { token });
  assert.equal(stamped.data[status.fieldId], 'manual-ok');

  const again = await expectRequest(201, `${base}/automation/rules/${manual.id}/manual-runs`, {
    token, method: 'POST', body: { recordId: record.id, idempotencyKey: 'stamp-1' },
  });
  assert.equal(again.deduplicated, true, 'the same idempotency key returns the original run');
  assert.equal(again.run.id, first.run.id);
  const stampedAgain = await expectRequest(200, `${base}/records/${record.id}`, { token });
  assert.equal(stampedAgain.revision, stamped.revision, 'deduplicated manual run writes nothing');

  await expectRequest(400, `${base}/automation/rules/${noManual.id}/manual-runs`, {
    token, method: 'POST', body: { recordId: record.id },
  });

  const page = await expectRequest(200, `${base}/automation/runs?ruleId=${manual.id}`, { token });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, first.run.id);
  const detail = await expectRequest(200, `${base}/automation/runs/${first.run.id}`, { token });
  assert.equal(detail.actions.length, 2);
  const summary = await expectRequest(200, `${base}/automation/summary`, { token });
  const manualSummary = summary.rules.find((entry) => entry.ruleId === manual.id);
  assert.equal(manualSummary.succeeded, 1);
  const auditPage = await expectRequest(200, `${base}/automation/audit?action=MANUAL_RUN`, { token });
  assert.ok(auditPage.total >= 1);

  // Retention: an old terminal run is pruned with its actions; a run still
  // referenced by a paused problem chain and all audit events survive.
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  const audit = await auditClient();
  try {
    const insertRun = async (key, root) => {
      const { rows } = await audit.query(
        `INSERT INTO automation_runs (tenant_id, app_id, rule_id, rule_version, event_id, trigger_identity,
           idempotency_key, record_id, root_causation_id, causation_depth, status, completed_at)
         VALUES ($1,$2,$3,1,NULL,$4,$5,$6,$7,1,'SUCCEEDED', clock_timestamp() - interval '100 days')
         RETURNING id`,
        [owner.tenantId, app.id, manual.id, `manual:${key}`, `manual:${key}:${manual.id}:1`, record.id, root]);
      return rows[0].id;
    };
    const oldRun = await insertRun('old-1', randomUUID());
    const protectedRun = await insertRun('old-2', randomUUID());
    await audit.query(
      `INSERT INTO automation_run_actions (tenant_id, app_id, run_id, action_id, position, status, idempotency_key)
       VALUES ($1,$2,$3,$4,0,'SUCCEEDED',$5)`,
      [owner.tenantId, app.id, oldRun, randomUUID(), `manual:old-1:a1`]);
    await audit.query(
      `INSERT INTO automation_problem_chains (tenant_id, root_causation_id, reason, last_run_id)
       VALUES ($1,$2,'CAUSATION_DEPTH_EXCEEDED',$3)`,
      [owner.tenantId, randomUUID(), protectedRun]);
    const auditBefore = await audit.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    const result = await engine.pruneRunHistory(context);
    assert.ok(result.pruned >= 1);
    const remaining = await audit.query(
      `SELECT id FROM automation_runs WHERE tenant_id=$1 AND id IN ($2,$3)`,
      [owner.tenantId, oldRun, protectedRun]);
    assert.deepEqual(remaining.rows.map((row) => row.id), [protectedRun],
      'problem-chain-referenced runs survive pruning');
    const auditAfter = await audit.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count, 'audit events are never pruned');
  } finally { await audit.end(); }
});

test('P3-B permission gates: unauthorized operations never write; revoked grants block retry and manual runs', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3b-gates');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const status = await addField(token, app.id, 'p3b_gate_status', 'text');
  await publish(token, app.id);

  const unauthorized = await makeRule(write, 'Operation outside grant', ruleConfig({ eventType: 'record.created' }, [
    { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [
      { fieldId: status.fieldId, mode: 'set', value: 'hacked' },
    ] },
  ]), {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [],
    writableFieldIds: [status.fieldId], allowedOperations: ['UPDATE_FIELDS'],
  });
  // Narrow the grant after publication: the update operation is no longer
  // covered, so the runtime recheck must refuse to write.
  const audit0 = await auditClient();
  let firstGrantId;
  try {
    const grants = await audit0.query(
      `SELECT id FROM automation_grants WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, unauthorized.id]);
    firstGrantId = grants.rows[0].id;
  } finally { await audit0.end(); }
  await write(`/automation/rules/${unauthorized.id}/grants/${firstGrantId}/revoke`, undefined);
  await write(`/automation/rules/${unauthorized.id}/grants`, {
    version: unauthorized.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
    targetAppIds: [], writableFieldIds: [status.fieldId], allowedOperations: ['NOTIFY'],
  });
  const record = await write('/records', { data: { [status.fieldId]: 'draft' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  const audit = await auditClient();
  try {
    const runs = await audit.query(
      `SELECT status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3`,
      [owner.tenantId, unauthorized.id, record.id]);
    assert.equal(runs.rows[0].status, 'SKIPPED_UNAUTHORIZED');
  } finally { await audit.end(); }
  const untouched = await expectRequest(200, `${base}/records/${record.id}`, { token });
  assert.equal(untouched.data[status.fieldId], 'draft', 'gate: an operation outside the grant writes nothing');
  assert.equal(untouched.revision, record.revision);

  const failing = await makeRule(write, 'Failing then revoked', ruleConfig({
    eventType: 'record.created', allowManual: true,
  }, [
    { actionId: randomUUID(), type: 'WEBHOOK' },
  ]), {
    sourceAppId: app.id, readableFieldIds: [], targetAppIds: [],
    writableFieldIds: [], allowedOperations: ['WEBHOOK'],
  });
  const record2 = await write('/records', { data: { [status.fieldId]: 'draft' } });
  await engine.processOutbox(context);
  const audit2 = await auditClient();
  let failedRunId;
  let grantId;
  try {
    const runs = await audit2.query(
      `SELECT id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3 AND status='FAILED'`,
      [owner.tenantId, failing.id, record2.id]);
    failedRunId = runs.rows[0].id;
    const grants = await audit2.query(
      `SELECT id FROM automation_grants WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, failing.id]);
    grantId = grants.rows[0].id;
  } finally { await audit2.end(); }
  await write(`/automation/rules/${failing.id}/grants/${grantId}/revoke`, undefined);
  await expectRequest(409, `${base}/automation/runs/${failedRunId}/retry`, { token, method: 'POST' });
  await expectRequest(409, `${base}/automation/rules/${failing.id}/manual-runs`, {
    token, method: 'POST', body: { recordId: record2.id },
  });
});
