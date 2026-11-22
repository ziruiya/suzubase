const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

test('G2-12 six ACL paths agree on lookup snapshots and related records, preview predicts display, blind editor cannot re-fetch', async (t) => {
  configureRuntime();
  const { deliverNotifications } = require('../../../apps/api/dist/notification-worker.js');
  const owner = await provision();
  const readerIdentity = await provision({ tenantId: owner.tenantId });
  const editorIdentity = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const reader = await login(readerIdentity);
  const editor = await login(editorIdentity);
  const user = (identity) => ({ kind: 'user', id: identity.userId });

  // Source app: reader sees only gate=public records; editor has no access at all.
  const source = await createApp(token, 'acl-source');
  const sBase = '/apps/' + source.id;
  const sWrite = (status, method, path, body) => expectRequest(status, sBase + path, { method, token, body });
  const key = await sWrite(201, 'POST', '/fields', { code: 'key', name: 'Key', type: 'text', uniqueValue: true });
  const amount = await addField(token, source.id, 'amount', 'number');
  const label = await addField(token, source.id, 'label', 'text');
  const gate = await addField(token, source.id, 'gate', 'text');
  await sWrite(200, 'PUT', '/draft/acl', {
    app: [{ action: 'view', subject: user(readerIdentity) }],
    record: [
      { action: 'view', subject: user(owner), conditions: [] },
      { action: 'view', subject: user(readerIdentity), conditions: [{ fieldId: gate.fieldId, operator: 'eq', value: 'public' }] },
    ],
    field: [],
  });
  await publish(token, source.id);
  const sPost = (data) => sWrite(201, 'POST', '/records', { data });
  await sPost({ [key.fieldId]: 'K1', [amount.fieldId]: '4242', [label.fieldId]: 'Alpha', [gate.fieldId]: 'public' });
  await sPost({ [key.fieldId]: 'K2', [amount.fieldId]: '99', [label.fieldId]: 'Beta', [gate.fieldId]: 'private' });

  // Destination app: lookup snapshot target `copy` is viewable by owner+editor only.
  const dest = await createApp(token, 'acl-dest');
  const dBase = '/apps/' + dest.id;
  const dWrite = (status, method, path, body, bearer = token) =>
    expectRequest(status, dBase + path, { method, token: bearer, body });
  const local = await dWrite(201, 'POST', '/fields', { code: 'local_key', name: 'local_key', type: 'text', searchMode: 'customer-id' });
  const copy = await addField(token, dest.id, 'copy', 'number');
  const lookup = await dWrite(201, 'POST', '/fields', { code: 'lookup', name: 'Lookup', type: 'lookup', lookup: {
    appId: source.id, keyFieldId: key.fieldId, localKeyFieldId: local.fieldId,
    copies: [{ sourceFieldId: amount.fieldId, targetFieldId: copy.fieldId }],
  } });
  const related = await dWrite(201, 'POST', '/fields', { code: 'related', name: 'Related', type: 'related', related: {
    appId: source.id, localFieldId: local.fieldId, matchFieldId: key.fieldId,
    displayFieldIds: [label.fieldId], pageSize: 10,
  } });
  await dWrite(200, 'PUT', '/draft/acl', {
    app: [
      { action: 'view', subject: user(readerIdentity) }, { action: 'export', subject: user(readerIdentity) },
      { action: 'view', subject: user(editorIdentity) }, { action: 'create', subject: user(editorIdentity) },
      { action: 'edit', subject: user(editorIdentity) },
    ],
    record: [
      { action: 'view', subject: user(owner), conditions: [] },
      { action: 'edit', subject: user(owner), conditions: [] },
      { action: 'view', subject: user(readerIdentity), conditions: [] },
      { action: 'view', subject: user(editorIdentity), conditions: [] },
      { action: 'edit', subject: user(editorIdentity), conditions: [] },
    ],
    field: [
      { fieldId: copy.fieldId, action: 'view', subject: user(owner) },
      { fieldId: copy.fieldId, action: 'view', subject: user(editorIdentity) },
      { fieldId: copy.fieldId, action: 'edit', subject: user(owner) },
      { fieldId: copy.fieldId, action: 'edit', subject: user(editorIdentity) },
      { fieldId: related.fieldId, action: 'view', subject: user(owner) },
      { fieldId: related.fieldId, action: 'view', subject: user(readerIdentity) },
      { fieldId: related.fieldId, action: 'view', subject: user(editorIdentity) },
    ],
  });
  await publish(token, dest.id);
  const d1 = await dWrite(201, 'POST', '/records', { data: { [local.fieldId]: 'K1' } });
  const d2 = await dWrite(201, 'POST', '/records', { data: { [local.fieldId]: 'K2' } });
  assert.equal(d1.data[copy.fieldId], '4242');
  assert.equal(d2.data[copy.fieldId], '99');

  // Path 1 — list: reader sees both records, snapshot values masked.
  const list = await dWrite(200, 'GET', '/records', undefined, reader);
  assert.equal(list.items.length, 2);
  assert.ok(list.items.every((item) => !Object.hasOwn(item.data, copy.fieldId)));
  // Path 2 — count/aggregate: count agrees with list; hidden numeric field rejected.
  const aggregate = await dWrite(200, 'GET', '/records/aggregates', undefined, reader);
  assert.equal(aggregate.count, '2');
  await dWrite(400, 'GET', '/records/aggregates?fields=' + copy.fieldId, undefined, reader);
  // Path 3 — reference display: detail masks the snapshot; related follows source ACL.
  const detail = await dWrite(200, 'GET', '/records/' + d1.id, undefined, reader);
  assert.ok(!Object.hasOwn(detail.data, copy.fieldId));
  const form = await dWrite(200, 'GET', '/records/' + d1.id + '/form', undefined, reader);
  assert.ok(!form.fields.some(({ fieldId }) => fieldId === copy.fieldId));
  assert.ok(!Object.hasOwn(form.record.data, copy.fieldId));
  const relatedD1 = await dWrite(200, 'GET', '/records/' + d1.id + '/related/' + related.fieldId, undefined, reader);
  assert.equal(relatedD1.count, '1');
  assert.deepEqual(relatedD1.items, [{ [label.fieldId]: 'Alpha' }]);
  const relatedD2 = await dWrite(200, 'GET', '/records/' + d2.id + '/related/' + related.fieldId, undefined, reader);
  assert.equal(relatedD2.count, '0');
  // Path 4 — export: no snapshot column or values for the restricted exporter.
  const origin = process.env.TEST_API_URL ?? 'http://api:3000';
  const exported = await fetch(new URL(dBase + '/csv/export', origin), { headers: { Authorization: 'Bearer ' + reader } });
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.ok(!csv.includes('4242') && !csv.includes('snapshot:'), csv);
  // Path 5 — search: visible key field finds the record without the snapshot;
  // searching the hidden snapshot field itself is rejected.
  const hits = await dWrite(200, 'GET', '/records/search?' +
    new URLSearchParams({ field: local.fieldId, mode: 'exact', query: 'K1' }), undefined, reader);
  assert.equal(hits.count, '1');
  assert.ok(!Object.hasOwn(hits.items[0].data, copy.fieldId));
  const hiddenSearch = await request(dBase + '/records/search?' +
    new URLSearchParams({ field: copy.fieldId, mode: 'exact', query: '4242' }), { token: reader });
  assert.notEqual(hiddenSearch.status, 200, JSON.stringify(hiddenSearch.body));
  // Path 6 — history: reader's history carries no snapshot values.
  const history = await dWrite(200, 'GET', '/records/' + d1.id + '/history', undefined, reader);
  assert.ok(!JSON.stringify(history).includes('4242'));

  // Preview consistency: the same field decisions predict the formal outcomes.
  const preview = await dWrite(201, 'POST', '/permissions/preview', { userId: readerIdentity.userId, recordId: d1.id });
  assert.equal(preview.fields[copy.fieldId].view.allowed, false);
  assert.equal(preview.fields[related.fieldId].view.allowed, true);
  assert.equal(preview.fields[local.fieldId].view.allowed, true);
  const editorPreview = await dWrite(201, 'POST', '/permissions/preview', { userId: editorIdentity.userId, recordId: d1.id });
  assert.equal(editorPreview.fields[copy.fieldId].view.allowed, true);

  // Notification masking cross-check: a rule template referencing the snapshot
  // field renders masked for the reader.
  const rules = [{ id: randomUUID(), enabled: true, trigger: 'created', recipients: [user(readerIdentity)],
    conditions: [], title: 'Snap {{' + copy.fieldId + '}} key {{' + local.fieldId + '}}', body: 'Snap {{' + copy.fieldId + '}}' }];
  await dWrite(200, 'PUT', '/notification-rules', { rules });
  await publish(token, dest.id);
  await dWrite(201, 'POST', '/records', { data: { [local.fieldId]: 'K1' } });
  await deliverNotifications(owner, false);
  const inbox = await expectRequest(200, '/notifications?appId=' + dest.id, { token: reader });
  assert.equal(inbox.items.length, 1);
  assert.ok(inbox.items[0].title.includes('K1'));
  assert.ok(!JSON.stringify(inbox).includes('4242'), JSON.stringify(inbox.items[0]));

  // Blind editor: full destination rights, zero source rights. Every re-fetch
  // surface is 404 and the snapshot stays byte-identical.
  const before = await dWrite(200, 'GET', '/records/' + d1.id);
  await dWrite(404, 'GET', '/records/' + d1.id + '/lookups/' + lookup.fieldId + '/refresh', undefined, editor);
  await dWrite(404, 'POST', '/records/' + d1.id + '/lookups/' + lookup.fieldId + '/refresh',
    { revision: before.revision, confirmation: 'a'.repeat(64) }, editor);
  const blindSearch = await request(dBase + '/records/reference-search?' +
    new URLSearchParams({ fieldId: lookup.fieldId, query: 'K' }), { token: editor });
  assert.equal(blindSearch.status, 404, JSON.stringify(blindSearch.body));
  const blindPreview = await request(dBase + '/records/lookup-preview', {
    method: 'POST', token: editor, body: { fieldId: lookup.fieldId, key: 'K1', recordId: d1.id },
  });
  assert.equal(blindPreview.status, 404, JSON.stringify(blindPreview.body));
  const after = await dWrite(200, 'GET', '/records/' + d1.id);
  assert.equal(after.data[copy.fieldId], '4242');
  assert.equal(after.revision, before.revision);
  // The editor does see the snapshot through the destination itself.
  const editorDetail = await dWrite(200, 'GET', '/records/' + d1.id, undefined, editor);
  assert.equal(editorDetail.data[copy.fieldId], '4242');
  t.diagnostic('Six paths agree for the restricted reader (list 2, count 2, snapshot masked, related 1/0, export clean, search masked); preview predicted both; blind editor re-fetch surfaces all 404 with snapshot untouched.');
});
