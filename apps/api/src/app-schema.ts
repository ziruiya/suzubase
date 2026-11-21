import {
  Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException,
  Delete, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import {
  and, apps, appCounters, appVersions, eq, records, fields, isNull, lte, recordReferences, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { fieldTypes, optionFieldTypes } from '@suzubase/shared-types';
import { z } from 'zod';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
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
}).refine((settings) => Object.keys(settings).length > 0 &&
  [settings.description, settings.icon, settings.adminMemo].every((value) => !value || !/[\x00\p{Surrogate}]/u.test(value)));
const option = z.strictObject({ value: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i), label: metadata.name, disabled: z.boolean().default(false) });
const fieldInput = z.strictObject({
  ...metadata, type: z.enum(fieldTypes), required: z.boolean().default(false), options: z.array(option).max(200).default([]),
}).refine(({ options, type }) => optionFieldTypes.has(type) === (options.length > 0)
  && new Set(options.map(({ value }) => value)).size === options.length, { path: ['options'] });
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
        this.authorization.appManagementScope(context),
        bin ? sql`${apps.deletedAt} IS NOT NULL` : isNull(apps.deletedAt),
      )).orderBy(apps.name, apps.id);
    });
  }

  private async managedApp(tx: TenantTransaction, context: TenantContext, appId: string, deleted = false) {
    const [app] = await tx.select().from(apps).where(and(
      this.authorization.appManagementScope(context), eq(apps.id, appId),
      deleted ? sql`${apps.deletedAt} IS NOT NULL` : isNull(apps.deletedAt),
    )).for('update');
    if (!app) throw new NotFoundException();
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
        const { description, icon, themeColor, duplicateHint, numericPrecision, adminMemo } = source;
        const [copy] = await tx.insert(apps).values({
          ...input, description, icon, themeColor, duplicateHint, numericPrecision, adminMemo,
          tenantId: context.tenantId, createdBy: context.userId,
        }).returning();
        const identity = { tenantId: context.tenantId, appId: copy.id };
        await tx.insert(appVersions).values({ ...identity, version: 1 });
        await tx.insert(appCounters).values(identity);
        const definitions = await this.getFields(tx, context, appId, source.publishedSchemaVersion);
        for (const { fieldId, code, name, type, required, options } of definitions) {
          const [field] = await tx.insert(fields).values({ ...identity, code, name, type, required, options, introducedIn: 1 }).returning();
          if (source.titleFieldId === fieldId) copy.titleFieldId = field.fieldId;
        }
        if (copy.titleFieldId) await tx.update(apps).set({ titleFieldId: copy.titleFieldId })
          .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, copy.id)));
        return copy;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('App code already in use');
      throw error;
    }
  }

  private async findApp(tx: TenantTransaction, context: TenantContext, appId: string, lock = false) {
    const query = tx.select().from(apps).where(this.authorization.appScope(context, appId));
    const [app] = await (lock ? query.for('update') : query);
    if (!app) throw new NotFoundException();
    return app;
  }

  async getPublished(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.findApp(tx, context, appId);
      const definitions = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
      return { id: app.id, name: app.name, code: app.code, description: app.description, icon: app.icon,
        themeColor: app.themeColor, titleFieldId: app.titleFieldId, archivedAt: app.archivedAt, schemaVersion: app.publishedSchemaVersion, fields: definitions };
    });
  }

  getFields(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    return tx.select({ fieldId: fields.fieldId, code: fields.code, name: fields.name, type: fields.type, required: fields.required, options: fields.options })
      .from(fields).where(and(
        eq(fields.tenantId, context.tenantId), eq(fields.appId, appId), lte(fields.introducedIn, version),
      )).orderBy(fields.introducedIn, fields.code);
  }

  async addField(context: TenantContext, appId: string, input: z.infer<typeof fieldInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        const app = await this.findApp(tx, context, appId, true);
        const version = app.draftSchemaVersion ?? app.publishedSchemaVersion + 1;
        const identity = { tenantId: context.tenantId, appId };
        if (app.draftSchemaVersion === null) {
          await tx.insert(appVersions).values({ ...identity, version });
        }
        await tx.update(apps).set({ draftSchemaVersion: version, draftStatus: 'editing' })
          .where(this.authorization.appScope(context, appId));
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
      return { version, status: app.draftStatus, fields: version === null ? [] : await this.getFields(tx, context, appId, version) };
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
      const app = await this.findApp(tx, context, appId, true);
      const version = app.draftSchemaVersion;
      if (version === null) throw new ConflictException('No draft to publish');
      const [addition] = await tx.select({ fieldId: fields.fieldId }).from(fields).where(and(
        eq(fields.tenantId, context.tenantId), eq(fields.appId, appId), eq(fields.introducedIn, version),
      )).limit(1);
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
      if (version !== app.publishedSchemaVersion + 1 || !addition || missing.length) {
        await tx.update(apps).set({ draftStatus: 'validation-failed' })
          .where(this.authorization.appScope(context, appId));
        return { failure: {
          appId, version, message: missing.length ? 'Existing records are missing required values' : 'Expected one or more new fields',
          problems: missing.map((problem) => ({ ...problem, value: null, reason: 'required' })),
          skippedDependencies: ['workflow', 'lookup'],
        } };
      }
      await tx.update(apps).set({ draftStatus: 'publishable' }).where(this.authorization.appScope(context, appId));
      const [published] = await tx.update(apps).set({
        publishedSchemaVersion: version, draftSchemaVersion: null, draftStatus: null,
      }).where(this.authorization.appScope(context, appId)).returning();
      return { published };
    });
    if (result.failure) throw new ConflictException(result.failure);
    return result.published;
  }

  async publishedVersion(tx: TenantTransaction, context: TenantContext, appId: string) {
    const app = await this.findApp(tx, context, appId, true);
    if (app.archivedAt) throw new ConflictException('Application is archived');
    return app.publishedSchemaVersion;
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

  @Post(':appId/publish')
  publish(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.publish(context, parseInput(identifier, id));
  }
}
