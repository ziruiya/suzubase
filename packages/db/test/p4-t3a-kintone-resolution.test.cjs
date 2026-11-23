const assert = require('node:assert/strict');
const { test } = require('node:test');

// P4-T3a: extraction-time resolution (choice identifiers, directory
// identities, categories, lookup structure) and the package builder
// extensions that carry them. mapKintoneField stays conservative without
// context; resolution happens only with the full record set available.

async function loadModules() {
  const kintone = await import('../../../apps/api/dist/kintone-import.js');
  const exporter = await import('../../../apps/api/dist/export-package.js');
  return { kintone, exporter };
}

function unzip(archive) {
  const { unzipSync } = require('../../../apps/api/node_modules/fflate');
  const files = unzipSync(new Uint8Array(archive));
  const read = (name) => JSON.parse(Buffer.from(files[name]).toString());
  return { files, read };
}

const baseEvidence = (appId) => ({
  source: 'kintone', appId, appName: 'T3a Test', extractedAt: '2026-11-23T00:00:00.000Z',
  settingVersion: '1', recordIdRange: { min: '1', max: '1' }, frozenWindow: true, unavailable: [],
});

test('P4-T3a stable source ids are RFC 4122 version-4 shaped', async () => {
  const { kintone } = await loadModules();
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const key of ['kintone:2:user:Administrator', 'kintone:2:field:customer_code',
    'kintone-app:2', 'kintone:4:category:2107', 'kintone:2:file:abc']) {
    assert.match(kintone.stableSourceUuid(key), shape, key);
    assert.equal(kintone.stableSourceUuid(key), kintone.stableSourceUuid(key));
  }
  assert.notEqual(kintone.stableSourceUuid('a'), kintone.stableSourceUuid('b'));
});

test('P4-T3a choice values resolve to deterministic option ids with labels kept', async () => {
  const { kintone } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility, buildM1CompatiblePackage } = kintone;
  const { verifyPackage } = (await loadModules()).exporter;
  const kindField = {
    code: 'kind', type: 'DROP_DOWN', label: 'Kind', required: false,
    options: {
      '保守': { label: '保守', index: '1' },
      '新規': { label: '新規', index: '0' },
      '修理': { label: '修理', index: '2' },
    },
  };
  const contextFree = mapKintoneField(kindField);
  assert.equal(contextFree.status, 'UNRESOLVED',
    'context-free mapping must stay conservative');
  const compatibility = [contextFree];
  const gateProblems = [];
  resolveExtractionCompatibility(compatibility, {
    records: [{ $id: { value: '1' }, kind: { value: '保守' } }],
    gateProblems,
  });
  assert.equal(compatibility[0].status, 'EQUIVALENT');
  assert.deepEqual(compatibility[0].optionValueMap, { '新規': 'opt_0', '保守': 'opt_1', '修理': 'opt_2' });
  assert.deepEqual(compatibility[0].resolvedOptions, [
    { value: 'opt_0', label: '新規', disabled: false },
    { value: 'opt_1', label: '保守', disabled: false },
    { value: 'opt_2', label: '修理', disabled: false },
  ]);
  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('77'), compatibility,
    records: [{ $id: { value: '1' }, kind: { value: '保守' } }],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  });
  assert.deepEqual(verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const schema = read('data/schema.json');
  const kind = schema.fields.find((field) => field.code === 'kind');
  assert.deepEqual(kind.options, [
    { value: 'opt_0', label: '新規', disabled: false },
    { value: 'opt_1', label: '保守', disabled: false },
    { value: 'opt_2', label: '修理', disabled: false },
  ]);
  const records = read('data/records.json').records;
  assert.equal(records[0].data[kind.fieldId], 'opt_1');
});

test('P4-T3a identity fields resolve via directory and carry source creators/timestamps', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility, buildM1CompatiblePackage, stableSourceUuid } = kintone;
  const fields = [
    { code: 'title', type: 'SINGLE_LINE_TEXT', label: 'Title' },
    { code: 'owner', type: 'USER_SELECT', label: 'Owner' },
    { code: '作成者', type: 'CREATOR', label: 'Creator' },
    { code: '更新者', type: 'MODIFIER', label: 'Modifier' },
    { code: '作成日時', type: 'CREATED_TIME', label: 'Created' },
    { code: '更新日時', type: 'UPDATED_TIME', label: 'Updated' },
    { code: 'カテゴリ', type: 'CATEGORY', label: 'Category', enabled: false },
  ];
  assert.equal(mapKintoneField(fields[1]).status, 'UNRESOLVED');
  assert.equal(mapKintoneField(fields[6]).status, 'UNRESOLVED');
  const compatibility = fields.map((field) => mapKintoneField(field, { fields }));
  const record = {
    $id: { value: '5' }, title: { value: 'Hello' },
    owner: { value: [{ code: 'alice', name: 'Alice' }] },
    '作成者': { value: { code: 'bob', name: 'Bob' } },
    '更新者': { value: { code: 'alice', name: 'Alice' } },
    '作成日時': { value: '2026-11-20T01:02:03Z' },
    '更新日時': { value: '2026-11-21T04:05:06Z' },
  };
  resolveExtractionCompatibility(compatibility, { records: [record], gateProblems: [] });
  for (const item of compatibility) assert.equal(item.status, 'EQUIVALENT', item.sourceFieldCode);
  const category = compatibility.find((item) => item.sourceType === 'CATEGORY');
  assert.deepEqual(category.categoryResolution, { mode: 'disabled' });
  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('78'), compatibility, records: [record],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const schema = read('data/schema.json');
  assert.equal(schema.fields.some((field) => field.code === 'カテゴリ'), false,
    'a disabled category field must not become a target field');
  assert.deepEqual(schema.versions[0].categories, { enabled: false, nodes: [] });
  const directory = read('data/directory.json');
  assert.deepEqual(directory.users.map((user) => user.loginName).sort(), ['alice', 'bob']);
  const packaged = read('data/records.json').records[0];
  assert.equal(packaged.createdBy, stableSourceUuid('kintone:78:user:bob'));
  assert.equal(packaged.updatedBy, stableSourceUuid('kintone:78:user:alice'));
  assert.equal(packaged.createdAt, '2026-11-20T01:02:03Z');
  assert.equal(packaged.updatedAt, '2026-11-21T04:05:06Z');
  const ownerField = schema.fields.find((field) => field.code === 'owner');
  assert.equal(packaged.data[ownerField.fieldId], stableSourceUuid('kintone:78:user:alice'));
  // A multi-entry identity value cannot be represented and must block.
  assert.throws(() => buildM1CompatiblePackage({
    evidence: baseEvidence('78'), compatibility,
    records: [{ ...record, owner: { value: [{ code: 'alice' }, { code: 'bob' }] } }],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  }), /multi-entry identity value/);
});

test('P4-T3a lookup structure verifies item by item and seals references', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility, buildM1CompatiblePackage, stableSourceUuid } = kintone;
  const lookupSource = {
    code: 'customer_code', type: 'SINGLE_LINE_TEXT', label: 'Customer',
    lookup: {
      relatedApp: { app: '9' }, relatedKeyField: 'customer_code',
      fieldMappings: [{ field: 'customer_name', relatedField: 'customer_name' }],
      lookupPickerFields: ['customer_code', 'customer_name'],
      filterCond: '', sort: 'record_number desc',
    },
  };
  const fields = [
    lookupSource,
    { code: 'customer_name', type: 'SINGLE_LINE_TEXT', label: 'Customer name' },
  ];
  const compatibility = fields.map((field) => mapKintoneField(field, { fields }));
  assert.equal(compatibility[0].status, 'UNRESOLVED');
  const relatedFields = [
    { code: 'customer_code' }, { code: 'customer_name' }, { code: 'record_number' },
  ];
  resolveExtractionCompatibility(compatibility, {
    records: [{ $id: { value: '1' }, customer_code: { value: 'TOK-001' }, customer_name: { value: 'Alpha' } }],
    relatedApps: { 9: { fields: relatedFields } },
    gateProblems: [],
  });
  assert.equal(compatibility[0].status, 'EQUIVALENT');
  assert.equal(compatibility[0].targetType, 'lookup');
  assert.deepEqual(compatibility[0].lookupResolution.sort, { field: 'record_number', direction: 'desc' });
  const relatedRecordId = stableSourceUuid('kintone:9:record:2');
  const extraction = {
    evidence: baseEvidence('10'), compatibility,
    records: [{ $id: { value: '1' }, customer_code: { value: 'TOK-001' }, customer_name: { value: 'Alpha' } }],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  };
  assert.throws(() => buildM1CompatiblePackage(extraction), /requires the related application/);
  const sealed = buildM1CompatiblePackage(extraction, {
    relatedApps: { 9: { recordsByKey: { 'TOK-001': relatedRecordId } } },
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const schema = read('data/schema.json');
  const lookupField = schema.fields.find((field) => field.code === 'customer_code');
  const keyField = schema.fields.find((field) => field.code === 'customer_code__key');
  assert.equal(lookupField.type, 'lookup');
  assert.equal(keyField.type, 'text');
  assert.equal(lookupField.lookup.keyFieldId, stableSourceUuid('kintone:9:field:customer_code'));
  assert.equal(lookupField.lookup.localKeyFieldId, keyField.fieldId);
  assert.deepEqual(lookupField.lookup.copies, [{
    sourceFieldId: stableSourceUuid('kintone:9:field:customer_name'),
    targetFieldId: schema.fields.find((field) => field.code === 'customer_name').fieldId,
  }]);
  assert.deepEqual(lookupField.lookup.displayFieldIds, [
    stableSourceUuid('kintone:9:field:customer_code'),
    stableSourceUuid('kintone:9:field:customer_name'),
  ]);
  const packaged = read('data/records.json').records[0];
  assert.equal(packaged.data[keyField.fieldId], 'TOK-001');
  assert.equal(packaged.data[lookupField.fieldId], undefined);
  const references = read('data/references.json').references;
  assert.equal(references.length, 1);
  assert.equal(references[0].targetRecordId, relatedRecordId);
  assert.equal(references[0].targetAppCode, 'kintone-9');
  const relations = read('data/config.json').relations;
  assert.equal(relations.length, 1);
  assert.equal(relations[0].kind, 'lookup');
  // A non-empty filterCond cannot be translated mechanically.
  const filtered = fields.map((field) => mapKintoneField(field, { fields }));
  filtered[0] = mapKintoneField({
    ...lookupSource, lookup: { ...lookupSource.lookup, filterCond: 'status = "open"' },
  }, { fields });
  resolveExtractionCompatibility(filtered, {
    records: [], relatedApps: { 9: { fields: relatedFields } }, gateProblems: [],
  });
  assert.equal(filtered[0].status, 'UNRESOLVED');
});

test('P4-T3a category tree capture seals nodes and assignments by node id', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility, buildM1CompatiblePackage, stableSourceUuid } = kintone;
  const categoryField = { code: 'カテゴリ', type: 'CATEGORY', label: 'Category', enabled: true };
  const compatibility = [mapKintoneField(categoryField), mapKintoneField(
    { code: 'title', type: 'SINGLE_LINE_TEXT', label: 'Title' })];
  const nodes = [
    { id: '100', parentId: null, name: 'Parent', sortOrder: 0 },
    { id: '101', parentId: '100', name: 'Child', sortOrder: 0 },
  ];
  const records = [
    { $id: { value: '1' }, title: { value: 'a' }, 'カテゴリ': { value: ['Child'] } },
    { $id: { value: '2' }, title: { value: 'b' }, 'カテゴリ': { value: [] } },
  ];
  const gateProblems = [];
  resolveExtractionCompatibility(compatibility, { records, categoryTree: { nodes }, gateProblems });
  assert.deepEqual(gateProblems, []);
  assert.equal(compatibility[0].status, 'EQUIVALENT');
  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('11'), compatibility, records,
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const schema = read('data/schema.json');
  assert.equal(schema.versions[0].categories.enabled, true);
  assert.deepEqual(schema.versions[0].categories.nodes, [
    { id: stableSourceUuid('kintone:11:category:100'), parentId: null, name: 'Parent', sortOrder: 0 },
    {
      id: stableSourceUuid('kintone:11:category:101'),
      parentId: stableSourceUuid('kintone:11:category:100'), name: 'Child', sortOrder: 0,
    },
  ]);
  const packaged = read('data/records.json').records;
  assert.deepEqual(packaged[0].categoryIds, [stableSourceUuid('kintone:11:category:101')]);
  assert.deepEqual(packaged[1].categoryIds, []);
  // An ambiguous name (same name under two parents) must block resolution.
  const ambiguous = [mapKintoneField(categoryField)];
  const ambiguousProblems = [];
  resolveExtractionCompatibility(ambiguous, {
    records,
    categoryTree: {
      nodes: [...nodes, { id: '102', parentId: null, name: 'Child', sortOrder: 1 }],
    },
    gateProblems: ambiguousProblems,
  });
  assert.equal(ambiguous[0].status, 'UNRESOLVED');
  assert.equal(ambiguousProblems.length, 1);
  assert.match(ambiguousProblems[0], /UNRESOLVED_CATEGORY_IDENTITY/);
});

test('P4-T3a tolerated unavailable items stay in evidence but do not block packaging', async () => {
  const { kintone } = await loadModules();
  const { buildM1CompatiblePackage, mapKintoneField } = kintone;
  const compatibility = [mapKintoneField({ code: 'title', type: 'SINGLE_LINE_TEXT', label: 'Title' })];
  const extraction = {
    evidence: {
      ...baseEvidence('12'),
      unavailable: [{ item: 'processDefinitions', reason: '404', evidence: null }],
    },
    compatibility,
    records: [{ $id: { value: '1' }, title: { value: 'x' } }],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  };
  assert.throws(() => buildM1CompatiblePackage(extraction), /source unavailable/);
  const sealed = buildM1CompatiblePackage({ ...extraction, toleratedUnavailable: ['processDefinitions'] });
  assert.ok(sealed.archive.length > 0);
  // A different unavailable item is not covered by the tolerance.
  assert.throws(() => buildM1CompatiblePackage({
    ...extraction,
    evidence: {
      ...extraction.evidence,
      unavailable: [{ item: 'records', reason: '500', evidence: null }],
    },
    toleratedUnavailable: ['processDefinitions'],
  }), /source unavailable/);
});

test('P4-T3a comments sharing a per-record kintone id stay distinct in the package', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, buildM1CompatiblePackage, stableSourceUuid } = kintone;
  const compatibility = [mapKintoneField({ code: 'title', type: 'SINGLE_LINE_TEXT', label: 'Title' })];
  const comments = ['2', '4', '8'].map((recordId) => ({
    id: '1', recordId, content: `note on ${recordId}`,
    creator: { code: 'admin', name: 'Admin' }, mentions: [],
    createdAt: '2026-11-22T15:51:49Z',
  }));
  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('14'), compatibility,
    records: ['2', '4', '8'].map((id) => ({ $id: { value: id }, title: { value: 'x' } })),
    comments, attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const packaged = read('data/comments.json').comments;
  assert.equal(packaged.length, 3);
  assert.equal(new Set(packaged.map((comment) => comment.id)).size, 3,
    'comment ids must be distinct across records');
  assert.deepEqual(packaged.map((comment) => comment.body).sort(),
    ['note on 2', 'note on 4', 'note on 8']);
});

test('P4-T3a real kintone comment shape (text field) keeps body and mention', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility, buildM1CompatiblePackage, stableSourceUuid } = kintone;
  // The owner identity (with display name) arrives through a record field,
  // exactly like the real fixture; the comment itself uses the real
  // kintone shape: text, creator, mentions with code only.
  const compatibility = [
    mapKintoneField({ code: 'title', type: 'SINGLE_LINE_TEXT', label: 'Title' }),
    mapKintoneField({ code: 'owner', type: 'USER_SELECT', label: 'Owner' }),
  ];
  const mentionRecords = [{
    $id: { value: '2' }, title: { value: 'x' },
    owner: { value: [{ code: 'owner@example.test', name: 'Owner Name' }] },
  }];
  resolveExtractionCompatibility(compatibility, { records: mentionRecords, gateProblems: [] });
  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('15'), compatibility,
    records: mentionRecords,
    comments: [{
      id: '1', recordId: '2',
      text: 'Owner Name \n見積を作成しました。内容をご確認ください。 ',
      creator: { code: 'admin', name: 'Admin' },
      mentions: [{ code: 'owner@example.test', type: 'USER' }],
      createdAt: '2026-11-22T15:51:49Z',
    }],
    attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true,
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const packaged = read('data/comments.json').comments;
  assert.equal(packaged.length, 1);
  assert.equal(packaged[0].body, 'Owner Name \n見積を作成しました。内容をご確認ください。 ');
  assert.deepEqual(packaged[0].mentions, [{
    userId: stableSourceUuid('kintone:15:user:owner@example.test'), offset: 0, length: 10,
  }]);
});

test('P4-T3a subtable file children seal target file ids, not source file keys', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, buildM1CompatiblePackage, stableSourceUuid } = kintone;
  const table = mapKintoneField({
    code: 'lines', type: 'SUBTABLE',
    fields: { doc: { type: 'FILE', label: 'Doc' }, name: { type: 'SINGLE_LINE_TEXT', label: 'Name' } },
  });
  assert.equal(table.status, 'EQUIVALENT');
  const body = Buffer.from('row-attachment');
  const sha256 = require('node:crypto').createHash('sha256').update(body).digest('hex');
  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('13'), compatibility: [table],
    records: [{ $id: { value: '1' } }],
    comments: [],
    attachments: [{
      recordId: '1', fieldCode: 'lines.doc', fileKey: 'fk-row', name: 'row.txt',
      bytes: body.length, sha256, body,
    }],
    subtableRows: [{
      sourceRecordId: '1', sourceTableCode: 'lines', sourceRowId: 'r1',
      targetRowId: stableSourceUuid('kintone:13:record:1:table:lines:row:r1'), rowOrder: 0,
      data: {
        doc: { type: 'FILE', value: [{ fileKey: 'fk-row', name: 'row.txt' }] },
        name: { type: 'SINGLE_LINE_TEXT', value: 'n1' },
      },
      attachments: [],
    }],
    subtableStates: [{ sourceRecordId: '1', sourceTableCode: 'lines', valueState: 'ROWS', rowCount: 1 }],
    blocking: [], packageReady: true,
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { read } = unzip(sealed.archive);
  const rows = read('data/table-rows.json').rows;
  const docFieldId = stableSourceUuid('kintone:13:field:lines:doc');
  assert.equal(rows[0].data[docFieldId],
    JSON.stringify([stableSourceUuid('kintone:13:file:fk-row')]));
});
