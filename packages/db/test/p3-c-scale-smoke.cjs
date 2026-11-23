// P3-C fix batch C2: 100,000-record scale smoke for date-relative
// backfill + consumption. Standalone script (not part of the regular
// `pnpm test` glob): run it explicitly against the test stack:
//
//   source <test-stack env> && node packages/db/test/p3-c-scale-smoke.cjs
//
// Fixture: 100,000 stock records are bulk-inserted directly into
// `records` (plus their 'created' record_events, the same complete
// stored shape the API path writes -- identical approach to the
// 2,000-record backfill gate fixture), all sharing wish_date
// 2027-03-15, so a -3d 09:00 Asia/Tokyo rule owes exactly one plan per
// record, due 2027-03-12T00:00:00Z. Backfill runs with an injected
// `now` long before any due_at (never executes); consumption then runs
// at due + 5 minutes. Batch limit is the product default (1000).
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const TOTAL = 100_000;
const CHUNK = 10_000;
const EXPECTED_BATCHES = TOTAL / 1_000;

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

const stamp = (label, started) => console.log(`[smoke] ${label}: ${((Date.now() - started) / 1000).toFixed(1)}s`);

async function main() {
  configureRuntime();
  const wallStart = Date.now();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-dr-scale100k');
  const base = `/apps/${app.id}`;
  const wish = await addField(token, app.id, 'wish_date', 'date');
  await publish(token, app.id);
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    const { rows: [appRow] } = await db.query(
      `SELECT published_schema_version FROM apps WHERE tenant_id=$1 AND id=$2`, [owner.tenantId, app.id]);

    // ---- Stock load: chunked bulk INSERTs of the complete record shape.
    const loadStart = Date.now();
    for (let start = 1; start <= TOTAL; start += CHUNK) {
      await db.query(
        `WITH inserted AS (
           INSERT INTO records (tenant_id, app_id, id, record_no, data, schema_version, revision, status, created_by, updated_by)
           SELECT $1, $2, gen_random_uuid(), n, jsonb_build_object($3::text, '2027-03-15'), $4, 1, 'active', $5, $5
           FROM generate_series($6::int, $7::int) AS n
           RETURNING id, data
         )
         INSERT INTO record_events (tenant_id, app_id, event_id, record_id, record_revision, schema_version, actor_id, source, kind, changes, snapshot_data)
         SELECT $1, $2, gen_random_uuid(), id, 1, $4, $5, 'api', 'created', '[]'::jsonb, data FROM inserted`,
        [owner.tenantId, app.id, wish.fieldId, appRow.published_schema_version, owner.userId, start, Math.min(start + CHUNK - 1, TOTAL)]);
      console.log(`[smoke] stock loaded up to ${Math.min(start + CHUNK - 1, TOTAL)}`);
    }
    stamp('stock load (100000 records + created events)', loadStart);
    const loadMs = Date.now() - loadStart;
    const { rows: [stockCount] } = await db.query(
      `SELECT count(*)::int AS count FROM records WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, app.id]);
    assert.equal(stockCount.count, TOTAL);

    // ---- Rule (created AFTER the stock exists, like the 2k gate).
    const config = {
      schemaVersion: 1,
      trigger: { eventType: 'schedule.dateRelative', dateRelative: { source: 'field', fieldId: wish.fieldId, offsetDays: -3, localTime: '09:00', timezone: 'Asia/Tokyo' } },
      conditions: { eventSnapshot: { operator: 'and', groups: [] }, currentState: { operator: 'and', groups: [] } },
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Reminder', body: 'due soon' } }],
    };
    const saved = await expectRequest(201, `${base}/automation/rules`, { token, method: 'POST', body: { name: 'scale100k', config } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
      token, method: 'POST', body: {
        version: saved.version.version, sourceAppId: app.id, readableFieldIds: [wish.fieldId],
        targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
      },
    });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, { token, method: 'POST', body: { version: saved.version.version } });
    await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, { token, method: 'POST', body: { enabled: true } });

    const engine = buildEngine();
    const context = Object.freeze({ tenantId: owner.tenantId, userId: NIL_UUID });
    const jobRow = async () => {
      const { rows } = await db.query(
        `SELECT * FROM automation_date_backfills WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
      return rows[0];
    };

    // ---- Phase 1: backfill (plan generation), now long before due.
    const backfillStart = Date.now();
    const early = new Date('2027-01-01T00:00:00Z');
    let backfillCalls = 0;
    let backfilled = 0;
    for (let guard = 0; guard < EXPECTED_BATCHES + 10; guard++) {
      const job = await jobRow();
      if (job?.status === 'COMPLETED') break;
      const result = await engine.processDateRelativeSchedules(context, { now: early });
      backfillCalls++;
      backfilled += result.backfilledRecords;
      assert.equal(result.executed, 0, 'backfill phase never executes');
      if (backfillCalls % 20 === 0) console.log(`[smoke] backfill calls=${backfillCalls} records=${backfilled}`);
    }
    const backfillMs = Date.now() - backfillStart;
    stamp('backfill phase', backfillStart);
    const job = await jobRow();
    assert.equal(job.status, 'COMPLETED', 'backfill job completes');
    assert.equal(job.processed_count, TOTAL, 'checkpoint processed_count reaches the full stock');
    assert.equal(backfilled, TOTAL);
    assert.equal(backfillCalls, EXPECTED_BATCHES, `backfill honours the 1000 batch cap: ${EXPECTED_BATCHES} calls`);
    const { rows: [maxRecord] } = await db.query(
      `SELECT id AS max_id FROM records WHERE tenant_id=$1 AND app_id=$2 ORDER BY id DESC LIMIT 1`, [owner.tenantId, app.id]);
    assert.equal(job.cursor_record_id, maxRecord.max_id, 'checkpoint cursor lands on the last record id');

    const { rows: [planCount] } = await db.query(
      `SELECT count(*)::int AS count FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(planCount.count, TOTAL, 'generated plans equal the stock size');
    const { rows: [dupPlans] } = await db.query(
      `SELECT count(*)::int AS count FROM (
         SELECT 1 FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2
         GROUP BY rule_version, record_id, schedule_key HAVING count(*) > 1
       ) AS dup`, [owner.tenantId, saved.rule.id]);
    assert.equal(dupPlans.count, 0, 'zero duplicate plans by logical identity');

    // ---- Phase 2: consumption at due + 5 minutes, batched to completion.
    const consumeStart = Date.now();
    const dueNow = new Date('2027-03-12T00:05:00Z');
    let consumeCalls = 0;
    let executed = 0;
    for (let guard = 0; guard < EXPECTED_BATCHES + 10; guard++) {
      const { rows: [pending] } = await db.query(
        `SELECT count(*)::int AS count FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2 AND status='PENDING'`,
        [owner.tenantId, saved.rule.id]);
      if (pending.count === 0) break;
      const result = await engine.processDateRelativeSchedules(context, { now: dueNow });
      consumeCalls++;
      executed += result.executed;
      assert.ok(result.executed <= 1_000, 'consumption honours the 1000 batch cap per call');
      if (consumeCalls % 10 === 0) console.log(`[smoke] consume calls=${consumeCalls} executed=${executed}`);
    }
    const consumeMs = Date.now() - consumeStart;
    stamp('consumption phase', consumeStart);
    assert.equal(executed, TOTAL, 'every plan executes exactly once across batches');
    assert.equal(consumeCalls, EXPECTED_BATCHES, `consumption took ${EXPECTED_BATCHES} batches of <=1000`);

    const { rows: [runCount] } = await db.query(
      `SELECT count(*)::int AS count FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2`, [owner.tenantId, saved.rule.id]);
    assert.equal(runCount.count, TOTAL, 'one run per plan');
    const { rows: [dupRuns] } = await db.query(
      `SELECT count(*)::int AS count FROM (
         SELECT 1 FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2
         GROUP BY idempotency_key HAVING count(*) > 1
       ) AS dup`, [owner.tenantId, saved.rule.id]);
    assert.equal(dupRuns.count, 0, 'zero duplicate runs by idempotency key');
    const { rows: [noteCount] } = await db.query(
      `SELECT count(*)::int AS count FROM notifications WHERE tenant_id=$1 AND payload->>'runId' IN (
         SELECT id::text FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2
       )`, [owner.tenantId, saved.rule.id]);
    assert.equal(noteCount.count, TOTAL, 'one notification per run');
    const { rows: [succeeded] } = await db.query(
      `SELECT count(*)::int AS count FROM automation_schedules WHERE tenant_id=$1 AND rule_id=$2 AND status='SUCCEEDED'`,
      [owner.tenantId, saved.rule.id]);
    assert.equal(succeeded.count, TOTAL, 'all plans finalize SUCCEEDED');

    console.log(JSON.stringify({
      records: TOTAL,
      stockLoadMs: loadMs,
      plansExpected: TOTAL, plansActual: planCount.count,
      duplicatePlanGroups: dupPlans.count,
      backfillCalls, backfillMs,
      consumeCalls, consumeMs,
      executed, runs: runCount.count, duplicateRunGroups: dupRuns.count,
      notifications: noteCount.count,
      checkpoint: { status: job.status, processedCount: job.processed_count, cursorIsMaxRecordId: job.cursor_record_id === maxRecord.max_id },
      totalMs: Date.now() - wallStart,
    }, null, 2));
    console.log('[smoke] PASS');
  } finally {
    await db.end();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error('[smoke] FAIL', error); process.exit(1); });
