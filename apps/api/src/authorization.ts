import { Injectable } from '@nestjs/common';
import {
  and, apps, eq, fields, isNull, lte, records, tenantMembers, TenantContext, TenantTransaction,
} from '@suzubase/db';

const appActions = ['view', 'create', 'edit', 'delete', 'import', 'export', 'manage'] as const;

interface PermissionDecision {
  allowed: boolean;
  reason: 'app-creator' | 'default-deny';
}

export interface EffectivePermissionRequest {
  tenantContext: TenantContext;
  targetUserId: string;
  appId: string;
  recordId?: string;
}

export interface EffectivePermissions {
  app: Record<(typeof appActions)[number], PermissionDecision>;
  record: Record<'view' | 'edit' | 'delete', PermissionDecision>;
  fields: Record<string, Record<'view' | 'edit', PermissionDecision>>;
}

@Injectable()
export class AuthorizationService {
  appScope(context: TenantContext, appId: string) {
    return and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId), eq(apps.createdBy, context.userId));
  }

  async canCreateApp(tx: TenantTransaction, context: TenantContext): Promise<boolean> {
    const [member] = await tx.select({ allowed: tenantMembers.canCreateApps }).from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, context.userId)));
    return member?.allowed ?? false;
  }

  async evaluateEffectivePermissions(
    tx: TenantTransaction,
    { tenantContext, targetUserId, appId, recordId }: EffectivePermissionRequest,
  ): Promise<EffectivePermissions> {
    // A future permission-preview endpoint must authorize the requesting administrator.
    const target = { tenantId: tenantContext.tenantId, userId: targetUserId };
    const [app] = await tx.select().from(apps).where(this.appScope(target, appId));
    const [record] = app && recordId
      ? await tx.select({ schemaVersion: records.schemaVersion }).from(records).where(and(
        eq(records.tenantId, target.tenantId), eq(records.appId, appId), eq(records.id, recordId),
        isNull(records.deletedAt),
      ))
      : [];
    const decision = (allowed: boolean): PermissionDecision => ({
      allowed, reason: allowed ? 'app-creator' : 'default-deny',
    });
    const appPermission = decision(Boolean(app));
    const recordPermission = decision(Boolean(record));
    const visibleFields = app && (!recordId || record)
      ? await tx.select({ fieldId: fields.fieldId }).from(fields).where(and(
        eq(fields.tenantId, target.tenantId), eq(fields.appId, appId),
        lte(fields.introducedIn, record?.schemaVersion ?? app.publishedSchemaVersion),
      ))
      : [];
    return {
      app: {
        view: appPermission, create: appPermission, edit: appPermission, delete: appPermission,
        import: appPermission, export: appPermission, manage: appPermission,
      },
      record: { view: recordPermission, edit: recordPermission, delete: recordPermission },
      fields: Object.fromEntries(
        visibleFields.map(({ fieldId }) => [fieldId, { view: appPermission, edit: appPermission }]),
      ),
    };
  }
}
