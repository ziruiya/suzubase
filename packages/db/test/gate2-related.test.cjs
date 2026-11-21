const assert = require('node:assert/strict');
const { test } = require('node:test');
const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-03 related records query live matches, count only visible records and project configured fields', async (t) => {
  const owner = await provision();
  const reader = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const readerToken = await login(reader);
  const source = '/apps/' + (await createApp(token, 'related-source')).id;
  const destination = '/apps/' + (await createApp(token, 'related-destination')).id;
  const write = (path, body, method = 'POST', status = 201) => expectRequest(status, path, { token, body, method });
  const add = (path, code, type) => addField(token, path.split('/')[2], code, type);
  const match = await add(source, 'match', 'text');
  const rank = await add(source, 'rank', 'number');
  const secret = await add(source, 'secret', 'text');
  const local = await add(destination, 'local_key', 'text');
  const readerSubject = { kind: 'user', id: reader.userId };
  const ownerSubject = { kind: 'user', id: owner.userId };
  await write(source + '/draft/acl', {
    app: [{ action: 'view', subject: readerSubject }],
    record: [
      { action: 'view', subject: ownerSubject, conditions: [] },
      { action: 'view', subject: readerSubject, conditions: [{ fieldId: secret.fieldId, operator: 'eq', value: 'public' }] },
    ],
    field: [{ action: 'view', subject: ownerSubject, fieldId: secret.fieldId }],
  }, 'PUT', 200);
  await publish(token, source.split('/')[2]);
  const related = await write(destination + '/fields', {
    code: 'related', name: 'Related', type: 'related',
    related: { appId: source.split('/')[2], localFieldId: local.fieldId, matchFieldId: match.fieldId,
      displayFieldIds: [rank.fieldId, secret.fieldId], sort: { fieldId: rank.fieldId, direction: 'desc' },
      conditions: [{ fieldId: rank.fieldId, operator: 'ne', value: '50' }], pageSize: 1 },
  });
  await write(destination + '/draft/acl', {
    app: [{ action: 'view', subject: readerSubject }, { action: 'export', subject: readerSubject }], record: [], field: [],
  }, 'PUT', 200);
  await publish(token, destination.split('/')[2]);
  const create = (path, data) => write(path + '/records', { data });
  const item = await create(destination, { [local.fieldId]: 'same' });
  assert.ok(!Object.hasOwn(item.data, related.fieldId));
  await write(destination + '/records', { data: { [local.fieldId]: 'same', [related.fieldId]: 'forged' } }, 'POST', 400);
  const sourceData = (key, n, visibility) => ({
    [match.fieldId]: key, [rank.fieldId]: String(n), [secret.fieldId]: visibility,
  });
  await create(source, sourceData('same', 20, 'public'));
  const privateRow = await create(source, sourceData('same', 100, 'private'));
  await create(source, sourceData('same', 50, 'public'));
  await create(source, sourceData('different', 200, 'public'));
  const path = destination + '/records/' + item.id + '/related/' + related.fieldId;
  const get = (bearer, suffix = '') => expectRequest(200, path + suffix, { token: bearer });
  const ownerPage = await get(token);
  assert.equal(ownerPage.count, '2');
  assert.equal(ownerPage.items[0][rank.fieldId], '100');
  assert.equal((await get(token, '?after=' + ownerPage.next)).items[0][rank.fieldId], '20');
  const restrictedPage = await get(readerToken);
  assert.equal(restrictedPage.count, '1');
  assert.equal(restrictedPage.next, null);
  assert.deepEqual(restrictedPage.items, [{ [rank.fieldId]: '20' }]);
  assert.deepEqual(restrictedPage.columns.map(({ fieldId }) => fieldId), [rank.fieldId]);
  await write(source + '/records/' + privateRow.id, {
    revision: privateRow.revision, data: sourceData('different', 100, 'private'),
  }, 'PUT', 200);
  assert.equal((await get(token)).count, '1');
  const exported = await fetch(new URL(destination + '/csv/export', process.env.TEST_API_URL), {
    headers: { Authorization: 'Bearer ' + readerToken },
  });
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.match(csv, /1 related records\. Counts only records you can view\./);
  assert.doesNotMatch(csv, /private|secret/);
  t.diagnostic('Owner saw records 100 and 20 across two pages. Reader saw record 20 and no secret column. Editing the source match reduced the owner count to one.');
});
