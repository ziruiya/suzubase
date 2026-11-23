const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

// P3-C date-relative (T-3 lower half): per-record plans in
// automation_schedules -- generation on record events, invalidation on
// date change / delete / disable / revoke / version change, checkpointed
// backfill, due consumption with the brief 3.2 late rule (24 actual
// hours from due_at, UTC), aggregated MISSED alerting and lease-based
// crash recovery. Time is injected into processDateRelativeSchedules /
// processOutbox; plan due_at values are constructed, never the wall
// clock, wherever a boundary is asserted.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const maintenanceContext = (tenantId) => Object.freeze({ tenantId, userId: NIL_UUID });
const emptyGroup = { operator: 'and', groups: [] };
const emptyConditions = { eventSnapshot: emptyGroup, currentState: emptyGroup };

function buildEngine() {
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
  return new AutomationService(schema, authorization, records,
    new WorkflowRuntimeService(schema, authorization, planner));
}

function scheduleModule() {
  return require('../../../apps/api/dist/automation-schedule.js');
}

async function adminClient() {
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  return db;
}

const minus3At9Tokyo = (fieldId) => ({
  source: 'field', fieldId, offsetDays: -3, localTime: '09:00', timezone: 'Asia/Tokyo',
});

async function createDateRule({ dateRelative, appCode, extraField }) {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, appCode);
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  let extra;
  if (extraField) extra = await addField(token, app.id, extraField.code, extraField.type);
  await publish(token, app.id);
  const readableFieldIds = [wish.fieldId, ...(extra ? [extra.fieldId] : [])];
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Date rule', config },
  });
  const grant = await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds,
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, {
    token, method: 'POST', body: { enabled: true },
  });
  return { owner, token, app, base, wishField: wish.fieldId, extraField: extra?.fieldId, rule: saved.rule, version: saved.version.version, grant, config };
}

async function addRecord(token, base, data) {
  return expectRequest(201, `${base}/records`, { token, method: 'POST', body: { data } });
}

async function planRows(db, tenantId, ruleId) {
  const { rows } = await db.query(
    `SELECT * FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2 ORDER BY record_id, schedule_key`,
    [tenantId, ruleId]);
  return rows;
}

async function runRows(db, tenantId, ruleId) {
  const { rows } = await db.query(
    `SELECT * FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 ORDER BY record_id`, [tenantId, ruleId]);
  return rows;
}

async function notificationCount(db, tenantId, ruleKey) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND rule_key=$2`, [tenantId, ruleKey]);
  return rows[0].count;
}

test('P3-C date-relative: config validation rejects illegal source, offset, local time and timezone shapes', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-cfg');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'cfg_wish', 'date');
  await publish(token, app.id);
  const attempt = async (trigger) => request(`${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'bad', config: {
      schemaVersion: 1, trigger, conditions: emptyConditions,
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId] } }],
    } },
  });
  const bad = [
    { eventType: 'schedule.dateRelative' },
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', offsetDays: -3, localTime: '09:00', timezone: 'Asia/Tokyo' } },
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'createdAt', fieldId: wish.fieldId, offsetDays: 3, localTime: '09:00', timezone: 'Asia/Tokyo' } },
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: wish.fieldId, offsetDays: 4000, localTime: '09:00', timezone: 'Asia/Tokyo' } },
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: wish.fieldId, offsetDays: -3, localTime: '9am', timezone: 'Asia/Tokyo' } },
    { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: wish.fieldId, offsetDays: -3, localTime: '09:00', timezone: 'Not/AZone' } },
    { eventType: 'record.created', dateRelative: { source: 'createdAt', offsetDays: 3, localTime: '09:00', timezone: 'Asia/Tokyo' } },
  ];
  for (const trigger of bad) {
    const result = await attempt(trigger);
    assert.equal(result.status, 400, `trigger must be rejected: ${JSON.stringify(trigger)}`);
  }
});

test('P3-C date-relative: preflight blocks a date-relative rule whose source field is not a date', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-pre');
  const base = `/apps/${app.id}`;
  const text = await addField(token, app.id, 'pre_text', 'text');
  await publish(token, app.id);
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'draft', config: {
      schemaVersion: 1,
      trigger: { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: text.fieldId, offsetDays: -1, localTime: '09:00', timezone: 'Asia/Tokyo' } },
      conditions: emptyConditions,
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId] } }],
    } },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [text.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  const result = await request(`${base}/automation/rules/${saved.rule.id}/preflight`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.publishable, false);
  assert.ok(result.body.findings.some((finding) => finding.code === 'SCHEDULE_DATE_FIELD_TYPE_INVALID'),
    'preflight must surface SCHEDULE_DATE_FIELD_TYPE_INVALID');
});

test('P3-C date-relative: S-02 form -- wish_date minus 3 days at 09:00 tenant time generates the exact due_at and executes once', async () => {
  configureRuntime();
  const fixture = await (async () => {
    const owner = await provision({ isAdmin: true });
    const token = await login(owner);
    const app = await createApp(token, 'p3c-dr-s02');
    const base = `/apps/${app.id}`;
    const wish = await addField(token, app.id, 'wish_date', 'date');
    await publish(token, app.id);
    const config = {
      schemaVersion: 1,
      trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
      conditions: emptyConditions,
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
    };
    const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'S-02', config } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
      token, method: 'POST', body: {
        version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
        targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
      },
    });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
    return { owner, token, app, base, wishField: wish.fieldId, rule: saved.rule };
  })();
  const { owner, token, base, wishField, rule } = fixture;
  const record = await addRecord(token, base, { [wishField]: '2026-12-13' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    const plans = await planRows(db, owner.tenantId, rule.id);
    assert.equal(plans.length, 1, 'record creation generates exactly one plan');
    const plan = plans[0];
    assert.equal(plan.record_id, record.id);
    assert.equal(plan.source_date, '2026-12-13');
    assert.equal(plan.schedule_key, `daterel:field:${wishField}:-3d:09:00`);
    // 2026-12-13 minus 3 days = 2026-12-10, 09:00 Asia/Tokyo = 00:00 UTC.
    assert.equal(new Date(plan.due_at).toISOString(), '2026-12-10T00:00:00.000Z');
    assert.equal(plan.status, 'PENDING');
    // Idempotent regeneration: replaying the event pass changes nothing.
    await engine.processOutbox(context);
    assert.equal((await planRows(db, owner.tenantId, rule.id)).length, 1);
    // Not yet due: nothing fires.
    const early = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-09T23:00:00Z') });
    assert.equal(early.executed, 0);
    // Due: executes through the shared engine, exactly once.
    const due = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:05:00Z') });
    assert.equal(due.executed, 1);
    assert.equal(due.late, 0);
    const runs = await runRows(db, owner.tenantId, rule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'SUCCEEDED');
    assert.equal(runs[0].trigger_identity, `date-relative:${plan.schedule_key}:2026-12-13`, 'B1: trigger identity carries the source date');
    assert.equal(runs[0].record_id, record.id);
    const after = await planRows(db, owner.tenantId, rule.id);
    assert.equal(after[0].status, 'SUCCEEDED');
    assert.ok(after[0].executed_at, 'execution timestamp recorded on the plan');
    const { rows: notes } = await db.query(
      `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND payload->>'runId'=$2`,
      [owner.tenantId, runs[0].id]);
    assert.equal(notes[0].count, 1, 'the reminder notification was delivered exactly once');
    const again = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:06:00Z') });
    assert.equal(again.executed, 0, 'a consumed plan never re-executes');
    assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 1);
  } finally { await db.end(); }
});

test('P3-C date-relative: V-02 -- moving the date 12/10 to 12/20 kills the old due_at and reschedules', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-v02');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'V-02', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const record = await addRecord(token, base, { [wish.fieldId]: '2026-12-10' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    let plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans.length, 1);
    assert.equal(new Date(plans[0].due_at).toISOString(), '2026-12-07T00:00:00.000Z', 'original plan: 12/10 minus 3 days at 09:00 JST');
    const current = await expectRequest(200, `${base}/records/${record.id}`, { token });
    await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: current.revision, data: { [wish.fieldId]: '2026-12-20' } },
    });
    await engine.processOutbox(context);
    plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans.length, 1, 'the logical plan identity is stable: still one row');
    assert.equal(plans[0].source_date, '2026-12-20');
    assert.equal(new Date(plans[0].due_at).toISOString(), '2026-12-17T00:00:00.000Z', 'new plan follows the new date');
    assert.equal(plans[0].status, 'PENDING');
    const atOldDue = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-07T00:05:00Z') });
    assert.equal(atOldDue.executed, 0, 'the old due_at never triggers');
    assert.equal((await runRows(db, owner.tenantId, saved.rule.id)).length, 0);
    const atNewDue = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-17T00:05:00Z') });
    assert.equal(atNewDue.executed, 1, 'the rescheduled plan executes at the new due_at');
  } finally { await db.end(); }
});

test('P3-C date-relative: V-03 -- soft-deleting the record invalidates the plan and nothing is sent', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-v03');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'V-03', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const record = await addRecord(token, base, { [wish.fieldId]: '2026-12-13' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    assert.equal((await planRows(db, owner.tenantId, saved.rule.id)).length, 1);
    const beforeDelete = await expectRequest(200, `${base}/records/${record.id}`, { token });
    await expectRequest(200, `${base}/records/${record.id}`, { token, method: 'DELETE', body: { revision: beforeDelete.revision } });
    await engine.processOutbox(context);
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans[0].status, 'INVALIDATED');
    assert.equal(plans[0].invalidation_reason, 'record-deleted');
    const due = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:05:00Z') });
    assert.equal(due.executed, 0);
    assert.equal((await runRows(db, owner.tenantId, saved.rule.id)).length, 0, 'a deleted record produces no run');
    const { rows: notes } = await db.query(
      `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND record_id=$2`, [owner.tenantId, record.id]);
    assert.equal(notes[0].count, 0, 'a deleted record produces no notification');
  } finally { await db.end(); }
});

test('P3-C date-relative: 24h boundary -- 23:59 late executes as LATE, 24:01 is MISSED with zero execution', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-late');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'late', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const lateRecord = await addRecord(token, base, { [wish.fieldId]: '2027-02-01' });
  const missedRecord = await addRecord(token, base, { [wish.fieldId]: '2027-02-02' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    // Drain the backfill first: its plan sync would otherwise reconcile
    // the constructed due_at values below back to the computed ones.
    await engine.processDateRelativeSchedules(context, { now: new Date('2027-01-01T00:00:00Z') });
    const now = new Date('2027-01-15T12:00:00Z');
    // Constructed plan rows: due 23h59m ago (inside the window) and
    // 24h01m ago (outside it), relative to the injected now.
    await db.query(`UPDATE automation_schedules SET due_at=$3 WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$4`,
      [owner.tenantId, saved.rule.id, new Date(now.getTime() - (23 * 3600 + 59 * 60) * 1000).toISOString(), lateRecord.id]);
    await db.query(`UPDATE automation_schedules SET due_at=$3 WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$4`,
      [owner.tenantId, saved.rule.id, new Date(now.getTime() - (24 * 3600 + 1 * 60) * 1000).toISOString(), missedRecord.id]);
    const result = await engine.processDateRelativeSchedules(context, { now });
    assert.equal(result.late, 1, 'inside 24h: late execution');
    assert.equal(result.missed, 1, 'outside 24h: missed, no execution');
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    const byRecord = new Map(plans.map((plan) => [plan.record_id, plan]));
    assert.equal(byRecord.get(lateRecord.id).status, 'LATE');
    assert.equal(byRecord.get(missedRecord.id).status, 'MISSED');
    assert.equal(byRecord.get(missedRecord.id).executed_at, null);
    const runs = await runRows(db, owner.tenantId, saved.rule.id);
    assert.equal(runs.length, 1, 'only the late plan produced a run');
    assert.equal(runs[0].record_id, lateRecord.id);
    const { rows: notes } = await db.query(
      `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND record_id=$2`, [owner.tenantId, missedRecord.id]);
    assert.equal(notes[0].count, 0, 'MISSED sends no expired reminder');
  } finally { await db.end(); }
});

test('P3-C date-relative: backfill over 2000 stock records in injected small batches, checkpoint resume, no duplicates', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-backfill');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const db = await adminClient();
  try {
    const { rows: [appRow] } = await db.query(`SELECT published_schema_version FROM apps WHERE tenant_id=$1 AND id=$2`,
      [owner.tenantId, app.id]);
    // 2,000 stock records exist BEFORE the rule: bulk-inserted directly
    // (the API path would take minutes; the backfill contract is about
    // the stored population, not about how it arrived).
    // Each stock record also gets its 'created' history event, exactly
    // as if it had arrived through the API: the fixture must stay a
    // history-consistent population (the audit tool samples records
    // against their events).
    await db.query(
      `WITH inserted AS (
         INSERT INTO records (tenant_id, app_id, id, record_no, data, schema_version, revision, status, created_by, updated_by)
         SELECT $1, $2, gen_random_uuid(), n, jsonb_build_object($3::text, '2027-03-15'), $4, 1, 'active', $5, $5
         FROM generate_series(1, 2000) AS n
         RETURNING id, data
       )
       INSERT INTO record_events (tenant_id, app_id, event_id, record_id, record_revision, schema_version, actor_id, source, kind, changes, snapshot_data)
       SELECT $1, $2, gen_random_uuid(), id, 1, $4, $5, 'api', 'created', '[]'::jsonb, data FROM inserted`,
      [owner.tenantId, app.id, wish.fieldId, appRow.published_schema_version, owner.userId]);
    const config = {
      schemaVersion: 1,
      trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
      conditions: emptyConditions,
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
    };
    const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'backfill', config } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
      token, method: 'POST', body: {
        version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
        targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
      },
    });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    const now = new Date('2027-01-01T00:00:00Z'); // long before any due_at: backfill must not execute
    const jobRow = async () => {
      const { rows } = await db.query(
        `SELECT * FROM automation_date_backfills WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
      return rows[0];
    };
    let job = await jobRow();
    assert.ok(job, 'publishing/enabling a date-relative rule creates its backfill job');
    assert.equal(job.status, 'RUNNING');
    const pass1 = await engine.processDateRelativeSchedules(context, { now, batchLimit: 700 });
    assert.equal(pass1.backfilledRecords, 700);
    assert.equal(pass1.executed, 0, 'backfill never executes');
    job = await jobRow();
    assert.equal(job.status, 'RUNNING', 'job survives an interrupted (partial) pass');
    assert.equal(job.processed_count, 700);
    assert.ok(job.cursor_record_id, 'checkpoint cursor persisted');
    // Simulated interruption: a fresh engine instance resumes from the
    // persisted checkpoint, not from the beginning.
    const engine2 = buildEngine();
    const pass2 = await engine2.processDateRelativeSchedules(context, { now, batchLimit: 700 });
    assert.equal(pass2.backfilledRecords, 700);
    const pass3 = await engine2.processDateRelativeSchedules(context, { now, batchLimit: 700 });
    assert.equal(pass3.backfilledRecords, 600);
    job = await jobRow();
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.processed_count, 2000);
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans.length, 2000, 'one plan per stock record');
    assert.equal(new Set(plans.map((plan) => plan.record_id)).size, 2000, 'no duplicate plans');
    assert.ok(plans.every((plan) => plan.status === 'PENDING' && new Date(plan.due_at).toISOString() === '2027-03-12T00:00:00.000Z'));
    const pass4 = await engine2.processDateRelativeSchedules(context, { now, batchLimit: 700 });
    assert.equal(pass4.backfilledRecords, 0);
    assert.equal((await planRows(db, owner.tenantId, saved.rule.id)).length, 2000, 'totals stay stable after completion');
    assert.equal((await runRows(db, owner.tenantId, saved.rule.id)).length, 0, 'backfill produced no runs');
  } finally { await db.end(); }
});

test('P3-C date-relative: disable, grant revoke and version supersede each invalidate plans and block execution', async () => {
  configureRuntime();
  const setup = async (appCode) => {
    const owner = await provision({ isAdmin: true });
    const token = await login(owner);
    const app = await createApp(token, appCode);
    const base = `/apps/${app.id}`;
    const wish = await addField(token, app.id, 'wish_date', 'date');
    await publish(token, app.id);
    const config = {
      schemaVersion: 1,
      trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
      conditions: emptyConditions,
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
    };
    const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: appCode, config } });
    const grant = await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
      token, method: 'POST', body: {
        version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
        targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
      },
    });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
    const record = await addRecord(token, base, { [wish.fieldId]: '2026-12-13' });
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    await engine.processOutbox(context);
    return { owner, token, app, base, wishField: wish.fieldId, rule: saved.rule, version: saved.version.version, grant, record, engine, context, config };
  };
  const dueNow = new Date('2026-12-10T00:05:00Z');
  // Disable.
  {
    const s = await setup('p3c-dr-disable');
    const db = await adminClient();
    try {
      assert.equal((await planRows(db, s.owner.tenantId, s.rule.id))[0].status, 'PENDING');
      await expectRequest(201, `${s.base}/automation/rules/${s.rule.id}/enable`, { token: s.token, method: 'POST', body: { enabled: false } });
      const plans = await planRows(db, s.owner.tenantId, s.rule.id);
      assert.equal(plans[0].status, 'INVALIDATED');
      assert.equal(plans[0].invalidation_reason, 'rule-disabled');
      const result = await s.engine.processDateRelativeSchedules(s.context, { now: dueNow });
      assert.equal(result.executed, 0);
      assert.equal((await runRows(db, s.owner.tenantId, s.rule.id)).length, 0);
    } finally { await db.end(); }
  }
  // Grant revoke.
  {
    const s = await setup('p3c-dr-revoke');
    const db = await adminClient();
    try {
      await expectRequest(201, `${s.base}/automation/rules/${s.rule.id}/grants/${s.grant.id}/revoke`, { token: s.token, method: 'POST' });
      const plans = await planRows(db, s.owner.tenantId, s.rule.id);
      assert.equal(plans[0].status, 'INVALIDATED');
      assert.equal(plans[0].invalidation_reason, 'grant-revoked');
      const result = await s.engine.processDateRelativeSchedules(s.context, { now: dueNow });
      assert.equal(result.executed, 0);
      assert.equal((await runRows(db, s.owner.tenantId, s.rule.id)).length, 0);
    } finally { await db.end(); }
  }
  // Version supersede: publish v2 (different offset) -- v1 plans die and
  // never fire; v2 backfills its own plan which fires at its own due.
  {
    const s = await setup('p3c-dr-supersede');
    const db = await adminClient();
    try {
      const v2Config = {
        ...s.config,
        trigger: { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: s.wishField, offsetDays: -1, localTime: '09:00', timezone: 'Asia/Tokyo' } },
      };
      const draft = await expectRequest(200, `${s.base}/automation/rules/${s.rule.id}/draft`, {
        token: s.token, method: 'PUT', body: { config: v2Config },
      });
      await expectRequest(201, `${s.base}/automation/rules/${s.rule.id}/grants`, {
        token: s.token, method: 'POST', body: {
          version: draft.version, sourceAppId: s.app.id, readableFieldIds: [s.wishField],
          targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
        },
      });
      await expectRequest(201, `${s.base}/automation/rules/${s.rule.id}/publish`, { token: s.token, method: 'POST', body: { version: draft.version } });
      const plans = await planRows(db, s.owner.tenantId, s.rule.id);
      const v1 = plans.filter((plan) => plan.rule_version === s.version);
      assert.equal(v1.length, 1);
      assert.equal(v1[0].status, 'INVALIDATED');
      assert.equal(v1[0].invalidation_reason, 'version-superseded');
      await expectRequest(201, `${s.base}/automation/rules/${s.rule.id}/enable`, { token: s.token, method: 'POST', body: { enabled: true } });
      const result = await s.engine.processDateRelativeSchedules(s.context, { now: dueNow });
      assert.equal(result.executed, 0, 'at the v1 due instant nothing fires: v1 is dead, v2 is not due yet');
      const atV2 = await s.engine.processDateRelativeSchedules(s.context, { now: new Date('2026-12-12T00:05:00Z') });
      assert.equal(atV2.executed, 1, 'the v2 plan (minus 1 day) fires at its own due_at');
      const runs = await runRows(db, s.owner.tenantId, s.rule.id);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].rule_version, draft.version);
    } finally { await db.end(); }
  }
});

test('P3-C date-relative: concurrent workers claim a due plan exactly once; a dead worker lease recovers without duplicates', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-concurrency');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'conc', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const recordA = await addRecord(token, base, { [wish.fieldId]: '2026-12-13' });
  const recordB = await addRecord(token, base, { [wish.fieldId]: '2026-12-14' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    // Concurrency: two independent engines race the same due plan.
    const now = new Date('2026-12-10T00:05:00Z');
    const [r1, r2] = await Promise.all([
      buildEngine().processDateRelativeSchedules(context, { now }),
      buildEngine().processDateRelativeSchedules(context, { now }),
    ]);
    assert.equal(r1.executed + r2.executed, 1, 'exactly one worker executes the due plan');
    assert.equal((await runRows(db, owner.tenantId, saved.rule.id)).length, 1);
    void recordA;
    // Crash recovery: plan B is claimed by a worker that dies (claim
    // planted, no execution). Inside the lease nothing happens; after
    // the lease expires the plan is reclaimed and executed once.
    await db.query(
      `UPDATE automation_schedules SET claim_token=$3, claimed_at=$4 WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$5`,
      [owner.tenantId, saved.rule.id, randomUUID(), new Date('2026-12-11T00:00:00Z').toISOString(), recordB.id]);
    const duringLease = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-11T00:04:00Z') });
    assert.equal(duringLease.executed, 0, 'a live claim blocks other workers');
    const afterLease = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-11T00:06:00Z') });
    assert.equal(afterLease.executed, 1, 'the expired lease is reclaimed and the plan executes');
    const runs = await runRows(db, owner.tenantId, saved.rule.id);
    assert.equal(runs.length, 2, 'no duplicate run for the recovered plan');
    assert.equal(runs.filter((run) => run.record_id === recordB.id).length, 1);
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans.find((plan) => plan.record_id === recordB.id).status, 'SUCCEEDED');
  } finally { await db.end(); }
});

test('P3-C date-relative: mass MISSED produces one aggregated SYSTEM alert, throttled per day', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-missed-alert');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'missed', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  for (const day of ['2026-12-13', '2026-12-14', '2026-12-15']) {
    await addRecord(token, base, { [wish.fieldId]: day });
  }
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    // All three plans are >24h past due at the injected now.
    const result = await engine.processDateRelativeSchedules(context, {
      now: new Date('2026-12-20T00:00:00Z'), missedAlertThreshold: 2,
    });
    assert.equal(result.missed, 3);
    assert.equal(result.executed, 0);
    assert.equal(await notificationCount(db, owner.tenantId, 'AUTOMATION_SCHEDULE_MISSED'), 1,
      'exactly one aggregated admin notification, not one per missed plan');
    const { rows: audits } = await db.query(
      `SELECT * FROM automation_audit_events WHERE tenant_id=$1 AND action='SCHEDULE_MISSED_ALERT'`, [owner.tenantId]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].details.missedCount, 3);
    assert.equal(audits[0].actor_type, 'SYSTEM');
    // A second wave of misses inside the throttle window stays silent.
    await addRecord(token, base, { [wish.fieldId]: '2026-12-16' });
    await engine.processOutbox(context);
    const second = await engine.processDateRelativeSchedules(context, {
      now: new Date('2026-12-20T01:00:00Z'), missedAlertThreshold: 1,
    });
    assert.equal(second.missed, 1);
    assert.equal(await notificationCount(db, owner.tenantId, 'AUTOMATION_SCHEDULE_MISSED'), 1, 'alert is throttled');
  } finally { await db.end(); }
});

test('P3-C date-relative: createdAt source plans from the record creation date in the tenant timezone', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-created');
  const base = `/apps/${app.id}`;
  const note = await addField(token, app.id, 'note', 'text');
  await publish(token, app.id);
  const relative = { source: 'createdAt', offsetDays: 7, localTime: '09:00', timezone: 'Asia/Tokyo' };
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: relative },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Follow-up', body: 'one week on' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'created', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const record = await addRecord(token, base, { [note.fieldId]: 'hello' });
  const engine = buildEngine();
  await engine.processOutbox(maintenanceContext(owner.tenantId));
  const db = await adminClient();
  try {
    const { isoDateInZone, dateRelativeDueAt } = scheduleModule();
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans.length, 1);
    const expectedSource = isoDateInZone(new Date(record.createdAt), 'Asia/Tokyo');
    assert.equal(plans[0].source_date, expectedSource);
    assert.equal(plans[0].schedule_key, 'daterel:createdAt:+7d:09:00');
    const expected = dateRelativeDueAt(expectedSource, relative);
    assert.equal(new Date(plans[0].due_at).toISOString(), expected.dueAt.toISOString());
  } finally { await db.end(); }
});

test('P3-C date-relative: B1 regression -- a terminal plan reopened by a date change executes a NEW run and notifies again', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-b1-reopen');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'B1 reopen', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const record = await addRecord(token, base, { [wish.fieldId]: '2026-12-13' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    const notesFor = async (runId) => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND payload->>'runId'=$2`,
        [owner.tenantId, runId]);
      return rows[0].count;
    };
    // First source date executes once: plan SUCCEEDED, one run, one notification.
    const first = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:05:00Z') });
    assert.equal(first.executed, 1);
    let runs = await runRows(db, owner.tenantId, saved.rule.id);
    assert.equal(runs.length, 1);
    const firstRun = runs[0];
    assert.equal(await notesFor(firstRun.id), 1);
    let plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans[0].status, 'SUCCEEDED');
    // Move the source date: the terminal plan reopens for the new date.
    const current = await expectRequest(200, `${base}/records/${record.id}`, { token });
    await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: current.revision, data: { [wish.fieldId]: '2026-12-20' } },
    });
    await engine.processOutbox(context);
    plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans.length, 1, 'still one logical plan row');
    assert.equal(plans[0].status, 'PENDING', 'terminal plan reopens when the source date moves');
    assert.equal(plans[0].source_date, '2026-12-20');
    assert.equal(new Date(plans[0].due_at).toISOString(), '2026-12-17T00:00:00.000Z');
    // New due date: a genuinely new run must execute and notify. Before
    // the B1 fix the run idempotency key did not contain the source
    // date, so the consumer adopted the OLD run and silently swallowed
    // the new reminder (runs stayed 1, no second notification).
    const second = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-17T00:05:00Z') });
    assert.equal(second.executed, 1);
    runs = await runRows(db, owner.tenantId, saved.rule.id);
    assert.equal(runs.length, 2, 'B1: the new source date must produce a second run, not adopt the old one');
    const secondRun = runs.find((run) => run.id !== firstRun.id);
    assert.ok(secondRun, 'second run is a distinct row');
    assert.notEqual(secondRun.idempotency_key, firstRun.idempotency_key);
    assert.ok(secondRun.idempotency_key.includes('2026-12-20'), 'run identity carries the source date');
    assert.equal(await notesFor(secondRun.id), 1, 'B1: the reminder for the new date is actually sent');
    assert.equal(await notesFor(firstRun.id), 1, 'the first notification is not duplicated');
    plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans[0].status, 'SUCCEEDED');
  } finally { await db.end(); }
});

test('P3-C date-relative: B1 regression -- replay with the SAME source date adopts the existing run (crash recovery, no duplicate execution or notification)', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-b1-replay');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'B1 replay', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const record = await addRecord(token, base, { [wish.fieldId]: '2026-12-13' });
  void record;
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    const notesFor = async (runId) => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND payload->>'runId'=$2`,
        [owner.tenantId, runId]);
      return rows[0].count;
    };
    const first = await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:05:00Z') });
    assert.equal(first.executed, 1);
    const runs = await runRows(db, owner.tenantId, saved.rule.id);
    assert.equal(runs.length, 1);
    assert.equal(await notesFor(runs[0].id), 1);
    // Simulate a worker that created the run (and its notification) but
    // died before finalizing the plan: rewind the plan row to its
    // pre-finalize state. The source date is unchanged, so the replay
    // must adopt the existing run -- never execute or notify twice.
    await db.query(
      `UPDATE automation_schedules SET status='PENDING', claim_token=NULL, claimed_at=NULL, executed_at=NULL
       WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, saved.rule.id]);
    await engine.processDateRelativeSchedules(context, { now: new Date('2026-12-10T00:06:00Z') });
    const afterRuns = await runRows(db, owner.tenantId, saved.rule.id);
    assert.equal(afterRuns.length, 1, 'same source date replay adopts the old run: no new run');
    assert.equal(afterRuns[0].id, runs[0].id);
    assert.equal(await notesFor(runs[0].id), 1, 'notification is not duplicated on replay');
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    assert.equal(plans[0].status, 'SUCCEEDED', 'adoption finalizes the plan from the old run outcome');
  } finally { await db.end(); }
});

test('P3-C date-relative: C1 grace boundary -- due consumed 14 minutes late is SUCCEEDED, 16 minutes late is LATE (injected grace)', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-c1-grace');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.dateRelative', dateRelative: minus3At9Tokyo(wish.fieldId) },
    conditions: emptyConditions,
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'C1 grace', config } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });
  const onTimeRecord = await addRecord(token, base, { [wish.fieldId]: '2027-02-01' });
  const lateRecord = await addRecord(token, base, { [wish.fieldId]: '2027-02-01' });
  const engine = buildEngine();
  const context = maintenanceContext(owner.tenantId);
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    // Drain the backfill first so its plan sync cannot reconcile the
    // constructed due_at values below back to the computed ones.
    await engine.processDateRelativeSchedules(context, { now: new Date('2027-01-01T00:00:00Z') });
    const now = new Date('2027-01-15T12:00:00Z');
    // Constructed plan rows: due 14 minutes ago (inside the injected
    // 15-minute on-time grace) and 16 minutes ago (outside it), both
    // far inside the 24h late window.
    await db.query(`UPDATE automation_schedules SET due_at=$3 WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$4`,
      [owner.tenantId, saved.rule.id, new Date(now.getTime() - 14 * 60_000).toISOString(), onTimeRecord.id]);
    await db.query(`UPDATE automation_schedules SET due_at=$3 WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$4`,
      [owner.tenantId, saved.rule.id, new Date(now.getTime() - 16 * 60_000).toISOString(), lateRecord.id]);
    const result = await engine.processDateRelativeSchedules(context, { now, onTimeGraceMs: 15 * 60_000 });
    assert.equal(result.executed, 2, 'both plans execute inside the 24h late window');
    assert.equal(result.late, 1, 'C1: only the 16-minute plan counts as late');
    const plans = await planRows(db, owner.tenantId, saved.rule.id);
    const byRecord = new Map(plans.map((plan) => [plan.record_id, plan]));
    assert.equal(byRecord.get(onTimeRecord.id).status, 'SUCCEEDED', 'C1: 14 minutes late executes as on-time SUCCEEDED');
    assert.equal(byRecord.get(lateRecord.id).status, 'LATE', 'C1: 16 minutes late executes as LATE');
    assert.equal((await runRows(db, owner.tenantId, saved.rule.id)).length, 2);
  } finally { await db.end(); }
});
