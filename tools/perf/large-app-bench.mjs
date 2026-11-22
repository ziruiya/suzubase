// G3-15 large-application measurement (no pass line; numbers + bottlenecks).
// Scales one application to 10,000 records + 500 attachments (seeded directly
// in the DB + attachment storage, the Gate 1/2 seeding method), then measures
// a real API export and a real API import of the resulting package into a
// fresh tenant of the same deployment.
//   BENCH_API_URL=http://api:3000 ADMIN_DATABASE_URL=... ATTACHMENT_DIRECTORY=/workspace/attachments \
//     node tools/perf/large-app-bench.mjs
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Api, exportApp, login, provision, sha256 } from '../fixtures/fixture-tools.mjs';

const require = createRequire(import.meta.url);
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = dbRequire('pg');

const api = new Api(process.env.BENCH_API_URL ?? process.env.A_API_URL ?? 'http://api:3000');
const dbUrl = process.env.ADMIN_DATABASE_URL;
const attachmentRoot = process.env.ATTACHMENT_DIRECTORY ?? './attachments';
const RECORDS = 10000;
const ATTACHMENTS = 500;

const owner = await provision(dbUrl, { isAdmin: true });
const token = await login(api, owner);
const app = await api.expect(token, 201, '/apps', { method: 'POST', body: { code: 'large-bench', name: 'Large bench' } });
const title = await api.expect(token, 201, `/apps/${app.id}/fields`, { method: 'POST', body: { code: 'title', name: 'Title', type: 'text' } });
const amount = await api.expect(token, 201, `/apps/${app.id}/fields`, { method: 'POST', body: { code: 'amount', name: 'Amount', type: 'number' } });
const docs = await api.expect(token, 201, `/apps/${app.id}/fields`, { method: 'POST', body: { code: 'docs', name: 'Docs', type: 'attachment' } });
const version = (await api.expect(token, 201, `/apps/${app.id}/publish`, { method: 'POST' })).publishedSchemaVersion;

const db = new Client({ connectionString: dbUrl });
await db.connect();
const seedStarted = performance.now();
try {
  await db.query('BEGIN');
  await db.query(`
    INSERT INTO records (tenant_id, app_id, record_no, data, schema_version, created_by, updated_by)
    SELECT $1::uuid, $2::uuid, n,
      jsonb_build_object($3::text, 'Large record ' || n, $4::text, (n % 1000)::text),
      $5::int, $6::uuid, $6::uuid
    FROM generate_series(1, ${RECORDS}) AS source(n)`,
    [owner.tenantId, app.id, title.fieldId, amount.fieldId, version, owner.userId]);
  // 500 attachment files, each referenced by one of the first 500 records.
  const pdf = Buffer.from('%PDF-1.4\nlarge bench attachment body, repeated for realism 0123456789\n%%EOF\n');
  const fileIds = [];
  for (let i = 0; i < ATTACHMENTS; i++) fileIds.push(randomUUID());
  const values = [];
  const params = [];
  fileIds.forEach((fileId, i) => {
    params.push(owner.tenantId, app.id, fileId, owner.userId, pdf.length, sha256(pdf));
    values.push(`($${params.length - 5}, $${params.length - 4}, $${params.length - 3}, $${params.length - 2}, 'ATTACHED', 'bench-${i}.pdf', 'application/pdf', $${params.length - 1}, $${params.length})`);
  });
  await db.query(`INSERT INTO files (tenant_id, app_id, id, uploaded_by, state, name, content_type, bytes, sha256) VALUES ${values.join(',')}`, params);
  for (const [i, fileId] of fileIds.entries()) {
    const key = join(attachmentRoot, owner.tenantId, app.id, fileId);
    mkdirSync(key, { recursive: true });
    writeFileSync(join(key, '1'), pdf);
    await db.query(
      `INSERT INTO file_references (tenant_id, app_id, record_id, field_id, file_id)
       SELECT $1::uuid, $2::uuid, id, $3::uuid, $4::uuid FROM records
       WHERE tenant_id = $1 AND app_id = $2 AND record_no = $5`,
      [owner.tenantId, app.id, docs.fieldId, fileId, i + 1]);
    await db.query(
      `UPDATE records SET data = data || jsonb_build_object($3::text, $4::text)
       WHERE tenant_id = $1 AND app_id = $2 AND record_no = $5`,
      [owner.tenantId, app.id, docs.fieldId, JSON.stringify([fileId]), i + 1]);
    await db.query('UPDATE files SET reference_count = 1 WHERE tenant_id = $1 AND app_id = $2 AND id = $3',
      [owner.tenantId, app.id, fileId]);
  }
  await db.query('UPDATE app_counters SET last_value = $3 WHERE tenant_id = $1 AND app_id = $2', [owner.tenantId, app.id, RECORDS]);
  await db.query('COMMIT');
} finally { await db.end(); }
const seedMs = performance.now() - seedStarted;

const exportStarted = performance.now();
const { archive, run } = await exportApp(api, token, app.id);
const exportMs = performance.now() - exportStarted;

// Import into a fresh tenant (same deployment) through the real wizard path.
const admin = await provision(dbUrl, { isAdmin: true });
const adminToken = await login(api, admin);
const importStarted = performance.now();
const uploaded = await api.call(adminToken, '/imports/upload', { method: 'POST', body: archive, contentType: 'application/octet-stream', expect: 201 });
const job = uploaded.body;
await api.expect(adminToken, 201, `/imports/${job.id}/validate`, { method: 'POST' });
await api.expect(adminToken, 200, `/imports/${job.id}/mappings`, { method: 'PUT', body: { users: { [owner.userId]: admin.userId } } });
const issued = await api.expect(adminToken, 201, `/imports/${job.id}/migration-token`, { method: 'POST' });
const runImport = await api.expect(issued.token, 201, `/imports/${job.id}/run`, { method: 'POST' });
const importMs = performance.now() - importStarted;
if (runImport.status !== 'ready') throw new Error('large import did not reach ready: ' + JSON.stringify(runImport).slice(0, 300));
const detail = await api.expect(adminToken, 200, `/imports/${job.id}`, {});
console.log(JSON.stringify({
  records: RECORDS, attachments: ATTACHMENTS, packageBytes: archive.length,
  seedMs: Math.round(seedMs), exportMs: Math.round(exportMs), importMs: Math.round(importMs),
  exportCounts: run.counts ?? null,
  importedRecords: detail.report?.counts?.target?.records ?? null,
  attachmentFailures: detail.report?.verification?.attachments?.failed?.length ?? null,
}, null, 2));
