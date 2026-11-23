const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

// P3-C C-0 reproduction: the production worker drives processOutbox and
// pruneRunHistory with the maintenanceTenants() context shape from
// packages/db/src/index.ts — a frozen { tenantId, userId: nil UUID } whose
// userId is NOT a tenant_members row. The P3-B guardrail suite only ever
// used a real owner context, so the RATE_LIMITED / BACKLOG_LIMITED audit
// inserts (actor FK -> tenant_members) and the pruning path were never
// exercised under this context. On the P3-B base both tests fail:
// processOutbox rejects with an automation_audit_events actor FK violation
// (rolling back the whole outbox transaction), and pruneRunHistory prunes
// nothing when any problem chain has last_run_id NULL (NOT IN semantics)
// and writes no RUN_HISTORY_PRUNED audit row at all.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const maintenanceContext = (tenantId) => Object.freeze({ tenantId, userId: NIL_UUID });

const emptyGroup = { operator: 'and', groups: [] };

async function buildEngine() {
  const { AppSchemaService } = require('../../../apps/api/dist/app-schema.js');
  const { AuthorizationService } = require('../../../apps/api/dist/authorization.js');
  const { AutomationService } = require('../../../apps/api/dist/automation.js');
  const authorization = new AuthorizationService();
  return new AutomationService(new AppSchemaService(authorization), authorization);
}

async function publishedRule() {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-system-actor');
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'p3c_status', 'text');
  await publish(token, app.id);
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'C-0 rule', config: {
      schemaVersion: 1,
      trigger: { eventType: 'record.updated', fieldId: status.fieldId, newValue: 'active' },
      conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup },
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientAssignee: true } }],
    } },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/preflight`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, {
    token, method: 'POST', body: { enabled: true },
  });
  const record = await expectRequest(201, `${base}/records`, {
    token, method: 'POST', body: { data: { [status.fieldId]: 'draft' } },
  });
  await expectRequest(200, `${base}/records/${record.id}`, {
    token, method: 'PUT', body: { revision: record.revision, data: { [status.fieldId]: 'active' } },
  });
  return { owner, app, rule: saved.rule, version: saved.version.version, record };
}

async function adminClient() {
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  return db;
}

test('P3-C C-0: processOutbox rate/backlog guardrails survive the maintenance (system) context', async () => {
  configureRuntime();
  const { AUTOMATION_TENANT_RUN_RATE_LIMIT, AUTOMATION_TENANT_PENDING_LIMIT } =
    require('../../../apps/api/dist/automation.js');
  const { owner, app, rule, version, record } = await publishedRule();
  const engine = await buildEngine();
  const context = maintenanceContext(owner.tenantId);
  const db = await adminClient();
  try {
    const event = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at LIMIT 1`,
      [owner.tenantId, app.id, record.id]);
    const eventId = event.rows[0].event_id;

    // Rate-limit leg: fill the 60-second run window, then drive the outbox
    // exactly as the production worker does.
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'c0-rate:'||n::text,'c0-rate:'||n::text,$6,$7,1,'SUCCEEDED'
       FROM generate_series(1,$8::int) n`,
      [owner.tenantId, app.id, rule.id, version, eventId, record.id, eventId, AUTOMATION_TENANT_RUN_RATE_LIMIT]);
    await db.query(`UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    let rateError;
    try { await engine.processOutbox(context); } catch (error) { rateError = error; }
    assert.equal(rateError, undefined,
      `maintenance-context processOutbox must not fail on the RATE_LIMITED audit insert: ${rateError?.message ?? ''}`);
    const rateAudit = await db.query(
      `SELECT actor_id, actor_type FROM automation_audit_events
       WHERE tenant_id=$1 AND action='RATE_LIMITED'`,
      [owner.tenantId]);
    assert.ok(rateAudit.rowCount >= 1, 'RATE_LIMITED audit row written under maintenance context');
    for (const row of rateAudit.rows) {
      assert.equal(row.actor_id, null, 'system audit rows carry no member actor');
      assert.equal(row.actor_type, 'SYSTEM', 'system audit rows are marked as system-originated');
    }
    // The guardrail must not consume the event: it stays unprocessed for a
    // later pass once the window clears.
    const stillPending = await db.query(
      `SELECT count(*)::int AS count FROM outbox
       WHERE tenant_id=$1 AND app_id=$2 AND automation_processed_at IS NULL`,
      [owner.tenantId, app.id]);
    assert.ok(stillPending.rows[0].count >= 1, 'rate-limited events are not marked processed');

    // Backlog leg: clear the rate window, overflow the pending limit with
    // old QUEUED runs (outside the 60-second rate window).
    await db.query(`DELETE FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key LIKE 'c0-rate:%'`,
      [owner.tenantId, app.id]);
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status,started_at)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'c0-backlog:'||n::text,'c0-backlog:'||n::text,$6,$7,1,'QUEUED',
         clock_timestamp() - interval '10 minutes'
       FROM generate_series(1,$8::int) n`,
      [owner.tenantId, app.id, rule.id, version, eventId, record.id, eventId, AUTOMATION_TENANT_PENDING_LIMIT + 1]);
    await db.query(`UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    let backlogError;
    try { await engine.processOutbox(context); } catch (error) { backlogError = error; }
    assert.equal(backlogError, undefined,
      `maintenance-context processOutbox must not fail on the BACKLOG_LIMITED audit insert: ${backlogError?.message ?? ''}`);
    const backlogAudit = await db.query(
      `SELECT actor_id, actor_type FROM automation_audit_events
       WHERE tenant_id=$1 AND action='BACKLOG_LIMITED'`,
      [owner.tenantId]);
    assert.ok(backlogAudit.rowCount >= 1, 'BACKLOG_LIMITED audit row written under maintenance context');
    for (const row of backlogAudit.rows) {
      assert.equal(row.actor_id, null);
      assert.equal(row.actor_type, 'SYSTEM');
    }
  } finally { await db.end(); }
});

test('P3-C C-0: pruneRunHistory under maintenance context prunes, survives NULL last_run_id chains, and writes RUN_HISTORY_PRUNED system audit', async () => {
  configureRuntime();
  const { owner, app, rule, record } = await publishedRule();
  const engine = await buildEngine();
  const context = maintenanceContext(owner.tenantId);
  const db = await adminClient();
  try {
    const insertRun = async (key, root) => {
      const { rows } = await db.query(
        `INSERT INTO automation_runs (tenant_id, app_id, rule_id, rule_version, event_id, trigger_identity,
           idempotency_key, record_id, root_causation_id, causation_depth, status, completed_at)
         VALUES ($1,$2,$3,1,NULL,$4,$5,$6,$7,1,'SUCCEEDED', clock_timestamp() - interval '100 days')
         RETURNING id`,
        [owner.tenantId, app.id, rule.id, `c0-prune:${key}`, `c0-prune:${key}:${rule.id}:1`, record.id, root]);
      return rows[0].id;
    };
    const oldRun = await insertRun('old-1', randomUUID());
    const protectedRun = await insertRun('old-2', randomUUID());
    await db.query(
      `INSERT INTO automation_run_actions (tenant_id, app_id, run_id, action_id, position, status, idempotency_key)
       VALUES ($1,$2,$3,$4,0,'SUCCEEDED',$5)`,
      [owner.tenantId, app.id, oldRun, randomUUID(), 'c0-prune:old-1:a1']);
    await db.query(
      `INSERT INTO automation_problem_chains (tenant_id, root_causation_id, reason, last_run_id)
       VALUES ($1,$2,'CAUSATION_DEPTH_EXCEEDED',$3)`,
      [owner.tenantId, randomUUID(), protectedRun]);
    // A problem chain whose last_run_id is NULL must not silently disable
    // all pruning (the old NOT IN formulation returns UNKNOWN for every run).
    await db.query(
      `INSERT INTO automation_problem_chains (tenant_id, root_causation_id, reason, last_run_id)
       VALUES ($1,$2,'REPEATED_FAILURES_LIMIT_3',NULL)`,
      [owner.tenantId, randomUUID()]);
    const auditBefore = await db.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);

    let pruneError;
    let result;
    try { result = await engine.pruneRunHistory(context); } catch (error) { pruneError = error; }
    assert.equal(pruneError, undefined,
      `maintenance-context pruneRunHistory must not fail: ${pruneError?.message ?? ''}`);
    assert.equal(result.pruned, 1, 'only the unreferenced old run is pruned despite the NULL last_run_id chain');
    const remaining = await db.query(
      `SELECT id FROM automation_runs WHERE tenant_id=$1 AND id IN ($2,$3)`,
      [owner.tenantId, oldRun, protectedRun]);
    assert.deepEqual(remaining.rows.map((row) => row.id), [protectedRun],
      'problem-chain-referenced runs survive pruning');
    const actions = await db.query(
      `SELECT count(*)::int AS count FROM automation_run_actions WHERE tenant_id=$1 AND run_id=$2`,
      [owner.tenantId, oldRun]);
    assert.equal(actions.rows[0].count, 0, 'pruned run actions are deleted with the run');

    const pruneAudit = await db.query(
      `SELECT actor_id, actor_type, details FROM automation_audit_events
       WHERE tenant_id=$1 AND app_id=$2 AND action='RUN_HISTORY_PRUNED'`,
      [owner.tenantId, app.id]);
    assert.equal(pruneAudit.rowCount, 1, 'pruning writes exactly one RUN_HISTORY_PRUNED audit row per rule group');
    assert.equal(pruneAudit.rows[0].actor_id, null, 'prune audit is a system action, not a member action');
    assert.equal(pruneAudit.rows[0].actor_type, 'SYSTEM');
    assert.equal(pruneAudit.rows[0].details.prunedCount, 1);
    const auditAfter = await db.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    assert.equal(auditAfter.rows[0].count, auditBefore.rows[0].count + 1,
      'pre-existing audit events are never pruned; exactly the prune row is added');
  } finally { await db.end(); }
});
