import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException,
  Delete, Param, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import {
  and, apps, appCounters, appVersions, eq, records, fields, isNull, lte, recordReferences, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { AclConfiguration, AppAction, autoNumberHelp, fieldContract, fieldTypes, optionFieldTypes, SavedView, ViewConfiguration } from '@suzubase/shared-types';
import { z } from 'zod';
import { AuthorizationService, RecordAccess } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { aclInput } from './acl-input';
import { normalizeValue } from './field-values';
import { viewInput } from './view-input';
import { identifier, parseInput, postgresErrorCode } from './validation';

const codePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const metadata = {
  code: z.string().regex(codePattern),
  name: z.string().trim().min(1).max(120).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
};
const appInput = z.strictObject(metadata);
const settingsInput = z.strictObject({
  name: metadata.name.optional(),
  description: z.string().max(4000).optional(),
  icon: z.string().max(64).nullable().optional(),
  themeColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  titleFieldId: identifier.nullable().optional(),
  duplicateHint: z.boolean().optional(),
  numericPrecision: z.int().min(0).max(12).optional(),
  adminMemo: z.string().max(4000).optional(),
  attachmentMaxBytes: z.int().min(1).max(8 * 1024 * 1024).optional(),
  attachmentMaxCount: z.int().min(0).max(25).optional(),
  attachmentTypes: z.array(z.enum(['image/png', 'image/jpeg', 'application/pdf'])).max(3).optional(),
}).refine((settings) => Object.keys(settings).length > 0 &&
  [settings.description, settings.icon, settings.adminMemo].every((value) => !value || !/[\x00\p{Surrogate}]/u.test(value)));
const option = z.strictObject({ value: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i), label: metadata.name, disabled: z.boolean().default(false) });
const numbering = z.strictObject({
  prefix: z.string().max(32).regex(/^[A-Za-z0-9_-]*$/),
  scopeFieldId: identifier.nullable(),
  nextValue: z.string().regex(/^[1-9][0-9]{0,17}$/),
  padding: z.int().min(0).max(32),
  enabled: z.boolean(),
});
const fieldInput = z.strictObject({
  ...metadata, type: z.enum(fieldTypes), autoNumber: numbering.optional(), required: z.boolean().default(false), uniqueValue: z.boolean().default(false), options: z.array(option).max(200).default([]),
}).refine(({ options, type }) => optionFieldTypes.has(type) === (options.length > 0)
  && new Set(options.map(({ value }) => value)).size === options.length, { path: ['options'] })
  .refine(({ type, uniqueValue }) => !uniqueValue || fieldContract[type].unique, { path: ['uniqueValue'] })
  .refine(({ type, autoNumber, required }) => (type === 'autoNumber') === Boolean(autoNumber) &&
    !(type === 'autoNumber' && required), { path: ['autoNumber'] });
const metadataProperties = {
  code: { type: 'string', pattern: codePattern.source },
  name: { type: 'string', minLength: 1, maxLength: 120 },
};

@Injectable()
export class AppSchemaService {
  constructor(private readonly authorization: AuthorizationService) {}

  async createApp(context: TenantContext, input: z.infer<typeof appInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        if (!await this.authorization.canCreateApp(tx, context)) throw new ForbiddenException('Permission denied');
        const [app] = await tx.insert(apps).values({
          ...input, tenantId: context.tenantId, createdBy: context.userId,
        }).returning();
        const identity = { tenantId: context.tenantId, appId: app.id };
        await tx.insert(appVersions).values({ ...identity, version: app.publishedSchemaVersion });
        await tx.insert(appCounters).values(identity);
        return app;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('App code already in use');
      throw error;
    }
  }

  async list(context: TenantContext, bin: boolean) {
    return withTenantTransaction(context, async (tx) => {
      if (bin && !await this.authorization.requireRecycleAccess(tx, context)) throw new ForbiddenException('无权限');
      return tx.select({
        id: apps.id, code: apps.code, name: apps.name, description: apps.description, archivedAt: apps.archivedAt,
        deletedAt: apps.deletedAt,
      }).from(apps).where(and(
        bin ? this.authorization.appManagementScope(context) : this.authorization.appScope(context, undefined),
        bin ? sql`${apps.deletedAt} IS NOT NULL` : isNull(apps.deletedAt),
      )).orderBy(apps.name, apps.id);
    });
  }

  private async managedApp(tx: TenantTransaction, context: TenantContext, appId: string, deleted = false) {
    const [app] = await tx.select().from(apps).where(and(
      this.authorization.appManagementScope(context), eq(apps.id, appId),
      deleted ? sql`${apps.deletedAt} IS NOT NULL` : isNull(apps.deletedAt),
    )).for('update');
    if (!app) throw new NotFoundException('无权限');
    return app;
  }

  async settings(context: TenantContext, appId: string, input?: z.infer<typeof settingsInput>) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      if (!input) return app;
      if (input.titleFieldId) {
        const definitions = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
        if (!definitions.some(({ fieldId }) => fieldId === input.titleFieldId)) {
          throw new ConflictException('Title field must exist in the published version');
        }
      }
      const [saved] = await tx.update(apps).set(input).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, appId),
      )).returning();
      return saved;
    });
  }

  async changeLifecycle(context: TenantContext, appId: string, action: 'archive' | 'activate' | 'delete' | 'restore') {
    return withTenantTransaction(context, async (tx) => {
      if (action === 'restore' && !await this.authorization.requireRecycleAccess(tx, context)) {
        throw new ForbiddenException('无权限');
      }
      const app = await this.managedApp(tx, context, appId, action === 'restore');
      const inbound = await tx.select({ appId: recordReferences.appId }).from(recordReferences).where(and(
        eq(recordReferences.tenantId, context.tenantId), eq(recordReferences.targetAppId, appId),
      )).limit(1);
      if (action === 'delete' && inbound.length) throw new ConflictException('The application has incoming record references');
      if (action === 'restore') {
        const [outbound] = await tx.select({ appId: recordReferences.targetAppId }).from(recordReferences)
          .innerJoin(apps, and(eq(apps.tenantId, recordReferences.tenantId), eq(apps.id, recordReferences.targetAppId)))
          .where(and(eq(recordReferences.tenantId, context.tenantId), eq(recordReferences.appId, appId),
            sql`${apps.deletedAt} IS NOT NULL`)).limit(1);
        if (outbound) throw new ConflictException('A referenced application is in the recycle bin');
      }
      const now = new Date().toISOString();
      const change = {
        archive: { archivedAt: now }, activate: { archivedAt: null }, delete: { deletedAt: now }, restore: { deletedAt: null },
      }[action];
      const [saved] = await tx.update(apps).set(change).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, app.id),
      )).returning();
      return saved;
    });
  }

  async copy(context: TenantContext, appId: string, input: z.infer<typeof appInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        if (!await this.authorization.canCreateApp(tx, context)) throw new ForbiddenException('无权限');
        const source = await this.managedApp(tx, context, appId);
        const { description, icon, themeColor, duplicateHint, numericPrecision, adminMemo, attachmentMaxBytes, attachmentMaxCount, attachmentTypes } = source;
        const [copy] = await tx.insert(apps).values({
          ...input, description, icon, themeColor, duplicateHint, numericPrecision, adminMemo, attachmentMaxBytes, attachmentMaxCount, attachmentTypes,
          tenantId: context.tenantId, createdBy: context.userId,
        }).returning();
        const identity = { tenantId: context.tenantId, appId: copy.id };
        await tx.insert(appVersions).values({ ...identity, version: 1 });
        await tx.insert(appCounters).values(identity);
        const definitions = await this.getFields(tx, context, appId, source.publishedSchemaVersion);
        const fieldMapping = new Map(definitions.map(({ fieldId }) => [fieldId, randomUUID()]));
        for (const { fieldId, code, name, type, required, uniqueValue, options, autoNumber } of definitions) {
          const copiedId = fieldMapping.get(fieldId)!;
          await tx.insert(fields).values({
            ...identity, fieldId: copiedId, code, name, type, required, uniqueValue, options, introducedIn: 1,
            autoNumber: autoNumber && {
              ...autoNumber, scopeFieldId: autoNumber.scopeFieldId && fieldMapping.get(autoNumber.scopeFieldId)!,
            },
          });
          if (source.titleFieldId === fieldId) copy.titleFieldId = copiedId;
        }
        if (copy.titleFieldId) await tx.update(apps).set({ titleFieldId: copy.titleFieldId })
          .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, copy.id)));
        const sourceViews = await this.getViews(tx, context, appId, source.publishedSchemaVersion);
        const viewMapping = new Map(sourceViews.views.map(({ id }) => [id, randomUUID()]));
        const remap = <T extends { fieldId: string }>(value: T): T => ({
          ...value, fieldId: fieldMapping.get(value.fieldId)!,
        });
        const viewConfiguration: ViewConfiguration = {
          defaultId: sourceViews.defaultId ? viewMapping.get(sourceViews.defaultId)! : null,
          views: sourceViews.views.map((view) => ({
            ...view, id: viewMapping.get(view.id)!,
            columns: view.columns.map(remap), conditions: view.conditions.map(remap),
            sort: view.sort && remap(view.sort),
          })),
        };
        await tx.update(appVersions).set({ viewConfiguration }).where(this.versionScope(context, copy.id, 1));
        return copy;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('App code already in use');
      throw error;
    }
  }

  async access(
    tx: TenantTransaction, context: TenantContext, appId: string, action: AppAction, lock = false,
  ) {
    const query = tx.select().from(apps).where(this.authorization.appScope(context, appId, action));
    const [app] = await (lock ? query.for('update') : query);
    if (!app) throw new NotFoundException('无权限');
    const acl = await this.authorization.configuration(tx, context, appId, app.publishedSchemaVersion);
    const fields = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
    const principal = await this.authorization.principal(tx, context);
    const access: RecordAccess = { acl, principal, types: new Map(fields.map(({ fieldId, type }) => [fieldId, type])) };
    return { app, fields, access };
  }

  async getPublished(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { app, fields, access } = await this.access(tx, context, appId, 'view');
      const definitions = fields.filter(({ fieldId }) => this.authorization.fieldDecision(access, fieldId, 'view').allowed);
      const views = this.visibleViews(await this.getViews(tx, context, appId, app.publishedSchemaVersion), access);
      return { id: app.id, name: app.name, code: app.code, description: app.description, icon: app.icon,
        themeColor: app.themeColor,
        titleFieldId: app.titleFieldId && this.authorization.fieldDecision(access, app.titleFieldId, 'view').allowed
          ? app.titleFieldId : null,
        archivedAt: app.archivedAt, schemaVersion: app.publishedSchemaVersion, fields: definitions, ...views };
    });
  }

  visibleViews(configuration: ViewConfiguration, access: RecordAccess) {
    const visible = (fieldId: string) => this.authorization.fieldDecision(access, fieldId, 'view').allowed;
    const views = configuration.views.filter((view) =>
      view.conditions.every(({ fieldId }) => visible(fieldId)) && (!view.sort || visible(view.sort.fieldId)),
    ).map((view) => ({ ...view, columns: view.columns.filter(({ fieldId }) => visible(fieldId)) }));
    return { views, defaultId: views.some(({ id }) => id === configuration.defaultId) ? configuration.defaultId : null };
  }

  getFields(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    return tx.select({ fieldId: fields.fieldId, code: fields.code, name: fields.name, type: fields.type, required: fields.required, uniqueValue: fields.uniqueValue, autoNumber: fields.autoNumber, options: fields.options })
      .from(fields).where(and(
        eq(fields.tenantId, context.tenantId), eq(fields.appId, appId), lte(fields.introducedIn, version),
      )).orderBy(fields.introducedIn, fields.code);
  }

  async addField(context: TenantContext, appId: string, input: z.infer<typeof fieldInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        const app = await this.managedApp(tx, context, appId);
        const version = app.draftSchemaVersion ?? app.publishedSchemaVersion + 1;
        const identity = { tenantId: context.tenantId, appId };
        if (app.draftSchemaVersion === null) {
          const viewConfiguration = await this.getViews(tx, context, appId, app.publishedSchemaVersion);
          const aclConfiguration = await this.authorization.configuration(tx, context, appId, app.publishedSchemaVersion);
          await tx.insert(appVersions).values({ ...identity, version, viewConfiguration, aclConfiguration });
        }
        await tx.update(apps).set({ draftSchemaVersion: version, draftStatus: 'editing' })
          .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
        if (input.autoNumber?.scopeFieldId) {
          const definitions = await this.getFields(tx, context, appId, version);
          const scope = definitions.find(({ fieldId }) => fieldId === input.autoNumber!.scopeFieldId);
          if (!scope || !fieldContract[scope.type].sort || scope.type === 'autoNumber') {
            throw new BadRequestException('Automatic numbering requires a scalar scope field');
          }
        }
        const [field] = await tx.insert(fields).values({ ...identity, ...input, introducedIn: version }).returning();
        return field;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('Field code already in use');
      throw error;
    }
  }

  async getDraft(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const version = app.draftSchemaVersion;
      return {
        version, status: app.draftStatus, autoNumberHelp,
        fields: version === null ? [] : await this.getFields(tx, context, appId, version),
        ...await this.getViews(tx, context, appId, version ?? app.publishedSchemaVersion),
      };
    });
  }

  async setDraftRequired(context: TenantContext, appId: string, fieldId: string, required: boolean) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      if (app.draftSchemaVersion === null) throw new ConflictException('No draft to edit');
      const scope = and(eq(fields.tenantId, context.tenantId), eq(fields.appId, appId),
        eq(fields.fieldId, fieldId), eq(fields.introducedIn, app.draftSchemaVersion));
      const [field] = await tx.update(fields).set({ required }).where(scope).returning();
      if (!field) throw new NotFoundException();
      await tx.update(apps).set({ draftStatus: 'editing' })
        .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
      return field;
    });
  }

  async publish(context: TenantContext, appId: string) {
    const result = await withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const version = app.draftSchemaVersion;
      if (version === null) throw new ConflictException('No draft to publish');
      const [addition] = await tx.select({ fieldId: fields.fieldId }).from(fields).where(and(
        eq(fields.tenantId, context.tenantId), eq(fields.appId, appId), eq(fields.introducedIn, version),
      )).limit(1);
      const draftViews = await this.getViews(tx, context, appId, version);
      const publishedViews = await this.getViews(tx, context, appId, app.publishedSchemaVersion);
      const draftAcl = await this.authorization.configuration(tx, context, appId, version);
      const publishedAcl = await this.authorization.configuration(tx, context, appId, app.publishedSchemaVersion);
      const changedAcl = JSON.stringify(draftAcl) !== JSON.stringify(publishedAcl);
      const changedViews = JSON.stringify(draftViews) !== JSON.stringify(publishedViews);
      const requireFields = await tx.select({ fieldId: fields.fieldId, name: fields.name }).from(fields).where(and(
        eq(fields.tenantId, context.tenantId), eq(fields.appId, appId),
        eq(fields.introducedIn, version), eq(fields.required, true),
      ));
      const missing = requireFields.length ? await tx.select({
        recordNo: sql<string>`${records.recordNo}::text`, fieldId: fields.fieldId, field: fields.name,
      }).from(records).innerJoin(fields, and(
        eq(fields.tenantId, records.tenantId), eq(fields.appId, records.appId),
        eq(fields.introducedIn, version), eq(fields.required, true),
      )).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId),
        sql`COALESCE(${records.data} ->> ${fields.fieldId}::text, '') IN ('', '[]')`)) : [];
      if (version !== app.publishedSchemaVersion + 1 || (!addition && !changedViews && !changedAcl) || missing.length) {
        await tx.update(apps).set({ draftStatus: 'validation-failed' })
          .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
        return { failure: {
          appId, version, message: missing.length ? 'Existing records are missing required values' : 'Draft has no changes',
          problems: missing.map((problem) => ({ ...problem, value: null, reason: 'required' })),
          skippedDependencies: ['workflow', 'lookup'],
        } };
      }
      await tx.update(apps).set({ draftStatus: 'publishable' }).where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
      const [published] = await tx.update(apps).set({
        publishedSchemaVersion: version, draftSchemaVersion: null, draftStatus: null,
      }).where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId))).returning();
      return { published };
    });
    if (result.failure) throw new ConflictException(result.failure);
    return result.published;
  }

  private versionScope(context: TenantContext, appId: string, version: number) {
    return and(eq(appVersions.tenantId, context.tenantId), eq(appVersions.appId, appId), eq(appVersions.version, version));
  }

  async getViews(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    const [snapshot] = await tx.select({ configuration: appVersions.viewConfiguration }).from(appVersions)
      .where(this.versionScope(context, appId, version));
    if (!snapshot) throw new NotFoundException();
    return snapshot.configuration;
  }

  async editView(
    context: TenantContext, appId: string,
    change: { action: 'save'; id?: string; value: z.infer<typeof viewInput> }
      | { action: 'delete'; id: string } | { action: 'default'; id: string | null },
  ) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const current = app.draftSchemaVersion ?? app.publishedSchemaVersion;
      const configuration = await this.getViews(tx, context, appId, current);
      const view = configuration.views.find(({ id }) => id === change.id);
      if (change.id && !view) throw new NotFoundException();
      if (change.action === 'save') {
        const fields = await this.getFields(tx, context, appId, current);
        const input = change.value;
        const definitions = new Map(fields.map((field) => [field.fieldId, field]));
        const columnsValid = input.columns.every(({ fieldId }) => definitions.has(fieldId));
        const sortField = input.sort && definitions.get(input.sort.fieldId);
        if (!columnsValid || (input.sort && (!sortField || !fieldContract[sortField.type].sort))) {
          throw new BadRequestException('Unsupported view column or sort');
        }
        const conditions = input.conditions.map((condition) => {
          const field = definitions.get(condition.fieldId);
          if (!field || !fieldContract[field.type].filter ||
            (condition.operator === 'current-user' && field.type !== 'user') ||
            (condition.operator === 'current-user-group' && field.type !== 'group')) {
            throw new BadRequestException('Unsupported view condition');
          }
          if ('value' in condition) {
            const value = normalizeValue(field.type, condition.value, field.options);
            if (value === undefined) throw new BadRequestException('Invalid view condition value');
            return { ...condition, value };
          }
          return condition;
        });
        const saved: SavedView = { ...input, id: change.id ?? randomUUID(), conditions };
        if (view) Object.assign(view, saved);
        else configuration.views.push(saved);
      } else if (change.action === 'delete') {
        configuration.views = configuration.views.filter(({ id }) => id !== change.id);
        if (configuration.defaultId === change.id) configuration.defaultId = null;
      } else {
        configuration.defaultId = change.id;
      }
      const version = app.draftSchemaVersion ?? app.publishedSchemaVersion + 1;
      if (app.draftSchemaVersion === null) {
        const aclConfiguration = await this.authorization.configuration(tx, context, appId, current);
        await tx.insert(appVersions).values({ tenantId: context.tenantId, appId, version, viewConfiguration: configuration, aclConfiguration });
      } else {
        await tx.update(appVersions).set({ viewConfiguration: configuration }).where(this.versionScope(context, appId, version));
      }
      await tx.update(apps).set({ draftSchemaVersion: version, draftStatus: 'editing' })
        .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
      return { version, ...configuration };
    });
  }

  async editAcl(context: TenantContext, appId: string, input?: z.infer<typeof aclInput>) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const current = app.draftSchemaVersion ?? app.publishedSchemaVersion;
      if (!input) return this.authorization.configuration(tx, context, appId, current);
      const fields = await this.getFields(tx, context, appId, current);
      const definitions = new Map(fields.map((field) => [field.fieldId, field]));
      for (const { subject } of [...input.app, ...input.field, ...input.record]) {
        if (subject.kind === 'user' || subject.kind === 'group' || subject.kind === 'organization') {
          await this.authorization.validateDirectorySubject(tx, context, subject);
        } else if (definitions.get(subject.id)?.type !== subject.kind.replace('-field', '')) {
          throw new BadRequestException('Invalid record subject field');
        }
      }
      if (input.field.some(({ fieldId }) => !definitions.has(fieldId))) throw new BadRequestException('Unknown permission field');
      const aclConfiguration: AclConfiguration = {
        app: input.app.map((rule) => ({ ...rule, id: randomUUID() })),
        field: input.field.map((rule) => ({ ...rule, id: randomUUID() })),
        record: input.record.map((rule) => ({
          ...rule, id: randomUUID(), conditions: rule.conditions.map((condition) => {
            const field = definitions.get(condition.fieldId);
            if (!field || !fieldContract[field.type].filter ||
              (condition.operator === 'current-user' && field.type !== 'user') ||
              (condition.operator === 'current-user-group' && field.type !== 'group')) {
              throw new BadRequestException('Unsupported permission condition');
            }
            if ('value' in condition) {
              const value = normalizeValue(field.type, condition.value, field.options);
              if (value === undefined) throw new BadRequestException('Invalid permission condition value');
              return { ...condition, value };
            }
            return condition;
          }),
        })),
      };
      const version = app.draftSchemaVersion ?? app.publishedSchemaVersion + 1;
      if (app.draftSchemaVersion === null) {
        const viewConfiguration = await this.getViews(tx, context, appId, current);
        await tx.insert(appVersions).values({ tenantId: context.tenantId, appId, version, viewConfiguration, aclConfiguration });
      } else {
        await tx.update(appVersions).set({ aclConfiguration }).where(this.versionScope(context, appId, version));
      }
      await tx.update(apps).set({ draftSchemaVersion: version, draftStatus: 'editing' })
        .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
      return aclConfiguration;
    });
  }

  async previewPermissions(context: TenantContext, appId: string, target: string, record: string | undefined) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const fields = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
      return this.authorization.preview(tx, context, appId, target, record, new Map(fields.map(({ fieldId, type }) => [fieldId, type])));
    });
  }

  async writable(tx: TenantTransaction, context: TenantContext, appId: string, action: AppAction) {
    const authorized = await this.access(tx, context, appId, action, true);
    if (authorized.app.archivedAt) throw new ConflictException('Application is archived');
    return authorized;
  }

}

@ApiTags('app schema')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps')
export class AppSchemaController {
  constructor(private readonly schemas: AppSchemaService) {}

  @Post()
  @ApiBody({ schema: {
    type: 'object', required: ['code', 'name'], additionalProperties: false, properties: metadataProperties,
  } })
  create(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    return this.schemas.createApp(context, parseInput(appInput, body));
  }

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Query('bin') bin: unknown) {
    return this.schemas.list(context, parseInput(z.enum(['true', 'false']).optional(), bin) === 'true');
  }

  @Get(':appId/settings')
  settings(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.settings(context, parseInput(identifier, id));
  }

  @Patch(':appId/settings')
  updateSettings(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.settings(context, parseInput(identifier, id), parseInput(settingsInput, body));
  }

  @Post(':appId/lifecycle')
  lifecycle(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { action } = parseInput(z.strictObject({ action: z.enum(['archive', 'activate', 'restore']) }), body);
    return this.schemas.changeLifecycle(context, parseInput(identifier, id), action);
  }

  @Delete(':appId')
  remove(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.changeLifecycle(context, parseInput(identifier, id), 'delete');
  }

  @Post(':appId/copy')
  copy(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.copy(context, parseInput(identifier, id), parseInput(appInput, body));
  }

  @Get(':appId')
  get(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.getPublished(context, parseInput(identifier, id));
  }

  @Post(':appId/fields')
  @ApiBody({ schema: {
    type: 'object', required: ['code', 'name', 'type'], additionalProperties: false,
    properties: { ...metadataProperties, type: { type: 'string', enum: [...fieldTypes] } },
  } })
  addField(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.addField(context, parseInput(identifier, id), parseInput(fieldInput, body));
  }

  @Get(':appId/draft')
  draft(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.getDraft(context, parseInput(identifier, id));
  }

  @Patch(':appId/draft/fields/:fieldId')
  editDraft(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string,
    @Param('fieldId') fieldId: string, @Body() body: unknown) {
    const { required } = parseInput(z.strictObject({ required: z.boolean() }), body);
    return this.schemas.setDraftRequired(context, parseInput(identifier, id), parseInput(identifier, fieldId), required);
  }

  @Post(':appId/draft/views')
  createView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.editView(context, parseInput(identifier, id), { action: 'save', value: parseInput(viewInput, body) });
  }

  @Put(':appId/draft/views/default')
  defaultView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { viewId } = parseInput(z.strictObject({ viewId: identifier.nullable() }), body);
    return this.schemas.editView(context, parseInput(identifier, id), { action: 'default', id: viewId });
  }

  @Put(':appId/draft/views/:viewId')
  updateView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string,
    @Param('viewId') viewId: string, @Body() body: unknown) {
    return this.schemas.editView(context, parseInput(identifier, id), {
      action: 'save', id: parseInput(identifier, viewId), value: parseInput(viewInput, body),
    });
  }

  @Delete(':appId/draft/views/:viewId')
  deleteView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Param('viewId') viewId: string) {
    return this.schemas.editView(context, parseInput(identifier, id), { action: 'delete', id: parseInput(identifier, viewId) });
  }

  @Get(':appId/draft/acl')
  acl(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.editAcl(context, parseInput(identifier, id));
  }

  @Put(':appId/draft/acl')
  saveAcl(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.editAcl(context, parseInput(identifier, id), parseInput(aclInput, body));
  }

  @Post(':appId/permissions/preview')
  preview(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { userId, recordId } = parseInput(z.strictObject({ userId: identifier, recordId: identifier.optional() }), body);
    return this.schemas.previewPermissions(context, parseInput(identifier, id), userId, recordId);
  }

  @Post(':appId/publish')
  publish(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.publish(context, parseInput(identifier, id));
  }
}
