const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-01 lookup keeps typed snapshots until a revision-bound refresh is confirmed', async (t) => {
  const token = await login(await provision());
  const source = await createApp(token, 'source');
  const destination = await createApp(token, 'destination');
  const add = (appId, body, status = 201) =>
    expectRequest(status, '/apps/' + appId + '/fields', { token, method: 'POST', body });
  const key = await add(source.id, { code: 'key', name: 'Unique key', type: 'text', uniqueValue: true });
  const amount = await addField(token, source.id, 'amount', 'number');
  const notUnique = await addField(token, source.id, 'other', 'text');
  await publish(token, source.id);
  const local = await addField(token, destination.id, 'key', 'text');
  const copy = await addField(token, destination.id, 'copy', 'number');
  const config = { appId: source.id, keyFieldId: key.fieldId, localKeyFieldId: local.fieldId,
    copies: [{ sourceFieldId: amount.fieldId, targetFieldId: copy.fieldId }] };
  const lookup = { code: 'lookup', name: 'Lookup', type: 'lookup', lookup: config };
  assert.match(JSON.stringify(await add(destination.id, { ...lookup, lookup: { ...config, keyFieldId: notUnique.fieldId } }, 400)), /unique field/);
  const { fieldId } = await add(destination.id, lookup);
  await publish(token, destination.id);

  const src = '/apps/' + source.id + '/records';
  const dest = '/apps/' + destination.id + '/records';
  const post = (path, body, status = 201) => expectRequest(status, path, { token, method: 'POST', body });
  const get = (path, status = 200) => expectRequest(status, path, { token });
  const put = (path, body, status = 200) => expectRequest(status, path, { token, method: 'PUT', body });
  const original = await post(src, { data: { [key.fieldId]: 'ABC', [amount.fieldId]: '01.2500' } });
  const second = await post(src, { data: { [key.fieldId]: 'DEF', [amount.fieldId]: '9' } });
  const miss = await post(dest, { data: { [local.fieldId]: 'unknown' } }, 400);
  assert.match(JSON.stringify(miss), /No visible record/);
  assert.deepEqual((await get(dest)).items, []);
  await post(dest, { data: { [local.fieldId]: 'abc', [copy.fieldId]: '999' } }, 400);
  const matched = await post(dest, { data: { [local.fieldId]: 'abc' } });
  assert.equal(matched.data[copy.fieldId], '1.25');
  t.diagnostic('Lookup key abc produced snapshot 1.25; unknown key failed with HTTP 400 and no record');

  const recordPath = dest + '/' + matched.id;
  const refresh = recordPath + '/lookups/' + fieldId + '/refresh';
  const srcPath = src + '/' + original.id;
  const changed = await put(srcPath, { revision: original.revision, data: { [key.fieldId]: 'ABC', [amount.fieldId]: '2.5' } });
  assert.equal((await get(recordPath)).data[copy.fieldId], '1.25');
  const oldPreview = await get(refresh);
  assert.deepEqual(oldPreview.changes, [{ fieldId: copy.fieldId, name: 'copy', current: '1.25', incoming: '2.5' }]);
  await put(srcPath, { revision: changed.revision, data: { [key.fieldId]: 'ABC', [amount.fieldId]: '3.75' } });
  await post(refresh, { revision: oldPreview.revision, confirmation: oldPreview.confirmation }, 409);
  const preview = await get(refresh);
  t.diagnostic('Refresh changes ' + JSON.stringify(preview.changes));
  const refreshed = await post(refresh, { revision: preview.revision, confirmation: preview.confirmation });
  assert.equal(refreshed.data[copy.fieldId], '3.75');
  const history = await get(recordPath + '/history');
  assert.ok(history.events.some((event) => event.kind === 'lookup-refetched'));
  const rekeyed = await put(recordPath, { revision: refreshed.revision, data: { [local.fieldId]: 'DEF' } });
  assert.equal(rekeyed.data[copy.fieldId], '9');
  await expectRequest(200, src + '/' + second.id, { token, method: 'DELETE', body: { revision: second.revision } });
  assert.equal((await get(refresh, 404)).message, '无权限');
  assert.equal((await get(recordPath)).data[copy.fieldId], '9');
});

test('G2-02 reference search paginates configured numeric order and projects only visible configured columns', async (t) => {
  const owner = await provision();
  const member = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(member);
  const source = await createApp(token, 'sources');
  const dest = await createApp(token, 'dest');
  const sourcePath = '/apps/' + source.id;
  const destPath = '/apps/' + dest.id;
  const write = (path, body, method = 'POST', status = 201, bearer = token) =>
    expectRequest(status, path, { method, body, token: bearer });
  const key = await write(sourcePath + '/fields', { code: 'key', name: 'Key', type: 'text', uniqueValue: true });
  const rank = await addField(token, source.id, 'rank', 'number');
  const confidential = await addField(token, source.id, 'confidential', 'text');
  const group = await addField(token, source.id, 'group', 'text');
  const local = await addField(token, dest.id, 'reference', 'text');
  const snapshot = await addField(token, dest.id, 'snapshot', 'number');
  const readerSubject = { kind: 'user', id: member.userId };
  const ownerSubject = { kind: 'user', id: owner.userId };
  await write(sourcePath + '/draft/acl', {
    app: [{ action: 'view', subject: readerSubject }],
    record: [
      { action: 'view', subject: readerSubject, conditions: [{ fieldId: group.fieldId, operator: 'eq', value: 'allowed' }] },
      { action: 'view', subject: ownerSubject, conditions: [] },
    ],
    field: [{ action: 'view', subject: ownerSubject, fieldId: confidential.fieldId }],
  }, 'PUT', 200);
  await publish(token, source.id);
  const lookup = await write(destPath + '/fields', { code: 'lookup', name: 'Lookup', type: 'lookup',
    lookup: { appId: source.id, keyFieldId: key.fieldId, localKeyFieldId: local.fieldId,
      copies: [{ sourceFieldId: rank.fieldId, targetFieldId: snapshot.fieldId }],
      displayFieldIds: [rank.fieldId, confidential.fieldId],
      sort: { fieldId: rank.fieldId, direction: 'desc' },
      conditions: [{ fieldId: rank.fieldId, operator: 'ne', value: '99' }],
    } });
  await write(destPath + '/draft/acl', {
    app: [{ action: 'view', subject: readerSubject }, { action: 'create', subject: readerSubject }], record: [], field: [],
  }, 'PUT', 200);
  await publish(token, dest.id);
  const data = (n, visibility = 'allowed') => ({
    [key.fieldId]: 'REF-' + n, [rank.fieldId]: String(n), [group.fieldId]: visibility, [confidential.fieldId]: 'hidden',
  });
  await write(sourcePath + '/records/batch', { items: [
    ...Array.from({ length: 21 }, (_, i) => ({ data: data(i + 1) })),
    { data: data(99) }, { data: data(100, 'denied') },
  ] });
  const url = destPath + '/records/reference-search?fieldId=' + lookup.fieldId + '&query=ref-';
  const first = await expectRequest(200, url, { token: reader });
  assert.deepEqual(first.columns.map(({ fieldId }) => fieldId).sort(), [key.fieldId, rank.fieldId].sort());
  assert.deepEqual(first.items.map((row) => row[rank.fieldId]), Array.from({ length: 20 }, (_, i) => String(21 - i)));
  assert.ok(first.items.every((row) => Object.keys(row).length === 2));
  const next = await expectRequest(200, url + '&after=' + first.next, { token: reader });
  assert.deepEqual(next.items, [{ [key.fieldId]: 'REF-1', [rank.fieldId]: '1' }]);
  assert.equal(next.next, null);
  const saved = await write(destPath + '/records', { data: { [local.fieldId]: next.items[0][key.fieldId] } }, 'POST', 201, reader);
  assert.equal(saved.data[snapshot.fieldId], '1');
  t.diagnostic('Reader saw 20 + 1 rows in descending numeric order. Record ACL, configured filter and field ACL hid excluded data.');
});
