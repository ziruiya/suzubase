import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  and, apps, appVersions, eq, groupMembers, isNull, memberGroups, or, organizations,
  permissionAudit, records, sql, tenantMembers, tenants, TenantContext, TenantTransaction,
} from '@suzubase/db';
import {
  AclConfiguration, AppAction, appActions, DirectorySubject, fieldActions, FieldAction,
  RecordAction, recordActions, RecordSubject, ViewCondition, multiOptionFieldTypes, FieldType, type FieldDefinition,
} from '@suzubase/shared-types';

export interface PermissionDecision {
  allowed: boolean;
  matched: string[];
}

@Injectable()
export class AuthorizationService {
  private membership(context: TenantContext) {
    return and(eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, context.userId),
      isNull(tenantMembers.disabledAt));
  }

  private appRuleMatches(context: TenantContext, action: AppAction) {
    return sql`EXISTS (
      SELECT 1 FROM ${appVersions}
      CROSS JOIN LATERAL jsonb_array_elements(${appVersions.aclConfiguration}->'app') AS grant_rule(rule)
      WHERE ${appVersions.tenantId} = ${apps.tenantId}
        AND ${appVersions.appId} = ${apps.id}
        AND ${appVersions.version} = ${apps.publishedSchemaVersion}
        AND grant_rule.rule->>'action' = ${action}
        AND (
          (grant_rule.rule->'subject'->>'kind' = 'user' AND grant_rule.rule->'subject'->>'id' = ${context.userId})
          OR (grant_rule.rule->'subject'->>'kind' = 'group' AND EXISTS (
            SELECT 1 FROM ${groupMembers}
            WHERE ${groupMembers.tenantId} = ${apps.tenantId} AND ${groupMembers.userId} = ${context.userId}
              AND ${groupMembers.groupId}::text = grant_rule.rule->'subject'->>'id'
          ))
          OR (grant_rule.rule->'subject'->>'kind' = 'organization' AND EXISTS (
            SELECT 1 FROM ${tenantMembers} WHERE ${this.membership(context)}
              AND ${tenantMembers.organizationId}::text = grant_rule.rule->'subject'->>'id'
          ))
        )
    )`;
  }

  appScope(context: TenantContext, appId: string | undefined, action: AppAction = 'view') {
    return and(eq(apps.tenantId, context.tenantId), appId ? eq(apps.id, appId) : undefined, isNull(apps.deletedAt),
      this.appAction(context, action));
  }

  private appAction(context: TenantContext, action: AppAction) {
    return and(
      sql`EXISTS (SELECT 1 FROM ${tenantMembers} WHERE ${this.membership(context)})`,
      or(
        eq(apps.createdBy, context.userId),
        sql`EXISTS (SELECT 1 FROM ${tenantMembers} WHERE ${this.membership(context)} AND ${tenantMembers.isAdmin})`,
        this.appRuleMatches(context, action),
      ),
    );
  }

  appManagementScope(context: TenantContext) {
    return and(eq(apps.tenantId, context.tenantId), this.appAction(context, 'manage'));
  }

  async requireRecycleAccess(tx: TenantTransaction, context: TenantContext) {
    const [member] = await tx.select({ allowed: tenantMembers.canManageRecycleBin }).from(tenantMembers)
      .where(this.membership(context));
    return member?.allowed ?? false;
  }

  async canCreateApp(tx: TenantTransaction, context: TenantContext) {
    const [member] = await tx.select({ allowed: tenantMembers.canCreateApps, admin: tenantMembers.isAdmin, tenantAllows: tenants.allowAppCreation })
      .from(tenantMembers).innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId)).where(this.membership(context));
    return Boolean(member && (member.admin || member.allowed || member.tenantAllows));
  }

  async configuration(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    const [snapshot] = await tx.select({ acl: appVersions.aclConfiguration }).from(appVersions).where(and(
      eq(appVersions.tenantId, context.tenantId), eq(appVersions.appId, appId), eq(appVersions.version, version),
    ));
    if (!snapshot) throw new NotFoundException('无权限');
    return snapshot.acl;
  }

  async principal(tx: TenantTransaction, context: TenantContext) {
    const [member] = await tx.select().from(tenantMembers).where(this.membership(context));
    if (!member) throw new NotFoundException('无权限');
    const groups = await tx.select({ id: groupMembers.groupId }).from(groupMembers).where(and(
      eq(groupMembers.tenantId, context.tenantId), eq(groupMembers.userId, context.userId),
    ));
    return { ...context, organizationId: member.organizationId, groups: groups.map(({ id }) => id) };
  }

  private matches(principal: Principal, subject: RecordSubject) {
    switch (subject.kind) {
      case 'user': return subject.id === principal.userId;
      case 'organization': return subject.id === principal.organizationId;
      case 'group': return principal.groups.includes(subject.id);
      case 'user-field': return sql`${records.data}->>${subject.id}::text = ${principal.userId}`;
      case 'organization-field': return principal.organizationId === null ? false :
        sql`${records.data}->>${subject.id}::text = ${principal.organizationId}`;
      case 'group-field': return principal.groups.length === 0 ? false :
        sql`(${records.data}->>${subject.id}::text) IN (${sql.join(principal.groups.map((id) => sql`${id}`), sql`,`)})`;
    }
  }

  condition(context: TenantContext, condition: ViewCondition, type?: FieldType) {
    const value = sql`(${records.data} ->> ${condition.fieldId}::text)`;
    const empty = type && (multiOptionFieldTypes.has(type) || type === 'attachment')
      ? sql`COALESCE(${value}, '') IN ('', '[]')` : sql`COALESCE(${value}, '') = ''`;
    switch (condition.operator) {
      case 'eq': return sql`${value} = ${condition.value}`;
      case 'ne': return sql`${value} <> ${condition.value}`;
      case 'empty': return empty;
      case 'nonempty': return sql`NOT (${empty})`;
      case 'current-user': return sql`${value} = ${context.userId}`;
      case 'current-user-group': return sql`EXISTS (
        SELECT 1 FROM ${groupMembers}
        WHERE ${groupMembers.tenantId} = ${records.tenantId}
          AND ${groupMembers.userId} = ${context.userId}
          AND ${groupMembers.groupId}::text = ${value}
      )`;
    }
  }

  recordRules(principal: Principal, acl: AclConfiguration, action: RecordAction, types: ReadonlyMap<string, FieldType>) {
    return acl.record.filter((rule) => rule.action === action).map((rule) => {
      const subject = this.matches(principal, rule.subject);
      const predicate = subject === false ? sql`false` : and(
        subject === true ? undefined : subject,
        ...rule.conditions.map((condition) => this.condition(principal, condition, types.get(condition.fieldId))),
      ) ?? sql`true`;
      return { id: rule.id, predicate };
    });
  }

  recordScope(access: RecordAccess, action: RecordAction) {
    const rules = this.recordRules(access.principal, access.acl, action, access.types);
    return rules.length ? or(...rules.map(({ predicate }) => predicate)) : undefined;
  }

  fieldDecision(access: RecordAccess, fieldId: string, action: FieldAction): PermissionDecision {
    if (action === 'view' && access.formulaRefs?.get(fieldId)?.some((id) => !access.types.has(id) || !this.fieldDecision(access, id, 'view').allowed)) {
      return { allowed: false, matched: [] };
    }
    const rules = access.acl.field.filter((rule) => rule.fieldId === fieldId && rule.action === action);
    const matched = rules.filter((rule) => this.matches(access.principal, rule.subject) === true).map(({ id }) => id);
    return rules.length ? { allowed: matched.length > 0, matched } : { allowed: true, matched: ['default-field-access'] };
  }

  editable(access: RecordAccess, fieldId: string) {
    return this.fieldDecision(access, fieldId, 'view').allowed && this.fieldDecision(access, fieldId, 'edit').allowed;
  }

  projection(access: RecordAccess) {
    const hidden = [...access.types.keys()].filter((id) => !this.fieldDecision(access, id, 'view').allowed);
    return hidden.length ? sql<(typeof records.$inferSelect)['data']>`
      ${records.data} - ARRAY[${sql.join(hidden.map((id) => sql`${id}::text`), sql`,`)}]::text[]
    ` : records.data;
  }

  async validateDirectorySubject(tx: TenantTransaction, context: TenantContext, subject: DirectorySubject) {
    const identity = {
      user: [tenantMembers, tenantMembers.tenantId, tenantMembers.userId],
      organization: [organizations, organizations.tenantId, organizations.id],
      group: [memberGroups, memberGroups.tenantId, memberGroups.id],
    } as const;
    const [table, tenantColumn, idColumn] = identity[subject.kind];
    const [target] = await tx.select({ id: idColumn }).from(table)
      .where(and(eq(tenantColumn, context.tenantId), eq(idColumn, subject.id)));
    if (!target) throw new BadRequestException('Unknown permission subject');
  }

  async preview(tx: TenantTransaction, actor: TenantContext, appId: string, targetId: string, recordId: string | undefined,
    types: Map<string, FieldType>) {
    const [app] = await tx.select().from(apps).where(this.appScope(actor, appId, 'manage'));
    if (!app) throw new NotFoundException('无权限');
    const target = { tenantId: actor.tenantId, userId: targetId };
    const principal = await this.principal(tx, target);
    const acl = await this.configuration(tx, target, appId, app.publishedSchemaVersion);
    const access = { principal, acl, types };
    const appDecisions = {} as Record<AppAction, PermissionDecision>;
    for (const action of appActions) {
      const [row] = await tx.select({ id: apps.id }).from(apps).where(this.appScope(target, appId, action));
      const matched = acl.app.filter((rule) => rule.action === action && this.matches(principal, rule.subject) === true).map(({ id }) => id);
      const allowed = Boolean(row);
      appDecisions[action] = { allowed, matched: allowed && !matched.length ? ['app-owner-or-tenant-admin'] : matched };
    }
    const recordDecisions = {} as Record<RecordAction, PermissionDecision>;
    for (const action of recordActions) {
      const gates = action === 'view' ? ['view'] as const : ['view', action] as const;
      const decision: PermissionDecision = { allowed: false, matched: [] };
      recordDecisions[action] = decision;
      if (!gates.every((gate) => appDecisions[gate].allowed) || !recordId) continue;
      const where = and(eq(records.tenantId, target.tenantId), eq(records.appId, appId), eq(records.id, recordId),
        isNull(records.deletedAt), ...gates.map((gate) => this.recordScope(access, gate)));
      const [record] = await tx.select({ id: records.id }).from(records).where(where);
      if (!record) continue;
      decision.allowed = true;
      const rules = this.recordRules(principal, acl, action, types);
      if (!rules.length) decision.matched.push('default-record-access');
      for (const rule of rules) {
        const [matched] = await tx.select({ id: records.id }).from(records).where(and(where, rule.predicate));
        if (matched) decision.matched.push(rule.id);
      }
    }
    const fieldDecisions = Object.fromEntries([...types.keys()].map((id) => [id, Object.fromEntries(
      fieldActions.map((action) => {
        const decision = this.fieldDecision(access, id, action);
        const recordGate = !recordId || recordDecisions[action === 'view' ? 'view' : 'edit'].allowed;
        const enabled = recordGate && (action === 'view' ? appDecisions.view.allowed :
          appDecisions.edit.allowed && this.editable(access, id));
        return [action, enabled ? decision : { allowed: false, matched: [] }];
      }),
    )]));
    await tx.insert(permissionAudit).values({
      tenantId: actor.tenantId, appId, actorId: actor.userId, targetUserId: targetId, recordId,
    });
    return { app: appDecisions, record: recordDecisions, fields: fieldDecisions };
  }
}

type Principal = Awaited<ReturnType<AuthorizationService['principal']>>;
export interface RecordAccess {
  principal: Principal;
  acl: AclConfiguration;
  types: ReadonlyMap<string, FieldType>;
  formulaRefs?: ReadonlyMap<string, string[]>;
}

export function formulaReferences(fields: FieldDefinition[]) {
  return new Map(fields.filter(({ formula }) => formula).map(({ fieldId, formula }) =>
    [fieldId, formula!.flatMap((token) => token.kind === 'field' ? [token.fieldId] : [])]));
}
