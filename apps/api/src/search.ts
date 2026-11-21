import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  and, eq, recordSearchValues, records, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { FieldType, RecordResponse, TextSearchMode } from '@suzubase/shared-types';
import { z } from 'zod';
import { RecordQueryService } from './record-query';
import { identifier, postgresErrorCode } from './validation';

export const searchInput = z.strictObject({
  field: identifier,
  query: z.string().trim().min(1).max(512).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
  mode: z.enum(['exact', 'prefix', 'tail']).default('exact'),
  view: identifier.optional(),
});

type SearchKind = TextSearchMode | 'phone' | 'phone-reverse' | 'email';

function normalize(kind: SearchKind, value: string) {
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

function searchableKinds(field: { type: FieldType; searchMode: TextSearchMode | null }): SearchKind[] {
  if (field.type === 'phone') return ['phone', 'phone-reverse'];
  if (field.type === 'email') return ['email'];
  return field.searchMode ? [field.searchMode] : [];
}

@Injectable()
export class SearchService {
  constructor(private readonly query: RecordQueryService) {}

  async project(
    tx: TenantTransaction, context: TenantContext, record: RecordResponse,
    definitions: { fieldId: string; type: FieldType; searchMode: TextSearchMode | null }[],
  ) {
    const fields = definitions.map((field) => ({ ...field, kinds: searchableKinds(field) })).filter(({ kinds }) => kinds.length);
    if (!fields.length) return;
    const identity = { tenantId: context.tenantId, appId: record.appId, recordId: record.id };
    const rows = fields.flatMap(({ fieldId, kinds }) => kinds.flatMap((kind) => {
      const value = normalize(kind, record.data[fieldId] ?? '');
      if (Buffer.byteLength(value) > 1000) {
        throw new BadRequestException([{ field: fieldId, message: 'Searchable value is too long' }]);
      }
      return value ? [{ ...identity, fieldId, kind, value }] : [];
    }));
    await tx.delete(recordSearchValues).where(and(eq(recordSearchValues.tenantId, identity.tenantId),
      eq(recordSearchValues.appId, identity.appId), eq(recordSearchValues.recordId, identity.recordId)));
    if (rows.length) await tx.insert(recordSearchValues).values(rows);
  }

  async search(context: TenantContext, appId: string, input: z.infer<typeof searchInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        const scope = await this.query.scope(tx, context, appId, input.view);
        const field = scope.fields.find(({ fieldId }) => fieldId === input.field);
        if (!field) throw new NotFoundException('无权限');
        const kinds = searchableKinds(field);
        const kind = input.mode === 'tail' ? 'phone-reverse' : kinds[0];
        if (!kind || !kinds.includes(kind) || (input.mode === 'prefix' && kind !== 'customer-id')) {
          throw new BadRequestException('Search mode is unavailable for this field');
        }
        const value = normalize(kind, input.query);
        if (!value || (kind === 'phone-reverse' && !/^[0-9]{4,}$/.test(value))) {
          throw new BadRequestException('Enter a valid search value. Phone suffixes require at least four digits.');
        }
        const pattern = value.replace(/[\\_%]/g, '\\$&') + '%';
        const filter = input.mode === 'exact' ? eq(recordSearchValues.value, value)
          : sql`${recordSearchValues.value} LIKE ${pattern}`;
        const matches = tx.select({ recordId: recordSearchValues.recordId }).from(recordSearchValues).where(and(
          eq(recordSearchValues.tenantId, context.tenantId), eq(recordSearchValues.appId, appId),
          eq(recordSearchValues.fieldId, input.field), eq(recordSearchValues.kind, kind), filter,
        )).as('matches');
        await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        const started = performance.now();
        // A single statement supplies both the count and its first page from one snapshot.
        const result = await tx.select({
          id: records.id, recordNo: sql<string>`${records.recordNo}::text`, data: scope.data,
          revision: records.revision, schemaVersion: records.schemaVersion,
          hitCount: sql<string>`count(*) OVER ()::text`,
        }).from(matches).innerJoin(records, and(eq(records.id, matches.recordId), scope.where))
          .orderBy(records.recordNo).limit(50);
        const databaseRoundTripMs = performance.now() - started;
        return {
          count: result[0]?.hitCount ?? '0',
          items: result.map(({ hitCount: _hitCount, ...record }) => record),
          ...(process.env.SEARCH_TIMING === '1' && { databaseRoundTripMs }),
        };
      });
    } catch (error) {
      if (postgresErrorCode(error) === '57014') throw new ServiceUnavailableException('Search timed out. Narrow the search and retry.');
      throw error;
    }
  }
}
