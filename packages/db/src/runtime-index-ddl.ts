import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type { FieldType, IndexPurpose } from '@suzubase/shared-types';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const indexNumericPattern = '^[+-]?[0-9]{1,200}([.][0-9]{1,200})?$';

function checkedUuid(value: string) {
  if (!uuid.test(value)) throw new Error('Invalid index identity');
  return value;
}

type JobIdentity = { tenantId: string; appId: string; id: string };

export function runtimeIndexName(job: JobIdentity) {
  const identity = [job.tenantId, job.appId, job.id].map(checkedUuid).join(':');
  return 'sb_runtime_' + createHash('md5').update(identity).digest('hex');
}

interface IndexIdentity {
  id: string;
  tenantId: string;
  appId: string;
  fieldId: string;
  fieldType: FieldType;
  purpose: IndexPurpose;
}

function statement(job: IndexIdentity) {
  const name = runtimeIndexName(job);
  const tenant = checkedUuid(job.tenantId);
  const app = checkedUuid(job.appId);
  const field = checkedUuid(job.fieldId);
  const scope = `tenant_id = '${tenant}'::uuid AND app_id = '${app}'::uuid`;
  if (job.purpose === 'search') {
    return `CREATE INDEX CONCURRENTLY "${name}" ON public.record_search_values
      (kind, value text_pattern_ops, record_id) WHERE ${scope} AND field_id = '${field}'::uuid`;
  }
  const raw = `(data ->> '${field}'::text)`;
  let expression: string;
  if (job.purpose === 'sort') {
    expression = job.fieldType === 'number' ? `NULLIF(${raw}, '')::numeric` : `NULLIF(${raw}, '')`;
  } else if (job.purpose === 'filter') {
    expression = job.fieldType === 'number' ? `CASE WHEN ${raw} ~ '${indexNumericPattern}' THEN ${raw}::numeric END` : `md5(${raw})`;
  } else {
    throw new Error('Unknown index purpose');
  }
  return `CREATE INDEX CONCURRENTLY "${name}" ON public.records ((${expression}), record_no)
    WHERE ${scope} AND deleted_at IS NULL`;
}

// This connection is reserved for predeclared DDL and owns no tenant transaction.
export async function withIndexDdl<T>(connectionString: string, callback: (ddl: IndexDdl) => Promise<T>) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3000 });
  await client.connect();
  try {
    await client.query("SET search_path = pg_catalog, pg_temp");
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '10min'");
    await client.query("SET max_parallel_maintenance_workers = 0");
    const { rows: [{ acquired }] } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(540742014) AS acquired',
    );
    if (!acquired) return undefined;
    return await callback({
      async drop(job) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public."${runtimeIndexName(job)}"`);
      },
      async build(job) {
        await client.query(statement(job));
        const { rows: [{ bytes }] } = await client.query<{ bytes: string }>(
          'SELECT pg_relation_size($1::regclass)::text AS bytes', ['public.' + runtimeIndexName(job)],
        );
        return Number(bytes);
      },
    });
  } finally {
    await client.end();
  }
}

export interface IndexDdl {
  drop(job: JobIdentity): Promise<void>;
  build(job: IndexIdentity): Promise<number>;
}
