import { and, eq, inArray, isNull, runtimeIndexes, sql, type TenantContext, type TenantTransaction } from '@suzubase/db';
import { boundedSortTypes, fieldContract, type FieldDefinition, type IndexPurpose } from '@suzubase/shared-types';
import { searchableKinds } from './search-projection';

export function supportsIndex(field: FieldDefinition, purpose: IndexPurpose) {
  switch (purpose) {
    case 'search': return searchableKinds(field).length > 0;
    case 'sort': return fieldContract[field.type].index && boundedSortTypes.has(field.type);
    case 'filter': return fieldContract[field.type].index;
  }
}

export function indexScope(context: TenantContext, appId: string) {
  return and(eq(runtimeIndexes.tenantId, context.tenantId), eq(runtimeIndexes.appId, appId));
}

export function indexJobScope(context: TenantContext, appId: string, id: string) {
  return and(indexScope(context, appId), eq(runtimeIndexes.id, id));
}

export async function retireChangedIndexes(tx: TenantTransaction, context: TenantContext, appId: string,
  previous: FieldDefinition[], next: FieldDefinition[]) {
  const target = new Map(next.map((field) => [field.fieldId, field]));
  const changed = previous.filter((field) => {
    const current = target.get(field.fieldId);
    return !current || current.type !== field.type || current.searchMode !== field.searchMode;
  }).map(({ fieldId }) => fieldId);
  if (!changed.length) return [];
  return tx.update(runtimeIndexes).set({
    retireRequested: sql`COALESCE(${runtimeIndexes.retireRequested}, clock_timestamp())`,
    retireReason: 'Field definition changed',
  }).where(and(indexScope(context, appId), isNull(runtimeIndexes.retiredAt), inArray(runtimeIndexes.fieldId, changed)))
    .returning({ id: runtimeIndexes.id, fieldId: runtimeIndexes.fieldId });
}
