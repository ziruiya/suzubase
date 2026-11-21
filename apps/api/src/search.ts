import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  and, eq, recordSearchValues, records, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { type FieldDefinition } from '@suzubase/shared-types';
import { z } from 'zod';
import { normalizeSearch, searchableKinds } from './search-projection';
import { RecordQueryService } from './record-query';
import { identifier, postgresErrorCode } from './validation';

export const searchInput = z.strictObject({
  field: identifier,
  query: z.string().trim().min(1).max(512).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
  mode: z.enum(['exact', 'prefix', 'tail']).default('exact'),
  view: identifier.optional(),
});

function upperPrefixBound(prefix: string) {
  const characters = [...prefix];
  while (characters.length) {
    const codePoint = characters.pop()!.codePointAt(0)!;
    if (codePoint === 0x10ffff) continue;
    const next = codePoint === 0xd7ff ? 0xe000 : codePoint + 1;
    return characters.join('') + String.fromCodePoint(next);
  }
  return undefined;
}

@Injectable()
export class SearchService {
  constructor(private readonly query: RecordQueryService) {}

  matchingRecords(tx: TenantTransaction, context: TenantContext, appId: string,
    fields: Pick<FieldDefinition, 'fieldId' | 'type' | 'searchMode'>[], input: z.infer<typeof searchInput>) {
    const field = fields.find(({ fieldId }) => fieldId === input.field);
    if (!field) throw new NotFoundException('无权限');
    const kinds = searchableKinds(field);
    const kind = input.mode === 'tail' ? 'phone-reverse' : kinds[0];
    if (!kind || !kinds.includes(kind) || (input.mode === 'prefix' && kind !== 'customer-id')) {
      throw new BadRequestException('Search mode is unavailable for this field');
    }
    const value = normalizeSearch(kind, input.query);
    if (!value || (kind === 'phone-reverse' && !/^[0-9]{4,}$/.test(value))) {
      throw new BadRequestException('Enter a valid search value. Phone suffixes require at least four digits.');
    }
    // LIKE is not leakproof in PostgreSQL, so RLS can prevent the planner from
    // turning it into an index range. The text_pattern_ops comparisons are
    // leakproof and use the same byte ordering as the projection index.
    const upper = input.mode === 'exact' ? undefined : upperPrefixBound(value);
    const filter = input.mode === 'exact' ? eq(recordSearchValues.value, value) : and(
      sql`${recordSearchValues.value} OPERATOR(pg_catalog.~>=~) ${value}`,
      upper === undefined ? undefined : sql`${recordSearchValues.value} OPERATOR(pg_catalog.~<~) ${upper}`,
    );
    return tx.select({ recordId: recordSearchValues.recordId }).from(recordSearchValues).where(and(
      eq(recordSearchValues.tenantId, context.tenantId), eq(recordSearchValues.appId, appId),
      eq(recordSearchValues.fieldId, input.field), eq(recordSearchValues.kind, kind), filter,
    )).as('matches');
  }

  async search(context: TenantContext, appId: string, input: z.infer<typeof searchInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        const scope = await this.query.scope(tx, context, appId, input.view);
        const matches = this.matchingRecords(tx, context, appId, scope.fields, input);
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
