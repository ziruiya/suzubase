import {
  BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException,
  Param, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, eq, isNull, memberGroups, organizations, sql, tenantMembers, workflowDefinitions,
  withTenantTransaction, type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import {
  fieldContract, workflowComparisonOperators, type FieldDefinition, type WorkflowGraph,
} from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { currentWorkflow, readWorkflowGraph, replaceGraph, workflowScope } from './workflow-graph';
import { normalizeValue } from './field-values';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { identifier, parseInput } from './validation';
import { conditions } from './view-input';

const name = z.string().trim().min(1).max(120).refine((value) => !/[\x00\p{Surrogate}]/u.test(value));
const assignee = z.union([
  z.strictObject({ kind: z.enum(['user', 'organization', 'group', 'user-field']), id: identifier }),
  z.strictObject({ kind: z.enum(['creator', 'previous']) }),
]);
const assignees = z.array(assignee).max(30);
const workflowCondition = z.union([
  conditions.element,
  z.strictObject({ fieldId: identifier, operator: z.enum(workflowComparisonOperators), value: z.string().max(128) }),
]);
const stateInput = z.strictObject({
  id: identifier, code: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), name, initial: z.boolean(), terminal: z.boolean(), assignees,
});
const actionInput = z.strictObject({
  id: identifier, name, eventType: z.enum(['transitioned', 'rejected']).default('transitioned'),
  automationAllowed: z.boolean().default(false),
  fromStateId: identifier, toStateId: identifier, conditions: z.array(workflowCondition).max(20), assignees,
});
const graphInput = z.strictObject({ states: z.array(stateInput).max(50), actions: z.array(actionInput).max(150) });
const enabledInput = z.strictObject({ enabled: z.boolean() });
const versionInput = z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.int().max(2147483647));
const versionSummary = z.object({ version: z.int(), status: z.enum(['draft', 'published']) });
export const workflowHttp = {
  graphInput, enabledInput, versionInput, definition: graphInput.extend(versionSummary.shape),
  settings: enabledInput.extend({ versions: z.array(versionSummary), draft: graphInput.extend(versionSummary.shape).nullable() }),
};

function graphProblems(graph: WorkflowGraph, fields: FieldDefinition[], publishing: boolean) {
  const problems: { dependency: string; fieldId?: string; objectId?: string; reason: string }[] = [];
  const add = (reason: string, objectId?: string, fieldId?: string) => problems.push({ dependency: 'workflow', objectId, fieldId, reason });
  const definitions = new Map(fields.map((field) => [field.fieldId, field]));
  const states = new Map(graph.states.map((state) => [state.id, state]));
  if (states.size !== graph.states.length || new Set(graph.states.map(({ code }) => code)).size !== graph.states.length) {
    add('Workflow state IDs and codes must be distinct');
  }
  if (new Set(graph.actions.map(({ id }) => id)).size !== graph.actions.length) add('Workflow action IDs must be distinct');
  const initials = graph.states.filter(({ initial }) => initial);
  if (initials.length > 1 || publishing && initials.length !== 1) add('Select one initial state');
  for (const action of graph.actions) {
    if (!states.has(action.fromStateId) || !states.has(action.toStateId)) add('Action must reference two existing states', action.id);
    if (states.get(action.fromStateId)?.terminal) add('Terminal states cannot have outgoing actions', action.id);
    for (const condition of action.conditions) {
      const field = definitions.get(condition.fieldId);
      if (!field || !fieldContract[field.type].filter ||
          (condition.operator === 'current-user' && field.type !== 'user') ||
          (condition.operator === 'current-user-group' && field.type !== 'group') ||
          (condition.operator !== 'eq' && condition.operator !== 'ne' && 'value' in condition && field.type !== 'number')) {
        add('Unsupported condition or missing field', action.id, condition.fieldId);
      } else if ('value' in condition) {
        const value = normalizeValue(field.type, condition.value, field.options);
        if (value === undefined) add('Invalid condition value', action.id, condition.fieldId);
        else condition.value = value;
      }
    }
  }
  for (const object of [...graph.states, ...graph.actions]) {
    for (const rule of object.assignees) {
      if (rule.kind === 'user-field' && definitions.get(rule.id)?.type !== 'user') add('Assignees require an existing user field', object.id, rule.id);
      if ('initial' in object && object.initial && rule.kind === 'previous') add('The initial state has no previous assignees', object.id);
    }
  }
  return problems;
}

async function directoryProblems(tx: TenantTransaction, tenantId: string, graph: WorkflowGraph) {
  const problems = [];
  for (const object of [...graph.states, ...graph.actions]) {
    for (const rule of object.assignees) {
      if (!('id' in rule) || rule.kind === 'user-field') continue;
      const rows = rule.kind === 'user'
        ? await tx.select({ id: tenantMembers.userId }).from(tenantMembers).where(and(
          eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, rule.id), isNull(tenantMembers.disabledAt)))
        : rule.kind === 'organization'
          ? await tx.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.tenantId, tenantId), eq(organizations.id, rule.id)))
          : await tx.select({ id: memberGroups.id }).from(memberGroups).where(and(eq(memberGroups.tenantId, tenantId), eq(memberGroups.id, rule.id)));
      if (!rows.length) problems.push({ dependency: 'workflow', objectId: object.id, reason: 'Assignee source is unavailable: ' + rule.id });
    }
  }
  return problems;
}

@Injectable()
export class WorkflowDefinitionService {
  constructor(private readonly schema: AppSchemaService) {}

  settings(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      const versions = await tx.select().from(workflowDefinitions).where(workflowScope({ tenantId: context.tenantId, appId }))
        .orderBy(sql`${workflowDefinitions.version} DESC`);
      const draft = versions.find(({ status }) => status === 'draft');
      return { enabled: app.workflowEnabled, versions: versions.map(({ status, version }) => ({ status, version })),
        draft: draft ? await readWorkflowGraph(tx, draft) : null };
    });
  }

  directory(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      return this.schema.directoryOptions(tx, context, new Set(['user', 'organization', 'group']));
    });
  }

  version(context: TenantContext, appId: string, version: number) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.managedApp(tx, context, appId);
      const [row] = await tx.select().from(workflowDefinitions).where(and(
        workflowScope({ tenantId: context.tenantId, appId }), eq(workflowDefinitions.version, version),
      ));
      if (!row) throw new NotFoundException('Unknown workflow version');
      return readWorkflowGraph(tx, row);
    });
  }

  save(context: TenantContext, appId: string, graph: WorkflowGraph) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      if (app.archivedAt) throw new ConflictException('Application is archived');
      const identity = { tenantId: context.tenantId, appId };
      const fields = await this.schema.getFields(tx, context, appId, app.draftSchemaVersion ?? app.publishedSchemaVersion);
      const problems = [...graphProblems(graph, fields, false), ...await directoryProblems(tx, context.tenantId, graph)];
      if (problems.length) throw new BadRequestException({ problems });
      const [latest] = await tx.select().from(workflowDefinitions).where(workflowScope(identity))
        .orderBy(sql`${workflowDefinitions.version} DESC`).limit(1);
      const draft = latest?.status === 'draft' ? latest : (await tx.insert(workflowDefinitions).values({
        ...identity, version: (latest?.version ?? 0) + 1, status: 'draft',
      }).returning())[0];
      await replaceGraph(tx, draft, graph);
      return { ...graph, status: draft.status, version: draft.version };
    });
  }

  publish(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      if (app.archivedAt) throw new ConflictException('Application is archived');
      const scope = workflowScope({ tenantId: context.tenantId, appId });
      const [draft] = await tx.select().from(workflowDefinitions).where(and(scope, eq(workflowDefinitions.status, 'draft')));
      if (!draft) throw new ConflictException('Save a workflow draft before publishing');
      const graph = await readWorkflowGraph(tx, draft);
      const fields = await this.schema.getFields(tx, context, appId, app.publishedSchemaVersion);
      const problems = [...graphProblems(graph, fields, true), ...await directoryProblems(tx, context.tenantId, graph)];
      const snapshot = await this.schema.getVersion(tx, context, appId, app.publishedSchemaVersion);
      problems.push(...await this.schema.checkDependencies(tx, context, app, fields, fields, snapshot));
      if (problems.length) throw new ConflictException({ problems });
      await tx.update(workflowDefinitions).set({ status: 'published' })
        .where(and(scope, eq(workflowDefinitions.id, draft.id), eq(workflowDefinitions.status, 'draft')));
      return { ...graph, status: 'published' as const };
    });
  }

  enable(context: TenantContext, appId: string, enabled: boolean) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.schema.managedApp(tx, context, appId);
      if (app.archivedAt) throw new ConflictException('Application is archived');
      if (enabled) {
        const current = await currentWorkflow(tx, { tenantId: context.tenantId, appId });
        if (!current) throw new ConflictException('Publish a workflow before enabling it');
        const graph = await readWorkflowGraph(tx, current);
        const fields = await this.schema.getFields(tx, context, appId, app.publishedSchemaVersion);
        const problems = [...graphProblems(graph, fields, true), ...await directoryProblems(tx, context.tenantId, graph)];
        if (problems.length) throw new ConflictException({ problems });
      }
      await tx.update(apps).set({ workflowEnabled: enabled })
        .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
      return { enabled };
    });
  }
}

@ApiTags('workflows')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/workflow')
export class WorkflowDefinitionController {
  constructor(private readonly workflows: WorkflowDefinitionService) {}

  @Get()
  settings(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.workflows.settings(context, parseInput(identifier, appId));
  }

  @Get('directory')
  directory(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.workflows.directory(context, parseInput(identifier, appId));
  }

  @Get('versions/:version')
  version(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('version') version: string) {
    return this.workflows.version(context, parseInput(identifier, appId), parseInput(versionInput, version));
  }

  @Put('draft')
  save(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.workflows.save(context, parseInput(identifier, appId), parseInput(graphInput, body));
  }

  @Post('publish')
  publish(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.workflows.publish(context, parseInput(identifier, appId));
  }

  @Patch('enabled')
  enable(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.workflows.enable(context, parseInput(identifier, appId), parseInput(enabledInput, body).enabled);
  }
}
