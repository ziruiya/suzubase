const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

const emptyGroup = { operator: 'and', groups: [] };
const ruleConfig = (trigger, actions = [{ actionId: randomUUID(), type: 'NOTIFY' }]) => ({
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
    token, body: { name: 'Guardrail rule', config: ruleConfig({ eventType: 'workflow.transitioned', toStateId: randomUUID() }) },
  });
  await assert.rejects(
    expectRequest(400, `${base}/automation/rules/${saved.rule.id}/grants`, {
      token, body: {
        version: saved.version.version, sourceAppId: otherApp.id, readableFieldIds: [],
        targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
      },
    }),
  );

  const recordRule = await expectRequest(201, `${base}/automation/rules`, {
    token, body: { name: 'Record snapshot rule', config: {
      schemaVersion: 1,
      trigger: { eventType: 'record.updated', fieldId: status.fieldId, newValue: 'active' },
      conditions: {
        eventSnapshot: { operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'draft' }] }] },
        currentState: { operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'active' }] }] },
      },
      actions: [{ actionId: randomUUID(), type: 'NOTIFY' }],
    } },
  });
  await expectRequest(201, `${base}/automation/rules/${recordRule.rule.id}/grants`, {
    token, body: {
      version: recordRule.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    },
  });
  await expectRequest(200, `${base}/automation/rules/${recordRule.rule.id}/preflight`, {
    token, body: { version: recordRule.version.version },
  });
  await expectRequest(200, `${base}/automation/rules/${recordRule.rule.id}/publish`, {
    token, body: { version: recordRule.version.version },
  });
  await expectRequest(200, `${base}/automation/rules/${recordRule.rule.id}/enable`, {
    token, body: { enabled: true },
  });

  const record = await expectRequest(201, `${base}/records`, {
    token, body: { data: { [status.fieldId]: 'draft' } },
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
    await expectRequest(200, `${base}/records/${record.id}`, {
      token, method: 'PUT', body: { revision: updated.revision, data: { [status.fieldId]: 'active-2' } },
    });
    const causalEvents = await db.query(
      `SELECT o.event_id,o.root_causation_id FROM outbox o
       JOIN record_events e ON e.tenant_id=o.tenant_id AND e.app_id=o.app_id AND e.event_id=o.event_id
       WHERE o.tenant_id=$1 AND o.app_id=$2 AND e.record_id=$3
       ORDER BY o.created_at`,
      [owner.tenantId, app.id, record.id],
    );
    if (causalEvents.rows.length >= 2) {
      const root = causalEvents.rows[0].event_id;
      await db.query(
        `UPDATE outbox SET root_causation_id=$3,parent_run_id=NULL
         WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
        [owner.tenantId, app.id, root, causalEvents.rows[1].event_id],
      );
    }
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
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'backlog:'||n::text,'backlog:'||n::text,$6,$7,1,'QUEUED'
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
    const repeatedRoot = randomUUID();
    await db.query(
      `INSERT INTO automation_runs
        (tenant_id,app_id,id,rule_id,rule_version,event_id,trigger_identity,idempotency_key,record_id,
         root_causation_id,causation_depth,status)
       SELECT $1,$2,gen_random_uuid(),$3,$4,$5,'failed:'||n::text,'failed:'||n::text,$6,$7,1,'FAILED'
       FROM generate_series(1,3) n`,
      [owner.tenantId, app.id, recordRule.rule.id, recordRule.version.version, eventId, record.id, repeatedRoot],
    );
    await db.query(
      `UPDATE outbox SET automation_processed_at=NULL, root_causation_id=$3, causation_depth=1
       WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
      [owner.tenantId, app.id, repeatedRoot, eventId],
    );
    await engine.processOutbox(context);
    const repeatedPause = await db.query(
      `SELECT reason FROM automation_problem_chains
       WHERE tenant_id=$1 AND root_causation_id=$2 AND resumed_at IS NULL`,
      [owner.tenantId, repeatedRoot],
    );
    assert.equal(repeatedPause.rowCount, 1);
    assert.match(repeatedPause.rows[0].reason, /REPEATED_FAILURES/);
    const depthEvent = await db.query(
      `SELECT event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id=$3 ORDER BY occurred_at DESC LIMIT 1`,
      [owner.tenantId, app.id, record.id],
    );
    await db.query(
      `UPDATE outbox SET causation_depth=5, root_causation_id=$3 WHERE tenant_id=$1 AND app_id=$2 AND event_id=$4`,
      [owner.tenantId, app.id, depthEvent.rows[0].event_id, depthEvent.rows[0].event_id],
    );
    await db.query(
      `UPDATE outbox SET automation_processed_at=NULL WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
      [owner.tenantId, app.id, depthEvent.rows[0].event_id],
    );
    await engine.processOutbox(context);
    const paused = await db.query(
      `SELECT reason FROM automation_problem_chains WHERE tenant_id=$1 AND resumed_at IS NULL`,
      [owner.tenantId],
    );
    assert.ok(paused.rowCount >= 1);
  } finally {
    await db.end();
  }

  const pausedApi = await expectRequest(200, `/apps/${app.id}/automation/problem-chains`, { token });
  assert.ok(pausedApi.length >= 1);
  const root = pausedApi[0].rootCausationId;
  const resumed = await expectRequest(200, `/apps/${app.id}/automation/problem-chains/${root}/resume`, { token, method: 'POST' });
  assert.equal(resumed.resumed, true);
});
