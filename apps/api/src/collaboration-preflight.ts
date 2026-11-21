import {
  and, apps, eq, fields, inArray, isNull, records, recordWorkflowState, sql, tenants, workflowDefinitions, workflowEvents,
  workflowStates, type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import { fieldContract, type FieldDefinition } from '@suzubase/shared-types';
import type { AppSchemaService } from './app-schema';
import { AuthorizationService, type RecordAccess } from './authorization';
import { serializeRecord, writeRecordEvent } from './record-events';
import { normalizeReferencePresentation } from './reference-config';
import { setAssignees, workStateScope } from './workflow-data';
import { readWorkflowGraph, workflowScope } from './workflow-graph';

export type CollaborationProblem = {
  fieldId: string; dependency: string; reason: string; dependentAppId?: string; dependentFieldId?: string;
  version?: number; objectId?: string; recordCount?: string; remedy?: string;
};

type Identity = { tenantId: string; appId: string };

export function lockSchemaChanges(tx: TenantTransaction, context: TenantContext) {
  return tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, context.tenantId)).for('update');
}

function inspectReference(field: FieldDefinition, local: Map<string, FieldDefinition>, target: Map<string, FieldDefinition>) {
  const problems: { fieldId: string; reason: string }[] = [];
  const config = field.lookup ?? field.related;
  if (!config) return problems;
  const add = (fieldId: string, label: string) => problems.push({ fieldId, reason: label + ' is missing or incompatible' });
  if (field.lookup) {
    const { localKeyFieldId, keyFieldId, copies } = field.lookup;
    const source = target.get(keyFieldId);
    if (!source?.uniqueValue) add(keyFieldId, 'Lookup unique key');
    if (!local.has(localKeyFieldId) || local.get(localKeyFieldId)?.type !== source?.type) add(localKeyFieldId, 'Lookup local key');
    for (const { sourceFieldId, targetFieldId } of copies) {
      const from = target.get(sourceFieldId);
      const to = local.get(targetFieldId);
      if (!from) add(sourceFieldId, 'Lookup copy source');
      if (!to || from && from.type !== to.type) add(targetFieldId, 'Lookup copy destination');
    }
  }
  if (field.related) {
    const { localFieldId, matchFieldId } = field.related;
    const match = target.get(matchFieldId);
    if (!match || !fieldContract[match.type].sort) add(matchFieldId, 'Related matching field');
    if (!local.has(localFieldId) || local.get(localFieldId)?.type !== match?.type) add(localFieldId, 'Related local matching field');
  }
  for (const id of config.displayFieldIds ?? []) if (!target.has(id)) add(id, 'Reference display field');
  for (const { fieldId } of config.conditions ?? []) if (!target.has(fieldId)) add(fieldId, 'Reference condition field');
  if (config.sort && !target.has(config.sort.fieldId)) add(config.sort.fieldId, 'Reference sort field');
  if (!problems.length) {
    try { normalizeReferencePresentation(config, [...target.values()]); }
    catch { add(field.fieldId, 'Reference display, condition or sort configuration'); }
  }
  return problems;
}

export async function outgoingReferences(tx: TenantTransaction, context: TenantContext, schema: AppSchemaService,
  appId: string, definitions: FieldDefinition[],
) {
  const local = new Map(definitions.map((field) => [field.fieldId, field]));
  const cache = new Map([[appId, local]]);
  const problems: CollaborationProblem[] = [];
  for (const field of definitions) {
    const config = field.lookup ?? field.related;
    if (!config) continue;
    if (!cache.has(config.appId)) {
      const [target] = await tx.select({ version: apps.publishedSchemaVersion }).from(apps).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, config.appId), isNull(apps.deletedAt),
      ));
      const fields = target ? await schema.getFields(tx, context, config.appId, target.version) : [];
      cache.set(config.appId, new Map(fields.map((entry) => [entry.fieldId, entry])));
    }
    for (const problem of inspectReference(field, local, cache.get(config.appId)!)) {
      problems.push({ ...problem, dependency: field.lookup ? 'lookup' : 'related', dependentAppId: appId, dependentFieldId: field.fieldId });
    }
  }
  return problems;
}

export async function inboundReferences(tx: TenantTransaction, context: TenantContext, schema: AppSchemaService,
  auth: AuthorizationService, appId: string, current: FieldDefinition[], next: FieldDefinition[], deleting = false,
) {
  const nextTypes = new Map(next.map(({ fieldId, type, uniqueValue }) => [fieldId, { type, uniqueValue }]));
  const changed = new Map(current.filter(({ fieldId, type, uniqueValue }) => {
    const replacement = nextTypes.get(fieldId);
    return !replacement || replacement.type !== type || replacement.uniqueValue !== uniqueValue;
  }).map((field) => [field.fieldId, field]));
  if (!deleting && !changed.size) return [];
  const relatedApps = await tx.select({
    id: apps.id, version: apps.publishedSchemaVersion,
    canManage: sql<boolean>`COALESCE(${auth.appManagementScope(context)}, false)`,
  }).from(apps).where(and(eq(apps.tenantId, context.tenantId), isNull(apps.deletedAt), sql`${apps.id} <> ${appId}`,
    sql`EXISTS (SELECT 1 FROM ${fields} WHERE ${fields.tenantId} = ${apps.tenantId} AND ${fields.appId} = ${apps.id}
      AND ${fields.type} IN ('lookup', 'related'))`));
  const problems: CollaborationProblem[] = [];
  let restricted = false;
  for (const candidate of relatedApps) {
    const bound = await tx.selectDistinct({ version: records.schemaVersion }).from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, candidate.id),
    ));
    const versions = new Set([candidate.version, ...bound.map(({ version }) => version)]);
    for (const version of versions) {
      for (const field of await schema.getFields(tx, context, candidate.id, version)) {
        const config = field.lookup ?? field.related;
        if (config?.appId !== appId) continue;
        const dependencies = [
          ...field.lookup ? [{ id: field.lookup.keyFieldId, role: 'unique key' },
            ...field.lookup.copies.map(({ sourceFieldId }) => ({ id: sourceFieldId, role: 'copy source' }))] : [],
          ...field.related ? [{ id: field.related.matchFieldId, role: 'matching field' }] : [],
          ...config.displayFieldIds?.map((id) => ({ id, role: 'display field' })) ?? [],
          ...config.conditions?.map(({ fieldId }) => ({ id: fieldId, role: 'condition field' })) ?? [],
          ...config.sort ? [{ id: config.sort.fieldId, role: 'sort field' }] : [],
        ];
        for (const { id, role } of dependencies) {
          const old = changed.get(id);
          const replacement = nextTypes.get(id);
          if (!deleting && (!old || replacement?.type === old.type && role !== 'unique key')) continue;
          if (!candidate.canManage) { restricted = true; continue; }
          problems.push({ fieldId: id, dependency: field.lookup ? 'lookup' : 'related',
            dependentAppId: candidate.id, dependentFieldId: field.fieldId, version, reason: 'Inbound reference uses this ' + role });
        }
      }
    }
  }
  if (restricted) problems.push({ fieldId: '', dependency: 'reference',
    reason: 'An incoming reference requires review by an authorized application administrator' });
  return problems;
}

export async function inspectWorkflowChanges(tx: TenantTransaction, identity: Identity,
  current: FieldDefinition[], draft: FieldDefinition[], enabled: boolean, fallback: boolean,
  disclose: { auth: AuthorizationService; access: RecordAccess | undefined },
) {
  const types = new Map(draft.map(({ fieldId, type }) => [fieldId, type]));
  const changed = new Set(current.filter(({ fieldId, type }) => types.get(fieldId) !== type).map(({ fieldId }) => fieldId));
  const problems: CollaborationProblem[] = [];
  const resolved: CollaborationProblem[] = [];
  const pool: string[] = [];
  if (!changed.size) return { problems, resolved, pool };
  const definitions = await tx.select().from(workflowDefinitions)
    .where(and(workflowScope(identity), eq(workflowDefinitions.status, 'published')))
    .orderBy(sql`${workflowDefinitions.version} DESC`);
  for (const definition of definitions) {
    const { states, actions } = await readWorkflowGraph(tx, definition);
    const conditionRefs = actions.flatMap(({ id, conditions }) => conditions.filter(({ fieldId }) => changed.has(fieldId))
      .map(({ fieldId }) => ({ fieldId, objectId: id })));
    const assigneeRefs = [...states, ...actions].flatMap(({ id, assignees }) => assignees.flatMap((rule) =>
      rule.kind === 'user-field' && changed.has(rule.id) ? [{ fieldId: rule.id, objectId: id }] : []));
    if (!conditionRefs.length && !assigneeRefs.length) continue;
    const openScope = and(eq(recordWorkflowState.tenantId, identity.tenantId), eq(recordWorkflowState.appId, identity.appId),
      eq(recordWorkflowState.workflowId, definition.id), eq(workflowStates.terminal, false), isNull(records.deletedAt));
    const stateJoin = and(eq(workflowStates.tenantId, recordWorkflowState.tenantId), eq(workflowStates.appId, recordWorkflowState.appId),
      eq(workflowStates.workflowId, recordWorkflowState.workflowId), eq(workflowStates.id, recordWorkflowState.stateId));
    const recordJoin = and(eq(records.tenantId, recordWorkflowState.tenantId), eq(records.appId, recordWorkflowState.appId),
      eq(records.id, recordWorkflowState.recordId));
    const candidates = await tx.select({ id: recordWorkflowState.recordId }).from(recordWorkflowState)
      .innerJoin(workflowStates, stateJoin).innerJoin(records, recordJoin).where(openScope);
    const [visible] = disclose.access ? await tx.select({ count: sql<string>`count(*)::text` }).from(recordWorkflowState)
      .innerJoin(workflowStates, stateJoin).innerJoin(records, recordJoin)
      .where(and(openScope, disclose.auth.recordScope(disclose.access, 'view'))) : [];
    const recordCount = visible?.count === String(candidates.length) ? visible.count : undefined;
    const usedByNew = enabled && definition.id === definitions[0].id;
    for (const ref of conditionRefs) {
      const issue = { ...ref, version: definition.version, dependency: 'workflow-condition', recordCount,
        reason: 'Published action references a removed or changed condition field',
        remedy: 'Finish open records on this version and publish a compatible definition for new records' };
      (candidates.length || usedByNew ? problems : resolved).push(issue);
    }
    for (const ref of assigneeRefs) {
      const issue = { ...ref, version: definition.version, dependency: 'workflow-assignee', recordCount,
        reason: 'Published assignee rule references a removed or changed user field',
        remedy: usedByNew ? 'Publish a compatible workflow or stop new workflow entry, then select the administrator pool' :
          'Move affected open records to the administrator pool with an assignee warning' };
      (usedByNew || candidates.length && !fallback ? problems : resolved).push(issue);
    }
    if (assigneeRefs.length && !usedByNew && fallback) pool.push(...candidates.map(({ id }) => id));
  }
  return { problems, resolved, pool };
}

export async function moveToAdministratorPool(tx: TenantTransaction, context: TenantContext, appId: string, ids: string[]) {
  if (!ids.length) return;
  const identity = { tenantId: context.tenantId, appId };
  const reason = 'An assignee source changed during schema publication. Assign active users to resume.';
  for (const recordId of ids) {
    const scope = { ...identity, recordId };
    const [workflow] = await tx.update(recordWorkflowState).set({ attentionReason: reason }).where(workStateScope(scope)).returning();
    const [row] = await tx.update(records).set({
      revision: sql`${records.revision} + 1`, updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(records.tenantId, identity.tenantId), eq(records.appId, appId), eq(records.id, recordId))).returning();
    await setAssignees(tx, scope, [], 'administrator-pool');
    const eventId = await writeRecordEvent(tx, context, serializeRecord(row), 'workflow-pool', [], 'migration');
    await tx.insert(workflowEvents).values({ ...identity, eventId, workflowId: workflow.workflowId,
      fromStateId: workflow.stateId, toStateId: workflow.stateId, reason, assigneeIds: [] });
  }
}
