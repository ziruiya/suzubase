const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');

test('P2-M3 kintone source safety and field mapping are explicit', async () => {
  const { KintoneSourceAdapter, validateKintoneDomain, mapKintoneField, stableSourceUuid } = await import('../../../apps/api/dist/kintone-import.js');
  assert.equal(validateKintoneDomain('https://example.cybozu.com', 'example.cybozu.com'), 'https://example.cybozu.com');
  assert.throws(() => validateKintoneDomain('http://example.cybozu.com', 'example.cybozu.com'), /HTTPS/);
  assert.throws(() => validateKintoneDomain('https://127.0.0.1', '127.0.0.1'), /public origin/);
  assert.throws(() => validateKintoneDomain('https://[::1]', '[::1]'), /public origin/);
  assert.throws(() => validateKintoneDomain('https://[::ffff:127.0.0.1]', '[::ffff:127.0.0.1]'), /public origin/);
  assert.throws(() => validateKintoneDomain('https://evil.example', 'example.cybozu.com'), /allowlisted/);
  const previousAllowlist = process.env.KINTONE_ALLOWED_HOSTS;
  process.env.KINTONE_ALLOWED_HOSTS = '127.0.0.1';
  try {
    assert.throws(() => new KintoneSourceAdapter('https://127.0.0.1', 'never-used'), /public origin/);
  } finally {
    if (previousAllowlist === undefined) delete process.env.KINTONE_ALLOWED_HOSTS;
    else process.env.KINTONE_ALLOWED_HOSTS = previousAllowlist;
  }

  const calcFields = [{ code: 'qty', type: 'NUMBER' }, { code: 'price', type: 'NUMBER' }];
  const calc = mapKintoneField({
    code: 'total', type: 'CALC', format: 'NUMBER', expression: 'qty * (price + 2)',
  }, { fields: calcFields });
  assert.equal(calc.status, 'EQUIVALENT');
  assert.deepEqual(calc.formula, [
    { kind: 'field', fieldId: 'qty' },
    { kind: 'field', fieldId: 'price' },
    { kind: 'number', value: '2' },
    { kind: 'operator', operator: '+' },
    { kind: 'operator', operator: '*' },
  ]);
  const nonConvertibleCalc = { code: 'total', type: 'CALC', expression: 'SUM(qty)' };
  assert.equal(mapKintoneField(nonConvertibleCalc).status, 'UNRESOLVED');
  const acceptedCalc = mapKintoneField(nonConvertibleCalc, { acceptCalcDataOnly: true });
  assert.equal(acceptedCalc.status, 'DATA_ONLY');
  assert.equal(acceptedCalc.sourceConfig.expression, 'SUM(qty)');
  assert.match(acceptedCalc.reason, /Administrator accepted/);
  assert.equal(mapKintoneField({ code: 'category', type: 'CATEGORY' }).status, 'UNSUPPORTED');
  assert.equal(mapKintoneField({ code: 'owner', type: 'USER_SELECT' }).status, 'UNRESOLVED');
  assert.equal(mapKintoneField({ code: 'title', type: 'SINGLE_LINE_TEXT' }).status, 'EQUIVALENT');
  assert.equal(mapKintoneField({ code: 'mystery', type: 'NEW_TYPE' }).status, 'UNSUPPORTED');
  const requiredTypes = [
    'SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'RICH_TEXT', 'NUMBER', 'CALC',
    'RADIO_BUTTON', 'DROP_DOWN', 'CHECK_BOX', 'MULTI_SELECT', 'DATE', 'TIME',
    'DATETIME', 'LINK', 'USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT',
    'FILE', 'SUBTABLE', 'REFERENCE_TABLE', 'RECORD_NUMBER', 'CREATOR', 'MODIFIER',
    'CREATED_TIME', 'UPDATED_TIME', 'STATUS', 'STATUS_ASSIGNEE', 'CATEGORY',
    'GROUP', 'LABEL', 'SPACER', 'HR',
  ];
  for (const type of requiredTypes) {
    assert.ok(
      ['EQUIVALENT', 'DATA_ONLY', 'UNRESOLVED', 'UNSUPPORTED'].includes(
        mapKintoneField({ code: type.toLowerCase(), type }).status,
      ),
      `Missing explicit compatibility result for ${type}`,
    );
  }
  assert.equal(mapKintoneField({
    code: 'lookup_without_target', type: 'SINGLE_LINE_TEXT', lookup: {},
  }).status, 'UNRESOLVED');
  assert.equal(stableSourceUuid('app:record:table:row'), stableSourceUuid('app:record:table:row'));
  assert.notEqual(stableSourceUuid('app:record:table:row'), stableSourceUuid('app:record:table:row2'));
});

test('P2-M3 resumes a failed cursor from its checkpoint without duplicate records', async (t) => {
  const { KintoneSourceAdapter, stableSourceUuid } = await import('../../../apps/api/dist/kintone-import.js');
  let pageTwoFails = true;
  let attachmentFails = true;
  let denyFields = false;
  let cursorPages = 0;
  const cursorQueries = [];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: url.searchParams.toString() });
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    if (url.pathname === '/k/v1/app.json') return send(200, { name: 'fixture' });
    if (url.pathname === '/k/v1/app/form/fields.json') {
      if (denyFields) return send(403, { message: 'not authorized' });
      return send(200, { properties: {
        title: { type: 'SINGLE_LINE_TEXT' }, lines: { type: 'SUBTABLE' }, docs: { type: 'FILE' },
      } });
    }
    if (url.pathname === '/k/v1/records.json') return send(200, { records: [] });
    if (url.pathname === '/k/v1/records/cursor.json' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.id === 'fixture-cursor') {
        cursorPages++;
        if (cursorPages === 1) return send(200, { records: [
          { $id: { value: '1' }, title: { value: 'one' }, lines: { value: [] },
            docs: { value: [{ fileKey: 'retry-file', name: 'source.txt' }] } },
          { $id: { value: '2' }, title: { value: 'two' }, lines: { value: null }, docs: { value: [] } },
        ], next: true });
        if (pageTwoFails) return send(503, { message: 'temporary outage' });
        return send(200, { records: [], next: false });
      }
      if (body.id === 'resume-cursor') return send(200, { records: [
        { $id: { value: '3' }, title: { value: 'three' }, lines: { value: [
          { id: 'row3', value: { proof: { value: [{ fileKey: 'row-file', name: 'row.txt' }] } } },
        ] }, docs: { value: [] } },
      ], next: false });
      if (body.query) {
        cursorQueries.push(body.query);
        return send(200, { id: body.query.includes('$id > 2') ? 'resume-cursor' : 'fixture-cursor' });
      }
      return send(200, { id: 'fixture-cursor' });
    }
    if (url.pathname === '/k/v1/records/cursor.json' && req.method === 'DELETE') return send(200, {});
    if (url.pathname === '/k/v1/record/comments.json') {
      return send(200, { comments: [{ id: `${url.searchParams.get('record')}-comment`, content: 'ok' }] });
    }
    if (url.pathname === '/k/v1/file.json') {
      if (attachmentFails) {
        attachmentFails = false;
        return send(403, { message: 'temporary denial' });
      }
      return send(200, Buffer.from('file-body'), 'application/octet-stream');
    }
    return send(200, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const previousAllowlist = process.env.KINTONE_ALLOWED_HOSTS;
  process.env.KINTONE_ALLOWED_HOSTS = 'fixture.cybozu.com';
  t.after(() => {
    if (previousAllowlist === undefined) delete process.env.KINTONE_ALLOWED_HOSTS;
    else process.env.KINTONE_ALLOWED_HOSTS = previousAllowlist;
  });
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  const fetcher = (input, init) => fetch(new URL(new URL(input).pathname + new URL(input).search, localOrigin), init);
  const adapter = new KintoneSourceAdapter('https://fixture.cybozu.com', 'secret-not-logged', 2000, 0, fetcher);
  let savedCheckpoint;
  const first = await adapter.extract('app-1', true, {
    onCheckpoint: (checkpoint) => { savedCheckpoint = checkpoint; },
  });
  assert.equal(first.evidence.unavailable.some((item) => item.item === 'records'), true);
  assert.deepEqual(first.records.map((record) => record.$id.value), ['1', '2']);
  assert.equal(first.subtableStates.find((item) => item.sourceRecordId === '1').valueState, 'EMPTY');
  assert.equal(first.subtableStates.find((item) => item.sourceRecordId === '2').valueState, 'NULL');
  assert.equal(savedCheckpoint.lastRecordId, '2');
  assert.deepEqual(cursorQueries, ['$id > 0 order by $id asc']);
  assert.equal(first.evidence.unavailable.some((item) => item.item === 'attachment:1:docs:retry-file'), true);

  pageTwoFails = false;
  const retriedCheckpoint = await adapter.retryAttachment(savedCheckpoint, {
    recordId: '1', fieldCode: 'docs', fileKey: 'retry-file', name: 'source.txt',
  });
  assert.equal(retriedCheckpoint.unavailable.some((item) => item.item === 'attachment:1:docs:retry-file'), false);
  assert.equal(retriedCheckpoint.attachments[0].bytes, Buffer.byteLength('file-body'));
  assert.equal(retriedCheckpoint.attachments[0].sha256,
    require('node:crypto').createHash('sha256').update('file-body').digest('hex'));
  assert.equal(retriedCheckpoint.attachments[0].recordId, '1');
  const resumed = await adapter.extract('app-1', true, { checkpoint: retriedCheckpoint });
  assert.deepEqual(resumed.records.map((record) => record.$id.value), ['1', '2', '3']);
  assert.equal(new Set(resumed.records.map((record) => record.$id.value)).size, 3);
  assert.deepEqual(resumed.comments.map((comment) => comment.id), ['1-comment', '2-comment', '3-comment']);
  assert.deepEqual(cursorQueries, ['$id > 0 order by $id asc', '$id > 2 order by $id asc']);
  const row = resumed.subtableRows[0];
  assert.equal(row.targetRowId, stableSourceUuid('kintone:app-1:record:3:table:lines:row:row3'));
  assert.equal(row.rowOrder, 0);
  assert.deepEqual(row.attachments, [{
    fileKey: 'row-file', bytes: Buffer.byteLength('file-body'),
    sha256: require('node:crypto').createHash('sha256').update('file-body').digest('hex'),
  }]);
  assert.equal(resumed.attachments.find((file) => file.fileKey === 'row-file').recordId, '3');
  assert.equal(resumed.attachments.find((file) => file.fileKey === 'row-file').bytes, Buffer.byteLength('file-body'));
  denyFields = true;
  const denied = await adapter.preflight('app-1');
  assert.equal(Object.hasOwn(denied.available, 'fields'), false);
  assert.match(denied.unavailable.find((item) => item.item === 'fields').reason, /permission denied/);

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
