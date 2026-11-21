import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, Injectable,
  NotFoundException, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConflictResponse, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  and, appCounters, apps, eq, gt, isNull, memberGroups, organizations, tenantMembers, recordCreateKeys, recordEvents, recordUniqueValues, records, sql, TenantContext,
  TenantTransaction, users, withTenantTransaction,
} from '@suzubase/db';
import { FieldChange, multiOptionFieldTypes, RecordData, RecordResponse } from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { RecordQueryService } from './record-query';
import { writeRecordEvent } from './record-events';
import { normalizeValue } from './field-values';
import { identifier, parseInput } from './validation';

const dataInput = z.record(identifier, z.string());
const createInput = z.strictObject({ data: dataInput });
const updateInput = z.strictObject({ data: dataInput, revision: z.int().min(1).max(2147483647) });
const revisionInput = updateInput.pick({ revision: true });
const pageInput = z.strictObject({
  view: identifier.optional(),
  after: z.string().regex(/^[0-9]{1,19}$/).refine((value) => BigInt(value) <= 9223372036854775807n).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),
});
const keyPattern = /^[!-~]{1,128}$/;
const createKey = z.string().regex(keyPattern).optional();
const dataSchema = {
  type: 'object',
  description: 'Keys are field UUIDs. Numbers are decimal strings such as "-12.50", stored as "-12.5".',
  additionalProperties: { type: 'string' },
};

function serializeRecord(row: typeof records.$inferSelect): RecordResponse {
  const { id, appId, recordNo, data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt } = row;
  return { id, appId, recordNo: recordNo.toString(), data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt };
}

function fieldChanges(before: RecordData, after: RecordData): FieldChange[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: FieldChange[] = [];
  for (const fieldId of ids) {
    const oldValue = before[fieldId] ?? null;
    const newValue = after[fieldId] ?? null;
    if (oldValue !== newValue) changes.push({ fieldId, oldValue, newValue });
  }
  return changes;
}

@Injectable()
export class RecordService {
  constructor(
    private readonly appSchema: AppSchemaService,
    private readonly authorization: AuthorizationService,
    private readonly query: RecordQueryService,
  ) {}

  private async normalizeData(
    tx: TenantTransaction, context: TenantContext, appId: string, version: number, data: RecordData,
  ): Promise<RecordData> {
    const definitions = await this.appSchema.getFields(tx, context, appId, version);
    const fields = new Map(definitions.map((field) => [field.fieldId, field]));
    const errors: { field: string; message: string }[] = [];
    const normalizedData: RecordData = {};
    for (const [fieldId, value] of Object.entries(data)) {
      const field = fields.get(fieldId);
      if (!field) {
        errors.push({ field: fieldId, message: 'Unknown field' });
        continue;
      }
      const normalized = value === '' && field.type !== 'number' ? '' : normalizeValue(field.type, value, field.options);
      if (normalized === undefined || !await this.validDirectoryValue(tx, context, field.type, normalized)) {
        errors.push({ field: fieldId, message: `Invalid ${field.type} value` });
      } else {
        normalizedData[fieldId] = normalized;
      }
    }
    for (const field of definitions) {
      const value = normalizedData[field.fieldId];
      if (field.required && (!value || (multiOptionFieldTypes.has(field.type) && value === '[]'))) {
        errors.push({ field: field.fieldId, message: 'Required field' });
      }
    }
    if (errors.length) throw new BadRequestException(errors);
    return normalizedData;
  }

  private async validDirectoryValue(tx: TenantTransaction, context: TenantContext, type: string, id: string) {
    if (!id) return true;
    switch (type) {
      case 'user': {
        const [user] = await tx.select({ id: tenantMembers.userId }).from(tenantMembers).where(and(
          eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, id), isNull(tenantMembers.disabledAt),
        ));
        return Boolean(user);
      }
      case 'organization': {
        const [organization] = await tx.select({ id: organizations.id }).from(organizations).where(and(
          eq(organizations.tenantId, context.tenantId), eq(organizations.id, id),
        ));
        return Boolean(organization);
      }
      case 'group': {
        const [group] = await tx.select({ id: memberGroups.id }).from(memberGroups).where(and(
          eq(memberGroups.tenantId, context.tenantId), eq(memberGroups.id, id),
        ));
        return Boolean(group);
      }
      default: return true;
    }
  }

  async create(context: TenantContext, appId: string, input: z.infer<typeof createInput>, key?: string) {
    return withTenantTransaction(context, async (tx) => {
      const schemaVersion = await this.appSchema.publishedVersion(tx, context, appId);
      const identity = { tenantId: context.tenantId, appId };
      const counterScope = and(eq(appCounters.tenantId, context.tenantId), eq(appCounters.appId, appId));
      if (key !== undefined) {
        // Serialize key lookup and insertion on the same per-app row used for number allocation.
        await tx.select({ appId: appCounters.appId }).from(appCounters).where(counterScope).for('update');
        const [previous] = await tx.select({ response: recordCreateKeys.response }).from(recordCreateKeys).where(and(
          eq(recordCreateKeys.tenantId, context.tenantId), eq(recordCreateKeys.appId, appId),
          eq(recordCreateKeys.userId, context.userId), eq(recordCreateKeys.key, key),
        ));
        if (previous) {
          await this.findRecord(tx, context, appId, previous.response.id);
          return previous.response;
        }
      }

      const data = await this.normalizeData(tx, context, appId, schemaVersion, input.data);
      const [counter] = await tx.update(appCounters).set({ lastValue: sql`${appCounters.lastValue} + 1` })
        .where(counterScope).returning({ recordNo: appCounters.lastValue });
      const [row] = await tx.insert(records).values({
        ...identity, recordNo: counter.recordNo, schemaVersion, data,
        createdBy: context.userId, updatedBy: context.userId,
      }).returning();
      const record = serializeRecord(row);
      await this.reserveUniqueValues(tx, context, record);
      await writeRecordEvent(tx, context, record, 'created', fieldChanges({}, data));
      if (key !== undefined) {
        await tx.insert(recordCreateKeys).values({
          ...identity, userId: context.userId, key, recordId: record.id, response: record,
        });
      }
      return record;
    });
  }

  async get(context: TenantContext, appId: string, recordId: string) {
    return withTenantTransaction(context, (tx) => this.findRecord(tx, context, appId, recordId));
  }

  private async findRecord(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string, deleted = false) {
    const [result] = await tx.select({ record: records }).from(records)
      .innerJoin(apps, and(
        eq(apps.tenantId, records.tenantId), eq(apps.id, records.appId),
        this.authorization.appScope(context, appId),
      )).where(and(eq(records.id, recordId), deleted ? sql`${records.deletedAt} IS NOT NULL` : isNull(records.deletedAt)));
    if (!result) throw new NotFoundException();
    return serializeRecord(result.record);
  }

  async update(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof updateInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.appSchema.publishedVersion(tx, context, appId);
      const current = await this.findRecord(tx, context, appId, recordId);
      if (current.revision !== input.revision) this.rejectRevision(current);
      const data = await this.normalizeData(tx, context, appId, current.schemaVersion, input.data);
      const [row] = await tx.update(records).set({
        data, revision: sql`${records.revision} + 1`, updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, recordId),
        eq(records.revision, input.revision), isNull(records.deletedAt),
      )).returning();
      if (!row) this.rejectRevision(await this.findRecord(tx, context, appId, recordId));
      const updated = serializeRecord(row);
      await tx.delete(recordUniqueValues).where(this.uniqueValuesScope(context, appId, recordId));
      await this.reserveUniqueValues(tx, context, updated);
      await writeRecordEvent(tx, context, updated, 'updated', fieldChanges(current.data, data));
      return updated;
    });
  }

  private uniqueValuesScope(context: TenantContext, appId: string, recordId: string) {
    return and(eq(recordUniqueValues.tenantId, context.tenantId),
      eq(recordUniqueValues.appId, appId), eq(recordUniqueValues.recordId, recordId));
  }

  private async reserveUniqueValues(tx: TenantTransaction, context: TenantContext, record: RecordResponse) {
    const definitions = await this.appSchema.getFields(tx, context, record.appId, record.schemaVersion);
    for (const field of definitions) {
      const value = record.data[field.fieldId];
      if (!field.uniqueValue || !value) continue;
      const normalizedValue = value.normalize('NFKC').toLowerCase();
      // Bound the indexed key in bytes for PostgreSQL's btree entry size.
      if (Buffer.byteLength(normalizedValue) > 1000) {
        throw new BadRequestException([{ field: field.fieldId, message: 'Unique value is too long' }]);
      }
      const identity = { tenantId: context.tenantId, appId: record.appId, fieldId: field.fieldId, normalizedValue };
      const [inserted] = await tx.insert(recordUniqueValues).values({ ...identity, recordId: record.id })
        .onConflictDoNothing().returning({ recordId: recordUniqueValues.recordId });
      if (!inserted) {
        const [holder] = await tx.select({ recordId: recordUniqueValues.recordId }).from(recordUniqueValues).where(and(
          eq(recordUniqueValues.tenantId, identity.tenantId), eq(recordUniqueValues.appId, identity.appId),
          eq(recordUniqueValues.fieldId, identity.fieldId), eq(recordUniqueValues.normalizedValue, normalizedValue),
        ));
        throw new ConflictException({ field: field.fieldId, message: 'Unique value is occupied', recordId: holder?.recordId });
      }
    }
  }

  async list(context: TenantContext, appId: string, { after, limit = 50, view }: z.infer<typeof pageInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { where, sort, sortValue, numericSort, descending } = await this.query.scope(tx, context, appId, view);
      let afterCondition = after === undefined ? undefined : gt(records.recordNo, BigInt(after));
      if (after !== undefined && sort) {
        const [cursor] = await tx.select({ value: sortValue! }).from(records)
          .where(and(where, eq(records.recordNo, BigInt(after))));
        if (!cursor) throw new BadRequestException('Cursor no longer belongs to this view');
        const tieBreaker = afterCondition;
        const value = numericSort ? sql`${cursor.value}::numeric` : sql`${cursor.value}::text`;
        afterCondition = cursor.value === null
          ? sql`(${sort} IS NULL AND ${tieBreaker})`
          : sql`(
            ${sort} ${descending ? sql`<` : sql`>`} ${value}
            OR (${sort} = ${value} AND ${tieBreaker})
            OR ${sort} IS NULL
          )`;
      }
      const order = sort ? [sql`${sort} ${descending ? sql`DESC` : sql`ASC`} NULLS LAST`, records.recordNo]
        : [records.recordNo];
      const rows = await tx.select().from(records).where(and(where, afterCondition)).orderBy(...order).limit(limit + 1);
      return {
        items: rows.slice(0, limit).map(serializeRecord),
        nextCursor: rows.length > limit ? rows[limit - 1].recordNo.toString() : null,
      };
    });
  }

  async batchCreate(context: TenantContext, appId: string, inputs: z.infer<typeof createInput>[]) {
    const results = [];
    for (const [index, input] of inputs.entries()) {
      try {
        results.push({ index, record: await this.create(context, appId, input) });
      } catch (error) {
        if (!(error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException)) throw error;
        results.push({ index, status: error.getStatus(), error: error.getResponse() });
      }
    }
    return { results };
  }

  async changeLifecycle(context: TenantContext, appId: string, id: string, revision: number, restore: boolean) {
    return withTenantTransaction(context, async (tx) => {
      if (restore && !await this.authorization.requireRecycleAccess(tx, context)) throw new ForbiddenException('无权限');
      await this.appSchema.publishedVersion(tx, context, appId);
      const current = await this.findRecord(tx, context, appId, id, restore);
      if (current.revision !== revision) this.rejectRevision(current);
      const [row] = await tx.update(records).set({
        revision: sql`${records.revision} + 1`, updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
        deletedAt: restore ? null : sql`clock_timestamp()`, deletedBy: restore ? null : context.userId,
      }).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, id), eq(records.revision, revision),
      )).returning();
      if (!row) throw new ConflictException('The record changed');
      const record = serializeRecord(row);
      if (restore) await this.reserveUniqueValues(tx, context, record);
      else await tx.delete(recordUniqueValues).where(this.uniqueValuesScope(context, appId, id));
      await writeRecordEvent(tx, context, record, restore ? 'restored' : 'deleted', []);
      return record;
    });
  }

  async history(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.findRecord(tx, context, appId, id);
      const events = await tx.select({
        event: recordEvents, name: users.displayName, email: users.email, disabledAt: tenantMembers.disabledAt,
      }).from(recordEvents).innerJoin(users, and(
        eq(users.tenantId, recordEvents.tenantId), eq(users.id, recordEvents.actorId),
      )).innerJoin(tenantMembers, and(
        eq(tenantMembers.tenantId, users.tenantId), eq(tenantMembers.userId, users.id),
      )).where(and(
        eq(recordEvents.tenantId, context.tenantId), eq(recordEvents.appId, appId), eq(recordEvents.recordId, id),
      )).orderBy(recordEvents.recordRevision);
      const schemas = new Map<number, Awaited<ReturnType<AppSchemaService['getFields']>>>();
      for (const { event } of events) {
        if (!schemas.has(event.schemaVersion)) {
          schemas.set(event.schemaVersion, await this.appSchema.getFields(tx, context, appId, event.schemaVersion));
        }
      }
      return {
        events: events.map(({ event, name, email, disabledAt }) => ({
          ...event, actorLabel: (name ?? email) + (disabledAt ? '（已停用）' : ''),
        })),
        schemas: Object.fromEntries(schemas),
      };
    });
  }

  private rejectRevision(current: RecordResponse): never {
    throw new ConflictException({ code: 'REVISION_CONFLICT', message: 'The record changed', current });
  }
}

@ApiTags('records')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/records')
export class RecordsController {
  constructor(private readonly service: RecordService) {}

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Scoped to tenant, user, app and record creation. Retained until physical deletion of the record. A replay returns the original 201 response.',
    schema: { type: 'string', pattern: keyPattern.source },
  })
  @ApiBody({ schema: {
    type: 'object', required: ['data'], additionalProperties: false, properties: { data: dataSchema },
  } })
  create(
    @AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Body() body: unknown, @Headers('idempotency-key') key: unknown,
  ) {
    return this.service.create(context, parseInput(identifier, appId), parseInput(createInput, body), parseInput(createKey, key));
  }

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    return this.service.list(context, parseInput(identifier, appId), parseInput(pageInput, query));
  }

  @Post('batch')
  batch(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    const { items } = parseInput(z.strictObject({ items: z.array(createInput).min(1).max(100) }), body);
    return this.service.batchCreate(context, parseInput(identifier, appId), items);
  }

  @Delete(':recordId')
  remove(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Body() body: unknown) {
    const { revision } = parseInput(revisionInput, body);
    return this.service.changeLifecycle(context, parseInput(identifier, appId), parseInput(identifier, id), revision, false);
  }

  @Post(':recordId/restore')
  restore(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Body() body: unknown) {
    const { revision } = parseInput(revisionInput, body);
    return this.service.changeLifecycle(context, parseInput(identifier, appId), parseInput(identifier, id), revision, true);
  }

  @Get(':recordId/history')
  history(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string) {
    return this.service.history(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Get(':recordId')
  get(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string) {
    return this.service.get(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Put(':recordId')
  @ApiBody({ schema: {
    type: 'object', required: ['data', 'revision'], additionalProperties: false,
    properties: { data: { ...dataSchema, description: 'Complete replacement field map.' }, revision: { type: 'integer', minimum: 1 } },
  } })
  @ApiConflictResponse({ description: 'REVISION_CONFLICT with the current record when the supplied revision is stale.' })
  update(
    @AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Body() body: unknown,
  ) {
    return this.service.update(context, parseInput(identifier, appId), parseInput(identifier, id), parseInput(updateInput, body));
  }
}
