import { and, eq, sql, workflowActions, workflowDefinitions, workflowStates, type TenantTransaction } from '@suzubase/db';
import type { AssigneeSource, WorkflowDefinition, WorkflowGraph } from '@suzubase/shared-types';

export type Identity = { tenantId: string; appId: string };
type DefinitionRow = typeof workflowDefinitions.$inferSelect;
const selectState = {
  id: workflowStates.id, code: workflowStates.code, name: workflowStates.name,
  initial: workflowStates.initial, terminal: workflowStates.terminal, assignees: workflowStates.assignees,
};
const selectAction = {
  id: workflowActions.id, name: workflowActions.name, eventType: workflowActions.eventType,
  automationAllowed: workflowActions.automationAllowed,
  fromStateId: workflowActions.fromStateId,
  toStateId: workflowActions.toStateId, conditions: workflowActions.conditions, assignees: workflowActions.assignees,
};

export function workflowScope(identity: Identity) {
  return and(eq(workflowDefinitions.tenantId, identity.tenantId), eq(workflowDefinitions.appId, identity.appId));
}

export async function currentWorkflow(tx: TenantTransaction, identity: Identity) {
  const [latest] = await tx.select().from(workflowDefinitions)
    .where(and(workflowScope(identity), eq(workflowDefinitions.status, 'published')))
    .orderBy(sql`${workflowDefinitions.version} DESC`).limit(1);
  return latest;
}

export async function readWorkflowGraph(tx: TenantTransaction, definition: DefinitionRow): Promise<WorkflowDefinition> {
  const { tenantId, appId, id, version, status } = definition;
  const states = await tx.select(selectState).from(workflowStates).where(and(
    eq(workflowStates.tenantId, tenantId), eq(workflowStates.appId, appId), eq(workflowStates.workflowId, id),
  )).orderBy(workflowStates.code);
  const actions = await tx.select(selectAction).from(workflowActions).where(and(
    eq(workflowActions.tenantId, tenantId), eq(workflowActions.appId, appId), eq(workflowActions.workflowId, id),
  )).orderBy(workflowActions.name, workflowActions.id);
  return { version, status, states, actions };
}

export async function replaceGraph(tx: TenantTransaction, { tenantId, appId, id }: DefinitionRow, graph: WorkflowGraph) {
  await tx.delete(workflowActions).where(and(
    eq(workflowActions.tenantId, tenantId), eq(workflowActions.appId, appId), eq(workflowActions.workflowId, id),
  ));
  await tx.delete(workflowStates).where(and(
    eq(workflowStates.tenantId, tenantId), eq(workflowStates.appId, appId), eq(workflowStates.workflowId, id),
  ));
  const identity = { tenantId, appId, workflowId: id };
  if (graph.states.length) await tx.insert(workflowStates).values(graph.states.map((state) => ({ ...identity, ...state })));
  if (graph.actions.length) await tx.insert(workflowActions).values(graph.actions.map((action) => ({ ...identity, ...action })));
}

export async function copyWorkflow(tx: TenantTransaction, source: Identity, target: Identity, fieldMapping: ReadonlyMap<string, string>) {
  const published = await currentWorkflow(tx, source);
  if (!published) return;
  const graph = await readWorkflowGraph(tx, published);
  const sources = (rules: AssigneeSource[]) => rules.map((rule) =>
    rule.kind === 'user-field' ? { ...rule, id: fieldMapping.get(rule.id)! } : rule);
  const [draft] = await tx.insert(workflowDefinitions).values({ ...target, version: 1, status: 'draft' }).returning();
  await replaceGraph(tx, draft, {
    states: graph.states.map((state) => ({ ...state, assignees: sources(state.assignees) })),
    actions: graph.actions.map((action) => ({ ...action, assignees: sources(action.assignees),
      conditions: action.conditions.map((condition) => ({ ...condition, fieldId: fieldMapping.get(condition.fieldId)! })),
    })),
  });
}

export async function publishedWorkflowStates(tx: TenantTransaction, identity: Identity) {
  const rows = await tx.selectDistinctOn([workflowStates.code], { code: workflowStates.code, name: workflowStates.name })
    .from(workflowDefinitions)
    .innerJoin(workflowStates, and(eq(workflowStates.tenantId, workflowDefinitions.tenantId),
      eq(workflowStates.appId, workflowDefinitions.appId), eq(workflowStates.workflowId, workflowDefinitions.id)))
    .where(and(workflowScope(identity), eq(workflowDefinitions.status, 'published')))
    .orderBy(workflowStates.code, sql`${workflowDefinitions.version} DESC`);
  return rows;
}
