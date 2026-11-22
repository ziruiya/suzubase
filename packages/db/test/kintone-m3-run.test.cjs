const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const { configureRuntime, login, provision } = require('./support.cjs');

configureRuntime();

test('P2-M3-C runner completes a mock extraction and isolated local SuzuBase import', async (t) => {
  const expectedTokens = { '100': 'fixture-token-a', '200': 'fixture-token-b' };
  const seenTokens = [];
  const cursorTokens = [];
  const cursors = new Map();
  const source = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const appId = url.searchParams.get('app');
    seenTokens.push({ appId, token: req.headers['x-cybozu-api-token'] });
    const json = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/k/v1/app.json') return json({ name: `Fixture ${appId}` });
    if (url.pathname === '/k/v1/app/form/fields.json') return json({ properties: {
      title: { type: 'SINGLE_LINE_TEXT', label: 'Title' },
      lines: { type: 'SUBTABLE', fields: { item: { type: 'SINGLE_LINE_TEXT', label: 'Item' } } },
      docs: { type: 'FILE', label: 'Documents' },
    } });
    if (url.pathname === '/k/v1/app/form/layout.json') return json({ layout: [] });
    if (url.pathname === '/k/v1/app/acl.json' || url.pathname === '/k/v1/record/acl.json' ||
      url.pathname === '/k/v1/field/acl.json') return json({ rights: [] });
    if (url.pathname === '/k/v1/app/status.json') return json({ enable: false, states: [], actions: [] });
    if (url.pathname === '/k/v1/app/processes.json') return json({ processes: {} });
    if (url.pathname === '/k/v1/records.json') return json({ records: [] });
    if (url.pathname === '/k/v1/records/cursor.json' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (body.app) cursorTokens.push({ appId: body.app, token: req.headers['x-cybozu-api-token'] });
      if (body.id) {
        const recordAppId = cursors.get(body.id);
        return json({ records: [{
          $id: { value: '1' }, title: { value: `Record from ${recordAppId}` },
          lines: { value: [{ id: 'row-1', value: { item: { value: 'table item' } } }] },
          docs: { value: [{ fileKey: `file-${recordAppId}`, name: 'fixture.txt' }] },
        }], next: false });
      }
      const id = `cursor-${body.app}`;
      cursors.set(id, body.app);
      return json({ id });
    }
    if (url.pathname === '/k/v1/records/cursor.json' && req.method === 'DELETE') return json({});
    if (url.pathname === '/k/v1/record/comments.json') return json({ comments: [{
      id: `${url.searchParams.get('app')}-comment`, recordId: '1', content: 'Fixture review',
    }] });
    if (url.pathname === '/k/v1/file.json') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end('fixture attachment');
    }
    return json({});
  });
  await new Promise((resolveListen) => source.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((resolveClose, reject) =>
    source.close((error) => error ? reject(error) : resolveClose())));

  const tenant = await provision({ isAdmin: true });
  const accessToken = await login(tenant);
  const reportDir = mkdtempSync(join(tmpdir(), 'suzubase-m3-c-'));
  t.after(() => rmSync(reportDir, { recursive: true, force: true }));
  const result = await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [resolve('tools/kintone/run-m3-c.mjs')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KINTONE_SUBDOMAIN: 'fixture',
        KINTONE_APP_A_ID: '100',
        KINTONE_APP_B_ID: '200',
        KINTONE_API_TOKEN_A: expectedTokens['100'],
        KINTONE_API_TOKEN_B: expectedTokens['200'],
        KINTONE_ALLOWED_HOSTS: 'fixture.cybozu.com',
        KINTONE_FREEZE_WINDOW_CONFIRMED: 'true',
        KINTONE_DRY_RUN: 'true',
        KINTONE_MOCK_ORIGIN: `http://127.0.0.1:${source.address().port}`,
        KINTONE_REPORT_DIR: reportDir,
        SUZUBASE_TARGET_API_ORIGIN: process.env.TEST_API_URL ?? 'http://api:3000',
        SUZUBASE_TARGET_ACCESS_TOKEN: accessToken,
        SUZUBASE_TARGET_ISOLATED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectChild);
    child.once('close', (code) => {
      if (code === 0) return resolveChild({ stdout, stderr });
      let report = '';
      try { report = readFileSync(JSON.parse(stdout).report, 'utf8'); } catch { /* report may not exist */ }
      rejectChild(new Error(`M3-C runner exited ${code}: ${stderr || stdout}\n${report}`));
    });
  });

  assert.deepEqual(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.result, 'ACTIVATED');
  assert.deepEqual(output.applications.map(({ status }) => status), ['activated', 'activated']);
  const reportName = readdirSync(reportDir).find((name) => name.endsWith('.json') && !name.endsWith('.checkpoint.json'));
  const report = JSON.parse(readFileSync(join(reportDir, reportName), 'utf8'));
  assert.equal(report.source.applications.length, 2);
  assert.ok(report.source.applications.every((app) =>
    app.extractionStartedAt && app.extractionEndedAt && app.sourceRecordIdRange.min === '1' &&
    app.sourceRecordIdRange.max === '1'));
  assert.equal(report.dataCompleteness.rate, 1);
  assert.ok(report.dimensions.records.every((item) => item.source === 1 && item.target === 1));
  assert.ok(report.dimensions.subtableRows.every((item) => item.source === 1 && item.target === 1));
  assert.ok(report.dimensions.attachments.every((item) => item.source === 1 && item.target === 1));
  assert.ok(report.dimensions.comments.every((item) => item.source === 1 && item.target === 1));
  assert.equal(report.sourceUnavailable.length, 0);
  assert.deepEqual([...new Set(seenTokens.map(({ token }) => token))].sort(),
    [expectedTokens['100'], expectedTokens['200']].sort());
  assert.ok(seenTokens.filter(({ appId }) => appId !== null)
    .every(({ appId, token }) => token === expectedTokens[appId]));
  assert.ok(cursorTokens.every(({ appId, token }) => token === expectedTokens[appId]));
});
