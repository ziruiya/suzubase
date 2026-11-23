const assert = require('node:assert/strict');
const { test } = require('node:test');

// P4 fix batch, task 5 (GPT T3a review): choice option identifier
// uniqueness hardening. resolveChoiceOptions must fail closed — never
// silently issue a duplicate `opt_<index>` — when an object-form
// option is missing its index, an index is duplicated or invalid, a
// source value repeats, or the field default points outside the
// option set. Translated fields are marked IDENTIFIER_TRANSLATED and
// carry the full source -> target map plus the translated default.

async function loadModules() {
  const kintone = await import('../../../apps/api/dist/kintone-import.js');
  const exporter = await import('../../../apps/api/dist/export-package.js');
  return { kintone, exporter };
}

const baseEvidence = (appId) => ({
  source: 'kintone', appId, appName: 'Fix Task5', extractedAt: '2026-11-23T00:00:00.000Z',
  settingVersion: '1', recordIdRange: { min: '1', max: '1' }, frozenWindow: true, unavailable: [],
});

test('P4-fix task5: missing object-form index fails closed (no silent opt_0 collision)', async () => {
  const { kintone } = await loadModules();
  const { resolveChoiceOptions, mapKintoneField, resolveExtractionCompatibility } = kintone;
  const direct = resolveChoiceOptions({
    options: {
      '新規': { label: '新規' },
      '保守': { label: '保守', index: '1' },
    },
  });
  assert.ok(direct && 'problem' in direct, JSON.stringify(direct));
  assert.match(direct.problem, /missing its kintone index/);

  const field = {
    code: 'kind', type: 'DROP_DOWN', label: 'Kind', required: false,
    options: {
      '新規': { label: '新規' },
      '保守': { label: '保守', index: '1' },
    },
  };
  const compatibility = [mapKintoneField(field)];
  assert.equal(compatibility[0].status, 'UNRESOLVED');
  const gateProblems = [];
  resolveExtractionCompatibility(compatibility, {
    records: [{ $id: { value: '1' }, kind: { value: '保守' } }],
    gateProblems,
  });
  assert.equal(compatibility[0].status, 'UNRESOLVED',
    'a missing index must keep the field UNRESOLVED (packaging blocked)');
  assert.match(compatibility[0].reason, /cannot be issued safely/);
  assert.equal(gateProblems.length, 1);
  assert.match(gateProblems[0], /CHOICE_OPTION_IDENTITY: field kind:/);
  assert.throws(() => kintone.buildM1CompatiblePackage({
    evidence: baseEvidence('81'), compatibility,
    records: [{ $id: { value: '1' }, kind: { value: '保守' } }],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: false, gateProblems,
  }), /kintone package blocked/);
});

test('P4-fix task5: duplicate and invalid indices fail closed', async () => {
  const { kintone } = await loadModules();
  const { resolveChoiceOptions } = kintone;
  const duplicate = resolveChoiceOptions({
    options: {
      '新規': { label: '新規', index: '1' },
      '保守': { label: '保守', index: '1' },
    },
  });
  assert.ok(duplicate && 'problem' in duplicate, JSON.stringify(duplicate));
  assert.match(duplicate.problem, /index 1 is assigned to more than one option/);

  for (const bad of ['abc', '-1', '1.5', '']) {
    const result = resolveChoiceOptions({
      options: { '新規': { label: '新規', index: bad } },
    });
    assert.ok(result && 'problem' in result, `index ${JSON.stringify(bad)} must fail closed`);
  }
  // Array form: an explicit index colliding with another explicit index.
  const arrayDuplicate = resolveChoiceOptions({
    options: [
      { value: '新規', label: '新規', index: 1 },
      { value: '保守', label: '保守', index: 1 },
    ],
  });
  assert.ok(arrayDuplicate && 'problem' in arrayDuplicate);
  assert.match(arrayDuplicate.problem, /more than one option/);
  // Array form: a repeated source value would silently overwrite the map.
  const repeatedValue = resolveChoiceOptions({
    options: [
      { value: '新規', label: '新規', index: 0 },
      { value: '新規', label: '新規', index: 1 },
    ],
  });
  assert.ok(repeatedValue && 'problem' in repeatedValue);
  assert.match(repeatedValue.problem, /appears more than once/);
});

test('P4-fix task5: normal options issue unique ids, complete map, translated default, IDENTIFIER_TRANSLATED marker', async () => {
  const { kintone, exporter } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility, buildM1CompatiblePackage } = kintone;
  const field = {
    code: 'kind', type: 'DROP_DOWN', label: 'Kind', required: false,
    defaultValue: '保守',
    options: {
      '保守': { label: '保守', index: '1' },
      '新規': { label: '新規', index: '0' },
      '修理': { label: '修理', index: '2' },
    },
  };
  const compatibility = [mapKintoneField(field)];
  const gateProblems = [];
  resolveExtractionCompatibility(compatibility, {
    records: [{ $id: { value: '1' }, kind: { value: '保守' } }],
    gateProblems,
  });
  const item = compatibility[0];
  assert.equal(item.status, 'EQUIVALENT');
  assert.deepEqual(gateProblems, []);
  assert.equal(item.translation, 'IDENTIFIER_TRANSLATED');
  assert.match(item.reason, /not byte-faithful/);
  // Map completeness: every source option value appears exactly once
  // and every issued identifier is unique.
  assert.deepEqual(item.optionValueMap, { '新規': 'opt_0', '保守': 'opt_1', '修理': 'opt_2' });
  assert.equal(Object.keys(item.optionValueMap).length, item.resolvedOptions.length);
  assert.equal(new Set(Object.values(item.optionValueMap)).size, item.resolvedOptions.length);
  assert.equal(new Set(item.resolvedOptions.map(({ value }) => value)).size, item.resolvedOptions.length);
  // The default is translated through the same map and points at a
  // target option that actually exists.
  assert.equal(item.resolvedDefaultValue, 'opt_1');
  assert.ok(item.resolvedOptions.some(({ value }) => value === item.resolvedDefaultValue));

  const sealed = buildM1CompatiblePackage({
    evidence: baseEvidence('82'), compatibility,
    records: [{ $id: { value: '1' }, kind: { value: '保守' } }],
    comments: [], attachments: [], subtableRows: [], subtableStates: [],
    blocking: [], packageReady: true, gateProblems,
  });
  assert.deepEqual(exporter.verifyPackage(sealed.archive).problems, []);
  const { unzipSync } = require('../../../apps/api/node_modules/fflate');
  const files = unzipSync(new Uint8Array(sealed.archive));
  const schema = JSON.parse(Buffer.from(files['data/schema.json']).toString());
  const reportField = schema.versions[0].migrationReport.fields
    .find((entry) => entry.sourceFieldCode === 'kind');
  assert.equal(reportField.translation, 'IDENTIFIER_TRANSLATED');
  assert.deepEqual(reportField.optionValueMap, { '新規': 'opt_0', '保守': 'opt_1', '修理': 'opt_2' });
  assert.equal(reportField.resolvedDefaultValue, 'opt_1');
  const records = JSON.parse(Buffer.from(files['data/records.json']).toString()).records;
  const kind = schema.fields.find((entry) => entry.code === 'kind');
  assert.equal(records[0].data[kind.fieldId], 'opt_1',
    'record values follow the same map as the default');
});

test('P4-fix task5: safe identifiers stay verbatim; default verified, outside-set default fails closed', async () => {
  const { kintone } = await loadModules();
  const { resolveChoiceOptions, mapKintoneField, resolveExtractionCompatibility } = kintone;
  const safe = resolveChoiceOptions({
    defaultValue: 'beta',
    options: {
      alpha: { label: 'Alpha', index: '0' },
      beta: { label: 'Beta', index: '1' },
    },
  });
  assert.ok(safe && !('problem' in safe), JSON.stringify(safe));
  assert.equal(safe.optionValueMap, undefined, 'no translation, no map');
  assert.deepEqual(safe.resolvedOptions.map(({ value }) => value), ['alpha', 'beta']);
  assert.equal(safe.resolvedDefaultValue, 'beta');

  const outside = resolveChoiceOptions({
    defaultValue: 'gamma',
    options: {
      '新規': { label: '新規', index: '0' },
      '保守': { label: '保守', index: '1' },
    },
  });
  assert.ok(outside && 'problem' in outside);
  assert.match(outside.problem, /not a member of the option set/);

  const field = {
    code: 'kind', type: 'CHECK_BOX', label: 'Kind', required: false,
    defaultValue: ['保守'],
    options: {
      '新規': { label: '新規', index: '0' },
      '保守': { label: '保守', index: '1' },
    },
  };
  const compatibility = [mapKintoneField(field)];
  resolveExtractionCompatibility(compatibility, {
    records: [{ $id: { value: '1' }, kind: { value: ['保守'] } }],
    gateProblems: [],
  });
  assert.equal(compatibility[0].status, 'EQUIVALENT');
  assert.deepEqual(compatibility[0].resolvedDefaultValue, ['opt_1'],
    'multi-value defaults translate element-wise through the same map');
});

test('P4-fix task5: subtable child with a missing index blocks the parent field', async () => {
  const { kintone } = await loadModules();
  const { mapKintoneField, resolveExtractionCompatibility } = kintone;
  const table = {
    code: 'lines', type: 'SUBTABLE', label: 'Lines',
    fields: {
      kind: {
        type: 'DROP_DOWN', label: 'Kind', required: false,
        options: {
          '新規': { label: '新規' },
          '保守': { label: '保守', index: '1' },
        },
      },
    },
  };
  const compatibility = [mapKintoneField(table)];
  const gateProblems = [];
  resolveExtractionCompatibility(compatibility, {
    records: [],
    subtableRows: [{
      sourceRecordId: '1', sourceTableCode: 'lines', sourceRowId: '1',
      targetRowId: 'row-1', rowOrder: 0, data: { kind: { value: '保守' } },
    }],
    gateProblems,
  });
  assert.equal(compatibility[0].status, 'UNRESOLVED');
  assert.ok(gateProblems.some((problem) => problem.includes('CHOICE_OPTION_IDENTITY: field kind:')),
    JSON.stringify(gateProblems));
});
