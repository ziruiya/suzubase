const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

const emptyGroup = { operator: 'and', groups: [] };
const ruleConfig = (trigger, actions = [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientAssignee: true } }], currentState = emptyGroup, eventSnapshot = emptyGroup) => ({
  schemaVersion: 1, trigger, conditions: { eventSnapshot, currentState }, actions,
});

async function auditCount(tenantId, appId) {
  const client = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    const { rows: [row] } = await client.query(
      `SELECT (SELECT count(*) FROM automation_runs WHERE tenant_id=$1 AND app_id=$2) +
        (SELECT count(*) FROM automation_run_actions WHERE tenant_id=$1 AND app_id=$2) AS count`,
      [tenantId, appId],
    );
    return Number(row.count);
  } finally { await client.end(); }
}

test('P3-A binds record/workflow events separately, rechecks snapshot/current/grants, and persists idempotent terminal runs', async (t) => {
  configureRuntime();
  const { AppSchemaService } = require('../../../apps/api/dist/app-schema.js');
  const { AuthorizationService } = require('../../../apps/api/dist/authorization.js');
  const { AutomationService } = require('../../../apps/api/dist/automation.js');
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'automation-foundation');
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'automation_status', 'text');
  const write = (path, body, method = 'POST', code = 201) =>
    expectRequest(code, base + path, { token, body, method });
  await publish(token, app.id);

  const initial = { id: randomUUID(), code: 'draft', name: 'Draft', initial: true, terminal: false, assignees: [{ kind: 'creator' }] };
  const active = { id: randomUUID(), code: 'active', name: 'Active', initial: false, terminal: true, assignees: [] };
  const transition = { id: randomUUID(), name: 'Complete', fromStateId: initial.id, toStateId: active.id, conditions: [], assignees: [] };
  const reject = { ...transition, id: randomUUID(), name: 'Return', eventType: 'rejected' };
  await write('/workflow/draft', { states: [initial, active], actions: [transition, reject] }, 'PUT', 200);
  await write('/workflow/publish');
  await write('/workflow/enabled', { enabled: true }, 'PATCH', 200);

  const makeRule = async (name, config, grant) => {
    const saved = await write('/automation/rules', { name, config });
    const version = saved.version.version;
    await write(`/automation/rules/${saved.rule.id}/grants`, { version, ...grant });
    assert.equal((await write(`/automation/rules/${saved.rule.id}/preflight`, { version })).publishable, true);
    await write(`/automation/rules/${saved.rule.id}/publish`, { version });
    await write(`/automation/rules/${saved.rule.id}/enable`, { enabled: true });
    return { id: saved.rule.id, version };
  };
  const sourceGrant = {
    sourceAppId: app.id, readableFieldIds: [status.fieldId], targetAppIds: [],
    writableFieldIds: [], allowedOperations: ['NOTIFY'],
  };
  const recordRule = await makeRule('Record field transition', ruleConfig({
    eventType: 'record.updated', fieldId: status.fieldId, newValue: 'active',
  }, undefined, {
    operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'active' }] }],
  }, {
    operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'active' }] }],
  }), sourceGrant);
  const workflowRule = await makeRule('Workflow transition', ruleConfig({
    eventType: 'workflow.transitioned', toStateId: active.id,
  }), { ...sourceGrant, readableFieldIds: [] });
  const rejectedRule = await makeRule('Workflow rejection', ruleConfig({
    eventType: 'workflow.rejected', toStateId: active.id,
  }), { ...sourceGrant, readableFieldIds: [] });

  const record = await write('/records', { data: { [status.fieldId]: 'draft' } });
  const beforeDryRun = await auditCount(owner.tenantId, app.id);
  const preview = await write(`/automation/rules/${recordRule.id}/dry-run`, {
    version: recordRule.version, recordId: record.id,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.sideEffects, false);
  assert.equal(preview.wouldRun, false);
  assert.equal(await auditCount(owner.tenantId, app.id), beforeDryRun, 'dry-run persists no runs or actions');
  await write(`/records/${record.id}`, { revision: record.revision, data: { [status.fieldId]: 'active' } }, 'PUT', 200);
  const updated = await write(`/records/${record.id}`, { revision: record.revision + 1, data: { [status.fieldId]: 'closed' } }, 'PUT', 200);

  const authorization = new AuthorizationService();
  const engine = new AutomationService(new AppSchemaService(authorization), authorization);
  const context = { tenantId: owner.tenantId, userId: owner.userId };
  const firstProcess = await engine.processOutbox(context);
  assert.ok(firstProcess.events >= 3);
  const audit = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await audit.connect();
  try {
    const stale = await audit.query(
      `SELECT status FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3 AND status='SKIPPED_STALE'`,
      [owner.tenantId, app.id, recordRule.id],
    );
    assert.equal(stale.rowCount, 1, 'event snapshot matched, but changed current state must be stale');
    const bound = await audit.query(
      `SELECT trigger_identity, status, rule_version FROM automation_runs
       WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, workflowRule.id],
    );
    assert.equal(bound.rowCount, 0, 'a record update cannot accidentally invoke the T-2 rule');

    const workflow = await expectRequest(200, `${base}/records/${record.id}/workflow`, { token });
    const response = await write(`/records/${record.id}/workflow/actions`, {
      action_id: transition.id, revision: updated.revision,
    });
    assert.equal(response.state.id, active.id);
    const secondProcess = await engine.processOutbox(context);
    assert.ok(secondProcess.createdRuns >= 1);
    const workflowRuns = await audit.query(
      `SELECT trigger_identity, status, rule_version, root_causation_id, causation_depth
       FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, workflowRule.id],
    );
    assert.equal(workflowRuns.rowCount, 1);
    assert.match(workflowRuns.rows[0].trigger_identity, /^workflow\.transitioned:/);
    assert.equal(workflowRuns.rows[0].status, 'SUCCEEDED');
    assert.equal(workflowRuns.rows[0].rule_version, workflowRule.version);
    assert.equal(workflowRuns.rows[0].causation_depth, 1);
    assert.ok(workflowRuns.rows[0].root_causation_id);
    const action = await audit.query(
      `SELECT status, error_code, idempotency_key FROM automation_run_actions
       WHERE tenant_id=$1 AND app_id=$2 AND run_id IN
         (SELECT id FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3)`,
      [owner.tenantId, app.id, workflowRule.id],
    );
    assert.equal(action.rowCount, 1);
    assert.equal(action.rows[0].status, 'SUCCEEDED');
    assert.equal(action.rows[0].error_code, null);
    const rejectedRecord = await write('/records', { data: { [status.fieldId]: 'draft' } });
    const rejectResult = await write(`/records/${rejectedRecord.id}/workflow/actions`, {
      action_id: reject.id, revision: rejectedRecord.revision,
    });
    assert.equal(rejectResult.state.id, active.id);
    await engine.processOutbox(context);
    const rejectedRuns = await audit.query(
      `SELECT trigger_identity FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3`,
      [owner.tenantId, app.id, rejectedRule.id],
    );
    assert.equal(rejectedRuns.rowCount, 1);
    assert.match(rejectedRuns.rows[0].trigger_identity, /^workflow\.rejected:/);
    assert.equal((await engine.processOutbox(context)).createdRuns, 0, 'replaying the worker is idempotent');
    await assert.rejects(audit.query(
      `UPDATE automation_rule_versions SET status='archived' WHERE tenant_id=$1 AND rule_id=$2 AND version=$3`,
      [owner.tenantId, workflowRule.id, workflowRule.version],
    ), /immutable/);
    const auditRows = await audit.query(
      `SELECT action FROM automation_audit_events WHERE tenant_id=$1 AND rule_id=$2`,
      [owner.tenantId, workflowRule.id],
    );
    assert.ok(auditRows.rows.some(({ action }) => action === 'GRANT_APPROVED'));
    assert.ok(auditRows.rows.some(({ action }) => action === 'PUBLISHED'));

    const grants = await audit.query(
      `SELECT id FROM automation_grants WHERE tenant_id=$1 AND rule_id=$2 AND rule_version=$3`,
      [owner.tenantId, recordRule.id, recordRule.version],
    );
    await write(`/automation/rules/${recordRule.id}/grants/${grants.rows[0].id}/revoke`, undefined);
    await write(`/records/${record.id}`, { revision: response.revision, data: { [status.fieldId]: 'active' } }, 'PUT', 200);
    await engine.processOutbox(context);
    const revoked = await audit.query(
      `SELECT status FROM automation_runs WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3 AND status='SKIPPED_UNAUTHORIZED'`,
      [owner.tenantId, app.id, recordRule.id],
    );
    assert.equal(revoked.rowCount, 1, 'revoked grants are rechecked at execution time');

    const cycle = await write('/automation/rules', {
      name: 'Deterministic cycle',
      config: ruleConfig({ eventType: 'record.created' }, [{
        actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: app.id,
        targetFieldIds: [status.fieldId],
        mappings: [{ targetFieldId: status.fieldId, mode: 'constant', value: 'cycle' }],
      }]),
    });

    await write(`/automation/rules/${cycle.rule.id}/grants`, {
      version: cycle.version.version, sourceAppId: app.id, readableFieldIds: [],
      targetAppIds: [app.id], writableFieldIds: [], allowedOperations: ['CREATE_RECORD'],
    });
    const cyclePreflight = await write(`/automation/rules/${cycle.rule.id}/preflight`, { version: cycle.version.version });
    assert.equal(cyclePreflight.publishable, false);
    assert.ok(cyclePreflight.findings.some(({ code }) => code === 'BLOCKING_CYCLE'));
    await write(`/automation/rules/${cycle.rule.id}/publish`, { version: cycle.version.version }, 'POST', 409);

    const potential = await write('/automation/rules', {
      name: 'Conditionally terminating cycle',
      config: ruleConfig({ eventType: 'record.updated', fieldId: status.fieldId, newValue: 'active' }, [{
        actionId: randomUUID(), type: 'UPDATE_FIELDS', targetFieldIds: [status.fieldId],
        updates: [{ fieldId: status.fieldId, mode: 'set', value: 'active' }],
      }], {
        operator: 'and', groups: [{ conditions: [{ fieldId: status.fieldId, operator: 'eq', value: 'active' }] }],
      }),
    });
    await write(`/automation/rules/${potential.rule.id}/grants`, {
      version: potential.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [app.id], writableFieldIds: [status.fieldId], allowedOperations: ['UPDATE_FIELDS'],
    });
    const warning = await write(`/automation/rules/${potential.rule.id}/preflight`, { version: potential.version.version });
    assert.equal(warning.publishable, true);
    assert.ok(warning.findings.some(({ code }) => code === 'POTENTIAL_CYCLE' && code !== 'BLOCKING_CYCLE'));

    const depthRule = await makeRule('Chain depth boundary', ruleConfig({ eventType: 'record.created' }), {
      sourceAppId: app.id, readableFieldIds: [], targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
    });
    const depthFiveRecord = await write('/records', { data: { [status.fieldId]: 'draft' } });
    const depthSixRecord = await write('/records', { data: { [status.fieldId]: 'draft' } });
    const eventRows = await audit.query(
      `SELECT record_id, event_id FROM record_events WHERE tenant_id=$1 AND app_id=$2 AND record_id IN ($3,$4)`,
      [owner.tenantId, app.id, depthFiveRecord.id, depthSixRecord.id],
    );
    const eventByRecord = new Map(eventRows.rows.map(({ record_id, event_id }) => [record_id, event_id]));
    await audit.query(
      `UPDATE outbox SET causation_depth=4 WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
      [owner.tenantId, app.id, eventByRecord.get(depthFiveRecord.id)],
    );
    await audit.query(
      `UPDATE outbox SET causation_depth=5 WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
      [owner.tenantId, app.id, eventByRecord.get(depthSixRecord.id)],
    );
    await engine.processOutbox(context);
    const depthRuns = await audit.query(
      `SELECT record_id, status, causation_depth FROM automation_runs
       WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3 AND record_id IN ($4,$5)`,
      [owner.tenantId, app.id, depthRule.id, depthFiveRecord.id, depthSixRecord.id],
    );
    assert.equal(depthRuns.rowCount, 2);
    assert.ok(depthRuns.rows.some(({ record_id, status, causation_depth }) =>
      record_id === depthFiveRecord.id && status === 'SUCCEEDED' && causation_depth === 5));
    assert.ok(depthRuns.rows.some(({ record_id, status, causation_depth }) =>
      record_id === depthSixRecord.id && status === 'CHAIN_DEPTH_EXCEEDED' && causation_depth === 6));
    const depthNotice = await audit.query(
      `SELECT source_type FROM notifications WHERE tenant_id=$1 AND event_type='AUTOMATION_CHAIN_DEPTH_EXCEEDED'`,
      [owner.tenantId],
    );
    assert.ok(depthNotice.rows.some(({ source_type }) => source_type === 'SYSTEM'));
    t.diagnostic(JSON.stringify({
      stale: stale.rowCount, workflowEventBinding: workflowRuns.rows[0].trigger_identity,
      workflowRejectionBinding: rejectedRuns.rows[0].trigger_identity,
      runStatus: workflowRuns.rows[0].status, actionStatus: action.rows[0].status,
      revokedGrant: revoked.rowCount, deterministicCycle: cyclePreflight.publishable,
      potentialCycle: warning.publishable, depthFiveRuns: 1, depthSixBlocked: 1, chainNotice: depthNotice.rowCount,
    }));
  } finally {
    await audit.end();
  }
});
