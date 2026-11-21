import {
  and, apps, eq, gt, IndexDdl, isNull, or, records, runtimeIndexName, runtimeIndexes, sql, TenantContext,
  TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import type { FieldDefinition } from '@suzubase/shared-types';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { preflightNormalize } from './schema-preflight';
import { normalizeSearch, searchableKinds } from './search-projection';
import { indexJobScope, supportsIndex } from './runtime-index-state';
import { postgresErrorCode } from './validation';

const schema = new AppSchemaService(new AuthorizationService());
const maxIndexBytes = 128 * 1024 * 1024;
const maxIndexRecords = 1_000_000;
const maxReportRows = 500;

type Job = typeof runtimeIndexes.$inferSelect;

async function preflight(tx: TenantTransaction, context: TenantContext, job: Job, field: FieldDefinition) {
  let after = 0n;
  let scanned = 0;
  let problemCount = 0;
  const problems: Job['problems'] = [];
  for (;;) {
    const rows = await tx.select({
      recordNo: records.recordNo, value: sql<unknown>`${records.data} -> ${job.fieldId}::text`,
    }).from(records).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, job.appId),
      isNull(records.deletedAt), gt(records.recordNo, after))).orderBy(records.recordNo).limit(2000);
    for (const { recordNo, value } of rows) {
      scanned++;
      let reason: string | undefined;
      if ((value === null || value === '') && field.required) reason = 'Required value is missing';
      else if (value !== null && value !== '' && (typeof value !== 'string' || preflightNormalize(field, value) !== value)) {
        reason = 'Value is incompatible with the published field type';
      } else if (typeof value === 'string' && job.purpose === 'search' &&
          searchableKinds(field).some((kind) => Buffer.byteLength(normalizeSearch(kind, value)) > 1000)) {
        reason = 'Search projection exceeds the storage limit';
      }
      if (reason) {
        problemCount++;
        if (problems.length < maxReportRows) {
          const display = typeof value === 'string' ? value : JSON.stringify(value);
          problems.push({ recordNo: recordNo.toString(), value: display?.slice(0, 512) ?? null, reason });
        }
      }
    }
    if (rows.length < 2000) break;
    after = rows[rows.length - 1].recordNo;
  }
  return { problems, problemCount, scanned };
}

async function requestIdleRetirements(tx: TenantTransaction, context: TenantContext) {
  const stats = sql`(SELECT last_idx_scan FROM pg_catalog.pg_stat_user_indexes
    WHERE schemaname = 'public' AND indexrelname = 'sb_runtime_' || md5(${runtimeIndexes.tenantId}::text || ':' || ${runtimeIndexes.appId}::text || ':' || ${runtimeIndexes.id}::text))`;
  await tx.update(runtimeIndexes).set({
    retireRequested: sql`now()`, retireReason: 'No recorded use for 90 days',
    lastUsedAt: stats,
  }).where(and(eq(runtimeIndexes.tenantId, context.tenantId), eq(runtimeIndexes.state, 'available'),
    isNull(runtimeIndexes.retiredAt), isNull(runtimeIndexes.retireRequested),
    sql`GREATEST(${runtimeIndexes.availableAt}, ${stats}) < now() - interval '90 days'`));
}

export async function runIndexJob(context: TenantContext, ddl: IndexDdl) {
  const work = await withTenantTransaction(context, async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    await requestIdleRetirements(tx, context);
    const [job] = await tx.select().from(runtimeIndexes).where(and(
      eq(runtimeIndexes.tenantId, context.tenantId), isNull(runtimeIndexes.retiredAt),
      or(eq(runtimeIndexes.state, 'building'), sql`${runtimeIndexes.retireRequested} IS NOT NULL`),
    )).orderBy(sql`${runtimeIndexes.retireRequested} ASC NULLS LAST`, runtimeIndexes.requestedAt).limit(1);
    if (!job) return;
    if (job.retireRequested) return { job, retire: true as const };
    const [app] = await tx.select({ version: apps.publishedSchemaVersion }).from(apps).where(and(
      eq(apps.tenantId, context.tenantId), eq(apps.id, job.appId), isNull(apps.deletedAt),
    ));
    const field = app && (await schema.getFields(tx, context, job.appId, app.version)).find(({ fieldId }) => fieldId === job.fieldId);
    if (!field || field.type !== job.fieldType || !supportsIndex(field, job.purpose)) {
      return { job, failureReason: 'Published field is no longer eligible for this index', problems: [], problemCount: 0 };
    }
    // A repeatable snapshot keeps full preflight bounded even while new records are written.
    const result = await preflight(tx, context, job, field);
    const failureReason = result.problemCount ? 'Data preflight failed' :
      result.scanned > maxIndexRecords ? 'Application exceeds the per-index record limit' : undefined;
    return { job, failureReason, ...result };
  });
  if (!work) return;
  const { job } = work;
  const scope = indexJobScope(context, job.appId, job.id);
  const save = (patch: Partial<typeof runtimeIndexes.$inferInsert>) => withTenantTransaction(context,
    (tx) => tx.update(runtimeIndexes).set(patch).where(and(scope, isNull(runtimeIndexes.retiredAt))));
  try {
    // Reconcile interrupted builds before issuing a new command for the same generated name.
    await ddl.drop(job);
    if (work.retire) {
      await save({ retiredAt: new Date().toISOString(), retireRequested: null, failureReason: null });
      return { index: runtimeIndexName(job), retired: true };
    }
    if (work.failureReason) {
      await save({ state: 'failed', failureReason: work.failureReason, problems: work.problems ?? [], problemCount: work.problemCount ?? 0 });
      return { index: runtimeIndexName(job), state: 'failed', reason: work.failureReason };
    }
    const bytes = await ddl.build(job);
    if (bytes > maxIndexBytes) {
      await ddl.drop(job);
      throw new Error('Index exceeds the per-index disk limit');
    }
    await save({ state: 'available', availableAt: new Date().toISOString(), failureReason: null, problems: [], problemCount: 0 });
    return { index: runtimeIndexName(job), state: 'available', bytes };
  } catch (error) {
    const reason = work.retire ? 'Retirement command failed' :
      error instanceof Error && error.message === 'Index exceeds the per-index disk limit' ? error.message : 'Concurrent index command failed';
    const code = postgresErrorCode(error);
    console.error(reason, { index: job.id, code });
    if (work.retire) {
      await save({ state: 'failed', failureReason: code ? reason + ' (' + code + ')' : reason });
    } else {
      await ddl.drop(job).catch((dropError) => console.error('Index reconciliation failed', { id: job.id, code: postgresErrorCode(dropError) }));
      await save({ state: 'failed', failureReason: code ? reason + ' (' + code + ')' : reason });
    }
    return { index: runtimeIndexName(job), state: 'failed', reason };
  }
}
