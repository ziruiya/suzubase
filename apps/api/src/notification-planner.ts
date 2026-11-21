import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, outbox, records, workflowAssignments, type TenantContext, type TenantTransaction } from '@suzubase/db';
import { notificationPlaceholders, type AssigneeSource, type NotificationDelivery, type NotificationRule,
  type NotificationTrigger, type RecordResponse } from '@suzubase/shared-types';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { assignmentScope, resolveAssignees } from './workflow-data';

type Event = {
  source: 'api' | 'import';
  trigger: 'created' | 'updated' | 'workflow-action' | 'comment-created';
  schemaVersion: number;
  workflowActionId?: string;
  stateCode?: string;
  commentAuthor?: string;
  mentions?: string[];
};

@Injectable()
export class NotificationPlanner {
  constructor(private readonly schema: AppSchemaService, private readonly auth: AuthorizationService) {}

  async recordEvent(tx: TenantTransaction, context: TenantContext, record: RecordResponse, eventId: string, event: Event) {
    if (event.source === 'import') return;
    const { appId } = record;
    const scope = { tenantId: context.tenantId, appId, recordId: record.id };
    const { notificationRules } = await this.schema.getVersion(tx, context, appId, event.schemaVersion);
    const matches = (rule: NotificationRule) => {
      const trigger: NotificationTrigger = rule.trigger;
      if (trigger === 'mention') return Boolean(event.mentions?.length);
      if (trigger === 'workflow-state') return Boolean(event.stateCode) && rule.stateCode === event.stateCode;
      if (trigger !== event.trigger) return false;
      return trigger !== 'workflow-action' || !rule.actionId || rule.actionId === event.workflowActionId;
    };
    const rules = notificationRules.filter((rule) => rule.enabled && matches(rule));
    if (!rules.length && !event.mentions?.length) return;
    const where = and(eq(records.tenantId, scope.tenantId), eq(records.appId, appId), eq(records.id, scope.recordId), isNull(records.deletedAt));
    const definitions = await this.schema.getFields(tx, context, appId, event.schemaVersion);
    const types = new Map(definitions.map((field) => [field.fieldId, field.type]));
    const currentAssignees = rules.some((rule) => rule.recipients.some(({ kind }) => kind === 'assignees'))
      ? (await tx.select({ id: workflowAssignments.userId }).from(workflowAssignments)
        .where(and(assignmentScope(scope), eq(workflowAssignments.active, true)))).map(({ id }) => id)
      : [];
    const enriched = new Map<string, NotificationDelivery[]>();
    function add(userId: string, ruleKey: string, title: string, body: string) {
      const entries = enriched.get(userId) ?? [];
      entries.push({ userId, ruleKey, title, body });
      enriched.set(userId, entries);
    }
    for (const id of event.mentions ?? []) add(id, 'mention', 'You were mentioned', 'Open the record to view the comment.');
    for (const rule of rules) {
      if (rule.conditions.some(({ fieldId }) => !types.has(fieldId))) continue;
      if (rule.conditions.length) {
        const [matched] = await tx.select({ id: records.id }).from(records).where(and(where,
          ...rule.conditions.map((condition) => this.auth.condition(context, condition, types.get(condition.fieldId)))));
        if (!matched) continue;
      }
      const recipients = rule.recipients.flatMap((recipient): AssigneeSource[] => {
        if (recipient.kind === 'comment-author') return event.commentAuthor ? [{ kind: 'user', id: event.commentAuthor }] : [];
        if (recipient.kind === 'assignees') return [{ kind: 'previous' }];
        return ['id' in recipient ? recipient : { kind: 'creator' }];
      });
      const ids = await resolveAssignees(tx, scope.tenantId, record, recipients, currentAssignees);
      for (const id of ids) {
        if (rule.trigger === 'mention' && !event.mentions?.includes(id)) continue;
        add(id, rule.id, rule.title, rule.body);
      }
    }

    const deliveries: NotificationDelivery[] = [];
    for (const [userId, content] of enriched) {
      const recipient = { tenantId: scope.tenantId, userId };
      const permitted = await this.schema.access(tx, recipient, appId, 'view').catch((error: unknown) => {
        if (error instanceof NotFoundException) return undefined;
        throw error;
      });
      if (!permitted) continue;
      const [visible] = await tx.select({ data: this.auth.projection(permitted.access) }).from(records)
        .where(and(where, this.auth.recordScope(permitted.access, 'view')));
      if (!visible) continue;
      const render = (template: string, max: number) => {
        const characters = Array.from(template.replace(notificationPlaceholders, (_, fieldId: string) => visible.data[fieldId.toLowerCase()] ?? ''));
        return characters.slice(0, max).join('');
      };
      for (const notice of content) deliveries.push({
        ...notice, title: render(notice.title, 200).trim() || 'Record notification', body: render(notice.body, 4000),
      });
    }
    if (deliveries.length) await tx.update(outbox).set({ notifications: deliveries })
      .where(and(eq(outbox.tenantId, scope.tenantId), eq(outbox.appId, appId), eq(outbox.eventId, eventId)));
  }
}
