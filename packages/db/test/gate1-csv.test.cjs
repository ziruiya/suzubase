const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G1-11 CSV preflights, resumes atomic batches, reports lookup values, and preserves automatic numbers', async (t) => {
  const owner = await provision();
  const token = await login(owner);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const request = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const amount = await request(201, 'POST', '/fields', { code: 'amount', name: 'Amount', type: 'number', required: true });
  const auto = await request(201, 'POST', '/fields', {
    code: 'number', name: 'Number', type: 'autoNumber',
    autoNumber: { prefix: 'I-', scopeFieldId: null, nextValue: '1', padding: 3, enabled: true },
  });
  await publish(token, app.id);
  const mapping = { Amount: amount.fieldId, Number: auto.fieldId, Customer: 'lookup' };
  const job = await request(201, 'POST', '/csv/preflight', {
    csv: 'Amount,Number,Customer\n10,I-040,\ninvalid,I-041,\n30,I-042,customer-lookup\n20,I-040,\n15,I-045,\n', mapping,
  });
  assert.equal(job.eligible, 2);
  assert.equal(job.failed, 3);
  assert.deepEqual(job.lookupColumns, ['Customer']);
  assert.equal((await request(200, 'GET', '/records/aggregates')).count, '0');
  const download = async (path) => {
    const origin = process.env.TEST_API_URL ?? 'http://api:3000';
    const response = await fetch(new URL(base + path, origin), { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200);
    return response.text();
  };
  const errorReport = await download('/csv/' + job.id + '/errors');
  assert.match(errorReport, /Customer,_row,_errors/);
  assert.match(errorReport, /Lookup columns/);
  const apply = (id, offset, size) => request(201, 'POST', '/csv/' + id + '/apply', { offset, size });
  assert.equal((await apply(job.id, 0, 1)).remaining, 1);
  assert.equal((await apply(job.id, 0, 1)).imported, 1);
  assert.equal((await apply(job.id, 1, 1)).imported, 2);

  const repaired = await request(201, 'POST', '/csv/preflight', { csv: 'Amount,Number\n22,I-041\n', mapping });
  assert.equal(repaired.eligible, 1);
  assert.equal((await apply(repaired.id, 0, 1)).imported, 1);
  const created = await request(201, 'POST', '/records', { data: { [amount.fieldId]: '100' } });
  assert.equal(created.data[auto.fieldId], 'I-046');
  const exported = await download('/csv/export');
  assert.deepEqual(exported.trim().split('\n'), [
    'amount,number', '10,I-040', '15,I-045', '22,I-041', '100,I-046',
  ]);
  t.diagnostic(JSON.stringify({ preflight: job, repaired: repaired.eligible, nextNumber: created.data[auto.fieldId], exported }));
});

test('G1-11 export shares visible row and field scope with list, aggregate, and search', async (t) => {
  const owner = await provision();
  const member = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(member);
  const app = await createApp(token);
  const base = '/apps/' + app.id;
  const as = (status, method, path, body, bearer = token) =>
    expectRequest(status, base + path, { method, token: bearer, body });
  const phone = await addField(token, app.id, 'phone', 'phone');
  const visible = await addField(token, app.id, 'visible', 'text');
  const secret = await addField(token, app.id, 'secret', 'text');
  await publish(token, app.id);
  for (const value of ['yes', 'no']) {
    await as(201, 'POST', '/records', { data: {
      [phone.fieldId]: '090-1234-5678', [visible.fieldId]: value, [secret.fieldId]: 'private',
    } });
  }
  const subject = { kind: 'user', id: member.userId };
  await as(200, 'PUT', '/draft/acl', {
    app: [{ action: 'view', subject }, { action: 'export', subject }],
    record: [{ action: 'view', subject, conditions: [{ fieldId: visible.fieldId, operator: 'eq', value: 'yes' }] }],
    field: [{ fieldId: secret.fieldId, action: 'view', subject: { kind: 'user', id: owner.userId } }],
  });
  await publish(token, app.id);
  const list = await as(200, 'GET', '/records', undefined, reader);
  const aggregate = await as(200, 'GET', '/records/aggregates', undefined, reader);
  const search = await as(200, 'GET', '/records/search?' +
    new URLSearchParams({ field: phone.fieldId, mode: 'tail', query: '5678' }), undefined, reader);
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const response = await fetch(new URL(base + '/csv/export', origin), { headers: { Authorization: 'Bearer ' + reader } });
  assert.equal(response.status, 200);
  const exported = await response.text();
  assert.equal(exported, 'phone,visible\n090-1234-5678,yes\n');
  assert.deepEqual([list.items.length, Number(aggregate.count), Number(search.count)], [1, 1, 1]);
  await as(404, 'POST', '/csv/preflight', { csv: 'Visible\nyes\n', mapping: { Visible: visible.fieldId } }, reader);
  t.diagnostic(JSON.stringify({ list: list.items.length, count: aggregate.count, search: search.count, exported }));
});
