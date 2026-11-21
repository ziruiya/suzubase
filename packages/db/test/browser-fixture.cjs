const { addField, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

async function browserFixture() {
  const owner = await provision();
  const viewer = await provision({ tenantId: owner.tenantId, canCreateApps: false });
  const token = await login(owner);
  const app = await createApp(token);
  const home = '/apps/' + app.id;
  const note = await addField(token, app.id, 'note', 'multiline');
  const date = await addField(token, app.id, 'date', 'date');
  const time = await addField(token, app.id, 'time', 'time');
  const datetime = await addField(token, app.id, 'datetime', 'datetime');
  const attachment = await addField(token, app.id, 'attachment', 'attachment');
  const secret = await addField(token, app.id, 'secret', 'text');
  await publish(token, app.id);
  const sample = await expectRequest(201, home + '/records', {
    method: 'POST', token, body: { data: {
      [note.fieldId]: 'LongValue'.repeat(45) + '\nSecond line',
      [date.fieldId]: '2026-11-21', [time.fieldId]: '10:30:00', [datetime.fieldId]: '2026-11-21T01:30:00Z',
      [secret.fieldId]: 'Private value',
    } },
  });
  await expectRequest(200, home + '/draft/acl', {
    method: 'PUT', token, body: {
      app: [{ action: 'view', subject: { kind: 'user', id: viewer.userId } }],
      record: [],
      field: [{ action: 'view', fieldId: secret.fieldId, subject: { kind: 'user', id: owner.userId } }],
    },
  });
  const aclPublished = await publish(token, app.id);
  return { owner, viewer, token, app, sample, aclPublished, fields: { note, date, time, datetime, attachment, secret } };
}

if (require.main === module) {
  browserFixture().then((fixture) => process.stdout.write(JSON.stringify(fixture)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { browserFixture };
