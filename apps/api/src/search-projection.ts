import { BadRequestException } from '@nestjs/common';
import { and, eq, recordSearchValues, type TenantContext, type TenantTransaction } from '@suzubase/db';
import type { FieldType, RecordResponse, TextSearchMode } from '@suzubase/shared-types';

export type SearchKind = TextSearchMode | 'phone' | 'phone-reverse' | 'email';

export function normalizeSearch(kind: SearchKind, value: string) {
  const normalized = value.normalize('NFKC');
  if (kind === 'phone' || kind === 'phone-reverse') {
    const digits = normalized.replace(/[\s()-]/g, '');
    if (!/^\+?[0-9]+$/.test(digits)) return '';
    return kind === 'phone-reverse' ? [...digits].reverse().join('') : digits;
  }
  if (kind === 'name' || kind === 'kana') return normalized.replace(/\s/gu, '').toLowerCase();
  if (kind === 'email') return normalized.toLowerCase();
  return normalized;
}

export function searchableKinds(field: { type: FieldType; searchMode: TextSearchMode | null }): SearchKind[] {
  if (field.type === 'phone') return ['phone', 'phone-reverse'];
  if (field.type === 'email') return ['email'];
  return field.searchMode ? [field.searchMode] : [];
}

export async function projectSearchValues(
    tx: TenantTransaction, context: TenantContext, record: RecordResponse,
    definitions: { fieldId: string; type: FieldType; searchMode: TextSearchMode | null }[],
  ) {
    const fields = definitions.map((field) => ({ ...field, kinds: searchableKinds(field) })).filter(({ kinds }) => kinds.length);
    const identity = { tenantId: context.tenantId, appId: record.appId, recordId: record.id };
    const rows = fields.flatMap(({ fieldId, kinds }) => kinds.flatMap((kind) => {
      const value = normalizeSearch(kind, record.data[fieldId] ?? '');
      if (Buffer.byteLength(value) > 1000) {
        throw new BadRequestException([{ field: fieldId, message: 'Searchable value is too long' }]);
      }
      return value ? [{ ...identity, fieldId, kind, value }] : [];
    }));
    await tx.delete(recordSearchValues).where(and(eq(recordSearchValues.tenantId, identity.tenantId),
      eq(recordSearchValues.appId, identity.appId), eq(recordSearchValues.recordId, identity.recordId)));
    if (rows.length) await tx.insert(recordSearchValues).values(rows);
  }

