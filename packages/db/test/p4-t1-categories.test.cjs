const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish, request } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';

// App C fixture shape (p4-appc-baseline.md): two roots, three children,
// five records — multi-assignment, parent-only assignment, unclassified.
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

async function raw(token, path, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
      ...(body && !contentType && { 'Content-Type': 'application/json' }),
    },
    body: body ? (contentType ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary */ }
  return { status: response.status, body: parsed, raw: text };
}

async function listNos(token, appId, query = '') {
  const page = await expectRequest(200, `/apps/${appId}/records${query}`, { token });
  return page.items.map((item) => item.recordNo).sort();
}

test('P4-T1 categories: tree lifecycle, assignment, descendant filter, rename, delete guard, disable', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p4-categories');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);

  // Tree: 5 nodes over 2 levels, set on the draft then published.
  const saved = await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: TREE });
  assert.equal(saved.nodes.length, 5);
  await publish(token, app.id);
  const published = await expectRequest(200, base, { token });
  assert.equal(published.categories.enabled, true);
  assert.equal(published.categories.nodes.length, 5);

  const create = (name, categoryIds) => expectRequest(201, base + '/records', {
    token, method: 'POST',
    body: { data: { [title.fieldId]: name }, ...(categoryIds && { categoryIds }) },
  });
  const c1 = await create('C-001', [TOKYO]);
  const c2 = await create('C-002', [OSAKA]);
  const c3 = await create('C-003', [TOKYO, KANAGAWA]);
  const c4 = await create('C-004', [KANTO]);
  const c5 = await create('C-005');
  assert.deepEqual([...c3.categoryIds].sort(), [KANAGAWA, TOKYO].sort());
  assert.deepEqual(c5.categoryIds, []);

  const fetched = await expectRequest(200, base + '/records/' + c3.id, { token });
  assert.deepEqual([...fetched.categoryIds].sort(), [KANAGAWA, TOKYO].sort());

  // Descendant-inclusive, deduplicated filtering (App C baseline numbers).
  assert.deepEqual(await listNos(token, app.id, `?category=${KANTO}`), [c1.recordNo, c3.recordNo, c4.recordNo].sort());
  assert.deepEqual(await listNos(token, app.id, `?category=${TOKYO}`), [c1.recordNo, c3.recordNo].sort());
  assert.deepEqual(await listNos(token, app.id, `?category=${KANSAI}`), [c2.recordNo]);
  assert.equal((await listNos(token, app.id)).length, 5);
  const badFilter = await request(base + '/records?category=' + randomUUID(), { token });
  assert.equal(badFilter.status, 400);

  // Invalid assignment is refused.
  const badAssign = await request(base + '/records', {
    token, method: 'POST', body: { data: { [title.fieldId]: 'X' }, categoryIds: [randomUUID()] },
  });
  assert.equal(badAssign.status, 400);

  // Rename keeps assignments (identity is the node id, not the name).
  const renamed = structuredClone(TREE);
  renamed.nodes = renamed.nodes.map((node) => node.id === TOKYO ? { ...node, name: '東京都' } : node);
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: renamed });
  await publish(token, app.id);
  const afterRename = await expectRequest(200, base + '/records/' + c1.id, { token });
  assert.deepEqual(afterRename.categoryIds, [TOKYO]);
  assert.deepEqual(await listNos(token, app.id, `?category=${TOKYO}`), [c1.recordNo, c3.recordNo].sort());

  // Sibling reorder is stored.
  const reordered = structuredClone(renamed);
  reordered.nodes = reordered.nodes.map((node) => node.id === TOKYO ? { ...node, sortOrder: 5 }
    : node.id === KANAGAWA ? { ...node, sortOrder: 0 } : node);
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: reordered });
  const draft = await expectRequest(200, base + '/draft', { token });
  const kantoChildren = draft.categories.nodes.filter((node) => node.parentId === KANTO)
    .sort((a, b) => a.sortOrder - b.sortOrder).map(({ name }) => name);
  assert.deepEqual(kantoChildren, ['神奈川', '東京都']);
  await publish(token, app.id);

  // Duplicate names under one parent are allowed (kintone parity).
  const duplicated = structuredClone(reordered);
  duplicated.nodes.push({ id: randomUUID(), parentId: KANTO, name: '東京都', sortOrder: 9 });
  const dupSaved = await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: duplicated });
  assert.equal(dupSaved.nodes.filter((node) => node.name === '東京都').length, 2);
  await publish(token, app.id);

  // Removing a category that still has records is refused at draft save.
  const withoutTokyo = structuredClone(duplicated);
  withoutTokyo.nodes = withoutTokyo.nodes.filter((node) => node.id !== TOKYO);
  const refused = await request(base + '/draft/categories', { token, method: 'PUT', body: withoutTokyo });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));

  // Publish-time guard: a node removed from the draft while unoccupied,
  // then assigned, blocks the publish.
  const temp = randomUUID();
  const withTemp = structuredClone(duplicated);
  withTemp.nodes.push({ id: temp, parentId: null, name: '臨時', sortOrder: 7 });
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: withTemp });
  await publish(token, app.id);
  const withoutTemp = structuredClone(withTemp);
  withoutTemp.nodes = withoutTemp.nodes.filter((node) => node.id !== temp);
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: withoutTemp });
  await create('C-006', [temp]);
  const blocked = await request(base + '/publish', { token, method: 'POST', body: {} });
  assert.equal(blocked.body.message, 'Dependency check failed', JSON.stringify(blocked.body));
  assert.ok(blocked.body.problems.some((problem) => problem.dependency === 'category'),
    JSON.stringify(blocked.body.problems));

  // Disabling hides the tree but keeps stored assignments.
  const disabled = structuredClone(withTemp);
  disabled.enabled = false;
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: disabled });
  await publish(token, app.id);
  const appAfter = await expectRequest(200, base, { token });
  assert.equal(appAfter.categories.enabled, false);
  const stillThere = await expectRequest(200, base + '/records/' + c1.id, { token });
  assert.deepEqual(stillThere.categoryIds, [TOKYO]);
  const assignWhileDisabled = await request(base + '/records', {
    token, method: 'POST', body: { data: { [title.fieldId]: 'Y' }, categoryIds: [TOKYO] },
  });
  assert.equal(assignWhileDisabled.status, 400);
});

test('P4-T1 export/import round trip carries the tree and assignments with remapped ids', async () => {
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p4-cat-export');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  await publish(token, app.id);
  await expectRequest(200, base + '/draft/categories', { token, method: 'PUT', body: TREE });
  await publish(token, app.id);
  const create = (name, categoryIds) => expectRequest(201, base + '/records', {
    token, method: 'POST', body: { data: { [title.fieldId]: name }, categoryIds },
  });
  await create('C-001', [TOKYO]);
  await create('C-003', [TOKYO, KANAGAWA]);
  await create('C-004', [KANTO]);

  const job = await expectRequest(201, base + '/exports', { token, method: 'POST' });
  const runExport = await expectRequest(201, base + '/exports/' + job.id + '/run', { token, method: 'POST' });
  assert.equal(runExport.status, 'sealed');
  const packageResponse = await fetch(new URL(base + '/exports/' + job.id + '/package', origin), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(packageResponse.status, 200);
  const archive = Buffer.from(await packageResponse.arrayBuffer());

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const uploaded = await raw(targetToken, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream',
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const importJob = uploaded.body;
  const validated = await expectRequest(201, `/imports/${importJob.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging', JSON.stringify(validated));
  const issued = await expectRequest(201, `/imports/${importJob.id}/migration-token`, { token: targetToken, method: 'POST' });
  await expectRequest(201, `/imports/${importJob.id}/run`, { token: issued.token, method: 'POST' });
  const activated = await expectRequest(201, `/imports/${importJob.id}/activate`, { token: targetToken, method: 'POST' });
  assert.equal(activated.status, 'activated');
  const detail = await expectRequest(200, `/imports/${importJob.id}`, { token: targetToken });
  const targetAppId = detail.targetAppId;
  assert.ok(targetAppId);

  const imported = await expectRequest(200, '/apps/' + targetAppId, { token: targetToken });
  assert.equal(imported.categories.enabled, true);
  assert.equal(imported.categories.nodes.length, 5);
  const names = imported.categories.nodes.map(({ name }) => name).sort();
  assert.deepEqual(names, ['大阪', '東京', '神奈川', '関東', '関西'].sort());
  const importedKanto = imported.categories.nodes.find(({ name }) => name === '関東');
  const importedTokyo = imported.categories.nodes.find(({ name }) => name === '東京');
  assert.notEqual(importedTokyo.id, TOKYO);
  assert.equal(importedTokyo.parentId, importedKanto.id);

  const page = await expectRequest(200, `/apps/${targetAppId}/records`, { token: targetToken });
  assert.equal(page.items.length, 3);
  const multi = page.items.find((item) => item.data[imported.fields.find(({ code }) => code === 'title').fieldId] === 'C-003');
  assert.equal(multi.categoryIds.length, 2);
  const filtered = await expectRequest(200, `/apps/${targetAppId}/records?category=${importedKanto.id}`, { token: targetToken });
  assert.equal(filtered.items.length, 3);
});

test('P4-T1 kintone category name resolution fails closed on ambiguity', async () => {
  const { resolveKintoneCategories, mapKintoneField } = await import('../../../apps/api/dist/kintone-import.js');
  const nodes = [
    { id: 'kanto', parentId: null, name: '関東' },
    { id: 'tokyo', parentId: 'kanto', name: '東京' },
    { id: 'osaka', parentId: null, name: '大阪' },
  ];
  const ok = resolveKintoneCategories(nodes, [
    { recordId: '1', names: ['東京'] },
    { recordId: '2', names: [] },
  ]);
  assert.deepEqual(ok.resolved, { 1: ['tokyo'], 2: [] });
  assert.deepEqual(ok.unresolved, []);

  const ambiguousNodes = [...nodes, { id: 'tokyo-2', parentId: null, name: '東京' }];
  const ambiguous = resolveKintoneCategories(ambiguousNodes, [
    { recordId: '3', names: ['東京'] },
    { recordId: '4', names: ['名古屋'] },
  ]);
  assert.deepEqual(ambiguous.resolved, { 3: [], 4: [] });
  assert.deepEqual(ambiguous.unresolved, [
    { recordId: '3', name: '東京', code: 'UNRESOLVED_CATEGORY_IDENTITY' },
    { recordId: '4', name: '名古屋', code: 'UNRESOLVED_CATEGORY_IDENTITY' },
  ]);
  const mapping = mapKintoneField({ code: 'category', type: 'CATEGORY' });
  assert.equal(mapping.status, 'UNRESOLVED');
  assert.equal(mapping.upgradeRequired, false);
});
