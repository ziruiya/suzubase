const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

function state(code, name, props = {}) {
  return { id: randomUUID(), code, name, initial: false, terminal: false, assignees: [], ...props };
}

function transition(name, from, to, assignees = [], conditions = []) {
  return { id: randomUUID(), name, fromStateId: from.id, toStateId: to.id, assignees, conditions };
}

test('G2-06 expense workflow resolves branches, rejects stale claims and retains bound versions', async (t) => {
  const owner = await provision();
  const supervisor = await provision({ tenantId: owner.tenantId });
  const manager = await provision({ tenantId: owner.tenantId });
  const ownerToken = await login(owner);
  const supervisorToken = await login(supervisor);
  const managerToken = await login(manager);
  const app = await createApp(ownerToken, 'expense-approval');
  const base = '/apps/' + app.id;
  const amount = await addField(ownerToken, app.id, 'amount', 'number');
  const write = (path, body, method = 'POST', status = 201, token = ownerToken) =>
    expectRequest(status, base + path, { token, body, method });
  await write('/draft/acl', {
    app: [supervisor, manager].flatMap(({ userId }) =>
      ['view', 'edit'].map((action) => ({ action, subject: { kind: 'user', id: userId } }))),
    record: [], field: [],
  }, 'PUT', 200);
  await publish(ownerToken, app.id);
  const initial = state('applicant', 'Applicant', { initial: true, assignees: [{ kind: 'creator' }] });
  const sup = state('supervisor', 'Supervisor');
  const mgr = state('manager', 'Manager');
  const done = state('done', 'Complete', { terminal: true });
  const condition = (operator) => [{ fieldId: amount.fieldId, operator, value: '100' }];
  const supervisorRule = { kind: 'user', id: supervisor.userId };
  const managerRule = { kind: 'user', id: manager.userId };
  const submit = transition('Submit to supervisor', initial, sup, [supervisorRule, managerRule], condition('lt'));
  const direct = transition('Submit to manager', initial, mgr, [managerRule], condition('gte'));
  const forward = transition('Supervisor approval', sup, mgr, [managerRule]);
  const reject = transition('Return to applicant', mgr, initial, [{ kind: 'creator' }]);
  const approve = transition('Final approval', mgr, done);
  const graph = { states: [initial, sup, mgr, done], actions: [submit, direct, forward, reject, approve] };
  await write('/workflow/draft', graph, 'PUT', 200);
  await write('/workflow/publish');
  await write('/workflow/enabled', { enabled: true }, 'PATCH', 200);
  const record = await write('/records', { data: { [amount.fieldId]: '20' } });
  const root = '/records/' + record.id;
  const read = async (token = ownerToken) => (await expectRequest(200, base + root + '/workflow', { token })).workflow;
  const run = async (action, revision, token = ownerToken) => {
    const payload = { action_id: action.id, revision };
    const response = await write(root + '/workflow/actions', payload, 'POST', 201, token);
    t.diagnostic(JSON.stringify({ action: action.name, request: payload, response }));
    return response;
  };
  const created = await read();
  const initialHistory = await expectRequest(200, base + root + '/history', { token: ownerToken });
  t.diagnostic(JSON.stringify({ action: 'Create expense', request: { data: { [amount.fieldId]: '20' } },
    response: { state: created.state.code, revision: record.revision, version: created.version,
      assigneeIds: created.assignees.map(({ id }) => id), eventId: initialHistory.events[0].eventId } }));
  assert.equal(created.version, 1);
  assert.deepEqual(created.assignees.map(({ id }) => id), [owner.userId]);
  assert.ok(created.actions.find(({ id }) => id === direct.id).reason);
  await write(root + '/workflow/actions', { action_id: submit.id, revision: record.revision, to_state_id: done.id }, 'POST', 400);
  const review = await run(submit, record.revision);
  assert.deepEqual(review.assigneeIds.sort(), [supervisor.userId, manager.userId].sort());
  const tasks = await expectRequest(200, '/workflow/tasks?appId=' + app.id + '&state=supervisor', { token: supervisorToken });
  assert.deepEqual(tasks.items.map(({ recordId }) => recordId), [record.id]);

  const forwardInput = { action_id: forward.id, revision: review.revision };
  const raced = await Promise.all([supervisorToken, managerToken].map((token) =>
    request(base + root + '/workflow/actions', { method: 'POST', body: forwardInput, token })));
  assert.deepEqual(raced.map(({ status }) => status).sort(), [201, 409]);
  t.diagnostic(JSON.stringify({ action: forward.name, request: forwardInput, responses: raced }));
  const pending = raced.find(({ status }) => status === 201).body;
  assert.equal(pending.state.code, 'manager');
  assert.deepEqual(pending.assigneeIds, [manager.userId]);
  const returned = await run(reject, pending.revision, managerToken);
  assert.deepEqual(returned.assigneeIds, [owner.userId]);
  assert.equal(returned.state.code, 'applicant');
  const edited = await write(root, { revision: returned.revision, data: { [amount.fieldId]: '150' } }, 'PUT', 200);
  const editedHistory = await expectRequest(200, base + root + '/history', { token: ownerToken });
  t.diagnostic(JSON.stringify({ action: 'Edit returned expense', request: { revision: returned.revision, data: { [amount.fieldId]: '150' } },
    response: { state: edited.status, revision: edited.revision, assigneeIds: [owner.userId], eventId: editedHistory.events.find(({ recordRevision }) => recordRevision === edited.revision).eventId } }));

  const replacement = state('v2', 'New initial', { initial: true, assignees: [{ kind: 'creator' }] });
  await write('/workflow/draft', { states: [replacement], actions: [] }, 'PUT', 200);
  await write('/workflow/publish');
  assert.equal((await read()).version, 1);
  const newRecord = await write('/records', { data: { [amount.fieldId]: '2' } });
  const { workflow: newWorkflow } = await expectRequest(200, base + '/records/' + newRecord.id + '/workflow', { token: ownerToken });
  assert.equal(newWorkflow.version, 2);
  assert.equal(newWorkflow.state.code, 'v2');
  const resubmitted = await run(direct, edited.revision);
  assert.equal(resubmitted.state.code, 'manager');
  const final = await run(approve, resubmitted.revision, managerToken);
  assert.equal(final.state.code, 'done');
  assert.equal(final.version, 1);
  assert.deepEqual(final.assigneeIds, []);
  assert.deepEqual((await read()).actions, []);
  const handoff = await write('/records/' + newRecord.id + '/workflow/reassign', {
    revision: newRecord.revision, userIds: [supervisor.userId],
  });
  assert.deepEqual(handoff.assigneeIds, [supervisor.userId]);

  await write('/workflow/enabled', { enabled: false }, 'PATCH', 200);
  const ordinary = await write('/records', { data: {} });
  assert.equal((await expectRequest(200, base + '/records/' + ordinary.id + '/workflow', { token: ownerToken })).workflow, null);
  assert.equal((await read()).state.code, 'done');
});

test('G2-06 construction-confirmation workflow supports an overdue state-and-date saved view', async (t) => {
  const owner = await provision();
  const confirmer = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token, 'construction-confirmation');
  const base = '/apps/' + app.id;
  const date = await addField(token, app.id, 'start_date', 'date');
  const person = await addField(token, app.id, 'confirmer', 'user');
  await publish(token, app.id);
  const states = [
    state('introduced', '紹介済', { initial: true, assignees: [{ kind: 'creator' }] }),
    state('contract', '契約確認'),
    state('waiting', '着工待確認'),
    state('confirmed', '着工確認済', { terminal: true }),
  ];
  const actions = states.slice(1).map((entry, i) => transition(entry.name, states[i], entry,
    [{ kind: 'user-field', id: person.fieldId }], [{ fieldId: date.fieldId, operator: 'nonempty' }]));
  const send = (path, body, method = 'POST', status = 201) => expectRequest(status, base + path, { token, body, method });
  await send('/workflow/draft', { states, actions }, 'PUT', 200);
  await send('/workflow/publish');
  await send('/workflow/enabled', { enabled: true }, 'PATCH', 200);
  const views = await send('/draft/views', { name: 'Overdue start', columns: [], conditions: [],
    workflowState: 'waiting', pastDateFieldId: date.fieldId });
  await publish(token, app.id);
  let record = await send('/records', { data: {} });
  const root = '/records/' + record.id;
  const waiting = '/records?view=' + views.views[0].id;
  await send(root + '/workflow/actions', { action_id: actions[0].id, revision: record.revision }, 'POST', 403);
  for (const [i, action] of actions.entries()) {
    const payload = { revision: record.revision, data: {
      [date.fieldId]: '2001-01-0' + (i + 1), [person.fieldId]: confirmer.userId,
    } };
    record = await send(root, payload, 'PUT', 200);
    const history = await expectRequest(200, base + root + '/history', { token });
    t.diagnostic(JSON.stringify({ action: 'Set start date and confirmer', request: payload,
      response: { state: record.status, revision: record.revision, eventId: history.events.find(({ recordRevision }) => recordRevision === record.revision).eventId } }));
    const input = { action_id: action.id, revision: record.revision };
    const result = await send(root + '/workflow/actions', input);
    t.diagnostic(JSON.stringify({ action: action.name, request: input, response: result }));
    assert.equal(result.state.code, states[i + 1].code);
    assert.deepEqual(result.assigneeIds, i === 2 ? [] : [confirmer.userId]);
    record.revision = result.revision;
    const list = await expectRequest(200, base + waiting, { token });
    assert.deepEqual(list.items.map(({ id }) => id), i === 1 ? [record.id] : []);
  }
});

test('G2-06 disable wizard requires active assignments to be transferred with history', async (t) => {
  const owner = await provision({ isAdmin: true });
  const old = await provision({ tenantId: owner.tenantId });
  const recipient = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token, 'handoff');
  const base = '/apps/' + app.id;
  const send = (path, body, method = 'POST', status = 201) => expectRequest(status, path, { token, method, body });
  const assigned = state('assigned', 'Assigned', { initial: true, assignees: [{ kind: 'user', id: old.userId }] });
  await send(base + '/workflow/draft', { states: [assigned], actions: [] }, 'PUT', 200);
  await send(base + '/workflow/publish');
  await send(base + '/workflow/enabled', { enabled: true }, 'PATCH', 200);
  const record = await send(base + '/records', { data: {} });
  const disable = '/tenant/users/' + old.userId + '/disable';
  const preview = await send(disable, undefined, 'GET', 200);
  assert.deepEqual(preview.assignments.map(({ id }) => id), [record.id]);
  assert.equal((await send(disable, undefined, 'POST', 409)).assignments[0].id, record.id);
  const transfer = await send(base + '/records/' + record.id + '/workflow/handoff', {
    revision: record.revision, fromUserId: old.userId, toUserId: recipient.userId,
  });
  assert.deepEqual(transfer.assigneeIds, [recipient.userId]);
  assert.deepEqual(await send(disable, undefined, 'GET', 200), { records: [], assignments: [] });
  assert.deepEqual(await send(disable), { disabled: true });
  const { events } = await send(base + '/records/' + record.id + '/history', undefined, 'GET', 200);
  assert.equal(events.find(({ eventId }) => eventId === transfer.eventId).kind, 'workflow-reassigned');
  t.diagnostic(JSON.stringify({ blockedRecordId: record.id, transferredTo: recipient.userId, eventId: transfer.eventId }));
});
