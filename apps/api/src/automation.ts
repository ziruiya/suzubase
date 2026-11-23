import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, automationAuditEvents, automationGrants, automationRuleVersions, automationRunActions, automationRuns,
  automationRules, automationProblemChains, eq, isNull, notifications, outbox, records, sql, tenantMembers, TenantContext, TenantTransaction, withTenantTransaction,
  type AutomationRuleConfig,
} from '@suzubase/db';
import { fieldContract, multiOptionFieldTypes, type FieldDefinition } from '@suzubase/shared-types';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { normalizeValue } from './field-values';
import { identifier, parseInput } from './validation';

const eventTypes = ['record.created', 'record.updated', 'record.deleted', 'workflow.transitioned', 'workflow.rejected'] as const;
export const AUTOMATION_TENANT_RUN_RATE_LIMIT = 100;
export const AUTOMATION_TENANT_RUN_RATE_WINDOW_MS = 60_000;
export const AUTOMATION_TENANT_PENDING_LIMIT = 1_000;
export const AUTOMATION_PROBLEM_CHAIN_FAILURE_LIMIT = 3;

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

export const automationHttp = {
  createRuleInput,
  draftInput,
  grantInput,
  versionInput,
  enableInput,
  rule: z.looseObject({ id: identifier, name: z.string(), enabled: z.boolean(), archivedAt: z.string().nullable().optional() }),
  version: z.looseObject({ ruleId: identifier, version: z.number().int(), status: z.string(), trigger: z.unknown(), conditions: z.unknown(), actions: z.unknown() }),
  grant: z.looseObject({ id: identifier, ruleId: identifier, ruleVersion: z.number().int(), revokedAt: z.string().nullable().optional() }),
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
  for (const stage of [configValue.conditions.eventSnapshot, configValue.conditions.currentState]) {
    for (const group of stage.groups) for (const item of group.conditions) ids.add(item.fieldId);
  }
  return ids;
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
  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService) {}

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
        : cfg.trigger.eventType === 'record.updated' && cfg.trigger.fieldId && 'newValue' in cfg.trigger
          ? !compare(valueAt(row.data, cfg.trigger.fieldId), cfg.trigger.newValue) ? false
            : 'oldValue' in cfg.trigger ? null : true
          : false;
      const boundFields = await this.schema.getFields(tx, context, appId, version.sourceSchemaVersion);
      const boundTypes = new Map(boundFields.map(({ fieldId, type }) => [fieldId, type]));
      const fieldVersionValid = configured.every((id) => boundTypes.get(id) === fieldById.get(id)?.type);
      return {
        dryRun: true, sideEffects: false, eventType: cfg.trigger.eventType, recordId: row.id,
        triggerMatches, snapshotMatches, currentMatches, fieldVersionValid, authorized,
        wouldRun: triggerMatches === true && snapshotMatches && currentMatches && fieldVersionValid && authorized,
        actions: cfg.actions.map(({ actionId, type, targetAppId, targetFieldIds }) => ({
          actionId, type, targetAppId: targetAppId ?? appId, targetFieldIds: targetFieldIds ?? [], executed: false,
        })),
        warning: cfg.trigger.eventType.startsWith('workflow.')
          ? 'Workflow event dry-run requires a persisted workflow event; this record-only preview does not simulate one.' : null,
      };
    });
  }

  listPausedChains(context: TenantContext) {
    return withTenantTransaction(context, async (tx) =>
      tx.select().from(automationProblemChains).where(and(
        eq(automationProblemChains.tenantId, context.tenantId),
        isNull(automationProblemChains.resumedAt),
      )));
  }

  resumePausedChain(context: TenantContext, rootCausationId: string) {
    return withTenantTransaction(context, async (tx) => {
      const [chain] = await tx.select().from(automationProblemChains).where(and(
        eq(automationProblemChains.tenantId, context.tenantId),
        eq(automationProblemChains.rootCausationId, rootCausationId),
        isNull(automationProblemChains.resumedAt),
      )).for('update');
      if (!chain) throw new NotFoundException('Active paused automation problem chain not found');
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
              for (const candidate of candidates) await tx.insert(automationAuditEvents).values({
                tenantId: context.tenantId, appId: candidate.rule.appId, ruleId: candidate.rule.id,
                ruleVersion: candidate.version.version, actorId: context.userId, action: 'RATE_LIMITED',
                details: { rootCausationId, eventId: event.eventId, limit: AUTOMATION_TENANT_RUN_RATE_LIMIT, windowMs: AUTOMATION_TENANT_RUN_RATE_WINDOW_MS },
              });
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
              for (const candidate of candidates) await tx.insert(automationAuditEvents).values({
                tenantId: context.tenantId, appId: candidate.rule.appId, ruleId: candidate.rule.id,
                ruleVersion: candidate.version.version, actorId: context.userId, action: 'BACKLOG_LIMITED',
                details: { rootCausationId, eventId: event.eventId, pendingCount, limit: AUTOMATION_TENANT_PENDING_LIMIT },
              });
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
                    : 'ACTIONS_NOT_IMPLEMENTED';
            const [run] = await tx.insert(automationRuns).values({
              tenantId: context.tenantId, appId: event.appId, ruleId: candidate.rule.id,
              ruleVersion: candidate.version.version, eventId: event.eventId,
              triggerIdentity: `${eventType}:${event.eventId}`, idempotencyKey: identity,
              recordId: event.recordId, rootCausationId: event.rootCausationId ?? event.eventId,
              parentRunId: event.parentRunId, causationDepth: event.causationDepth + 1,
              originRuleId: event.originRuleId, originActionId: event.originActionId,
              status, lastError: status === 'ACTIONS_NOT_IMPLEMENTED' ? 'P3-A records actions but does not execute P3-B side effects' : null,
              completedAt: sql`clock_timestamp()`,
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
            for (const [position, action] of cfg.actions.entries()) {
              await tx.insert(automationRunActions).values({
                tenantId: context.tenantId, appId: event.appId, runId: run.id, actionId: action.actionId,
                position, status: 'NOT_EXECUTED', idempotencyKey: `${identity}:${action.actionId}`,
                errorCode: status === 'ACTIONS_NOT_IMPLEMENTED' ? 'P3B_DEFERRED' : status,
                completedAt: sql`clock_timestamp()`,
              }).onConflictDoNothing();
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
      } catch {
        findings.push({ code: 'TARGET_APP_UNAVAILABLE', severity: 'BLOCKING', targetAppId: action.targetAppId });
      }
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
    return { schemaVersion: version.schemaVersion, trigger: version.trigger,
      conditions: version.conditions, actions: version.actions } as AutomationRuleConfig;
  }
}

@ApiTags('automation')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/automation')
export class AutomationController {
  constructor(private readonly automation: AutomationService) {}

  @Get('problem-chains')
  listPausedChains(@AuthenticatedTenant() context: TenantContext) {
    return this.automation.listPausedChains(context);
  }

  @Post('problem-chains/:rootCausationId/resume')
  resumePausedChain(@AuthenticatedTenant() context: TenantContext,
    @Param('rootCausationId') rootCausationId: string) {
    return this.automation.resumePausedChain(context, parseInput(identifier, rootCausationId));
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
