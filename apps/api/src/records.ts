import {
  BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Post, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import {
  and, appCounters, apps, eq, isNull, records, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { RecordData, RecordResponse } from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { writeRecordEvent } from './record-events';
import { identifier, parseInput } from './validation';

const dataInput = z.record(identifier, z.string());
const createInput = z.strictObject({ data: dataInput });
const dataSchema = {
  type: 'object',
  description: 'Keys are field UUIDs. Numbers are decimal strings such as "-12.50", stored as "-12.5".',
  additionalProperties: { type: 'string' },
};

function normalizeDecimal(value: string): string | undefined {
  if (value.length > 200) return undefined;
  const parts = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!parts || parts[0] !== value) return undefined;
  const [, sign, integer, fraction = ''] = parts;
  const whole = integer.replace(/^0+(?=\d)/, '');
  const partial = fraction.replace(/0+$/, '');
  const prefix = sign === '-' && (whole !== '0' || partial) ? '-' : '';
  return partial ? `${prefix}${whole}.${partial}` : `${prefix}${whole}`;
}

function serializeRecord(row: typeof records.$inferSelect): RecordResponse {
  const { id, appId, recordNo, data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt } = row;
  return { id, appId, recordNo: recordNo.toString(), data, schemaVersion, revision, status, createdBy, createdAt, updatedBy, updatedAt };
}

@Injectable()
export class RecordService {
  constructor(
    private readonly appSchema: AppSchemaService,
    private readonly authorization: AuthorizationService,
  ) {}

  private async normalizeData(
    tx: TenantTransaction, context: TenantContext, appId: string, version: number, data: RecordData,
  ): Promise<RecordData> {
    const definitions = await this.appSchema.getFields(tx, context, appId, version);
    const types = new Map(definitions.map(({ fieldId, type }) => [fieldId, type]));
    return Object.fromEntries(Object.entries(data).map(([fieldId, value]) => {
      const type = types.get(fieldId);
      if (!type) throw new BadRequestException(`Unknown field ${fieldId}`);
      const normalized = type === 'number'
        ? normalizeDecimal(value)
        : /[\r\n\x00\u2028\u2029\p{Surrogate}]/u.test(value) ? undefined : value;
      if (normalized === undefined) throw new BadRequestException(`Invalid ${type} value for field ${fieldId}`);
      return [fieldId, normalized];
    }));
  }

  async create(context: TenantContext, appId: string, input: z.infer<typeof createInput>) {
    return withTenantTransaction(context, async (tx) => {
      const schemaVersion = await this.appSchema.publishedVersion(tx, context, appId);
      const data = await this.normalizeData(tx, context, appId, schemaVersion, input.data);
      const identity = { tenantId: context.tenantId, appId };
      const [counter] = await tx.update(appCounters).set({ lastValue: sql`${appCounters.lastValue} + 1` })
        .where(and(eq(appCounters.tenantId, context.tenantId), eq(appCounters.appId, appId)))
        .returning({ recordNo: appCounters.lastValue });
      const [row] = await tx.insert(records).values({
        ...identity, recordNo: counter.recordNo, schemaVersion, data,
        createdBy: context.userId, updatedBy: context.userId,
      }).returning();
      const record = serializeRecord(row);
      await writeRecordEvent(tx, context, record, 'created', Object.entries(data).map(([fieldId, newValue]) => ({
        fieldId, oldValue: null, newValue,
      })));
      return record;
    });
  }

  async get(context: TenantContext, appId: string, recordId: string) {
    return withTenantTransaction(context, async (tx) => {
      const [result] = await tx.select({ record: records }).from(records)
        .innerJoin(apps, and(
          eq(apps.tenantId, records.tenantId), eq(apps.id, records.appId),
          this.authorization.appScope(context, appId),
        )).where(and(eq(records.id, recordId), isNull(records.deletedAt)));
      if (!result) throw new NotFoundException();
      return serializeRecord(result.record);
    });
  }
}

@ApiTags('records')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/records')
export class RecordsController {
  constructor(private readonly service: RecordService) {}

  @Post()
  @ApiBody({ schema: {
    type: 'object', required: ['data'], additionalProperties: false, properties: { data: dataSchema },
  } })
  create(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.service.create(context, parseInput(identifier, appId), parseInput(createInput, body));
  }

  @Get(':recordId')
  get(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string) {
    return this.service.get(context, parseInput(identifier, appId), parseInput(identifier, id));
  }
}
