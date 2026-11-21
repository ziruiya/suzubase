const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-05 views publish atomically, filter by current user, and paginate numeric order', async (t) => {
  const owner = await provision();
  const other = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const assignee = await addField(token, app.id, 'person', 'user');
  const amount = await addField(token, app.id, 'amount', 'number');
  await publish(token, app.id);
  for (const [person, value] of [[owner.userId, '100'], [other.userId, '1'], [owner.userId, '20']]) {
    await request(201, 'POST', '/records', { data: { [assignee.fieldId]: person, [amount.fieldId]: value } });
  }
  const input = {
    name: 'My records',
    columns: [{ fieldId: amount.fieldId, width: 140 }],
    conditions: [{ fieldId: assignee.fieldId, operator: 'current-user' }],
    sort: { fieldId: amount.fieldId, direction: 'asc' },
  };
  const draft = await request(201, 'POST', '/draft/views', input);
  const view = draft.views[0];
  await request(400, 'GET', '/records?view=' + view.id);
  await request(200, 'PUT', '/draft/views/default', { viewId: view.id });
  await publish(token, app.id);
  const first = await request(200, 'GET', '/records?limit=1');
  const next = await request(200, 'GET', '/records?limit=1&after=' + first.nextCursor);
  const amounts = [...first.items, ...next.items].map(({ data }) => data[amount.fieldId]);
  assert.deepEqual(amounts, ['20', '100']);
  assert.equal(next.nextCursor, null);
  const aggregates = await request(200, 'GET', '/records/aggregates?fields=' + amount.fieldId);
  assert.equal(aggregates.count, '2');
  assert.equal(aggregates.fields[0].sum, '120');
  assert.equal(Number(aggregates.fields[0].average), 60);
  await request(400, 'GET', '/records/aggregates?fields=' + assignee.fieldId);
  t.diagnostic(JSON.stringify({ aggregates, handChecked: { count: 2, sum: 20 + 100, average: (20 + 100) / 2 } }));

  await request(200, 'DELETE', '/draft/views/' + view.id);
  assert.equal((await request(200, 'GET', '/records')).items.length, 2);
  await publish(token, app.id);
  assert.equal((await request(200, 'GET', '/records')).items.length, 3);
  t.diagnostic(JSON.stringify({ amounts, defaultView: view.name, excluded: '1' }));
});

test('GF-10 organization and group selector UUIDs round-trip and current-user-group filters saved views', async (t) => {
  const owner = await provision({ isAdmin: true });
  const employee = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(employee);
  const tenant = (status, method, path, body) => expectRequest(status, '/tenant' + path, { method, token, body });
  const org = await tenant(201, 'POST', '/organizations', { name: 'Tokyo', parentId: null });
  const sales = await tenant(201, 'POST', '/groups', { name: 'Sales' });
  const support = await tenant(201, 'POST', '/groups', { name: 'Support' });
  await tenant(200, 'PUT', '/groups/' + sales.id + '/members/' + employee.userId, { included: true });
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const call = (status, method, path, body, bearer = token) => expectRequest(status, base + path, { method, token: bearer, body });
  const location = await call(201, 'POST', '/fields', { type: 'organization', name: 'Office', code: 'office' });
  const team = await call(201, 'POST', '/fields', { type: 'group', name: 'Team', code: 'team' });
  await publish(token, app.id);
  const fields = { [location.fieldId]: org.id, [team.fieldId]: sales.id };
  const included = await call(201, 'POST', '/records', { data: fields });
  await call(201, 'POST', '/records', { data: { ...fields, [team.fieldId]: support.id } });
  const draft = await call(201, 'POST', '/draft/views', { name: 'My teams', columns: [],
    conditions: [{ fieldId: team.fieldId, operator: 'current-user-group' }] });
  await call(200, 'PUT', '/draft/acl', { app: [{ action: 'view', subject: { kind: 'user', id: employee.userId } }],
    record: [], field: [] });
  await publish(token, app.id);
  const options = await call(200, 'GET', '/selector-options', undefined, reader);
  assert.deepEqual(options.organization, [{ id: org.id, name: 'Tokyo' }]);
  assert.deepEqual(options.group.map(({ name }) => name), ['Sales', 'Support']);
  const scoped = await call(200, 'GET', '/records?view=' + draft.views[0].id, undefined, reader);
  assert.deepEqual(scoped.items.map(({ id }) => id), [included.id]);
  assert.deepEqual(scoped.items[0].data, fields);
  const blocked = await tenant(409, 'DELETE', '/organizations/' + org.id);
  assert.equal(blocked.references.length, 2);
  t.diagnostic(JSON.stringify({ organization: fields[location.fieldId], group: fields[team.fieldId], currentUserGroupMatches: scoped.items.length }));
});
