const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

// P3-C fixed cadence (T-3 upper half): persistent cadence plans, stable
// slot keys, atomic claiming, missed-run policy, DST/month-end semantics,
// crash recovery and batched continuation. Time is never taken from the
// wall clock for scheduling decisions: tests construct due plan rows
// directly and drive AutomationService.processSchedules with an injected
// `now`, matching the brief's controllable-clock requirement.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const maintenanceContext = (tenantId) => Object.freeze({ tenantId, userId: NIL_UUID });
const emptyGroup = { operator: 'and', groups: [] };
const eqGroup = (fieldId, value) => ({ operator: 'and', groups: [{ conditions: [{ fieldId, operator: 'eq', value }] }] });

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

async function createScheduleRule({ schedule, conditions, appCode }) {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, appCode);
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'sch_status', 'text');
  await publish(token, app.id);
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'schedule.fixed', schedule },
    conditions: conditions ?? { eventSnapshot: emptyGroup, currentState: emptyGroup },
    actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Scheduled', body: 'slot fired' } }],
  };
  if (conditions) config.conditions = conditions(status.fieldId);
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Cadence rule', config },
  });
  const grant = await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, {
    token, method: 'POST', body: { enabled: true },
  });
  return { owner, token, app, base, statusField: status.fieldId, rule: saved.rule, version: saved.version.version, grant };
}

async function addRecord(token, base, fieldId, value) {
  return expectRequest(201, `${base}/records`, { token, method: 'POST', body: { data: { [fieldId]: value } } });
}

// Point the rule's cadence plan at a chosen slot (constructed due row).
async function setPlanDue(db, tenantId, ruleId, slot) {
  await db.query(
    `UPDATE automation_cadence_plans SET next_due_at=$3, next_slot_key=$4, status='ACTIVE',
       claim_token=NULL, claimed_at=NULL WHERE tenant_id=$1 AND rule_id=$2`,
    [tenantId, ruleId, slot.utc.toISOString(), slot.slotKey]);
}

async function planRow(db, tenantId, ruleId) {
  const { rows } = await db.query(
    `SELECT * FROM automation_cadence_plans WHERE tenant_id=$1 AND rule_id=$2`, [tenantId, ruleId]);
  return rows[0];
}

async function slotRows(db, tenantId, ruleId) {
  const { rows } = await db.query(
    `SELECT * FROM automation_cadence_slots WHERE tenant_id=$1 AND rule_id=$2 ORDER BY scheduled_for, slot_key`,
    [tenantId, ruleId]);
  return rows;
}

async function runRows(db, tenantId, ruleId) {
  const { rows } = await db.query(
    `SELECT * FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 ORDER BY record_id`, [tenantId, ruleId]);
  return rows;
}

const dailyTokyo = { cadence: 'daily', localTime: '09:00', timezone: 'Asia/Tokyo' };

test('P3-C cadence: config validation rejects illegal cadence, local time, timezone, weekdays and month day', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-sch-cfg');
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'cfg_status', 'text');
  await publish(token, app.id);
  const attempt = async (schedule) => request(`${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'bad', config: {
      schemaVersion: 1, trigger: { eventType: 'schedule.fixed', schedule },
      conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup },
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId] } }],
    } },
  });
  for (const schedule of [
    { cadence: 'daily', localTime: '09:00', timezone: 'Not/AZone' },
    { cadence: 'daily', localTime: '9am', timezone: 'Asia/Tokyo' },
    { cadence: 'daily', localTime: '24:00', timezone: 'Asia/Tokyo' },
    { cadence: 'weekly', localTime: '09:00', timezone: 'Asia/Tokyo' },
    { cadence: 'weekly', localTime: '09:00', timezone: 'Asia/Tokyo', weekdays: [1, 1] },
    { cadence: 'monthly', localTime: '09:00', timezone: 'Asia/Tokyo' },
    { cadence: 'monthly', localTime: '09:00', timezone: 'Asia/Tokyo', monthDay: 32 },
    { cadence: 'hourly', localTime: '09:00', timezone: 'Asia/Tokyo' },
  ]) {
    const result = await attempt(schedule);
    assert.equal(result.status, 400, `schedule must be rejected: ${JSON.stringify(schedule)}`);
  }
  void status;
});

test('P3-C cadence: preflight blocks a stored version whose timezone was tampered invalid', async () => {
  configureRuntime();
  // Draft version (published versions are immutable, so the tamper target
  // is a not-yet-published draft -- exactly what preflight gates).
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-sch-pre');
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'pre_status', 'text');
  await publish(token, app.id);
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'draft', config: {
      schemaVersion: 1, trigger: { eventType: 'schedule.fixed', schedule: dailyTokyo },
      conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup },
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId] } }],
    } },
  });
  const rule = saved.rule, version = saved.version.version;
  await expectRequest(201, `${base}/automation/rules/${rule.id}/grants`, {
    token, method: 'POST', body: {
      version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  const db = await adminClient();
  try {
    await db.query(
      `UPDATE automation_rule_versions SET trigger_json = jsonb_set(trigger_json, '{schedule,timezone}', '"Not/AZone"')
       WHERE tenant_id=$1 AND rule_id=$2 AND version=$3`, [owner.tenantId, rule.id, version]);
    const result = await request(`${base}/automation/rules/${rule.id}/preflight`, {
      token, method: 'POST', body: { version },
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.publishable, false);
    assert.ok(result.body.findings.some((finding) => finding.code === 'SCHEDULE_TIMEZONE_INVALID'),
      'preflight must surface SCHEDULE_TIMEZONE_INVALID');
  } finally { await db.end(); }
});

test('P3-C cadence: on-time slot executes matching records once, shares one batch, and a duplicate scan creates nothing', async () => {
  configureRuntime();
  const conditions = (fieldId) => ({ eventSnapshot: emptyGroup, currentState: eqGroup(fieldId, 'open') });
  const { owner, token, base, statusField, rule } = await createScheduleRule({
    schedule: dailyTokyo, conditions, appCode: 'p3c-sch-ontime',
  });
  const openA = await addRecord(token, base, statusField, 'open');
  const openB = await addRecord(token, base, statusField, 'open');
  await addRecord(token, base, statusField, 'closed');
  const { nextSlotAfter } = scheduleModule();
  const slot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
  const db = await adminClient();
  try {
    const plan = await planRow(db, owner.tenantId, rule.id);
    assert.ok(plan, 'enabling a fixed-schedule rule creates its cadence plan');
    assert.equal(plan.timezone, 'Asia/Tokyo');
    assert.equal(plan.cadence, 'daily');
    assert.equal(plan.local_time, '09:00');
    assert.equal(plan.missed_run_policy, 'skip');
    await setPlanDue(db, owner.tenantId, rule.id, slot);
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    const now = new Date(slot.utc.getTime() + 2 * 60_000);
    const first = await engine.processSchedules(context, { now });
    assert.equal(first.runsCreated, 2, 'only condition-matching records produce runs');
    const runs = await runRows(db, owner.tenantId, rule.id);
    assert.equal(runs.length, 2);
    assert.deepEqual(new Set(runs.map((run) => run.record_id)), new Set([openA.id, openB.id]));
    assert.ok(runs.every((run) => run.status === 'SUCCEEDED'));
    assert.ok(runs.every((run) => run.trigger_identity === `schedule:${slot.slotKey}`));
    assert.equal(new Set(runs.map((run) => run.batch_id)).size, 1, 'one slot = one shared batch_id');
    const slots = await slotRows(db, owner.tenantId, rule.id);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].status, 'COMPLETED');
    const after = await planRow(db, owner.tenantId, rule.id);
    assert.equal(after.last_completed_slot, slot.slotKey);
    assert.ok(new Date(after.next_due_at) > now, 'plan advanced to the next period');
    // Duplicate scan / duplicate claim of the same period: nothing new.
    const second = await engine.processSchedules(context, { now });
    assert.equal(second.runsCreated, 0);
    assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 2, 'same period never produces a second batch');
  } finally { await db.end(); }
});

test('P3-C cadence: missed periods default to skip -- no catch-up runs, plan advances, only the next live cycle executes', async () => {
  configureRuntime();
  const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule: dailyTokyo, appCode: 'p3c-sch-skip' });
  await addRecord(token, base, statusField, 'open');
  const { nextSlotAfter } = scheduleModule();
  const firstSlot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, firstSlot);
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    // Worker down across >= 2 periods: recovery happens 2h after the
    // fourth consecutive daily slot became due (all four are "missed").
    const recovery = new Date(firstSlot.utc.getTime() + 3 * 86_400_000 + 2 * 3_600_000);
    const result = await engine.processSchedules(context, { now: recovery });
    assert.equal(result.runsCreated, 0, 'default policy never runs missed periods');
    const slots = await slotRows(db, owner.tenantId, rule.id);
    assert.equal(slots.length, 4);
    assert.ok(slots.every((slot) => slot.status === 'SKIPPED_MISSED'));
    assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 0);
    const plan = await planRow(db, owner.tenantId, rule.id);
    assert.ok(new Date(plan.next_due_at) > recovery, 'plan advanced to the next valid period');
    // The next live cycle then executes normally.
    const live = await engine.processSchedules(context, { now: new Date(new Date(plan.next_due_at).getTime() + 60_000) });
    assert.equal(live.runsCreated, 1, 'only the latest (live) cycle executes');
    const runs = await runRows(db, owner.tenantId, rule.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger_identity, `schedule:${plan.next_slot_key}`);
  } finally { await db.end(); }
});

test('P3-C cadence: catch_up_latest runs exactly the most recent missed period, marked as catch-up', async () => {
  configureRuntime();
  const schedule = { ...dailyTokyo, missedRunPolicy: 'catch_up_latest' };
  const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule, appCode: 'p3c-sch-catchup' });
  await addRecord(token, base, statusField, 'open');
  const { nextSlotAfter } = scheduleModule();
  const firstSlot = nextSlotAfter(schedule, new Date('2026-06-01T00:00:00Z'));
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, firstSlot);
    const engine = buildEngine();
    const recovery = new Date(firstSlot.utc.getTime() + 3 * 86_400_000 + 2 * 3_600_000);
    const result = await engine.processSchedules(maintenanceContext(owner.tenantId), { now: recovery });
    assert.equal(result.runsCreated, 1, 'exactly one missed period is caught up');
    const runs = await runRows(db, owner.tenantId, rule.id);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].trigger_identity.endsWith(':catchup'), 'catch-up runs are identifiable');
    const slots = await slotRows(db, owner.tenantId, rule.id);
    const completed = slots.filter((slot) => slot.status === 'COMPLETED');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].is_catchup, true);
    assert.equal(runs[0].trigger_identity, `schedule:${completed[0].slot_key}:catchup`);
    assert.equal(slots.filter((slot) => slot.status === 'SKIPPED_MISSED').length, 3,
      'older missed periods stay skipped');
  } finally { await db.end(); }
});

test('P3-C cadence: monthly day 31 lands on the last day of February and fires exactly once', async () => {
  configureRuntime();
  const schedule = { cadence: 'monthly', monthDay: 31, localTime: '09:00', timezone: 'Asia/Tokyo' };
  const { nextSlotAfter, slotForLocalDate } = scheduleModule();
  const feb = nextSlotAfter(schedule, new Date('2026-02-01T00:00:00Z'));
  assert.equal(feb.localDate, '2026-02-28', 'month-end rule: missing 31st clamps to the last day');
  assert.equal(feb.slotKey, 'monthly:2026-02-28');
  assert.equal(slotForLocalDate(schedule, 2026, 2, 28).slotKey, feb.slotKey);
  const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule, appCode: 'p3c-sch-monthend' });
  await addRecord(token, base, statusField, 'open');
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, feb);
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    const now = new Date(feb.utc.getTime() + 2 * 60_000);
    assert.equal((await engine.processSchedules(context, { now })).runsCreated, 1);
    assert.equal((await engine.processSchedules(context, { now })).runsCreated, 0, 'February slot fires once only');
    const plan = await planRow(db, owner.tenantId, rule.id);
    assert.equal(plan.next_slot_key, 'monthly:2026-03-31');
  } finally { await db.end(); }
});

test('P3-C cadence: DST gap slot is skipped with SKIPPED_NONEXISTENT_TIME and the fold slot executes only at its first occurrence', async () => {
  configureRuntime();
  const schedule = { cadence: 'daily', localTime: '02:30', timezone: 'America/New_York' };
  const { slotForLocalDate, localTimeToUtcCandidates } = scheduleModule();
  const gap = slotForLocalDate(schedule, 2026, 3, 8); // 2026-03-08 02:30 does not exist in New York
  assert.equal(gap.exists, false);
  const foldCandidates = localTimeToUtcCandidates({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
  assert.equal(foldCandidates.length, 2, 'ambiguous local time has two UTC candidates');
  const foldSchedule = { cadence: 'daily', localTime: '01:30', timezone: 'America/New_York' };
  const fold = slotForLocalDate(foldSchedule, 2026, 11, 1);
  assert.equal(fold.utc.getTime(), foldCandidates[0].getTime(), 'fold slot pins the first occurrence');

  const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule, appCode: 'p3c-sch-dst' });
  await addRecord(token, base, statusField, 'open');
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, gap);
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    const result = await engine.processSchedules(context, { now: new Date(gap.utc.getTime() + 2 * 60_000) });
    assert.equal(result.runsCreated, 0, 'nonexistent local time never executes');
    const slots = await slotRows(db, owner.tenantId, rule.id);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].status, 'SKIPPED_NONEXISTENT_TIME');
    assert.equal(slots[0].slot_key, 'daily:2026-03-08');
    const plan = await planRow(db, owner.tenantId, rule.id);
    assert.equal(plan.next_slot_key, 'daily:2026-03-09', 'plan moves past the skipped slot');
  } finally { await db.end(); }

  const second = await createScheduleRule({ schedule: foldSchedule, appCode: 'p3c-sch-fold' });
  await addRecord(second.token, second.base, second.statusField, 'open');
  const db2 = await adminClient();
  try {
    await setPlanDue(db2, second.owner.tenantId, second.rule.id, fold);
    const engine = buildEngine();
    const context = maintenanceContext(second.owner.tenantId);
    const now = new Date(fold.utc.getTime() + 2 * 60_000);
    assert.equal((await engine.processSchedules(context, { now })).runsCreated, 1);
    // Scanning again at the second occurrence must not fire again.
    const secondOccurrence = new Date(foldCandidates[1].getTime() + 2 * 60_000);
    assert.equal((await engine.processSchedules(context, { now: secondOccurrence })).runsCreated, 0,
      'repeated local time executes only at its first occurrence');
    assert.equal((await runRows(db2, second.owner.tenantId, second.rule.id)).length, 1);
  } finally { await db2.end(); }
});

test('P3-C cadence: concurrent workers claiming the same due plan produce exactly one batch', async () => {
  configureRuntime();
  const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule: dailyTokyo, appCode: 'p3c-sch-race' });
  await addRecord(token, base, statusField, 'open');
  await addRecord(token, base, statusField, 'open');
  const { nextSlotAfter } = scheduleModule();
  const slot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, slot);
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    const now = new Date(slot.utc.getTime() + 2 * 60_000);
    const [a, b] = await Promise.all([
      engine.processSchedules(context, { now }),
      engine.processSchedules(context, { now }),
    ]);
    assert.equal(a.runsCreated + b.runsCreated, 2, 'two workers together create exactly one run per record');
    assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 2);
    assert.equal((await slotRows(db, owner.tenantId, rule.id)).filter((row) => row.status === 'COMPLETED').length, 1);
  } finally { await db.end(); }
});

test('P3-C cadence: crash after claiming resumes from the checkpoint without duplicating runs; batch limit continues without losing the remainder', async () => {
  configureRuntime();
  const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule: dailyTokyo, appCode: 'p3c-sch-crash' });
  for (let i = 0; i < 5; i++) await addRecord(token, base, statusField, 'open');
  const { nextSlotAfter } = scheduleModule();
  const slot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, slot);
    const engine = buildEngine();
    const context = maintenanceContext(owner.tenantId);
    const now = new Date(slot.utc.getTime() + 2 * 60_000);
    // First pass examines only 2 of 5 candidates, then the worker "dies":
    // the slot stays CLAIMED with its checkpoint and the plan claim held.
    const first = await engine.processSchedules(context, { now, batchLimit: 2 });
    assert.equal(first.runsCreated, 2);
    let slots = await slotRows(db, owner.tenantId, rule.id);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].status, 'CLAIMED');
    assert.equal(slots[0].processed_count, 2);
    assert.ok(slots[0].cursor_record_id, 'checkpoint cursor persisted');
    // Recovery pass (lease forced to zero, as after the lease expires):
    // continues from the checkpoint and finishes the slot.
    const recovered = await engine.processSchedules(context, { now, batchLimit: 2, claimLeaseMs: 0 });
    assert.ok(recovered.resumedSlots >= 1, 'claimed slot was resumed');
    for (let i = 0; i < 4; i++) {
      await engine.processSchedules(context, { now, batchLimit: 2, claimLeaseMs: 0 });
    }
    slots = await slotRows(db, owner.tenantId, rule.id);
    assert.equal(slots[0].status, 'COMPLETED');
    assert.equal(slots[0].processed_count, 5, 'remainder was continued, not discarded');
    const runs = await runRows(db, owner.tenantId, rule.id);
    assert.equal(runs.length, 5);
    assert.equal(new Set(runs.map((run) => run.record_id)).size, 5, 'no record got a duplicate run across the crash');
    assert.equal(new Set(runs.map((run) => run.batch_id)).size, 1, 'resumed runs keep the original batch');
  } finally { await db.end(); }
});

test('P3-C cadence: lifecycle -- disable and grant revoke invalidate the plan; backlog is visible in the summary and alerts admins', async () => {
  configureRuntime();
  const created = await createScheduleRule({ schedule: dailyTokyo, appCode: 'p3c-sch-life' });
  const { owner, token, base, rule, grant } = created;
  await addRecord(token, base, created.statusField, 'open');
  const { nextSlotAfter } = scheduleModule();
  const slot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
  const db = await adminClient();
  try {
    await setPlanDue(db, owner.tenantId, rule.id, slot);
    // Backlog is API-visible through the E-6 summary before any processing.
    const summary = await expectRequest(200, `${base}/automation/summary`, { token });
    assert.ok(summary.scheduleBacklog >= 1, 'summary exposes the due-plan backlog count');
    // Alert path: threshold forced to zero so the due plan alerts.
    const engine = buildEngine();
    await engine.processSchedules(maintenanceContext(owner.tenantId), {
      now: new Date(Date.now() - 60_000), backlogAlertThreshold: 0,
    });
    const alerts = await db.query(
      `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND source_type='SYSTEM' AND rule_key='AUTOMATION_SCHEDULE_BACKLOG'`,
      [owner.tenantId]);
    assert.ok(alerts.rows[0].count >= 1, 'backlog alert delivered to admins as a SYSTEM notification');
    const audit = await db.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND action='SCHEDULE_BACKLOG_ALERT'`,
      [owner.tenantId]);
    assert.ok(audit.rows[0].count >= 1, 'backlog alert is audited');

    // Disable: plan invalidated, due slot never fires.
    await expectRequest(201, `${base}/automation/rules/${rule.id}/enable`, {
      token, method: 'POST', body: { enabled: false },
    });
    let plan = await planRow(db, owner.tenantId, rule.id);
    assert.equal(plan.status, 'INVALIDATED');
    assert.equal(plan.invalidation_reason, 'rule-disabled');
    const now = new Date(slot.utc.getTime() + 2 * 60_000);
    assert.equal((await engine.processSchedules(maintenanceContext(owner.tenantId), { now })).runsCreated, 0);
    // Re-enable revives the plan; revoking the grant kills it again.
    await expectRequest(201, `${base}/automation/rules/${rule.id}/enable`, {
      token, method: 'POST', body: { enabled: true },
    });
    plan = await planRow(db, owner.tenantId, rule.id);
    assert.equal(plan.status, 'ACTIVE');
    await setPlanDue(db, owner.tenantId, rule.id, slot);
    await expectRequest(201, `${base}/automation/rules/${rule.id}/grants/${grant.id}/revoke`, {
      token, method: 'POST', body: {},
    });
    plan = await planRow(db, owner.tenantId, rule.id);
    assert.equal(plan.status, 'INVALIDATED');
    assert.equal(plan.invalidation_reason, 'grant-revoked');
    assert.equal((await engine.processSchedules(maintenanceContext(owner.tenantId), { now })).runsCreated, 0,
      'a revoked grant means the due slot can never fire');
    assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 0);
  } finally { await db.end(); }
});

test('P3-C cadence: C1 grace boundary -- slot consumed 14 minutes late executes on time, 16 minutes late is missed (injected grace)', async () => {
  configureRuntime();
  const { nextSlotAfter } = scheduleModule();
  const graceMs = 15 * 60_000;
  // 14 minutes late: inside the on-time grace, the slot executes.
  {
    const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule: dailyTokyo, appCode: 'p3c-sch-c1-14' });
    await addRecord(token, base, statusField, 'open');
    const slot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
    const db = await adminClient();
    try {
      await setPlanDue(db, owner.tenantId, rule.id, slot);
      const engine = buildEngine();
      const result = await engine.processSchedules(maintenanceContext(owner.tenantId), {
        now: new Date(slot.utc.getTime() + 14 * 60_000), onTimeGraceMs: graceMs,
      });
      assert.equal(result.runsCreated, 1, 'C1: 14 minutes late is still on time and executes');
      const slots = await slotRows(db, owner.tenantId, rule.id);
      assert.equal(slots.length, 1);
      assert.equal(slots[0].status, 'COMPLETED');
      assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 1);
    } finally { await db.end(); }
  }
  // 16 minutes late: beyond the grace, the slot is missed (skip policy).
  {
    const { owner, token, base, statusField, rule } = await createScheduleRule({ schedule: dailyTokyo, appCode: 'p3c-sch-c1-16' });
    await addRecord(token, base, statusField, 'open');
    const slot = nextSlotAfter(dailyTokyo, new Date('2026-06-01T00:00:00Z'));
    const db = await adminClient();
    try {
      await setPlanDue(db, owner.tenantId, rule.id, slot);
      const engine = buildEngine();
      const result = await engine.processSchedules(maintenanceContext(owner.tenantId), {
        now: new Date(slot.utc.getTime() + 16 * 60_000), onTimeGraceMs: graceMs,
      });
      assert.equal(result.runsCreated, 0, 'C1: 16 minutes late is missed and never executes');
      const slots = await slotRows(db, owner.tenantId, rule.id);
      assert.equal(slots.length, 1);
      assert.equal(slots[0].status, 'SKIPPED_MISSED');
      assert.equal((await runRows(db, owner.tenantId, rule.id)).length, 0);
    } finally { await db.end(); }
  }
});
