import { outbox, recordEvents, TenantContext, TenantTransaction } from '@suzubase/db';
import { FieldChange, RecordData, RecordResponse } from '@suzubase/shared-types';

export async function writeRecordEvent(
  tx: TenantTransaction,
  context: TenantContext,
  record: RecordResponse,
  kind: 'created' | 'updated' | 'lookup-refetched' | 'deleted' | 'restored' | 'schema-migrated',
  changes: FieldChange[],
  source: 'api' | 'import' | 'migration' = 'api',
): Promise<void> {
  const scope = { tenantId: context.tenantId, appId: record.appId };
  const [{ eventId }] = await tx.insert(recordEvents).values({
    ...scope, recordId: record.id, recordRevision: record.revision, schemaVersion: record.schemaVersion,
    actorId: context.userId, source, kind, changes,
  }).returning({ eventId: recordEvents.eventId });
  await tx.insert(outbox).values({ ...scope, eventId, topic: `record.${kind}` });
}

export function fieldChanges(before: RecordData, after: RecordData): FieldChange[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: FieldChange[] = [];
  for (const fieldId of ids) {
    const oldValue = before[fieldId] ?? null;
    const newValue = after[fieldId] ?? null;
    if (oldValue !== newValue) changes.push({ fieldId, oldValue, newValue });
  }
  return changes;
}

export function serializeRecord(row: Pick<typeof import('@suzubase/db').records.$inferSelect,
  'id' | 'appId' | 'recordNo' | 'data' | 'schemaVersion' | 'revision' | 'status' | 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>): RecordResponse {
  const { id, appId, recordNo, data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt } = row;
  return { id, appId, recordNo: recordNo.toString(), data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt };
}
