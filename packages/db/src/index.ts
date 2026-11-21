import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export { and, eq, isNull, lte, sql } from 'drizzle-orm';
export {
  apps, appCounters, appVersions, fields, outbox, recordCreateKeys, recordEvents, records, recordReferences,
  tenantMembers, tenants, users,
} from './schema';

export interface TenantContext {
  readonly tenantId: string;
  readonly userId: string;
}

export type TenantTransaction = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
  allowExitOnIdle: true,

});
const db = drizzle(pool);
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export async function checkDatabase(): Promise<void> {
  await pool.query('SELECT 1');
}

// This credential verifier returns an identity only after the password matches.
export async function verifyLogin(email: string, password: string): Promise<TenantContext | undefined> {
  const result = await db.execute<{ tenantId: string; userId: string }>(
    sql`SELECT tenant_id AS "tenantId", user_id AS "userId" FROM authentication.verify_login(${email}, ${password})`,
  );
  return result.rows[0];
}

export async function withTenantTransaction<T>(
  tenantContext: TenantContext,
  callback: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  const { tenantId } = tenantContext;
  if (!uuid.test(tenantId)) throw new Error('Invalid tenant context');
  return db.transaction(async (transaction) => {
    // SET LOCAL does not accept bind parameters. Only a validated UUID becomes a SQL literal.
    await transaction.execute(sql.raw(`SET LOCAL suzubase.tenant_id = '${tenantId}'`));
    return callback(transaction);
  });
}
