import { and, eq, fileReferences, memberGroups, organizations, records, tenantMembers,
  type TenantContext, type TenantTransaction } from '@suzubase/db';
import { fieldContract, isRecordInput, multiOptionFieldTypes, notificationPlaceholders, optionFieldTypes, type AclConfiguration,
  type NotificationRule, type FieldDefinition, type FormLayout, type RecordData, type ViewCondition, type ViewConfiguration } from '@suzubase/shared-types';
import { z } from 'zod';
import { normalizeValue } from './field-values';
import { calculateFields, formulaProblems } from './formula';
import { normalizeSearch, searchableKinds } from './search-projection';
import { identifier } from './validation';
import { layoutWidths } from '@suzubase/shared-types';

export const formLayoutInput = z.array(z.strictObject({
  id: identifier,
  groupFieldId: identifier.optional(),
  cells: z.array(z.strictObject({ fieldId: identifier, width: z.literal(layoutWidths) })).min(1).max(4),
})).max(500);

export const migrationInput = z.strictObject({ incompatible: z.enum(['reject', 'clear-optional']).default('reject'), workflowAssignees: z.literal('administrator-pool').optional() });
export type MigrationStrategy = z.infer<typeof migrationInput>;

export function isDestructive(current: FieldDefinition[], next: FieldDefinition[]) {
  const byId = new Map(next.map((field) => [field.fieldId, field]));
  return current.some(({ fieldId, type, uniqueValue }) => {
    const target = byId.get(fieldId);
    return !target || target.type !== type || target.uniqueValue !== uniqueValue;
  }) || next.some(({ fieldId, uniqueValue }) => uniqueValue && !current.some((field) => field.fieldId === fieldId));
}

export function referencesPreflight(published: FieldDefinition[], draft: FieldDefinition[], views: ViewConfiguration,
  acl: AclConfiguration, titleFieldId: string | null, notificationRules: NotificationRule[] = []) {
  const old = new Map(published.map((field) => [field.fieldId, field]));
  const next = new Map(draft.map((field) => [field.fieldId, field]));
  const changed = (id: string) => !next.has(id) || (old.has(id) && old.get(id)!.type !== next.get(id)!.type);
  const invalidCondition = (condition: ViewCondition) => {
    if (changed(condition.fieldId)) return true;
    const field = next.get(condition.fieldId)!;
    return 'value' in condition && optionFieldTypes.has(field.type) &&
      normalizeValue(field.type, condition.value, field.options.map((option) => ({ ...option, disabled: false }))) === undefined;
  };
  const issues = formulaProblems(draft, published).map((problem) => ({ ...problem, dependency: 'formula' }));
  const add = (fieldId: string, dependency: string, objectId: string) =>
    issues.push({ fieldId, dependency, reason: objectId + ' references a removed or type-changed field' });
  for (const view of views.views) {
    for (const column of view.columns) {
      if (changed(column.fieldId)) add(column.fieldId, 'view-column', view.id);
    }
    for (const fieldId of view.aggregateFields ?? []) {
      const field = next.get(fieldId);
      if (!field || changed(fieldId) || !fieldContract[field.type].aggregate) add(fieldId, 'view-aggregate', view.id);
    }
    if (view.pastDateFieldId && changed(view.pastDateFieldId)) add(view.pastDateFieldId, 'view-overdue-date', view.id);
    if (view.sort && changed(view.sort.fieldId)) add(view.sort.fieldId, 'view-sort', view.id);
    for (const condition of view.conditions) {
      if (invalidCondition(condition)) add(condition.fieldId, 'view-filter', view.id);
    }
  }
  for (const rule of acl.field) {
    if (changed(rule.fieldId)) add(rule.fieldId, 'field-acl', rule.id);
  }
  for (const rule of acl.record) {
    if (rule.subject.kind.endsWith('-field') && changed(rule.subject.id)) add(rule.subject.id, 'record-acl-subject', rule.id);
    for (const condition of rule.conditions) {
      if (invalidCondition(condition)) add(condition.fieldId, 'record-acl-condition', rule.id);
    }
  }
  for (const rule of notificationRules) {
    for (const condition of rule.conditions) {
      if (invalidCondition(condition)) add(condition.fieldId, 'notification-condition', rule.id);
    }
    for (const recipient of rule.recipients) {
      if (recipient.kind === 'user-field' && (changed(recipient.id) || next.get(recipient.id)?.type !== 'user')) {
        add(recipient.id, 'notification-recipient', rule.id);
      }
    }
    for (const [, fieldId] of (rule.title + '\n' + rule.body).matchAll(notificationPlaceholders)) {
      if (changed(fieldId.toLowerCase())) add(fieldId.toLowerCase(), 'notification-template', rule.id);
    }
  }
  if (titleFieldId && changed(titleFieldId)) add(titleFieldId, 'title', 'App title');
  for (const field of draft) {
    const scope = field.autoNumber?.scopeFieldId;
    if (scope && changed(scope)) add(scope, 'automatic-number', field.fieldId);
  }
  return issues;
}

export function validLayout(layout: FormLayout, definitions: FieldDefinition[]) {
  const byId = new Map(definitions.map((field) => [field.fieldId, field]));
  const ids = layout.flatMap(({ cells }) => cells.map(({ fieldId }) => fieldId));
  return new Set(layout.map(({ id }) => id)).size === layout.length && new Set(ids).size === ids.length &&
    layout.every(({ groupFieldId, cells }) => (!groupFieldId ||
      byId.get(groupFieldId)?.layoutElement?.kind === 'group' && !ids.includes(groupFieldId)) &&
      cells.every(({ fieldId }) => byId.has(fieldId)) && cells.reduce((sum, { width }) => sum + width, 0) <= 12);
}

export function withoutLayoutField(layout: FormLayout, fieldId: string) {
  return layout.map(({ groupFieldId, cells, id }) => ({
    id, ...(groupFieldId && groupFieldId !== fieldId && { groupFieldId }),
    cells: cells.filter((cell) => cell.fieldId !== fieldId),
  })).filter(({ cells }) => cells.length);
}

function empty(field: FieldDefinition, value: string | undefined) {
  return !value || (value === '[]' && (multiOptionFieldTypes.has(field.type) || field.type === 'attachment'));
}

export function preflightNormalize(field: FieldDefinition, value: string) {
  if (field.type === 'attachment') {
    try {
      const ids = z.array(identifier).max(25).safeParse(JSON.parse(value));
      return ids.success ? value : undefined;
    } catch {
      return undefined;
    }
  }
  // Historical selections remain valid when an option is deactivated.
  return normalizeValue(field.type, value, field.options.map((option) => ({ ...option, disabled: false })));
}

export function uniqueKey(value: string) {
  return value.normalize('NFKC').toLowerCase();
}

export async function dataPreflight(tx: TenantTransaction, context: TenantContext, appId: string,
  previous: FieldDefinition[], next: FieldDefinition[], destructive: boolean, strategy?: MigrationStrategy, recalculate = true) {
  const scope = and(eq(records.tenantId, context.tenantId), eq(records.appId, appId));
  const previousById = new Map(previous.map((field) => [field.fieldId, field]));
  const nextIds = new Set(next.map(({ fieldId }) => fieldId));
  const targets = next.filter((field) => {
    const old = previousById.get(field.fieldId);
    return isRecordInput(field.type) && (old ? destructive || field.required && !old.required : field.required);
  });
  const rows = targets.length || destructive ? await tx.select().from(records).where(scope).orderBy(records.recordNo) : [];
  const directoryTypes = new Set(targets.filter(({ type, fieldId }) => type !== previousById.get(fieldId)?.type)
    .map(({ type }) => type));
  const directory = {
    user: directoryTypes.has('user') ? new Set((await tx.select({ id: tenantMembers.userId }).from(tenantMembers)
      .where(eq(tenantMembers.tenantId, context.tenantId))).map(({ id }) => id)) : undefined,
    group: directoryTypes.has('group') ? new Set((await tx.select({ id: memberGroups.id }).from(memberGroups)
      .where(eq(memberGroups.tenantId, context.tenantId))).map(({ id }) => id)) : undefined,
    organization: directoryTypes.has('organization') ? new Set((await tx.select({ id: organizations.id }).from(organizations)
      .where(eq(organizations.tenantId, context.tenantId))).map(({ id }) => id)) : undefined,
  };
  const issues: { recordNo: string; fieldId: string; field: string; value: string | null; reason: string }[] = [];
  const repaired: typeof issues = [];
  const reserved = new Map<string, string>();
  const plan = [];
  for (const row of rows) {
    const data: RecordData = { ...row.data };
    const archive: RecordData = { ...row.archivedData };
    for (const [id, value] of Object.entries(data)) {
      if (!nextIds.has(id)) {
        archive[id] = value;
        delete data[id];
      }
    }
    for (const field of targets) {
      const { fieldId, name, type } = field;
      const original = row.data[fieldId];
      const old = previousById.get(fieldId);
      const raw: unknown = original;
      const unexpectedType = raw !== undefined && typeof raw !== 'string';
      const valueIsEmpty = !unexpectedType && empty(field, original);
      let value = valueIsEmpty || unexpectedType ? undefined : preflightNormalize(field, original!);
      const directoryIds = directory[type as keyof typeof directory];
      if (type !== old?.type && directoryIds && value && !directoryIds.has(value)) value = undefined;
      if (value && type !== old?.type && type === 'attachment') {
        // Links for ordinary writes must be established through FileService.
        const [matching] = await tx.select({ fieldId: fileReferences.fieldId }).from(fileReferences).where(and(
          eq(fileReferences.tenantId, context.tenantId), eq(fileReferences.appId, appId),
          eq(fileReferences.recordId, row.id), eq(fileReferences.fieldId, fieldId),
        )).limit(1);
        if (!matching) value = undefined;
      }
      const recordNo = row.recordNo.toString();
      const key = field.uniqueValue && !row.deletedAt && value ? fieldId + ':' + uniqueKey(value) : undefined;
      const conflict = key && reserved.get(key);
      const searchTooLarge = Boolean(value) && searchableKinds(field).some((kind) =>
        Buffer.byteLength(normalizeSearch(kind, value!)) > 1000);
      const reason = field.required && !value && valueIsEmpty ? 'required'
        : !value && !valueIsEmpty ? 'incompatible value'
        : searchTooLarge ? 'search projection is too long'
        : key && Buffer.byteLength(uniqueKey(value!)) > 1000 ? 'unique value is too long'
        : conflict ? 'duplicate unique value' : undefined;
      if (reason) {
        const item = { recordNo, fieldId, field: name, value: unexpectedType ? JSON.stringify(raw) : original ?? null, reason };
        if (destructive && strategy?.incompatible === 'clear-optional' && !field.required) {
          delete data[fieldId];
          repaired.push(item);
        } else issues.push(item);
      } else if (value) {
        if (key) reserved.set(key, recordNo);
        if (destructive) data[fieldId] = value;
      } else if (destructive) {
        if (type !== old?.type) delete data[fieldId];
      }
    }
    if (destructive) {
      for (const field of next) {
        if (field.type === 'calculation') delete data[field.fieldId];
        if ((field.type === 'layout' || field.type === 'autoNumber') && previousById.get(field.fieldId)?.type !== field.type) {
          delete data[field.fieldId];
        }
      }
      if (recalculate) calculateFields(next, data);
      plan.push({ row, data, archive });
    }
  }
  return { issues, repaired, plan };
}
