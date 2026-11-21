import {
  Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException,
  Param, Post, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import {
  and, apps, appCounters, appVersions, eq, fields, lte, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { fieldTypes } from '@suzubase/shared-types';
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
const fieldInput = z.strictObject({ ...metadata, type: z.enum(fieldTypes) });
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
      return { id: app.id, name: app.name, code: app.code, schemaVersion: app.publishedSchemaVersion, fields: definitions };
    });
  }

  getFields(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    return tx.select({ fieldId: fields.fieldId, code: fields.code, name: fields.name, type: fields.type })
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

  async publish(context: TenantContext, appId: string) {
    const result = await withTenantTransaction(context, async (tx) => {
      const app = await this.findApp(tx, context, appId, true);
      const version = app.draftSchemaVersion;
      if (version === null) throw new ConflictException('No draft to publish');
      const [addition] = await tx.select({ fieldId: fields.fieldId }).from(fields).where(and(
        eq(fields.tenantId, context.tenantId), eq(fields.appId, appId), eq(fields.introducedIn, version),
      )).limit(1);
      // B0 drafts can only add optional fields. Existing definitions are immutable, so
      // a valid successor with an addition has no destructive dependencies to check.
      if (version !== app.publishedSchemaVersion + 1 || !addition) {
        await tx.update(apps).set({ draftStatus: 'validation-failed' })
          .where(this.authorization.appScope(context, appId));
        return { failure: { appId, version, message: 'Expected the next schema version with at least one new field' } };
      }
      const [published] = await tx.update(apps).set({
        publishedSchemaVersion: version, draftSchemaVersion: null, draftStatus: null,
      }).where(this.authorization.appScope(context, appId)).returning();
      return { published };
    });
    if (result.failure) throw new ConflictException(result.failure);
    return result.published;
  }

  async publishedVersion(tx: TenantTransaction, context: TenantContext, appId: string) {
    return (await this.findApp(tx, context, appId)).publishedSchemaVersion;
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

  @Post(':appId/publish')
  publish(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.publish(context, parseInput(identifier, id));
  }
}
