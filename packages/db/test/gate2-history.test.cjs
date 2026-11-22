const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

function state(code, name, props = {}) {
  return { id: randomUUID(), code, name, initial: false, terminal: false, assignees: [], ...props };
}

test('G2-13 record history carries every event kind with workflow detail, filters and a compatible export', async (t) => {
  const owner = await provision();
  const assignee = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);

  const source = await createApp(token, 'history-source');
  const sBase = '/apps/' + source.id;
  const sWrite = (status, method, path, body) => expectRequest(status, sBase + path, { method, token, body });
  const sKey = await sWrite(201, 'POST', '/fields', { code: 'key', name: 'Key', type: 'text', uniqueValue: true });
  const sVal = await addField(token, source.id, 'val', 'text');
  await publish(token, source.id);
  const sourceRecord = await sWrite(201, 'POST', '/records', { data: { [sKey.fieldId]: 'K1', [sVal.fieldId]: 'V1' } });

  const app = await createApp(token, 'history-main');
  const base = '/apps/' + app.id;
  const write = (status, method, path, body, bearer = token) =>
    expectRequest(status, base + path, { method, token: bearer, body });
  const name = await addField(token, app.id, 'name', 'text');
  const local = await addField(token, app.id, 'local_key', 'text');
  const copy = await addField(token, app.id, 'copy', 'text');
  const sku = randomUUID();
  const qty = randomUUID();
  const table = await write(201, 'POST', '/fields', {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: sku, name: 'SKU', code: 'sku', type: 'text', required: true },
      { fieldId: qty, name: 'Qty', code: 'qty', type: 'number', required: true },
    ], minRows: 0, maxRows: 10, addRows: true, deleteRows: true, reorderRows: true },
  });
  const lookup = await write(201, 'POST', '/fields', { code: 'lookup', name: 'Lookup', type: 'lookup', lookup: {
    appId: source.id, keyFieldId: sKey.fieldId, localKeyFieldId: local.fieldId,
    copies: [{ sourceFieldId: sVal.fieldId, targetFieldId: copy.fieldId }],
  } });
  const open = state('open', 'Open', { initial: true, assignees: [{ kind: 'creator' }] });
  const review = state('review', 'Review');
  const done = state('done', 'Done', { terminal: true });
  const submit = { id: randomUUID(), name: 'Submit', fromStateId: open.id, toStateId: review.id,
    assignees: [{ kind: 'user', id: assignee.userId }], conditions: [] };
  await write(200, 'PUT', '/workflow/draft', { states: [open, review, done], actions: [submit] });
  await write(201, 'POST', '/workflow/publish');
  await write(200, 'PATCH', '/workflow/enabled', { enabled: true });
  await write(200, 'PUT', '/draft/acl', {
    app: [{ action: 'workflow-repair', subject: { kind: 'user', id: owner.userId } }], record: [], field: [],
  });
  await publish(token, app.id);

  const row = (s, q) => ({ rowId: randomUUID(), data: { [sku]: s, [qty]: q } });
  const first = row('A', '1');
  const second = row('B', '2');
  const record = await write(201, 'POST', '/records', {
    data: { [name.fieldId]: 'First', [local.fieldId]: 'K1', [table.fieldId]: JSON.stringify([first]) },
  });
  assert.equal(record.data[copy.fieldId], 'V1');
  const entry = '/records/' + record.id;
  let revision = record.revision;
  const edit = async (data) => {
    const updated = await write(200, 'PUT', entry, { revision, data });
    revision = updated.revision;
    return updated;
  };
  await edit({ [name.fieldId]: 'Second', [local.fieldId]: 'K1', [table.fieldId]: JSON.stringify([first]) });
  const editedRow = { ...first, data: { [sku]: 'A', [qty]: '5' } };
  await edit({ [name.fieldId]: 'Second', [local.fieldId]: 'K1', [table.fieldId]: JSON.stringify([editedRow, second]) });
  await edit({ [name.fieldId]: 'Second', [local.fieldId]: 'K1', [table.fieldId]: JSON.stringify([editedRow]) });

  await sWrite(200, 'PUT', '/records/' + sourceRecord.id, {
    revision: sourceRecord.revision, data: { [sKey.fieldId]: 'K1', [sVal.fieldId]: 'V2' },
  });
  const refreshPath = entry + '/lookups/' + lookup.fieldId + '/refresh';
  const preview = await write(200, 'GET', refreshPath);
  const refreshed = await write(201, 'POST', refreshPath, { revision: preview.revision, confirmation: preview.confirmation });
  assert.equal(refreshed.data[copy.fieldId], 'V2');
  revision = refreshed.revision;

  const acted = await write(201, 'POST', entry + '/workflow/actions', { action_id: submit.id, revision });
  revision = acted.revision;
  const reassigned = await write(201, 'POST', entry + '/workflow/reassign', { revision, userIds: [owner.userId] });
  revision = reassigned.revision;
  const repaired = await write(201, 'POST', entry + '/workflow/repair', {
    revision, stateId: done.id, reason: 'History repair sample',
  });
  revision = repaired.revision;

  const comment = await write(201, 'POST', entry + '/comments', { parts: [{ kind: 'text', text: 'History note' }] });
  const removed = await write(200, 'DELETE', entry + '/comments/' + comment.id);

  const history = await write(200, 'GET', entry + '/history');
  const kinds = history.events.map(({ kind }) => kind);
  for (const expected of ['created', 'updated', 'lookup-refetched', 'workflow-action', 'workflow-reassigned',
    'WORKFLOW_REPAIR', 'comment-created', 'comment-deleted']) {
    assert.ok(kinds.includes(expected), 'missing kind ' + expected + ' in ' + kinds.join(','));
  }
  const revisions = history.events.map(({ recordRevision }) => recordRevision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), 'recordRevision must be monotonic');
  assert.equal(revisions.at(-1), removed.revision);
  const actionEvent = history.events.find(({ kind }) => kind === 'workflow-action');
  assert.deepEqual(
    { action: actionEvent.workflow.action, from: actionEvent.workflow.from, to: actionEvent.workflow.to },
    { action: 'Submit', from: 'Open', to: 'Review' });
  assert.deepEqual(actionEvent.workflow.assigneeIds, [assignee.userId]);
  const repairEvent = history.events.find(({ kind }) => kind === 'WORKFLOW_REPAIR');
  assert.equal(repairEvent.workflow.reason, 'History repair sample');
  assert.equal(repairEvent.workflow.action, null);
  assert.equal(repairEvent.workflow.to, 'Done');
  const tableEvents = history.events.filter(({ changes }) =>
    changes.some((change) => change.fieldId === table.fieldId));
  assert.ok(tableEvents.some(({ changes }) => changes.some((change) => change.rowChange === 'added')));
  assert.ok(tableEvents.some(({ changes }) => changes.some((change) => change.rowChange === 'removed')));

  // Filters: kind and field.
  const onlyRepair = await write(200, 'GET', entry + '/history?kind=WORKFLOW_REPAIR');
  assert.deepEqual(onlyRepair.events.map(({ kind }) => kind), ['WORKFLOW_REPAIR']);
  const onlyComments = await write(200, 'GET', entry + '/history?kind=comment-created');
  assert.equal(onlyComments.events.length, 1);
  const byName = await write(200, 'GET', entry + '/history?fieldId=' + name.fieldId);
  assert.ok(byName.events.length >= 1);
  assert.ok(byName.events.every(({ changes }) => changes.some((change) => change.fieldId === name.fieldId)));
  const byTable = await write(200, 'GET', entry + '/history?fieldId=' + table.fieldId);
  assert.ok(byTable.events.length >= 2);

  // The workflow history view reads the same events (single source).
  const workflowHistory = await write(200, 'GET', entry + '/workflow/history');
  const workflowIds = new Set(workflowHistory.map(({ eventId }) => eventId));
  for (const event of history.events) {
    if (['workflow-action', 'workflow-reassigned', 'WORKFLOW_REPAIR'].includes(event.kind)) {
      assert.ok(workflowIds.has(event.eventId), event.kind);
    }
  }

  // Export keeps its Gate 1 shape and now includes workflow and comment events.
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const response = await fetch(new URL(base + entry + '/history/export', origin),
    { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const exported = JSON.parse(await response.text());
  assert.equal(exported.recordId, record.id);
  assert.equal(exported.recordNo, record.recordNo);
  assert.ok(Array.isArray(exported.events) && exported.schemas);
  const exportedKinds = exported.events.map(({ kind }) => kind);
  assert.ok(exportedKinds.includes('workflow-action') && exportedKinds.includes('comment-created'));
  assert.equal(exported.events.find(({ kind }) => kind === 'WORKFLOW_REPAIR').workflow.reason, 'History repair sample');
  t.diagnostic('History kinds: ' + kinds.join(', ') + '; revisions ' + revisions.join('→') +
    '; filters kind/field verified; export shape preserved with workflow detail.');
});
