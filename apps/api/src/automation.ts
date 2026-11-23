import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, automationAuditEvents, automationCadencePlans, automationCadenceSlots, automationDateBackfills, automationGrants, automationRuleVersions, automationRunActions, automationRuns,
  automationRules, automationProblemChains, automationSchedules, eq, groupMembers, inArray, isNull, notifications, outbox, records, sql, tenantMembers, TenantContext, TenantTransaction, withTenantTransaction, workflowAssignments,
  type AutomationRuleConfig,
} from '@suzubase/db';
import {
  dateRelativeDueAt, dateRelativeScheduleKey, enumerateSlots, isIsoDate, isValidLocalTime, isValidTimezone, isoDateInZone, nextSlotAfter,
  type DateRelativeConfig, type FixedScheduleConfig, type ScheduleSlot,
} from './automation-schedule';
import { fieldContract, multiOptionFieldTypes, type FieldDefinition, type RecordData, type RecordResponse } from '@suzubase/shared-types';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { normalizeValue } from './field-values';
import { serializeRecord } from './record-events';
import { RecordService } from './records';
import { WorkflowRuntimeService } from './workflow-runtime';
import { randomUUID } from 'node:crypto';
import { identifier, parseInput } from './validation';

const eventTypes = ['record.created', 'record.updated', 'record.deleted', 'workflow.transitioned', 'workflow.rejected', 'schedule.fixed', 'schedule.dateRelative'] as const;

const fixedSchedule = z.strictObject({
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  localTime: z.string(),
  timezone: z.string().min(1).max(100),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  monthDay: z.number().int().min(1).max(31).optional(),
  missedRunPolicy: z.enum(['skip', 'catch_up_latest']).optional(),
});
const dateRelativeSchedule = z.strictObject({
  source: z.enum(['field', 'createdAt']),
  fieldId: identifier.optional(),
  offsetDays: z.number().int().min(-3650).max(3650),
  localTime: z.string(),
  timezone: z.string().min(1).max(100),
});
export const AUTOMATION_TENANT_RUN_RATE_LIMIT = 100;
export const AUTOMATION_TENANT_RUN_RATE_WINDOW_MS = 60_000;
export const AUTOMATION_TENANT_PENDING_LIMIT = 1_000;
export const AUTOMATION_PROBLEM_CHAIN_FAILURE_LIMIT = 3;
// P3-C C-3: guardrail audit rows (RATE_LIMITED / BACKLOG_LIMITED) are
// throttled per (tenant, app, rule, action): the first row in each window
// is always written; repeats inside the window are suppressed so a
// sustained limit cannot flood the append-only audit table. The signal is
// not lost -- the triggering event stays unprocessed and a later pass
// outside the window writes a fresh row.
export const AUTOMATION_GUARDRAIL_AUDIT_WINDOW_MS = 60_000;

// P3-C fixed cadence (T-3): one pass claims at most this many candidate
// records per slot; the remainder continues from the slot checkpoint on
// the next pass and is never discarded.
export const AUTOMATION_SCHEDULE_BATCH_LIMIT = 1_000;
// A claimed plan/slot whose worker died becomes resumable after this
// lease; run idempotency keys make resumption duplicate-safe.
export const AUTOMATION_SCHEDULE_CLAIM_LEASE_MS = 5 * 60_000;
// A due slot processed within this window of its scheduled instant is
// on time (the worker polls every 60s, so normal lateness is ~1 minute).
// A slot first seen later than this is "missed": the missed-run policy
// decides between skipping it and one controlled catch-up.
export const AUTOMATION_SCHEDULE_ON_TIME_GRACE_MS = 15 * 60_000;
// Due-plan backlog above this count alerts tenant admins (SYSTEM
// notification + audit row, throttled to one alert per day per tenant).
export const AUTOMATION_SCHEDULE_BACKLOG_ALERT_THRESHOLD = 100;

// P3-C date-relative (T-3 lower half): brief 3.2 late window -- a plan
// executed within 24 ACTUAL hours of its due_at (UTC) is a late
// execution (marked LATE); past the window the plan is MISSED and never
// executes. The 24h window itself is the brief's explicit contract and
// is NOT the fixed-cadence 15-minute grace; the grace is reused here
// only to classify the boundary between an on-time execution and a
// late one (the worker polls every 60s, so without a grace every
// normal execution would be "late" and SUCCEEDED unreachable).
export const AUTOMATION_DATE_RELATIVE_LATE_WINDOW_MS = 24 * 3_600_000;
// Aggregated MISSED alerting: at or above this many plans marked MISSED
// in one pass, tenant admins get ONE summary SYSTEM notification (daily
// dedup) instead of one message per missed plan.
export const AUTOMATION_DATE_RELATIVE_MISSED_ALERT_THRESHOLD = 100;

// P3-C C-0 (option a): maintenanceTenants() contexts carry the nil UUID as
// userId; that identity is not a tenant member, so audit rows written from
// such a context must not claim it as actor. System actions are recorded
// with actor_id NULL and actor_type 'SYSTEM' (migration 0043); every other
// context keeps its real member actor with actor_type 'USER'.
export const SYSTEM_ACTOR_USER_ID = '00000000-0000-0000-0000-000000000000';
export function auditActor(context: TenantContext): { actorId: string | null; actorType: 'USER' | 'SYSTEM' } {
  return context.userId === SYSTEM_ACTOR_USER_ID
    ? { actorId: null, actorType: 'SYSTEM' }
    : { actorId: context.userId, actorType: 'USER' };
}

export function automationUpdateNeeded(currentValue: unknown, targetValue: unknown) {
  if (Object.is(currentValue, targetValue)) return false;
  if (typeof currentValue === 'object' && typeof targetValue === 'object' && currentValue !== null && targetValue !== null) {
    return JSON.stringify(currentValue) !== JSON.stringify(targetValue);
  }
  return true;
}
const condition = z.strictObject({
  fieldId: identifier,
  operator: z.enum(['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_contains', 'empty', 'nonempty',
    'in', 'contains_any', 'contains_all', 'changed_to']),
  value: z.unknown().optional(),
});
const conditionGroup = z.strictObject({
  operator: z.enum(['and', 'or']).default('and'),
  groups: z.array(z.strictObject({ conditions: z.array(condition).max(50) })).max(50),
});
const config = z.strictObject({
  schemaVersion: z.literal(1),
  trigger: z.strictObject({
    eventType: z.enum(eventTypes),
    fieldId: identifier.optional(),
    oldValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    fromStateId: identifier.optional(),
    toStateId: identifier.optional(),
    allowManual: z.boolean().optional(),
    schedule: fixedSchedule.optional(),
    dateRelative: dateRelativeSchedule.optional(),
  }),
  conditions: z.strictObject({
    eventSnapshot: conditionGroup,
    currentState: conditionGroup,
  }),
  actions: z.array(z.strictObject({
    actionId: identifier,
    type: z.enum(['NOTIFY', 'UPDATE_FIELDS', 'CREATE_RECORD', 'ADVANCE_WORKFLOW', 'WEBHOOK']),
    targetAppId: identifier.optional(),
    targetFieldIds: z.array(identifier).max(100).optional(),
    notify: z.strictObject({
      recipientUserIds: z.array(identifier).max(100).optional(),
      recipientGroupIds: z.array(identifier).max(50).optional(),
      recipientFieldId: identifier.optional(),
      recipientAssignee: z.boolean().optional(),
      title: z.string().max(200).optional(),
      body: z.string().max(2000).optional(),
    }).optional(),
    updates: z.array(z.strictObject({
      fieldId: identifier,
      mode: z.enum(['set', 'increment', 'decrement', 'clear', 'copy']),
      value: z.unknown().optional(),
      sourceFieldId: identifier.optional(),
    })).max(100).optional(),
    mappings: z.array(z.strictObject({
      targetFieldId: identifier,
      mode: z.enum(['constant', 'source']),
      value: z.unknown().optional(),
      sourceFieldId: identifier.optional(),
    })).max(100).optional(),
    workflowActionId: identifier.optional(),
  })).max(50).refine((actions) => new Set(actions.map(({ actionId }) => actionId)).size === actions.length),
}).superRefine((value, ctx) => {
  const { trigger } = value;
  if (trigger.fieldId && trigger.eventType !== 'record.updated') {
    ctx.addIssue({ code: 'custom', message: 'Field-change selectors are only valid for record updates' });
  }
  if ((('oldValue' in trigger && trigger.oldValue !== undefined) || ('newValue' in trigger && trigger.newValue !== undefined)) && !trigger.fieldId) {
    ctx.addIssue({ code: 'custom', message: 'Field-change value constraints require a field' });
  }
  if (trigger.eventType.startsWith('workflow.') && !trigger.toStateId) {
    ctx.addIssue({ code: 'custom', message: 'Workflow triggers require a target state' });
  }
  if (trigger.eventType === 'schedule.fixed') {
    if (!trigger.schedule) {
      ctx.addIssue({ code: 'custom', message: 'Fixed-schedule triggers require a schedule configuration' });
    } else {
      const schedule = trigger.schedule;
      if (trigger.fieldId || trigger.fromStateId || trigger.toStateId ||
        'oldValue' in trigger && trigger.oldValue !== undefined || 'newValue' in trigger && trigger.newValue !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'Fixed-schedule triggers do not take event selectors' });
      }
      if (!isValidLocalTime(schedule.localTime)) {
        ctx.addIssue({ code: 'custom', message: 'Schedule localTime must be HH:MM (24-hour)' });
      }
      if (!isValidTimezone(schedule.timezone)) {
        ctx.addIssue({ code: 'custom', message: 'Schedule timezone must be an IANA timezone identifier' });
      }
      if (schedule.cadence === 'weekly' && !schedule.weekdays?.length) {
        ctx.addIssue({ code: 'custom', message: 'Weekly schedules require at least one weekday' });
      }
      if (schedule.cadence === 'weekly' && schedule.weekdays &&
        new Set(schedule.weekdays).size !== schedule.weekdays.length) {
        ctx.addIssue({ code: 'custom', message: 'Weekly schedule weekdays must be unique' });
      }
      if (schedule.cadence !== 'weekly' && schedule.weekdays) {
        ctx.addIssue({ code: 'custom', message: 'Only weekly schedules take weekdays' });
      }
      if (schedule.cadence === 'monthly' && schedule.monthDay === undefined) {
        ctx.addIssue({ code: 'custom', message: 'Monthly schedules require a month day' });
      }
      if (schedule.cadence !== 'monthly' && schedule.monthDay !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'Only monthly schedules take a month day' });
      }
    }
  } else if (trigger.schedule) {
    ctx.addIssue({ code: 'custom', message: 'Only fixed-schedule triggers take a schedule configuration' });
  }
  if (trigger.eventType === 'schedule.dateRelative') {
    if (!trigger.dateRelative) {
      ctx.addIssue({ code: 'custom', message: 'Date-relative triggers require a dateRelative configuration' });
    } else {
      const relative = trigger.dateRelative;
      if (trigger.fieldId || trigger.fromStateId || trigger.toStateId ||
        'oldValue' in trigger && trigger.oldValue !== undefined || 'newValue' in trigger && trigger.newValue !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'Date-relative triggers do not take event selectors' });
      }
      if (relative.source === 'field' && !relative.fieldId) {
        ctx.addIssue({ code: 'custom', message: 'Date-relative field source requires a fieldId' });
      }
      if (relative.source === 'createdAt' && relative.fieldId) {
        ctx.addIssue({ code: 'custom', message: 'Date-relative createdAt source takes no fieldId' });
      }
      if (!isValidLocalTime(relative.localTime)) {
        ctx.addIssue({ code: 'custom', message: 'Date-relative localTime must be HH:MM (24-hour)' });
      }
      if (!isValidTimezone(relative.timezone)) {
        ctx.addIssue({ code: 'custom', message: 'Date-relative timezone must be an IANA timezone identifier' });
      }
    }
  } else if (trigger.dateRelative) {
    ctx.addIssue({ code: 'custom', message: 'Only date-relative triggers take a dateRelative configuration' });
  }
  const sameIds = (left: string[], right: string[]) =>
    left.length === right.length && left.every((id) => right.includes(id));
  for (const action of value.actions) {
    if (action.type === 'NOTIFY') {
      const notify = action.notify;
      if (!notify || !(notify.recipientUserIds?.length || notify.recipientGroupIds?.length ||
        notify.recipientFieldId || notify.recipientAssignee)) {
        ctx.addIssue({ code: 'custom', message: 'NOTIFY actions require at least one recipient source' });
      }
    }
    if (action.type === 'UPDATE_FIELDS') {
      if (!action.updates?.length) ctx.addIssue({ code: 'custom', message: 'UPDATE_FIELDS actions require updates' });
      for (const update of action.updates ?? []) {
        if (update.mode === 'copy' && !update.sourceFieldId) {
          ctx.addIssue({ code: 'custom', message: 'copy updates require a source field' });
        }
        if (update.mode !== 'copy' && update.sourceFieldId) {
          ctx.addIssue({ code: 'custom', message: 'Only copy updates take a source field' });
        }
        if (['set', 'increment', 'decrement'].includes(update.mode) && !('value' in update)) {
          ctx.addIssue({ code: 'custom', message: update.mode + ' updates require a value' });
        }
        if (update.mode === 'clear' && 'value' in update) {
          ctx.addIssue({ code: 'custom', message: 'clear updates take no value' });
        }
      }
      if (action.targetFieldIds && !sameIds(action.targetFieldIds, (action.updates ?? []).map(({ fieldId }) => fieldId))) {
        ctx.addIssue({ code: 'custom', message: 'UPDATE_FIELDS targetFieldIds must equal the updated fields' });
      }
    }
    if (action.type === 'CREATE_RECORD') {
      if (!action.targetAppId) ctx.addIssue({ code: 'custom', message: 'CREATE_RECORD actions require a target application' });
      if (!action.mappings?.length) ctx.addIssue({ code: 'custom', message: 'CREATE_RECORD actions require mappings' });
      for (const mapping of action.mappings ?? []) {
        if (mapping.mode === 'source' && !mapping.sourceFieldId) {
          ctx.addIssue({ code: 'custom', message: 'source mappings require a source field' });
        }
        if (mapping.mode === 'constant' && !('value' in mapping)) {
          ctx.addIssue({ code: 'custom', message: 'constant mappings require a value' });
        }
      }
      if (action.targetFieldIds && !sameIds(action.targetFieldIds, (action.mappings ?? []).map(({ targetFieldId }) => targetFieldId))) {
        ctx.addIssue({ code: 'custom', message: 'CREATE_RECORD targetFieldIds must equal the mapped fields' });
      }
    }
    if (action.type === 'ADVANCE_WORKFLOW' && !action.workflowActionId) {
      ctx.addIssue({ code: 'custom', message: 'ADVANCE_WORKFLOW actions require a workflow action' });
    }
  }
});
const createRuleInput = z.strictObject({ name: z.string().trim().min(1).max(120), config });
const draftInput = z.strictObject({ config });
const grantInput = z.strictObject({
  version: z.number().int().positive(),
  sourceAppId: identifier,
  readableFieldIds: z.array(identifier).max(500),
  targetAppIds: z.array(identifier).max(50),
  writableFieldIds: z.array(identifier).max(500),
  allowedOperations: z.array(z.enum(['NOTIFY', 'UPDATE_FIELDS', 'CREATE_RECORD', 'ADVANCE_WORKFLOW', 'WEBHOOK'])).max(10),
});
const versionInput = z.strictObject({ version: z.number().int().positive() });
const enableInput = z.strictObject({ enabled: z.boolean() });
const manualRunInput = z.strictObject({
  recordId: identifier,
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
});

export const automationHttp = {
  createRuleInput,
  draftInput,
  grantInput,
  versionInput,
  enableInput,
  rule: z.looseObject({ id: identifier, name: z.string(), enabled: z.boolean(), archivedAt: z.string().nullable().optional() }),
  version: z.looseObject({ ruleId: identifier, version: z.number().int(), status: z.string(), trigger: z.unknown(), conditions: z.unknown(), actions: z.unknown() }),
  grant: z.looseObject({ id: identifier, ruleId: identifier, ruleVersion: z.number().int(), revokedAt: z.string().nullable().optional() }),
  manualRunInput,
  run: z.looseObject({
    id: identifier, ruleId: identifier, ruleVersion: z.number().int(), status: z.string(),
    recordId: identifier, eventId: identifier.nullable().optional(), lastError: z.string().nullable().optional(),
  }),
  runAction: z.looseObject({
    actionId: identifier, actionType: z.string(), status: z.string(),
    errorCode: z.string().nullable().optional(), resultRef: z.string().nullable().optional(),
    attemptCount: z.number().int().optional(),
  }),
  runDetail: z.looseObject({ run: z.unknown(), actions: z.array(z.unknown()) }),
  runPage: z.looseObject({ items: z.array(z.unknown()), total: z.number().int() }),
  auditEvent: z.looseObject({
    id: identifier, action: z.string(), ruleId: identifier.nullable().optional(),
    actorId: identifier.nullable().optional(), details: z.unknown().optional(),
  }),
  auditPage: z.looseObject({ items: z.array(z.unknown()), total: z.number().int() }),
  summary: z.looseObject({ rules: z.array(z.unknown()), backlog: z.number().int(), unprocessedEvents: z.number().int() }),
  result: z.looseObject({}),
};

export function automationActionCausation(run: {
  id: string; rootCausationId: string; causationDepth: number; ruleId: string;
}, actionId: string) {
  return {
    rootCausationId: run.rootCausationId,
    parentRunId: run.id,
    causationDepth: run.causationDepth,
    originRuleId: run.ruleId,
    originActionId: actionId,
  };
}

type Group = z.infer<typeof conditionGroup>;
type Condition = z.infer<typeof condition>;
const missing = Symbol('missing');

function valueAt(data: Record<string, unknown>, id: string) {
  return Object.hasOwn(data, id) ? data[id] : missing;
}

function compare(left: unknown | typeof missing, right: unknown) {
  if (left === missing) return false;
  if (left === right) return true;
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (Array.isArray(left) || Array.isArray(right) || typeof left === 'object' || typeof right === 'object') {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}

function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type Change = { fieldId: string; oldValue: unknown; newValue: unknown; oldPresent?: boolean; newPresent?: boolean };

function evaluateOne(data: Record<string, unknown>, item: Condition, changes: Change[]) {
  const left = valueAt(data, item.fieldId);
  const right = item.value;
  switch (item.operator) {
    case 'empty': return left === missing || left === null || left === '' || Array.isArray(left) && left.length === 0;
    case 'nonempty': return !(left === missing || left === null || left === '' || Array.isArray(left) && left.length === 0);
    case 'eq': return compare(left, right);
    case 'ne': return left !== missing && !compare(left, right);
    case 'changed_to': return changes.some((change) => change.fieldId === item.fieldId &&
      (change.newPresent === true || change.newPresent !== false && change.newValue !== null) && compare(change.newValue, right));
    case 'contains': {
      const values = collection(left);
      return values.length ? values.some((value) => compare(value, right))
        : typeof left === 'string' && left.includes(String(right ?? ''));
    }
    case 'not_contains': {
      const values = collection(left);
      return values.length ? !values.some((value) => compare(value, right))
        : left === missing || left === null || typeof left === 'string' && !left.includes(String(right ?? ''));
    }
    case 'in': {
      if (!Array.isArray(right)) return false;
      const values = collection(left);
      return values.length ? values.some((entry) => right.some((value) => compare(entry, value)))
        : right.some((value) => compare(left, value));
    }
    case 'contains_any': return Array.isArray(right) && collection(left).some((entry) => right.some((value) => compare(entry, value)));
    case 'contains_all': return Array.isArray(right) && right.every((value) => collection(left).some((entry) => compare(entry, value)));
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte': {
      if (left === missing || left === null || right === null || right === undefined) return false;
        const numeric = (value: unknown) => typeof value === 'number' ||
          typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
        if (numeric(left) && numeric(right)) {
          const a = new Decimal(String(left));
          const b = new Decimal(String(right));
        const order = a.comparedTo(b);
        return item.operator === 'gt' ? order > 0 : item.operator === 'lt' ? order < 0 : item.operator === 'gte' ? order >= 0 : order <= 0;
      }
      const order = String(left).localeCompare(String(right));
      return item.operator === 'gt' ? order > 0 : item.operator === 'lt' ? order < 0 : item.operator === 'gte' ? order >= 0 : order <= 0;
    }
  }
}

function evaluateGroup(data: Record<string, unknown>, group: Group, changes: Change[]) {
  if (!group.groups.length) return true;
  const groupResults = group.groups.map(({ conditions }) => conditions.every((item) => evaluateOne(data, item, changes)));
  return group.operator === 'and' ? groupResults.every(Boolean) : groupResults.some(Boolean);
}

function fieldsFor(configValue: AutomationRuleConfig) {
  const ids = new Set<string>();
  const trigger = configValue.trigger;
  if (trigger.fieldId) ids.add(trigger.fieldId);
  if (trigger.dateRelative?.fieldId) ids.add(trigger.dateRelative.fieldId);
  for (const stage of [configValue.conditions.eventSnapshot, configValue.conditions.currentState]) {
    for (const group of stage.groups) for (const item of group.conditions) ids.add(item.fieldId);
  }
  for (const action of configValue.actions) {
    if (action.notify?.recipientFieldId) ids.add(action.notify.recipientFieldId);
    for (const text of [action.notify?.title, action.notify?.body]) {
      for (const match of text?.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g) ?? []) ids.add(match[1]);
    }
    for (const update of action.updates ?? []) if (update.sourceFieldId) ids.add(update.sourceFieldId);
    for (const mapping of action.mappings ?? []) if (mapping.sourceFieldId) ids.add(mapping.sourceFieldId);
  }
  return ids;
}

function renderTemplate(template: string, data: Record<string, unknown>, readable: ReadonlySet<string>) {
  return template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, fieldId: string) => {
    if (!readable.has(fieldId)) return '';
    const value = data[fieldId];
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

function templateFieldIds(text: string | undefined) {
  return [...(text?.matchAll(/\{\{([A-Za-z0-9_-]+)\}\}/g) ?? [])].map((match) => match[1]);
}

function codedError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function actionErrorCode(error: unknown, type: string) {
  const coded = (error as { code?: unknown } | null)?.code;
  if (typeof coded === 'string') return coded;
  if (error instanceof ConflictException) return 'REVISION_CONFLICT';
  if (error instanceof ForbiddenException) return 'ACTION_FORBIDDEN';
  if (error instanceof NotFoundException) return 'ACTION_NOT_FOUND';
  if (error instanceof BadRequestException) return 'ACTION_INPUT_INVALID';
  return `${type}_EXECUTION_FAILED`;
}

function supportedCondition(item: Condition, field: FieldDefinition) {
  if (!fieldContract[field.type].filter) return false;
  if (['gt', 'lt', 'gte', 'lte'].includes(item.operator)) {
    return ['number', 'date', 'datetime', 'time', 'text', 'email', 'link'].includes(field.type);
  }
  if (['contains', 'not_contains'].includes(item.operator)) return ['text', 'multiline', 'rich-text'].includes(field.type) || ['checkbox', 'multi-select'].includes(field.type);
  if (['contains_any', 'contains_all'].includes(item.operator)) return ['checkbox', 'multi-select', 'user', 'group', 'organization'].includes(field.type);
  if (item.operator === 'in') return Array.isArray(item.value);
  return true;
}

function cycleFindings(rules: { appId: string; config: AutomationRuleConfig }[]) {
  const edges = rules.flatMap((rule, sourceIndex) => rule.config.actions.flatMap((action) => {
    const producedEvent = {
      CREATE_RECORD: 'record.created', UPDATE_FIELDS: 'record.updated', ADVANCE_WORKFLOW: 'workflow.transitioned',
    }[action.type];
    if (!producedEvent) return [];
    const targetApp = action.targetAppId ?? rule.appId;
    return rules.flatMap((targetRule, targetIndex) => targetRule.appId === targetApp &&
      targetRule.config.trigger.eventType === producedEvent ? [{
        from: sourceIndex, to: targetIndex, appId: targetApp,
        deterministic: action.type === 'CREATE_RECORD' &&
          rule.config.conditions.eventSnapshot.groups.every(({ conditions }) => !conditions.length) &&
          rule.config.conditions.currentState.groups.every(({ conditions }) => !conditions.length) &&
          targetRule.config.conditions.eventSnapshot.groups.every(({ conditions }) => !conditions.length) &&
          targetRule.config.conditions.currentState.groups.every(({ conditions }) => !conditions.length),
      }] : []);
  }));
  const adjacency = new Map<number, typeof edges>();
  for (const edge of edges) adjacency.set(edge.from, [...adjacency.get(edge.from) ?? [], edge]);
  const found = new Map<string, typeof edges>();
  function walk(node: number, stack: number[], path: typeof edges[number][]) {
    for (const edge of adjacency.get(node) ?? []) {
      const at = stack.indexOf(edge.to);
      if (at >= 0) {
        const cycle = [...path.slice(at), edge];
        const key = cycle.map(({ from, to }) => `${from}>${to}`).sort().join('|');
        found.set(key, cycle);
      } else if (stack.length < 20) walk(edge.to, [...stack, edge.to], [...path, edge]);
    }
  }
  for (const node of adjacency.keys()) walk(node, [node], []);
  return [...found.values()].map((cycle) => ({
    code: cycle.every(({ deterministic }) => deterministic) ? 'BLOCKING_CYCLE' : 'POTENTIAL_CYCLE',
    apps: [...new Set(cycle.map(({ appId }) => appId))],
  }));
}

@Injectable()
export class AutomationService {
  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService,
    private readonly recordWrites: RecordService, private readonly workflowRuntime: WorkflowRuntimeService) {}

  list(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      return tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId),
      )).orderBy(automationRules.createdAt);
    });
  }

  create(context: TenantContext, appId: string, input: z.infer<typeof createRuleInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const app = await this.schema.managedApp(tx, context, appId);
      const fields = await this.schema.getFields(tx, context, appId, app.publishedSchemaVersion);
      this.validateConfig(input.config, fields);
      const [rule] = await tx.insert(automationRules).values({
        tenantId: context.tenantId, appId, name: input.name, createdBy: context.userId,
      }).returning();
      const [version] = await tx.insert(automationRuleVersions).values({
        tenantId: context.tenantId, appId, ruleId: rule.id, version: 1, schemaVersion: 1,
        sourceSchemaVersion: app.publishedSchemaVersion,
        trigger: input.config.trigger, conditions: input.config.conditions, actions: input.config.actions,
        createdBy: context.userId,
      }).returning();
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId: rule.id, ruleVersion: version.version,
        actorId: context.userId, action: 'RULE_CREATED',
      });
      return { rule, version: { ...version, config: input.config } };
    });
  }

  saveDraft(context: TenantContext, appId: string, ruleId: string, input: z.infer<typeof draftInput>) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      const [rule] = await tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId), eq(automationRules.id, ruleId),
        isNull(automationRules.archivedAt),
      )).for('update');
      if (!rule) throw new NotFoundException('Unknown automation rule');
      const fields = await this.schema.getFields(tx, context, appId, app.publishedSchemaVersion);
      this.validateConfig(input.config, fields);
      const [latest] = await tx.select({ version: automationRuleVersions.version }).from(automationRuleVersions).where(and(
        eq(automationRuleVersions.tenantId, context.tenantId), eq(automationRuleVersions.ruleId, ruleId),
      )).orderBy(sql`${automationRuleVersions.version} DESC`).limit(1);
      const versionNumber = (latest?.version ?? 0) + 1;
      const [version] = await tx.insert(automationRuleVersions).values({
        tenantId: context.tenantId, appId, ruleId, version: versionNumber, schemaVersion: input.config.schemaVersion,
        sourceSchemaVersion: app.publishedSchemaVersion,
        trigger: input.config.trigger, conditions: input.config.conditions, actions: input.config.actions,
        createdBy: context.userId,
      }).returning();
      await tx.update(automationRules).set({ updatedAt: sql`clock_timestamp()` }).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId), eq(automationRules.id, ruleId),
      ));
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: versionNumber,
        actorId: context.userId, action: 'RULE_UPDATED',
      });
      return { ...version, config: input.config };
    });
  }

  grant(context: TenantContext, appId: string, ruleId: string, input: z.infer<typeof grantInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const version = await this.readVersion(tx, context, appId, ruleId, input.version);
      await this.schema.managedApp(tx, context, input.sourceAppId);
      const { fields, access: sourceAccess } = await this.schema.access(tx, context, input.sourceAppId, 'view');
      const fieldIds = new Set(fields.map(({ fieldId }) => fieldId));
      if (input.readableFieldIds.some((id) => !fieldIds.has(id))) throw new BadRequestException('Unknown readable field');
      if (input.readableFieldIds.some((id) => !this.authorization.fieldDecision(sourceAccess, id, 'view').allowed)) {
        throw new BadRequestException('A source field is not readable by the granting administrator');
      }
      for (const targetId of input.targetAppIds) {
        await this.schema.managedApp(tx, context, targetId);
        const { fields: targetFields, access: targetAccess } = await this.schema.access(tx, context, targetId, 'edit');
        const valid = new Set(targetFields.map(({ fieldId }) => fieldId));
        if (input.writableFieldIds.some((id) => !valid.has(id))) throw new BadRequestException('Unknown writable field');
        if (input.writableFieldIds.some((id) => !this.authorization.fieldDecision(targetAccess, id, 'edit').allowed)) {
          throw new BadRequestException('A target field is not writable by the granting administrator');
        }
      }
      if (input.sourceAppId !== appId) {
        throw new BadRequestException('The trigger source must be the rule application');
      }
      const [grant] = await tx.insert(automationGrants).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: input.version, sourceAppId: input.sourceAppId,
        readableFieldIds: input.readableFieldIds, targetAppIds: input.targetAppIds,
        writableFieldIds: input.writableFieldIds, allowedOperations: input.allowedOperations,
        approvedBy: context.userId,
      }).onConflictDoUpdate({
        target: [automationGrants.tenantId, automationGrants.ruleId, automationGrants.ruleVersion],
        set: {
          sourceAppId: input.sourceAppId, readableFieldIds: input.readableFieldIds,
          targetAppIds: input.targetAppIds, writableFieldIds: input.writableFieldIds,
          allowedOperations: input.allowedOperations, approvedBy: context.userId,
          approvedAt: sql`clock_timestamp()`, revokedAt: null, revokedBy: null,
        },
      }).returning();
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: input.version,
        actorId: context.userId, action: 'GRANT_APPROVED',
        details: { sourceAppId: input.sourceAppId, targetAppIds: input.targetAppIds,
          readableFieldIds: input.readableFieldIds, writableFieldIds: input.writableFieldIds,
          allowedOperations: input.allowedOperations },
      });
      // P3-C cadence: re-approving a grant for the enabled rule's current
      // version revives its plan (it was invalidated on revoke).
      const [ruleForPlan] = await tx.select({ enabled: automationRules.enabled, currentVersion: automationRules.currentVersion })
        .from(automationRules).where(and(eq(automationRules.tenantId, context.tenantId),
          eq(automationRules.appId, appId), eq(automationRules.id, ruleId)));
      if (ruleForPlan?.enabled && ruleForPlan.currentVersion === input.version) {
        const version = await this.readVersion(tx, context, appId, ruleId, input.version);
        await this.refreshCadencePlan(tx, context.tenantId, appId, ruleId, version);
        // P3-C date-relative: a fresh grant revives planning too -- the
        // backfill (re)scan regenerates the version's per-record plans.
        await this.ensureDateBackfill(tx, context.tenantId, appId, ruleId, version);
      }
      return grant;
    });
  }

  revoke(context: TenantContext, appId: string, ruleId: string, grantId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [grant] = await tx.update(automationGrants).set({ revokedAt: sql`clock_timestamp()`, revokedBy: context.userId })
        .where(and(eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.appId, appId),
          eq(automationGrants.ruleId, ruleId), eq(automationGrants.id, grantId), isNull(automationGrants.revokedAt)))
        .returning();
      if (!grant) throw new NotFoundException('Active automation grant not found');
      // P3-C cadence: revoking the grant kills that version's plan.
      await this.invalidateCadencePlans(tx, context.tenantId, ruleId, 'grant-revoked', { onlyVersion: grant.ruleVersion });
      await this.invalidateDateRelativePlans(tx, context.tenantId, ruleId, 'grant-revoked', { onlyVersion: grant.ruleVersion });
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: grant.ruleVersion,
        actorId: context.userId, action: 'GRANT_REVOKED',
      });
      return { revoked: true };
    });
  }

  preflight(context: TenantContext, appId: string, ruleId: string, input: z.infer<typeof versionInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const version = await this.readVersion(tx, context, appId, ruleId, input.version);
      const ruleConfig = this.configOf(version);
      const problems = await this.validateVersion(tx, context, appId, version);
      const existing = await tx.select({
        appId: automationRules.appId, trigger: automationRuleVersions.trigger,
        conditions: automationRuleVersions.conditions, actions: automationRuleVersions.actions,
      }).from(automationRules).innerJoin(automationRuleVersions, and(
        eq(automationRuleVersions.tenantId, automationRules.tenantId),
        eq(automationRuleVersions.appId, automationRules.appId),
        eq(automationRuleVersions.ruleId, automationRules.id),
        eq(automationRuleVersions.version, automationRules.currentVersion),
      )).where(and(eq(automationRules.tenantId, context.tenantId), eq(automationRules.enabled, true), isNull(automationRules.archivedAt)));
      const cycles = cycleFindings([...existing.map((item) => ({ appId: item.appId, config: {
        schemaVersion: 1, trigger: item.trigger, conditions: item.conditions, actions: item.actions,
      } as AutomationRuleConfig })),
        { appId, config: ruleConfig }]);
      const findings = [...problems, ...cycles.map((cycle) => ({
        ...cycle, severity: cycle.code === 'BLOCKING_CYCLE' ? 'BLOCKING' as const : 'WARNING' as const,
      }))];
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: version.version,
        actorId: context.userId, action: 'PREFLIGHT', details: { findings },
      });
      return { publishable: !findings.some((finding) => finding.code === 'BLOCKING_CYCLE' || finding.severity === 'BLOCKING'),
        findings, cycles };
    });
  }

  publish(context: TenantContext, appId: string, ruleId: string, input: z.infer<typeof versionInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const version = await this.readVersion(tx, context, appId, ruleId, input.version);
      if (version.status === 'published') throw new ConflictException('Published automation versions are immutable');
      const findings = await this.validateVersion(tx, context, appId, version);
      const [grant] = await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, ruleId),
        eq(automationGrants.ruleVersion, input.version), isNull(automationGrants.revokedAt),
      ));
      if (!grant) findings.push({ code: 'GRANT_REQUIRED', severity: 'BLOCKING' });
      const current = await tx.select({
        appId: automationRules.appId, trigger: automationRuleVersions.trigger,
        conditions: automationRuleVersions.conditions, actions: automationRuleVersions.actions,
      }).from(automationRules).innerJoin(automationRuleVersions, and(
        eq(automationRuleVersions.tenantId, automationRules.tenantId),
        eq(automationRuleVersions.appId, automationRules.appId),
        eq(automationRuleVersions.ruleId, automationRules.id),
        eq(automationRuleVersions.version, automationRules.currentVersion),
      )).where(and(eq(automationRules.tenantId, context.tenantId), eq(automationRules.enabled, true), isNull(automationRules.archivedAt)));
      const cycles = cycleFindings([...current.map((item) => ({ appId: item.appId, config: {
        schemaVersion: 1, trigger: item.trigger, conditions: item.conditions, actions: item.actions,
      } as AutomationRuleConfig })),
        { appId, config: this.configOf(version) }]);
      findings.push(...cycles.map((cycle) => ({
        ...cycle, severity: cycle.code === 'BLOCKING_CYCLE' ? 'BLOCKING' as const : 'WARNING' as const,
      })));
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: input.version,
        actorId: context.userId, action: 'PREFLIGHT', details: { findings },
      });
      if (findings.some(({ severity, code }) => severity === 'BLOCKING' || code === 'BLOCKING_CYCLE')) {
        throw new ConflictException({ message: 'Automation preflight has blocking findings', findings });
      }
      const [published] = await tx.update(automationRuleVersions).set({
        status: 'published', publishedBy: context.userId, publishedAt: sql`clock_timestamp()`,
      }).where(and(eq(automationRuleVersions.tenantId, context.tenantId),
        eq(automationRuleVersions.ruleId, ruleId), eq(automationRuleVersions.version, input.version),
        eq(automationRuleVersions.status, 'draft'))).returning();
      await tx.update(automationRules).set({ currentVersion: input.version, enabled: false, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId), eq(automationRules.id, ruleId)));
      // P3-C cadence: a version change supersedes the old version's plan;
      // the newly published version gets its own plan row (consumption is
      // additionally gated on the rule being enabled, which publish just
      // cleared, so nothing can fire until enable).
      await this.invalidateCadencePlans(tx, context.tenantId, ruleId, 'version-superseded', { exceptVersion: input.version });
      await this.refreshCadencePlan(tx, context.tenantId, appId, ruleId, published);
      // P3-C date-relative: the superseded version's per-record plans die
      // with it; the new version backfills its own plans from scratch.
      await this.invalidateDateRelativePlans(tx, context.tenantId, ruleId, 'version-superseded', { exceptVersion: input.version });
      await this.ensureDateBackfill(tx, context.tenantId, appId, ruleId, published);
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: input.version,
        actorId: context.userId, action: 'PUBLISHED', details: { warnings: findings },
      });
      return { version: published, warnings: findings.filter(({ severity }) => severity === 'WARNING') };
    });
  }

  enable(context: TenantContext, appId: string, ruleId: string, input: z.infer<typeof enableInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [rule] = await tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId), eq(automationRules.id, ruleId),
      )).for('update');
      if (!rule?.currentVersion) throw new ConflictException('Publish the rule before enabling it');
      if (input.enabled) {
        const [grant] = await tx.select({ id: automationGrants.id }).from(automationGrants).where(and(
          eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, ruleId),
          eq(automationGrants.ruleVersion, rule.currentVersion), isNull(automationGrants.revokedAt),
        ));
        if (!grant) throw new ConflictException('An active automation grant is required');
        const version = await this.readVersion(tx, context, appId, ruleId, rule.currentVersion);
        const findings = await this.validateVersion(tx, context, appId, version);
        if (findings.some(({ severity }) => severity === 'BLOCKING')) {
          throw new ConflictException({ message: 'Automation preflight has blocking findings', findings });
        }
      }
      await tx.update(automationRules).set({ enabled: input.enabled, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId), eq(automationRules.id, ruleId)));
      // P3-C cadence: enabling (re)creates the current version's plan;
      // disabling invalidates it so a disabled rule can never fire.
      if (input.enabled) {
        const version = await this.readVersion(tx, context, appId, ruleId, rule.currentVersion);
        await this.refreshCadencePlan(tx, context.tenantId, appId, ruleId, version);
        await this.ensureDateBackfill(tx, context.tenantId, appId, ruleId, version);
      } else {
        await this.invalidateCadencePlans(tx, context.tenantId, ruleId, 'rule-disabled');
        await this.invalidateDateRelativePlans(tx, context.tenantId, ruleId, 'rule-disabled');
      }
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: rule.currentVersion,
        actorId: context.userId, action: input.enabled ? 'ENABLED' : 'DISABLED',
      });
      return { enabled: input.enabled };
    });
  }

  archive(context: TenantContext, appId: string, ruleId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [rule] = await tx.update(automationRules).set({
        enabled: false, archivedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      }).where(and(eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId),
        eq(automationRules.id, ruleId), isNull(automationRules.archivedAt))).returning();
      if (!rule) throw new NotFoundException('Active automation rule not found');
      await this.invalidateCadencePlans(tx, context.tenantId, ruleId, 'rule-archived');
      await this.invalidateDateRelativePlans(tx, context.tenantId, ruleId, 'rule-archived');
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: rule.currentVersion,
        actorId: context.userId, action: 'RULE_ARCHIVED',
      });
      return { archived: true };
    });
  }

  dryRun(context: TenantContext, appId: string, ruleId: string,
    input: z.infer<typeof versionInput> & { recordId: string }) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const version = await this.readVersion(tx, context, appId, ruleId, input.version);
      const cfg = this.configOf(version);
      const { fields, access } = await this.schema.access(tx, context, appId, 'view');
      const fieldById = new Map(fields.map((field) => [field.fieldId, field]));
      const configured = [...fieldsFor(cfg)];
      const unreadable = configured.filter((id) =>
        !fieldById.has(id) || !this.authorization.fieldDecision(access, id, 'view').allowed);
      if (unreadable.length) throw new BadRequestException({
        message: 'Rule fields are not readable by the current operator', fieldIds: unreadable,
      });
      const [row] = await tx.select().from(records).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, input.recordId),
        isNull(records.deletedAt), this.authorization.recordScope(access, 'view'),
      ));
      if (!row) throw new NotFoundException('Record not found or not readable');
      const [grant] = await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, ruleId),
        eq(automationGrants.ruleVersion, input.version), isNull(automationGrants.revokedAt),
      ));
      const authorized = Boolean(grant && grant.sourceAppId === appId &&
        configured.every((id) => grant.readableFieldIds.includes(id)) &&
        cfg.actions.every((action) => grant.allowedOperations.includes(action.type) &&
          (!action.targetAppId || grant.targetAppIds.includes(action.targetAppId)) &&
          (action.targetFieldIds ?? []).every((id) => grant.writableFieldIds.includes(id))));
      const snapshotMatches = !cfg.trigger.eventType.startsWith('workflow.') &&
        evaluateGroup(row.data, cfg.conditions.eventSnapshot, []);
      const currentMatches = evaluateGroup(row.data, cfg.conditions.currentState, []);
      const triggerMatches = cfg.trigger.eventType === 'record.created' ? true
        : cfg.trigger.eventType === 'schedule.fixed' ? true
        : cfg.trigger.eventType === 'record.updated' && cfg.trigger.fieldId && 'newValue' in cfg.trigger
          ? !compare(valueAt(row.data, cfg.trigger.fieldId), cfg.trigger.newValue) ? false
            : 'oldValue' in cfg.trigger ? null : true
          : false;
      const boundFields = await this.schema.getFields(tx, context, appId, version.sourceSchemaVersion);
      const boundTypes = new Map(boundFields.map(({ fieldId, type }) => [fieldId, type]));
      const fieldVersionValid = configured.every((id) => boundTypes.get(id) === fieldById.get(id)?.type);
      const record = serializeRecord(row);
      const readableIds = new Set(configured);
      const actionPlans: Record<string, unknown>[] = [];
      for (const action of cfg.actions) {
        if (action.type === 'NOTIFY') {
          actionPlans.push({ actionId: action.actionId, type: action.type,
            recipients: await this.resolveNotifyRecipients(tx, context.tenantId, appId, record, action.notify ?? {}),
            title: renderTemplate(action.notify?.title ?? '', record.data, readableIds),
            body: renderTemplate(action.notify?.body ?? '', record.data, readableIds) });
        } else if (action.type === 'UPDATE_FIELDS') {
          actionPlans.push({ actionId: action.actionId, type: action.type,
            updates: (action.updates ?? []).map((update) => {
              try {
                const plan = this.planFieldUpdate(fields, record, update);
                return { fieldId: update.fieldId, mode: update.mode,
                  from: record.data[update.fieldId] ?? null, to: plan.value ?? null, changed: plan.changed };
              } catch (error) {
                return { fieldId: update.fieldId, mode: update.mode,
                  error: error instanceof Error ? error.message : String(error) };
              }
            }) });
        } else if (action.type === 'CREATE_RECORD') {
          actionPlans.push({ actionId: action.actionId, type: action.type, targetAppId: action.targetAppId,
            data: this.planCreateData(record, action) });
        } else if (action.type === 'ADVANCE_WORKFLOW') {
          actionPlans.push({ actionId: action.actionId, type: action.type,
            workflowActionId: action.workflowActionId, currentStatus: row.status ?? null,
            note: 'Workflow state, automation opt-in and action conditions are re-evaluated at execution time.' });
        } else {
          actionPlans.push({ actionId: action.actionId, type: action.type,
            note: 'Webhook delivery is implemented in P3-D; in P3-B the action fails explicitly.' });
        }
      }
      return {
        dryRun: true, sideEffects: false,
        // P3-C C-3 disclosure: a dry run is a zero-side-effect preview and
        // deliberately writes NO audit event and no run history (brief
        // appendix 2, F8). The preview result is returned synchronously to
        // the operator only; `auditTrail: 'none'` states that in the API.
        auditTrail: 'none' as const,
        eventType: cfg.trigger.eventType, recordId: row.id,
        triggerMatches, snapshotMatches, currentMatches, fieldVersionValid, authorized,
        wouldRun: triggerMatches === true && snapshotMatches && currentMatches && fieldVersionValid && authorized,
        actions: cfg.actions.map(({ actionId, type, targetAppId, targetFieldIds }) => ({
          actionId, type, targetAppId: targetAppId ?? appId, targetFieldIds: targetFieldIds ?? [], executed: false,
        })),
        actionPlans,
        boundaries: 'Dry run resolves recipients and field changes against the current record only; ' +
          'grants, workflow state and conditions are re-checked at execution time. ' +
          'A dry run writes no audit event and leaves no run history: it is a zero-side-effect preview.',
        warning: cfg.trigger.eventType.startsWith('workflow.')
          ? 'Workflow event dry-run requires a persisted workflow event; this record-only preview does not simulate one.' : null,
      };
    });
  }

  listPausedChains(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const rows = await tx.select({ chain: automationProblemChains })
        .from(automationProblemChains)
        .innerJoin(automationRuns, and(
          eq(automationRuns.tenantId, automationProblemChains.tenantId),
          eq(automationRuns.id, automationProblemChains.lastRunId),
        ))
        .where(and(
          eq(automationProblemChains.tenantId, context.tenantId),
          eq(automationRuns.appId, appId),
          isNull(automationProblemChains.resumedAt),
        ));
      return rows.map(({ chain }) => chain);
    });
  }

  resumePausedChain(context: TenantContext, appId: string, rootCausationId: string) {
    return withTenantTransaction(context, async (tx) => {
      const [chain] = await tx.select().from(automationProblemChains).where(and(
        eq(automationProblemChains.tenantId, context.tenantId),
        eq(automationProblemChains.rootCausationId, rootCausationId),
        isNull(automationProblemChains.resumedAt),
      )).for('update');
      if (!chain) throw new NotFoundException('Active paused automation problem chain not found');
      if (chain.lastRunId) {
        const [lastRun] = await tx.select({ appId: automationRuns.appId }).from(automationRuns).where(and(
          eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.id, chain.lastRunId),
        ));
        if (!lastRun || lastRun.appId !== appId) {
          throw new NotFoundException('Active paused automation problem chain not found');
        }
      }
      await tx.update(automationProblemChains).set({
        resumedAt: sql`clock_timestamp()`, resumedBy: context.userId,
      }).where(and(
        eq(automationProblemChains.tenantId, context.tenantId),
        eq(automationProblemChains.rootCausationId, rootCausationId),
        isNull(automationProblemChains.resumedAt),
      ));
      if (chain.lastRunId) {
        const [run] = await tx.select().from(automationRuns).where(and(
          eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.id, chain.lastRunId),
        ));
        if (run) await tx.insert(automationAuditEvents).values({
          tenantId: context.tenantId, appId: run.appId, ruleId: run.ruleId, ruleVersion: run.ruleVersion,
          actorId: context.userId, action: 'CHAIN_RESUMED',
          details: { rootCausationId, reason: chain.reason },
        });
      }
      return { resumed: true, rootCausationId };
    });
  }

  // P3-C C-3 throttle check: true when a guardrail audit row for the same
  // (tenant, app, rule, action) already exists inside the throttle window.
  private async guardrailAuditThrottled(tx: TenantTransaction, tenantId: string,
    appId: string, ruleId: string, action: 'RATE_LIMITED' | 'BACKLOG_LIMITED') {
    const recent = await tx.execute(sql`
      SELECT 1 AS hit FROM automation_audit_events
      WHERE tenant_id=${tenantId} AND app_id=${appId} AND rule_id=${ruleId} AND action=${action}
        AND occurred_at >= clock_timestamp() - (${AUTOMATION_GUARDRAIL_AUDIT_WINDOW_MS} * interval '1 millisecond')
      LIMIT 1
    `);
    return recent.rows.length > 0;
  }

  async processOutbox(context: TenantContext, limit = 100) {
    return withTenantTransaction(context, async (tx) => {
      const events = await tx.execute(sql`
        SELECT o.event_id AS "eventId", o.app_id AS "appId", o.topic, o.root_causation_id AS "rootCausationId",
          o.parent_run_id AS "parentRunId", o.causation_depth AS "causationDepth",
          o.origin_rule_id AS "originRuleId", o.origin_action_id AS "originActionId",
          e.record_id AS "recordId", e.record_revision AS "recordRevision", e.schema_version AS "schemaVersion",
          e.kind, e.snapshot_data AS "snapshotData", e.changes,
          w.from_state_id AS "fromStateId", w.to_state_id AS "toStateId",
          w.event_type AS "workflowEventType", (w.event_id IS NOT NULL) AS "isWorkflow"
        FROM outbox o JOIN record_events e
          ON e.tenant_id=o.tenant_id AND e.app_id=o.app_id AND e.event_id=o.event_id
        LEFT JOIN workflow_events w
          ON w.tenant_id=o.tenant_id AND w.app_id=o.app_id AND w.event_id=o.event_id
        WHERE o.tenant_id=${context.tenantId} AND o.automation_processed_at IS NULL
          AND o.topic NOT LIKE 'record.WORKFLOW_REPAIR'
        ORDER BY o.created_at, o.event_id
        LIMIT ${limit} FOR UPDATE OF o SKIP LOCKED
      `);
      const rows = events.rows as {
        eventId: string; appId: string; topic: string; rootCausationId: string | null; parentRunId: string | null;
        causationDepth: number; originRuleId: string | null; originActionId: string | null; recordId: string;
        recordRevision: number; schemaVersion: number; kind: string; snapshotData: Record<string, unknown>;
        changes: Change[]; fromStateId: string | null;
        toStateId: string | null; workflowEventType: 'transitioned' | 'rejected' | null; isWorkflow: boolean;
      }[];
      let createdRuns = 0;
      for (const event of rows) {
        const eventType = event.isWorkflow && event.kind === 'workflow-action'
          ? event.workflowEventType === 'rejected' ? 'workflow.rejected' : 'workflow.transitioned'
            : ({ created: 'record.created', updated: 'record.updated', deleted: 'record.deleted' } as Record<string, string>)[event.kind];
        if (eventType && !(eventType === 'record.updated' && event.changes.length === 0)) {
          const candidates = await tx.select({
            rule: automationRules, version: automationRuleVersions, grant: automationGrants,
          }).from(automationRules).innerJoin(automationRuleVersions, and(
            eq(automationRuleVersions.tenantId, automationRules.tenantId), eq(automationRuleVersions.appId, automationRules.appId),
            eq(automationRuleVersions.ruleId, automationRules.id), eq(automationRuleVersions.version, automationRules.currentVersion),
          )).innerJoin(automationGrants, and(
            eq(automationGrants.tenantId, automationRules.tenantId), eq(automationGrants.ruleId, automationRules.id),
            eq(automationGrants.ruleVersion, automationRuleVersions.version),
          )).where(and(eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, event.appId),
            eq(automationRules.enabled, true), isNull(automationRules.archivedAt),
            eq(automationRuleVersions.status, 'published')));
          // P3-C date-relative: record lifecycle events maintain the
          // per-record plans of every enabled date-relative rule on this
          // app (create -> generate, date change -> invalidate + regen,
          // delete -> invalidate). This is plan maintenance only: it
          // never creates runs, and it is deliberately placed before the
          // guardrail deferrals below so a rate/backlog pause cannot lose
          // a plan update (the event itself stays unprocessed and the
          // sync is idempotent when the pass repeats).
          if (eventType === 'record.created' || eventType === 'record.updated' || eventType === 'record.deleted') {
            for (const candidate of candidates) {
              const candidateCfg = this.configOf(candidate.version);
              if (candidateCfg.trigger.eventType !== 'schedule.dateRelative' || candidate.grant.revokedAt) continue;
              await this.syncDateRelativePlanForEvent(tx, context.tenantId, candidate, event);
            }
          }
            const rootCausationId = event.rootCausationId ?? event.eventId;
            const [paused] = await tx.select().from(automationProblemChains).where(and(
              eq(automationProblemChains.tenantId, context.tenantId),
              eq(automationProblemChains.rootCausationId, rootCausationId),
              isNull(automationProblemChains.resumedAt),
            ));
            if (paused) {
              await tx.update(outbox).set({ automationProcessedAt: sql`clock_timestamp()` })
                .where(and(eq(outbox.tenantId, context.tenantId), eq(outbox.appId, event.appId), eq(outbox.eventId, event.eventId)));
              continue;
            }
            const recentRuns = await tx.execute(sql`
              SELECT count(*)::int AS count
              FROM automation_runs
              WHERE tenant_id=${context.tenantId}
                AND started_at >= clock_timestamp() - interval '60 seconds'
            `);
            const runCount = Number((recentRuns.rows[0] as { count: number }).count ?? 0);
            if (runCount >= AUTOMATION_TENANT_RUN_RATE_LIMIT) {
              for (const candidate of candidates) {
                if (await this.guardrailAuditThrottled(tx, context.tenantId, candidate.rule.appId, candidate.rule.id, 'RATE_LIMITED')) continue;
                await tx.insert(automationAuditEvents).values({
                  tenantId: context.tenantId, appId: candidate.rule.appId, ruleId: candidate.rule.id,
                  ruleVersion: candidate.version.version, ...auditActor(context), action: 'RATE_LIMITED',
                  details: { rootCausationId, eventId: event.eventId, limit: AUTOMATION_TENANT_RUN_RATE_LIMIT, windowMs: AUTOMATION_TENANT_RUN_RATE_WINDOW_MS },
                });
              }
              continue;
            }
            const backlog = await tx.execute(sql`
              SELECT
                (SELECT count(*)::int FROM automation_runs
                  WHERE tenant_id=${context.tenantId} AND status IN ('QUEUED','RUNNING')) +
                (SELECT count(*)::int FROM outbox
                  WHERE tenant_id=${context.tenantId} AND automation_processed_at IS NULL) AS count
            `);
            const pendingCount = Number((backlog.rows[0] as { count: number }).count ?? 0);
            if (pendingCount > AUTOMATION_TENANT_PENDING_LIMIT) {
              for (const candidate of candidates) {
                if (await this.guardrailAuditThrottled(tx, context.tenantId, candidate.rule.appId, candidate.rule.id, 'BACKLOG_LIMITED')) continue;
                await tx.insert(automationAuditEvents).values({
                  tenantId: context.tenantId, appId: candidate.rule.appId, ruleId: candidate.rule.id,
                  ruleVersion: candidate.version.version, ...auditActor(context), action: 'BACKLOG_LIMITED',
                  details: { rootCausationId, eventId: event.eventId, pendingCount, limit: AUTOMATION_TENANT_PENDING_LIMIT },
                });
              }
              continue;
            }
          for (const candidate of candidates) {
            const cfg = this.configOf(candidate.version);
            const triggerChange = cfg.trigger.fieldId && event.changes.find((change) => change.fieldId === cfg.trigger.fieldId);
            if (cfg.trigger.eventType !== eventType ||
              cfg.trigger.fieldId && (!triggerChange ||
                'oldValue' in cfg.trigger && !(triggerChange.oldPresent === true || triggerChange.oldValue !== null) ||
                'oldValue' in cfg.trigger && !compare(triggerChange.oldValue, cfg.trigger.oldValue) ||
                'newValue' in cfg.trigger && !(triggerChange.newPresent === true || triggerChange.newValue !== null) ||
                'newValue' in cfg.trigger && !compare(triggerChange.newValue, cfg.trigger.newValue)) ||
              cfg.trigger.fromStateId && cfg.trigger.fromStateId !== event.fromStateId ||
              cfg.trigger.toStateId && cfg.trigger.toStateId !== event.toStateId) continue;
            const eventSnapshotPass = evaluateGroup(event.snapshotData, cfg.conditions.eventSnapshot, event.changes);
            const [sourceApp] = await tx.select().from(apps).where(and(
              eq(apps.tenantId, context.tenantId), eq(apps.id, event.appId), isNull(apps.deletedAt), isNull(apps.archivedAt),
            ));
            const currentFields = sourceApp ? await this.schema.getFields(tx, context, event.appId, sourceApp.publishedSchemaVersion) : [];
            const currentFieldIds = new Set(currentFields.map(({ fieldId }) => fieldId));
            const relevantIds = fieldsFor(cfg);
            const boundFields = await this.schema.getFields(tx, context, event.appId, candidate.version.sourceSchemaVersion);
            const eventFields = await this.schema.getFields(tx, context, event.appId, event.schemaVersion);
            const fieldTypeById = (definitions: FieldDefinition[]) => new Map(definitions.map(({ fieldId, type }) => [fieldId, type]));
            const boundTypes = fieldTypeById(boundFields);
            const eventTypesById = fieldTypeById(eventFields);
            const currentTypes = fieldTypeById(currentFields);
            const fieldVersionValid = [...relevantIds].every((id) =>
              boundTypes.has(id) && eventTypesById.get(id) === boundTypes.get(id) && currentTypes.get(id) === boundTypes.get(id));
            const grant = candidate.grant;
            let grantValid = Boolean(sourceApp && !grant.revokedAt && grant.sourceAppId === event.appId &&
              [...relevantIds].every((id) => grant.readableFieldIds.includes(id)) &&
              cfg.actions.every((action) => grant.allowedOperations.includes(action.type) &&
                (!action.targetAppId || grant.targetAppIds.includes(action.targetAppId)) &&
                (action.targetFieldIds ?? []).every((id) => grant.writableFieldIds.includes(id))));
            let sourceAccess: Awaited<ReturnType<AppSchemaService['access']>>['access'] | undefined;
            if (grantValid) {
              const grantor = { tenantId: context.tenantId, userId: grant.approvedBy };
              try {
                const source = await this.schema.access(tx, grantor, event.appId, 'view');
                sourceAccess = source.access;
                if ([...relevantIds].some((id) => !this.authorization.fieldDecision(source.access, id, 'view').allowed)) {
                  grantValid = false;
                }
                for (const action of cfg.actions) if (action.targetAppId) {
                  const target = await this.schema.access(tx, grantor, action.targetAppId, 'edit');
                  if ((action.targetFieldIds ?? []).some((id) => !this.authorization.fieldDecision(target.access, id, 'edit').allowed)) {
                    grantValid = false;
                  }
                }
              } catch {
                grantValid = false;
              }
            }
            for (const action of cfg.actions) if (action.targetAppId) {
              const [targetApp] = await tx.select().from(apps).where(and(
                eq(apps.tenantId, context.tenantId), eq(apps.id, action.targetAppId),
                isNull(apps.deletedAt), isNull(apps.archivedAt),
              ));
              if (!targetApp) grantValid = false;
              else {
                const targetFields = await this.schema.getFields(tx, context, action.targetAppId, targetApp.publishedSchemaVersion);
                const ids = new Set(targetFields.map(({ fieldId }) => fieldId));
                if ((action.targetFieldIds ?? []).some((id) => !ids.has(id))) grantValid = false;
              }
            }
            const [current] = sourceAccess ? await tx.select().from(records).where(and(
              eq(records.tenantId, context.tenantId), eq(records.appId, event.appId), eq(records.id, event.recordId),
              this.authorization.recordScope(sourceAccess, 'view'),
            )) : [];
            if (!current && sourceApp) grantValid = false;
            const currentPass = Boolean(current && (!current.deletedAt || event.kind === 'deleted') &&
              [...relevantIds].every((id) => currentFieldIds.has(id)) &&
              fieldVersionValid &&
              evaluateGroup(current.data, cfg.conditions.currentState, event.changes) &&
              (!cfg.trigger.fieldId || !('newValue' in cfg.trigger) || compare(valueAt(current.data, cfg.trigger.fieldId), cfg.trigger.newValue)));
            const identity = `${event.appId}:${event.eventId}:${eventType}:${candidate.rule.id}:${candidate.version.version}`;
            const failedRuns = await tx.select({ id: automationRuns.id }).from(automationRuns).where(and(
              eq(automationRuns.tenantId, context.tenantId),
              eq(automationRuns.rootCausationId, event.rootCausationId ?? event.eventId),
              eq(automationRuns.recordId, event.recordId),
              eq(automationRuns.ruleId, candidate.rule.id),
              eq(automationRuns.status, 'FAILED'),
            ));
            const [repeated] = await tx.select({ id: automationRuns.id }).from(automationRuns).where(and(
              eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.rootCausationId, event.rootCausationId ?? event.eventId),
              eq(automationRuns.recordId, event.recordId), eq(automationRuns.ruleId, candidate.rule.id),
            )).limit(1);
            const status = event.causationDepth >= 5 ? 'CHAIN_DEPTH_EXCEEDED'
              : failedRuns.length >= AUTOMATION_PROBLEM_CHAIN_FAILURE_LIMIT ? 'CHAIN_PAUSED'
              : repeated ? 'BLOCKED_CYCLE'
              : !grantValid ? 'SKIPPED_UNAUTHORIZED'
                : !eventSnapshotPass ? 'SKIPPED_CONDITION'
                  : !currentPass ? 'SKIPPED_STALE'
                    : 'EXECUTE';
            const [run] = await tx.insert(automationRuns).values({
              tenantId: context.tenantId, appId: event.appId, ruleId: candidate.rule.id,
              ruleVersion: candidate.version.version, eventId: event.eventId,
              triggerIdentity: `${eventType}:${event.eventId}`, idempotencyKey: identity,
              recordId: event.recordId, rootCausationId: event.rootCausationId ?? event.eventId,
              parentRunId: event.parentRunId, causationDepth: event.causationDepth + 1,
              originRuleId: event.originRuleId, originActionId: event.originActionId,
              status: status === 'EXECUTE' ? 'RUNNING' : status, lastError: null,
              completedAt: status === 'EXECUTE' ? null : sql`clock_timestamp()`,
            }).onConflictDoNothing().returning();
            if (!run) continue;
            createdRuns++;
            if (status === 'CHAIN_DEPTH_EXCEEDED' || status === 'CHAIN_PAUSED') {
              await tx.insert(automationProblemChains).values({
                tenantId: context.tenantId, rootCausationId: event.rootCausationId ?? event.eventId,
                reason: status === 'CHAIN_DEPTH_EXCEEDED'
                  ? 'CAUSATION_DEPTH_EXCEEDED'
                  : `REPEATED_FAILURES_LIMIT_${AUTOMATION_PROBLEM_CHAIN_FAILURE_LIMIT}`,
                lastRunId: run.id,
              }).onConflictDoNothing();
              // P3-C C-2: CHAIN_PAUSED is a real audit action from here --
              // every chain pause (repeated failures or depth limit) writes
              // exactly one audit row, keyed to the run that paused it.
              await tx.insert(automationAuditEvents).values({
                tenantId: context.tenantId, appId: event.appId, ruleId: candidate.rule.id,
                ruleVersion: candidate.version.version, ...auditActor(context), action: 'CHAIN_PAUSED',
                details: { rootCausationId: event.rootCausationId ?? event.eventId, runId: run.id, reason: status },
              });
              const admins = await tx.select({ userId: tenantMembers.userId }).from(tenantMembers).where(and(
                eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.isAdmin, true), isNull(tenantMembers.disabledAt),
              ));
              for (const { userId } of admins) await tx.insert(notifications).values({
                tenantId: context.tenantId, userId, sourceType: 'SYSTEM',
                ruleKey: 'AUTOMATION_PROBLEM_CHAIN_PAUSED',
                title: 'Automation problem chain paused',
                body: status === 'CHAIN_DEPTH_EXCEEDED'
                  ? 'An automation chain exceeded the five-run depth limit and was paused.'
                  : 'An automation problem chain repeated failures and was paused.',
                sourceEventId: event.eventId, dedupKey: `automation-chain-paused:${event.rootCausationId ?? event.eventId}`,
                eventType: 'AUTOMATION_PROBLEM_CHAIN_PAUSED', targetRole: 'TENANT_ADMIN',
                payload: { runId: run.id, ruleId: candidate.rule.id, reason: status },
                emailState: 'skipped',
              }).onConflictDoNothing();
            }
            const insertedActions: { actionId: string; idempotencyKey: string }[] = [];
            for (const [position, action] of cfg.actions.entries()) {
              const [row] = await tx.insert(automationRunActions).values({
                tenantId: context.tenantId, appId: event.appId, runId: run.id, actionId: action.actionId,
                position, status: status === 'EXECUTE' ? 'PENDING' : 'NOT_EXECUTED',
                idempotencyKey: `${identity}:${action.actionId}`,
                errorCode: status === 'EXECUTE' ? null : status,
                completedAt: status === 'EXECUTE' ? null : sql`clock_timestamp()`,
              }).onConflictDoNothing().returning();
              if (row) insertedActions.push({ actionId: row.actionId, idempotencyKey: row.idempotencyKey });
            }
            if (status === 'EXECUTE') {
              await this.executeActions(tx, { tenantId: context.tenantId, userId: grant.approvedBy }, {
                runId: run.id, appId: event.appId, ruleId: candidate.rule.id,
                rootCausationId: run.rootCausationId, causationDepth: run.causationDepth,
                cfg, record: serializeRecord(current!), eventId: event.eventId,
                actionRows: cfg.actions.flatMap((action) => {
                  const row = insertedActions.find((entry) => entry.actionId === action.actionId);
                  return row ? [{ action, row }] : [];
                }),
                readableFieldIds: grant.readableFieldIds,
              });
            }
            if (status === 'CHAIN_DEPTH_EXCEEDED') {
              const admins = await tx.select({ userId: tenantMembers.userId }).from(tenantMembers).where(and(
                eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.isAdmin, true), isNull(tenantMembers.disabledAt),
              ));
              for (const { userId } of admins) await tx.insert(notifications).values({
                tenantId: context.tenantId, userId, sourceType: 'SYSTEM', ruleKey: 'AUTOMATION_CHAIN_DEPTH_EXCEEDED',
                title: 'Automation chain stopped', body: 'An automation chain exceeded the five-run depth limit.',
                sourceEventId: event.eventId, dedupKey: `automation-chain:${event.rootCausationId ?? event.eventId}:${candidate.rule.id}`,
                eventType: 'AUTOMATION_CHAIN_DEPTH_EXCEEDED', targetRole: 'TENANT_ADMIN',
                payload: { runId: run.id, ruleId: candidate.rule.id }, emailState: 'skipped',
              }).onConflictDoNothing();
            }
          }
        }
        await tx.update(outbox).set({ automationProcessedAt: sql`clock_timestamp()` })
          .where(and(eq(outbox.tenantId, context.tenantId), eq(outbox.appId, event.appId), eq(outbox.eventId, event.eventId)));
      }
      return { events: rows.length, createdRuns };
    });
  }


  // ---------------------------------------------------------------------
  // P3-C fixed cadence (T-3): persistent plans, atomic claiming, missed
  // policy, per-slot batched execution over the SAME action engine, run
  // idempotency keys and guardrails as event runs. No second execution
  // path is introduced: a schedule run differs from an event run only in
  // its trigger identity (schedule:<slot key>[:catchup]) and batch_id.
  // ---------------------------------------------------------------------

  private scheduleConfigOf(cfg: AutomationRuleConfig): FixedScheduleConfig | null {
    if (cfg.trigger.eventType !== 'schedule.fixed' || !cfg.trigger.schedule) return null;
    const schedule = cfg.trigger.schedule;
    return {
      cadence: schedule.cadence, localTime: schedule.localTime, timezone: schedule.timezone,
      weekdays: schedule.weekdays, monthDay: schedule.monthDay,
      missedRunPolicy: schedule.missedRunPolicy ?? 'skip',
    };
  }

  private async refreshCadencePlan(tx: TenantTransaction, tenantId: string, appId: string,
    ruleId: string, version: typeof automationRuleVersions.$inferSelect, now = new Date()) {
    const schedule = this.scheduleConfigOf(this.configOf(version));
    if (!schedule) return null;
    const [existing] = await tx.select().from(automationCadencePlans).where(and(
      eq(automationCadencePlans.tenantId, tenantId), eq(automationCadencePlans.ruleId, ruleId),
      eq(automationCadencePlans.ruleVersion, version.version)));
    const sameConfig = existing && existing.timezone === schedule.timezone &&
      existing.cadence === schedule.cadence && existing.localTime === schedule.localTime &&
      JSON.stringify(existing.weekdays ?? null) === JSON.stringify(schedule.weekdays ?? null) &&
      existing.monthDay === (schedule.monthDay ?? null) &&
      existing.missedRunPolicy === (schedule.missedRunPolicy ?? 'skip');
    // An active plan with the same configuration is left untouched, even
    // when already due: recomputing next-due here would silently drop the
    // pending slot. Refresh only creates, revives (INVALIDATED) or
    // re-bases a plan whose configuration changed.
    if (existing?.status === 'ACTIVE' && sameConfig) return existing;
    const next = nextSlotAfter(schedule, now);
    const [plan] = await tx.insert(automationCadencePlans).values({
      tenantId, appId, ruleId, ruleVersion: version.version,
      timezone: schedule.timezone, cadence: schedule.cadence, localTime: schedule.localTime,
      weekdays: schedule.weekdays ?? null, monthDay: schedule.monthDay ?? null,
      missedRunPolicy: schedule.missedRunPolicy ?? 'skip',
      status: 'ACTIVE', invalidationReason: null,
      nextDueAt: next.utc.toISOString(), nextSlotKey: next.slotKey, claimToken: null, claimedAt: null,
    }).onConflictDoUpdate({
      target: [automationCadencePlans.tenantId, automationCadencePlans.ruleId, automationCadencePlans.ruleVersion],
      set: {
        timezone: schedule.timezone, cadence: schedule.cadence, localTime: schedule.localTime,
        weekdays: schedule.weekdays ?? null, monthDay: schedule.monthDay ?? null,
        missedRunPolicy: schedule.missedRunPolicy ?? 'skip',
        status: 'ACTIVE', invalidationReason: null,
        nextDueAt: next.utc.toISOString(), nextSlotKey: next.slotKey, claimToken: null, claimedAt: null,
        updatedAt: sql`clock_timestamp()`,
      },
    }).returning();
    return plan;
  }

  private async invalidateCadencePlans(tx: TenantTransaction, tenantId: string, ruleId: string,
    reason: string, scope: { exceptVersion?: number; onlyVersion?: number } = {}) {
    await tx.update(automationCadencePlans).set({
      status: 'INVALIDATED', invalidationReason: reason, claimToken: null, claimedAt: null,
      updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(automationCadencePlans.tenantId, tenantId), eq(automationCadencePlans.ruleId, ruleId),
      eq(automationCadencePlans.status, 'ACTIVE'),
      scope.onlyVersion !== undefined ? eq(automationCadencePlans.ruleVersion, scope.onlyVersion) : undefined,
      scope.exceptVersion !== undefined ? sql`${automationCadencePlans.ruleVersion} <> ${scope.exceptVersion}` : undefined,
    ));
  }

  // Lazily (re)create plans for enabled schedule rules whose plan is
  // missing or invalidated while an active grant exists (defensive: the
  // publish/enable/grant hooks normally maintain plans eagerly).
  private async ensureCadencePlans(tx: TenantTransaction, context: TenantContext, now: Date) {
    const candidates = await tx.select({ rule: automationRules, version: automationRuleVersions })
      .from(automationRules).innerJoin(automationRuleVersions, and(
        eq(automationRuleVersions.tenantId, automationRules.tenantId),
        eq(automationRuleVersions.appId, automationRules.appId),
        eq(automationRuleVersions.ruleId, automationRules.id),
        eq(automationRuleVersions.version, automationRules.currentVersion),
      )).innerJoin(automationGrants, and(
        eq(automationGrants.tenantId, automationRules.tenantId),
        eq(automationGrants.ruleId, automationRules.id),
        eq(automationGrants.ruleVersion, automationRuleVersions.version),
        isNull(automationGrants.revokedAt),
      )).where(and(eq(automationRules.tenantId, context.tenantId),
        eq(automationRules.enabled, true), isNull(automationRules.archivedAt),
        eq(automationRuleVersions.status, 'published'),
        sql`${automationRuleVersions.trigger}->>'eventType' = 'schedule.fixed'`));
    for (const { rule, version } of candidates) {
      const [plan] = await tx.select({ id: automationCadencePlans.id, status: automationCadencePlans.status })
        .from(automationCadencePlans).where(and(
          eq(automationCadencePlans.tenantId, context.tenantId),
          eq(automationCadencePlans.ruleId, rule.id), eq(automationCadencePlans.ruleVersion, version.version)));
      if (!plan || plan.status !== 'ACTIVE') {
        await this.refreshCadencePlan(tx, context.tenantId, rule.appId, rule.id, version, now);
      }
    }
  }

  async processSchedules(context: TenantContext, options: {
    now?: Date; batchLimit?: number; claimLeaseMs?: number;
    onTimeGraceMs?: number; backlogAlertThreshold?: number;
  } = {}) {
    const now = options.now ?? new Date();
    const batchLimit = options.batchLimit ?? AUTOMATION_SCHEDULE_BATCH_LIMIT;
    const leaseMs = options.claimLeaseMs ?? AUTOMATION_SCHEDULE_CLAIM_LEASE_MS;
    const graceMs = options.onTimeGraceMs ?? AUTOMATION_SCHEDULE_ON_TIME_GRACE_MS;
    const alertThreshold = options.backlogAlertThreshold ?? AUTOMATION_SCHEDULE_BACKLOG_ALERT_THRESHOLD;
    const totals = { backlog: 0, claimedPlans: 0, resumedSlots: 0, slotsCompleted: 0, slotsSkipped: 0, runsCreated: 0 };

    // Pass 0: plan maintenance, backlog accounting and admin alerting.
    const duePlanIds = await withTenantTransaction(context, async (tx) => {
      await this.ensureCadencePlans(tx, context, now);
      const due = await tx.execute(sql`
        SELECT p.id AS id FROM automation_cadence_plans p
        JOIN automation_rules r ON r.tenant_id = p.tenant_id AND r.id = p.rule_id
        WHERE p.tenant_id = ${context.tenantId} AND p.status = 'ACTIVE'
          AND p.next_due_at <= ${now.toISOString()} AND r.enabled = true AND r.archived_at IS NULL
          AND r.current_version = p.rule_version
        ORDER BY p.next_due_at, p.id
      `);
      totals.backlog = due.rows.length;
      if (totals.backlog > alertThreshold) {
        const recent = await tx.execute(sql`
          SELECT 1 AS hit FROM automation_audit_events
          WHERE tenant_id = ${context.tenantId} AND action = 'SCHEDULE_BACKLOG_ALERT'
            AND occurred_at >= clock_timestamp() - interval '24 hours' LIMIT 1
        `);
        if (!recent.rows.length) {
          const first = due.rows[0] as { id: string };
          const [plan] = await tx.select().from(automationCadencePlans).where(and(
            eq(automationCadencePlans.tenantId, context.tenantId), eq(automationCadencePlans.id, first.id)));
          if (plan) {
            await tx.insert(automationAuditEvents).values({
              tenantId: context.tenantId, appId: plan.appId, ruleId: plan.ruleId, ruleVersion: plan.ruleVersion,
              ...auditActor(context), action: 'SCHEDULE_BACKLOG_ALERT',
              details: { backlog: totals.backlog, threshold: alertThreshold },
            });
            const admins = await tx.select({ userId: tenantMembers.userId }).from(tenantMembers).where(and(
              eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.isAdmin, true),
              isNull(tenantMembers.disabledAt)));
            for (const { userId } of admins) await tx.insert(notifications).values({
              tenantId: context.tenantId, userId, sourceType: 'SYSTEM',
              ruleKey: 'AUTOMATION_SCHEDULE_BACKLOG',
              title: 'Automation schedule backlog is growing',
              body: `${totals.backlog} fixed-schedule plans are due and unprocessed (alert threshold ${alertThreshold}).`,
              sourceEventId: plan.id, dedupKey: `automation-schedule-backlog:${context.tenantId}:${now.toISOString().slice(0, 10)}`,
              eventType: 'AUTOMATION_SCHEDULE_BACKLOG', targetRole: 'TENANT_ADMIN',
              payload: { backlog: totals.backlog, threshold: alertThreshold }, emailState: 'skipped',
            }).onConflictDoNothing();
          }
        }
      }
      return (due.rows as { id: string }[]).map(({ id }) => id);
    });

    // Pass 1: resume slots left CLAIMED by a dead worker (lease expired).
    const resumable = await withTenantTransaction(context, async (tx) => tx.execute(sql`
      SELECT s.id AS "slotId", s.plan_id AS "planId" FROM automation_cadence_slots s
      JOIN automation_cadence_plans p ON p.tenant_id = s.tenant_id AND p.id = s.plan_id
      WHERE s.tenant_id = ${context.tenantId} AND s.status = 'CLAIMED' AND p.status = 'ACTIVE'
        AND (p.claim_token IS NULL OR p.claimed_at <= ${new Date(now.getTime() - leaseMs).toISOString()})
      ORDER BY s.created_at, s.id
    `));
    for (const row of resumable.rows as { slotId: string; planId: string }[]) {
      const outcome = await this.resumeCadenceSlot(context, row.planId, row.slotId, { now, batchLimit, leaseMs });
      if (outcome) {
        totals.resumedSlots++;
        totals.runsCreated += outcome.runsCreated;
        if (outcome.done) totals.slotsCompleted++;
      }
    }

    // Pass 2: claim and process due plans, one plan at a time.
    for (const planId of duePlanIds) {
      const outcome = await this.processCadencePlan(context, planId, { now, batchLimit, leaseMs, graceMs });
      if (!outcome) continue;
      totals.claimedPlans++;
      totals.runsCreated += outcome.runsCreated;
      totals.slotsCompleted += outcome.slotsCompleted;
      totals.slotsSkipped += outcome.slotsSkipped;
    }
    return totals;
  }

  // Atomically claim one due plan (single conditional UPDATE: concurrent
  // workers race on the row and exactly one wins), classify its due slots
  // under the missed-run policy, and execute the surviving slot(s).
  private async processCadencePlan(context: TenantContext, planId: string, options: {
    now: Date; batchLimit: number; leaseMs: number; graceMs: number;
  }) {
    const { now, batchLimit, leaseMs, graceMs } = options;
    const claimToken = randomUUID();
    const claimed = await withTenantTransaction(context, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE automation_cadence_plans
        SET claim_token = ${claimToken}, claimed_at = ${now.toISOString()}, updated_at = clock_timestamp()
        WHERE tenant_id = ${context.tenantId} AND id = ${planId} AND status = 'ACTIVE'
          AND next_due_at <= ${now.toISOString()}
          AND (claim_token IS NULL OR claimed_at <= ${new Date(now.getTime() - leaseMs).toISOString()})
        RETURNING id
      `);
      return result.rows.length > 0;
    });
    if (!claimed) return null;

    const prepared = await withTenantTransaction(context, async (tx) => {
      const [plan] = await tx.select().from(automationCadencePlans).where(and(
        eq(automationCadencePlans.tenantId, context.tenantId), eq(automationCadencePlans.id, planId)));
      if (!plan || plan.status !== 'ACTIVE' || plan.claimToken !== claimToken) return null;
      const [rule] = await tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.id, plan.ruleId)));
      const version = rule?.currentVersion === plan.ruleVersion
        ? await this.readVersion(tx, context, plan.appId, plan.ruleId, plan.ruleVersion).catch(() => null) : null;
      const [grant] = version ? await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, plan.ruleId),
        eq(automationGrants.ruleVersion, plan.ruleVersion), isNull(automationGrants.revokedAt))) : [];
      const cfg = version ? this.configOf(version) : null;
      const schedule = cfg ? this.scheduleConfigOf(cfg) : null;
      if (!rule?.enabled || rule.archivedAt || !version || version.status !== 'published' || !grant || !cfg || !schedule ||
        !await this.grantCoversExecution(tx, context.tenantId, plan.appId, cfg, grant)) {
        await this.invalidateCadencePlans(tx, context.tenantId, plan.ruleId,
          !rule?.enabled || rule.archivedAt ? 'rule-disabled' : !grant ? 'grant-revoked' : 'version-superseded',
          { onlyVersion: plan.ruleVersion });
        return null;
      }
      const dueSlots = enumerateSlots(schedule, new Date(new Date(plan.nextDueAt).getTime() - 1000), now)
        .filter((slot) => slot.utc >= new Date(plan.nextDueAt) || slot.slotKey === plan.nextSlotKey);
      const fromKey = dueSlots.findIndex((slot) => slot.slotKey === plan.nextSlotKey);
      const pending = fromKey >= 0 ? dueSlots.slice(fromKey) : dueSlots;
      let slotsSkipped = 0;
      const existent: ScheduleSlot[] = [];
      for (const slot of pending) {
        if (!slot.exists) {
          await tx.insert(automationCadenceSlots).values({
            tenantId: context.tenantId, appId: plan.appId, planId: plan.id, ruleId: plan.ruleId,
            ruleVersion: plan.ruleVersion, slotKey: slot.slotKey, localDate: slot.localDate,
            scheduledFor: slot.utc.toISOString(), status: 'SKIPPED_NONEXISTENT_TIME', completedAt: sql`clock_timestamp()`,
          }).onConflictDoNothing();
          slotsSkipped++;
        } else existent.push(slot);
      }
      const missed = existent.filter((slot) => now.getTime() - slot.utc.getTime() > graceMs);
      const onTime = existent.filter((slot) => now.getTime() - slot.utc.getTime() <= graceMs);
      const policy = schedule.missedRunPolicy ?? 'skip';
      const executions: { slot: ScheduleSlot; isCatchup: boolean }[] = [];
      const catchupSlot = policy === 'catch_up_latest' && missed.length ? missed[missed.length - 1] : null;
      for (const slot of missed) {
        if (catchupSlot && slot.slotKey === catchupSlot.slotKey) {
          executions.push({ slot, isCatchup: true });
          continue;
        }
        await tx.insert(automationCadenceSlots).values({
          tenantId: context.tenantId, appId: plan.appId, planId: plan.id, ruleId: plan.ruleId,
          ruleVersion: plan.ruleVersion, slotKey: slot.slotKey, localDate: slot.localDate,
          scheduledFor: slot.utc.toISOString(), status: 'SKIPPED_MISSED', completedAt: sql`clock_timestamp()`,
        }).onConflictDoNothing();
        slotsSkipped++;
      }
      for (const slot of onTime) executions.push({ slot, isCatchup: false });
      const slotRows: (typeof automationCadenceSlots.$inferSelect)[] = [];
      let inFlight = false;
      for (const { slot, isCatchup } of executions) {
        const [row] = await tx.insert(automationCadenceSlots).values({
          tenantId: context.tenantId, appId: plan.appId, planId: plan.id, ruleId: plan.ruleId,
          ruleVersion: plan.ruleVersion, slotKey: slot.slotKey, localDate: slot.localDate,
          scheduledFor: slot.utc.toISOString(), isCatchup, status: 'CLAIMED', batchId: randomUUID(), claimToken,
        }).onConflictDoNothing().returning();
        if (row) slotRows.push(row);
        else {
          // A slot row already exists for this period: if it is still
          // CLAIMED, a previous batch is in flight (batch limit or a
          // crashed worker) -- the resume path owns it, and this pass
          // must not advance the plan past it.
          const [existing] = await tx.select({ status: automationCadenceSlots.status }).from(automationCadenceSlots)
            .where(and(eq(automationCadenceSlots.tenantId, context.tenantId),
              eq(automationCadenceSlots.ruleId, plan.ruleId),
              eq(automationCadenceSlots.ruleVersion, plan.ruleVersion),
              eq(automationCadenceSlots.slotKey, slot.slotKey)));
          if (existing?.status === 'CLAIMED') inFlight = true;
        }
      }
      if (!slotRows.length && inFlight) {
        await tx.update(automationCadencePlans).set({
          claimToken: null, claimedAt: null, updatedAt: sql`clock_timestamp()`,
        }).where(and(eq(automationCadencePlans.tenantId, context.tenantId),
          eq(automationCadencePlans.id, plan.id), eq(automationCadencePlans.claimToken, claimToken)));
      }
      if (!slotRows.length && !inFlight) {
        const next = nextSlotAfter(schedule, now);
        await tx.update(automationCadencePlans).set({
          lastCompletedSlot: pending.length ? pending[pending.length - 1].slotKey : plan.lastCompletedSlot,
          nextDueAt: next.utc.toISOString(), nextSlotKey: next.slotKey, claimToken: null, claimedAt: null,
          updatedAt: sql`clock_timestamp()`,
        }).where(and(eq(automationCadencePlans.tenantId, context.tenantId),
          eq(automationCadencePlans.id, plan.id), eq(automationCadencePlans.claimToken, claimToken)));
      }
      return { plan, cfg, grant, schedule, slotRows, slotsSkipped };
    });
    if (!prepared) return { runsCreated: 0, slotsCompleted: 0, slotsSkipped: 0 };
    let runsCreated = 0, slotsCompleted = 0;
    for (const slotRow of prepared.slotRows) {
      const outcome = await this.executeCadenceSlot(context, prepared.plan, slotRow, prepared.cfg, prepared.grant, batchLimit);
      runsCreated += outcome.runsCreated;
      if (outcome.done) slotsCompleted++;
    }
    return { runsCreated, slotsCompleted, slotsSkipped: prepared.slotsSkipped };
  }

  // Re-acquire a CLAIMED slot whose worker died and continue it from its
  // checkpoint. Already-created runs are protected by their idempotency
  // keys, so resumption never duplicates a logical run.
  private async resumeCadenceSlot(context: TenantContext, planId: string, slotId: string, options: {
    now: Date; batchLimit: number; leaseMs: number;
  }) {
    const claimToken = randomUUID();
    const prepared = await withTenantTransaction(context, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE automation_cadence_plans
        SET claim_token = ${claimToken}, claimed_at = ${options.now.toISOString()}, updated_at = clock_timestamp()
        WHERE tenant_id = ${context.tenantId} AND id = ${planId} AND status = 'ACTIVE'
          AND (claim_token IS NULL OR claimed_at <= ${new Date(options.now.getTime() - options.leaseMs).toISOString()})
        RETURNING id
      `);
      if (!result.rows.length) return null;
      const [plan] = await tx.select().from(automationCadencePlans).where(and(
        eq(automationCadencePlans.tenantId, context.tenantId), eq(automationCadencePlans.id, planId)));
      const [slotRow] = await tx.select().from(automationCadenceSlots).where(and(
        eq(automationCadenceSlots.tenantId, context.tenantId), eq(automationCadenceSlots.id, slotId),
        eq(automationCadenceSlots.status, 'CLAIMED')));
      if (!plan || !slotRow) return null;
      await tx.update(automationCadenceSlots).set({ claimToken }).where(and(
        eq(automationCadenceSlots.tenantId, context.tenantId), eq(automationCadenceSlots.id, slotId)));
      const version = await this.readVersion(tx, context, plan.appId, plan.ruleId, plan.ruleVersion).catch(() => null);
      const [grant] = version ? await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, plan.ruleId),
        eq(automationGrants.ruleVersion, plan.ruleVersion), isNull(automationGrants.revokedAt))) : [];
      if (!version || !grant) return null;
      const cfg = this.configOf(version);
      if (!await this.grantCoversExecution(tx, context.tenantId, plan.appId, cfg, grant)) return null;
      return { plan, slotRow: { ...slotRow, claimToken }, cfg, grant };
    });
    if (!prepared) return null;
    return this.executeCadenceSlot(context, prepared.plan, prepared.slotRow, prepared.cfg, prepared.grant, options.batchLimit);
  }

  // Execute one claimed slot: scan candidate records in stable id order,
  // filter by the rule conditions, and create + execute one run per
  // matching record through the shared action engine. At most batchLimit
  // candidates are examined per call; the slot checkpoint (cursor +
  // processed count) is persisted per record, in the same transaction as
  // that record's run, so a crash loses at most the in-flight record and
  // resumption continues exactly where the checkpoint stopped.
  private async executeCadenceSlot(context: TenantContext, plan: typeof automationCadencePlans.$inferSelect,
    slotRow: typeof automationCadenceSlots.$inferSelect, cfg: AutomationRuleConfig,
    grant: typeof automationGrants.$inferSelect, batchLimit: number) {
    let cursor = slotRow.cursorRecordId;
    let processed = slotRow.processedCount;
    let runsCreated = 0;
    const candidates = await withTenantTransaction(context, async (tx) => tx.select().from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, plan.appId), isNull(records.deletedAt),
      cursor ? sql`${records.id} > ${cursor}` : undefined,
    )).orderBy(records.id).limit(batchLimit));
    for (const candidate of candidates) {
      const matches = evaluateGroup(candidate.data, cfg.conditions.eventSnapshot, []) &&
        evaluateGroup(candidate.data, cfg.conditions.currentState, []);
      await withTenantTransaction(context, async (tx) => {
        if (matches) {
          const identity = `${plan.appId}:schedule:${plan.ruleId}:${plan.ruleVersion}:${slotRow.slotKey}:${candidate.id}`;
          const runId = randomUUID();
          const [run] = await tx.insert(automationRuns).values({
            id: runId, tenantId: context.tenantId, appId: plan.appId, ruleId: plan.ruleId,
            ruleVersion: plan.ruleVersion, eventId: null,
            triggerIdentity: `schedule:${slotRow.slotKey}${slotRow.isCatchup ? ':catchup' : ''}`,
            idempotencyKey: identity, recordId: candidate.id, batchId: slotRow.batchId,
            rootCausationId: slotRow.batchId ?? runId, parentRunId: null, causationDepth: 1,
            originRuleId: plan.ruleId, originActionId: null, status: 'RUNNING',
          }).onConflictDoNothing().returning();
          if (run) {
            runsCreated++;
            const actionRows: { action: AutomationRuleConfig['actions'][number];
              row: { actionId: string; idempotencyKey: string } }[] = [];
            for (const [position, action] of cfg.actions.entries()) {
              const [row] = await tx.insert(automationRunActions).values({
                tenantId: context.tenantId, appId: plan.appId, runId: run.id, actionId: action.actionId,
                position, status: 'PENDING', idempotencyKey: `${identity}:${action.actionId}`,
              }).onConflictDoNothing().returning();
              if (row) actionRows.push({ action, row: { actionId: row.actionId, idempotencyKey: row.idempotencyKey } });
            }
            await this.executeActions(tx, { tenantId: context.tenantId, userId: grant.approvedBy }, {
              runId: run.id, appId: plan.appId, ruleId: plan.ruleId,
              rootCausationId: run.rootCausationId, causationDepth: run.causationDepth,
              cfg, record: serializeRecord(candidate), eventId: null, actionRows,
              readableFieldIds: grant.readableFieldIds,
            });
          }
        }
        processed++;
        cursor = candidate.id;
        await tx.update(automationCadenceSlots).set({
          cursorRecordId: candidate.id, processedCount: processed,
        }).where(and(eq(automationCadenceSlots.tenantId, context.tenantId),
          eq(automationCadenceSlots.id, slotRow.id), eq(automationCadenceSlots.status, 'CLAIMED')));
      });
    }
    let done = candidates.length < batchLimit;
    if (!done) {
      const remaining = await withTenantTransaction(context, async (tx) => tx.select({ id: records.id }).from(records)
        .where(and(eq(records.tenantId, context.tenantId), eq(records.appId, plan.appId),
          isNull(records.deletedAt), sql`${records.id} > ${cursor}`)).limit(1));
      done = remaining.length === 0;
    }
    if (done) {
      const schedule = this.scheduleConfigOf(cfg);
      await withTenantTransaction(context, async (tx) => {
        await tx.update(automationCadenceSlots).set({
          status: 'COMPLETED', completedAt: sql`clock_timestamp()`,
        }).where(and(eq(automationCadenceSlots.tenantId, context.tenantId),
          eq(automationCadenceSlots.id, slotRow.id), eq(automationCadenceSlots.status, 'CLAIMED')));
        if (schedule) {
          const next = nextSlotAfter(schedule, new Date(slotRow.scheduledFor));
          await tx.update(automationCadencePlans).set({
            lastCompletedSlot: slotRow.slotKey, nextDueAt: next.utc.toISOString(), nextSlotKey: next.slotKey,
            claimToken: null, claimedAt: null, updatedAt: sql`clock_timestamp()`,
          }).where(and(eq(automationCadencePlans.tenantId, context.tenantId),
            eq(automationCadencePlans.id, plan.id), eq(automationCadencePlans.status, 'ACTIVE'),
            sql`(${automationCadencePlans.claimToken} = ${slotRow.claimToken} OR ${automationCadencePlans.claimToken} IS NULL OR ${automationCadencePlans.nextSlotKey} = ${slotRow.slotKey})`));
        }
      });
    }
    return { runsCreated, done };
  }

  // ---------------------------------------------------------------------
  // P3-C date-relative (T-3 lower half): per-record persistent plans in
  // automation_schedules, maintained by record lifecycle events and by a
  // checkpointed backfill, consumed by the same worker loop and the same
  // executeActions engine as every other trigger. Brief 3.2 contract:
  // date change invalidates + regenerates, delete / disable / revoke /
  // version change invalidate, execution revalidates the live record,
  // 24 actual hours of lateness execute as LATE, beyond that MISSED.
  // ---------------------------------------------------------------------

  private dateRelativeConfigOf(cfg: AutomationRuleConfig): DateRelativeConfig | null {
    if (cfg.trigger.eventType !== 'schedule.dateRelative' || !cfg.trigger.dateRelative) return null;
    const relative = cfg.trigger.dateRelative;
    return {
      source: relative.source, fieldId: relative.fieldId, offsetDays: relative.offsetDays,
      localTime: relative.localTime, timezone: relative.timezone,
    };
  }

  private sourceDateForRecord(relative: DateRelativeConfig,
    record: { data: Record<string, unknown>; createdAt: Date | string }): string | null {
    if (relative.source === 'createdAt') return isoDateInZone(new Date(record.createdAt), relative.timezone);
    const raw = relative.fieldId ? record.data[relative.fieldId] : undefined;
    return isIsoDate(raw) ? raw : null;
  }

  // Regenerate (or invalidate) the single logical plan of one record
  // under one rule version. Idempotent: re-running the sync for an
  // unchanged record changes nothing.
  private async syncDateRelativePlan(tx: TenantTransaction, args: {
    tenantId: string; appId: string; ruleId: string; ruleVersion: number;
    cfg: AutomationRuleConfig;
    record: { id: string; data: Record<string, unknown>; createdAt: Date | string; deletedAt: Date | string | null };
  }) {
    const relative = this.dateRelativeConfigOf(args.cfg);
    if (!relative) return;
    const key = dateRelativeScheduleKey(relative);
    const scope = and(eq(automationSchedules.tenantId, args.tenantId),
      eq(automationSchedules.ruleId, args.ruleId), eq(automationSchedules.ruleVersion, args.ruleVersion),
      eq(automationSchedules.recordId, args.record.id), eq(automationSchedules.scheduleKey, key));
    const [existing] = await tx.select().from(automationSchedules).where(scope);
    const invalidateExisting = async (reason: string) => {
      if (existing?.status !== 'PENDING') return;
      await tx.update(automationSchedules).set({
        status: 'INVALIDATED', invalidatedAt: sql`clock_timestamp()`, invalidationReason: reason,
        claimToken: null, claimedAt: null,
      }).where(scope);
    };
    if (args.record.deletedAt) {
      await invalidateExisting('record-deleted');
      return;
    }
    const sourceDate = this.sourceDateForRecord(relative, args.record);
    if (!sourceDate) {
      await invalidateExisting('date-cleared');
      return;
    }
    const { dueAt } = dateRelativeDueAt(sourceDate, relative);
    if (!existing) {
      await tx.insert(automationSchedules).values({
        tenantId: args.tenantId, appId: args.appId, ruleId: args.ruleId, ruleVersion: args.ruleVersion,
        recordId: args.record.id, scheduleKey: key, dueAt: dueAt.toISOString(), status: 'PENDING',
        sourceDate,
      }).onConflictDoNothing();
      return;
    }
    if (existing.status === 'PENDING') {
      if (existing.sourceDate !== sourceDate || new Date(existing.dueAt).getTime() !== dueAt.getTime()) {
        await tx.update(automationSchedules).set({
          dueAt: dueAt.toISOString(), sourceDate, claimToken: null, claimedAt: null,
        }).where(scope);
      }
      return;
    }
    if (existing.status === 'INVALIDATED') {
      await tx.update(automationSchedules).set({
        status: 'PENDING', dueAt: dueAt.toISOString(), sourceDate,
        invalidatedAt: null, invalidationReason: null, claimToken: null, claimedAt: null, executedAt: null,
      }).where(scope);
      return;
    }
    // Terminal rows (SUCCEEDED / LATE / MISSED / FAILED / CANCELLED) are
    // the execution evidence for their source date: they only reopen
    // when the source date itself moved, which is a new logical plan
    // wearing the same identity (the run history keeps the old proof).
    if (existing.sourceDate !== sourceDate) {
      await tx.update(automationSchedules).set({
        status: 'PENDING', dueAt: dueAt.toISOString(), sourceDate,
        invalidatedAt: null, invalidationReason: null, claimToken: null, claimedAt: null, executedAt: null,
      }).where(scope);
    }
  }

  private async syncDateRelativePlanForEvent(tx: TenantTransaction, tenantId: string,
    candidate: { rule: typeof automationRules.$inferSelect; version: typeof automationRuleVersions.$inferSelect },
    event: { appId: string; recordId: string }) {
    const [record] = await tx.select().from(records).where(and(
      eq(records.tenantId, tenantId), eq(records.appId, event.appId), eq(records.id, event.recordId)));
    if (!record) {
      await tx.update(automationSchedules).set({
        status: 'INVALIDATED', invalidatedAt: sql`clock_timestamp()`, invalidationReason: 'record-deleted',
        claimToken: null, claimedAt: null,
      }).where(and(eq(automationSchedules.tenantId, tenantId),
        eq(automationSchedules.ruleId, candidate.rule.id),
        eq(automationSchedules.ruleVersion, candidate.version.version),
        eq(automationSchedules.recordId, event.recordId), eq(automationSchedules.status, 'PENDING')));
      return;
    }
    await this.syncDateRelativePlan(tx, {
      tenantId, appId: event.appId, ruleId: candidate.rule.id, ruleVersion: candidate.version.version,
      cfg: this.configOf(candidate.version), record,
    });
  }

  private async invalidateDateRelativePlans(tx: TenantTransaction, tenantId: string, ruleId: string,
    reason: string, scope: { exceptVersion?: number; onlyVersion?: number } = {}) {
    await tx.update(automationSchedules).set({
      status: 'INVALIDATED', invalidatedAt: sql`clock_timestamp()`, invalidationReason: reason,
      claimToken: null, claimedAt: null,
    }).where(and(
      eq(automationSchedules.tenantId, tenantId), eq(automationSchedules.ruleId, ruleId),
      eq(automationSchedules.status, 'PENDING'),
      scope.onlyVersion !== undefined ? eq(automationSchedules.ruleVersion, scope.onlyVersion) : undefined,
      scope.exceptVersion !== undefined ? sql`${automationSchedules.ruleVersion} <> ${scope.exceptVersion}` : undefined,
    ));
    // Invalidated plans must be regenerated by a fresh scan if the rule
    // becomes eligible again, so the affected backfill jobs restart from
    // a null cursor (the worker only processes jobs of eligible rules,
    // so a reset job for a disabled rule simply waits).
    await tx.update(automationDateBackfills).set({
      status: 'RUNNING', cursorRecordId: null, processedCount: 0, updatedAt: sql`clock_timestamp()`,
    }).where(and(
      eq(automationDateBackfills.tenantId, tenantId), eq(automationDateBackfills.ruleId, ruleId),
      scope.onlyVersion !== undefined ? eq(automationDateBackfills.ruleVersion, scope.onlyVersion) : undefined,
      scope.exceptVersion !== undefined ? sql`${automationDateBackfills.ruleVersion} <> ${scope.exceptVersion}` : undefined,
    ));
  }

  private async ensureDateBackfill(tx: TenantTransaction, tenantId: string, appId: string,
    ruleId: string, version: typeof automationRuleVersions.$inferSelect) {
    if (!this.dateRelativeConfigOf(this.configOf(version))) return null;
    const [job] = await tx.insert(automationDateBackfills).values({
      tenantId, appId, ruleId, ruleVersion: version.version, status: 'RUNNING',
    }).onConflictDoNothing().returning();
    if (job) return job;
    const [existing] = await tx.select().from(automationDateBackfills).where(and(
      eq(automationDateBackfills.tenantId, tenantId), eq(automationDateBackfills.ruleId, ruleId),
      eq(automationDateBackfills.ruleVersion, version.version)));
    return existing ?? null;
  }

  // Lazily create backfill jobs for enabled date-relative rules with an
  // active grant (defensive: publish/enable/grant hooks create them
  // eagerly, mirroring ensureCadencePlans).
  private async ensureDateBackfills(tx: TenantTransaction, context: TenantContext) {
    const candidates = await tx.select({ rule: automationRules, version: automationRuleVersions })
      .from(automationRules).innerJoin(automationRuleVersions, and(
        eq(automationRuleVersions.tenantId, automationRules.tenantId),
        eq(automationRuleVersions.appId, automationRules.appId),
        eq(automationRuleVersions.ruleId, automationRules.id),
        eq(automationRuleVersions.version, automationRules.currentVersion),
      )).innerJoin(automationGrants, and(
        eq(automationGrants.tenantId, automationRules.tenantId),
        eq(automationGrants.ruleId, automationRules.id),
        eq(automationGrants.ruleVersion, automationRuleVersions.version),
        isNull(automationGrants.revokedAt),
      )).where(and(eq(automationRules.tenantId, context.tenantId),
        eq(automationRules.enabled, true), isNull(automationRules.archivedAt),
        eq(automationRuleVersions.status, 'published'),
        sql`${automationRuleVersions.trigger}->>'eventType' = 'schedule.dateRelative'`));
    for (const { rule, version } of candidates) {
      await this.ensureDateBackfill(tx, context.tenantId, rule.appId, rule.id, version);
    }
  }

  async processDateRelativeSchedules(context: TenantContext, options: {
    now?: Date; batchLimit?: number; claimLeaseMs?: number;
    lateWindowMs?: number; missedAlertThreshold?: number;
  } = {}) {
    const now = options.now ?? new Date();
    const batchLimit = options.batchLimit ?? AUTOMATION_SCHEDULE_BATCH_LIMIT;
    const leaseMs = options.claimLeaseMs ?? AUTOMATION_SCHEDULE_CLAIM_LEASE_MS;
    const lateWindowMs = options.lateWindowMs ?? AUTOMATION_DATE_RELATIVE_LATE_WINDOW_MS;
    const missedAlertThreshold = options.missedAlertThreshold ?? AUTOMATION_DATE_RELATIVE_MISSED_ALERT_THRESHOLD;
    const totals = {
      backfilledRecords: 0, backfillJobsCompleted: 0, claimed: 0,
      executed: 0, late: 0, missed: 0, invalidated: 0, cancelled: 0, failed: 0,
    };

    // Pass A: stock backfill (checkpointed, resumable, never executes).
    const jobs = await withTenantTransaction(context, async (tx) => {
      await this.ensureDateBackfills(tx, context);
      return tx.select().from(automationDateBackfills).where(and(
        eq(automationDateBackfills.tenantId, context.tenantId),
        eq(automationDateBackfills.status, 'RUNNING'),
      )).orderBy(automationDateBackfills.createdAt, automationDateBackfills.id);
    });
    for (const job of jobs) {
      const outcome = await this.processDateBackfill(context, job, batchLimit);
      totals.backfilledRecords += outcome.processed;
      if (outcome.completed) totals.backfillJobsCompleted++;
    }

    // Pass B: consume due plans.
    const dueIds = await withTenantTransaction(context, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id FROM automation_schedules
        WHERE tenant_id = ${context.tenantId} AND status = 'PENDING' AND due_at <= ${now.toISOString()}
        ORDER BY due_at, id LIMIT ${batchLimit}
      `);
      return (rows.rows as { id: string }[]).map(({ id }) => id);
    });
    let missedSample: typeof automationSchedules.$inferSelect | null = null;
    for (const planId of dueIds) {
      const outcome = await this.processDateRelativePlan(context, planId, { now, leaseMs, lateWindowMs });
      if (!outcome) continue;
      totals.claimed++;
      if (outcome.executed) totals.executed++;
      if (outcome.late) totals.late++;
      if (outcome.missed) { totals.missed++; missedSample ??= outcome.plan; }
      if (outcome.invalidated) totals.invalidated++;
      if (outcome.cancelled) totals.cancelled++;
      if (outcome.failed) totals.failed++;
    }

    // Pass C: aggregated MISSED alert (one summary per tenant per day,
    // never one message per missed plan).
    if (totals.missed >= missedAlertThreshold && missedSample) {
      const sample: typeof automationSchedules.$inferSelect = missedSample;
      await withTenantTransaction(context, async (tx) => {
        const recent = await tx.execute(sql`
          SELECT 1 AS hit FROM automation_audit_events
          WHERE tenant_id = ${context.tenantId} AND action = 'SCHEDULE_MISSED_ALERT'
            AND occurred_at >= clock_timestamp() - interval '24 hours' LIMIT 1
        `);
        if (recent.rows.length) return;
        await tx.insert(automationAuditEvents).values({
          tenantId: context.tenantId, appId: sample.appId, ruleId: sample.ruleId, ruleVersion: sample.ruleVersion,
          ...auditActor(context), action: 'SCHEDULE_MISSED_ALERT',
          details: { missedCount: totals.missed, threshold: missedAlertThreshold },
        });
        const admins = await tx.select({ userId: tenantMembers.userId }).from(tenantMembers).where(and(
          eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.isAdmin, true),
          isNull(tenantMembers.disabledAt)));
        for (const { userId } of admins) await tx.insert(notifications).values({
          tenantId: context.tenantId, userId, sourceType: 'SYSTEM',
          ruleKey: 'AUTOMATION_SCHEDULE_MISSED',
          title: 'Date-relative reminders were missed',
          body: `${totals.missed} date-relative reminder plans passed the 24-hour late window and were marked MISSED without executing.`,
          sourceEventId: sample.id, dedupKey: `automation-schedule-missed:${context.tenantId}:${now.toISOString().slice(0, 10)}`,
          eventType: 'AUTOMATION_SCHEDULE_MISSED', targetRole: 'TENANT_ADMIN',
          payload: { missedCount: totals.missed, threshold: missedAlertThreshold }, emailState: 'skipped',
        }).onConflictDoNothing();
      });
    }
    return totals;
  }

  // One backfill batch for one rule version: stable id cursor, at most
  // batchLimit records, checkpoint persisted per record in the same
  // transaction as that record's plan sync. Backfill only writes plans;
  // it never executes them (past-due stock is left for the due pass,
  // which applies the brief's late/MISSED rules instead of bursting).
  private async processDateBackfill(context: TenantContext,
    job: typeof automationDateBackfills.$inferSelect, batchLimit: number) {
    const prepared = await withTenantTransaction(context, async (tx) => {
      const [rule] = await tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.id, job.ruleId)));
      const version = rule?.currentVersion === job.ruleVersion
        ? await this.readVersion(tx, context, job.appId, job.ruleId, job.ruleVersion).catch(() => null) : null;
      const [grant] = version ? await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, job.ruleId),
        eq(automationGrants.ruleVersion, job.ruleVersion), isNull(automationGrants.revokedAt))) : [];
      const cfg = version ? this.configOf(version) : null;
      if (!rule?.enabled || rule.archivedAt || !version || version.status !== 'published' || !grant || !cfg ||
        !this.dateRelativeConfigOf(cfg) ||
        !await this.grantCoversExecution(tx, context.tenantId, job.appId, cfg, grant)) {
        await tx.update(automationDateBackfills).set({
          status: 'COMPLETED', updatedAt: sql`clock_timestamp()`,
        }).where(and(eq(automationDateBackfills.tenantId, context.tenantId),
          eq(automationDateBackfills.id, job.id), eq(automationDateBackfills.status, 'RUNNING')));
        return null;
      }
      return { cfg };
    });
    if (!prepared) return { processed: 0, completed: true };
    let cursor = job.cursorRecordId;
    let processed = job.processedCount;
    let batchProcessed = 0;
    const candidates = await withTenantTransaction(context, async (tx) => tx.select().from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, job.appId), isNull(records.deletedAt),
      cursor ? sql`${records.id} > ${cursor}` : undefined,
    )).orderBy(records.id).limit(batchLimit));
    for (const candidate of candidates) {
      await withTenantTransaction(context, async (tx) => {
        await this.syncDateRelativePlan(tx, {
          tenantId: context.tenantId, appId: job.appId, ruleId: job.ruleId, ruleVersion: job.ruleVersion,
          cfg: prepared.cfg, record: candidate,
        });
        processed++;
        batchProcessed++;
        cursor = candidate.id;
        await tx.update(automationDateBackfills).set({
          cursorRecordId: candidate.id, processedCount: processed, updatedAt: sql`clock_timestamp()`,
        }).where(and(eq(automationDateBackfills.tenantId, context.tenantId),
          eq(automationDateBackfills.id, job.id)));
      });
    }
    let completed = candidates.length < batchLimit;
    if (!completed) {
      const remaining = await withTenantTransaction(context, async (tx) => tx.select({ id: records.id }).from(records)
        .where(and(eq(records.tenantId, context.tenantId), eq(records.appId, job.appId),
          isNull(records.deletedAt), sql`${records.id} > ${cursor}`)).limit(1));
      completed = remaining.length === 0;
    }
    if (completed) {
      await withTenantTransaction(context, async (tx) => {
        await tx.update(automationDateBackfills).set({
          status: 'COMPLETED', updatedAt: sql`clock_timestamp()`,
        }).where(and(eq(automationDateBackfills.tenantId, context.tenantId),
          eq(automationDateBackfills.id, job.id), eq(automationDateBackfills.status, 'RUNNING')));
      });
    }
    return { processed: batchProcessed, completed };
  }

  // Claim and consume one due date-relative plan. The claim is a single
  // conditional UPDATE (exactly one worker wins); a claimed plan whose
  // worker died becomes claimable again after the lease, and the run
  // idempotency key (which embeds the plan identity) makes resumption
  // duplicate-safe.
  private async processDateRelativePlan(context: TenantContext, planId: string, options: {
    now: Date; leaseMs: number; lateWindowMs: number;
  }) {
    const { now, leaseMs, lateWindowMs } = options;
    const claimToken = randomUUID();
    const claimed = await withTenantTransaction(context, async (tx) => {
      const result = await tx.execute(sql`
        UPDATE automation_schedules
        SET claim_token = ${claimToken}, claimed_at = ${now.toISOString()}
        WHERE tenant_id = ${context.tenantId} AND id = ${planId} AND status = 'PENDING'
          AND (claim_token IS NULL OR claimed_at <= ${new Date(now.getTime() - leaseMs).toISOString()})
        RETURNING id
      `);
      return result.rows.length > 0;
    });
    if (!claimed) return null;
    return withTenantTransaction(context, async (tx) => {
      const [plan] = await tx.select().from(automationSchedules).where(and(
        eq(automationSchedules.tenantId, context.tenantId), eq(automationSchedules.id, planId)));
      if (!plan || plan.status !== 'PENDING' || plan.claimToken !== claimToken) return null;
      const finalize = async (status: string, extra: {
        invalidated?: boolean; reason?: string; executed?: boolean;
      } = {}) => {
        await tx.update(automationSchedules).set({
          status, claimToken: null, claimedAt: null,
          executedAt: extra.executed ? sql`clock_timestamp()` : plan.executedAt,
          invalidatedAt: extra.invalidated ? sql`clock_timestamp()` : plan.invalidatedAt,
          invalidationReason: extra.reason ?? plan.invalidationReason,
        }).where(and(eq(automationSchedules.tenantId, context.tenantId),
          eq(automationSchedules.id, plan.id), eq(automationSchedules.claimToken, claimToken)));
      };
      const [rule] = await tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.id, plan.ruleId)));
      const version = rule?.currentVersion === plan.ruleVersion
        ? await this.readVersion(tx, context, plan.appId, plan.ruleId, plan.ruleVersion).catch(() => null) : null;
      const [grant] = version ? await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, plan.ruleId),
        eq(automationGrants.ruleVersion, plan.ruleVersion), isNull(automationGrants.revokedAt))) : [];
      const cfg = version ? this.configOf(version) : null;
      const relative = cfg ? this.dateRelativeConfigOf(cfg) : null;
      if (!rule?.enabled || rule.archivedAt || !version || version.status !== 'published' || !cfg || !relative) {
        await finalize('INVALIDATED', {
          invalidated: true,
          reason: !rule?.enabled || rule.archivedAt ? 'rule-disabled' : 'version-superseded',
        });
        return { plan, invalidated: true };
      }
      if (!grant || !await this.grantCoversExecution(tx, context.tenantId, plan.appId, cfg, grant)) {
        await finalize('INVALIDATED', { invalidated: true, reason: 'grant-revoked' });
        return { plan, invalidated: true };
      }
      const [record] = await tx.select().from(records).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, plan.appId), eq(records.id, plan.recordId)));
      if (!record || record.deletedAt) {
        await finalize('INVALIDATED', { invalidated: true, reason: 'record-deleted' });
        return { plan, invalidated: true };
      }
      const lateMs = now.getTime() - new Date(plan.dueAt).getTime();
      if (lateMs > lateWindowMs) {
        await finalize('MISSED');
        return { plan, missed: true };
      }
      const currentSource = this.sourceDateForRecord(relative, record);
      if (currentSource !== plan.sourceDate) {
        await finalize('INVALIDATED', { invalidated: true, reason: 'date-changed' });
        return { plan, invalidated: true };
      }
      const matches = evaluateGroup(record.data, cfg.conditions.eventSnapshot, []) &&
        evaluateGroup(record.data, cfg.conditions.currentState, []);
      if (!matches) {
        await finalize('CANCELLED', { invalidated: true, reason: 'conditions-not-met' });
        return { plan, cancelled: true };
      }
      const late = lateMs > AUTOMATION_SCHEDULE_ON_TIME_GRACE_MS;
      const identity = `${plan.appId}:date-relative:${plan.ruleId}:${plan.ruleVersion}:${plan.scheduleKey}:${plan.recordId}`;
      const [existingRun] = await tx.select({ id: automationRuns.id, status: automationRuns.status })
        .from(automationRuns).where(and(eq(automationRuns.tenantId, context.tenantId),
          eq(automationRuns.idempotencyKey, identity)));
      if (existingRun) {
        // A previous worker created the run but died before finalizing
        // the plan: adopt the run's outcome, never execute twice.
        const succeeded = existingRun.status === 'SUCCEEDED';
        await finalize(succeeded ? (late ? 'LATE' : 'SUCCEEDED') : 'FAILED', { executed: succeeded });
        return { plan, executed: succeeded, late: succeeded && late, failed: !succeeded };
      }
      const runId = randomUUID();
      const batchId = randomUUID();
      const [run] = await tx.insert(automationRuns).values({
        id: runId, tenantId: context.tenantId, appId: plan.appId, ruleId: plan.ruleId,
        ruleVersion: plan.ruleVersion, eventId: null,
        triggerIdentity: `date-relative:${plan.scheduleKey}`,
        idempotencyKey: identity, recordId: plan.recordId, batchId,
        rootCausationId: batchId, parentRunId: null, causationDepth: 1,
        originRuleId: plan.ruleId, originActionId: null, status: 'RUNNING',
      }).onConflictDoNothing().returning();
      if (!run) {
        await finalize('FAILED', {});
        return { plan, failed: true };
      }
      const actionRows: { action: AutomationRuleConfig['actions'][number];
        row: { actionId: string; idempotencyKey: string } }[] = [];
      for (const [position, action] of cfg.actions.entries()) {
        const [row] = await tx.insert(automationRunActions).values({
          tenantId: context.tenantId, appId: plan.appId, runId: run.id, actionId: action.actionId,
          position, status: 'PENDING', idempotencyKey: `${identity}:${action.actionId}`,
        }).onConflictDoNothing().returning();
        if (row) actionRows.push({ action, row: { actionId: row.actionId, idempotencyKey: row.idempotencyKey } });
      }
      await this.executeActions(tx, { tenantId: context.tenantId, userId: grant.approvedBy }, {
        runId: run.id, appId: plan.appId, ruleId: plan.ruleId,
        rootCausationId: run.rootCausationId, causationDepth: run.causationDepth,
        cfg, record: serializeRecord(record), eventId: null, actionRows,
        readableFieldIds: grant.readableFieldIds,
      });
      const [finished] = await tx.select({ status: automationRuns.status }).from(automationRuns)
        .where(and(eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.id, run.id)));
      const succeeded = finished?.status === 'SUCCEEDED';
      await finalize(succeeded ? (late ? 'LATE' : 'SUCCEEDED') : 'FAILED', { executed: succeeded });
      return { plan, executed: succeeded, late: succeeded && late, failed: !succeeded };
    });
  }

  // ---------------------------------------------------------------------
  // P3-B action execution engine. Actions run sequentially inside the
  // caller's transaction; each action executes in its own savepoint so a
  // failing action rolls back only itself (brief §7: non-atomic chain —
  // earlier successful actions stay committed). The executing identity is
  // always the grant approver (approver-delegated context, brief F4).
  // ---------------------------------------------------------------------

  private async grantCoversExecution(tx: TenantTransaction, tenantId: string, appId: string,
    cfg: AutomationRuleConfig, grant: typeof automationGrants.$inferSelect) {
    if (grant.revokedAt || grant.sourceAppId !== appId) return false;
    const relevantIds = fieldsFor(cfg);
    if (![...relevantIds].every((id) => grant.readableFieldIds.includes(id))) return false;
    if (!cfg.actions.every((action) => grant.allowedOperations.includes(action.type) &&
      (!action.targetAppId || grant.targetAppIds.includes(action.targetAppId)) &&
      (action.targetFieldIds ?? []).every((id) => grant.writableFieldIds.includes(id)))) return false;
    const grantor = { tenantId, userId: grant.approvedBy };
    try {
      const source = await this.schema.access(tx, grantor, appId, 'view');
      if ([...relevantIds].some((id) => !this.authorization.fieldDecision(source.access, id, 'view').allowed)) return false;
      for (const action of cfg.actions) if (action.targetAppId) {
        const target = await this.schema.access(tx, grantor, action.targetAppId, 'edit');
        if ((action.targetFieldIds ?? []).some((id) => !this.authorization.fieldDecision(target.access, id, 'edit').allowed)) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private async resolveNotifyRecipients(tx: TenantTransaction, tenantId: string, appId: string,
    record: RecordResponse, notify: NonNullable<AutomationRuleConfig['actions'][number]['notify']>) {
    const wanted = new Set<string>(notify.recipientUserIds ?? []);
    if (notify.recipientGroupIds?.length) {
      const members = await tx.select({ userId: groupMembers.userId }).from(groupMembers).where(and(
        eq(groupMembers.tenantId, tenantId), inArray(groupMembers.groupId, notify.recipientGroupIds)));
      for (const { userId } of members) wanted.add(userId);
    }
    if (notify.recipientFieldId) {
      // User fields store either a bare user id or a JSON array of ids.
      const raw = record.data[notify.recipientFieldId];
      if (raw) {
        let ids = [raw];
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) ids = parsed.map(String);
          else if (typeof parsed === 'string') ids = [parsed];
        } catch { /* bare id */ }
        for (const id of ids) wanted.add(id);
      }
    }
    if (notify.recipientAssignee) {
      const assignees = await tx.select({ userId: workflowAssignments.userId }).from(workflowAssignments).where(and(
        eq(workflowAssignments.tenantId, tenantId), eq(workflowAssignments.appId, appId),
        eq(workflowAssignments.recordId, record.id), eq(workflowAssignments.active, true)));
      for (const { userId } of assignees) wanted.add(userId);
    }
    if (!wanted.size) return [];
    const active = await tx.select({ userId: tenantMembers.userId }).from(tenantMembers).where(and(
      eq(tenantMembers.tenantId, tenantId), inArray(tenantMembers.userId, [...wanted]),
      isNull(tenantMembers.disabledAt)));
    return active.map(({ userId }) => userId);
  }

  private planFieldUpdate(fields: FieldDefinition[], record: RecordResponse,
    update: NonNullable<AutomationRuleConfig['actions'][number]['updates']>[number]) {
    const field = fields.find((entry) => entry.fieldId === update.fieldId);
    if (!field) throw codedError('UPDATE_FIELD_NOT_FOUND', 'Update field is not in the record schema: ' + update.fieldId);
    const currentRaw = Object.hasOwn(record.data, update.fieldId) ? record.data[update.fieldId] : undefined;
    if (update.mode === 'clear') return { kind: 'value' as const, value: undefined, changed: currentRaw !== undefined };
    let raw: string | undefined;
    if (update.mode === 'copy') {
      raw = update.sourceFieldId ? record.data[update.sourceFieldId] : undefined;
    } else if (update.mode === 'set') {
      raw = update.value === undefined || update.value === null ? undefined
        : typeof update.value === 'string' ? update.value
          : typeof update.value === 'object' ? JSON.stringify(update.value) : String(update.value);
    } else {
      let current: Decimal;
      try {
        current = currentRaw === undefined || currentRaw === '' ? new Decimal(0) : new Decimal(currentRaw);
        const delta = new Decimal(String(update.value));
        raw = (update.mode === 'increment' ? current.plus(delta) : current.minus(delta)).toString();
      } catch {
        throw codedError('INCREMENT_NON_NUMERIC', 'Field value or step is not numeric: ' + update.fieldId);
      }
    }
    if (raw === undefined) return { kind: 'value' as const, value: undefined, changed: currentRaw !== undefined };
    const normalized = normalizeValue(field.type, raw, field.options);
    if (normalized === undefined) throw codedError('INVALID_FIELD_VALUE', 'Value is not valid for field ' + update.fieldId);
    return { kind: 'value' as const, value: normalized, changed: automationUpdateNeeded(currentRaw, normalized) };
  }

  private planCreateData(record: RecordResponse,
    action: AutomationRuleConfig['actions'][number]) {
    const data: Record<string, string> = {};
    for (const mapping of action.mappings ?? []) {
      if (mapping.mode === 'constant') {
        if (mapping.value === undefined) continue;
        data[mapping.targetFieldId] = typeof mapping.value === 'string' ? mapping.value
          : typeof mapping.value === 'object' ? JSON.stringify(mapping.value) : String(mapping.value);
      } else {
        const value = mapping.sourceFieldId ? record.data[mapping.sourceFieldId] : undefined;
        if (value !== undefined) data[mapping.targetFieldId] = value;
      }
    }
    return data;
  }

  private async executeActions(tx: TenantTransaction, delegated: TenantContext, args: {
    runId: string; appId: string; ruleId: string; rootCausationId: string; causationDepth: number;
    cfg: AutomationRuleConfig; record: RecordResponse; eventId: string | null;
    actionRows: { action: AutomationRuleConfig['actions'][number];
      row: { actionId: string; idempotencyKey: string } }[];
    readableFieldIds: string[];
  }) {
    let record = args.record;
    const runScope = and(eq(automationRuns.tenantId, delegated.tenantId), eq(automationRuns.id, args.runId));
    for (const { action, row } of args.actionRows) {
      const [existing] = await tx.select({ status: automationRunActions.status }).from(automationRunActions)
        .where(and(eq(automationRunActions.tenantId, delegated.tenantId),
          eq(automationRunActions.runId, args.runId), eq(automationRunActions.actionId, row.actionId)));
      if (existing?.status === 'SUCCEEDED') continue;
      const causation = automationActionCausation({
        id: args.runId, rootCausationId: args.rootCausationId,
        causationDepth: args.causationDepth, ruleId: args.ruleId,
      }, action.actionId);
      const rowScope = and(eq(automationRunActions.tenantId, delegated.tenantId),
        eq(automationRunActions.runId, args.runId), eq(automationRunActions.actionId, row.actionId));
      try {
        const result = await tx.transaction(async (sp) => this.executeAction(sp as TenantTransaction, delegated, {
          appId: args.appId, ruleId: args.ruleId, runId: args.runId, action, record,
          eventId: args.eventId, causation, idempotencyKey: row.idempotencyKey,
          readableFieldIds: args.readableFieldIds,
        }));
        if (result.record) record = result.record;
        await tx.update(automationRunActions).set({
          status: 'SUCCEEDED', resultRef: result.resultRef, errorCode: null,
          attemptCount: sql`${automationRunActions.attemptCount} + 1`, completedAt: sql`clock_timestamp()`,
        }).where(rowScope);
      } catch (error) {
        const code = actionErrorCode(error, action.type);
        await tx.update(automationRunActions).set({
          status: 'FAILED', errorCode: code,
          attemptCount: sql`${automationRunActions.attemptCount} + 1`, completedAt: sql`clock_timestamp()`,
        }).where(rowScope);
        await tx.update(automationRuns).set({
          status: 'FAILED', completedAt: sql`clock_timestamp()`,
          lastError: `${action.actionId}: ${code}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
        }).where(runScope);
        return { status: 'FAILED' as const, failedActionId: action.actionId, errorCode: code };
      }
    }
    await tx.update(automationRuns).set({
      status: 'SUCCEEDED', lastError: null, completedAt: sql`clock_timestamp()`,
    }).where(runScope);
    return { status: 'SUCCEEDED' as const };
  }

  private async executeAction(tx: TenantTransaction, delegated: TenantContext, args: {
    appId: string; ruleId: string; runId: string;
    action: AutomationRuleConfig['actions'][number]; record: RecordResponse;
    eventId: string | null; causation: ReturnType<typeof automationActionCausation>;
    idempotencyKey: string; readableFieldIds: string[];
  }): Promise<{ resultRef: string; record?: RecordResponse }> {
    switch (args.action.type) {
      case 'NOTIFY': return this.executeNotify(tx, delegated, args);
      case 'UPDATE_FIELDS': return this.executeUpdateFields(tx, delegated, args);
      case 'CREATE_RECORD': return this.executeCreateRecord(tx, delegated, args);
      case 'ADVANCE_WORKFLOW': return this.executeAdvanceWorkflow(tx, delegated, args);
      case 'WEBHOOK': throw codedError('WEBHOOK_NOT_IMPLEMENTED_P3D',
        'Webhook actions are delivered in P3-D and fail explicitly in P3-B');
      default: throw codedError('ACTION_TYPE_UNSUPPORTED', 'Unsupported action type: ' + args.action.type);
    }
  }

  private async executeNotify(tx: TenantTransaction, delegated: TenantContext, args: {
    appId: string; ruleId: string; runId: string; idempotencyKey: string;
    action: AutomationRuleConfig['actions'][number]; record: RecordResponse;
    eventId: string | null; readableFieldIds: string[];
  }) {
    const notify = args.action.notify ?? {};
    const recipients = await this.resolveNotifyRecipients(tx, delegated.tenantId, args.appId, args.record, notify);
    const readable = new Set(args.readableFieldIds);
    const title = renderTemplate(notify.title ?? 'Automation notification', args.record.data, readable);
    const body = renderTemplate(notify.body ?? '', args.record.data, readable);
    if (recipients.length) {
      await tx.insert(notifications).values(recipients.map((userId) => ({
        tenantId: delegated.tenantId, userId, sourceType: 'RECORD' as const, appId: args.appId,
        recordId: args.record.id, eventId: args.eventId,
        ruleKey: `automation:${args.ruleId}:${args.action.actionId}`,
        // P3-C C-1: every automation notification carries its run and
        // action idempotency key in the payload, so event-less (manual)
        // notifications -- whose (tenant, app, event, user, rule_key)
        // unique key cannot fire with a NULL event -- can still be
        // reconciled back to exactly one run action by the audit tool.
        payload: { runId: args.runId, actionId: args.action.actionId, actionIdempotencyKey: args.idempotencyKey },
        title, body, emailState: 'skipped' as const,
      }))).onConflictDoNothing();
    }
    return { resultRef: `notified:${recipients.length}` };
  }

  private async executeUpdateFields(tx: TenantTransaction, delegated: TenantContext, args: {
    appId: string; action: AutomationRuleConfig['actions'][number]; record: RecordResponse;
    causation: ReturnType<typeof automationActionCausation>;
  }) {
    const fields = await this.schema.getFields(tx, delegated, args.appId, args.record.schemaVersion);
    const data: RecordData = {};
    let changed = false;
    for (const update of args.action.updates ?? []) {
      const plan = this.planFieldUpdate(fields, args.record, update);
      if (plan.changed) changed = true;
      if (plan.value !== undefined) data[update.fieldId] = plan.value;
    }
    if (!changed) return { resultRef: 'no-progress' };
    const updated = await this.recordWrites.persistUpdate(tx, delegated, args.appId, args.record.id,
      { revision: args.record.revision, data }, args.causation);
    return { resultRef: `revision:${updated.revision}`, record: updated };
  }

  private async executeCreateRecord(tx: TenantTransaction, delegated: TenantContext, args: {
    action: AutomationRuleConfig['actions'][number]; record: RecordResponse;
    causation: ReturnType<typeof automationActionCausation>; idempotencyKey: string;
  }) {
    const targetAppId = args.action.targetAppId!;
    const target = await this.schema.writable(tx, delegated, targetAppId, 'create');
    const byId = new Map(target.fields.map((field) => [field.fieldId, field]));
    const planned = this.planCreateData(args.record, args.action);
    const data: RecordData = {};
    for (const [fieldId, raw] of Object.entries(planned)) {
      const field = byId.get(fieldId);
      if (!field) throw codedError('CREATE_TARGET_FIELD_NOT_FOUND', 'Target field is not in the target application: ' + fieldId);
      const normalized = normalizeValue(field.type, raw, field.options);
      if (normalized === undefined) throw codedError('INVALID_FIELD_VALUE', 'Value is not valid for field ' + fieldId);
      data[fieldId] = normalized;
    }
    const created = await this.recordWrites.persistCreate(tx, delegated, targetAppId, data, target, 'api',
      args.idempotencyKey, args.causation);
    return { resultRef: created.id };
  }

  private async executeAdvanceWorkflow(tx: TenantTransaction, delegated: TenantContext, args: {
    appId: string; ruleId: string; runId: string;
    action: AutomationRuleConfig['actions'][number]; record: RecordResponse;
    causation: ReturnType<typeof automationActionCausation>;
  }) {
    const result = await this.workflowRuntime.executeAutomation(tx, delegated, args.appId, args.record.id,
      args.action.workflowActionId!, args.causation, { ruleId: args.ruleId, runId: args.runId });
    return { resultRef: `state:${result.state.code}`,
      record: { ...args.record, revision: result.revision, status: result.state.code } };
  }


  // ---------------------------------------------------------------------
  // P3-B run operations: manual trigger (T-4), failed-run retry, run and
  // audit queries (C4), and the 90-day run-history retention policy.
  // ---------------------------------------------------------------------

  retryRun(context: TenantContext, appId: string, runId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [run] = await tx.select().from(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId), eq(automationRuns.id, runId)));
      if (!run) throw new NotFoundException('Automation run not found');
      if (run.status !== 'FAILED') throw new ConflictException('Only failed runs can be retried');
      const version = await this.readVersion(tx, context, appId, run.ruleId, run.ruleVersion);
      const cfg = this.configOf(version);
      const [grant] = await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, run.ruleId),
        eq(automationGrants.ruleVersion, run.ruleVersion)));
      if (!grant || grant.revokedAt) throw new ConflictException('The automation grant is no longer active');
      if (!await this.grantCoversExecution(tx, context.tenantId, appId, cfg, grant)) {
        throw new ConflictException('The automation grant no longer covers this rule version');
      }
      const [recordRow] = await tx.select().from(records).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, run.recordId),
        isNull(records.deletedAt)));
      if (!recordRow) throw new ConflictException('The run record no longer exists');
      const rows = await tx.select().from(automationRunActions).where(and(
        eq(automationRunActions.tenantId, context.tenantId), eq(automationRunActions.runId, runId)))
        .orderBy(automationRunActions.position);
      await tx.update(automationRuns).set({
        status: 'RUNNING', attemptCount: sql`${automationRuns.attemptCount} + 1`,
        lastError: null, completedAt: null,
      }).where(and(eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.id, runId)));
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId: run.ruleId, ruleVersion: run.ruleVersion,
        actorId: context.userId, action: 'RUN_RETRIED', details: { runId },
      });
      const outcome = await this.executeActions(tx, { tenantId: context.tenantId, userId: grant.approvedBy }, {
        runId: run.id, appId, ruleId: run.ruleId, rootCausationId: run.rootCausationId,
        causationDepth: run.causationDepth, cfg, record: serializeRecord(recordRow),
        eventId: run.eventId,
        actionRows: cfg.actions.flatMap((action) => {
          const row = rows.find((entry) => entry.actionId === action.actionId);
          return row ? [{ action, row: { actionId: row.actionId, idempotencyKey: row.idempotencyKey } }] : [];
        }),
        readableFieldIds: grant.readableFieldIds,
      });
      return { runId: run.id, ...outcome };
    });
  }

  manualRun(context: TenantContext, appId: string, ruleId: string, input: z.infer<typeof manualRunInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [rule] = await tx.select().from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId),
        eq(automationRules.id, ruleId), isNull(automationRules.archivedAt)));
      if (!rule) throw new NotFoundException('Automation rule not found');
      if (!rule.enabled || !rule.currentVersion) throw new ConflictException('Rule is not enabled');
      const version = await this.readVersion(tx, context, appId, ruleId, rule.currentVersion);
      const cfg = this.configOf(version);
      if (!cfg.trigger.allowManual) throw new BadRequestException('This rule does not allow manual runs');
      const identity = input.idempotencyKey ? `manual:${input.idempotencyKey}` : `manual:${randomUUID()}`;
      const [existing] = await tx.select().from(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId),
        eq(automationRuns.triggerIdentity, identity)));
      if (existing) {
        const rows = await tx.select().from(automationRunActions).where(and(
          eq(automationRunActions.tenantId, context.tenantId), eq(automationRunActions.runId, existing.id)))
          .orderBy(automationRunActions.position);
        return { run: existing, actions: rows, deduplicated: true };
      }
      const [grant] = await tx.select().from(automationGrants).where(and(
        eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, ruleId),
        eq(automationGrants.ruleVersion, rule.currentVersion)));
      if (!grant || grant.revokedAt) throw new ConflictException('The automation grant is not active');
      if (!await this.grantCoversExecution(tx, context.tenantId, appId, cfg, grant)) {
        throw new ConflictException('The automation grant does not cover this rule version');
      }
      const [recordRow] = await tx.select().from(records).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, input.recordId),
        isNull(records.deletedAt)));
      if (!recordRow) throw new NotFoundException('Record not found');
      const runId = randomUUID();
      // P3-C C-1: a concurrent manual trigger carrying the same
      // idempotency key can pass the pre-check above and collide on the
      // run unique constraint. That collision is a replay, not an error:
      // insert with ON CONFLICT DO NOTHING and return the existing run.
      const [run] = await tx.insert(automationRuns).values({
        id: runId, tenantId: context.tenantId, appId, ruleId, ruleVersion: rule.currentVersion,
        eventId: null, triggerIdentity: identity,
        idempotencyKey: `${identity}:${ruleId}:${rule.currentVersion}`,
        recordId: input.recordId, rootCausationId: runId, parentRunId: null, causationDepth: 1,
        originRuleId: ruleId, originActionId: null, status: 'RUNNING',
      }).onConflictDoNothing().returning();
      if (!run) {
        const [winner] = await tx.select().from(automationRuns).where(and(
          eq(automationRuns.tenantId, context.tenantId),
          eq(automationRuns.idempotencyKey, `${identity}:${ruleId}:${rule.currentVersion}`)));
        if (!winner) throw new ConflictException('Manual run collided with an existing run that could not be read back');
        const winnerActions = await tx.select().from(automationRunActions).where(and(
          eq(automationRunActions.tenantId, context.tenantId), eq(automationRunActions.runId, winner.id)))
          .orderBy(automationRunActions.position);
        return { run: winner, actions: winnerActions, deduplicated: true };
      }
      const actionRows: { action: AutomationRuleConfig['actions'][number];
        row: { actionId: string; idempotencyKey: string } }[] = [];
      for (const [position, action] of cfg.actions.entries()) {
        const [row] = await tx.insert(automationRunActions).values({
          tenantId: context.tenantId, appId, runId, actionId: action.actionId, position,
          status: 'PENDING', idempotencyKey: `${identity}:${action.actionId}`,
        }).returning();
        actionRows.push({ action, row: { actionId: row.actionId, idempotencyKey: row.idempotencyKey } });
      }
      await tx.insert(automationAuditEvents).values({
        tenantId: context.tenantId, appId, ruleId, ruleVersion: rule.currentVersion,
        actorId: context.userId, action: 'MANUAL_RUN', details: { runId, recordId: input.recordId },
      });
      await this.executeActions(tx, { tenantId: context.tenantId, userId: grant.approvedBy }, {
        runId, appId, ruleId, rootCausationId: runId, causationDepth: 1, cfg,
        record: serializeRecord(recordRow), eventId: null, actionRows,
        readableFieldIds: grant.readableFieldIds,
      });
      const [finalRun] = await tx.select().from(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.id, runId)));
      const finalActions = await tx.select().from(automationRunActions).where(and(
        eq(automationRunActions.tenantId, context.tenantId), eq(automationRunActions.runId, runId)))
        .orderBy(automationRunActions.position);
      return { run: finalRun, actions: finalActions, deduplicated: false };
    });
  }

  listRuns(context: TenantContext, appId: string,
    query: { ruleId?: string; status?: string; limit: number; offset: number }) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const where = and(eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId),
        query.ruleId ? eq(automationRuns.ruleId, query.ruleId) : undefined,
        query.status ? eq(automationRuns.status, query.status) : undefined);
      const items = await tx.select().from(automationRuns).where(where)
        .orderBy(sql`${automationRuns.startedAt} DESC, ${automationRuns.id} DESC`)
        .limit(query.limit).offset(query.offset);
      const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` }).from(automationRuns).where(where);
      return { items, total };
    });
  }

  getRun(context: TenantContext, appId: string, runId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [run] = await tx.select().from(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId), eq(automationRuns.id, runId)));
      if (!run) throw new NotFoundException('Automation run not found');
      const actions = await tx.select().from(automationRunActions).where(and(
        eq(automationRunActions.tenantId, context.tenantId), eq(automationRunActions.runId, runId)))
        .orderBy(automationRunActions.position);
      return { run, actions };
    });
  }

  listAudit(context: TenantContext, appId: string,
    query: { ruleId?: string; action?: string; limit: number; offset: number }) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const where = and(eq(automationAuditEvents.tenantId, context.tenantId), eq(automationAuditEvents.appId, appId),
        query.ruleId ? eq(automationAuditEvents.ruleId, query.ruleId) : undefined,
        query.action ? eq(automationAuditEvents.action, query.action) : undefined);
      const items = await tx.select().from(automationAuditEvents).where(where)
        .orderBy(sql`${automationAuditEvents.occurredAt} DESC, ${automationAuditEvents.id} DESC`)
        .limit(query.limit).offset(query.offset);
      const [{ total }] = await tx.select({ total: sql<number>`count(*)::int` })
        .from(automationAuditEvents).where(where);
      return { items, total };
    });
  }

  runSummary(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const rules = await tx.select({
        id: automationRules.id, name: automationRules.name, enabled: automationRules.enabled,
      }).from(automationRules).where(and(
        eq(automationRules.tenantId, context.tenantId), eq(automationRules.appId, appId),
        isNull(automationRules.archivedAt)));
      const counts = await tx.select({
        ruleId: automationRuns.ruleId, status: automationRuns.status, total: sql<number>`count(*)::int`,
      }).from(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId)))
        .groupBy(automationRuns.ruleId, automationRuns.status);
      const summaries = [];
      for (const rule of rules) {
        const byStatus = new Map(counts.filter((entry) => entry.ruleId === rule.id)
          .map((entry) => [entry.status, entry.total]));
        const skipped = [...byStatus.entries()]
          .filter(([status]) => status.startsWith('SKIPPED') || status === 'BLOCKED_CYCLE' ||
            status === 'CHAIN_PAUSED' || status === 'CHAIN_DEPTH_EXCEEDED')
          .reduce((sum, [, total]) => sum + total, 0);
        const [last] = await tx.select({
          status: automationRuns.status, startedAt: automationRuns.startedAt, lastError: automationRuns.lastError,
        }).from(automationRuns).where(and(
          eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId),
          eq(automationRuns.ruleId, rule.id)))
          .orderBy(sql`${automationRuns.startedAt} DESC, ${automationRuns.id} DESC`).limit(1);
        summaries.push({
          ruleId: rule.id, name: rule.name, enabled: rule.enabled,
          succeeded: byStatus.get('SUCCEEDED') ?? 0, failed: byStatus.get('FAILED') ?? 0, skipped,
          lastStatus: last?.status ?? null, lastRunAt: last?.startedAt ?? null, lastError: last?.lastError ?? null,
        });
      }
      const [{ backlog }] = await tx.select({ backlog: sql<number>`count(*)::int` }).from(automationRuns)
        .where(and(eq(automationRuns.tenantId, context.tenantId), eq(automationRuns.appId, appId),
          inArray(automationRuns.status, ['QUEUED', 'RUNNING'])));
      const [{ unprocessedEvents }] = await tx.select({ unprocessedEvents: sql<number>`count(*)::int` })
        .from(outbox).where(and(eq(outbox.tenantId, context.tenantId), eq(outbox.appId, appId),
          isNull(outbox.automationProcessedAt)));
      // P3-C cadence: schedule backlog is part of the same E-6 summary --
      // active plans whose next due instant has passed, plus slots still
      // claimed (in flight or awaiting crash recovery).
      const [{ scheduleBacklog }] = await tx.select({ scheduleBacklog: sql<number>`count(*)::int` })
        .from(automationCadencePlans).where(and(
          eq(automationCadencePlans.tenantId, context.tenantId), eq(automationCadencePlans.appId, appId),
          eq(automationCadencePlans.status, 'ACTIVE'), sql`${automationCadencePlans.nextDueAt} <= clock_timestamp()`));
      const [{ scheduleInFlight }] = await tx.select({ scheduleInFlight: sql<number>`count(*)::int` })
        .from(automationCadenceSlots).where(and(
          eq(automationCadenceSlots.tenantId, context.tenantId), eq(automationCadenceSlots.appId, appId),
          eq(automationCadenceSlots.status, 'CLAIMED')));
      return { rules: summaries, backlog, unprocessedEvents, scheduleBacklog, scheduleInFlight };
    });
  }

  // Brief §5.4 / C4: hot run history is retained for 90 days. Terminal runs
  // older than that are pruned with their action rows, except runs still
  // referenced by a paused problem chain. Audit events are never pruned.
  // P3-C C-0: pruning itself is audited — one RUN_HISTORY_PRUNED row per
  // (app, rule, version) group, written with the caller's audit actor
  // (SYSTEM with actor_id NULL under the worker's maintenance context).
  // The problem-chain exclusion uses NOT EXISTS: a chain row whose
  // last_run_id is NULL must not silently disable all pruning the way
  // NOT IN did.
  async pruneRunHistory(context: TenantContext) {
    return withTenantTransaction(context, async (tx) => {
      const stale = await tx.select({
        id: automationRuns.id, appId: automationRuns.appId,
        ruleId: automationRuns.ruleId, ruleVersion: automationRuns.ruleVersion,
      }).from(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId),
        sql`${automationRuns.completedAt} < clock_timestamp() - interval '90 days'`,
        sql`${automationRuns.status} NOT IN ('QUEUED','RUNNING')`,
        sql`NOT EXISTS (SELECT 1 FROM automation_problem_chains pc
          WHERE pc.tenant_id = ${context.tenantId} AND pc.last_run_id = ${automationRuns.id})`,
      ));
      if (!stale.length) return { pruned: 0 };
      const ids = stale.map(({ id }) => id);
      await tx.delete(automationRunActions).where(and(
        eq(automationRunActions.tenantId, context.tenantId), inArray(automationRunActions.runId, ids)));
      await tx.delete(automationRuns).where(and(
        eq(automationRuns.tenantId, context.tenantId), inArray(automationRuns.id, ids)));
      const groups = new Map<string, { appId: string; ruleId: string; ruleVersion: number; prunedCount: number }>();
      for (const row of stale) {
        const key = `${row.appId}:${row.ruleId}:${row.ruleVersion}`;
        const group = groups.get(key) ?? { appId: row.appId, ruleId: row.ruleId, ruleVersion: row.ruleVersion, prunedCount: 0 };
        group.prunedCount++;
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        await tx.insert(automationAuditEvents).values({
          tenantId: context.tenantId, appId: group.appId, ruleId: group.ruleId,
          ruleVersion: group.ruleVersion, ...auditActor(context), action: 'RUN_HISTORY_PRUNED',
          details: { prunedCount: group.prunedCount, retentionDays: 90 },
        });
      }
      return { pruned: ids.length };
    });
  }

  private validateConfig(value: AutomationRuleConfig, definitions: FieldDefinition[]) {
    const byId = new Map(definitions.map((field) => [field.fieldId, field]));
    for (const id of fieldsFor(value)) if (!byId.has(id)) throw new BadRequestException('Rule references an unknown field: ' + id);
    if (value.trigger.fieldId && !byId.has(value.trigger.fieldId)) throw new BadRequestException('Unknown trigger field');
    for (const stage of [value.conditions.eventSnapshot, value.conditions.currentState]) {
      for (const group of stage.groups) for (const item of group.conditions) {
        const field = byId.get(item.fieldId)!;
        if (!supportedCondition(item, field)) throw new BadRequestException('Unsupported condition for field ' + item.fieldId);
        if (['contains_any', 'contains_all', 'in'].includes(item.operator) && !Array.isArray(item.value)) {
          throw new BadRequestException('Collection condition requires an array value');
        }
        if (!('value' in item) || item.value === undefined || item.value === null ||
          ['empty', 'nonempty'].includes(item.operator)) continue;
        if (['contains_any', 'contains_all'].includes(item.operator)) {
          if (multiOptionFieldTypes.has(field.type)) {
            const normalized = normalizeValue(field.type, JSON.stringify(item.value), field.options);
            item.value = normalized === undefined ? undefined : JSON.parse(normalized);
          }
          if (item.value === undefined) throw new BadRequestException('Invalid normalized collection condition');
        } else if (item.operator === 'in') {
          const normalized = (item.value as unknown[]).map((value) =>
            normalizeValue(field.type, String(value), field.options));
          if (normalized.some((value) => value === undefined)) throw new BadRequestException('Invalid normalized collection condition');
          item.value = normalized;
        } else if (item.operator === 'contains' && multiOptionFieldTypes.has(field.type)) {
          const normalized = normalizeValue(field.type, JSON.stringify([item.value]), field.options);
          if (normalized === undefined) throw new BadRequestException('Invalid normalized condition value');
          item.value = JSON.parse(normalized)[0];
        } else {
          const normalized = normalizeValue(field.type, String(item.value), field.options);
          if (normalized === undefined) throw new BadRequestException('Invalid normalized condition value');
          item.value = normalized;
        }
      }
    }
    if (value.trigger.fieldId) {
      const field = byId.get(value.trigger.fieldId)!;
      for (const key of ['oldValue', 'newValue'] as const) {
        if (key in value.trigger && value.trigger[key] !== undefined) {
          const normalized = normalizeValue(field.type, String(value.trigger[key]), field.options);
          if (normalized === undefined) throw new BadRequestException('Invalid normalized trigger value');
          value.trigger[key] = normalized;
        }
      }
    }
    for (const action of value.actions) {
      if (action.type === 'NOTIFY' && action.notify) {
        const field = action.notify.recipientFieldId ? byId.get(action.notify.recipientFieldId) : undefined;
        if (action.notify.recipientFieldId && (!field || field.type !== 'user')) {
          throw new BadRequestException('Notification recipient field must be a user field');
        }
        for (const id of [...templateFieldIds(action.notify.title), ...templateFieldIds(action.notify.body)]) {
          if (!byId.has(id)) throw new BadRequestException('Notification template references an unknown field: ' + id);
        }
      }
      if (action.type === 'UPDATE_FIELDS') {
        for (const update of action.updates ?? []) {
          const field = byId.get(update.fieldId);
          if (!field) throw new BadRequestException('Update references an unknown field: ' + update.fieldId);
          if (field.autoNumber || ['calculation', 'table'].includes(field.type)) {
            throw new BadRequestException('Field cannot be updated by automation: ' + update.fieldId);
          }
          if (update.mode === 'increment' || update.mode === 'decrement') {
            if (field.type !== 'number') throw new BadRequestException('Increment/decrement requires a number field: ' + update.fieldId);
            if (update.value === undefined || update.value === null || Number.isNaN(Number(update.value))) {
              throw new BadRequestException('Increment/decrement requires a numeric value');
            }
          }
          if (update.mode === 'copy') {
            const source = byId.get(update.sourceFieldId!);
            if (!source) throw new BadRequestException('Copy source field is unknown: ' + update.sourceFieldId);
            if (source.type !== field.type) throw new BadRequestException('Copy source and target field types must match');
          }
          if (update.mode === 'set' && update.value !== undefined && update.value !== null) {
            const raw = typeof update.value === 'string' ? update.value
              : typeof update.value === 'object' ? JSON.stringify(update.value) : String(update.value);
            if (normalizeValue(field.type, raw, field.options) === undefined) {
              throw new BadRequestException('Invalid value for field: ' + update.fieldId);
            }
          }
        }
      }
      if (action.type === 'CREATE_RECORD') {
        for (const mapping of action.mappings ?? []) {
          if (mapping.mode === 'source' && !byId.has(mapping.sourceFieldId!)) {
            throw new BadRequestException('Mapping source field is unknown: ' + mapping.sourceFieldId);
          }
        }
      }
    }
  }

  private async validateVersion(tx: TenantTransaction, context: TenantContext, appId: string, version: typeof automationRuleVersions.$inferSelect) {
    const findings: { code: string; severity: 'BLOCKING' | 'WARNING'; fieldId?: string; targetAppId?: string }[] = [];
    const cfg = this.configOf(version);
    const { fields: definitions, access } = await this.schema.access(tx, context, appId, 'view');
    for (const id of fieldsFor(cfg)) if (!definitions.some((field) => field.fieldId === id)) {
      findings.push({ code: 'FIELD_UNAVAILABLE', severity: 'BLOCKING', fieldId: id });
    } else if (!this.authorization.fieldDecision(access, id, 'view').allowed) {
      findings.push({ code: 'FIELD_NOT_READABLE', severity: 'BLOCKING', fieldId: id });
    }
    for (const action of cfg.actions) {
      if (!action.targetAppId) continue;
      try {
        const { fields: targetFields, access: targetAccess } =
          await this.schema.access(tx, context, action.targetAppId, 'edit');
        for (const id of action.targetFieldIds ?? []) if (!targetFields.some((field) => field.fieldId === id)) {
          findings.push({ code: 'TARGET_FIELD_UNAVAILABLE', severity: 'BLOCKING', fieldId: id, targetAppId: action.targetAppId });
        } else if (!this.authorization.fieldDecision(targetAccess, id, 'edit').allowed) {
          findings.push({ code: 'TARGET_FIELD_NOT_WRITABLE', severity: 'BLOCKING', fieldId: id, targetAppId: action.targetAppId });
        }
        if (action.type === 'CREATE_RECORD') {
          for (const mapping of action.mappings ?? []) {
            if (mapping.mode !== 'constant' || mapping.value === undefined || mapping.value === null) continue;
            const targetField = targetFields.find((field) => field.fieldId === mapping.targetFieldId);
            if (!targetField) {
              findings.push({ code: 'TARGET_FIELD_UNAVAILABLE', severity: 'BLOCKING', fieldId: mapping.targetFieldId, targetAppId: action.targetAppId });
              continue;
            }
            const raw = typeof mapping.value === 'string' ? mapping.value
              : typeof mapping.value === 'object' ? JSON.stringify(mapping.value) : String(mapping.value);
            if (normalizeValue(targetField.type, raw, targetField.options) === undefined) {
              findings.push({ code: 'TARGET_VALUE_INVALID', severity: 'BLOCKING', fieldId: mapping.targetFieldId, targetAppId: action.targetAppId });
            }
          }
        }
      } catch {
        findings.push({ code: 'TARGET_APP_UNAVAILABLE', severity: 'BLOCKING', targetAppId: action.targetAppId });
      }
    }
    // P3-C cadence: schedule configuration is re-validated at preflight
    // time (not only by the write-path schema), so a version stored
    // through any path cannot publish an illegal cadence, local time or
    // timezone.
    if (cfg.trigger.eventType === 'schedule.fixed') {
      const schedule = cfg.trigger.schedule;
      if (!schedule) findings.push({ code: 'SCHEDULE_CONFIG_MISSING', severity: 'BLOCKING' });
      else {
        if (!['daily', 'weekly', 'monthly'].includes(schedule.cadence)) {
          findings.push({ code: 'SCHEDULE_CADENCE_INVALID', severity: 'BLOCKING' });
        }
        if (!isValidLocalTime(schedule.localTime ?? '')) {
          findings.push({ code: 'SCHEDULE_LOCAL_TIME_INVALID', severity: 'BLOCKING' });
        }
        if (!isValidTimezone(schedule.timezone ?? '')) {
          findings.push({ code: 'SCHEDULE_TIMEZONE_INVALID', severity: 'BLOCKING' });
        }
        if (schedule.cadence === 'weekly' &&
          (!schedule.weekdays?.length || schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
            new Set(schedule.weekdays).size !== schedule.weekdays.length)) {
          findings.push({ code: 'SCHEDULE_WEEKDAYS_INVALID', severity: 'BLOCKING' });
        }
        if (schedule.cadence === 'monthly' &&
          (schedule.monthDay === undefined || !Number.isInteger(schedule.monthDay) || schedule.monthDay < 1 || schedule.monthDay > 31)) {
          findings.push({ code: 'SCHEDULE_MONTH_DAY_INVALID', severity: 'BLOCKING' });
        }
        if (schedule.missedRunPolicy !== undefined && !['skip', 'catch_up_latest'].includes(schedule.missedRunPolicy)) {
          findings.push({ code: 'SCHEDULE_MISSED_POLICY_INVALID', severity: 'BLOCKING' });
        }
      }
    } else if (cfg.trigger.schedule) {
      findings.push({ code: 'SCHEDULE_CONFIG_UNEXPECTED', severity: 'BLOCKING' });
    }
    // P3-C date-relative: same re-validation discipline as fixed cadence.
    if (cfg.trigger.eventType === 'schedule.dateRelative') {
      const relative = cfg.trigger.dateRelative;
      if (!relative) findings.push({ code: 'SCHEDULE_CONFIG_MISSING', severity: 'BLOCKING' });
      else {
        if (relative.source !== 'field' && relative.source !== 'createdAt') {
          findings.push({ code: 'SCHEDULE_DATE_SOURCE_INVALID', severity: 'BLOCKING' });
        }
        if (relative.source === 'field') {
          const field = definitions.find((entry) => entry.fieldId === relative.fieldId);
          if (!relative.fieldId) {
            findings.push({ code: 'SCHEDULE_DATE_FIELD_MISSING', severity: 'BLOCKING' });
          } else if (field && field.type !== 'date') {
            findings.push({ code: 'SCHEDULE_DATE_FIELD_TYPE_INVALID', severity: 'BLOCKING', fieldId: relative.fieldId });
          }
        }
        if (relative.source === 'createdAt' && relative.fieldId) {
          findings.push({ code: 'SCHEDULE_DATE_FIELD_UNEXPECTED', severity: 'BLOCKING' });
        }
        if (!Number.isInteger(relative.offsetDays) || relative.offsetDays < -3650 || relative.offsetDays > 3650) {
          findings.push({ code: 'SCHEDULE_OFFSET_INVALID', severity: 'BLOCKING' });
        }
        if (!isValidLocalTime(relative.localTime ?? '')) {
          findings.push({ code: 'SCHEDULE_LOCAL_TIME_INVALID', severity: 'BLOCKING' });
        }
        if (!isValidTimezone(relative.timezone ?? '')) {
          findings.push({ code: 'SCHEDULE_TIMEZONE_INVALID', severity: 'BLOCKING' });
        }
      }
    } else if (cfg.trigger.dateRelative) {
      findings.push({ code: 'SCHEDULE_CONFIG_UNEXPECTED', severity: 'BLOCKING' });
    }
    const [grant] = await tx.select().from(automationGrants).where(and(
      eq(automationGrants.tenantId, context.tenantId), eq(automationGrants.ruleId, version.ruleId),
      eq(automationGrants.ruleVersion, version.version), isNull(automationGrants.revokedAt),
    ));
    if (!grant) findings.push({ code: 'GRANT_REQUIRED', severity: 'BLOCKING' });
    else {
      if (grant.sourceAppId !== appId) findings.push({ code: 'SOURCE_APP_MISMATCH', severity: 'BLOCKING' });
      for (const id of fieldsFor(cfg)) if (!grant.readableFieldIds.includes(id)) findings.push({ code: 'READ_GRANT_MISSING', severity: 'BLOCKING', fieldId: id });
      for (const action of cfg.actions) {
        if (!grant.allowedOperations.includes(action.type)) findings.push({ code: 'OPERATION_GRANT_MISSING', severity: 'BLOCKING' });
        if (action.targetAppId && !grant.targetAppIds.includes(action.targetAppId)) findings.push({ code: 'TARGET_GRANT_MISSING', severity: 'BLOCKING', targetAppId: action.targetAppId });
        for (const id of action.targetFieldIds ?? []) if (!grant.writableFieldIds.includes(id)) findings.push({ code: 'WRITE_GRANT_MISSING', severity: 'BLOCKING', fieldId: id });
      }
    }
    return findings;
  }

  private async readVersion(tx: TenantTransaction, context: TenantContext, appId: string, ruleId: string, version: number) {
    const [row] = await tx.select().from(automationRuleVersions).where(and(
      eq(automationRuleVersions.tenantId, context.tenantId), eq(automationRuleVersions.appId, appId),
      eq(automationRuleVersions.ruleId, ruleId), eq(automationRuleVersions.version, version),
    ));
    if (!row) throw new NotFoundException('Unknown automation rule version');
    return row;
  }

  private configOf(version: typeof automationRuleVersions.$inferSelect): AutomationRuleConfig {
    const cfg = { schemaVersion: version.schemaVersion, trigger: version.trigger,
      conditions: version.conditions, actions: version.actions } as AutomationRuleConfig;
    // P3-B: the fields an action writes are part of its grant surface. When a
    // config omits targetFieldIds, derive them from the action parameters so
    // grant coverage checks can never pass vacuously.
    for (const action of cfg.actions) {
      if (action.type === 'UPDATE_FIELDS' && !action.targetFieldIds && action.updates) {
        action.targetFieldIds = [...new Set(action.updates.map(({ fieldId }) => fieldId))];
      }
      if (action.type === 'CREATE_RECORD' && !action.targetFieldIds && action.mappings) {
        action.targetFieldIds = [...new Set(action.mappings.map(({ targetFieldId }) => targetFieldId))];
      }
    }
    return cfg;
  }
}

@ApiTags('automation')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('problem-chains')
  listPausedChains(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.automation.listPausedChains(context, parseInput(identifier, appId));
  }

  @Post('problem-chains/:rootCausationId/resume')
  resumePausedChain(@AuthenticatedTenant() context: TenantContext,
    @Param('appId') appId: string, @Param('rootCausationId') rootCausationId: string) {
    return this.automation.resumePausedChain(context, parseInput(identifier, appId),
      parseInput(identifier, rootCausationId));
  }

  @Get('runs')
  listRuns(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Query('ruleId') ruleId?: string, @Query('status') status?: string,
    @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.automation.listRuns(context, parseInput(identifier, appId), {
      ruleId: ruleId ? parseInput(identifier, ruleId) : undefined,
      status: status || undefined,
      limit: Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200),
      offset: Math.max(Number(offset ?? 0) || 0, 0),
    });
  }

  @Get('runs/:runId')
  getRun(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('runId') runId: string) {
    return this.automation.getRun(context, parseInput(identifier, appId), parseInput(identifier, runId));
  }

  @Post('runs/:runId/retry')
  retryRun(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('runId') runId: string) {
    return this.automation.retryRun(context, parseInput(identifier, appId), parseInput(identifier, runId));
  }

  @Post('rules/:ruleId/manual-runs')
  manualRun(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.automation.manualRun(context, parseInput(identifier, appId), parseInput(identifier, ruleId),
      parseInput(automationHttp.manualRunInput, body));
  }

  @Get('audit')
  listAudit(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Query('ruleId') ruleId?: string, @Query('action') action?: string,
    @Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.automation.listAudit(context, parseInput(identifier, appId), {
      ruleId: ruleId ? parseInput(identifier, ruleId) : undefined,
      action: action || undefined,
      limit: Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200),
      offset: Math.max(Number(offset ?? 0) || 0, 0),
    });
  }

  @Get('summary')
  runSummary(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.automation.runSummary(context, parseInput(identifier, appId));
  }

  @Get('rules')
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.automation.list(context, parseInput(identifier, appId));
  }

  @Post('rules')
  create(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.automation.create(context, parseInput(identifier, appId), parseInput(createRuleInput, body));
  }

  @Put('rules/:ruleId/draft')
  draft(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.automation.saveDraft(context, parseInput(identifier, appId), parseInput(identifier, ruleId),
      parseInput(draftInput, body));
  }

  @Post('rules/:ruleId/grants')
  grant(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.automation.grant(context, parseInput(identifier, appId), parseInput(identifier, ruleId),
      parseInput(grantInput, body));
  }

  @Post('rules/:ruleId/grants/:grantId/revoke')
  revoke(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Param('grantId') grantId: string) {
    return this.automation.revoke(context, parseInput(identifier, appId), parseInput(identifier, ruleId), parseInput(identifier, grantId));
  }

  @Post('rules/:ruleId/preflight')
  preflight(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.automation.preflight(context, parseInput(identifier, appId), parseInput(identifier, ruleId),
      parseInput(versionInput, body));
  }

  @Post('rules/:ruleId/dry-run')
  dryRun(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    const input = parseInput(versionInput.extend({ recordId: identifier }), body);
    return this.automation.dryRun(context, parseInput(identifier, appId), parseInput(identifier, ruleId), input);
  }

  @Post('rules/:ruleId/publish')
  publish(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.automation.publish(context, parseInput(identifier, appId), parseInput(identifier, ruleId),
      parseInput(versionInput, body));
  }

  @Post('rules/:ruleId/enable')
  enable(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('ruleId') ruleId: string, @Body() body: unknown) {
    return this.automation.enable(context, parseInput(identifier, appId), parseInput(identifier, ruleId),
      parseInput(enableInput, body));
  }

  @Delete('rules/:ruleId')
  archive(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('ruleId') ruleId: string) {
    return this.automation.archive(context, parseInput(identifier, appId), parseInput(identifier, ruleId));
  }
}
