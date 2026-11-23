const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

// P3-C admission conditions C-1 / C-2 / C-3 (second block):
// - C-1: manualRun replays return the existing run -- both the sequential
//   pre-check path and the unique-constraint collision path -- and manual
//   (event-less) notifications reconcile back to their run action through
//   the notification payload (runId + action idempotency key).
// - C-2: a CHAIN_PAUSED run now writes a CHAIN_PAUSED audit row (the audit
//   action previously existed in the CHECK but was never written).
// - C-3: RATE_LIMITED / BACKLOG_LIMITED audit writes are throttled per
//   (tenant, app, rule, action) window -- repeated passes keep exactly one
//   row and the event stays pending; dry-run discloses auditTrail 'none'
//   and writes no audit row.
const emptyGroup = { operator: 'and', groups: [] };
const ruleConfig = (trigger, actions) => ({
  schemaVersion: 1, trigger, conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup }, actions,
});
const writer = (token, base) => (path, body, method = 'POST', code = 201) =>
  expectRequest(code, base + path, { token, body, method });

async function buildEngine() {
  const { AppSchemaService } = require('../../../apps/api/dist/app-schema.js');
  const { AuthorizationService } = require('../../../apps/api/dist/authorization.js');
  const { AutomationService } = require('../../../apps/api/dist/automation.js');
  const authorization = new AuthorizationService();
  return new AutomationService(new AppSchemaService(authorization), authorization);
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

test('P3-C C-1: manual replay returns the existing run (pre-check and unique-collision paths); manual notifications reconcile via payload', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3c-admission-manual');
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const status = await addField(token, app.id, 'p3c_adm_status', 'text');
  await publish(token, app.id);
  const notifyAction = randomUUID();
  const manual = await makeRule(write, 'Manual notify', ruleConfig({
    eventType: 'record.created', allowManual: true,
  }, [
    { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [
      { fieldId: status.fieldId, mode: 'set', value: 'manual-ok' },
    ] },
    { actionId: notifyAction, type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'Stamped' } },
  ]), {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [],
    writableFieldIds: [status.fieldId], allowedOperations: ['UPDATE_FIELDS', 'NOTIFY'],
  });
  const record = await write('/records', { data: { [status.fieldId]: 'draft' } });
  const db = await auditClient();
  try {
    const manualNotices = () => db.query(
      `SELECT payload, rule_key FROM notifications
       WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 AND source_type='RECORD' AND event_id IS NULL`,
      [owner.tenantId, app.id, record.id]);
    const runCount = async () => Number((await db.query(
      `SELECT count(*)::int AS count FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, manual.id])).rows[0].count);

    const first = await expectRequest(201, `${base}/automation/rules/${manual.id}/manual-runs`, {
      token, method: 'POST', body: { recordId: record.id, idempotencyKey: 'c1-key' },
    });
    assert.equal(first.deduplicated, false);
    assert.equal(first.run.status, 'SUCCEEDED');
    assert.equal(await runCount(), 1);

    // C-1 audit reconciliation: the event-less notification links back to
    // exactly this run and this action's idempotency key.
    let notices = await manualNotices();
    assert.equal(notices.rowCount, 1, 'one manual notification after the first run');
    assert.equal(notices.rows[0].rule_key, `automation:${manual.id}:${notifyAction}`);
    assert.equal(notices.rows[0].payload.runId, first.run.id);
    assert.equal(notices.rows[0].payload.actionIdempotencyKey, `manual:c1-key:${notifyAction}`);

    const again = await expectRequest(201, `${base}/automation/rules/${manual.id}/manual-runs`, {
      token, method: 'POST', body: { recordId: record.id, idempotencyKey: 'c1-key' },
    });
    assert.equal(again.deduplicated, true, 'same key replays return the existing run, not an error');
    assert.equal(again.run.id, first.run.id);
    assert.equal(await runCount(), 1, 'no second run on replay');
    notices = await manualNotices();
    assert.equal(notices.rowCount, 1, 'no second notification on replay');

    // Deterministic unique-collision path: a run whose trigger identity
    // differs (so the pre-check misses it) but whose run idempotency key
    // collides with the key this request will build. The insert must
    // degrade to returning that winner instead of raising a 500/conflict.
    const planted = await db.query(
      `INSERT INTO automation_runs (tenant_id, app_id, id, rule_id, rule_version, event_id, trigger_identity,
         idempotency_key, record_id, root_causation_id, causation_depth, status, completed_at)
       VALUES ($1,$2,gen_random_uuid(),$3,$4,NULL,'manual:planted-other',$5,$6,gen_random_uuid(),1,'SUCCEEDED',clock_timestamp())
       RETURNING id`,
      [owner.tenantId, app.id, manual.id, manual.version,
        `manual:c1-race:${manual.id}:${manual.version}`, record.id]);
    const plantedId = planted.rows[0].id;
    const before = await expectRequest(200, `${base}/records/${record.id}`, { token });
    const collided = await expectRequest(201, `${base}/automation/rules/${manual.id}/manual-runs`, {
      token, method: 'POST', body: { recordId: record.id, idempotencyKey: 'c1-race' },
    });
    assert.equal(collided.deduplicated, true, 'unique-collision replay returns the existing run');
    assert.equal(collided.run.id, plantedId);
    assert.equal(await runCount(), 2, 'collision created no additional run');
    const after = await expectRequest(200, `${base}/records/${record.id}`, { token });
    assert.equal(after.revision, before.revision, 'collision replay executed nothing');
    notices = await manualNotices();
    assert.equal(notices.rowCount, 1, 'collision replay sent no notification');

    // A deduplicated FAILED run is returned as FAILED (the UI keys its
    // "use Retry instead" hint on exactly this flag + status pair).
    const failedPlant = await db.query(
      `INSERT INTO automation_runs (tenant_id, app_id, id, rule_id, rule_version, event_id, trigger_identity,
         idempotency_key, record_id, root_causation_id, causation_depth, status, completed_at)
       VALUES ($1,$2,gen_random_uuid(),$3,$4,NULL,'manual:c1-failed',$5,$6,gen_random_uuid(),1,'FAILED',clock_timestamp())
       RETURNING id`,
      [owner.tenantId, app.id, manual.id, manual.version,
        `manual:c1-failed:${manual.id}:${manual.version}`, record.id]);
    const failedReplay = await expectRequest(201, `${base}/automation/rules/${manual.id}/manual-runs`, {
      token, method: 'POST', body: { recordId: record.id, idempotencyKey: 'c1-failed' },
    });
    assert.equal(failedReplay.deduplicated, true);
    assert.equal(failedReplay.run.id, failedPlant.rows[0].id);
    assert.equal(failedReplay.run.status, 'FAILED');
  } finally { await db.end(); }
});

async function publishedNotifyRule(slug) {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, slug);
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'p3c_adm2_status', 'text');
  await publish(token, app.id);
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Admission rule', config: {
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
  const updated = await expectRequest(200, `${base}/records/${record.id}`, {
    token, method: 'PUT', body: { revision: record.revision, data: { [status.fieldId]: 'active' } },
  });
  return { owner, token, app, base, status, rule: saved.rule, version: saved.version.version, record, updated };
}

test('P3-C C-3: guardrail audit writes are throttled per window; the first row always lands and events stay pending', async () => {
  configureRuntime();
  const { AUTOMATION_TENANT_RUN_RATE_LIMIT, AUTOMATION_TENANT_PENDING_LIMIT } =
    require('../../../apps/api/dist/automation.js');
  const { owner, app, rule, version, record } = await publishedNotifyRule('p3c-admission-throttle');
  const engine = await buildEngine();
  const context = Object.freeze({ tenantId: owner.tenantId, userId: '00000000-0000-0000-0000-000000000000' });
  const db = await auditClient();
  try {
    const event = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at LIMIT 1`,
      [owner.tenantId, app.id, record.id]);
    const eventId = event.rows[0].event_id;
    const auditCount = async (action) => Number((await db.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND action=$2`,
      [owner.tenantId, action])).rows[0].count);

    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'adm-rate:'||n::text,'adm-rate:'||n::text,$6,$7,1,'SUCCEEDED'
       FROM generate_series(1,$8::int) n`,
      [owner.tenantId, app.id, rule.id, version, eventId, record.id, eventId, AUTOMATION_TENANT_RUN_RATE_LIMIT]);
    await db.query(`UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    await engine.processOutbox(context);
    await engine.processOutbox(context);
    await engine.processOutbox(context);
    assert.equal(await auditCount('RATE_LIMITED'), 1,
      'three rate-limited passes over multiple events write exactly one throttled audit row');
    const stillPending = await db.query(
      `SELECT count(*)::int AS count FROM outbox WHERE tenant_id=$1 AND app_id=$2 AND automation_processed_at IS NULL`,
      [owner.tenantId, app.id]);
    assert.ok(stillPending.rows[0].count >= 1, 'rate-limited events are not consumed; the signal is not lost');

    await db.query(`DELETE FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key LIKE 'adm-rate:%'`,
      [owner.tenantId, app.id]);
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status,started_at)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'adm-backlog:'||n::text,'adm-backlog:'||n::text,$6,$7,1,'QUEUED',
         clock_timestamp() - interval '10 minutes'
       FROM generate_series(1,$8::int) n`,
      [owner.tenantId, app.id, rule.id, version, eventId, record.id, eventId, AUTOMATION_TENANT_PENDING_LIMIT + 1]);
    await db.query(`UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id]);
    await engine.processOutbox(context);
    await engine.processOutbox(context);
    assert.equal(await auditCount('BACKLOG_LIMITED'), 1,
      'repeated backlog-limited passes write exactly one throttled audit row');
  } finally { await db.end(); }
});

test('P3-C C-2/C-3: CHAIN_PAUSED runs write the CHAIN_PAUSED audit action; dry-run discloses no audit trail and writes none', async () => {
  configureRuntime();
  const { owner, token, app, base, status, rule, version, record, updated } =
    await publishedNotifyRule('p3c-admission-chain');
  const engine = await buildEngine();
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  const db = await auditClient();
  try {
    // Dry-run disclosure leg (before any processing writes audit rows).
    const auditBefore = Number((await db.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id])).rows[0].count);
    const preview = await expectRequest(201, `${base}/automation/rules/${rule.id}/dry-run`, {
      token, method: 'POST', body: { version, recordId: record.id },
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.sideEffects, false);
    assert.equal(preview.auditTrail, 'none', 'dry-run API explicitly discloses that it leaves no audit trail');
    assert.match(preview.boundaries, /no audit event/);
    const auditAfter = Number((await db.query(
      `SELECT count(*)::int AS count FROM automation_audit_events WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id])).rows[0].count);
    assert.equal(auditAfter, auditBefore, 'dry-run writes no audit row');

    // Chain-pause leg: three FAILED runs on one root, then a fresh matching
    // event on the same root must end CHAIN_PAUSED and be audited as such.
    const away = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: updated.revision, data: { [status.fieldId]: 'draft' } },
    });
    const back = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: away.revision, data: { [status.fieldId]: 'active' } },
    });
    assert.ok(back.revision > away.revision);
    const chainRoot = randomUUID();
    const anyEvent = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at LIMIT 1`,
      [owner.tenantId, app.id, record.id]);
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'adm-failed:'||n::text,'adm-failed:'||n::text,$6,$7,1,'FAILED'
       FROM generate_series(1,3) n`,
      [owner.tenantId, app.id, rule.id, version, anyEvent.rows[0].event_id, record.id, chainRoot]);
    const latestEvent = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at DESC LIMIT 1`,
      [owner.tenantId, app.id, record.id]);
    await db.query(
      `UPDATE outbox SET automation_processed_at=NULL, root_causation_id=$3
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
      [owner.tenantId, app.id, chainRoot, latestEvent.rows[0].event_id]);
    await engine.processOutbox(context);
    const pausedRun = await db.query(
      `SELECT id FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3
        AND root_causation_id=$4 AND status='CHAIN_PAUSED'`,
      [owner.tenantId, app.id, rule.id, chainRoot]);
    assert.equal(pausedRun.rowCount, 1, 'the fresh event on a thrice-failed chain ends CHAIN_PAUSED');
    const pauseAudit = await db.query(
      `SELECT details FROM automation_audit_events
       WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3 AND action='CHAIN_PAUSED'`,
      [owner.tenantId, app.id, rule.id]);
    assert.equal(pauseAudit.rowCount, 1, 'CHAIN_PAUSED is now a written audit action, exactly once per pause');
    assert.equal(pauseAudit.rows[0].details.runId, pausedRun.rows[0].id);
    assert.equal(pauseAudit.rows[0].details.reason, 'CHAIN_PAUSED');
  } finally { await db.end(); }
});
