import { outbox, recordEvents, TenantContext, TenantTransaction } from '@suzubase/db';
import { FieldChange, RecordResponse } from '@suzubase/shared-types';

export async function writeRecordEvent(
  tx: TenantTransaction,
  context: TenantContext,
  record: RecordResponse,
  kind: 'created' | 'updated' | 'deleted' | 'restored',
  changes: FieldChange[],
): Promise<void> {
  const scope = { tenantId: context.tenantId, appId: record.appId };
  const [{ eventId }] = await tx.insert(recordEvents).values({
    ...scope, recordId: record.id, recordRevision: record.revision, schemaVersion: record.schemaVersion,
    actorId: context.userId, source: 'api', kind, changes,
  }).returning({ eventId: recordEvents.eventId });
  await tx.insert(outbox).values({ ...scope, eventId, topic: `record.${kind}` });
}
