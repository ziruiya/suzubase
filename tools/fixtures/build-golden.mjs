// G3-11 / decision 3: build the golden sample package.
// Exports a compact fixture application with the CURRENT code and stores the
// sealed package as the repo golden fixture. CI replays it through the
// current importer (see gate3-wavec.test.cjs golden regression).
//   GOLDEN_API_URL=http://api:3000 ADMIN_DATABASE_URL=... node tools/fixtures/build-golden.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Api, exportApp, login, provision } from './fixture-tools.mjs';

const api = new Api(process.env.GOLDEN_API_URL ?? process.env.A_API_URL ?? 'http://api:3000');
const db = process.env.ADMIN_DATABASE_URL;
const owner = await provision(db, { isAdmin: true });
const token = await login(api, owner);
const app = await api.expect(token, 201, '/apps', { method: 'POST', body: { code: 'golden-app-1', name: 'Golden Sample 顧客管理' } });
const base = '/apps/' + app.id;
const title = await api.expect(token, 201, base + '/fields', { method: 'POST', body: { code: 'title', name: 'タイトル', type: 'text' } });
const amount = await api.expect(token, 201, base + '/fields', { method: 'POST', body: { code: 'amount', name: '金額', type: 'number' } });
const docs = await api.expect(token, 201, base + '/fields', { method: 'POST', body: { code: 'docs', name: '添付', type: 'attachment' } });
await api.expect(token, 201, base + '/fields', { method: 'POST', body: {
  code: 'case-no', name: '番号', type: 'autoNumber',
  autoNumber: { prefix: 'G-', scopeFieldId: null, nextValue: '1', padding: 3, enabled: true },
} });
await api.expect(token, 201, base + '/publish', { method: 'POST' });
const pdf = Buffer.from('%PDF-1.4\ngolden attachment\n%%EOF\n');
const uploaded = await api.call(token, base + '/files?' + new URLSearchParams({ name: 'golden.pdf', type: 'application/pdf' }), {
  method: 'POST', body: pdf, contentType: 'application/octet-stream', expect: 201,
});
for (let i = 1; i <= 3; i++) {
  const record = await api.expect(token, 201, base + '/records', { method: 'POST',
    body: { data: { [title.fieldId]: 'Golden record ' + i, [amount.fieldId]: String(i * 100) } } });
  if (i === 1) {
    const current = await api.expect(token, 200, `${base}/records/${record.id}`, {});
    await api.expect(token, 200, `${base}/records/${record.id}`, { method: 'PUT', body: {
      revision: current.revision,
      data: { [title.fieldId]: 'Golden record 1', [amount.fieldId]: '100', [docs.fieldId]: JSON.stringify([uploaded.body.id]) },
    } });
    await api.expect(token, 201, `${base}/records/${record.id}/comments`, { method: 'POST',
      body: { parts: [{ kind: 'text', text: 'golden comment' }] } });
  }
}
const { archive, run } = await exportApp(api, token, app.id);
const target = join(dirname(fileURLToPath(import.meta.url)), '../../packages/db/test/fixtures/golden-app-1.zip');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, archive);
console.log(JSON.stringify({ golden: target, bytes: archive.length, counts: run.counts ?? null }));
