const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-04 subtables save ordered rows with scoped validation, calculation, row history and ACL', async (t) => {
  const owner = await provision();
  const reader = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const readerToken = await login(reader);
  const { id } = await createApp(token, 'line-items');
  const path = '/apps/' + id;
  const write = (suffix, body, method = 'POST', status = 201, bearer = token) =>
    expectRequest(status, path + suffix, { token: bearer, body, method });
  const code = randomUUID();
  const amount = randomUUID();
  const total = randomUUID();
  const table = {
    fields: [
      { fieldId: code, name: 'SKU', code: 'sku', type: 'text', required: true, uniqueValue: true },
      { fieldId: amount, name: 'Net', code: 'net', type: 'number', required: true },
      { fieldId: total, name: 'Gross', code: 'gross', type: 'calculation', formula: [
        { kind: 'field', fieldId: amount }, { kind: 'number', value: '2' }, { kind: 'operator', operator: '*' },
      ] },
    ], minRows: 1, maxRows: 3, addRows: true, deleteRows: true, reorderRows: true,
  };
  const definition = { code: 'lines', name: 'Line items', type: 'table', table };
  await write('/fields', { ...definition, table: { ...table, fields: [{ ...table.fields[0], type: 'lookup' }] } }, 'POST', 400);
  await write('/fields', { ...definition, table: { ...table, fields: [...table.fields.slice(0, 2), {
    ...table.fields[2], formula: [{ kind: 'field', fieldId: randomUUID() }],
  }] } }, 'POST', 400);
  const field = await write('/fields', definition);
  const fieldId = field.fieldId;
  const readerSubject = { kind: 'user', id: reader.userId };
  const ownerSubject = { kind: 'user', id: owner.userId };
  await write('/draft/acl', {
    app: [{ action: 'view', subject: readerSubject }, { action: 'edit', subject: readerSubject }],
    record: [], field: [
      { action: 'view', subject: ownerSubject, fieldId },
      { action: 'edit', subject: ownerSubject, fieldId },
    ],
  }, 'PUT', 200);
  await publish(token, id);
  const row = (sku, value) => ({ rowId: randomUUID(), data: { [code]: sku, [amount]: value } });
  const [first, second, third] = [row('X', '1.25'), row('Y', '5'), row('Z', '10')];
  const body = (rows) => ({ data: { [fieldId]: JSON.stringify(rows) } });
  await write('/records', body([]), 'POST', 400);
  await write('/records', body([first, row('x', '2')]), 'POST', 400);
  const record = await write('/records', body([first, second]));
  assert.equal(JSON.parse(record.data[fieldId])[0].data[total], '2.5');
  const item = '/records/' + record.id;
  const update = await write(item, { revision: record.revision, ...body([second, first, third]) }, 'PUT', 200);
  const revised = { ...second, data: { ...second.data, [amount]: '7' } };
  const edited = await write(item, { revision: update.revision, ...body([revised, third]) }, 'PUT', 200);
  assert.deepEqual(JSON.parse(edited.data[fieldId]).map(({ rowId }) => rowId), [second.rowId, third.rowId]);
  assert.equal(JSON.parse(edited.data[fieldId])[0].data[total], '14');
  const list = await expectRequest(200, path + '/records', { token });
  assert.equal(list.items[0].data[fieldId], '2');
  const history = await expectRequest(200, path + item + '/history', { token });
  const changes = history.events.flatMap((event) => event.changes);
  assert.ok(changes.some(({ rowId, rowChange }) => rowId === third.rowId && rowChange === 'added'));
  assert.ok(changes.some(({ rowId, rowChange }) => rowId === second.rowId && rowChange === 'moved'));
  assert.ok(changes.some(({ rowId, rowChange }) => rowId === first.rowId && rowChange === 'removed'));
  assert.ok(changes.some(({ rowId, childFieldId, oldValue, newValue }) =>
    rowId === second.rowId && childFieldId === amount && oldValue === '5' && newValue === '7'));
  const restricted = await expectRequest(200, path + item, { token: readerToken });
  assert.ok(!Object.hasOwn(restricted.data, fieldId));
  await write(item, { revision: edited.revision, ...body([third]) }, 'PUT', 403, readerToken);
  const hiddenHistory = await expectRequest(200, path + item + '/history', { token: readerToken });
  assert.ok(hiddenHistory.events.every((event) => event.changes.length === 0));
  t.diagnostic('Created and reordered child rows, deleted one, edited Net 5 → 7 and recalculated Gross to 14. Field ACL removed rows and history values.');
});
