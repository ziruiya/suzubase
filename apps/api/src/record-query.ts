import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  and, eq, isNull, records, recordUniqueValues, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { fieldContract, AppAction, LookupConfiguration } from '@suzubase/shared-types';
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
