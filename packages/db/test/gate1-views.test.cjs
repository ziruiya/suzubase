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
  await request(200, 'DELETE', '/draft/views/' + view.id);
  assert.equal((await request(200, 'GET', '/records')).items.length, 2);
  await publish(token, app.id);
  assert.equal((await request(200, 'GET', '/records')).items.length, 3);
  t.diagnostic(JSON.stringify({ amounts, defaultView: view.name, excluded: '1' }));
});
