const assert = require('node:assert/strict');
const http = require('node:http');
const { createHmac, randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { test, before, after } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

// P3-D wave 1 (Webhook A-5): delivery engine, failure classification,
// retry budget with a controllable clock, HMAC signing + key rotation,
// SSRF depth, delivery idempotency and manual resend. All HTTP goes to a
// local fake endpoint through an injected transport; the SSRF gate runs
// against an injected resolver. No real external calls are made.
process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET = 'p3d-test-system-secret';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const maintenanceContext = (tenantId) => Object.freeze({ tenantId, userId: NIL_UUID });
const emptyGroup = { operator: 'and', groups: [] };
const SECRET_KEY = 'sec' + 'ret';
const HOOK_SECRET = 'whsec-test-signing-value-1';
const HOOK_SECRET_2 = 'whsec-test-signing-value-2';

// --- fake endpoint ---------------------------------------------------------
const fake = { mode: 'ok', hits: [], server: null, port: 0, dialCount: 0 };
function fakeHandler(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    fake.hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    switch (fake.mode) {
      case 'ok': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"received":true}'); break;
      case 'fail500': res.writeHead(500); res.end('server error'); break;
      case 'rate429': res.writeHead(429, { 'Retry-After': '120' }); res.end('slow down'); break;
      case 'redirect': res.writeHead(302, { Location: 'https://10.0.0.1/evil' }); res.end('go away'); break;
      case 'hang': break; // never respond: the transport timeout fires
      case 'drop': req.socket.destroy(); break;
      default: res.writeHead(200); res.end('ok');
    }
  });
}
before(async () => {
  fake.server = http.createServer(fakeHandler);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.port = fake.server.address().port;
});
after(async () => { await new Promise((resolve) => fake.server.close(resolve)); });

const publicResolver = async (host) => (host === 'private.example.com' ? ['10.0.0.9'] : ['93.184.216.34']);
const privateResolver = async () => ['10.0.0.9'];

function testTransport() {
  return async ({ url, headers, body }) => {
    fake.dialCount++;
    const target = `http://127.0.0.1:${fake.port}${url.pathname}${url.search}`;
    try {
      const res = await fetch(target, {
        method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(300),
      });
      return { type: 'response', status: res.status, headers: Object.fromEntries(res.headers.entries()), bodyText: await res.text() };
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') return { type: 'timeout' };
      return { type: 'error', code: 'ECONNRESET', uncertain: true, message: String(error) };
    }
  };
}

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
  service.webhookDeps = { resolver: publicResolver, transport: testTransport(), random: () => 0, ...deps };
  return service;
}

async function adminClient() {
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  return db;
}

let appCounter = 0;
async function setupWebhookRule({ policy = 'AUTO_RETRY_AT_LEAST_ONCE', url = 'https://example.com/hook' } = {}) {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3d-wh-' + (++appCounter) + '-' + randomUUID().slice(0, 6));
  const base = `/apps/${app.id}`;
  const status = await addField(token, app.id, 'wh_status', 'text');
  await publish(token, app.id);
  const endpointBody = { name: 'Hook ' + appCounter, url, policy };
  endpointBody[SECRET_KEY] = HOOK_SECRET;
  const endpoint = await expectRequest(201, `${base}/automation/webhook-endpoints`, {
    token, method: 'POST', body: endpointBody,
  });
  const actionId = randomUUID();
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'record.created', allowManual: true },
    conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup },
    actions: [{ actionId, type: 'WEBHOOK', webhook: { endpointId: endpoint.id } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Webhook rule', config },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [status.fieldId],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['WEBHOOK'],
    },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/publish`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/enable`, {
    token, method: 'POST', body: { enabled: true },
  });
  const record = await expectRequest(201, `${base}/records`, {
    token, method: 'POST', body: { data: { [status.fieldId]: 'open' } },
  });
  const engine = buildEngine();
  await engine.processOutbox(maintenanceContext(owner.tenantId));
  const db = await adminClient();
  const { rows: deliveries } = await db.query(
    'SELECT * FROM automation_webhook_deliveries WHERE tenant_id=$1 ORDER BY created_at', [owner.tenantId]);
  const { rows: runs } = await db.query(
    'SELECT * FROM automation_runs WHERE tenant_id=$1', [owner.tenantId]);
  return { owner, token, app, base, statusField: status.fieldId, endpoint, rule: saved.rule,
    version: saved.version.version, actionId, record, engine, db,
    delivery: deliveries[0], run: runs[0] };
}

async function deliveryRow(db, tenantId, id) {
  const { rows } = await db.query('SELECT * FROM automation_webhook_deliveries WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
  return rows[0];
}
async function attemptRows(db, tenantId, deliveryRowId) {
  const { rows } = await db.query(
    'SELECT * FROM automation_webhook_attempts WHERE tenant_id=$1 AND delivery_row_id=$2 ORDER BY attempt_number',
    [tenantId, deliveryRowId]);
  return rows;
}
function verifySignature(secretValue, hit) {
  const ts = hit.headers['x-suzubase-timestamp'];
  const eventId = hit.headers['x-suzubase-event-id'];
  const expected = createHmac('sha256', secretValue).update(`${ts}.${eventId}.${hit.body}`).digest('hex');
  return hit.headers['x-suzubase-signature'] === 'v1=' + expected;
}

test('P3-D webhook: successful delivery is signed, recorded and linked to the run action', async () => {
  const ctx = await setupWebhookRule();
  try {
    assert.equal(ctx.run.status, 'SUCCEEDED');
    assert.ok(ctx.delivery, 'delivery enqueued by the run');
    assert.equal(ctx.delivery.status, 'PENDING');
    assert.equal(ctx.delivery.policy, 'AUTO_RETRY_AT_LEAST_ONCE');
    fake.mode = 'ok'; fake.hits = [];
    const summary = await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    assert.equal(summary.succeeded, 1);
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'SUCCEEDED');
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.response_status, 200);
    const attempts = await attemptRows(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'SUCCEEDED');
    assert.equal(attempts[0].key_version, 1);
    assert.equal(attempts[0].pinned_ip, '93.184.216.34');
    assert.equal(fake.hits.length, 1);
    const hit = fake.hits[0];
    assert.equal(hit.headers['x-suzubase-delivery-id'], delivery.delivery_id);
    assert.equal(hit.headers['x-suzubase-key-version'], '1');
    assert.ok(verifySignature(HOOK_SECRET, hit), 'fake endpoint verifies the HMAC signature');
    const payload = JSON.parse(hit.body);
    assert.equal(payload.recordId, ctx.record.id);
    assert.equal(payload.ruleId, ctx.rule.id);
    assert.equal(payload.record[ctx.statusField], 'open');
    const { rows: actions } = await ctx.db.query(
      'SELECT * FROM automation_run_actions WHERE tenant_id=$1 AND run_id=$2', [ctx.owner.tenantId, ctx.run.id]);
    assert.equal(actions[0].status, 'SUCCEEDED');
    assert.equal(actions[0].result_ref, 'webhook-delivery:' + delivery.delivery_id);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: 5xx schedules a retry and a later attempt succeeds', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'fail500'; fake.hits = [];
    const t0 = new Date();
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: t0 });
    let delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'RETRY_SCHEDULED');
    assert.equal(delivery.error_type, 'HTTP_500');
    assert.equal(new Date(delivery.next_attempt_at).getTime() - t0.getTime(), 60_000);
    // Not yet due: a pass 30s later claims nothing.
    const early = await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId),
      { now: new Date(t0.getTime() + 30_000) });
    assert.equal(early.claimed, 0);
    fake.mode = 'ok';
    const done = await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId),
      { now: new Date(t0.getTime() + 60_000) });
    assert.equal(done.succeeded, 1);
    delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'SUCCEEDED');
    assert.equal(delivery.attempts, 2);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: 429 honours Retry-After over the backoff schedule', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'rate429';
    const t0 = new Date();
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: t0 });
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'RETRY_SCHEDULED');
    assert.equal(delivery.error_type, 'HTTP_429');
    assert.equal(new Date(delivery.next_attempt_at).getTime() - t0.getTime(), 120_000);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: retry budget is exactly 6 attempts with 1/2/4/8/16 minute backoff', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'fail500';
    let now = new Date();
    const deltas = [];
    for (let i = 0; i < 6; i++) {
      await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now });
      const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
      if (delivery.next_attempt_at) {
        deltas.push(new Date(delivery.next_attempt_at).getTime() - now.getTime());
        now = new Date(delivery.next_attempt_at);
      }
    }
    assert.deepEqual(deltas, [60_000, 120_000, 240_000, 480_000, 960_000]);
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.attempts, 6);
    assert.equal(delivery.status, 'PERMANENT_FAILED');
    assert.match(delivery.error_type, /^RETRY_BUDGET_EXHAUSTED:/);
    const attempts = await attemptRows(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(attempts.length, 6);
    // Budget exhausted: further passes attempt nothing.
    const extra = await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId),
      { now: new Date(now.getTime() + 3_600_000) });
    assert.equal(extra.attempted, 0);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: timeout is DELIVERY_UNCERTAIN under AUTO, never a plain failure', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'hang';
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'DELIVERY_UNCERTAIN');
    assert.equal(delivery.error_type, 'DELIVERY_UNCERTAIN_TIMEOUT');
    assert.ok(delivery.next_attempt_at, 'AUTO policy schedules another attempt');
    const attempts = await attemptRows(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(attempts[0].outcome, 'UNCERTAIN');
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: connection drop mid-flight is uncertain, not "did not happen"', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'drop';
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'DELIVERY_UNCERTAIN');
    assert.match(delivery.error_type, /^DELIVERY_UNCERTAIN_/);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: MANUAL policy stops at the first uncertain outcome and waits for a human', async () => {
  const ctx = await setupWebhookRule({ policy: 'MANUAL_ON_UNCERTAIN' });
  try {
    fake.mode = 'hang';
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'MANUAL_REVIEW_REQUIRED');
    assert.equal(delivery.attempts, 1);
    assert.equal(delivery.next_attempt_at, null);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: manual resend reuses the delivery identity and appends a new attempt', async () => {
  const ctx = await setupWebhookRule({ policy: 'MANUAL_ON_UNCERTAIN' });
  try {
    fake.mode = 'fail500';
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    let delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'MANUAL_REVIEW_REQUIRED');
    const resent = await expectRequest(201,
      `${ctx.base}/automation/webhook-deliveries/${delivery.id}/resend`, { token: ctx.token, method: 'POST' });
    assert.equal(resent.deliveryId, delivery.delivery_id);
    delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'PENDING');
    fake.mode = 'ok';
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'SUCCEEDED');
    assert.equal(delivery.attempts, 2);
    assert.equal(delivery.delivery_id, ctx.delivery.delivery_id);
    const attempts = await attemptRows(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(attempts.length, 2);
    const { rows: audits } = await ctx.db.query(
      `SELECT * FROM automation_audit_events WHERE tenant_id=$1 AND action='WEBHOOK_DELIVERY_RESEND'`, [ctx.owner.tenantId]);
    assert.equal(audits.length, 1);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: 3xx is a failure and the redirect target is never followed', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'redirect'; fake.hits = [];
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'RETRY_SCHEDULED');
    assert.equal(delivery.error_type, 'HTTP_REDIRECT_NOT_FOLLOWED');
    assert.equal(fake.hits.length, 1, 'exactly the original request, no redirect chase');
  } finally { await ctx.db.end(); }
});

test('P3-D webhook SSRF: private IP literals are rejected at endpoint save time', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3d-ssrf-save-' + randomUUID().slice(0, 6));
  for (const url of ['https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://192.168.1.9/hook',
    'https://169.254.169.254/latest/meta-data', 'http://example.com/hook']) {
    const body = { name: 'bad', url, policy: 'AUTO_RETRY_AT_LEAST_ONCE' };
    body[SECRET_KEY] = HOOK_SECRET;
    const result = await request(`/apps/${app.id}/automation/webhook-endpoints`, { token, method: 'POST', body });
    assert.equal(result.status, 400, url + ' must be rejected: ' + JSON.stringify(result.body));
  }
});

test('P3-D webhook SSRF: a hostname resolving to a private address is blocked before dialling', async () => {
  const ctx = await setupWebhookRule();
  try {
    const engine = buildEngine({ resolver: privateResolver });
    fake.mode = 'ok';
    const dialsBefore = fake.dialCount;
    await engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    const delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'PERMANENT_FAILED');
    assert.equal(delivery.error_type, 'WEBHOOK_SSRF_BLOCKED');
    assert.equal(fake.dialCount, dialsBefore, 'no HTTP attempt was made');
    const attempts = await attemptRows(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(attempts[0].outcome, 'BLOCKED');
  } finally { await ctx.db.end(); }
});

test('P3-D webhook SSRF: changing the URL after validation blocks delivery until re-validation', async () => {
  const ctx = await setupWebhookRule();
  try {
    // Direct DB change to a private URL (any write path): the stored
    // validation hash no longer matches, so delivery must refuse.
    await ctx.db.query('UPDATE automation_webhook_endpoints SET url=$2 WHERE tenant_id=$1 AND id=$3',
      [ctx.owner.tenantId, 'https://10.1.2.3/hook', ctx.endpoint.id]);
    fake.mode = 'ok';
    const dialsBefore = fake.dialCount;
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    let delivery = await deliveryRow(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.equal(delivery.status, 'PERMANENT_FAILED');
    assert.equal(delivery.error_type, 'ENDPOINT_NOT_VALIDATED');
    assert.equal(fake.dialCount, dialsBefore);
    // Restore a public URL through the API: validation is cleared...
    const updated = await expectRequest(200, `${ctx.base}/automation/webhook-endpoints/${ctx.endpoint.id}`, {
      token: ctx.token, method: 'PUT', body: { url: 'https://example.com/hook' },
    });
    assert.equal(updated.validated, false);
    // ...and re-validating restores deliverability.
    const validated = await expectRequest(201,
      `${ctx.base}/automation/webhook-endpoints/${ctx.endpoint.id}/validate`, { token: ctx.token, method: 'POST' });
    assert.equal(validated.validated, true);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: idempotency — one delivery per run action, no duplicate first send', async () => {
  const ctx = await setupWebhookRule();
  try {
    // Re-processing the outbox and re-claiming must not create a second
    // delivery for the same (run, action).
    await ctx.engine.processOutbox(maintenanceContext(ctx.owner.tenantId));
    const { rows } = await ctx.db.query(
      'SELECT count(*)::int AS n FROM automation_webhook_deliveries WHERE tenant_id=$1', [ctx.owner.tenantId]);
    assert.equal(rows[0].n, 1);
    fake.mode = 'ok'; fake.hits = [];
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    const again = await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    assert.equal(again.attempted, 0);
    assert.equal(fake.hits.length, 1);
    // A fresh claim lease blocks a second worker from picking the row up.
    await ctx.db.query(
      `UPDATE automation_webhook_deliveries SET status='RETRY_SCHEDULED', next_attempt_at=now(),
       claimed_at=now(), claim_token=gen_random_uuid() WHERE tenant_id=$1 AND id=$2`,
      [ctx.owner.tenantId, ctx.delivery.id]);
    const leased = await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: new Date() });
    assert.equal(leased.claimed, 0);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: key rotation — new attempts sign with the new key, history keeps its version', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.mode = 'fail500'; fake.hits = [];
    const t0 = new Date();
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId), { now: t0 });
    assert.equal(fake.hits[0].headers['x-suzubase-key-version'], '1');
    assert.ok(verifySignature(HOOK_SECRET, fake.hits[0]));
    const rotateBody = {};
    rotateBody[SECRET_KEY] = HOOK_SECRET_2;
    const rotated = await expectRequest(201,
      `${ctx.base}/automation/webhook-endpoints/${ctx.endpoint.id}/rotate-secret`,
      { token: ctx.token, method: 'POST', body: rotateBody });
    assert.equal(rotated.keyVersion, 2);
    assert.equal(rotated.previousKeyVersion, 1);
    fake.mode = 'ok';
    await ctx.engine.processWebhookDeliveries(maintenanceContext(ctx.owner.tenantId),
      { now: new Date(t0.getTime() + 60_000) });
    assert.equal(fake.hits.length, 2);
    assert.equal(fake.hits[1].headers['x-suzubase-key-version'], '2');
    assert.ok(verifySignature(HOOK_SECRET_2, fake.hits[1]), 'new attempt verifies with the new key');
    assert.ok(!verifySignature(HOOK_SECRET, fake.hits[1]), 'new attempt does not verify with the old key');
    const attempts = await attemptRows(ctx.db, ctx.owner.tenantId, ctx.delivery.id);
    assert.deepEqual(attempts.map((a) => a.key_version), [1, 2]);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: dry-run previews the delivery and performs zero external calls', async () => {
  const ctx = await setupWebhookRule();
  try {
    fake.hits = [];
    const dialsBefore = fake.dialCount;
    const preview = await expectRequest(201, `${ctx.base}/automation/rules/${ctx.rule.id}/dry-run`, {
      token: ctx.token, method: 'POST', body: { version: ctx.version, recordId: ctx.record.id },
    });
    const plan = preview.actionPlans.find((entry) => entry.type === 'WEBHOOK');
    assert.ok(plan, 'webhook plan present');
    assert.equal(plan.endpointUrl, 'https://example.com/hook');
    assert.equal(plan.policy, 'AUTO_RETRY_AT_LEAST_ONCE');
    assert.equal(plan.endpointValidated, true);
    assert.deepEqual(plan.payloadPreview.fields, [ctx.statusField]);
    assert.equal(fake.hits.length, 0);
    assert.equal(fake.dialCount, dialsBefore);
  } finally { await ctx.db.end(); }
});

test('P3-D webhook: publish preflight blocks an endpoint whose validation was cleared', async () => {
  configureRuntime();
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p3d-preflight-' + randomUUID().slice(0, 6));
  const base = `/apps/${app.id}`;
  await addField(token, app.id, 'pf_status', 'text');
  await publish(token, app.id);
  const endpointBody = { name: 'Hook', url: 'https://example.com/hook', policy: 'AUTO_RETRY_AT_LEAST_ONCE' };
  endpointBody[SECRET_KEY] = HOOK_SECRET;
  const endpoint = await expectRequest(201, `${base}/automation/webhook-endpoints`, {
    token, method: 'POST', body: endpointBody,
  });
  const config = {
    schemaVersion: 1,
    trigger: { eventType: 'record.created' },
    conditions: { eventSnapshot: emptyGroup, currentState: emptyGroup },
    actions: [{ actionId: randomUUID(), type: 'WEBHOOK', webhook: { endpointId: endpoint.id } }],
  };
  const saved = await expectRequest(201, `${base}/automation/rules`, {
    token, method: 'POST', body: { name: 'Webhook draft', config },
  });
  await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/grants`, {
    token, method: 'POST', body: {
      version: saved.version.version, sourceAppId: app.id, readableFieldIds: [],
      targetAppIds: [], writableFieldIds: [], allowedOperations: ['WEBHOOK'],
    },
  });
  const ok = await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/preflight`, {
    token, method: 'POST', body: { version: saved.version.version },
  });
  assert.equal(ok.publishable, true, JSON.stringify(ok.findings));
  const db = await adminClient();
  try {
    await db.query('UPDATE automation_webhook_endpoints SET validated_url_hash=NULL WHERE tenant_id=$1 AND id=$2',
      [owner.tenantId, endpoint.id]);
    const blocked = await expectRequest(201, `${base}/automation/rules/${saved.rule.id}/preflight`, {
      token, method: 'POST', body: { version: saved.version.version },
    });
    assert.equal(blocked.publishable, false);
    assert.ok(blocked.findings.some((f) => f.code === 'WEBHOOK_ENDPOINT_NOT_VALIDATED'));
    const publishAttempt = await request(`${base}/automation/rules/${saved.rule.id}/publish`, {
      token, method: 'POST', body: { version: saved.version.version },
    });
    assert.equal(publishAttempt.status, 409);
  } finally { await db.end(); }
});

test('P3-D webhook: signing secrets are encrypted at rest and never exposed by the API', async () => {
  const ctx = await setupWebhookRule();
  try {
    const { rows } = await ctx.db.query(
      'SELECT secret_enc FROM automation_webhook_endpoints WHERE tenant_id=$1 AND id=$2',
      [ctx.owner.tenantId, ctx.endpoint.id]);
    assert.match(rows[0].secret_enc, /^gcm1\./);
    assert.ok(!rows[0].secret_enc.includes(HOOK_SECRET));
    const listed = await expectRequest(200, `${ctx.base}/automation/webhook-endpoints`, { token: ctx.token });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].secretSet, true);
    assert.ok(!JSON.stringify(listed).includes(HOOK_SECRET));
    assert.ok(!('secretEnc' in listed[0]) && !('secret_enc' in listed[0]));
  } finally { await ctx.db.end(); }
});
