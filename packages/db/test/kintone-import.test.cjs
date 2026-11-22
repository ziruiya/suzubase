const assert = require('node:assert/strict');
const { test } = require('node:test');

test('P2-M3 kintone source safety and field mapping are explicit', async () => {
  const { validateKintoneDomain, mapKintoneField, stableSourceUuid } = await import('../../../apps/api/dist/kintone-import.js');
  assert.equal(validateKintoneDomain('https://example.cybozu.com', 'example.cybozu.com'), 'https://example.cybozu.com');
  assert.throws(() => validateKintoneDomain('http://example.cybozu.com', 'example.cybozu.com'), /HTTPS/);
  assert.throws(() => validateKintoneDomain('https://127.0.0.1', '127.0.0.1'), /public origin/);
  assert.throws(() => validateKintoneDomain('https://evil.example', 'example.cybozu.com'), /allowlisted/);

  const calc = mapKintoneField({ code: 'total', type: 'CALC', expression: 'SUM(qty)' });
  assert.equal(calc.status, 'UNRESOLVED');
  assert.equal(calc.targetType, 'calculation');
  assert.equal(mapKintoneField({ code: 'category', type: 'CATEGORY' }).status, 'UNSUPPORTED');
  assert.equal(mapKintoneField({ code: 'owner', type: 'USER_SELECT' }).status, 'UNRESOLVED');
  assert.equal(mapKintoneField({ code: 'title', type: 'SINGLE_LINE_TEXT' }).status, 'EQUIVALENT');
  assert.equal(mapKintoneField({ code: 'mystery', type: 'NEW_TYPE' }).status, 'UNSUPPORTED');
  assert.equal(stableSourceUuid('app:record:table:row'), stableSourceUuid('app:record:table:row'));
  assert.notEqual(stableSourceUuid('app:record:table:row'), stableSourceUuid('app:record:table:row2'));
});

test('P2-M3 builds only frozen, complete kintone data as a verifiable M1 package', async () => {
  const { buildM1CompatiblePackage, stableSourceUuid } = await import('../../../apps/api/dist/kintone-import.js');
  const { verifyPackage } = await import('../../../apps/api/dist/export-package.js');
  const appId = '123';
  const extractedAt = '2026-11-23T00:00:00.000Z';
  const field = {
    sourceFieldCode: 'title', sourceType: 'SINGLE_LINE_TEXT', targetType: 'text',
    status: 'EQUIVALENT', reason: 'direct', sourceConfig: {}, sourceUnavailable: false, upgradeRequired: false,
  };
  const sourceRowId = stableSourceUuid(`kintone:${appId}:row:1`);
  const body = Buffer.from('attachment-body');
  const extraction = {
    evidence: {
      source: 'kintone', appId, appName: 'M3 Test', extractedAt, settingVersion: '1',
      recordIdRange: { min: '1', max: '1' }, frozenWindow: true, unavailable: [],
    },
    compatibility: [field],
    records: [{ $id: { value: '1' }, title: { value: 'Hello' } }],
    comments: [{ id: '10', recordId: '1', content: 'Review', creator: { code: 'alice' }, createdAt: extractedAt }],
    attachments: [{
      recordId: '1', fieldCode: 'files', fileKey: 'fk-1', name: 'a.txt',
      bytes: body.length, sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'), body,
    }],
    subtableRows: [{
      sourceRecordId: '1', sourceTableCode: 'lines', sourceRowId: 'row-1',
      targetRowId: sourceRowId, rowOrder: 0, data: { item: 'A' }, attachments: [],
    }],
    blocking: [],
    packageReady: true,
  };
  const sealed = buildM1CompatiblePackage(extraction);
  const verification = verifyPackage(sealed.archive);
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.manifest.formatVersion, '1.0');
  assert.equal(verification.manifest.counts.actual.records, 1);
  assert.equal(verification.manifest.counts.actual.attachments, 1);
  assert.equal(verification.manifest.counts.actual.comments, 1);
  assert.equal(verification.manifest.counts.actual.tableRows, 1);

  assert.throws(() => buildM1CompatiblePackage({
    ...extraction,
    evidence: { ...extraction.evidence, frozenWindow: false },
  }), /frozen snapshot/);
  assert.throws(() => buildM1CompatiblePackage({
    ...extraction,
    evidence: { ...extraction.evidence, unavailable: [{ item: 'records', reason: '403', evidence: null }] },
  }), /source unavailable/);
});
