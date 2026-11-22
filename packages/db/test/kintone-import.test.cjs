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
  assert.throws(() => validateKintoneDomain('https://[fec0::1]', '[fec0::1]'), /public origin/);
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
  let denyAppAcl = false;
  let denySecondRecordComments = true;
  let includeSourceWorkflow = false;
  let includeSourceAcl = false;
  let includeSourceLayout = false;
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
        title: { type: 'SINGLE_LINE_TEXT' },
        lines: { type: 'SUBTABLE', fields: { item: { type: 'SINGLE_LINE_TEXT', label: 'Item' } } },
        docs: { type: 'FILE' },
      } });
    }
    if (url.pathname === '/k/v1/app/acl.json' && includeSourceAcl) {
      return send(200, { rights: [{ entity: { type: 'USER', code: 'alice' }, app: 'VIEW' }] });
    }
    if (url.pathname === '/k/v1/app/acl.json' && denyAppAcl) {
      return send(403, { message: 'not authorized' });
    }
    if (url.pathname === '/k/v1/app/form/layout.json' && includeSourceLayout) {
      return send(200, { layout: [{ type: 'ROW', fields: [{ code: 'title' }] }] });
    }
    if (url.pathname === '/k/v1/app/status.json' && includeSourceWorkflow) {
      return send(200, { enable: true, states: { open: {}, closed: {} }, actions: [{ name: 'close' }] });
    }
    if (url.pathname === '/k/v1/app/processes.json' && includeSourceWorkflow) {
      return send(200, { processes: { default: { states: { open: {} } } } });
    }
    if (url.pathname === '/k/v1/records.json') return send(200, { records: [] });
    if (url.pathname === '/k/v1/records/cursor.json' &&
      ['GET', 'POST'].includes(req.method)) {
      let body;
      if (req.method === 'GET') body = { id: url.searchParams.get('id') };
      else {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      }
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
      if (url.searchParams.get('record') === '2' && denySecondRecordComments) {
        return send(403, { message: 'comment access denied' });
      }
      if (url.searchParams.get('record') === '1') {
        const offset = Number(url.searchParams.get('offset'));
        return send(200, { comments: offset === 0
          ? Array.from({ length: 10 }, (_, index) => ({ id: `1-comment-${index + 1}`, content: 'ok' }))
          : [{ id: '1-comment-11', content: 'tail' }] });
      }
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
  assert.equal(first.evidence.unavailable.some((item) => item.item === 'comments:2'), true);
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
  assert.deepEqual(resumed.comments.map((comment) => comment.id), [
    ...Array.from({ length: 10 }, (_, index) => `1-comment-${index + 1}`),
    '1-comment-11', '3-comment',
  ]);
  assert.equal(resumed.evidence.unavailable.some((item) => item.item === 'comments:2'), true);
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
  denyFields = false;
  denySecondRecordComments = false;
  denyAppAcl = true;
  const deniedAcl = await adapter.extract('app-1', true);
  assert.equal(deniedAcl.sourceMetadata.acl.app, undefined);
  assert.equal(deniedAcl.evidence.unavailable.some((item) => item.item === 'appAcl'), true);
  denyAppAcl = false;
  includeSourceWorkflow = true;
  includeSourceAcl = true;
  includeSourceLayout = true;
  const gated = await adapter.extract('app-1', true);
  assert.equal(gated.packageReady, false);
  assert.ok(gated.gateProblems.some((problem) => problem.includes('workflow')));
  assert.ok(gated.gateProblems.some((problem) => problem.includes('permissions')));
  assert.ok(gated.gateProblems.some((problem) => problem.includes('layout')));
  const accepted = await adapter.extract('app-1', true, {
    acceptWorkflowDowngrade: true, acceptPermissionDowngrade: true, acceptLayoutDowngrade: true,
  });
  assert.equal(accepted.packageReady, true);
  assert.deepEqual(accepted.downgrades.map(({ item }) => item).sort(), ['layout', 'permissions', 'workflow']);
  const acceptedPackage = require('../../../apps/api/dist/kintone-import.js')
    .buildM1CompatiblePackage(accepted);
  assert.deepEqual(require('../../../apps/api/dist/export-package.js')
    .verifyPackage(acceptedPackage.archive).problems, []);
  assert.equal(acceptedPackage.manifest.inclusion.kintoneWorkflow, 'unsupported');
  assert.equal(acceptedPackage.manifest.inclusion.kintonePermissions, 'unsupported');
  assert.equal(acceptedPackage.manifest.inclusion.kintoneLayout, 'unsupported');

});

test('P2-M3 builds only frozen, complete kintone data as a verifiable M1 package', async () => {
  const { buildM1CompatiblePackage, mapKintoneField, stableSourceUuid } = await import('../../../apps/api/dist/kintone-import.js');
  const { verifyPackage } = await import('../../../apps/api/dist/export-package.js');
  const appId = '123';
  const extractedAt = '2026-11-23T00:00:00.000Z';
  const field = {
    sourceFieldCode: 'title', sourceType: 'SINGLE_LINE_TEXT', targetType: 'text',
    status: 'EQUIVALENT', reason: 'direct', sourceConfig: {}, sourceUnavailable: false, upgradeRequired: false,
  };
  const tableField = mapKintoneField({
    code: 'lines', type: 'SUBTABLE', fields: { item: { type: 'SINGLE_LINE_TEXT', label: 'Item' } },
  });
  const sourceRowId = stableSourceUuid(`kintone:${appId}:row:1`);
  const body = Buffer.from('attachment-body');
  const extraction = {
    evidence: {
      source: 'kintone', appId, appName: 'M3 Test', extractedAt, settingVersion: '1',
      recordIdRange: { min: '1', max: '1' }, frozenWindow: true, unavailable: [],
    },
    compatibility: [field, tableField],
    records: [{ $id: { value: '1' }, title: { value: 'Hello' } }],
    comments: [{
      id: '10', recordId: '1', content: 'Hello @Alice', creator: { code: 'alice' },
      mentions: [{ code: 'alice', name: 'Alice' }], createdAt: extractedAt,
    }],
    attachments: [{
      recordId: '1', fieldCode: 'files', fileKey: 'fk-1', name: 'a.txt',
      bytes: body.length, sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'), body,
    }],
    subtableRows: [{
      sourceRecordId: '1', sourceTableCode: 'lines', sourceRowId: 'row-1',
      targetRowId: stableSourceUuid(`kintone:${appId}:record:1:table:lines:row:row-1`),
      rowOrder: 0, data: { item: { value: 'A' } }, attachments: [],
    }],
    subtableStates: [{ sourceRecordId: '1', sourceTableCode: 'lines', valueState: 'ROWS', rowCount: 1 }],
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
  const { unzipSync } = require('../../../apps/api/node_modules/fflate');
  const packageFiles = unzipSync(new Uint8Array(sealed.archive));
  const importedComments = JSON.parse(Buffer.from(packageFiles['data/comments.json']).toString()).comments;
  assert.deepEqual(importedComments[0].mentions, [{
    userId: stableSourceUuid(`kintone:${appId}:user:alice`), offset: 6, length: 6,
  }]);
  const directory = JSON.parse(Buffer.from(packageFiles['data/directory.json']).toString());
  assert.equal(directory.users[0].id, stableSourceUuid(`kintone:${appId}:user:alice`));

  assert.throws(() => buildM1CompatiblePackage({
    ...extraction,
    evidence: { ...extraction.evidence, frozenWindow: false },
  }), /frozen snapshot/);
  assert.throws(() => buildM1CompatiblePackage({
    ...extraction,
    evidence: { ...extraction.evidence, unavailable: [{ item: 'records', reason: '403', evidence: null }] },
  }), /source unavailable/);
});
