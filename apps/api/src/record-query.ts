import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  and, eq, gt, isNull, or, records, recordUniqueValues, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { fieldContract, AppAction, LookupConfiguration, ReferencePresentation } from '@suzubase/shared-types';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { uniqueKey } from './schema-preflight';
import { postgresErrorCode } from './validation';

@Injectable()
export class RecordQueryService {
  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService) {}

  async scope(tx: TenantTransaction, context: TenantContext, appId: string, viewId?: string, action: AppAction = 'view') {
    if (action !== 'view') await this.schema.access(tx, context, appId, action);
    const { app, fields: definitions, access } = await this.schema.access(tx, context, appId, 'view');
    const configuration = this.schema.visibleViews(await this.schema.getViews(tx, context, appId, app.publishedSchemaVersion), access);
    const activeId = viewId ?? configuration.defaultId;
    const view = configuration.views.find(({ id }) => id === activeId);
    if (activeId && !view) throw new BadRequestException('Unknown published view');
    const fields = definitions.filter(({ fieldId }) => this.authorization.fieldDecision(access, fieldId, 'view').allowed);
    const sortField = fields.find(({ fieldId }) => fieldId === view?.sort?.fieldId);
    const sortValue = sortField && sql<string>`NULLIF(${records.data} ->> ${sortField.fieldId}::text, '')`;
    const numericSort = sortField?.type === 'number';
    const sort = numericSort ? sql`(${sortValue})::numeric` : sortValue;
    const descending = view?.sort?.direction === 'desc';
    const where = and(
      eq(records.tenantId, context.tenantId), eq(records.appId, appId), isNull(records.deletedAt),
      this.authorization.recordScope(access, 'view'),
      ...view?.conditions.map((condition) => this.authorization.condition(context, condition, access.types.get(condition.fieldId))) ?? [],
    );
    return { where, sort, sortValue, numericSort, descending, view, fields, data: this.authorization.projection(access), access };
  }
  async lookupSource(tx: TenantTransaction, context: TenantContext, config: LookupConfiguration,
    match: { key: string } | { recordId: string },
  ) {
    const { fields, access } = await this.schema.access(tx, context, config.appId, 'view');
    const key = fields.find(({ fieldId }) => fieldId === config.keyFieldId);
    const ids = [config.keyFieldId, ...config.copies.map(({ sourceFieldId }) => sourceFieldId)];
    if (!key?.uniqueValue || ids.some((id) => !this.authorization.fieldDecision(access, id, 'view').allowed)) {
      throw new NotFoundException('无权限');
    }
    const scope = and(eq(records.tenantId, context.tenantId), eq(records.appId, config.appId),
      isNull(records.deletedAt), this.authorization.recordScope(access, 'view'));
    const query = tx.select({ id: records.id, revision: records.revision, data: this.authorization.projection(access) }).from(records);
    const [row] = 'recordId' in match
      ? await query.where(and(scope, eq(records.id, match.recordId)))
      : await query.innerJoin(recordUniqueValues, and(
        eq(recordUniqueValues.tenantId, records.tenantId), eq(recordUniqueValues.appId, records.appId),
        eq(recordUniqueValues.recordId, records.id), eq(recordUniqueValues.fieldId, config.keyFieldId),
        eq(recordUniqueValues.normalizedValue, uniqueKey(match.key)),
      )).where(scope);
    return row;
  }

  async referencePage(tx: TenantTransaction, context: TenantContext, appId: string, config: ReferencePresentation,
    match: { fieldId: string; value: string; prefix?: boolean }, limit: number, after?: string,
  ) {
    const { fields, access } = await this.schema.access(tx, context, appId, 'view');
    const visible = (id: string) => access.types.has(id) && this.authorization.fieldDecision(access, id, 'view').allowed;
    const predicates = [match.fieldId, ...config.conditions?.map(({ fieldId }) => fieldId) ?? []];
    if (config.sort) predicates.push(config.sort.fieldId);
    if (predicates.some((id) => !visible(id))) throw new NotFoundException('无权限');

    const display = [...new Set([...config.displayFieldIds ?? [], ...(match.prefix ? [match.fieldId] : [])])];
    const columns = fields.filter(({ fieldId }) => display.includes(fieldId) && visible(fieldId))
      .map(({ fieldId, name }) => ({ fieldId, name }));
    const raw = sql<string>`${records.data} ->> ${match.fieldId}::text`;
    const scope = and(eq(records.tenantId, context.tenantId), eq(records.appId, appId), isNull(records.deletedAt),
      this.authorization.recordScope(access, 'view'),
      match.prefix
        ? sql`length(${raw}) > 0 AND starts_with(lower(${raw}), lower(${match.value}))`
        : this.authorization.condition(context, { fieldId: match.fieldId, operator: 'eq', value: match.value }, access.types.get(match.fieldId)),
      ...config.conditions?.map((condition) => this.authorization.condition(context, condition, access.types.get(condition.fieldId))) ?? [],
    );
    const sortField = config.sort?.fieldId;
    const direction = config.sort?.direction === 'desc' ? sql`DESC` : sql`ASC`;
    const afterOperator = config.sort?.direction === 'desc' ? sql`<` : sql`>`;
    const sortText = sortField ? sql<string | null>`NULLIF(${records.data} ->> ${sortField}::text, '')` : undefined;
    const numericSort = sortField && access.types.get(sortField) === 'number';
    const sort = sortText && (numericSort ? sql`(${sortText})::numeric` : sortText);

    const afterNumber = after === undefined ? undefined : BigInt(after);
    let cursor = afterNumber === undefined ? undefined : gt(records.recordNo, afterNumber);
    if (cursor && sortText) {
      const [anchor] = await tx.select({ value: sortText }).from(records)
        .where(and(scope, eq(records.recordNo, afterNumber!)));
      if (!anchor) throw new BadRequestException('The reference page changed. Restart the search.');
      if (anchor.value === null) cursor = and(isNull(sort!), cursor);
      else {
        const value = numericSort ? sql`${anchor.value}::numeric` : sql`${anchor.value}`;
        cursor = or(isNull(sort!), sql`${sort} ${afterOperator} ${value}`, and(sql`${sort} = ${value}`, cursor));
      }
    }
    const projection = columns.length
      ? sql<Record<string, string>>`COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(${records.data})
          WHERE key IN (${sql.join(columns.map(({ fieldId }) => sql`${fieldId}`), sql`,`)})), '{}'::jsonb)`
      : sql<Record<string, string>>`'{}'::jsonb`;
    const rows = await tx.select({ recordNo: records.recordNo, data: projection })
      .from(records).where(and(scope, cursor))
      .orderBy(...sort ? [sql`${sort} ${direction} NULLS LAST`] : [], records.recordNo).limit(limit + 1);
    return {
      columns, items: rows.slice(0, limit).map(({ data }) => data),
      next: rows.length > limit ? rows[limit - 1].recordNo.toString() : null,
    };
  }

  async aggregate(context: TenantContext, appId: string, viewId: string | undefined, fieldIds: string[]) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        const { where, fields } = await this.scope(tx, context, appId, viewId);
        const numeric = new Set(fields.filter(({ type }) => fieldContract[type].aggregate).map(({ fieldId }) => fieldId));
        if (fieldIds.some((fieldId) => !numeric.has(fieldId))) {
          throw new BadRequestException('Only visible numeric fields support aggregation');
        }
        await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        const selections: Record<string, ReturnType<typeof sql<string | null>>> = { count: sql<string>`count(*)::text` };
        for (const [i, fieldId] of fieldIds.entries()) {
          const value = sql`NULLIF(${records.data} ->> ${fieldId}::text, '')::numeric`;
          selections['sum' + i] = sql<string | null>`sum(${value})::text`;
          selections['average' + i] = sql<string | null>`avg(${value})::text`;
        }
        const [row] = await tx.select(selections).from(records).where(where);
        return {
          count: row.count!,
          fields: fieldIds.map((fieldId, i) => ({ fieldId, sum: row['sum' + i], average: row['average' + i] })),
        };
      });
    } catch (error) {
      if (postgresErrorCode(error) === '57014') {
        throw new ServiceUnavailableException('Aggregation timed out. Narrow the view filters and retry.');
      }
      throw error;
    }
  }

}
