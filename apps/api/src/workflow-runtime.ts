import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, eq, gt, indexNumericPattern, isNull, records, recordEvents, recordWorkflowState, sql, tenantMembers, users, workflowActions, workflowAssignments,
  workflowEvents, workflowStates, withTenantTransaction, type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import type { ViewCondition, WorkflowCondition } from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService, type RecordAccess } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { NotificationPlanner } from './notification-planner';
import { serializeRecord, writeRecordEvent } from './record-events';
import { assignmentScope, resolveAssignees, setAssignees, workStateScope } from './workflow-data';
import { identifier, parseInput } from './validation';

const revision = z.int().min(1).max(2147483647);
const executeInput = z.strictObject({ action_id: identifier, revision });
const assigneeIds = z.array(identifier).min(1).max(100).refine((ids) => new Set(ids).size === ids.length);
const reassignInput = z.strictObject({ userIds: assigneeIds, revision });
const repairInput = z.strictObject({
  stateId: identifier, revision,
  reason: z.string().trim().min(1).max(2000).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
  userIds: assigneeIds.optional(),
});
const handoffInput = z.strictObject({ fromUserId: identifier, toUserId: identifier, revision });
const taskQuery = z.strictObject({
  appId: identifier.optional(), state: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  after: z.string().regex(/^[0-9a-f-]{36}:[0-9]{1,19}$/i).optional(),
});
const stateSummary = z.object({ id: identifier, code: z.string(), name: z.string(), terminal: z.boolean() });
const memberSummary = z.object({ id: identifier, name: z.string(), disabled: z.boolean() });
const runtimeSummary = z.object({
  version: z.int(), state: stateSummary, assignees: z.array(memberSummary), canReassign: z.boolean(), repairStates: z.array(stateSummary),
  actions: z.array(z.object({ id: identifier, name: z.string(), target: stateSummary, reason: z.string().nullable() })),
});
const taskPage = z.object({
  items: z.array(z.object({
    appId: identifier, appName: z.string(), recordId: identifier, recordNo: z.string(), state: z.string(), stateName: z.string(),
  })), next: z.string().nullable(),
});
const history = z.array(z.object({
  eventId: identifier, recordRevision: revision, kind: z.string(), occurredAt: z.string(), actor: z.string(),
  action: z.string().nullable(), from: z.string().nullable(), to: z.string(), reason: z.string().nullable(),
  assigneeIds: z.array(identifier),
}));
const mutation = z.object({ eventId: identifier, revision, version: z.int(), state: stateSummary, assigneeIds: z.array(identifier) });
export const workflowRuntimeHttp = { executeInput, reassignInput, handoffInput, repairInput, taskQuery, runtimeSummary, taskPage, mutation, history };
type Task = z.infer<typeof taskPage>['items'][number];

const stateColumns = {
  id: workflowStates.id, code: workflowStates.code, name: workflowStates.name, terminal: workflowStates.terminal,
};

function isOrdinaryCondition(condition: WorkflowCondition): condition is ViewCondition {
  return !['lt', 'lte', 'gt', 'gte'].includes(condition.operator);
}

function workCondition(authorization: AuthorizationService, access: RecordAccess, condition: WorkflowCondition) {
  if (!isOrdinaryCondition(condition)) {
    const operator = { lt: sql`<`, lte: sql`<=`, gt: sql`>`, gte: sql`>=` }[condition.operator];
    const value = sql`(${records.data}->>${condition.fieldId}::text)`;
    return sql`(CASE WHEN ${value} ~ ${indexNumericPattern} THEN ${value}::numeric END) ${operator} ${condition.value}::numeric`;
  }
  return authorization.condition(access.principal, condition, access.types.get(condition.fieldId));
}

@Injectable()
export class WorkflowRuntimeService {
  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService,
    private readonly notifications: NotificationPlanner) {}

  private async load(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string, lock = false) {
    const { app, access } = await this.schema.access(tx, context, appId, 'view', lock);
    const scope = { tenantId: context.tenantId, appId, recordId };
    const [result] = await tx.select({
      record: records, workflow: recordWorkflowState,
      allowed: sql<boolean>`COALESCE(${this.authorization.recordScope(access, 'edit') ?? sql`true`}, false)`,
    }).from(records).leftJoin(recordWorkflowState, and(
      eq(recordWorkflowState.tenantId, records.tenantId), eq(recordWorkflowState.appId, records.appId), eq(recordWorkflowState.recordId, records.id),
    )).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, recordId),
      isNull(records.deletedAt), this.authorization.recordScope(access, 'view')));
    if (!result) throw new NotFoundException('无权限');
    const [flags] = await tx.select({
      manage: sql<boolean>`COALESCE(${this.authorization.appManagementScope(context)}, false)`,
      repair: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'workflow-repair')}, false)`,
      edit: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'edit')}, false)`,
    }).from(apps).where(eq(apps.id, appId));
    return { ...result, app, access, scope, canEdit: !app.archivedAt && result.allowed && flags.edit, canManage: flags.manage, canRepair: flags.manage && flags.repair };
  }

  private async available(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string, lock = false) {
    const loaded = await this.load(tx, context, appId, recordId, lock);
    if (!loaded.workflow) return { loaded, runtime: null, graph: new Map() };
    const { workflowId, workflowVersion, stateId } = loaded.workflow;
    const { record, access, scope, canEdit, canManage } = loaded;
    const stateScope = and(eq(workflowStates.tenantId, context.tenantId), eq(workflowStates.appId, appId), eq(workflowStates.workflowId, workflowId));
    const [state] = await tx.select(stateColumns).from(workflowStates).where(and(stateScope, eq(workflowStates.id, stateId)));
    const assignees = await tx.select({
      id: users.id, name: sql<string>`COALESCE(${users.displayName}, ${users.loginName}, ${users.email})`,
      disabled: sql<boolean>`${tenantMembers.disabledAt} IS NOT NULL`,
    }).from(workflowAssignments).innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, workflowAssignments.tenantId),
      eq(tenantMembers.userId, workflowAssignments.userId))).innerJoin(users, and(eq(users.tenantId, tenantMembers.tenantId),
      eq(users.id, tenantMembers.userId))).where(and(assignmentScope(scope), eq(workflowAssignments.active, true)))
      .orderBy(sql`2`, users.id);
    const graphRows = state.terminal ? [] : await tx.select({ action: workflowActions, target: stateColumns }).from(workflowActions)
      .innerJoin(workflowStates, and(stateScope, eq(workflowStates.id, workflowActions.toStateId)))
      .where(and(eq(workflowActions.tenantId, context.tenantId), eq(workflowActions.appId, appId),
        eq(workflowActions.workflowId, workflowId), eq(workflowActions.fromStateId, stateId)))
      .orderBy(workflowActions.name, workflowActions.id);
    const qualified = canManage || assignees.some(({ id, disabled }) => id === context.userId && !disabled);
    const actions = [];
    for (const { action, target } of graphRows) {
      let reason: string | null = null;
      if (!canEdit) reason = loaded.app.archivedAt ? 'Application is archived' : 'Record edit permission is required';
      else if (!qualified) reason = 'A current assignee or application administrator must act';
      else if (action.conditions.some(({ fieldId }) => !access.types.has(fieldId) ||
        !this.authorization.fieldDecision(access, fieldId, 'view').allowed)) reason = 'Access to a condition field is required';
      else if (action.conditions.length) {
        const [result] = await tx.select({
          met: sql<boolean>`COALESCE(${and(...action.conditions.map((condition) => workCondition(this.authorization, access, condition)))}, false)`,
        }).from(records).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, recordId),
          eq(records.revision, record.revision)));
        if (!result?.met) reason = 'The action conditions are not met';
      }
      actions.push({ id: action.id, name: action.name, target, reason });
    }
    const repairStates = loaded.canRepair && canEdit ? await tx.select(stateColumns).from(workflowStates).where(stateScope)
      .orderBy(workflowStates.name, workflowStates.id) : [];
    return {
      loaded, graph: new Map(graphRows.map((row) => [row.action.id, row])),
      runtime: { version: workflowVersion, state, assignees, actions, repairStates, canReassign: canEdit && canManage && !state.terminal },
    };
  }

  detail(context: TenantContext, appId: string, recordId: string) {
    return withTenantTransaction(context, async (tx) => ({ workflow: (await this.available(tx, context, appId, recordId)).runtime }));
  }

  execute(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof executeInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { loaded, runtime, graph } = await this.available(tx, context, appId, recordId, true);
      if (loaded.record.revision !== input.revision) throw new ConflictException('Workflow state or record version changed. Refresh the record.');
      const choice = runtime?.actions.find(({ id }) => id === input.action_id);
      const transition = graph.get(input.action_id);
      if (!choice || !transition || !loaded.workflow) throw new BadRequestException('Action is unavailable in the current state');
      if (choice.reason) throw new ForbiddenException(choice.reason);
      const { action, target } = transition;
      const record = serializeRecord(loaded.record);
      const assignees = await resolveAssignees(tx, context.tenantId, record, action.assignees,
        runtime!.assignees.filter(({ disabled }) => !disabled).map(({ id }) => id));
      return this.persist(tx, context, loaded, input.revision, target, target.terminal ? [] : assignees, 'workflow-action', action.id);
    });
  }

  reassign(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof reassignInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { loaded, runtime } = await this.available(tx, context, appId, recordId, true);
      if (loaded.record.revision !== input.revision) throw new ConflictException('Workflow state or record version changed. Refresh the record.');
      if (!runtime?.canReassign) throw new ForbiddenException('无权限');
      const resolved = await resolveAssignees(tx, context.tenantId, serializeRecord(loaded.record),
        input.userIds.map((id) => ({ kind: 'user', id })));
      if (resolved.length !== input.userIds.length) throw new BadRequestException('Choose active users in this tenant');
      return this.persist(tx, context, loaded, input.revision, runtime.state, resolved, 'workflow-reassigned');
    });
  }

  handoff(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof handoffInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { loaded, runtime } = await this.available(tx, context, appId, recordId, true);
      if (loaded.record.revision !== input.revision) throw new ConflictException('Workflow state or record version changed. Refresh the record.');
      if (!runtime?.canReassign) throw new ForbiddenException('无权限');
      if (input.fromUserId === input.toUserId || !runtime.assignees.some(({ id }) => id === input.fromUserId)) {
        throw new BadRequestException('Choose a different user for an active assignment');
      }
      const record = serializeRecord(loaded.record);
      const resolved = await resolveAssignees(tx, context.tenantId, record, [{ kind: 'user', id: input.toUserId }]);
      if (!resolved.length) throw new BadRequestException('Choose an active user in this tenant');
      const ids = [...new Set([...runtime.assignees.filter(({ id }) => id !== input.fromUserId).map(({ id }) => id), ...resolved])];
      return this.persist(tx, context, loaded, input.revision, runtime.state, ids, 'workflow-reassigned');
    });
  }

  repair(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof repairInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { loaded, runtime } = await this.available(tx, context, appId, recordId, true);
      if (!loaded.canRepair || !loaded.canEdit) throw new ForbiddenException('无权限');
      if (loaded.record.revision !== input.revision) throw new ConflictException('Workflow state or record version changed. Refresh the record.');
      if (!loaded.workflow || !runtime) throw new BadRequestException('Record has no workflow');
      const [target] = await tx.select({
        ...stateColumns, assignees: workflowStates.assignees,
      }).from(workflowStates).where(and(eq(workflowStates.tenantId, context.tenantId), eq(workflowStates.appId, appId),
        eq(workflowStates.workflowId, loaded.workflow.workflowId), eq(workflowStates.id, input.stateId)));
      if (!target) throw new BadRequestException('Choose a state in the record’s workflow version');
      if (target.terminal && input.userIds) throw new BadRequestException('A terminal state cannot have active assignees');
      const rules = input.userIds?.map((id) => ({ kind: 'user' as const, id })) ?? target.assignees;
      const ids = target.terminal ? [] : await resolveAssignees(tx, context.tenantId, serializeRecord(loaded.record), rules,
        runtime.assignees.filter(({ disabled }) => !disabled).map(({ id }) => id));
      if (!target.terminal && (!ids.length || input.userIds && ids.length !== input.userIds.length)) {
        throw new BadRequestException('Repair requires valid active assignees');
      }
      const { assignees: _, ...status } = target;
      return this.persist(tx, context, loaded, input.revision, status, ids, 'WORKFLOW_REPAIR', undefined, input.reason);
    });
  }

  history(context: TenantContext, appId: string, recordId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { scope } = await this.load(tx, context, appId, recordId);
      return readWorkflowHistory(tx, scope);
    });
  }

  private async persist(tx: TenantTransaction, context: TenantContext, loaded: Awaited<ReturnType<WorkflowRuntimeService['load']>>,
    revision: number, target: z.infer<typeof stateSummary>, ids: string[], kind: 'workflow-action' | 'workflow-reassigned' | 'WORKFLOW_REPAIR', actionId?: string, reason?: string,
  ) {
    const { scope, workflow } = loaded;
    const [updated] = await tx.update(records).set({
      status: target.code, revision: sql`${records.revision} + 1`, updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
    }).where(and(eq(records.tenantId, scope.tenantId), eq(records.appId, scope.appId), eq(records.id, scope.recordId),
      eq(records.revision, revision), isNull(records.deletedAt))).returning();
    if (!updated) throw new ConflictException('Workflow state changed. Refresh the record.');
    await tx.update(recordWorkflowState).set({ stateId: target.id, revision: updated.revision }).where(workStateScope(scope));
    await setAssignees(tx, scope, ids, kind);
    const record = serializeRecord(updated);
    const eventId = await writeRecordEvent(tx, context, record, kind, []);
    await tx.insert(workflowEvents).values({
      tenantId: scope.tenantId, appId: scope.appId, eventId, workflowId: workflow!.workflowId,
      actionId, reason, fromStateId: workflow!.stateId, toStateId: target.id, assigneeIds: ids,
    });
    if (kind === 'workflow-action') await this.notifications.recordEvent(tx, context, record, eventId, {
      source: 'api', trigger: 'workflow-action', schemaVersion: loaded.app.publishedSchemaVersion,
      workflowActionId: actionId, stateCode: target.code,
    });
    return { eventId, revision: updated.revision, version: workflow!.workflowVersion, state: target, assigneeIds: ids };
  }

  tasks(context: TenantContext, input: z.infer<typeof taskQuery>, unassigned = false) {
    return withTenantTransaction(context, async (tx) => {
      const [afterApp, afterNumber] = input.after?.split(':') ?? [];
      if (afterApp) parseInput(identifier, afterApp);
      if (afterNumber && BigInt(afterNumber) > 9223372036854775807n) throw new BadRequestException('Invalid cursor');
      if (unassigned && !input.appId) throw new BadRequestException('Choose an application');
      const list = await tx.select({ id: apps.id, name: apps.name }).from(apps).where(and(
        this.authorization.appScope(context, input.appId),
        unassigned ? this.authorization.appManagementScope(context) : undefined,
        isNull(apps.archivedAt), afterApp ? sql`${apps.id} >= ${afterApp}::uuid` : undefined,
      )).orderBy(apps.id);
      const limit = 50;
      const items: Task[] = [];
      for (const app of list) {
        const { access } = await this.schema.access(tx, context, app.id, 'view');
        const hasAssignee = sql`EXISTS (SELECT 1 FROM ${workflowAssignments}
          JOIN ${tenantMembers} ON ${tenantMembers.tenantId} = ${workflowAssignments.tenantId}
            AND ${tenantMembers.userId} = ${workflowAssignments.userId} AND ${tenantMembers.disabledAt} IS NULL
          WHERE ${workflowAssignments.tenantId} = ${records.tenantId} AND ${workflowAssignments.appId} = ${records.appId}
            AND ${workflowAssignments.recordId} = ${records.id} AND ${workflowAssignments.active}
            ${unassigned ? sql`` : sql`AND ${workflowAssignments.userId} = ${context.userId}`})`;
        const recordsForApp = await tx.select({
          recordId: records.id, recordNo: sql<string>`${records.recordNo}::text`, state: workflowStates.code, stateName: workflowStates.name,
        }).from(records).innerJoin(recordWorkflowState, and(eq(recordWorkflowState.tenantId, records.tenantId),
          eq(recordWorkflowState.appId, records.appId), eq(recordWorkflowState.recordId, records.id)))
          .innerJoin(workflowStates, and(eq(workflowStates.tenantId, recordWorkflowState.tenantId),
            eq(workflowStates.appId, recordWorkflowState.appId), eq(workflowStates.workflowId, recordWorkflowState.workflowId),
            eq(workflowStates.id, recordWorkflowState.stateId)))
          .where(and(eq(records.tenantId, context.tenantId), eq(records.appId, app.id), isNull(records.deletedAt),
            eq(workflowStates.terminal, false), input.state ? eq(workflowStates.code, input.state) : undefined,
            app.id === afterApp && afterNumber ? gt(records.recordNo, BigInt(afterNumber)) : undefined,
            this.authorization.recordScope(access, 'view'), unassigned ? sql`NOT (${hasAssignee})` : hasAssignee))
          .orderBy(records.recordNo).limit(limit + 1 - items.length);
        items.push(...recordsForApp.map((entry) => ({ appId: app.id, appName: app.name, ...entry })));
        if (items.length > limit) break;
      }
      const anchor = items[limit - 1];
      return { items: items.slice(0, limit), next: items.length > limit ? anchor.appId + ':' + anchor.recordNo : null };
    });
  }
}

export function readWorkflowHistory(tx: TenantTransaction, scope: { tenantId: string; appId: string; recordId: string }) {
  const stateLabel = (id: typeof workflowEvents.fromStateId | typeof workflowEvents.toStateId) => sql<string>`(
    SELECT ${workflowStates.name} FROM ${workflowStates} WHERE ${workflowStates.tenantId} = ${workflowEvents.tenantId}
      AND ${workflowStates.appId} = ${workflowEvents.appId} AND ${workflowStates.workflowId} = ${workflowEvents.workflowId}
      AND ${workflowStates.id} = ${id}
  )`;
  return tx.select({
    eventId: recordEvents.eventId, recordRevision: recordEvents.recordRevision, kind: recordEvents.kind,
    occurredAt: recordEvents.occurredAt,
    actor: sql<string>`COALESCE(${users.displayName}, ${users.loginName}, ${users.email}) ||
      CASE WHEN ${tenantMembers.disabledAt} IS NULL THEN '' ELSE '（已停用）' END`,
    action: workflowActions.name, from: sql<string | null>`${stateLabel(workflowEvents.fromStateId)}`,
    to: stateLabel(workflowEvents.toStateId), reason: workflowEvents.reason, assigneeIds: workflowEvents.assigneeIds,
  }).from(recordEvents).innerJoin(workflowEvents, and(eq(workflowEvents.tenantId, recordEvents.tenantId),
    eq(workflowEvents.appId, recordEvents.appId), eq(workflowEvents.eventId, recordEvents.eventId)))
    .leftJoin(workflowActions, and(eq(workflowActions.tenantId, workflowEvents.tenantId), eq(workflowActions.appId, workflowEvents.appId),
      eq(workflowActions.workflowId, workflowEvents.workflowId), eq(workflowActions.id, workflowEvents.actionId)))
    .innerJoin(users, and(eq(users.tenantId, recordEvents.tenantId), eq(users.id, recordEvents.actorId)))
    .innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, users.tenantId), eq(tenantMembers.userId, users.id)))
    .where(and(eq(recordEvents.tenantId, scope.tenantId), eq(recordEvents.appId, scope.appId), eq(recordEvents.recordId, scope.recordId)))
    .orderBy(recordEvents.recordRevision);
}

@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller()
export class WorkflowRuntimeController {
  constructor(private readonly workflows: WorkflowRuntimeService) {}

  @Get('apps/:appId/records/:recordId/workflow')
  detail(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') recordId: string) {
    return this.workflows.detail(context, parseInput(identifier, appId), parseInput(identifier, recordId));
  }

  @Post('apps/:appId/records/:recordId/workflow/actions')
  execute(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Body() body: unknown,
  ) {
    return this.workflows.execute(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(executeInput, body));
  }

  @Post('apps/:appId/records/:recordId/workflow/reassign')
  reassign(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Body() body: unknown,
  ) {
    return this.workflows.reassign(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(reassignInput, body));
  }

  @Post('apps/:appId/records/:recordId/workflow/handoff')
  handoff(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Body() body: unknown,
  ) {
    return this.workflows.handoff(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(handoffInput, body));
  }

  @Post('apps/:appId/records/:recordId/workflow/repair')
  repair(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Body() body: unknown,
  ) {
    return this.workflows.repair(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(repairInput, body));
  }

  @Get('apps/:appId/records/:recordId/workflow/history')
  history(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') recordId: string) {
    return this.workflows.history(context, parseInput(identifier, appId), parseInput(identifier, recordId));
  }

  @Get('workflow/tasks')
  tasks(@AuthenticatedTenant() context: TenantContext, @Query() query: unknown) {
    return this.workflows.tasks(context, parseInput(taskQuery, query));
  }

  @Get('workflow/unassigned')
  unassigned(@AuthenticatedTenant() context: TenantContext, @Query() query: unknown) {
    return this.workflows.tasks(context, parseInput(taskQuery, query), true);
  }
}
