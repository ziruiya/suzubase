// G3-11 / decision 11: database upgrade drill.
// Reconstructs a Gate 2-era database (migrations 0000..0031 only), loads
// fixture-ish data, then applies ALL current migrations and verifies:
// data survives, the migrated schema matches the current journal, and the
// core tables are readable. Run inside a container/host with the repo built:
//   ADMIN_DATABASE_URL=... MIGRATION_DATABASE_URL=... RUNTIME_DATABASE_PASSWORD=... \
//     node tools/drills/db-upgrade-drill.mjs
// The scratch database is dropped at the end unless KEEP_DRILL_DB=1.
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = dbRequire('pg');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const migrationsDir = join(repoRoot, 'packages/db/migrations');
const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8'));
const GATE2_LAST = '0031_gate2_preflight';
const gate2Entries = journal.entries.filter((entry) => entry.tag <= GATE2_LAST);
if (gate2Entries.length === journal.entries.length) throw new Error('no post-Gate-2 migrations found; drill is meaningless');

const scratch = 'suzubase_upgrade_' + Math.random().toString(16).slice(2, 10);
const urlFor = (setting, db) => { const url = new URL(process.env[setting]); url.pathname = '/' + db; return url.toString(); };
const adminUrl = urlFor('ADMIN_DATABASE_URL', scratch);
const migrationUrl = urlFor('MIGRATION_DATABASE_URL', scratch);

const control = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
await control.connect();
const work = join(tmpdir(), scratch);
try {
  await control.query(`CREATE DATABASE ${scratch} TEMPLATE template0`);
  // Stage a Gate 2-only migrations folder (journal truncated to 0031).
  const staged = join(work, 'migrations');
  mkdirSync(join(staged, 'meta'), { recursive: true });
  for (const entry of gate2Entries) cpSync(join(migrationsDir, entry.tag + '.sql'), join(staged, entry.tag + '.sql'));
  cpSync(join(migrationsDir, 'meta/_journal.json'), join(staged, 'meta/_journal.json.tmp'));
  const stagedJournal = { ...journal, entries: gate2Entries };
  writeFileSync(join(staged, 'meta/_journal.json'), JSON.stringify(stagedJournal, null, 2));
  rmSync(join(staged, 'meta/_journal.json.tmp'), { force: true });
  for (const entry of gate2Entries) {
    const snapshot = join(migrationsDir, 'meta', entry.tag + '_snapshot.json');
    try { cpSync(snapshot, join(staged, 'meta', entry.tag + '_snapshot.json')); } catch { /* snapshot optional */ }
  }
  // migrate.js resolves its migrations folder relative to its own location
  // (dist/../migrations), so each phase runs from a scratch package layout:
  // <layout>/dist/migrate.js + <layout>/migrations, with NODE_PATH pointing
  // at the real package's node_modules.
  const migrateOnce = async (folder, label) => {
    const layout = join(work, 'layout-' + label);
    mkdirSync(join(layout, 'dist'), { recursive: true });
    cpSync(join(repoRoot, 'packages/db/dist/migrate.js'), join(layout, 'dist/migrate.js'));
    cpSync(folder, join(layout, 'migrations'), { recursive: true });
    const { stdout } = await run(process.execPath, [join(layout, 'dist/migrate.js')], {
      env: { ...process.env, ADMIN_DATABASE_URL: adminUrl, MIGRATION_DATABASE_URL: migrationUrl,
        NODE_PATH: join(repoRoot, 'packages/db/node_modules') },
      maxBuffer: 1024 * 1024 * 16,
    }).catch((error) => ({ stdout: String(error.stdout ?? '') + String(error.stderr ?? '') + '\nMIGRATE FAILED: ' + error.message }));
    return stdout;
  };
  let out = await migrateOnce(staged, 'gate2');
  const inspect = new Client({ connectionString: adminUrl });
  await inspect.connect();
  let applied = Number((await inspect.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).rows[0].n);
  if (applied !== gate2Entries.length) {
    throw new Error(`Gate 2 reconstruction applied ${applied}, expected ${gate2Entries.length}. Output: ${out.slice(-800)}`);
  }
  // Fixture-ish Gate 2-era data.
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  await inspect.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'Upgrade drill tenant']);
  await inspect.query('INSERT INTO users (tenant_id, id, email) VALUES ($1, $2, $3)', [tenantId, userId, 'drill@example.test']);
  await inspect.query('INSERT INTO tenant_members (tenant_id, user_id, can_create_apps, is_admin) VALUES ($1, $2, true, true)', [tenantId, userId]);
  const before = Number((await inspect.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).rows[0].n);
  await inspect.end();

  // Apply ALL current migrations (the real folder).
  out = await migrateOnce(migrationsDir, 'current');
  const check = new Client({ connectionString: adminUrl });
  await check.connect();
  const after = Number((await check.query('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).rows[0].n);
  const tenants = Number((await check.query('SELECT count(*) AS n FROM tenants WHERE id = $1', [tenantId])).rows[0].n);
  const gate3Tables = (await check.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('export_jobs', 'import_jobs', 'migration_audit_log')")).rows[0].n;
  await check.end();
  const result = { scratch, gate2Migrations: before, currentMigrations: after, journalTotal: journal.entries.length,
    tenantSurvived: tenants === 1, gate3Tables, ok: after === journal.entries.length && tenants === 1 && gate3Tables === 3 };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (process.env.KEEP_DRILL_DB !== '1') {
    await control.query(`DROP DATABASE IF EXISTS ${scratch}`).catch(() => undefined);
  }
  await control.end();
  rmSync(work, { recursive: true, force: true });
}
