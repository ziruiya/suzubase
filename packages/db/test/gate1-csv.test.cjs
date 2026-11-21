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

test('GF-10 ad hoc search ZIP contains only authorized hits and verifies attachment bytes and manifest', async (t) => {
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const { unzipSync } = createRequire(require.resolve('../../../apps/api/package.json'))('fflate');
  const { parse } = createRequire(require.resolve('../../../apps/api/package.json'))('csv-parse/sync');
  const owner = await provision();
  const user = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(user);
  const { id } = await expectRequest(201, '/apps', {
    method: 'POST', token, body: { code: 'customer-search', name: 'Customers', template: 'customers' },
  });
  const base = '/apps/' + id;
  const call = (status, method, path, body, bearer = token) => expectRequest(status, base + path, { token: bearer, method, body });
  const configured = await call(200, 'GET', '');
  const field = (code) => configured.fields.find((entry) => entry.code === code).fieldId;
  assert.notEqual(field('name'), field('name-kana'));
  const attachment = await call(201, 'POST', '/fields', { name: 'Attachment', code: 'attachment', type: 'attachment' });
  await publish(token, id);
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const payload = Buffer.from('%PDF-1.4\nZIP payload\n%%EOF\n');
  async function seed(name, phone) {
    const result = await fetch(new URL(base + '/files?' + new URLSearchParams({ type: 'application/pdf', name: name + '.pdf' }), origin),
      { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' }, body: payload });
    assert.equal(result.status, 201);
    const file = await result.json();
    await call(201, 'POST', '/records', { data: {
      [field('name')]: name, [field('phone')]: phone, [attachment.fieldId]: JSON.stringify([file.id]),
    } });
    return file;
  }
  const visible = await seed('Visible', '09012345678');
  await seed('Hidden', '09012345678');
  await seed('Nonmatching', '09012340000');
  await call(200, 'PUT', '/draft/acl', {
    app: ['view', 'export'].map((action) => ({ action, subject: { kind: 'user', id: user.userId } })),
    record: [{ action: 'view', subject: { kind: 'user', id: user.userId }, conditions: [
      { fieldId: field('name'), operator: 'ne', value: 'Hidden' },
    ] }],
    field: [],
  });
  await publish(token, id);
  const query = new URLSearchParams({ field: field('phone'), mode: 'tail', query: '5678' });
  const hits = await call(200, 'GET', '/records/search?' + query, undefined, reader);
  assert.equal(hits.count, '1');
  const zip = await fetch(new URL(base + '/csv/export?' + query + '&attachments=true', origin),
    { headers: { Authorization: 'Bearer ' + reader } });
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-type'), /^application\/zip/);
  const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(Object.keys(entries).sort(), ['attachments.csv', 'attachments/' + visible.id, 'records.csv']);
  const manifest = parse(Buffer.from(entries['attachments.csv']), { columns: true });
  const sha256 = createHash('sha256').update(payload).digest('hex');
  assert.deepEqual(manifest, [{ id: visible.id, name: 'Visible.pdf', sha256, bytes: String(payload.length), path: 'attachments/' + visible.id }]);
  assert.deepEqual(Buffer.from(entries[manifest[0].path]), payload);
  const rows = parse(Buffer.from(entries['records.csv']), { columns: true });
  assert.deepEqual(rows.map(({ name }) => name), ['Visible']);
  t.diagnostic(JSON.stringify({ searchHits: hits.count, csvRows: rows.length, attachmentBytes: payload.length, sha256 }));
});
