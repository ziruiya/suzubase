// G3-15 performance regression: 100k-record search benchmark.
// Same seeding method as Gate 1/2 (packages/db/test/search-performance.cjs):
// direct DB seeding of 100,000 records + search projection rows, then
// end-to-end HTTP measurements of exact (full phone) and tail (last-4)
// searches. Reports DB-plan execution time (via the Gate 1 script's method,
// re-run separately) and HTTP P50/P95 here.
//   BENCH_API_URL=http://api:3000 ADMIN_DATABASE_URL=... node tools/perf/search-bench.mjs
import { createRequire } from 'node:module';
import { Api, login, provision } from '../fixtures/fixture-tools.mjs';

const require = createRequire(import.meta.url);
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = dbRequire('pg');

const api = new Api(process.env.BENCH_API_URL ?? process.env.A_API_URL ?? 'http://api:3000');
const dbUrl = process.env.ADMIN_DATABASE_URL;
const owner = await provision(dbUrl, { isAdmin: true });
const token = await login(api, owner);
const app = await api.expect(token, 201, '/apps', { method: 'POST', body: { code: 'search-bench', name: 'Search bench' } });
const phone = await api.expect(token, 201, `/apps/${app.id}/fields`, { method: 'POST', body: { code: 'phone', name: 'Phone', type: 'phone' } });
const version = (await api.expect(token, 201, `/apps/${app.id}/publish`, { method: 'POST' })).publishedSchemaVersion;

const db = new Client({ connectionString: dbUrl });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query(`
    INSERT INTO records (tenant_id, app_id, record_no, data, schema_version, created_by, updated_by)
    SELECT $1::uuid, $2::uuid, n, jsonb_build_object($3::text, '090' || lpad(n::text, 8, '0')), $4::int, $5::uuid, $5::uuid
    FROM generate_series(1, 100000) AS source(n)`,
    [owner.tenantId, app.id, phone.fieldId, version, owner.userId]);
  await db.query(`
    INSERT INTO record_search_values (tenant_id, app_id, record_id, field_id, kind, value)
    SELECT tenant_id, app_id, id, $3::uuid, kind, CASE kind WHEN 'phone' THEN data->>$3::text ELSE reverse(data->>$3::text) END
    FROM records CROSS JOIN (VALUES ('phone'), ('phone-reverse')) AS modes(kind)
    WHERE tenant_id = $1 AND app_id = $2`,
    [owner.tenantId, app.id, phone.fieldId]);
  await db.query('UPDATE app_counters SET last_value = 100000 WHERE tenant_id = $1 AND app_id = $2', [owner.tenantId, app.id]);
  await db.query('COMMIT');
  await db.query('ANALYZE records');
  await db.query('ANALYZE record_search_values');
} finally { await db.end(); }

async function measure(label, path, rounds = 40) {
  const times = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    const result = await api.expect(token, 200, path, {});
    if (i === 0 && String(result.count) === '0') throw new Error(label + ' returned no hits');
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
  return { label, rounds, p50Ms: Number(p50.toFixed(1)), p95Ms: Number(p95.toFixed(1)), maxMs: Number(times.at(-1).toFixed(1)) };
}

const exact = await measure('phone exact (full number)',
  `/apps/${app.id}/records/search?field=${phone.fieldId}&query=09000054321&mode=exact`);
const tail = await measure('phone tail (last 4)',
  `/apps/${app.id}/records/search?field=${phone.fieldId}&query=4321&mode=tail`);
console.log(JSON.stringify({ records: 100000, exact, tail, baselineP95Ms: 53 }, null, 2));
