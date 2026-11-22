const { randomUUID } = require('node:crypto');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

async function gate2BrowserFixture() {
  configureRuntime();
  const { deliverNotifications } = require('../../../apps/api/dist/notification-worker.js');
  const owner = await provision();
  const token = await login(owner);

  const source = await expectRequest(201, '/apps', {
    method: 'POST', token, body: { code: 'gate2-browser-source', name: 'Gate2 source' },
  });
  const sBase = '/apps/' + source.id;
  const sWrite = (status, method, path, body) => expectRequest(status, sBase + path, { method, token, body });
  const sKey = await sWrite(201, 'POST', '/fields', { code: 'key', name: 'Key', type: 'text', uniqueValue: true });
  const sVal = await addField(token, source.id, 'val', 'text');
  await publish(token, source.id);
  await sWrite(201, 'POST', '/records', { data: { [sKey.fieldId]: 'K1', [sVal.fieldId]: 'Alpha' } });

  const app = await expectRequest(201, '/apps', {
    method: 'POST', token, body: { code: 'gate2-browser', name: 'Gate2 checks' },
  });
  const base = '/apps/' + app.id;
  const write = (status, method, path, body) => expectRequest(status, base + path, { method, token, body });
  const title = await addField(token, app.id, 'title', 'text');
  const local = await addField(token, app.id, 'local_key', 'text');
  const copy = await addField(token, app.id, 'copy', 'text');
  const sku = randomUUID();
  const qty = randomUUID();
  const table = await write(201, 'POST', '/fields', {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: sku, name: 'SKU', code: 'sku', type: 'text', required: true },
      { fieldId: qty, name: 'Qty', code: 'qty', type: 'number', required: true },
    ], minRows: 0, maxRows: 10, addRows: true, deleteRows: true, reorderRows: true },
  });
  const lookup = await write(201, 'POST', '/fields', { code: 'lookup', name: 'Lookup', type: 'lookup', lookup: {
    appId: source.id, keyFieldId: sKey.fieldId, localKeyFieldId: local.fieldId,
    copies: [{ sourceFieldId: sVal.fieldId, targetFieldId: copy.fieldId }],
    displayFieldIds: [sVal.fieldId],
  } });
  const open = { id: randomUUID(), code: 'open', name: 'Open', initial: true, terminal: false, assignees: [{ kind: 'creator' }] };
  const review = { id: randomUUID(), code: 'review', name: 'Review', initial: false, terminal: false, assignees: [] };
  const approve = { id: randomUUID(), name: 'Approve step', fromStateId: open.id, toStateId: review.id,
    assignees: [{ kind: 'creator' }], conditions: [] };
  await write(200, 'PUT', '/workflow/draft', { states: [open, review], actions: [approve] });
  await write(201, 'POST', '/workflow/publish');
  await write(200, 'PATCH', '/workflow/enabled', { enabled: true });
  await publish(token, app.id);
  const rules = [{ id: randomUUID(), enabled: true, trigger: 'created',
    recipients: [{ kind: 'user', id: owner.userId }], conditions: [],
    title: 'Created {{' + title.fieldId + '}}', body: 'A record was created' }];
  await write(200, 'PUT', '/notification-rules', { rules });
  await publish(token, app.id);
  const record = await write(201, 'POST', '/records', {
    data: { [title.fieldId]: 'Mobile record', [local.fieldId]: 'K1',
      [table.fieldId]: JSON.stringify([{ rowId: randomUUID(), data: { [sku]: 'A', [qty]: '1' } }]) },
  });
  const delivered = await deliverNotifications(owner, false);
  return { owner, token, app, record, delivered: delivered.inserted,
    fields: { title, local, copy, table, lookup, sku, qty }, action: approve };
}

if (require.main === module) {
  gate2BrowserFixture().then((fixture) => process.stdout.write(JSON.stringify(fixture)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
module.exports = { gate2BrowserFixture };
