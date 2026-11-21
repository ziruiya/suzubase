import { resolve } from 'node:path';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

async function main() {
  const url = new URL(process.env.MIGRATION_DATABASE_URL!);
  const admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock(540742013)');
    for (const [role, password] of [
      ['suzubase_migration', decodeURIComponent(url.password)],
      ['suzubase_runtime', process.env.RUNTIME_DATABASE_PASSWORD],
    ]) {
      if (!password) throw new Error(`Missing password for ${role}`);
      const { rows: [{ statement }] } = await admin.query<{ statement: string }>(`
        SELECT format(
          '%s ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
          CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) THEN 'ALTER' ELSE 'CREATE' END,
          $1::text, $2::text
        ) AS statement
      `, [role, password]);
      await admin.query(statement);
    }
    const { rows: [{ statement }] } = await admin.query<{ statement: string }>(
      "SELECT format('GRANT CREATE ON DATABASE %I TO suzubase_migration', current_database()) AS statement",
    );
    await admin.query(statement);
    await admin.query('GRANT USAGE, CREATE ON SCHEMA public TO suzubase_migration');

    const owner = new Client({ connectionString: url.toString() });
    await owner.connect();
    try {
      const { rows: [db] } = await owner.query('SELECT current_database() AS database, current_user AS role');
      console.log(`Applying Drizzle migrations to ${db.database} as ${db.role}`);
      await migrate(drizzle(owner), { migrationsFolder: resolve(__dirname, '../migrations') });
      const { rows: [{ count }] } = await owner.query('SELECT count(*) FROM drizzle.__drizzle_migrations');
      console.log(`Drizzle migrations complete (${count} applied in total)`);
    } finally {
      await owner.end();
    }
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
