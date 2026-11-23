const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { unzipSync, zipSync, strToU8, strFromU8 } = require(require.resolve('fflate', { paths: [__dirname + '/../../../apps/api'] }));
const { verifyPackage } = require('../../../apps/api/dist/export-package.js');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

// P3-D wave 2 (M1 automation export/import, brief S7 + V-08 + S8.3):
// rules travel inside the M1 package as disabled drafts; webhook secrets
// never enter the package; grants are requirements only; references are
// remapped or explicitly unresolved; schedules are recomputed by the
// target, never copied; importing produces zero runs/notifications/
// deliveries; a remediated rule walks preflight -> publish -> enable.
configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';
const HOOK_SECRET = 'whsec-m1-export-must-not-leak';
const emptyGroup = { operator: 'and', groups: [] };
const ruleConfig = (trigger, actions) => ({
  schemaVersion: 1, trigger, conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup }, actions,
});
const writer = (token, base) => (path, body, method = 'POST', code = 201) =>
  expectRequest(code, base + path, { token, body, method });

async function dbClient() {
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  return db;
}
async function raw(token, path, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
    },
    body, signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: response.status, body: parsed, raw: text };
}
async function exportApp(token, appId) {
  const job = await expectRequest(201, `/apps/${appId}/exports`, { token, method: 'POST' });
  const run = await expectRequest(201, `/apps/${appId}/exports/${job.id}/run`, { token, method: 'POST' });
  assert.equal(run.status, 'sealed', JSON.stringify(run));
  const response = await fetch(new URL(`/apps/${appId}/exports/${job.id}/package`, origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}
async function stageImport(targetToken, archive, mappings = {}) {
  const uploaded = await raw(targetToken, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream',
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const job = uploaded.body;
  if (Object.keys(mappings).length) {
    await expectRequest(200, `/imports/${job.id}/mappings`, { token: targetToken, method: 'PUT', body: mappings });
  }
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  return { job, issued };
}
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
  return new AutomationService(schema, authorization, records,
    new WorkflowRuntimeService(schema, authorization, planner));
}

// Source environment: app B (A-3 target), app A with a workflow, a webhook
// endpoint with a secret, and three published+enabled rules covering
// A-1..A-5, a date-relative trigger and a fixed cadence trigger.
async function buildSource() {
  const owner = await provision({ isAdmin: true });
  const member = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const appB = await createApp(token, 'p3dm1-tickets-' + randomUUID().slice(0, 6));
  const titleB = await addField(token, appB.id, 'm1_ticket_title', 'text');
  await publish(token, appB.id);

  const app = await createApp(token, 'p3dm1-cases-' + randomUUID().slice(0, 6));
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'm1_title', 'text');
  const status = await addField(token, app.id, 'm1_status', 'text');
  const due = await addField(token, app.id, 'm1_due', 'date');
  const assignee = await addField(token, app.id, 'm1_assignee', 'user');
  await publish(token, app.id);

  const open = { id: randomUUID(), code: 'open', name: 'Open', initial: true, terminal: false, assignees: [{ kind: 'creator' }] };
  const review = { id: randomUUID(), code: 'review', name: 'Review', initial: false, terminal: true, assignees: [] };
  const autoMove = { id: randomUUID(), name: 'Auto move', fromStateId: open.id, toStateId: review.id, conditions: [], assignees: [], automationAllowed: true };
  await write('/workflow/draft', { states: [open, review], actions: [autoMove] }, 'PUT', 200);
  await write('/workflow/publish');
  await write('/workflow/enabled', { enabled: true }, 'PATCH', 200);

  const endpoint = await write('/automation/webhook-endpoints', {
    name: 'M1 hook', url: 'https://93.184.216.34/hook', policy: 'AUTO_RETRY_AT_LEAST_ONCE', secret: HOOK_SECRET,
  });
  assert.equal(endpoint.validated, true);

  // NOTE (existing P3 grant model): one grant's writableFieldIds are
  // validated against its target applications, so own-app field writes
  // and cross-app creates live on two rules. Together they cover A-1..A-5.
  const comboLocal = await write('/automation/rules', {
    name: 'Combo local A1 A2 A4 A5', config: ruleConfig({ eventType: 'record.created', allowManual: true }, [
      { actionId: randomUUID(), type: 'NOTIFY', notify: {
        recipientUserIds: [member.userId], recipientFieldId: assignee.fieldId,
        title: 'New {{' + title.fieldId + '}}', body: 'Case created' } },
      { actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [
        { fieldId: status.fieldId, mode: 'set', value: 'triaged' } ] },
      { actionId: randomUUID(), type: 'ADVANCE_WORKFLOW', workflowActionId: autoMove.id },
      { actionId: randomUUID(), type: 'WEBHOOK', webhook: { endpointId: endpoint.id } },
    ]),
  });
  await write(`/automation/rules/${comboLocal.rule.id}/grants`, {
    version: comboLocal.version.version, sourceAppId: app.id,
    readableFieldIds: [title.fieldId, status.fieldId, assignee.fieldId, due.fieldId],
    targetAppIds: [], writableFieldIds: [status.fieldId],
    allowedOperations: ['NOTIFY', 'UPDATE_FIELDS', 'ADVANCE_WORKFLOW', 'WEBHOOK'],
  });
  await write(`/automation/rules/${comboLocal.rule.id}/publish`, { version: comboLocal.version.version });
  await write(`/automation/rules/${comboLocal.rule.id}/enable`, { enabled: true });
  const comboCross = await write('/automation/rules', {
    name: 'Combo cross A3', config: ruleConfig({ eventType: 'record.created' }, [
      { actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: appB.id, mappings: [
        { targetFieldId: titleB.fieldId, mode: 'source', sourceFieldId: title.fieldId } ] },
    ]),
  });
  await write(`/automation/rules/${comboCross.rule.id}/grants`, {
    version: comboCross.version.version, sourceAppId: app.id,
    readableFieldIds: [title.fieldId], targetAppIds: [appB.id], writableFieldIds: [titleB.fieldId],
    allowedOperations: ['CREATE_RECORD'],
  });
  await write(`/automation/rules/${comboCross.rule.id}/publish`, { version: comboCross.version.version });
  await write(`/automation/rules/${comboCross.rule.id}/enable`, { enabled: true });
  const combo = comboLocal;

  const reminder = await write('/automation/rules', {
    name: 'Due reminder', config: ruleConfig({
      eventType: 'schedule.dateRelative',
      dateRelative: { source: 'field', fieldId: due.fieldId, offsetDays: -3, localTime: '09:00', timezone: 'Asia/Tokyo' },
    }, [{ actionId: randomUUID(), type: 'NOTIFY', notify: {
      recipientUserIds: [owner.userId], title: 'Due soon', body: 'Check the case' } }]),
  });
  await write(`/automation/rules/${reminder.rule.id}/grants`, {
    version: reminder.version.version, sourceAppId: app.id, readableFieldIds: [due.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
  });
  await write(`/automation/rules/${reminder.rule.id}/publish`, { version: reminder.version.version });
  await write(`/automation/rules/${reminder.rule.id}/enable`, { enabled: true });

  const daily = await write('/automation/rules', {
    name: 'Daily digest', config: ruleConfig({
      eventType: 'schedule.fixed',
      schedule: { cadence: 'daily', localTime: '09:00', timezone: 'Asia/Tokyo', missedRunPolicy: 'skip' },
    }, [{ actionId: randomUUID(), type: 'NOTIFY', notify: {
      recipientUserIds: [owner.userId], title: 'Digest', body: 'Daily' } }]),
  });
  await write(`/automation/rules/${daily.rule.id}/grants`, {
    version: daily.version.version, sourceAppId: app.id, readableFieldIds: [title.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
  });
  await write(`/automation/rules/${daily.rule.id}/publish`, { version: daily.version.version });
  await write(`/automation/rules/${daily.rule.id}/enable`, { enabled: true });

  const record = await write('/records', { data: {
    [title.fieldId]: 'Case-1', [status.fieldId]: 'new',
    [due.fieldId]: '2027-01-10', [assignee.fieldId]: owner.userId,
  } });
  // Let the source engine create the date-relative plan for the record, so
  // the test can prove the target does NOT inherit the source plan row.
  const engine = buildEngine();
  await engine.processDateRelativeSchedules({ tenantId: owner.tenantId, userId: owner.userId }, { now: new Date() });

  const db = await dbClient();
  let sourceSecretEnc; let sourceSchedules; let sourceCadence;
  try {
    const enc = await db.query('SELECT secret_enc FROM automation_webhook_endpoints WHERE tenant_id=$1', [owner.tenantId]);
    sourceSecretEnc = enc.rows[0].secret_enc;
    sourceSchedules = (await db.query(
      'SELECT count(*)::int AS n FROM automation_schedules WHERE tenant_id=$1', [owner.tenantId])).rows[0].n;
    sourceCadence = (await db.query(
      'SELECT count(*)::int AS n FROM automation_cadence_plans WHERE tenant_id=$1 AND status=$2',
      [owner.tenantId, 'ACTIVE'])).rows[0].n;
  } finally { await db.end(); }
  assert.ok(sourceSecretEnc && sourceSecretEnc.length > 20, 'source endpoint stores ciphertext at rest');
  assert.ok(sourceSchedules >= 1, 'source has a date-relative plan row for the record');
  assert.ok(sourceCadence >= 1, 'source has an active cadence plan');

  const archiveB = await exportApp(token, appB.id);
  const archive = await exportApp(token, app.id);
  return { owner, member, token, app, appB, titleB, fields: { title, status, due, assignee },
    endpoint, rules: { combo: combo.rule, reminder: reminder.rule, daily: daily.rule },
    autoMove, record, archive, archiveB, sourceSecretEnc };
}

test('P3-D wave2 roundtrip: export carries automation without secrets; import lands disabled drafts, remapped, grant-free, placeholder endpoint, zero side effects', async () => {
  const source = await buildSource();

  // ---- package-level assertions -------------------------------------------
  const entries = unzipSync(new Uint8Array(source.archive));
  const automation = JSON.parse(strFromU8(entries['data/automation.json']));
  assert.equal(automation.schemaVersion, 1);
  assert.equal(automation.rules.length, 4);
  assert.equal(automation.endpoints.length, 1);
  assert.equal(automation.endpoints[0].url, 'https://93.184.216.34/hook');
  assert.equal(automation.endpoints[0].policy, 'AUTO_RETRY_AT_LEAST_ONCE');
  assert.equal(automation.endpoints[0].credentialRequired, true);
  const comboPkg = automation.rules.find((rule) => rule.sourceRuleId === source.rules.combo.id);
  assert.deepEqual(comboPkg.versions[0].actions.map((action) => action.type),
    ['NOTIFY', 'UPDATE_FIELDS', 'ADVANCE_WORKFLOW', 'WEBHOOK']);
  const crossPkg = automation.rules.find((rule) => rule.versions[0].actions.some((a) => a.type === 'CREATE_RECORD'));
  assert.ok(crossPkg, 'the A-3 cross-app rule is in the package');
  const allTypes = automation.rules.flatMap((rule) => rule.versions[0].actions.map((a) => a.type));
  for (const type of ['NOTIFY', 'UPDATE_FIELDS', 'CREATE_RECORD', 'ADVANCE_WORKFLOW', 'WEBHOOK']) {
    assert.ok(allTypes.includes(type), `package covers action ${type}`);
  }
  assert.equal(comboPkg.versions[0].grantRequirement.allowedOperations.length, 4);
  const wholeText = Object.values(entries).map((bytes) => Buffer.from(bytes).toString('utf8')).join('\n');
  assert.ok(!wholeText.includes(HOOK_SECRET), 'plaintext webhook secret must never enter the package');
  assert.ok(!wholeText.includes(source.sourceSecretEnc), 'webhook secret ciphertext must never enter the package');
  assert.ok(!wholeText.includes('secretEnc'), 'no secret material field of any kind in the package');
  assert.deepEqual(verifyPackage(source.archive).problems, []);

  // ---- target environment --------------------------------------------------
  const admin = await provision({ isAdmin: true });
  const member = await provision({ tenantId: admin.tenantId });
  const adminToken = await login(admin);
  const userMapping = { users: { [source.owner.userId]: admin.userId, [source.member.userId]: member.userId } };

  const importB = await stageImport(adminToken, source.archiveB, userMapping);
  const runB = await expectRequest(201, `/imports/${importB.job.id}/run`, { token: importB.issued.token, method: 'POST' });
  assert.equal(runB.completion, 'complete', JSON.stringify(runB.pending));
  await expectRequest(201, `/imports/${importB.job.id}/activate`, { token: adminToken, method: 'POST' });
  const targetAppB = runB.targetAppId;

  const imp = await stageImport(adminToken, source.archive, userMapping);
  // Dry-run preview before the real import: same shape as the result.
  const dry = await expectRequest(201, `/imports/${imp.job.id}/automation-dry-run`, { token: adminToken, method: 'POST' });
  assert.equal(dry.willCreate.rules, 4);
  assert.equal(dry.willCreate.ruleVersions, 4);
  assert.equal(dry.willCreate.webhookEndpoints, 1);
  assert.deepEqual(dry.unresolved, [], JSON.stringify(dry.unresolved));
  assert.ok(dry.manualActions.some((entry) => entry.kind === 'webhook-credential'));
  assert.equal(dry.manualActions.filter((entry) => entry.kind === 'grant-reauthorization').length, 4);
  assert.equal(dry.grantsEffective, false);
  assert.equal(dry.rulesEnabled, false);
  assert.ok(Array.isArray(dry.cycleFindings));

  const run = await expectRequest(201, `/imports/${imp.job.id}/run`, { token: imp.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  assert.equal(run.completion, 'complete', JSON.stringify(run.pending?.automation));
  const targetAppId = run.targetAppId;
  assert.ok(run.pending.automation, 'automation pending section present');
  assert.equal(run.pending.automation.rules.length, 4);
  assert.deepEqual(run.pending.automation.unresolved, []);
  assert.equal(run.pending.automation.credentialsPending.length, 1);
  assert.equal(run.pending.automation.grantRequirements.length, 4);
  // P3 closure C5: the import-completion UI renders exactly this
  // pending.automation.manualActions list (data source for the visible
  // "Manual actions required after import" block in import-export.tsx).
  assert.ok(Array.isArray(run.pending.automation.manualActions), 'manualActions list present on the job pending payload the UI renders');
  assert.equal(run.pending.automation.manualActions.length, 5, 'manualActions = 1 webhook credential + 4 grant re-approvals');
  assert.equal(run.pending.automation.manualActions.filter((entry) => entry.kind === 'webhook-credential').length, 1);
  assert.equal(run.pending.automation.manualActions.filter((entry) => entry.kind === 'grant-reauthorization').length, 4);
  const credentialAction = run.pending.automation.manualActions.find((entry) => entry.kind === 'webhook-credential');
  assert.ok(credentialAction.name && credentialAction.url, 'credential action carries the endpoint name/url the UI lists');
  assert.ok(run.report.automation, 'report carries the automation section');
  assert.equal(run.report.automation.rulesImported, 4);
  assert.equal(run.report.automation.rulesEnabled, 0);
  assert.equal(run.report.automation.grantsEffective, 0);
  assert.ok(run.report.difference.notInherited.some((entry) => entry.item === 'webhook credential'));
  assert.ok(run.report.difference.notInherited.some((entry) => entry.item === 'automation grant'));

  const targetApp = await expectRequest(200, '/apps/' + targetAppId, { token: adminToken }).catch(() => null);
  void targetApp; // staged app is isolated until activation; DB checks below are authoritative
  const db = await dbClient();
  try {
    const t = admin.tenantId;
    const rules = await db.query(
      'SELECT id, enabled, current_version FROM automation_rules WHERE tenant_id=$1 AND app_id=$2', [t, targetAppId]);
    assert.equal(rules.rowCount, 4);
    for (const row of rules.rows) {
      assert.equal(row.enabled, false, 'imported rule is disabled');
      assert.equal(row.current_version, null, 'imported rule has no effective published version');
    }
    const versions = await db.query(
      'SELECT status, trigger_json, condition_json, actions_json FROM automation_rule_versions WHERE tenant_id=$1 AND app_id=$2',
      [t, targetAppId]);
    assert.equal(versions.rowCount, 4);
    for (const row of versions.rows) assert.equal(row.status, 'draft', 'imported versions are drafts');
    const grants = await db.query(
      'SELECT count(*)::int AS n FROM automation_grants WHERE tenant_id=$1', [t]);
    assert.equal(grants.rows[0].n, 0, 'no grant becomes effective on import');
    const endpoints = await db.query(
      'SELECT id, url, policy, secret_enc, credential_pending, validated_url_hash FROM automation_webhook_endpoints WHERE tenant_id=$1 AND app_id=$2',
      [t, targetAppId]);
    assert.equal(endpoints.rowCount, 1);
    assert.equal(endpoints.rows[0].credential_pending, true);
    assert.equal(endpoints.rows[0].secret_enc, '', 'placeholder endpoint carries no secret material');
    assert.equal(endpoints.rows[0].validated_url_hash, null);
    const targetEndpointId = endpoints.rows[0].id;
    assert.notEqual(targetEndpointId, source.endpoint.id);

    // Zero side effects (V-08): no runs, no notifications, no deliveries,
    // no outbox rows, no copied schedule rows in the target application.
    for (const [table, label] of [
      ['automation_runs', 'runs'], ['automation_webhook_deliveries', 'deliveries'],
      ['automation_schedules', 'date-relative schedules'], ['automation_cadence_plans', 'cadence plans'],
      ['outbox', 'outbox rows'],
    ]) {
      const counted = await db.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1 AND app_id=$2`, [t, targetAppId]);
      assert.equal(counted.rows[0].n, 0, `import produced zero ${label}`);
    }
    const notices = await db.query(
      'SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1 AND app_id=$2', [t, targetAppId]);
    assert.equal(notices.rows[0].n, 0, 'import produced zero notifications');

    // Remapping: every reference points at target-environment ids.
    const targetFields = await db.query(
      'SELECT field_id, code FROM fields WHERE tenant_id=$1 AND app_id=$2', [t, targetAppId]);
    const fieldByCode = new Map(targetFields.rows.map((row) => [row.code, row.field_id]));
    const targetFieldsB = await db.query(
      'SELECT field_id, code FROM fields WHERE tenant_id=$1 AND app_id=$2', [t, targetAppB]);
    const titleBTarget = targetFieldsB.rows.find((row) => row.code === 'm1_ticket_title').field_id;
    const wfActions = await db.query(
      'SELECT id FROM workflow_actions WHERE tenant_id=$1 AND app_id=$2', [t, targetAppId]);
    const targetWfActionIds = new Set(wfActions.rows.map((row) => row.id));
    const comboVersion = versions.rows.find((row) =>
      row.actions_json.some((action) => action.type === 'WEBHOOK'));
    const byType = new Map(comboVersion.actions_json.map((action) => [action.type, action]));
    const crossVersion = versions.rows.find((row) =>
      row.actions_json.some((action) => action.type === 'CREATE_RECORD'));
    const createAction = crossVersion.actions_json.find((action) => action.type === 'CREATE_RECORD');
    assert.equal(createAction.targetAppId, targetAppB, 'cross-app target remapped to the restored app');
    assert.equal(createAction.mappings[0].targetFieldId, titleBTarget);
    assert.equal(createAction.mappings[0].sourceFieldId, fieldByCode.get('m1_title'));
    assert.equal(byType.get('UPDATE_FIELDS').updates[0].fieldId, fieldByCode.get('m1_status'));
    assert.deepEqual(byType.get('NOTIFY').notify.recipientUserIds, [member.userId], 'recipient user remapped');
    assert.equal(byType.get('NOTIFY').notify.recipientFieldId, fieldByCode.get('m1_assignee'));
    assert.ok(byType.get('NOTIFY').notify.title.includes(fieldByCode.get('m1_title')), 'template field remapped');
    assert.equal(byType.get('WEBHOOK').webhook.endpointId, targetEndpointId, 'endpoint reference remapped to the placeholder');
    assert.ok(targetWfActionIds.has(byType.get('ADVANCE_WORKFLOW').workflowActionId), 'workflow action remapped');
    assert.notEqual(byType.get('ADVANCE_WORKFLOW').workflowActionId, source.autoMove.id);
    const reminderVersion = versions.rows.find((row) => row.trigger_json.eventType === 'schedule.dateRelative');
    assert.equal(reminderVersion.trigger_json.dateRelative.fieldId, fieldByCode.get('m1_due'),
      'date-relative trigger field remapped');

    // Cycle re-check ran in the target and recorded a conclusion.
    assert.ok(Array.isArray(run.pending.automation.cycleFindings));
    assert.ok(!run.pending.automation.cycleFindings.some((finding) => finding.severity === 'BLOCKING'));

    // ---- remediation + re-enable path --------------------------------------
    const comboTarget = run.pending.automation.rules
      .find((rule) => rule.sourceRuleId === source.rules.combo.id);
    const targetBase = '/apps/' + targetAppId;
    await expectRequest(201, `/imports/${imp.job.id}/activate`, { token: adminToken, method: 'POST' });
    // Grant first: preflight must still block on the missing credential.
    await expectRequest(201, `${targetBase}/automation/rules/${comboTarget.targetRuleId}/grants`, {
      token: adminToken, method: 'POST', body: {
        version: 1, sourceAppId: targetAppId,
        readableFieldIds: [fieldByCode.get('m1_title'), fieldByCode.get('m1_status'),
          fieldByCode.get('m1_assignee'), fieldByCode.get('m1_due')],
        targetAppIds: [], writableFieldIds: [fieldByCode.get('m1_status')],
        allowedOperations: ['NOTIFY', 'UPDATE_FIELDS', 'ADVANCE_WORKFLOW', 'WEBHOOK'],
      },
    });
    const blockedPreflight = await expectRequest(201,
      `${targetBase}/automation/rules/${comboTarget.targetRuleId}/preflight`,
      { token: adminToken, method: 'POST', body: { version: 1 } });
    assert.equal(blockedPreflight.publishable, false);
    assert.ok(blockedPreflight.findings.some((finding) => finding.code === 'WEBHOOK_CREDENTIAL_REQUIRED'),
      JSON.stringify(blockedPreflight.findings));
    // Supply the secret through the existing rotation route, then validate.
    const rotated = await expectRequest(201,
      `${targetBase}/automation/webhook-endpoints/${targetEndpointId}/rotate-secret`,
      { token: adminToken, method: 'POST', body: { secret: 'whsec-target-supplied-secret' } });
    assert.equal(rotated.credentialPending, false);
    assert.equal(rotated.secretSet, true);
    const validatedEndpoint = await expectRequest(201,
      `${targetBase}/automation/webhook-endpoints/${targetEndpointId}/validate`,
      { token: adminToken, method: 'POST' });
    assert.equal(validatedEndpoint.validated, true);
    const preflight = await expectRequest(201,
      `${targetBase}/automation/rules/${comboTarget.targetRuleId}/preflight`,
      { token: adminToken, method: 'POST', body: { version: 1 } });
    assert.equal(preflight.publishable, true, JSON.stringify(preflight.findings));
    await expectRequest(201, `${targetBase}/automation/rules/${comboTarget.targetRuleId}/publish`,
      { token: adminToken, method: 'POST', body: { version: 1 } });
    const enabled = await expectRequest(201, `${targetBase}/automation/rules/${comboTarget.targetRuleId}/enable`,
      { token: adminToken, method: 'POST', body: { enabled: true } });
    assert.equal(enabled.enabled, true);

    // Schedule recomputation: enabling the imported daily rule creates a
    // fresh cadence plan in the target; enabling the date-relative rule
    // plus a worker pass creates plans bound to TARGET record/rule ids.
    const dailyTarget = run.pending.automation.rules
      .find((rule) => rule.sourceRuleId === source.rules.daily.id);
    const reminderTarget = run.pending.automation.rules
      .find((rule) => rule.sourceRuleId === source.rules.reminder.id);
    for (const [target, readable] of [
      [dailyTarget, [fieldByCode.get('m1_title')]],
      [reminderTarget, [fieldByCode.get('m1_due')]],
    ]) {
      await expectRequest(201, `${targetBase}/automation/rules/${target.targetRuleId}/grants`, {
        token: adminToken, method: 'POST', body: {
          version: 1, sourceAppId: targetAppId, readableFieldIds: readable,
          targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
        },
      });
      await expectRequest(201, `${targetBase}/automation/rules/${target.targetRuleId}/publish`,
        { token: adminToken, method: 'POST', body: { version: 1 } });
      await expectRequest(201, `${targetBase}/automation/rules/${target.targetRuleId}/enable`,
        { token: adminToken, method: 'POST', body: { enabled: true } });
    }
    const engine = buildEngine();
    await engine.processDateRelativeSchedules(
      { tenantId: admin.tenantId, userId: admin.userId }, { now: new Date() });
    const plans = await db.query(
      'SELECT rule_id FROM automation_cadence_plans WHERE tenant_id=$1 AND app_id=$2 AND status=$3',
      [t, targetAppId, 'ACTIVE']);
    assert.ok(plans.rows.some((row) => row.rule_id === dailyTarget.targetRuleId),
      'cadence plan recomputed in the target for the imported daily rule');
    const datePlans = await db.query(
      'SELECT rule_id, record_id, due_at FROM automation_schedules WHERE tenant_id=$1 AND app_id=$2 AND rule_id=$3',
      [t, targetAppId, reminderTarget.targetRuleId]);
    assert.ok(datePlans.rowCount >= 1, 'date-relative plan recomputed from target records');
    const targetRecord = await db.query(
      'SELECT id FROM records WHERE tenant_id=$1 AND app_id=$2 LIMIT 1', [t, targetAppId]);
    assert.equal(datePlans.rows[0].record_id, targetRecord.rows[0].id,
      'plan binds the TARGET record id, not a copied source row');
    assert.equal(new Date(datePlans.rows[0].due_at).toISOString(), '2027-01-07T00:00:00.000Z',
      'due = target record date 2027-01-10 minus 3 days at 09:00 Asia/Tokyo');
  } finally { await db.end(); }
});

test('P3-D wave2 unresolved references: missing cross-app target and unmapped user are explicit in dry-run and result; rule stays disabled and completion pends', async () => {
  const source = await buildSource();
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  // No import of app B, and the member user is NOT mapped.
  const imp = await stageImport(adminToken, source.archive, {
    users: { [source.owner.userId]: admin.userId },
  });
  const dry = await expectRequest(201, `/imports/${imp.job.id}/automation-dry-run`, { token: adminToken, method: 'POST' });
  assert.ok(dry.unresolved.some((entry) => entry.kind === 'app' && entry.sourceId === source.appB.id),
    JSON.stringify(dry.unresolved));
  assert.ok(dry.unresolved.some((entry) => entry.kind === 'user' && entry.sourceId === source.member.userId),
    JSON.stringify(dry.unresolved));
  const run = await expectRequest(201, `/imports/${imp.job.id}/run`, { token: imp.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready');
  assert.equal(run.completion, 'pending', JSON.stringify(run.pending?.automation));
  assert.ok(run.pending.automation.unresolved.some((entry) => entry.kind === 'app'));
  assert.ok(run.pending.automation.unresolved.some((entry) => entry.kind === 'user'));
  assert.ok(run.pending.automation.unresolved.some((entry) => entry.kind === 'target-field'));
  const blocked = await request(`/imports/${imp.job.id}/activate`, { token: adminToken, method: 'POST' });
  assert.equal(blocked.status, 400);
  const db = await dbClient();
  try {
    const rules = await db.query(
      'SELECT enabled FROM automation_rules WHERE tenant_id=$1 AND app_id=$2',
      [admin.tenantId, run.targetAppId]);
    assert.equal(rules.rowCount, 4);
    for (const row of rules.rows) assert.equal(row.enabled, false);
    // The unmapped recipient was dropped from the list, never re-pointed.
    const versions = await db.query(
      'SELECT actions_json FROM automation_rule_versions WHERE tenant_id=$1 AND app_id=$2',
      [admin.tenantId, run.targetAppId]);
    const combo = versions.rows.find((row) => row.actions_json.some((a) => a.type === 'WEBHOOK'));
    const notify = combo.actions_json.find((a) => a.type === 'NOTIFY');
    assert.deepEqual(notify.notify.recipientUserIds, []);
  } finally { await db.end(); }
  await expectRequest(201, `/imports/${imp.job.id}/cancel`, { token: adminToken, method: 'POST' });
  // Cancel cleanup now covers automation rows (migration 0048 purge).
  const db2 = await dbClient();
  try {
    const left = await db2.query(
      'SELECT count(*)::int AS n FROM automation_rules WHERE tenant_id=$1 AND app_id=$2',
      [admin.tenantId, run.targetAppId]);
    assert.equal(left.rows[0].n, 0, 'cancel purged the staged automation rules');
  } finally { await db2.end(); }
});

test('P3-D wave2 cycle re-check: a package whose drafts form a deterministic loop imports disabled with a BLOCKING finding and pending completion', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dm1-loop-' + randomUUID().slice(0, 6));
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'm1_loop_title', 'text');
  await publish(token, app.id);
  // Two unconditional draft rules creating records in their own app: a
  // provable BLOCKING cycle. They are never published in the source
  // (publish would refuse them), which is exactly why the import-side
  // re-check matters.
  for (const name of ['Loop A', 'Loop B']) {
    await write('/automation/rules', {
      name, config: ruleConfig({ eventType: 'record.created' }, [
        { actionId: randomUUID(), type: 'CREATE_RECORD', targetAppId: app.id, mappings: [
          { targetFieldId: title.fieldId, mode: 'constant', value: 'x' } ] },
      ]),
    });
  }
  const archive = await exportApp(token, app.id);
  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const imp = await stageImport(adminToken, archive, {});
  const dry = await expectRequest(201, `/imports/${imp.job.id}/automation-dry-run`, { token: adminToken, method: 'POST' });
  assert.ok(dry.cycleFindings.some((finding) => finding.code === 'BLOCKING_CYCLE'),
    JSON.stringify(dry.cycleFindings));
  const run = await expectRequest(201, `/imports/${imp.job.id}/run`, { token: imp.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready');
  assert.equal(run.completion, 'pending');
  assert.ok(run.pending.automation.cycleFindings.some(
    (finding) => finding.code === 'BLOCKING_CYCLE' && finding.severity === 'BLOCKING'),
    JSON.stringify(run.pending.automation.cycleFindings));
  await expectRequest(201, `/imports/${imp.job.id}/cancel`, { token: adminToken, method: 'POST' });
});

test('P3-D wave2 old packages: a package without an automation section imports with unchanged semantics; manifests without automation counts still verify', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3dm1-plain-' + randomUUID().slice(0, 6));
  const title = await addField(token, app.id, 'm1_plain_title', 'text');
  await publish(token, app.id);
  await expectRequest(201, `/apps/${app.id}/records`, { token, method: 'POST',
    body: { data: { [title.fieldId]: 'plain' } } });
  const sealed = await exportApp(token, app.id);
  // Strip the automation file and its manifest entry: this is byte-wise
  // what a pre-wave-2 export of the same app looked like.
  const entries = unzipSync(new Uint8Array(sealed));
  const manifest = JSON.parse(strFromU8(entries['manifest.json']));
  assert.equal(manifest.inclusion.automation, 'absent');
  delete entries['data/automation.json'];
  manifest.files = manifest.files.filter((file) => file.path !== 'data/automation.json');
  for (const side of ['expected', 'actual']) {
    delete manifest.counts[side].automationRules;
    delete manifest.counts[side].automationRuleVersions;
    delete manifest.counts[side].automationWebhookEndpoints;
  }
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  const oldArchive = Buffer.from(zipSync(entries));
  assert.deepEqual(verifyPackage(oldArchive).problems, [],
    'old manifests without automation counts must still verify');

  const admin = await provision({ isAdmin: true });
  const adminToken = await login(admin);
  const imp = await stageImport(adminToken, oldArchive, {});
  const dry = await expectRequest(201, `/imports/${imp.job.id}/automation-dry-run`, { token: adminToken, method: 'POST' });
  assert.equal(dry.automation, null);
  const run = await expectRequest(201, `/imports/${imp.job.id}/run`, { token: imp.issued.token, method: 'POST' });
  assert.equal(run.status, 'ready');
  assert.equal(run.completion, 'complete', JSON.stringify(run.pending));
  assert.equal(run.pending.automation, null);
  assert.equal(run.report.automation, null);
  await expectRequest(201, `/imports/${imp.job.id}/activate`, { token: adminToken, method: 'POST' });
});
