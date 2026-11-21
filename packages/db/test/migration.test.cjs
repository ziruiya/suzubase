const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { Client } = require('pg');
const journal = require('../migrations/meta/_journal.json');

const run = promisify(execFile);

function databaseUrl(setting, database) {
  const url = new URL(process.env[setting]);
  url.pathname = `/${database}`;
  return url.toString();
}

test('all Drizzle migrations run from an empty PostgreSQL database and can be rerun', async (t) => {
  const database = `suzubase_empty_${randomBytes(6).toString('hex')}`;
  const control = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  const adminUrl = databaseUrl('ADMIN_DATABASE_URL', database);
  const migrationUrl = databaseUrl('MIGRATION_DATABASE_URL', database);
  const inspect = new Client({ connectionString: adminUrl });
  await control.connect();
  try {
    await control.query(`CREATE DATABASE ${database} TEMPLATE template0`);
    await inspect.connect();
    assert.equal((await inspect.query("SELECT to_regclass('public.records') AS name")).rows[0].name, null);
    for (const runNumber of [1, 2]) {
      const { stdout } = await run(process.execPath, [resolve(__dirname, '../dist/migrate.js')], {
        env: { ...process.env, ADMIN_DATABASE_URL: adminUrl, MIGRATION_DATABASE_URL: migrationUrl },
      });
      t.diagnostic(`Run ${runNumber} on ${runNumber === 1 ? 'empty' : 'migrated'} database\n${stdout.trim()}`);
      assert.equal(Number((await inspect.query('SELECT count(*) FROM drizzle.__drizzle_migrations')).rows[0].count),
        journal.entries.length);
    }
    const { rows } = await inspect.query(`
      SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname IN ('public', 'authentication')
      ORDER BY c.relname
    `);
    assert.deepEqual(rows.map(({ relname }) => relname), [
      'app_counters', 'app_versions', 'apps', 'auto_number_counters', 'csv_jobs', 'fields', 'file_references', 'files', 'group_members', 'issued_auto_numbers', 'login_credentials', 'member_groups', 'organizations', 'outbox', 'permission_audit',
      'record_create_keys', 'record_events', 'record_references', 'record_search_values', 'record_unique_values', 'records', 'tenant_members', 'tenants', 'users',
    ]);
    assert.ok(rows.every(({ relrowsecurity, owner }) => relrowsecurity && owner === 'suzubase_migration'));
  } finally {
    await inspect.end();
    try {
      await control.query(`DROP DATABASE IF EXISTS ${database}`);
    } finally {
      await control.end();
    }
  }
});
