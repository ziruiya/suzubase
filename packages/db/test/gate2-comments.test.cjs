const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp, expectRequest, login, provision, publish } = require('./support.cjs');

test('G2-08 comments are ACL-scoped, preserve structured mentions and retain a deletion event', async (t) => {
  const owner = await provision();
  const author = await provision({ tenantId: owner.tenantId });
  const peer = await provision({ tenantId: owner.tenantId });
  const outsider = await provision({ tenantId: owner.tenantId });
  const token = await login(owner);
  const authorToken = await login(author);
  const peerToken = await login(peer);
  const outsiderToken = await login(outsider);
  const app = await createApp(token, 'comments');
  const root = '/apps/' + app.id;
  const write = (path, body, method = 'POST', status = 201, bearer = token) =>
    expectRequest(status, root + path, { token: bearer, body, method });
  await write('/draft/acl', { app: [author, peer].map(({ userId }) => ({ action: 'view', subject: { kind: 'user', id: userId } })),
    record: [], field: [] }, 'PUT', 200);
  await publish(token, app.id);
  const record = await write('/records', { data: {} });
  const entry = '/records/' + record.id;
  const path = entry + '/comments';
  await write(path, undefined, 'GET', 404, outsiderToken);
  const content = { parts: [
    { kind: 'text', text: 'Please look <%> ' }, { kind: 'mention', userId: peer.userId },
    { kind: 'text', text: ' text @[' + outsider.userId + ']' },
  ] };
  const created = await write(path, content, 'POST', 201, authorToken);
  const visible = (await write(path, undefined, 'GET', 200, peerToken)).items[0];
  assert.equal(visible.canDelete, false);
  assert.deepEqual(visible.parts, [content.parts[0], { ...content.parts[1], name: peer.email }, content.parts[2]]);
  await write(path + '/' + created.id, undefined, 'DELETE', 404, peerToken);

  await write('/settings', { commentsEnabled: false }, 'PATCH', 200);
  await write(path, undefined, 'GET', 403, authorToken);
  await write(path, content, 'POST', 403, authorToken);
  await write('/settings', { commentsEnabled: true }, 'PATCH', 200);
  assert.equal((await write(path, undefined, 'GET', 200, authorToken)).items.length, 1);
  const removed = await write(path + '/' + created.id, undefined, 'DELETE', 200, authorToken);
  const deleted = (await write(path, undefined, 'GET', 200)).items[0];
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.parts, []);
  const history = await write(entry + '/history', undefined, 'GET', 200);
  const evidence = history.events.filter(({ objectId }) => objectId === created.id);
  assert.deepEqual(evidence.map(({ kind, objectType, recordRevision }) => [kind, objectType, recordRevision]),
    [['comment-created', 'comment', created.revision], ['comment-deleted', 'comment', removed.revision]]);
  assert.ok(!JSON.stringify(history).includes('Please look'));
  t.diagnostic(JSON.stringify({ created, removed, deleted, structuredMention: visible.parts[1] }));
});
