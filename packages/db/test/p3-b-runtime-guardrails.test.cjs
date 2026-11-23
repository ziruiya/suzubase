const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

const emptyGroup = { operator: 'and', groups: [] };
const ruleConfig = (trigger, actions = [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientAssignee: true } }]) => ({
  schemaVersion: 1, trigger, conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup }, actions,
});

test('P3-B C6 source binding and C2 runtime guardrails use real API and worker paths', async () => {
  configureRuntime();
  const { AppSchemaService } = require('../../../apps/api/dist/app-schema.js');
  const { AuthorizationService } = require('../../../apps/api/dist/authorization.js');
  const { AutomationService, automationUpdateNeeded, AUTOMATION_TENANT_RUN_RATE_LIMIT, AUTOMATION_TENANT_PENDING_LIMIT } =
    require('../../../apps/api/dist/automation.js');
  assert.equal(automationUpdateNeeded('same', 'same'), false);
  assert.equal(automationUpdateNeeded('old', 'new'), true);
  assert.equal(automationUpdateNeeded({ value: 1 }, { value: 1 }), false);

  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3b-guardrail');
  const otherApp = await createApp(token, 'p3b-other');
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'guard_status', 'text');
  await publish(token, app.id);

  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Guardrail rule', config: ruleConfig({ eventType: 'workflow.transitioned', toStateId: randomUUID() }) },
  });
  await expectRequest(400, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: otherApp.id, readableFieldIds: [],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });

  const recordRule = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Record snapshot rule', config: {
      schemaVersion: 1,
      trigger: { eventType: 'record.updated', fieldId: status.fieldId, newValue: 'active' },
      conditions: {
        eventSnapshot: { operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'draft' }] }] },
        currentState: { operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'active' }] }] },
      },
      actions: [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientAssignee: true } }],
    } },
  });
  await expectRequest(201, `${base}/automation/rules/${recordRule.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: recordRule.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${recordRule.rule.id}/preflight`, {
    token, method: 'POST', body: { version: recordRule.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${recordRule.rule.id}/publish`, {
    token, method: 'POST', body: { version: recordRule.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${recordRule.rule.id}/enable`, {
    token, method: 'POST', body: { enabled: true },
  });

  const record = await expectRequest(201, `${base}/records`, {
    token, method: 'POST', body: { data: { [status.fieldId]: 'draft' } },
  });
  const updated = await expectRequest(200, `${base}/records/${record.id}`, {
    token, method: 'PUT', body: { revision: record.revision, data: { [status.fieldId]: 'active' } },
  });

  const authorization = new AuthorizationService();
  const engine = new AutomationService(new AppSchemaService(authorization), authorization);
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  await engine.processOutbox(context);

  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    const snapshotRun = await db.query(
      `SELECT status FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, recordRule.rule.id],
    );
    assert.equal(snapshotRun.rowCount, 1);
    assert.equal(snapshotRun.rows[0].status, 'SKIPPED_CONDITION');

    await db.query(
      `UPDATE outbox SET automation_processed_at=NULL
       WHERE tenant_id=$1 AND app_id=$2`,
      [owner.tenantId, app.id],
    );
    const away = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: updated.revision, data: { [status.fieldId]: 'draft' } },
    });
    const back = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: away.revision, data: { [status.fieldId]: 'active' } },
    });
    // Harness chain linkage: a production chain link is written by the causing
    // automation action; at this foundation stage the returning event is linked
    // explicitly to the first run's root. Real action-chain linkage is proven
    // separately by the P3-B actions suite (C3).
    const firstRun = await db.query(
      `SELECT root_causation_id FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, recordRule.rule.id],
    );
    const latestEvent = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at DESC LIMIT 1`,
      [owner.tenantId, app.id, record.id],
    );
    await db.query(
      `UPDATE outbox SET root_causation_id=$3, parent_run_id=NULL
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
      [owner.tenantId, app.id, firstRun.rows[0].root_causation_id, latestEvent.rows[0].event_id],
    );
    await engine.processOutbox(context);
    const blocked = await db.query(
      `SELECT status FROM automation_runs
       WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3 AND status='BLOCKED_CYCLE'`,
      [owner.tenantId, app.id, recordRule.rule.id],
    );
    assert.equal(blocked.rowCount, 1, 'same root causation + rule + record must be BLOCKED_CYCLE');

    await db.query(
      `UPDATE automation_runs SET status='POTENTIAL_CYCLE' WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, recordRule.rule.id],
    )
      .then(() => assert.fail('POTENTIAL_CYCLE must not remain a run status'))
      .catch((error) => assert.match(error.message, /automation_runs_status_check|status/));

    const event = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at LIMIT 1`,
      [owner.tenantId, app.id, record.id],
    );
    const eventId = event.rows[0].event_id;
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'guard:'||n::text,'guard:'||n::text,$6,$7,1,'SUCCEEDED'
       FROM generate_series(1,$8::int) n`,
      [owner.tenantId, app.id, recordRule.rule.id, recordRule.version.version, eventId, record.id, eventId, AUTOMATION_TENANT_RUN_RATE_LIMIT],
    );
    await db.query(`UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, app.id]);
    await engine.processOutbox(context);
    const rateAudit = await db.query(
      `SELECT action FROM automation_audit_events WHERE tenant_id=$1 AND action='RATE_LIMITED'`,
      [owner.tenantId],
    );
    assert.ok(rateAudit.rowCount >= 1);

    await db.query(`DELETE FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key LIKE 'guard:%'`, [owner.tenantId, app.id]);
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status,started_at)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'backlog:'||n::text,'backlog:'||n::text,$6,$7,1,'QUEUED',
         clock_timestamp() - interval '10 minutes'
       FROM generate_series(1,$8::int) n`,
      [owner.tenantId, app.id, recordRule.rule.id, recordRule.version.version, eventId, record.id, eventId, AUTOMATION_TENANT_PENDING_LIMIT + 1],
    );
    await db.query(`UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2`, [owner.tenantId, app.id]);
    await engine.processOutbox(context);
    const backlogAudit = await db.query(
      `SELECT action FROM automation_audit_events WHERE tenant_id=$1 AND action='BACKLOG_LIMITED'`,
      [owner.tenantId],
    );
    assert.ok(backlogAudit.rowCount >= 1);

    await db.query(`DELETE FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key LIKE 'backlog:%'`, [owner.tenantId, app.id]);
    // Repeated failures in one chain pause the chain (C2 circuit breaker):
    // a fresh matching event whose chain already holds 3 FAILED runs for the
    // same record+rule must end CHAIN_PAUSED and register a problem chain.
    const away2 = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: back.revision, data: { [status.fieldId]: 'draft' } },
    });
    const back2 = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: away2.revision, data: { [status.fieldId]: 'active' } },
    });
    const chainRoot = randomUUID();
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'failed:'||n::text,'failed:'||n::text,$6,$7,1,'FAILED'
       FROM generate_series(1,3) n`,
      [owner.tenantId, app.id, recordRule.rule.id, recordRule.version.version, eventId, record.id, chainRoot],
    );
    const back2Event = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at DESC LIMIT 1`,
      [owner.tenantId, app.id, record.id],
    );
    await db.query(
      `UPDATE outbox SET automation_processed_at=NULL, root_causation_id=$3
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
      [owner.tenantId, app.id, chainRoot, back2Event.rows[0].event_id],
    );
    await engine.processOutbox(context);
    const repeatedPause = await db.query(
      `SELECT reason FROM automation_problem_chains
       WHERE tenant_id=$1 AND root_causation_id=$2 AND resumed_at IS NULL`,
      [owner.tenantId, chainRoot],
    );
    assert.equal(repeatedPause.rowCount, 1);
    assert.match(repeatedPause.rows[0].reason, /REPEATED_FAILURES/);

    // Depth guard: a matching event arriving at causation depth 5 ends
    // CHAIN_DEPTH_EXCEEDED and pauses its own chain.
    const away3 = await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: back2.revision, data: { [status.fieldId]: 'draft' } },
    });
    await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: away3.revision, data: { [status.fieldId]: 'active' } },
    });
    const deepEvent = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at DESC LIMIT 1`,
      [owner.tenantId, app.id, record.id],
    );
    await db.query(
      `UPDATE outbox SET causation_depth=5, root_causation_id=$3, automation_processed_at=NULL
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
      [owner.tenantId, app.id, deepEvent.rows[0].event_id, deepEvent.rows[0].event_id],
    );
    await engine.processOutbox(context);
    const depthRun = await db.query(
      `SELECT status FROM automation_runs
       WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3 AND status='CHAIN_DEPTH_EXCEEDED'`,
      [owner.tenantId, app.id, recordRule.rule.id],
    );
    assert.equal(depthRun.rowCount, 1);
    const paused = await db.query(
      `SELECT reason FROM automation_problem_chains
       WHERE tenant_id=$1 AND root_causation_id=$2 AND resumed_at IS NULL`,
      [owner.tenantId, deepEvent.rows[0].event_id],
    );
    assert.equal(paused.rowCount, 1);
    assert.equal(paused.rows[0].reason, 'CAUSATION_DEPTH_EXCEEDED');
  } finally {
    await db.end();
  }

  const pausedApi = await expectRequest(200, `/apps/${app.id}/automation/problem-chains`, { token });
  assert.ok(pausedApi.length >= 1);
  const root = pausedApi[0].rootCausationId;
  const resumed = await expectRequest(201, `/apps/${app.id}/automation/problem-chains/${root}/resume`, { token, method: 'POST' });
  assert.equal(resumed.resumed, true);
});
