import {
  BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, appVersions, eq, isNull, notifications, records, sql, workflowActions, workflowDefinitions,
  withTenantTransaction, type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import { fieldContract, notificationPlaceholders, notificationTriggers, type NotificationRule } from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { normalizeValue } from './field-values';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { identifier, parseInput } from './validation';
import { conditions } from './view-input';
import { publishedWorkflowStates } from './workflow-graph';

const recipient = z.union([
  z.strictObject({ kind: z.enum(['user', 'organization', 'group', 'user-field']), id: identifier }),
  z.strictObject({ kind: z.enum(['creator', 'assignees', 'comment-author']) }),
]);
const template = (limit: number) => z.string().max(limit).refine((value) => !/[\x00\p{Surrogate}]/u.test(value));
const ruleInput = z.strictObject({
  id: identifier, enabled: z.boolean(), trigger: z.enum(notificationTriggers), actionId: identifier.optional(),
  stateCode: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  conditions, recipients: z.array(recipient).min(1).max(30), title: template(200).min(1), body: template(4000),
}).refine((rule) => (!rule.actionId || rule.trigger === 'workflow-action') &&
  (rule.trigger === 'workflow-state') === Boolean(rule.stateCode), { message: 'Select an action or state compatible with the trigger' });
const rulesInput = z.strictObject({ rules: z.array(ruleInput).max(50).refine((rules) => new Set(rules.map(({ id }) => id)).size === rules.length) });
const appFilter = z.strictObject({ appId: identifier.optional() });
const centerFilter = appFilter.extend({ after: identifier.optional(), read: z.enum(['read', 'unread']).optional() });
const noticeItem = z.object({
  id: identifier, appId: identifier, createdAt: z.string(), readAt: z.string().nullable(),
  appName: z.string(), title: z.string(), body: z.string(),
});
const centerReply = z.object({ items: z.array(noticeItem), next: identifier.nullable() });
export const notificationHttp = { ruleInput, rulesInput, appFilter, centerFilter, centerReply };

function own(context: TenantContext) {
  return and(eq(notifications.tenantId, context.tenantId), eq(notifications.userId, context.userId));
}

async function actionOptions(tx: TenantTransaction, context: TenantContext, appId: string) {
  return tx.selectDistinctOn([workflowActions.id], { id: workflowActions.id, name: workflowActions.name }).from(workflowActions)
    .innerJoin(workflowDefinitions, and(eq(workflowDefinitions.tenantId, workflowActions.tenantId),
      eq(workflowDefinitions.appId, workflowActions.appId), eq(workflowDefinitions.id, workflowActions.workflowId)))
    .where(and(eq(workflowActions.tenantId, context.tenantId), eq(workflowActions.appId, appId), eq(workflowDefinitions.status, 'published')))
    .orderBy(workflowActions.id, sql`${workflowDefinitions.version} DESC`);
}

@Injectable()
export class NotificationService {
  constructor(private readonly schema: AppSchemaService, private readonly auth: AuthorizationService) {}

  settings(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      const published = await this.schema.getVersion(tx, context, appId, app.publishedSchemaVersion);
      const draft = app.draftSchemaVersion && await this.schema.getVersion(tx, context, appId, app.draftSchemaVersion);
      return {
        published: published.notificationRules, draft: draft ? draft.notificationRules : null,
        actions: await actionOptions(tx, context, appId),
        states: await publishedWorkflowStates(tx, { tenantId: context.tenantId, appId }),
        directory: await this.schema.directoryOptions(tx, context, new Set(['user', 'organization', 'group'])),
      };
    });
  }

  save(context: TenantContext, appId: string, rules: NotificationRule[]) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      const fields = await this.schema.getFields(tx, context, appId, app.draftSchemaVersion ?? app.publishedSchemaVersion);
      const byId = new Map(fields.map((field) => [field.fieldId, field]));
      const states = new Set((await publishedWorkflowStates(tx, { tenantId: context.tenantId, appId })).map(({ code }) => code));
      const actions = new Set((await actionOptions(tx, context, appId)).map(({ id }) => id));
      for (const rule of rules) {
        if (rule.stateCode && !states.has(rule.stateCode) || rule.actionId && !actions.has(rule.actionId)) {
          throw new BadRequestException('Choose a published workflow action or state');
        }
        for (const text of [rule.title, rule.body]) {
          if (text.replace(notificationPlaceholders, '').includes('{{')) throw new BadRequestException('Use {{field_id}} template placeholders');
          for (const [, fieldId] of text.matchAll(notificationPlaceholders)) {
            if (!byId.has(fieldId.toLowerCase())) throw new BadRequestException('Template references an unknown field');
          }
        }
        for (const condition of rule.conditions) {
          const field = byId.get(condition.fieldId);
          if (!field || !fieldContract[field.type].filter ||
            condition.operator === 'current-user' && field.type !== 'user' ||
            condition.operator === 'current-user-group' && field.type !== 'group') {
            throw new BadRequestException('Unsupported notification condition');
          }
          if ('value' in condition) {
            const normalized = normalizeValue(field.type, condition.value, field.options);
            if (normalized === undefined) throw new BadRequestException('Invalid condition value');
            condition.value = normalized;
          }
        }
        for (const recipient of rule.recipients) {
          if (recipient.kind === 'user-field' && byId.get(recipient.id)?.type !== 'user') throw new BadRequestException('Choose a user field');
          if (recipient.kind === 'user' || recipient.kind === 'organization' || recipient.kind === 'group') {
            await this.auth.validateDirectorySubject(tx, context, { kind: recipient.kind, id: recipient.id });
          }
        }
      }
      const version = await this.schema.beginDraft(tx, context, app);
      await tx.update(appVersions).set({ notificationRules: rules }).where(and(
        eq(appVersions.tenantId, context.tenantId), eq(appVersions.appId, appId), eq(appVersions.version, version),
      ));
      return { rules };
    });
  }

  unread(context: TenantContext, appId?: string) {
    return withTenantTransaction(context, async (tx) => {
      const [result] = await tx.select({ count: sql<string>`count(*)::text` }).from(notifications)
        .where(and(own(context), isNull(notifications.readAt), appId ? eq(notifications.appId, appId) : undefined));
      return result;
    });
  }

  list(context: TenantContext, filters: z.infer<typeof centerFilter>) {
    return withTenantTransaction(context, async (tx) => {
      const scope = and(own(context), filters.appId ? eq(notifications.appId, filters.appId) : undefined,
        filters.read === 'read' ? sql`${notifications.readAt} IS NOT NULL` : filters.read === 'unread' ? isNull(notifications.readAt) : undefined);
      const [anchor] = filters.after ? await tx.select({ id: notifications.id, createdAt: notifications.createdAt })
        .from(notifications).where(and(scope, eq(notifications.id, filters.after))) : [];
      if (filters.after && !anchor) throw new BadRequestException('Invalid notification cursor');
      const limit = 30;
      const rows = await tx.select({
        id: notifications.id, appId: notifications.appId, recordId: notifications.recordId, appName: apps.name,
        title: notifications.title, body: notifications.body, readAt: notifications.readAt, createdAt: notifications.createdAt,
      }).from(notifications).innerJoin(apps, and(eq(apps.tenantId, notifications.tenantId), eq(apps.id, notifications.appId)))
        .where(and(scope, anchor ? sql`(${notifications.createdAt}, ${notifications.id}) < (${anchor.createdAt}::timestamptz, ${anchor.id}::uuid)` : undefined))
        .orderBy(sql`${notifications.createdAt} DESC, ${notifications.id} DESC`).limit(limit + 1);
      const page = rows.slice(0, limit);
      const items = [];
      const cache = new Map<string, Awaited<ReturnType<NotificationService['recordAccess']>>>();
      for (const { recordId, ...item } of page) {
        const key = item.appId + recordId;
        if (!cache.has(key)) cache.set(key, await this.recordAccess(tx, context, item.appId, recordId));
        items.push(cache.get(key) ? item : { ...item, appName: '', title: 'Notification', body: '' });
      }
      return { items, next: rows.length > limit ? page[limit - 1].id : null };
    });
  }

  read(context: TenantContext, id?: string, appId?: string) {
    return withTenantTransaction(context, async (tx) => {
      await tx.update(notifications).set({ readAt: sql`COALESCE(${notifications.readAt}, clock_timestamp())` })
        .where(and(own(context), id ? eq(notifications.id, id) : undefined,
          appId ? eq(notifications.appId, appId) : undefined, isNull(notifications.readAt)));
      return { read: true as const };
    });
  }

  open(context: TenantContext, id: string) {
    return withTenantTransaction(context, async (tx) => {
      const [link] = await tx.select({ appId: notifications.appId, recordId: notifications.recordId }).from(notifications)
        .where(and(own(context), eq(notifications.id, id)));
      if (!link || !await this.recordAccess(tx, context, link.appId, link.recordId)) throw new NotFoundException('无权限');
      await tx.update(notifications).set({ readAt: sql`COALESCE(${notifications.readAt}, clock_timestamp())` })
        .where(and(own(context), eq(notifications.id, id)));
      return link;
    });
  }

  private async recordAccess(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string) {
    const grant = await this.schema.access(tx, context, appId, 'view').catch((error: unknown) => {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    });
    if (!grant) return false;
    const [target] = await tx.select({ id: records.id }).from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, recordId), isNull(records.deletedAt),
      this.auth.recordScope(grant.access, 'view')));
    return Boolean(target);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller()
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get('apps/:appId/notification-rules')
  settings(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.notifications.settings(context, parseInput(identifier, appId));
  }
  @Put('apps/:appId/notification-rules')
  save(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.notifications.save(context, parseInput(identifier, appId), parseInput(rulesInput, body).rules);
  }
  @Get('notifications')
  list(@AuthenticatedTenant() context: TenantContext, @Query() query: unknown) {
    return this.notifications.list(context, parseInput(centerFilter, query));
  }
  @Get('notifications/unread')
  unread(@AuthenticatedTenant() context: TenantContext, @Query() query: unknown) {
    return this.notifications.unread(context, parseInput(appFilter, query).appId);
  }
  @Post('notifications/read-all')
  readAll(@AuthenticatedTenant() context: TenantContext, @Query() query: unknown) {
    return this.notifications.read(context, undefined, parseInput(appFilter, query).appId);
  }
  @Post('notifications/:id/read')
  read(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string) {
    return this.notifications.read(context, parseInput(identifier, id));
  }
  @Post('notifications/:id/open')
  open(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string) {
    return this.notifications.open(context, parseInput(identifier, id));
  }
}
