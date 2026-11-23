const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';

// P4 fix batch, C2: the categoryIds response contract. Four shapes —
// (1) categories enabled + record assigned: ids present;
// (2) categories enabled + record unassigned: present, explicit [];
// (3) categories disabled + historical assignments: ids still present;
// (4) app that never used categories: property omitted entirely.
// Absence is a compatibility shape, never proof of "no assignments".

const KANTO = randomUUID(); const TOKYO = randomUUID(); const KANAGAWA = randomUUID();
const KANSAI = randomUUID(); const OSAKA = randomUUID();
const TREE = {
  enabled: true,
  nodes: [
    { id: KANTO, parentId: null, name: '関東', sortOrder: 0 },
    { id: TOKYO, parentId: KANTO, name: '東京', sortOrder: 0 },
    { id: KANAGAWA, parentId: KANTO, name: '神奈川', sortOrder: 1 },
    { id: KANSAI, parentId: null, name: '関西', sortOrder: 1 },
    { id: OSAKA, parentId: KANSAI, name: '大阪', sortOrder: 0 },
  ],
};

test('P4-fix C2: categoryIds four-case response contract', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p4-fix-cat-contract');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: TREE });
  await publish(token, app.id);

  // (1) enabled + assigned.
  const assigned = await expectRequest(201, base + '/records', {
    token, method: 'POST', body: { data: { [title.fieldId]: 'A' }, categoryIds: [TOKYO] },
  });
  assert.deepEqual(assigned.categoryIds, [TOKYO]);
  const fetchedAssigned = await expectRequest(200, base + '/records/' + assigned.id, { token });
  assert.deepEqual(fetchedAssigned.categoryIds, [TOKYO]);

  // (2) enabled + unassigned: explicit empty array, key present.
  const unassigned = await expectRequest(201, base + '/records', {
    token, method: 'POST', body: { data: { [title.fieldId]: 'B' } },
  });
  const fetchedUnassigned = await expectRequest(200, base + '/records/' + unassigned.id, { token });
  assert.ok('categoryIds' in fetchedUnassigned, 'enabled app must provide the property');
  assert.deepEqual(fetchedUnassigned.categoryIds, []);

  // List shape follows the same rule for both records.
  const page = await expectRequest(200, base + '/records', { token });
  const byId = new Map(page.items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(assigned.id).categoryIds, [TOKYO]);
  assert.deepEqual(byId.get(unassigned.id).categoryIds, []);

  // (3) disabled + historical assignments: ids still returned.
  await expectRequest(200, base + '/draft/categories', {
    token, method: 'PUT', body: { enabled: false, nodes: TREE.nodes },
  });
  await publish(token, app.id);
  const appAfter = await expectRequest(200, base, { token });
  assert.equal(appAfter.categories.enabled, false);
  const fetchedAfterDisable = await expectRequest(200, base + '/records/' + assigned.id, { token });
  assert.deepEqual(fetchedAfterDisable.categoryIds, [TOKYO],
    'historical assignments stay visible after the feature is disabled');

  // (4) an app that never used categories omits the property.
  const plain = await createApp(token, 'p4-fix-cat-plain');
  const plainBase = '/apps/' + plain.id;
  const plainTitle = await addField(token, plain.id, 'title', 'text');
  await publish(token, plain.id);
  const plainRecord = await expectRequest(201, plainBase + '/records', {
    token, method: 'POST', body: { data: { [plainTitle.fieldId]: 'P' } },
  });
  const fetchedPlain = await expectRequest(200, plainBase + '/records/' + plainRecord.id, { token });
  assert.ok(!('categoryIds' in fetchedPlain),
    'never-categorized apps keep the legacy response shape (property omitted)');
  const plainPage = await expectRequest(200, plainBase + '/records', { token });
  assert.ok(!('categoryIds' in plainPage.items[0]));
});

test('P4-fix C2: OpenAPI documents categoryIds as optional with the semantic lock', async () => {
  const response = await fetch(new URL('/docs-json', origin));
  assert.equal(response.status, 200);
  const document = await response.json();
  const serialized = JSON.stringify(document);
  assert.ok(serialized.includes('categoryIds'), 'OpenAPI must describe categoryIds');
  assert.ok(serialized.includes('NOT proof that the record has no category'),
    'OpenAPI must carry the absence-is-not-proof semantics');
  assert.ok(serialized.includes('Never use the'),
    'OpenAPI must carry the no-authorization-use semantics');
});
