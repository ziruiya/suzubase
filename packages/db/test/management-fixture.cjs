const { createApp, expectRequest, login, provision, publish } = require('./support.cjs');

async function managementFixture() {
  const owner = await provision({ isAdmin: true, canManageRecycleBin: true });
  const token = await login(owner);
  const app = await createApp(token, 'managed');
  const appUrl = '/apps/' + app.id;
  const call = (status, path, method, body) => expectRequest(status, appUrl + path, { method, body, token });
  const title = await call(201, '/fields', 'POST', { name: 'Title', code: 'b-title', type: 'text' });
  const amount = await call(201, '/fields', 'POST', { name: 'Amount', code: 'amount', type: 'number' });
  const notes = await call(201, '/fields', 'POST', { name: 'Notes', code: 'notes', type: 'richText' });
  const region = await call(201, '/fields', 'POST', { name: 'Region', code: 'region', type: 'organization' });
  const team = await call(201, '/fields', 'POST', { name: 'Team', code: 'team', type: 'group' });
  await publish(token, app.id);
  await call(201, '/records', 'POST', { data: { [title.fieldId]: 'Active', [amount.fieldId]: '20' } });
  const record = await call(201, '/records', 'POST', { data: { [title.fieldId]: 'Deleted', [amount.fieldId]: '100' } });
  await call(200, '/records/' + record.id, 'DELETE', { revision: record.revision });
  return { owner, token, app, fields: { title, amount, notes, region, team } };
}

if (require.main === module) {
  managementFixture().then((fixture) => process.stdout.write(JSON.stringify(fixture)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = { managementFixture };
