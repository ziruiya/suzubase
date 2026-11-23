const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test, before, after } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

// P3-D wave3 (closing wave): S-scenario end-to-end runs, the V-05 / V-06
// supplements, the section 8.3 API-bypass negative, and the appendix-4
// dispositions (backfill revival, adoption lateness, cadence resume
// recheck). Everything goes through the real chain: real API writes ->
// outbox -> worker -> actions. SQL is used only to read evidence, to
// construct due schedule rows (the established P3-C pattern) and to
// simulate a worker that died after creating a run but before finalizing
// its plan (plan row reset -- never to fabricate an event or a result).
process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET = 'p3d-test-secret';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const maintenanceContext = (tenantId) => Object.freeze({ tenantId, userId: NIL_UUID });
const emptyGroup = { operator: 'and', groups: [] };
const emptyConditions = { eventSnapshot: emptyGroup, currentState: emptyGroup };
const eqConditions = (fieldId, value) => {
  const group = { operator: 'and', groups: [{ conditions: [{ fieldId, operator: 'eq', value }] }] };
  return { eventSnapshot: group, currentState: group };
};
const ruleConfig = (trigger, actions, conditions = emptyConditions) => ({ schemaVersion: 1, trigger, conditions, actions });

function buildEngine(deps = {}) {
  const { AppSchemaService } = require('../../../apps/api/dist/app-schema.js');
  const { AuthorizationService } = require('../../../apps/api/dist/authorization.js');
  const { AutomationService } = require('../../../apps/api/dist/automation.js');
  const { NotificationPlanner } = require('../../../apps/api/dist/notification-planner.js');
  const { RecordQueryService } = require('../../../apps/api/dist/record-query.js');
  const { RecordService } = require('../../../apps/api/dist/records.js');
  const { FileService } = require('../../../apps/api/dist/files.js');
  const { WorkflowRuntimeService } = require('../../../apps/api/dist/workflow-runtime.js');
  const authorization = new AuthorizationService();
  const schema = new AppSchemaService(authorization);
  const planner = new NotificationPlanner(schema, authorization);
  const records = new RecordService(schema, authorization,
    new RecordQueryService(schema, authorization), new FileService(schema, authorization), planner);
  const service = new AutomationService(schema, authorization, records,
    new WorkflowRuntimeService(schema, authorization, planner));
  if (deps.webhook) service.webhookDeps = deps.webhook;
  return service;
}
function scheduleModule() { return require('../../../apps/api/dist/automation-schedule.js'); }
async function adminClient() {
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  return db;
}
const writer = (token, base) => (path, body, method = 'POST', code = 201) =>
  expectRequest(code, base + path, { token, body, method });

async function makeRule(write, name, config, grant) {
  const saved = await write('/automation/rules', { name, config });
  const version = saved.version.version;
  await write(`/automation/rules/${saved.rule.id}/grants`, { version, ...grant });
  const preflight = await write(`/automation/rules/${saved.rule.id}/preflight`, { version });
  assert.equal(preflight.publishable, true, `preflight must pass for ${name}: ${JSON.stringify(preflight.findings)}`);
  await write(`/automation/rules/${saved.rule.id}/publish`, { version });
  await write(`/automation/rules/${saved.rule.id}/enable`, { enabled: true });
  return { id: saved.rule.id, version, grantId: null, saved };
}

// ---------------------------------------------------------------- S-(a)
test('P3-D wave3 S-a (= brief S-01 / task (a)): status becomes 対応中 -> assignee notified once, source event + run/action verified', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-sa');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'w3_title', 'text');
  const status = await addField(token, app.id, 'w3_status', 'text');
  const assignee = await addField(token, app.id, 'w3_assignee', 'user');
  await publish(token, app.id);
  const notifyAction = randomUUID();
  const rule = await makeRule(write, 'Notify assignee on 対応中', ruleConfig(
    { eventType: 'record.updated', fieldId: status.fieldId, newValue: '対応中' },
    [{ actionId: notifyAction, type: 'NOTIFY', notify: { recipientFieldId: assignee.fieldId, title: 'Case moved: {{' + title.fieldId + '}}', body: 'now in progress' } }],
  ), {
    sourceAppId: app.id, readableFieldIds: [title.fieldId, status.fieldId, assignee.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
  });
  const record = await write('/records', { data: { [title.fieldId]: 'Case-A', [status.fieldId]: '新規', [assignee.fieldId]: owner.userId } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  // Record PUT is a full-data replace: resend every field, changing only
  // the status (wiping the assignee here would silently notify nobody).
  const updated = await write(`/records/${record.id}`, { revision: record.revision, data: {
    [title.fieldId]: 'Case-A', [status.fieldId]: '対応中', [assignee.fieldId]: owner.userId,
  } }, 'PUT', 200);
  assert.equal(updated.data[status.fieldId], '対応中');
  await engine.processOutbox(context);
  await engine.processOutbox(context); // replay: dedup must hold
  const db = await adminClient();
  try {
    const runs = await db.query(`SELECT id, status, rule_version, event_id FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3`,
      [owner.tenantId, rule.id, record.id]);
    assert.equal(runs.rowCount, 1);
    assert.equal(runs.rows[0].status, 'SUCCEEDED');
    assert.equal(runs.rows[0].rule_version, rule.version);
    const evt = await db.query(`SELECT kind FROM record_events WHERE tenant_id=$1 AND event_id=$2`, [owner.tenantId, runs.rows[0].event_id]);
    assert.equal(evt.rows[0].kind, 'updated', 'run is bound to the real record.updated source event');
    const actions = await db.query(`SELECT status FROM automation_run_actions WHERE tenant_id=$1 AND run_id=$2`, [owner.tenantId, runs.rows[0].id]);
    assert.equal(actions.rows[0].status, 'SUCCEEDED');
    const notes = await db.query(`SELECT user_id, rule_key FROM notifications WHERE tenant_id=$1 AND record_id=$2 AND source_type='RECORD'`,
      [owner.tenantId, record.id]);
    assert.equal(notes.rowCount, 1, 'exactly one notification after replay (V-10)');
    assert.equal(notes.rows[0].user_id, owner.userId, 'recipient resolved from the assignee field');
    assert.equal(notes.rows[0].rule_key, `automation:${rule.id}:${notifyAction}`);
  } finally { await db.end(); }
});

// ---------------------------------------------------------------- S-(c)
test('P3-D wave3 S-c (task (c); brief S-01 family): workflow advance -> notify applicant + create next-step todo in linked app', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const appA = await createApp(token, 'p3dw3-sc-cases');
  const appB = await createApp(token, 'p3dw3-sc-todos');
  const baseA = `/apps/${appA.id}`;
  const writeA = writer(token, baseA);
  const writeB = writer(token, `/apps/${appB.id}`);
  const titleA = await addField(token, appA.id, 'w3_case_title', 'text');
  await publish(token, appA.id);
  const todoTitle = await addField(token, appB.id, 'w3_todo_title', 'text');
  const todoKind = await addField(token, appB.id, 'w3_todo_kind', 'text');
  await publish(token, appB.id);
  const intake = { id: randomUUID(), code: 'intake', name: 'Intake', initial: true, terminal: false, assignees: [{ kind: 'creator' }] };
  const review = { id: randomUUID(), code: 'review', name: 'Review', initial: false, terminal: false, assignees: [{ kind: 'creator' }] };
  const begin = { id: randomUUID(), name: 'Begin review', fromStateId: intake.id, toStateId: review.id, conditions: [], assignees: [{ kind: 'creator' }] };
  await writeA('/workflow/draft', { states: [intake, review], actions: [begin] }, 'PUT', 200);
  await writeA('/workflow/publish');
  await writeA('/workflow/enabled', { enabled: true }, 'PATCH', 200);
  const rule = await makeRule(writeA, 'On review: notify + todo', ruleConfig(
    { eventType: 'workflow.transitioned', toStateId: review.id },
    [
      { actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Review started: {{' + titleA.fieldId + '}}' } },
      { actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: appB.id, mappings: [
        { targetFieldId: todoTitle.fieldId, mode: 'source', sourceFieldId: titleA.fieldId },
        { targetFieldId: todoKind.fieldId, mode: 'constant', value: 'next-step' },
      ] },
    ],
  ), {
    sourceAppId: appA.id, readableFieldIds: [titleA.fieldId], targetAppIds: [appB.id],
    writableFieldIds: [todoTitle.fieldId, todoKind.fieldId], allowedOperations: ['NOTIFY', 'CREATE_RECORD'],
  });
  const record = await writeA('/records', { data: { [titleA.fieldId]: 'Case-C' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  const before = await expectRequest(200, `${baseA}/records/${record.id}`, { token });
  await writeA(`/records/${record.id}/workflow/actions`, { action_id: begin.id, revision: before.revision });
  await engine.processOutbox(context);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    const runs = await db.query(`SELECT id, status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3`,
      [owner.tenantId, rule.id, record.id]);
    assert.equal(runs.rowCount, 1);
    assert.equal(runs.rows[0].status, 'SUCCEEDED');
    const actions = await db.query(`SELECT status FROM automation_run_actions WHERE tenant_id=$1 AND run_id=$2 ORDER BY position`,
      [owner.tenantId, runs.rows[0].id]);
    assert.deepEqual(actions.rows.map((r) => r.status), ['SUCCEEDED', 'SUCCEEDED']);
    const notes = await db.query(`SELECT count(*)::int AS c FROM notifications WHERE tenant_id=$1 AND record_id=$2 AND rule_key LIKE $3`,
      [owner.tenantId, record.id, `automation:${rule.id}:%`]);
    assert.equal(notes.rows[0].c, 1, 'applicant notified exactly once');
    const todos = await db.query(`SELECT data FROM records WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, appB.id]);
    assert.equal(todos.rowCount, 1, 'exactly one next-step todo created');
    assert.equal(todos.rows[0].data[todoTitle.fieldId], 'Case-C');
    assert.equal(todos.rows[0].data[todoKind.fieldId], 'next-step');
    const wf = await db.query(`SELECT actor_type FROM workflow_events WHERE tenant_id=$1 AND app_id=$2 AND action_id=$3`,
      [owner.tenantId, appA.id, begin.id]);
    assert.equal(wf.rows[0].actor_type, 'USER', 'the triggering transition stays a human action; automation did not fake it');
  } finally { await db.end(); }
});

// ------------------------------------------------------- S-(d) + V-01
test('P3-D wave3 S-d (= brief S-03 / task (d)) + V-01: create case -> follow-up record; crash-style retry never creates a second record', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const appA = await createApp(token, 'p3dw3-sd-cases');
  const appB = await createApp(token, 'p3dw3-sd-followups');
  const writeA = writer(token, `/apps/${appA.id}`);
  const titleA = await addField(token, appA.id, 'w3_sd_title', 'text');
  await publish(token, appA.id);
  const titleB = await addField(token, appB.id, 'w3_fu_title', 'text');
  const refB = await addField(token, appB.id, 'w3_fu_ref', 'text');
  await publish(token, appB.id);
  const rule = await makeRule(writeA, 'Open follow-up', ruleConfig(
    { eventType: 'record.created' },
    [
      { actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: appB.id, mappings: [
        { targetFieldId: titleB.fieldId, mode: 'source', sourceFieldId: titleA.fieldId },
        { targetFieldId: refB.fieldId, mode: 'constant', value: 'auto-followup' },
      ] },
      { actionId: randomUUID(), type: 'WEBHOOK' }, // unconfigured: fails after the create committed
    ],
  ), {
    sourceAppId: appA.id, readableFieldIds: [titleA.fieldId], targetAppIds: [appB.id],
    writableFieldIds: [titleB.fieldId, refB.fieldId], allowedOperations: ['CREATE_RECORD', 'WEBHOOK'],
  });
  const record = await writeA('/records', { data: { [titleA.fieldId]: 'Case-D' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  const db = await adminClient();
  let runId;
  try {
    const runs = await db.query(`SELECT id, status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, rule.id]);
    assert.equal(runs.rows[0].status, 'FAILED', 'run failed at the webhook action AFTER the create committed (crash-equivalent state)');
    runId = runs.rows[0].id;
    const created = await db.query(`SELECT data FROM records WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, appB.id]);
    assert.equal(created.rowCount, 1);
    assert.equal(created.rows[0].data[titleB.fieldId], 'Case-D');
    assert.equal(created.rows[0].data[refB.fieldId], 'auto-followup');
  } finally { await db.end(); }
  // V-01 / V-09: retrying the failed run must not create a second record
  // and must re-run only the failed action.
  const retry = await expectRequest(201, `/apps/${appA.id}/automation/runs/${runId}/retry`, { token, method: 'POST' });
  assert.equal(retry.status, 'FAILED');
  const db2 = await adminClient();
  try {
    const created = await db2.query(`SELECT count(*)::int AS c FROM records WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, appB.id]);
    assert.equal(created.rows[0].c, 1, 'V-01: no second follow-up record after retry');
    const keys = await db2.query(`SELECT count(*)::int AS c FROM record_create_keys WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, appB.id]);
    assert.equal(keys.rows[0].c, 1, 'business idempotency key anchored exactly once');
    const actions = await db2.query(`SELECT status, attempt_count FROM automation_run_actions WHERE tenant_id=$1 AND run_id=$2 ORDER BY position`, [owner.tenantId, runId]);
    assert.equal(actions.rows[0].attempt_count, 1, 'succeeded create action not replayed (V-09)');
    assert.equal(actions.rows[1].attempt_count, 2, 'only the failed action retried (V-09)');
  } finally { await db2.end(); }
});

// ---------------------------------------------------------------- S-(e)
test('P3-D wave3 S-e (task (e)): weekly Monday cadence -> per-record summary notifications for matching records only, one shared batch', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-se');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const status = await addField(token, app.id, 'w3_se_status', 'text');
  await publish(token, app.id);
  const schedule = { cadence: 'weekly', weekdays: [1], localTime: '09:00', timezone: 'Asia/Tokyo' };
  const rule = await makeRule(write, 'Weekly open-case summary', ruleConfig(
    { eventType: 'schedule.fixed', schedule },
    [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Weekly summary item', body: 'open case' } }],
    eqConditions(status.fieldId, 'open'),
  ), {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
  });
  await write('/records', { data: { [status.fieldId]: 'open' } });
  await write('/records', { data: { [status.fieldId]: 'open' } });
  await write('/records', { data: { [status.fieldId]: 'closed' } });
  const { nextSlotAfter } = scheduleModule();
  const slot = nextSlotAfter(schedule, new Date('2026-12-06T00:00:00Z')); // a Monday 09:00 Asia/Tokyo slot
  assert.equal(new Date(slot.utc).toISOString(), '2026-12-07T00:00:00.000Z');
  const db = await adminClient();
  try {
    await db.query(`UPDATE automation_cadence_plans SET next_due_at=$3, next_slot_key=$4, status='ACTIVE', claim_token=NULL, claimed_at=NULL WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, rule.id, slot.utc.toISOString(), slot.slotKey]);
  } finally { await db.end(); }
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  const outcome = await engine.processSchedules(context, { now: new Date(slot.utc.getTime() + 60_000) });
  assert.equal(outcome.runsCreated, 2, 'one run per matching (open) record in the weekly slot');
  const again = await engine.processSchedules(context, { now: new Date(slot.utc.getTime() + 120_000) });
  assert.equal(again.runsCreated, 0, 'duplicate scan of the same slot creates nothing');
  const db2 = await adminClient();
  try {
    const runs = await db2.query(`SELECT batch_id, status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, rule.id]);
    assert.equal(runs.rowCount, 2);
    assert.ok(runs.rows.every((r) => r.status === 'SUCCEEDED'));
    assert.equal(new Set(runs.rows.map((r) => r.batch_id)).size, 1, 'all summary runs share the slot batch identity');
    const notes = await db2.query(`SELECT count(*)::int AS c FROM notifications WHERE tenant_id=$1 AND rule_key LIKE $2`,
      [owner.tenantId, `automation:${rule.id}:%`]);
    assert.equal(notes.rows[0].c, 2, 'verifiable summary count: exactly the 2 open records produced a summary notification; the closed one did not');
  } finally { await db2.end(); }
});

// ---------------------------------------------------------------- V-05
test('P3-D wave3 V-05: a run created under v1 stays bound to v1 after v2 publishes, and retry still rechecks the CURRENT grant state', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const appA = await createApp(token, 'p3dw3-v05-src');
  const appB = await createApp(token, 'p3dw3-v05-dst');
  const writeA = writer(token, `/apps/${appA.id}`);
  const titleA = await addField(token, appA.id, 'w3_v05_title', 'text');
  const statusA = await addField(token, appA.id, 'w3_v05_status', 'text');
  await publish(token, appA.id);
  const titleB = await addField(token, appB.id, 'w3_v05_btitle', 'text');
  await publish(token, appB.id);
  const grantV1 = {
    sourceAppId: appA.id, readableFieldIds: [titleA.fieldId], targetAppIds: [appB.id],
    writableFieldIds: [titleB.fieldId], allowedOperations: ['CREATE_RECORD', 'WEBHOOK'],
  };
  const v1 = await makeRule(writeA, 'V05 rule', ruleConfig(
    { eventType: 'record.created' },
    [
      { actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: appB.id, mappings: [{ targetFieldId: titleB.fieldId, mode: 'source', sourceFieldId: titleA.fieldId }] },
      { actionId: randomUUID(), type: 'WEBHOOK' },
    ],
  ), grantV1);
  const record = await writeA('/records', { data: { [titleA.fieldId]: 'V05-1', [statusA.fieldId]: 'new' } });
  const engine = buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  const db = await adminClient();
  let runId; let grantRowId;
  try {
    const runs = await db.query(`SELECT id, status, rule_version FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, v1.id]);
    assert.equal(runs.rows[0].status, 'FAILED');
    assert.equal(runs.rows[0].rule_version, 1);
    runId = runs.rows[0].id;
    const grants = await db.query(`SELECT id FROM automation_grants WHERE tenant_id=$1 AND rule_id=$2 AND rule_version=1`, [owner.tenantId, v1.id]);
    grantRowId = grants.rows[0].id;
  } finally { await db.end(); }
  // Publish v2 (completely different action) while the v1 run awaits retry.
  const draft2 = await writeA(`/automation/rules/${v1.id}/draft`, { config: ruleConfig(
    { eventType: 'record.created' },
    [{ actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [{ fieldId: statusA.fieldId, mode: 'set', value: 'v2-was-here' }] }],
  ) }, 'PUT', 200);
  const v2version = draft2.version; // saveDraft returns the version row itself (version is the number)
  assert.equal(v2version, 2);
  await writeA(`/automation/rules/${v1.id}/grants`, {
    version: v2version, sourceAppId: appA.id, readableFieldIds: [statusA.fieldId],
    targetAppIds: [], writableFieldIds: [statusA.fieldId], allowedOperations: ['UPDATE_FIELDS'],
  });
  await writeA(`/automation/rules/${v1.id}/publish`, { version: v2version });
  await writeA(`/automation/rules/${v1.id}/enable`, { enabled: true });
  // Retry the queued v1 run: it must execute the V1 action list (the
  // unconfigured WEBHOOK fails again), never the v2 UPDATE_FIELDS.
  const retry = await expectRequest(201, `/apps/${appA.id}/automation/runs/${runId}/retry`, { token, method: 'POST' });
  assert.equal(retry.status, 'FAILED', 'v1 run retries its own v1 actions, not v2');
  const after = await expectRequest(200, `/apps/${appA.id}/records/${record.id}`, { token });
  assert.equal(after.data[statusA.fieldId], 'new', 'v2 action never leaked into the v1 run');
  // Current-authorization recheck: revoke the v1 grant -> retry refused.
  await writeA(`/automation/rules/${v1.id}/grants/${grantRowId}/revoke`, {});
  const refused = await request(`/apps/${appA.id}/automation/runs/${runId}/retry`, { token, method: 'POST' });
  assert.equal(refused.status, 409, 'retry after grant revocation is refused by the current grant state');
  // Semantics pin (brief 5.2: a run references the version in effect when
  // it actually executes): an event that arrives under v2 binds v2.
  const record2 = await writeA('/records', { data: { [titleA.fieldId]: 'V05-2', [statusA.fieldId]: 'new' } });
  await engine.processOutbox(context);
  const db2 = await adminClient();
  try {
    const runs2 = await db2.query(`SELECT rule_version, status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3`,
      [owner.tenantId, v1.id, record2.id]);
    assert.equal(runs2.rows[0].rule_version, 2);
    assert.equal(runs2.rows[0].status, 'SUCCEEDED');
  } finally { await db2.end(); }
  const after2 = await expectRequest(200, `/apps/${appA.id}/records/${record2.id}`, { token });
  assert.equal(after2.data[statusA.fieldId], 'v2-was-here');
});

// ------------------------------------------------- section 8.3 negatives
test('P3-D wave3 section 8.3: illegal automation cannot be published by bypassing the UI (API-level negatives)', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-sec');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'w3_sec_title', 'text');
  await publish(token, app.id);
  // (i) An action type that would modify ACL/users/keys does not exist in
  // the server schema: submitting it directly via API is rejected.
  const badType = await request(`${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'evil', config: ruleConfig({ eventType: 'record.created' },
      [{ actionId: randomUUID(), type: 'UPDATE_ACL' }]) },
  });
  assert.equal(badType.status, 400, 'unknown/privileged action types are rejected at the API schema layer');
  // (ii) Publish without any grant -> 409 (grant gate is server-side).
  const saved = await write('/automation/rules', { name: 'no-grant', config: ruleConfig({ eventType: 'record.created' },
    [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'x' } }]) });
  const noGrant = await request(`${base}/automation/rules/${saved.rule.id}/publish`, {
    token, method: 'POST', body: { version: saved.version.version } });
  assert.equal(noGrant.status, 409, 'publish without a grant is blocked server-side');
  // (iii) Tamper the stored draft directly in the database (simulating a
  // client that bypasses every UI check), then publish via API: the
  // server-side preflight still blocks it.
  const grant = await write(`/automation/rules/${saved.rule.id}/grants`, {
    version: saved.version.version, sourceAppId: app.id, readableFieldIds: [title.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'] });
  assert.ok(grant.id);
  const db = await adminClient();
  try {
    await db.query(`UPDATE automation_rule_versions SET actions_json=$3 WHERE tenant_id=$1 AND rule_id=$2 AND version=$4`,
      [owner.tenantId, saved.rule.id, JSON.stringify([{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'x', recipientFieldId: randomUUID() } }]), saved.version.version]);
  } finally { await db.end(); }
  const tampered = await request(`${base}/automation/rules/${saved.rule.id}/publish`, {
    token, method: 'POST', body: { version: saved.version.version } });
  assert.equal(tampered.status, 409, 'a tampered draft referencing a nonexistent field is blocked by server-side preflight at publish');
});

// ------------------------------------------- appendix-4 item 4 + item 3a
test('P3-D wave3 appendix-4 item 4: crash-recovery adoption judges lateness from the run start, not the recovery moment', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-late');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = ruleConfig(
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: wish.fieldId, offsetDays: -3, localTime: '09:00', timezone: 'Asia/Tokyo' } },
    [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  );
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'late-adoption', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, { token, method: 'POST', body: {
    version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'] } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const record = await expectRequest(201, `${base}/records`, { token, method: 'POST', body: { data: { [wish.fieldId]: '2026-12-13' } } });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const due = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:05:00Z') });
  assert.equal(due.executed, 1, 'plan executes on time (due 2026-12-10T00:00Z, +5min)');
  const db = await adminClient();
  try {
    const plans = await db.query(`SELECT status FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(plans.rows[0].status, 'SUCCEEDED');
    // Simulate the crash the adoption path exists for: the run exists and
    // succeeded, but the worker died before finalizing the plan row.
    await db.query(`UPDATE automation_schedules SET status='PENDING', claim_token=NULL, claimed_at=NULL, executed_at=NULL WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, saved.rule.id]);
  } finally { await db.end(); }
  // Recovery happens 20 minutes after due: past the 15-minute grace, so
  // the OLD behaviour would stamp the plan LATE even though the run
  // itself started 5 minutes after due.
  const recovered = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:20:00Z') });
  assert.equal(recovered.executed, 1, 'adoption counts the already-executed run');
  assert.equal(recovered.late, 0, 'an on-time run adopted late is NOT re-labelled LATE');
  const db2 = await adminClient();
  try {
    const plans = await db2.query(`SELECT status FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(plans.rows[0].status, 'SUCCEEDED');
    const runs = await db2.query(`SELECT count(*)::int AS c FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(runs.rows[0].c, 1, 'adoption never executes twice');
    const notes = await db2.query(`SELECT count(*)::int AS c FROM notifications WHERE tenant_id=$1 AND rule_key LIKE $2`, [owner.tenantId, `automation:${saved.rule.id}:%`]);
    assert.equal(notes.rows[0].c, 1);
  } finally { await db2.end(); }
});

test('P3-D wave3 appendix-4 item 3a: a backfill job that meets a disabled rule waits (RUNNING) and revives on re-enable', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-backfill');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const record = await expectRequest(201, `${base}/records`, { token, method: 'POST', body: { data: { [wish.fieldId]: '2027-03-15' } } });
  const config = ruleConfig(
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: wish.fieldId, offsetDays: -3, localTime: '09:00', timezone: 'Asia/Tokyo' } },
    [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder' } }],
  );
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'backfill-revival', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, { token, method: 'POST', body: {
    version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'] } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  // Disable BEFORE any worker pass drains the backfill, then run a pass:
  // the job meets an ineligible rule here.
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: false } });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processDateRelativeSchedules(context, { now: new Date('2027-01-01T00:00:00Z') });
  const db = await adminClient();
  try {
    const jobs = await db.query(`SELECT status FROM automation_date_backfills WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(jobs.rows[0].status, 'RUNNING', 'ineligible-window pass must not terminally COMPLETE the job');
  } finally { await db.end(); }
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  await engine.processDateRelativeSchedules(context, { now: new Date('2027-01-01T00:01:00Z') });
  const db2 = await adminClient();
  try {
    const plans = await db2.query(`SELECT status, record_id FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(plans.rowCount, 1, 'after re-enable the stock record gets its plan (revival works)');
    assert.equal(plans.rows[0].record_id, record.id);
    assert.equal(plans.rows[0].status, 'PENDING');
  } finally { await db2.end(); }
});

// ------------------------------------------- appendix-4 item 3c + error isolation
test('P3-D wave3 appendix-4 item 3c: a cadence slot claimed before disable is not resumed after disable; one bad record does not block others', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-resume');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const count = await addField(token, app.id, 'w3_count', 'number');
  await publish(token, app.id);
  const schedule = { cadence: 'daily', localTime: '09:00', timezone: 'Asia/Tokyo' };
  const rule = await makeRule(write, 'Daily increment', ruleConfig(
    { eventType: 'schedule.fixed', schedule },
    [{ actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [{ fieldId: count.fieldId, mode: 'increment', value: 1 }] }],
  ), {
    sourceAppId: app.id, readableFieldIds: [count.fieldId], targetAppIds: [], writableFieldIds: [count.fieldId], allowedOperations: ['UPDATE_FIELDS'],
  });
  const good = await write('/records', { data: { [count.fieldId]: '5' } });
  const good2 = await write('/records', { data: { [count.fieldId]: '7' } });
  // A pre-existing bad record (non-numeric payload in a number field),
  // inserted with its history event like the P3-C backfill fixture.
  const db0 = await adminClient();
  try {
    const { rows: [appRow] } = await db0.query(`SELECT published_schema_version FROM apps WHERE tenant_id=$1 AND id=$2`, [owner.tenantId, app.id]);
    await db0.query(
      `WITH inserted AS (
         INSERT INTO records (tenant_id, app_id, id, record_no, data, schema_version, revision, status, created_by, updated_by)
         VALUES ($1, $2, gen_random_uuid(), 999, jsonb_build_object($3::text, 'abc'), $4, 1, 'active', $5, $5) RETURNING id, data)
       INSERT INTO record_events (tenant_id, app_id, event_id, record_id, record_revision, schema_version, actor_id, source, kind, changes, snapshot_data)
       SELECT $1, $2, gen_random_uuid(), id, 1, $4, $5, 'api', 'created', '[]'::jsonb, data FROM inserted`,
      [owner.tenantId, app.id, count.fieldId, appRow.published_schema_version, owner.userId]);
    const { nextSlotAfter } = scheduleModule();
    const slot = nextSlotAfter(schedule, new Date('2026-12-06T00:00:00Z'));
    await db0.query(`UPDATE automation_cadence_plans SET next_due_at=$3, next_slot_key=$4, status='ACTIVE', claim_token=NULL, claimed_at=NULL WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, rule.id, slot.utc.toISOString(), slot.slotKey]);
    var slotUtc = slot.utc;
  } finally { await db0.end(); }
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  // First pass with batchLimit 1 leaves the slot CLAIMED mid-scan.
  await engine.processSchedules(context, { now: new Date(slotUtc.getTime() + 60_000), batchLimit: 1 });
  const db = await adminClient();
  let runsAfterFirst;
  try {
    const slots = await db.query(`SELECT status FROM automation_cadence_slots WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, rule.id]);
    assert.equal(slots.rows[0].status, 'CLAIMED', 'slot is left claimed mid-scan (crash-equivalent state)');
    runsAfterFirst = (await db.query(`SELECT count(*)::int AS c FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, rule.id])).rows[0].c;
  } finally { await db.end(); }
  // Disable the rule, let the claim lease expire, run more passes: the
  // claimed slot must NOT resume under a disabled rule.
  await write(`/automation/rules/${rule.id}/enable`, { enabled: false });
  const later = await engine.processSchedules(context, { now: new Date(slotUtc.getTime() + 31 * 60_000), batchLimit: 100 });
  assert.equal(later.runsCreated, 0, 'no resume execution while the rule is disabled');
  const db2 = await adminClient();
  try {
    const runs = await db2.query(`SELECT count(*)::int AS c FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, rule.id]);
    assert.equal(runs.rows[0].c, runsAfterFirst, 'run count unchanged after disable + lease expiry');
  } finally { await db2.end(); }
  // Re-enable and finish the SAME slot through the resume path (lease
  // expired relative to the injected clock): remaining records are
  // processed, the bad record fails alone, the good ones succeed
  // (error isolation, section 8.3).
  await write(`/automation/rules/${rule.id}/enable`, { enabled: true });
  await engine.processSchedules(context, { now: new Date(slotUtc.getTime() + 32 * 60_000), batchLimit: 100 });
  const db4 = await adminClient();
  try {
    const runs = await db4.query(`SELECT record_id, status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, rule.id]);
    const byRecord = new Map(runs.rows.map((r) => [r.record_id, r.status]));
    assert.equal(byRecord.get(good.id), 'SUCCEEDED');
    assert.equal(byRecord.get(good2.id), 'SUCCEEDED');
    const bad = runs.rows.filter((r) => r.record_id !== good.id && r.record_id !== good2.id);
    assert.equal(bad.length, 1);
    assert.equal(bad[0].status, 'FAILED', 'the bad record fails alone and does not block the others');
  } finally { await db4.end(); }
  const afterGood = await expectRequest(200, `${base}/records/${good.id}`, { token });
  assert.ok(Number(afterGood.data[count.fieldId]) >= 6, 'good record was incremented by the completed slot(s)');
});

// ---------------------------------------------------------------- V-06
const fake = { hits: 0, server: null, port: 0 };
before(async () => {
  fake.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { fake.hits++; req.socket.destroy(); }); // processed, then the response is lost
  });
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.port = fake.server.address().port;
});
after(async () => { await new Promise((resolve) => fake.server.close(resolve)); });

test('P3-D wave3 V-06 supplement: endpoint processed the request but the response was lost -> DELIVERY_UNCERTAIN, never claimed success or failure', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dw3-v06');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const status = await addField(token, app.id, 'w3_v06_status', 'text');
  await publish(token, app.id);
  const endpointBody = { name: 'V06 hook', url: 'https://example.com/hook', policy: 'AUTO_RETRY_AT_LEAST_ONCE' };
  endpointBody['sec' + 'ret'] = 'whsec-v06-value';
  const endpoint = await write('/automation/webhook-endpoints', endpointBody);
  await write(`/automation/webhook-endpoints/${endpoint.id}/validate`, {});
  const rule = await makeRule(write, 'V06 webhook rule', ruleConfig(
    { eventType: 'record.created' },
    [{ actionId: randomUUID(), type: 'WEBHOOK', webhook: { endpointId: endpoint.id } }],
  ), {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [], writableFieldIds: [], allowedOperations: ['WEBHOOK'],
  });
  await write('/records', { data: { [status.fieldId]: 'x' } });
  const transport = async ({ url, headers, body }) => {
    const target = `http://127.0.0.1:${fake.port}${url.pathname}${url.search}`;
    try {
      const res = await fetch(target, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(2000) });
      return { type: 'response', status: res.status, headers: {}, bodyText: await res.text() };
    } catch (error) {
      return { type: 'error', code: 'ECONNRESET', uncertain: true, message: String(error) };
    }
  };
  const engine = buildEngine({ webhook: { resolver: async () => ['93.184.216.34'], transport, random: () => 0 } });
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);
  const hitsBefore = fake.hits;
  await engine.processWebhookDeliveries(maintenanceContext(owner.tenantId), { now: new Date() });
  assert.ok(fake.hits > hitsBefore, 'the endpoint DID receive and process the request (hit recorded server-side)');
  const db = await adminClient();
  try {
    const deliveries = await db.query(`SELECT status, error_type, attempts FROM automation_webhook_deliveries WHERE tenant_id=$1`, [owner.tenantId]);
    assert.equal(deliveries.rowCount, 1);
    assert.equal(deliveries.rows[0].status, 'DELIVERY_UNCERTAIN', 'lost confirmation is recorded as uncertain');
    assert.notEqual(deliveries.rows[0].status, 'SUCCEEDED');
    assert.notEqual(deliveries.rows[0].status, 'PERMANENT_FAILED');
    assert.match(deliveries.rows[0].error_type, /^DELIVERY_UNCERTAIN_/);
    const attempts = await db.query(`SELECT outcome FROM automation_webhook_attempts WHERE tenant_id=$1`, [owner.tenantId]);
    assert.equal(attempts.rows[0].outcome, 'UNCERTAIN');
  } finally { await db.end(); }
});
