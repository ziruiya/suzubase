import { outbox, recordEvents, recordWorkflowState, TenantContext, TenantTransaction } from '@suzubase/db';
import { workStateScope } from './workflow-data';
import { FieldChange, RecordData, RecordResponse } from '@suzubase/shared-types';

export interface EventCausation {
  rootCausationId: string;
  parentRunId: string;
  causationDepth: number;
  originRuleId: string;
  originActionId: string;
}

export async function writeRecordEvent(
  tx: TenantTransaction,
  context: TenantContext,
  record: RecordResponse,
  kind: 'created' | 'updated' | 'lookup-refetched' | 'deleted' | 'restored' | 'schema-migrated' | 'workflow-action' | 'workflow-reassigned' | 'WORKFLOW_REPAIR' | 'workflow-pool' | 'comment-created' | 'comment-deleted',
  changes: FieldChange[],
  source: 'api' | 'import' | 'migration' = 'api',
  object?: { type: 'comment'; id: string },
  causation?: EventCausation,
): Promise<string> {
  const scope = { tenantId: context.tenantId, appId: record.appId };
  const [{ eventId }] = await tx.insert(recordEvents).values({
    ...scope, recordId: record.id, recordRevision: record.revision, schemaVersion: record.schemaVersion,
    actorId: context.userId, source, kind, changes, snapshotData: record.data,
    objectType: object?.type ?? (kind.startsWith('workflow-') || kind === 'WORKFLOW_REPAIR' ? 'workflow' : 'record'),
    objectId: object?.id,
  }).returning({ eventId: recordEvents.eventId });
  if (kind !== 'created') await tx.update(recordWorkflowState).set({ revision: record.revision })
    .where(workStateScope({ ...scope, recordId: record.id }));
  if (kind !== 'WORKFLOW_REPAIR') await tx.insert(outbox).values({
    ...scope, eventId, topic: `record.${kind}`,
    rootCausationId: causation?.rootCausationId ?? eventId,
    parentRunId: causation?.parentRunId ?? null,
    causationDepth: causation?.causationDepth ?? 0,
    originRuleId: causation?.originRuleId ?? null,
    originActionId: causation?.originActionId ?? null,
  });
  return eventId;
}

export function fieldChanges(before: RecordData, after: RecordData): FieldChange[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: FieldChange[] = [];
  for (const fieldId of ids) {
    const oldPresent = Object.hasOwn(before, fieldId);
    const newPresent = Object.hasOwn(after, fieldId);
    const oldValue = oldPresent ? before[fieldId] : null;
    const newValue = newPresent ? after[fieldId] : null;
    if (oldPresent !== newPresent || oldValue !== newValue) {
      changes.push({
        fieldId, oldValue, newValue,
        ...(oldPresent && oldValue === null ? { oldPresent: true } : {}),
        ...(newPresent && newValue === null ? { newPresent: true } : {}),
      });
    }
  }
  return changes;
}

export function serializeRecord(row: Pick<typeof import('@suzubase/db').records.$inferSelect,
  'id' | 'appId' | 'recordNo' | 'data' | 'schemaVersion' | 'revision' | 'status' | 'createdBy' | 'createdAt' | 'updatedBy' | 'updatedAt'>): RecordResponse {
  const { id, appId, recordNo, data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt } = row;
  return { id, appId, recordNo: recordNo.toString(), data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt };
}
