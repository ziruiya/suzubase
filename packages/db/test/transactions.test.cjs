const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const { and, appCounters, eq, outbox, recordCreateKeys, recordEvents, records, withTenantTransaction } = require('../dist');

async function fixture() {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const field = await addField(token, app.id, 'amount', 'number');
  await publish(token, app.id);
  return { owner, token, app, fieldId: field.fieldId, path: `/apps/${app.id}/records` };
}

function createRecord(status, { token, path, fieldId }, value, key) {
  return expectRequest(status, path, {
    method: 'POST', token, body: { data: { [fieldId]: value } },
    headers: key === undefined ? {} : { 'Idempotency-Key': key },
  });
}

function replaceRecord(status, { token, path, fieldId }, recordId, revision, value) {
  return expectRequest(status, `${path}/${recordId}`, {
    method: 'PUT', token, body: { data: { [fieldId]: value }, revision },
  });
}

function state({ owner, app }) {
  return withTenantTransaction(owner, async (tx) => {
    const appScope = (table) => and(eq(table.tenantId, owner.tenantId), eq(table.appId, app.id));
    const [counter] = await tx.select().from(appCounters).where(appScope(appCounters));
    return {
      counter: counter.lastValue,
      records: await tx.select().from(records).where(appScope(records)),
      keys: await tx.select().from(recordCreateKeys).where(appScope(recordCreateKeys)),
      events: await tx.select().from(recordEvents).where(appScope(recordEvents)).orderBy(recordEvents.recordRevision),
      outbox: await tx.select().from(outbox).where(appScope(outbox)),
    };
  });
}

test('concurrent duplicate creates return the original result and allocate one number', async (t) => {
  const f = await fixture();
  const key = 'invoice-create';
  const submissions = await Promise.all(Array.from({ length: 8 }, () => createRecord(201, f, '10.00', key)));
  const [created] = submissions;
  for (const response of submissions) assert.deepEqual(response, created);
  assert.equal(created.recordNo, '1');

  const before = await state(f);
  assert.equal(before.counter, 1n);
  for (const rows of [before.records, before.keys, before.events, before.outbox]) assert.equal(rows.length, 1);
  assert.equal(before.outbox[0].eventId, before.events[0].eventId);
  assert.deepEqual(before.events[0].changes, [{ fieldId: f.fieldId, oldValue: null, newValue: '10' }]);
  await replaceRecord(200, f, created.id, 1, '20');
  assert.deepEqual(await createRecord(201, f, '10.00', key), created);

  const otherApp = await createApp(f.token, 'other-app');
  const other = await expectRequest(201, `/apps/${otherApp.id}/records`, {
    method: 'POST', token: f.token, body: { data: {} }, headers: { 'Idempotency-Key': key },
  });
  assert.notEqual(other.id, created.id);
  assert.equal(other.recordNo, '1');
  t.diagnostic('8 concurrent POSTs → 8 original 201 responses, 1 record, 1 number, 1 key, 1 history event, 1 outbox row');
});

test('one concurrent revision update wins and stale writes return the current record', async (t) => {
  const f = await fixture();
  const created = await createRecord(201, f, '10');
  const requests = ['20.50', '30.50'].map((value) => request(`${f.path}/${created.id}`, {
    method: 'PUT', token: f.token, body: { revision: created.revision, data: { [f.fieldId]: value } },
  }));
  const results = await Promise.all(requests);
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
  const updated = results.find(({ status }) => status === 200).body;
  const conflict = results.find(({ status }) => status === 409).body;
  assert.equal(updated.revision, 2);
  assert.equal(conflict.code, 'REVISION_CONFLICT');
  assert.deepEqual(conflict.current, updated);
  assert.deepEqual(await replaceRecord(409, f, created.id, 1, '99'), conflict);
  await expectRequest(400, `${f.path}/${created.id}`, { method: 'PUT', token: f.token, body: { data: {} } });
  assert.deepEqual(await expectRequest(200, `${f.path}/${created.id}`, { token: f.token }), updated);

  const after = await state(f);
  assert.deepEqual(after.events.map(({ recordRevision, kind }) => [recordRevision, kind]), [[1, 'created'], [2, 'updated']]);
  const event = after.events[1];
  assert.equal(event.actorId, f.owner.userId);
  assert.equal(event.schemaVersion, updated.schemaVersion);
  assert.deepEqual(event.changes, [{ fieldId: f.fieldId, oldValue: '10', newValue: updated.data[f.fieldId] }]);
  assert.deepEqual(after.outbox.map(({ eventId }) => eventId).sort(), after.events.map(({ eventId }) => eventId).sort());
  t.diagnostic('Concurrent PUTs at revision 1 → 200 and 409 REVISION_CONFLICT. Current revision 2, exactly 2 history events and 2 outbox rows.');
});

test('outbox failure rolls back record creation and updates with their history', async () => {
  const f = await fixture();
  const original = await createRecord(201, f, '10');
  const before = await state(f);
  const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  const suffix = f.app.id.replaceAll('-', '');
  const fn = `reject_outbox_${suffix}`;
  try {
    await admin.query(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Test outbox failure'; END;
    $$`);
    await admin.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON outbox
      FOR EACH ROW WHEN (NEW.app_id = '${f.app.id}'::uuid) EXECUTE FUNCTION public.${fn}()`);
    await createRecord(500, f, '20', 'retry-after-rollback');
    await replaceRecord(500, f, original.id, original.revision, '30');
    assert.deepEqual(await state(f), before);
  } finally {
    await admin.query(`DROP TRIGGER IF EXISTS ${fn} ON outbox`);
    await admin.query(`DROP FUNCTION IF EXISTS public.${fn}()`);
    await admin.end();
  }
  const retried = await createRecord(201, f, '20', 'retry-after-rollback');
  assert.equal(retried.recordNo, '2');
  assert.equal((await replaceRecord(200, f, original.id, 1, '30')).revision, 2);
});
