import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  and, apps, eq, groupMembers, isNull, records, sql, TenantContext, TenantTransaction,
} from '@suzubase/db';
import { ViewCondition } from '@suzubase/shared-types';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';

@Injectable()
export class RecordQueryService {
  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService) {}

  condition(context: TenantContext, condition: ViewCondition) {
    const value = sql`(${records.data} ->> ${condition.fieldId}::text)`;
    switch (condition.operator) {
      case 'eq': return sql`${value} = ${condition.value}`;
      case 'ne': return sql`${value} <> ${condition.value}`;
      case 'empty': return sql`COALESCE(${value}, '') IN ('', '[]')`;
      case 'nonempty': return sql`COALESCE(${value}, '') NOT IN ('', '[]')`;
      case 'current-user': return sql`${value} = ${context.userId}`;
      case 'current-user-group': return sql`EXISTS (
        SELECT 1 FROM ${groupMembers}
        WHERE ${groupMembers.tenantId} = ${records.tenantId}
          AND ${groupMembers.userId} = ${context.userId}
          AND ${groupMembers.groupId}::text = ${value}
      )`;
    }
  }

  async scope(tx: TenantTransaction, context: TenantContext, appId: string, viewId?: string) {
    const [app] = await tx.select({ version: apps.publishedSchemaVersion })
      .from(apps).where(this.authorization.appScope(context, appId));
    if (!app) throw new NotFoundException();
    const configuration = await this.schema.getViews(tx, context, appId, app.version);
    const activeId = viewId ?? configuration.defaultId;
    const view = configuration.views.find(({ id }) => id === activeId);
    if (activeId && !view) throw new BadRequestException('Unknown published view');
    const fields = await this.schema.getFields(tx, context, appId, app.version);
    const sortField = fields.find(({ fieldId }) => fieldId === view?.sort?.fieldId);
    const sortValue = sortField && sql<string>`NULLIF(${records.data} ->> ${sortField.fieldId}::text, '')`;
    const numericSort = sortField?.type === 'number';
    const sort = numericSort ? sql`(${sortValue})::numeric` : sortValue;
    const descending = view?.sort?.direction === 'desc';
    const where = and(
      eq(records.tenantId, context.tenantId), eq(records.appId, appId), isNull(records.deletedAt),
      ...view?.conditions.map((condition) => this.condition(context, condition)) ?? [],
    );
    return { where, sort, sortValue, numericSort, descending, view, fields };
  }
}
