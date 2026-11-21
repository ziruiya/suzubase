import {
  and, eq, groupMembers, inArray, isNull, or, recordWorkflowState, tenantMembers, workflowAssignments, workflowEvents,
  workflowStates, type TenantTransaction,
} from '@suzubase/db';
import type { AssigneeSource, RecordResponse } from '@suzubase/shared-types';
import { currentWorkflow } from './workflow-graph';

type RecordScope = { tenantId: string; appId: string; recordId: string };

export function workStateScope({ tenantId, appId, recordId }: RecordScope) {
  return and(eq(recordWorkflowState.tenantId, tenantId), eq(recordWorkflowState.appId, appId), eq(recordWorkflowState.recordId, recordId));
}
export function assignmentScope({ tenantId, appId, recordId }: RecordScope) {
  return and(eq(workflowAssignments.tenantId, tenantId), eq(workflowAssignments.appId, appId), eq(workflowAssignments.recordId, recordId));
}

export async function resolveAssignees(tx: TenantTransaction, tenantId: string,
  record: Pick<RecordResponse, 'createdBy' | 'data'>, rules: AssigneeSource[], previous: string[] = [],
) {
  const users: string[] = [];
  const organizations: string[] = [];
  const groups: string[] = [];
  for (const rule of rules) {
    switch (rule.kind) {
      case 'user': users.push(rule.id); break;
      case 'user-field': if (record.data[rule.id]) users.push(record.data[rule.id]); break;
      case 'creator': users.push(record.createdBy); break;
      case 'previous': users.push(...previous); break;
      case 'organization': organizations.push(rule.id); break;
      case 'group': groups.push(rule.id); break;
    }
  }
  if (groups.length) {
    const rows = await tx.select({ id: groupMembers.userId }).from(groupMembers)
      .where(and(eq(groupMembers.tenantId, tenantId), inArray(groupMembers.groupId, groups)));
    users.push(...rows.map(({ id }) => id));
  }
  if (!users.length && !organizations.length) return [];
  const rows = await tx.select({ id: tenantMembers.userId }).from(tenantMembers).where(and(
    eq(tenantMembers.tenantId, tenantId), isNull(tenantMembers.disabledAt),
    or(users.length ? inArray(tenantMembers.userId, users) : undefined,
      organizations.length ? inArray(tenantMembers.organizationId, organizations) : undefined),
  )).orderBy(tenantMembers.userId).for('share');
  return rows.map(({ id }) => id);
}

export async function setAssignees(tx: TenantTransaction, scope: RecordScope, ids: string[], role: string) {
  await tx.update(workflowAssignments).set({ active: false }).where(and(assignmentScope(scope), eq(workflowAssignments.active, true)));
  if (ids.length) await tx.insert(workflowAssignments).values(ids.map((userId) => ({ ...scope, userId, role })))
    .onConflictDoUpdate({
      target: [workflowAssignments.tenantId, workflowAssignments.appId, workflowAssignments.recordId, workflowAssignments.userId],
      set: { active: true, role },
    });
}

export async function initialWorkflow(tx: TenantTransaction, identity: { tenantId: string; appId: string }) {
  const definition = await currentWorkflow(tx, identity);
  if (!definition) throw new Error('Enabled workflow has no published version');
  const [state] = await tx.select().from(workflowStates).where(and(
    eq(workflowStates.tenantId, identity.tenantId), eq(workflowStates.appId, identity.appId),
    eq(workflowStates.workflowId, definition.id), eq(workflowStates.initial, true),
  ));
  if (!state) throw new Error('Published workflow has no initial state');
  return { state, definition };
}

export async function attachInitialWorkflow(tx: TenantTransaction, tenantId: string, record: RecordResponse,
  initial: Awaited<ReturnType<typeof initialWorkflow>>, eventId: string,
) {
  const scope = { tenantId, appId: record.appId, recordId: record.id };
  const { state, definition } = initial;
  const ids = state.terminal ? [] : await resolveAssignees(tx, tenantId, record, state.assignees);
  await tx.insert(recordWorkflowState).values({ ...scope, workflowId: definition.id, workflowVersion: definition.version,
    stateId: state.id, revision: record.revision });
  await setAssignees(tx, scope, ids, 'initial');
  await tx.insert(workflowEvents).values({
    tenantId, appId: record.appId, eventId, workflowId: definition.id, toStateId: state.id, assigneeIds: ids,
  });
}
