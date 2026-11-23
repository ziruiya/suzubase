const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { readFile, readdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { Client } = require('pg');
const { addField, configureRuntime, createApp, expectRequest, login, provision, publish } = require('./support.cjs');

configureRuntime();
const origin = process.env.TEST_API_URL ?? 'http://api:3000';
const execFileAsync = promisify(execFile);
const migrationsDir = resolve(__dirname, '../migrations');

async function dbQuery(sqlText, params, connectionString = process.env.ADMIN_DATABASE_URL) {
  const client = new Client({ connectionString });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

function withDatabase(connectionString, name) {
  const url = new URL(connectionString);
  url.pathname = '/' + name;
  return url.toString();
}

// ---------------------------------------------------------------------
// Part A: upgrade path. A database built at the pre-0050 shape (the
// first 50 journal entries applied by hand, drizzle bookkeeping rows
// inserted exactly as the migrator would) and seeded with old business
// data must survive the real migrate.js run to all 52 migrations with
// every record, file, reference and subtable row intact.
// ---------------------------------------------------------------------
test('P4-fix C4: pre-0050 database with business data upgrades to 52 migrations without loss', async () => {
  const journal = JSON.parse(await readFile(join(migrationsDir, 'meta/_journal.json'), 'utf8'));
  assert.equal(journal.entries.length, 52);
  const scratch = 'suzubase_p4fix_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const adminUrl = withDatabase(process.env.ADMIN_DATABASE_URL, scratch);
  const migrationUrl = withDatabase(process.env.MIGRATION_DATABASE_URL, scratch);
  const control = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await control.connect();
  await control.query(`CREATE DATABASE "${scratch}"`);
  try {
    // Role preamble mirrors dist/migrate.js (roles are cluster-global).
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const migrationPassword = new URL(process.env.MIGRATION_DATABASE_URL).password;
      const runtimePassword = process.env.RUNTIME_DATABASE_PASSWORD;
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'suzubase_migration')
        THEN CREATE ROLE suzubase_migration LOGIN PASSWORD '${migrationPassword}';
        ELSE ALTER ROLE suzubase_migration WITH LOGIN PASSWORD '${migrationPassword}'; END IF; END $$`);
      await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'suzubase_runtime')
        THEN CREATE ROLE suzubase_runtime LOGIN PASSWORD '${runtimePassword}';
        ELSE ALTER ROLE suzubase_runtime WITH LOGIN PASSWORD '${runtimePassword}'; END IF; END $$`);
      await admin.query('GRANT CREATE ON DATABASE ' + scratch + ' TO suzubase_migration');
      await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO suzubase_migration');
    } finally { await admin.end(); }

    // Apply journal entries 0..49 by hand as the migration user and
    // record the bookkeeping rows the migrator itself would have left.
    const mig = new Client({ connectionString: migrationUrl });
    await mig.connect();
    try {
      await mig.query('CREATE SCHEMA IF NOT EXISTS drizzle');
      await mig.query(`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
      assert.equal(files.length, 52);
      for (const entry of journal.entries.slice(0, 50)) {
        const file = files.find((name) => name.startsWith(entry.tag));
        assert.ok(file, entry.tag);
        const sqlText = await readFile(join(migrationsDir, file), 'utf8');
        for (const statement of sqlText.split('--> statement-breakpoint')) {
          const trimmed = statement.trim();
          if (trimmed) await mig.query(trimmed);
        }
        await mig.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [createHash('sha256').update(sqlText).digest('hex'), entry.when]);
      }
    } finally { await mig.end(); }

    // Seed old business data (superuser connection bypasses RLS).
    const tenantId = randomUUID(); const userId = randomUUID(); const appId = randomUUID();
    const titleId = randomUUID(); const docsId = randomUUID(); const linesId = randomUUID();
    const childSku = randomUUID(); const childProof = randomUUID();
    const rec1 = randomUUID(); const rec2 = randomUUID();
    const file1 = randomUUID(); const file2 = randomUUID(); const rowId = randomUUID();
    const sha = createHash('sha256').update('legacy-bytes').digest('hex');
    const rowData = { [childSku]: 'SKU-1', [childProof]: JSON.stringify([file2]) };
    const seed = new Client({ connectionString: adminUrl });
    await seed.connect();
    try {
      // apps <-> app_versions reference each other (published version
      // FK), so the seed must land in one transaction, exactly like the
      // application writes it.
      await seed.query('BEGIN');
      await seed.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'Legacy tenant']);
      await seed.query('INSERT INTO users (tenant_id, id, email, display_name) VALUES ($1, $2, $3, $4)',
        [tenantId, userId, 'legacy@example.jp', 'Legacy']);
      await seed.query('INSERT INTO tenant_members (tenant_id, user_id, is_admin) VALUES ($1, $2, true)',
        [tenantId, userId]);
      await seed.query('INSERT INTO apps (tenant_id, id, code, name, created_by) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, appId, 'legacy-app', 'Legacy app', userId]);
      await seed.query('INSERT INTO app_versions (tenant_id, app_id, version) VALUES ($1, $2, 1)',
        [tenantId, appId]);
      await seed.query(`INSERT INTO fields (tenant_id, app_id, field_id, introduced_in, code, name, type)
        VALUES ($1, $2, $3, 1, 'title', 'Title', 'text'), ($1, $2, $4, 1, 'docs', 'Docs', 'attachment')`,
        [tenantId, appId, titleId, docsId]);
      await seed.query(`INSERT INTO fields (tenant_id, app_id, field_id, introduced_in, code, name, type, "table")
        VALUES ($1, $2, $3, 1, 'lines', 'Lines', 'table', $4::jsonb)`,
        [tenantId, appId, linesId, JSON.stringify({ fields: [
          { fieldId: childSku, code: 'sku', name: 'SKU', type: 'text', required: true, uniqueValue: false, options: [] },
          { fieldId: childProof, code: 'proof', name: 'Proof', type: 'attachment', required: false, uniqueValue: false, options: [] },
        ], minRows: 0, maxRows: 25, addRows: true, deleteRows: true, reorderRows: true })]);
      await seed.query(`INSERT INTO records (tenant_id, app_id, id, record_no, data, schema_version, created_by, updated_by)
        VALUES ($1, $2, $3, 1, $4::jsonb, 1, $5, $5), ($1, $2, $6, 2, $7::jsonb, 1, $5, $5)`,
        [tenantId, appId, rec1, JSON.stringify({ [titleId]: 'one', [docsId]: JSON.stringify([file1]) }),
          userId, rec2, JSON.stringify({ [titleId]: 'two', [docsId]: '[]' })]);
      await seed.query(`INSERT INTO files (tenant_id, app_id, id, uploaded_by, name, content_type, bytes, sha256, state, reference_count)
        VALUES ($1, $2, $3, $4, 'one.pdf', 'application/pdf', 12, $5, 'ATTACHED', 1),
               ($1, $2, $6, $4, 'two.pdf', 'application/pdf', 12, $5, 'ATTACHED', 1)`,
        [tenantId, appId, file1, userId, sha, file2]);
      await seed.query('INSERT INTO file_references (tenant_id, app_id, record_id, field_id, file_id) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, appId, rec1, docsId, file1]);
      await seed.query(`INSERT INTO record_table_rows (tenant_id, app_id, record_id, field_id, row_id, row_order, data)
        VALUES ($1, $2, $3, $4, $5, 0, $6::jsonb)`,
        [tenantId, appId, rec1, linesId, rowId, JSON.stringify(rowData)]);
      await seed.query('COMMIT');
    } catch (error) {
      await seed.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await seed.end(); }

    // Run the real migrator against the scratch database.
    const { stdout } = await execFileAsync(process.execPath, [resolve(__dirname, '../dist/migrate.js')], {
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: adminUrl,
        MIGRATION_DATABASE_URL: migrationUrl,
      },
    });
    assert.match(stdout, /52 applied in total/);

    const check = new Client({ connectionString: adminUrl });
    await check.connect();
    try {
      const [{ n: migrationCount }] = (await check.query(
        'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows;
      assert.equal(migrationCount, 52);
      const records = (await check.query(
        'SELECT id, data FROM records WHERE tenant_id = $1 ORDER BY record_no', [tenantId])).rows;
      assert.equal(records.length, 2);
      assert.deepEqual(records[0].data, { [titleId]: 'one', [docsId]: JSON.stringify([file1]) });
      assert.deepEqual(records[1].data, { [titleId]: 'two', [docsId]: '[]' });
      const files = (await check.query(
        'SELECT id, state, reference_count, sha256 FROM files WHERE tenant_id = $1 ORDER BY name', [tenantId])).rows;
      assert.deepEqual(files.map(({ state, reference_count, sha256: digest }) =>
        ({ state, reference_count, digest })),
        [{ state: 'ATTACHED', reference_count: 1, digest: sha },
          { state: 'ATTACHED', reference_count: 1, digest: sha }]);
      const [{ n: refCount }] = (await check.query(
        'SELECT count(*)::int AS n FROM file_references WHERE tenant_id = $1', [tenantId])).rows;
      assert.equal(refCount, 1);
      const rows = (await check.query(
        'SELECT data FROM record_table_rows WHERE tenant_id = $1', [tenantId])).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].data, rowData);
      // The two new tables exist and start empty; old data untouched.
      const [{ n: catCount }] = (await check.query(
        'SELECT count(*)::int AS n FROM record_categories WHERE tenant_id = $1', [tenantId])).rows;
      assert.equal(catCount, 0);
      const [{ n: tfrCount }] = (await check.query(
        'SELECT count(*)::int AS n FROM table_file_references WHERE tenant_id = $1', [tenantId])).rows;
      assert.equal(tfrCount, 0);
      const [{ def }] = (await check.query(
        "SELECT pg_get_functiondef('public.purge_imported_app(uuid, uuid)'::regprocedure) AS def")).rows;
      assert.match(def, /DELETE FROM record_categories/);
      assert.match(def, /DELETE FROM table_file_references/);
    } finally { await check.end(); }
  } finally {
    await control.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await control.end();
  }
});

// ---------------------------------------------------------------------
// Part B: purge. Cancelling a staged import whose target app carries
// category assignments and subtable file references must leave zero
// residue in record_categories / table_file_references (and the other
// per-app tables) once purge_imported_app has run.
// ---------------------------------------------------------------------
async function raw(token, path, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: {
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(contentType && { 'Content-Type': contentType }),
    },
    body, signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: response.status, body: parsed, raw: text };
}

const KANTO = randomUUID(); const TOKYO = randomUUID();
const TREE = {
  enabled: true,
  nodes: [
    { id: KANTO, parentId: null, name: '関東', sortOrder: 0 },
    { id: TOKYO, parentId: KANTO, name: '東京', sortOrder: 0 },
  ],
};

test('P4-fix C4: cancelling a staged import purges categories and subtable file references', async () => {
  const source = await provision({ isAdmin: true });
  const sourceToken = await login(source);
  const app = await createApp(sourceToken, 'p4-fix-purge-src');
  const base = '/apps/' + app.id;
  const title = await addField(sourceToken, app.id, 'title', 'text');
  const docs = await addField(sourceToken, app.id, 'docs', 'attachment');
  const childSku = randomUUID(); const childProof = randomUUID();
  const lines = await expectRequest(201, base + '/fields', { token: sourceToken, method: 'POST', body: {
    code: 'lines', name: 'Lines', type: 'table',
    table: { fields: [
      { fieldId: childSku, code: 'sku', name: 'SKU', type: 'text', required: true, uniqueValue: false, options: [] },
      { fieldId: childProof, code: 'proof', name: 'Proof', type: 'attachment', required: false, uniqueValue: false, options: [] },
    ], minRows: 0, maxRows: 25, addRows: true, deleteRows: true, reorderRows: true },
  } });
  await publish(sourceToken, app.id);
  await expectRequest(200, base + '/draft/categories', { token: sourceToken, method: 'PUT', body: TREE });
  await publish(sourceToken, app.id);

  const uploadFile = async (name, label) => {
    const response = await fetch(new URL(`/apps/${app.id}/files?` + new URLSearchParams({
      name, type: 'application/pdf',
    }), origin), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sourceToken, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`), signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const recFile = await uploadFile('record.pdf', 'purge-record');
  const rowFile = await uploadFile('row.pdf', 'purge-row');
  await expectRequest(201, base + '/records', { token: sourceToken, method: 'POST', body: {
    data: {
      [title.fieldId]: 'Purge me',
      [docs.fieldId]: JSON.stringify([recFile.id]),
      [lines.fieldId]: JSON.stringify([
        { rowId: randomUUID(), data: { [childSku]: 'A-1', [childProof]: JSON.stringify([rowFile.id]) } },
      ]),
    },
    categoryIds: [TOKYO],
  } });

  const exportJob = await expectRequest(201, base + '/exports', { token: sourceToken, method: 'POST' });
  const sealed = await expectRequest(201, `${base}/exports/${exportJob.id}/run`, { token: sourceToken, method: 'POST' });
  assert.equal(sealed.status, 'sealed');
  const download = await fetch(new URL(`${base}/exports/${exportJob.id}/package`, origin), {
    headers: { Authorization: 'Bearer ' + sourceToken }, signal: AbortSignal.timeout(15000),
  });
  assert.equal(download.status, 200);
  const archive = Buffer.from(await download.arrayBuffer());

  const target = await provision({ isAdmin: true });
  const targetToken = await login(target);
  const uploaded = await raw(targetToken, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream',
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const job = uploaded.body;
  const validated = await expectRequest(201, `/imports/${job.id}/validate`, { token: targetToken, method: 'POST' });
  assert.equal(validated.status, 'staging');
  const issued = await expectRequest(201, `/imports/${job.id}/migration-token`, { token: targetToken, method: 'POST' });
  const run = await expectRequest(201, `/imports/${job.id}/run`, { token: issued.token, method: 'POST' });
  assert.equal(run.status, 'ready', JSON.stringify(run));
  const targetAppId = run.targetAppId;
  assert.ok(targetAppId);

  const countFor = (table) => dbQuery(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND app_id = $2`,
    [target.tenantId, targetAppId]).then((rows) => rows[0].n);
  // The staged target really carries the new-shape rows before purge.
  assert.ok(await countFor('record_categories') >= 1, 'staged categories must exist pre-purge');
  assert.ok(await countFor('table_file_references') >= 1, 'staged subtable references must exist pre-purge');
  assert.ok(await countFor('records') >= 1);
  assert.ok(await countFor('files') >= 2);

  await expectRequest(201, `/imports/${job.id}/cancel`, { token: targetToken, method: 'POST' });
  for (const table of ['records', 'files', 'record_categories', 'table_file_references',
    'record_table_rows', 'file_references', 'fields']) {
    assert.equal(await countFor(table), 0, `${table} must have zero residue after purge`);
  }
  const appsLeft = await dbQuery('SELECT count(*)::int AS n FROM apps WHERE tenant_id = $1 AND id = $2',
    [target.tenantId, targetAppId]);
  assert.equal(appsLeft[0].n, 0, 'the imported app row itself must be gone');
});

// ---------------------------------------------------------------------
// Part C: cleanup sharing. A file referenced by two records must
// survive cleanup until the last reference is released; repeated
// cleanup runs must be idempotent (no negative reference counts).
// ---------------------------------------------------------------------
test('P4-fix C4: cleanup never purges a still-referenced file and is idempotent', async () => {
  const { cleanupFiles } = require('../../../apps/api/dist/file-maintenance.js');
  const owner = await provision({ isAdmin: true });
  const token = await login(owner);
  const app = await createApp(token, 'p4-fix-cleanup');
  const base = '/apps/' + app.id;
  const title = await addField(token, app.id, 'title', 'text');
  const docs = await addField(token, app.id, 'docs', 'attachment');
  await publish(token, app.id);

  const response = await fetch(new URL(`/apps/${app.id}/files?` + new URLSearchParams({
    name: 'shared.pdf', type: 'application/pdf',
  }), origin), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('%PDF-1.4\nshared\n%%EOF\n'), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 201);
  const file = await response.json();
  const makeRecord = (name) => expectRequest(201, base + '/records', {
    token, method: 'POST',
    body: { data: { [title.fieldId]: name, [docs.fieldId]: JSON.stringify([file.id]) } },
  });
  const rec1 = await makeRecord('one');
  const rec2 = await makeRecord('two');
  const fileRow = () => dbQuery(
    'SELECT state, reference_count, purged_at FROM files WHERE tenant_id = $1 AND id = $2',
    [owner.tenantId, file.id]).then((rows) => rows[0]);
  assert.deepEqual(await fileRow(), { state: 'ATTACHED', reference_count: 2, purged_at: null });

  const context = { tenantId: owner.tenantId };
  const retention = { deletedHours: 0, temporaryHours: 0 };
  let result = await cleanupFiles(context, retention);
  assert.equal(result.purgedDeleted, 0, 'a twice-referenced file must survive cleanup');
  assert.equal((await fileRow()).reference_count, 2);

  const drop = (record) => expectRequest(200, base + '/records/' + record.id, {
    token, method: 'PUT',
    body: { data: { [title.fieldId]: 'x', [docs.fieldId]: '[]' }, revision: record.revision },
  });
  await drop(rec1);
  assert.deepEqual(await fileRow(), { state: 'ATTACHED', reference_count: 1, purged_at: null });
  result = await cleanupFiles(context, retention);
  assert.equal(result.purgedDeleted, 0, 'a once-referenced file must survive cleanup');

  await drop(rec2);
  assert.deepEqual(await fileRow(), { state: 'DELETED', reference_count: 0, purged_at: null });
  result = await cleanupFiles(context, retention);
  assert.equal(result.purgedDeleted, 1);
  const purged = await fileRow();
  assert.equal(purged.state, 'DELETED');
  assert.ok(purged.purged_at, 'purge timestamp recorded');
  result = await cleanupFiles(context, retention);
  assert.equal(result.purgedDeleted, 0, 'repeat cleanup must be a no-op');
  assert.equal((await fileRow()).reference_count, 0, 'reference count never goes negative');
});
