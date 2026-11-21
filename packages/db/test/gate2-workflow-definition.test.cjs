const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-05 workflow drafts validate dependencies and publish immutable independent versions', async (t) => {
  const owner = await provision();
  const reader = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const readerToken = await login(reader);
  const app = await createApp(token, 'workflow-def');
  const root = '/apps/' + app.id;
  const path = root + '/workflow';
  const write = (suffix, body, method, status = 200) => expectRequest(status, path + suffix, { token, body, method });
  const amount = await addField(token, app.id, 'amount', 'number');
  const reviewer = await addField(token, app.id, 'reviewer', 'user');
  const from = randomUUID();
  const to = randomUUID();
  const action = randomUUID();
  const graph = {
    states: [
      { id: from, code: 'open', name: 'Open', initial: true, terminal: false, assignees: [{ kind: 'creator' }] },
      { id: to, code: 'closed', name: 'Closed', initial: false, terminal: true, assignees: [] },
    ],
    actions: [{ id: action, name: 'Approve', fromStateId: from, toStateId: to,
      assignees: [{ kind: 'user-field', id: reviewer.fieldId }, { kind: 'user', id: reader.userId }, { kind: 'previous' }],
      conditions: [{ fieldId: amount.fieldId, operator: 'gte', value: '25.00' }],
    }],
  };
  await write('/enabled', { enabled: true }, 'PATCH', 409);
  await write('/draft', { ...graph, actions: [{ ...graph.actions[0], conditions: [{ fieldId: randomUUID(), operator: 'nonempty' }] }] }, 'PUT', 400);
  const draft = await write('/draft', graph, 'PUT');
  assert.equal(draft.version, 1);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.actions[0].conditions[0].value, '25');
  const blocked = await write('/publish', undefined, 'POST', 409);
  assert.ok(blocked.problems.some((problem) => problem.fieldId === amount.fieldId));
  await publish(token, app.id);
  const v1 = await write('/publish', undefined, 'POST', 201);
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'published');
  assert.deepEqual(await write('/enabled', { enabled: true }, 'PATCH'), { enabled: true });
  await expectRequest(404, path, { token: readerToken });
  await expectRequest(404, path + '/directory', { token: readerToken });
  const directory = await expectRequest(200, path + '/directory', { token });
  assert.ok(directory.user.some(({ id }) => id === reader.userId));
  const edited = { ...graph, actions: [{ ...graph.actions[0], name: 'Finish' }] };
  const v2Draft = await write('/draft', edited, 'PUT');
  assert.equal(v2Draft.version, 2);
  assert.equal((await expectRequest(200, path + '/versions/1', { token })).actions[0].name, 'Approve');
  await write('/publish', undefined, 'POST', 201);
  await write('/enabled', { enabled: false }, 'PATCH');
  const copied = await expectRequest(201, root + '/copy', { token, method: 'POST',
    body: { name: 'Workflow copy', code: 'workflow-copy' } });
  const copyApp = await expectRequest(200, '/apps/' + copied.id, { token });
  const copy = await expectRequest(200, '/apps/' + copied.id + '/workflow', { token });
  assert.equal(copy.enabled, false);
  assert.deepEqual(copy.versions, [{ version: 1, status: 'draft' }]);
  assert.equal(copy.draft.actions[0].conditions[0].fieldId, copyApp.fields.find(({ code }) => code === 'amount').fieldId);
  assert.equal(copy.draft.actions[0].assignees[0].id, copyApp.fields.find(({ code }) => code === 'reviewer').fieldId);
  assert.equal(copy.draft.actions[0].assignees[1].id, reader.userId);
  t.diagnostic('Publishing before the field schema returned 409. Workflow v1 and v2 published independently. Copy made a disabled draft and remapped field references.');
});
