const assert = require('node:assert/strict');
const { Client } = require('pg');
const { test } = require('node:test');
const { expectRequest, login, provision } = require('./support.cjs');

test('G1-01 directory enforces roles, password policy, tree integrity and session revocation', async () => {
  const administrator = await provision();
  const db = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await db.connect();
  try {
    await db.query('UPDATE tenant_members SET is_admin = true WHERE tenant_id = $1 AND user_id = $2',
      [administrator.tenantId, administrator.userId]);
  } finally {
    await db.end();
  }
  const token = await login(administrator);
  const userInput = { email: 'member@example.test', loginName: 'member', displayName: 'Member', password: 'Long!Password2026' };
  const request = (status, method, path, body) => expectRequest(status, '/tenant' + path, { method, token, body });
  await request(400, 'POST', '/users', { ...userInput, password: 'weak' });
  const user = await request(201, 'POST', '/users', userInput);
  const duplicate = await request(409, 'POST', '/users', userInput);
  assert.deepEqual(duplicate.duplicates, ['email', 'loginName']);

  const oldToken = await login(userInput);
  await expectRequest(403, '/tenant/directory', { token: oldToken });
  const parent = await request(201, 'POST', '/organizations', { name: 'HQ', parentId: null });
  const child = await request(201, 'POST', '/organizations', { name: 'Branch', parentId: parent.id });
  await request(409, 'PUT', '/organizations/' + parent.id, { name: parent.name, parentId: child.id });
  const reference = await request(409, 'DELETE', '/organizations/' + parent.id);
  assert.deepEqual(reference.children, [{ id: child.id, name: child.name }]);
  await request(200, 'PATCH', '/users/' + user.id, { organizationId: child.id, displayName: 'New name' });

  for (const name of ['One', 'Two']) {
    const group = await request(201, 'POST', '/groups', { name });
    await request(200, 'PUT', '/groups/' + group.id + '/members/' + user.id, { included: true });
  }
  const password = 'Replacement!Password2026';
  await request(200, 'PUT', '/users/' + user.id + '/password', { password });
  await expectRequest(401, '/tenant/directory', { token: oldToken });
  const freshToken = await login({ email: user.email, password });
  await request(201, 'POST', '/users/' + user.id + '/disable');
  await expectRequest(401, '/tenant/directory', { token: freshToken });
  const directory = await request(200, 'GET', '/directory');
  assert.equal(directory.members.find(({ id }) => id === user.id).label, 'New name（已停用）');
  assert.equal(directory.groupMembers.filter(({ userId }) => userId === user.id).length, 2);
});
