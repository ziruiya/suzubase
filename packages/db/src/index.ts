import { sql } from 'drizzle-orm';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { ApiTokenAction } from '@suzubase/shared-types';

export { and, eq, inArray, or, isNull, lte, gt, sql } from 'drizzle-orm';
export {
  apiTokens, apps, appCounters, autoNumberCounters, issuedAutoNumbers, appVersions, csvJobs, deploymentInstance, exportJobs, importJobs, migrationAuditLog, migrationTokens, permissionAudit, fields, fileReferences, files, outbox, recordCreateKeys, recordEvents, recordSearchValues, recordUniqueValues, records, recordReferences, recordTableRows, runtimeIndexes, type SourceIdMapRow,
  automationRules, automationRuleVersions, automationGrants, automationRuns, automationRunActions, automationSchedules,
  automationCadencePlans, automationCadenceSlots, automationDateBackfills,
  automationWebhookDeliveries, automationAuditEvents, automationProblemChains, type AutomationRuleConfig, type AutomationConditionOperator,
  notifications, recordComments, commentMentions,
  workflowDefinitions, workflowStates, workflowActions, recordWorkflowState, workflowAssignments, workflowEvents,
  groupMembers, loginCredentials, memberGroups, organizations, tenantMembers, tenants, users,
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
export async function verifyLogin(email: string, password: string): Promise<(TenantContext & { sessionVersion: number }) | undefined> {
  const result = await pool.query<{ tenantId: string; userId: string; sessionVersion: number }>(
    'SELECT tenant_id AS "tenantId", user_id AS "userId", session_version AS "sessionVersion" FROM authentication.verify_login($1, $2)',
    [email, password],
  );
  return result.rows[0];
}

export function apiTokenHash(token: string) {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

export async function verifyMigrationToken(token: string) {
  const result = await pool.query<TenantContext & { importJobId: string; targetAppId: string | null; expiresAt: string }>(
    'SELECT tenant_id AS "tenantId", user_id AS "userId", import_job_id AS "importJobId", target_app_id AS "targetAppId", expires_at AS "expiresAt" FROM authentication.verify_migration_token($1)',
    [apiTokenHash(token)],
  );
  return result.rows[0];
}

export async function verifyApiToken(token: string) {
  const result = await pool.query<TenantContext & { appId: string; actions: ApiTokenAction[] }>(
    'SELECT tenant_id AS "tenantId", user_id AS "userId", app_id AS "appId", actions FROM authentication.verify_api_token($1)',
    [apiTokenHash(token)],
  );
  return result.rows[0];
}

export async function withTenantTransaction<T>(
  tenantContext: TenantContext,
  callback: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  const { tenantId } = tenantContext;
  if (tenantId.length !== 36 || !uuid.test(tenantId)) throw new Error('Invalid tenant context');
  return db.transaction(async (transaction) => {
    // SET LOCAL does not accept bind parameters. Only a validated UUID becomes a SQL literal.
    await transaction.execute(sql.raw(`SET LOCAL suzubase.tenant_id = '${tenantId}'`));
    return callback(transaction);
  });
}

// Maintenance processes discover tenant identifiers, then use ordinary RLS transactions for all task data.
export async function maintenanceTenants() {
  const { rows } = await pool.query<{ tenantId: string }>('SELECT tenant_id AS "tenantId" FROM authentication.maintenance_tenants()');
  return rows.map(({ tenantId }) => Object.freeze({
    tenantId, userId: '00000000-0000-0000-0000-000000000000',
  }));
}

export { indexNumericPattern, runtimeIndexName, withIndexDdl, type IndexDdl } from './runtime-index-ddl';
