const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

// P3 closure batch (C3 + C4):
// - C3: the automation webhook encryption key must FAIL FAST when no key
//   is configured. There is no hardcoded fallback key anywhere: the save
//   path (encryptWebhookSecret, used by endpoint create/rotate) and the
//   delivery path (decryptWebhookSecret, used by the delivery engine)
//   both refuse explicitly instead of using a repository-published value.
// - C4 (brief V-05(ii) direct test): an event that was QUEUED while rule
//   v1 was current (outbox row written, not yet consumed) and is only
//   consumed AFTER v2 is published+enabled binds the version in effect
//   at execution time (v2 / currentVersion, brief 5.2). This differs
//   from the wave3 V-05 test, whose second record was created only after
//   v2 was already live (its event never sat queued under v1), and from
//   its first leg (an already-created run retrying under its own v1).
// Use the stack-provided credential when one is exported (CI provisions
// a fresh random value per run); the fixed value is only a local fallback.
process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET ??= 'p3d-test-system-secret';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const maintenanceContext = (tenantId) => Object.freeze({ tenantId, userId: NIL_UUID });
const emptyGroup = { operator: 'and', groups: [] };
const emptyConditions = { eventSnapshot: emptyGroup, currentState: emptyGroup };
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
async function adminClient() {
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  return db;
}
const writer = (token, base) => (path, body, method = 'POST', code = 201) =>
  expectRequest(code, base + path, { token, body, method });

function withoutWebhookKey(fn) {
  const savedWebhook = process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
  const savedSystem = process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
  delete process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
  delete process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
  try { return fn(); } finally {
    if (savedWebhook === undefined) delete process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
    else process.env.SUZUBASE_WEBHOOK_SECRET_KEY = savedWebhook;
    if (savedSystem === undefined) delete process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
    else process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET = savedSystem;
  }
}

// ------------------------------------------------------------------ C3a
test('P3 closure C3: missing/empty webhook encryption key fails fast on the save and delivery secret paths (no hardcoded fallback)', async () => {
  const { encryptWebhookSecret, decryptWebhookSecret } = require('../../../apps/api/dist/automation-webhook.js');
  // Roundtrip with a configured key works (control case).
  const sealed = encryptWebhookSecret('whsec-closure-control');
  assert.equal(decryptWebhookSecret(sealed), 'whsec-closure-control');
  // Save path: encrypting with NO key configured must throw the explicit
  // fail-fast error, never encrypt under a repository-published value.
  withoutWebhookKey(() => {
    assert.throws(() => encryptWebhookSecret('whsec-must-not-seal'),
      /WEBHOOK_SECRET_KEY_NOT_CONFIGURED/, 'save path refuses to encrypt without a configured key');
    // Delivery path: reading an existing ciphertext without a key must
    // throw the same explicit error (the engine maps it to a BLOCKED
    // delivery), never decrypt under a fallback key.
    assert.throws(() => decryptWebhookSecret(sealed),
      /WEBHOOK_SECRET_KEY_NOT_CONFIGURED/, 'delivery path refuses to decrypt without a configured key');
  });
  // Empty / whitespace-only values count as missing.
  const savedSystem = process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
  const savedWebhook = process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
  process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET = '   ';
  delete process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
  try {
    assert.throws(() => encryptWebhookSecret('whsec-must-not-seal'),
      /WEBHOOK_SECRET_KEY_NOT_CONFIGURED/, 'whitespace-only key material is treated as missing');
  } finally {
    if (savedSystem === undefined) delete process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
    else process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET = savedSystem;
    if (savedWebhook !== undefined) process.env.SUZUBASE_WEBHOOK_SECRET_KEY = savedWebhook;
  }
});

// ------------------------------------------------------------------ C3b
test('P3 closure C3: delivery engine BLOCKS a delivery with WEBHOOK_SECRET_KEY_NOT_CONFIGURED when the key is absent at delivery time (zero transport calls)', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3cl-c3-' + randomUUID().slice(0, 6));
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const status = await addField(token, app.id, 'cl_c3_status', 'text');
  await publish(token, app.id);
  let dialCount = 0;
  const engine = buildEngine({ webhook: {
    resolver: async () => ['93.184.216.34'],
    transport: async () => { dialCount += 1; return { type: 'response', status: 200, headers: {}, bodyText: '{"received":true}' }; },
    random: () => 0,
  } });
  const context = maintenanceContext(owner.tenantId);
  // Endpoint + rule are created while the key IS configured (API process
  // encrypts the secret at save time).
  const endpoint = await write('/automation/webhook-endpoints', {
    name: 'Closure hook', url: 'https://example.com/hook', policy: 'AUTO_RETRY_AT_LEAST_ONCE',
    secret: 'whsec-closure-delivery',
  });
  const saved = await write('/automation/rules', { name: 'Closure C3 rule', config: ruleConfig(
    { eventType: 'record.created' },
    [{ actionId: randomUUID(), type: 'WEBHOOK', webhook: { endpointId: endpoint.id } }],
  ) });
  await write(`/automation/rules/${saved.rule.id}/grants`, {
    version: saved.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['WEBHOOK'],
  });
  await write(`/automation/rules/${saved.rule.id}/publish`, { version: saved.version.version });
  await write(`/automation/rules/${saved.rule.id}/enable`, { enabled: true });
  await write('/records', { data: { [status.fieldId]: 'open' } });
  await engine.processOutbox(context);
  const db = await adminClient();
  try {
    const queued = await db.query('SELECT id, status FROM automation_webhook_deliveries WHERE tenant_id=$1', [owner.tenantId]);
    assert.equal(queued.rowCount, 1);
    assert.equal(queued.rows[0].status, 'PENDING');
    // Now the key disappears from the delivery process environment: the
    // delivery must fail explicitly, with zero transport calls.
    const savedWebhook = process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
    const savedSystem = process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
    delete process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
    delete process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
    try {
      await engine.processWebhookDeliveries(context, { now: new Date() });
    } finally {
      if (savedWebhook === undefined) delete process.env.SUZUBASE_WEBHOOK_SECRET_KEY;
      else process.env.SUZUBASE_WEBHOOK_SECRET_KEY = savedWebhook;
      if (savedSystem === undefined) delete process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET;
      else process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET = savedSystem;
    }
    assert.equal(dialCount, 0, 'no HTTP attempt is made when the encryption key is not configured');
    const after = await db.query('SELECT status, error_type FROM automation_webhook_deliveries WHERE tenant_id=$1', [owner.tenantId]);
    assert.equal(after.rows[0].status, 'PERMANENT_FAILED', 'blocked delivery ends PERMANENT_FAILED, never silently delivered');
    assert.equal(after.rows[0].error_type, 'WEBHOOK_SECRET_KEY_NOT_CONFIGURED');
    const attempts = await db.query('SELECT outcome, error_type FROM automation_webhook_attempts WHERE tenant_id=$1', [owner.tenantId]);
    assert.equal(attempts.rowCount, 1);
    assert.equal(attempts.rows[0].outcome, 'BLOCKED');
    assert.equal(attempts.rows[0].error_type, 'WEBHOOK_SECRET_KEY_NOT_CONFIGURED');
  } finally { await db.end(); }
});

// ------------------------------------------------------------------- C4
test('P3 closure C4 (V-05(ii) direct): an event queued under v1 but consumed after v2 publishes binds v2 (execution-time version)', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3cl-v05ii-' + randomUUID().slice(0, 6));
  const base = `/apps/${app.id}`;
  const write = writer(token, base);
  const title = await addField(token, app.id, 'cl_v05_title', 'text');
  const status = await addField(token, app.id, 'cl_v05_status', 'text');
  await publish(token, app.id);
  // v1: NOTIFY only (no field writes). If the queued event bound v1, the
  // record status would stay untouched and a notification would appear.
  const v1 = await write('/automation/rules', { name: 'V05ii rule', config: ruleConfig(
    { eventType: 'record.created' },
    [{ actionId: randomUUID(), type: 'NOTIFY', notify: { recipientUserIds: [owner.userId], title: 'v1 notify' } }],
  ) });
  await write(`/automation/rules/${v1.rule.id}/grants`, {
    version: v1.version.version, sourceAppId: app.id, readableFieldIds: [title.fieldId],
    targetAppIds: [], writableFieldIds: [], allowedOperations: ['NOTIFY'],
  });
  await write(`/automation/rules/${v1.rule.id}/publish`, { version: v1.version.version });
  await write(`/automation/rules/${v1.rule.id}/enable`, { enabled: true });
  const ruleId = v1.rule.id;
  // The event is QUEUED under v1: the record is created (outbox row
  // written) but the worker deliberately does NOT consume it yet.
  const record = await write('/records', { data: { [title.fieldId]: 'queued-under-v1', [status.fieldId]: 'new' } });
  const db0 = await adminClient();
  try {
    const runs0 = await db0.query('SELECT count(*)::int AS c FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2', [owner.tenantId, ruleId]);
    assert.equal(runs0.rows[0].c, 0, 'no run exists yet: the event is still queued in the outbox');
  } finally { await db0.end(); }
  // v2 is published + enabled while the v1-era event is still queued.
  const draft2 = await write(`/automation/rules/${ruleId}/draft`, { config: ruleConfig(
    { eventType: 'record.created' },
    [{ actionId: randomUUID(), type: 'UPDATE_FIELDS', updates: [{ fieldId: status.fieldId, mode: 'set', value: 'v2-executed' }] }],
  ) }, 'PUT', 200);
  assert.equal(draft2.version, 2);
  await write(`/automation/rules/${ruleId}/grants`, {
    version: 2, sourceAppId: app.id, readableFieldIds: [status.fieldId],
    targetAppIds: [], writableFieldIds: [status.fieldId], allowedOperations: ['UPDATE_FIELDS'],
  });
  await write(`/automation/rules/${ruleId}/publish`, { version: 2 });
  await write(`/automation/rules/${ruleId}/enable`, { enabled: true });
  // Only NOW is the queued event consumed.
  const engine = buildEngine();
  await engine.processOutbox({ tenantId: owner.tenantId, userId: owner.userId });
  const db = await adminClient();
  try {
    const runs = await db.query('SELECT rule_version, status FROM automation_runs WHERE tenant_id=$1 AND rule_id=$2 AND record_id=$3',
      [owner.tenantId, ruleId, record.id]);
    assert.equal(runs.rowCount, 1, 'exactly one run for the queued event');
    assert.equal(runs.rows[0].rule_version, 2, 'run binds the execution-time version (v2 / currentVersion), not the queue-time v1');
    assert.equal(runs.rows[0].status, 'SUCCEEDED');
    const notes = await db.query(`SELECT count(*)::int AS c FROM notifications WHERE tenant_id=$1 AND rule_key LIKE $2`,
      [owner.tenantId, `automation:${ruleId}:%`]);
    assert.equal(notes.rows[0].c, 0, 'the v1 NOTIFY action never executed for the queued event');
  } finally { await db.end(); }
  const after = await expectRequest(200, `/apps/${app.id}/records/${record.id}`, { token });
  assert.equal(after.data[status.fieldId], 'v2-executed', 'the v2 UPDATE_FIELDS action is what actually executed');
});
