const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-10 preflight blocks outbound and inbound lookup and related-field dependencies without record instances', async (t) => {
  const token = await login(await provision());
  const source = await createApp(token, 'reference-source');
  const target = await createApp(token, 'reference-dependent');
  const base = (app) => '/apps/' + app.id;
  const request = (app, path, body, method = 'POST', status = 201) =>
    expectRequest(status, base(app) + path, { token, body, method });
  const key = await request(source, '/fields', { code: 'key', name: 'Unique key', type: 'text', uniqueValue: true });
  const label = await addField(token, source.id, 'source_label', 'text');
  await publish(token, source.id);
  const local = await addField(token, target.id, 'local_key', 'text');
  const snapshot = await addField(token, target.id, 'snapshot', 'text');
  const lookup = await request(target, '/fields', { code: 'lookup', name: 'Lookup', type: 'lookup',
    lookup: { appId: source.id, keyFieldId: key.fieldId, localKeyFieldId: local.fieldId,
      copies: [{ sourceFieldId: label.fieldId, targetFieldId: snapshot.fieldId }] } });
  const related = await request(target, '/fields', { code: 'related', name: 'Related', type: 'related',
    related: { appId: source.id, localFieldId: local.fieldId, matchFieldId: key.fieldId, displayFieldIds: [label.fieldId], pageSize: 10 } });
  await publish(token, target.id);
  await request(source, '/draft/fields/' + label.fieldId, undefined, 'DELETE', 200);
  const sourceReport = await request(source, '/publish', undefined, 'POST', 409);
  assert.deepEqual(sourceReport.skippedDependencies, []);
  for (const [dependency, field] of [['lookup', lookup], ['related', related]]) {
    assert.ok(sourceReport.problems.some((item) => item.dependency === dependency && item.fieldId === label.fieldId &&
      item.dependentAppId === target.id && item.dependentFieldId === field.fieldId));
  }
  assert.ok((await request(source, '', undefined, 'DELETE', 409)).problems.length >= 2);
  await request(target, '/draft/fields/' + local.fieldId, undefined, 'DELETE', 200);
  const targetReport = await request(target, '/publish', undefined, 'POST', 409);
  assert.ok(targetReport.problems.some(({ fieldId, dependency }) => fieldId === local.fieldId && dependency === 'lookup'));
  assert.ok(targetReport.problems.some(({ fieldId, dependency }) => fieldId === local.fieldId && dependency === 'related'));
  t.diagnostic(JSON.stringify({ sourceReport, targetReport }));
});

test('G2-10 published workflows protect conditions and require explicit administrator-pool routing', async (t) => {
  const owner = await provision();
  const member = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token, 'workflow-preflight');
  const base = '/apps/' + app.id;
  const request = (path, body, method = 'POST', status = 201) => expectRequest(status, base + path, { token, body, method });
  const reviewer = await addField(token, app.id, 'reviewer', 'user');
  const conditionField = await addField(token, app.id, 'amount', 'number');
  await publish(token, app.id);
  const open = { id: randomUUID(), code: 'open', name: 'Open', initial: true, terminal: false,
    assignees: [{ kind: 'user-field', id: reviewer.fieldId }] };
  const done = { id: randomUUID(), code: 'done', name: 'Done', initial: false, terminal: true, assignees: [] };
  const approve = { id: randomUUID(), name: 'Approve', fromStateId: open.id, toStateId: done.id, assignees: [],
    conditions: [{ fieldId: conditionField.fieldId, operator: 'nonempty' }] };
  await request('/workflow/draft', { states: [open, done], actions: [approve] }, 'PUT', 200);
  await request('/workflow/publish');
  await request('/workflow/enabled', { enabled: true }, 'PATCH', 200);
  const record = await request('/records', { data: { [reviewer.fieldId]: member.userId, [conditionField.fieldId]: '1' } });
  const entry = '/records/' + record.id;
  await request('/draft/fields/' + conditionField.fieldId, { type: 'text' }, 'PATCH', 200);
  let error = await request('/publish', { migration: { incompatible: 'reject' } }, 'POST', 409);
  assert.ok(error.problems.some(({ dependency, recordCount, version }) => dependency === 'workflow-condition' && recordCount === '1' && version === 1));
  await request('/draft/fields/' + conditionField.fieldId, { type: 'number' }, 'PATCH', 200);
  await request('/draft/fields/' + reviewer.fieldId, undefined, 'DELETE', 200);
  error = await request('/publish', { migration: { incompatible: 'reject' } }, 'POST', 409);
  assert.ok(error.problems.some(({ dependency, recordCount }) => dependency === 'workflow-assignee' && recordCount === '1'));
  await request('/workflow/enabled', { enabled: false }, 'PATCH', 200);
  await request('/publish', { migration: { incompatible: 'reject' } }, 'POST', 409);
  const published = await request('/publish', { migration: { incompatible: 'reject', workflowAssignees: 'administrator-pool' } });
  const { workflow } = await request(entry + '/workflow', undefined, 'GET', 200);
  assert.equal(workflow.version, 1);
  assert.deepEqual(workflow.assignees, []);
  assert.match(workflow.attentionReason, /assignee source changed/);
  assert.ok(published.resolvedDependencies.some((problem) => problem.dependency === 'workflow-assignee'));
  const pool = await expectRequest(200, '/workflow/unassigned?appId=' + app.id, { token });
  assert.deepEqual(pool.items.map(({ recordId }) => recordId), [record.id]);
  const events = await request(entry + '/workflow/history', undefined, 'GET', 200);
  assert.equal(events.at(-1).kind, 'workflow-pool');
  await request('/workflow/enabled', { enabled: true }, 'PATCH', 409);
  t.diagnostic(JSON.stringify({ blocked: error.problems, resolved: published.resolvedDependencies, pool: events.at(-1) }));
});
