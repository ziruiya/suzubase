const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-10 normalizes Japanese search projections and excludes unreadable records and fields', async (t) => {
  const owner = await provision();
  const member = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(member);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const request = (status, method, path, body, bearer = token) => expectRequest(status, base + path, { method, token: bearer, body });
  const phone = await addField(token, app.id, 'phone', 'phone');
  const email = await addField(token, app.id, 'email', 'email');
  const amount = await addField(token, app.id, 'amount', 'number');
  const text = async (code, searchMode) => request(201, 'POST', '/fields', { name: code, code, type: 'text', searchMode });
  const name = await text('name', 'name');
  const kana = await text('kana', 'kana');
  const customer = await text('customer', 'customer-id');
  await publish(token, app.id);
  const data = {
    [name.fieldId]: '山田　太郎', [kana.fieldId]: 'ヤマダ タロウ', [phone.fieldId]: '０９０（１２３４）５６７８',
    [email.fieldId]: 'Contact@example.test', [customer.fieldId]: 'C-1123', [amount.fieldId]: '1',
  };
  const visible = await request(201, 'POST', '/records', { data });
  await request(201, 'POST', '/records', { data: { ...data, [amount.fieldId]: '0' } });
  const search = (field, query, mode = 'exact', status = 200, bearer = token) =>
    request(status, 'GET', '/records/search?' + new URLSearchParams({ field: field.fieldId, query, mode }), undefined, bearer);
  const cases = [
    [phone, '090-1234-5678', 'exact', '2'],
    [phone, '５６７８', 'tail', '2'],
    [name, '山 田 太 郎', 'exact', '2'],
    [name, 'ヤマダ タロウ', 'exact', '0'],
    [kana, 'ﾔﾏﾀﾞﾀﾛｳ', 'exact', '2'],
    [customer, 'C-11', 'prefix', '2'],
    [customer, 'C-1%', 'prefix', '0'],
    [email, 'contact@EXAMPLE.test', 'exact', '2'],
  ];
  const outcomes = [];
  for (const [field, query, mode, expected] of cases) {
    const result = await search(field, query, mode);
    assert.equal(result.count, expected);
    outcomes.push({ field: field.code, query, mode, count: result.count });
  }
  await search(phone, '678', 'tail', 400);
  const subject = { kind: 'user', id: member.userId };
  const creator = { kind: 'user', id: owner.userId };
  await request(200, 'PUT', '/draft/acl', {
    app: [{ action: 'view', subject }],
    record: [
      { action: 'view', subject, conditions: [{ fieldId: amount.fieldId, operator: 'eq', value: '1' }] },
      { action: 'view', subject: creator, conditions: [] },
    ],
    field: [{ fieldId: email.fieldId, action: 'view', subject: creator }],
  });
  await publish(token, app.id);
  const result = await search(phone, '5678', 'tail', 200, reader);
  assert.equal(result.count, '1');
  assert.deepEqual(result.items.map(({ id }) => id), [visible.id]);
  assert.equal(result.items[0].data[email.fieldId], undefined);
  const denied = await search(email, 'contact@example.test', 'exact', 404, reader);
  assert.equal(denied.message, '无权限');
  assert.equal((await request(200, 'GET', '/records/aggregates', undefined, reader)).count, result.count);
  t.diagnostic(JSON.stringify({ outcomes, authorizedTailHits: result.count, hiddenField: denied.message }));
});
