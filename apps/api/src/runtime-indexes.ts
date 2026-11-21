import { Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq, inArray, isNull, records, runtimeIndexName, runtimeIndexes, sql, type TenantContext, withTenantTransaction } from '@suzubase/db';
import { indexPurposes } from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { indexJobScope, indexScope, supportsIndex } from './runtime-index-state';
import { identifier, parseInput } from './validation';

const indexInput = z.strictObject({
  fieldId: identifier,
  purpose: z.enum(indexPurposes),
  reason: z.string().trim().min(1).max(250).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
});

export const indexHttp = { indexInput };

@Injectable()
export class RuntimeIndexService {
  constructor(private readonly schema: AppSchemaService, private readonly auth: AuthorizationService) {}

  async list(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { fields } = await this.schema.access(tx, context, appId, 'manage');
      const list = await tx.select({
        job: runtimeIndexes,
        lastUsed: sql<string | null>`(SELECT last_idx_scan::text FROM pg_catalog.pg_stat_user_indexes
          WHERE schemaname = 'public' AND indexrelname = 'sb_runtime_' || md5(${runtimeIndexes.tenantId}::text || ':' || ${runtimeIndexes.appId}::text || ':' || ${runtimeIndexes.id}::text))`,
      }).from(runtimeIndexes).where(indexScope(context, appId)).orderBy(sql`${runtimeIndexes.requestedAt} DESC`).limit(100);
      const view = await this.schema.access(tx, context, appId, 'view').catch((error: unknown) => {
        if (error instanceof NotFoundException) return undefined;
        throw error;
      });
      const pendingNumbers = [...new Set(list.flatMap(({ job }) => job.problems.map(({ recordNo }) => BigInt(recordNo))))];
      const allowed = view && pendingNumbers.length ? new Set((await tx.select({ number: records.recordNo }).from(records)
        .where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId), isNull(records.deletedAt),
          inArray(records.recordNo, pendingNumbers), this.auth.recordScope(view.access, 'view')))).map(({ number }) => number.toString())) : undefined;
      return list.map(({ job, lastUsed }) => ({
        ...job, name: runtimeIndexName(job), lastUsedAt: lastUsed ?? job.lastUsedAt,
        fieldName: fields.find(({ fieldId }) => fieldId === job.fieldId)?.name ?? job.fieldId,
        problems: job.problems.filter(({ recordNo }) => allowed?.has(recordNo) && view &&
          this.auth.fieldDecision(view.access, job.fieldId, 'view').allowed),
      }));
    });
  }

  async declare(context: TenantContext, appId: string, input: z.infer<typeof indexInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { fields } = await this.schema.writable(tx, context, appId, 'manage');
      const field = fields.find(({ fieldId }) => fieldId === input.fieldId);
      if (!field || !supportsIndex(field, input.purpose)) throw new ConflictException('Published field does not support the selected index use');
      const jobs = await tx.select().from(runtimeIndexes).where(and(indexScope(context, appId), isNull(runtimeIndexes.retiredAt)));
      if (jobs.some(({ fieldId, purpose }) => fieldId === field.fieldId && purpose === input.purpose)) {
        throw new ConflictException('This field and use already have an index job');
      }
      if (jobs.length >= 12) throw new ConflictException('This application has reached its 12-index limit');
      const [job] = await tx.insert(runtimeIndexes).values({
        ...input, tenantId: context.tenantId, appId, fieldType: field.type, requestedBy: context.userId,
      }).returning();
      return job;
    });
  }

  async change(context: TenantContext, appId: string, id: string, action: 'retry' | 'retire') {
    return withTenantTransaction(context, async (tx) => {
      const { fields } = await this.schema.access(tx, context, appId, 'manage', true);
      const scope = indexJobScope(context, appId, id);
      const [job] = await tx.select().from(runtimeIndexes).where(scope).for('update');
      if (!job || job.retiredAt) throw new NotFoundException('无权限');
      if (action === 'retry') {
        const field = fields.find(({ fieldId }) => fieldId === job.fieldId);
        if (job.state !== 'failed' || job.retireRequested || field?.type !== job.fieldType || !supportsIndex(field, job.purpose)) {
          throw new ConflictException('Only eligible failed index jobs can be retried');
        }
      }
      const [updated] = await tx.update(runtimeIndexes).set(action === 'retry' ? {
        state: 'building', requestedAt: sql`now()`, requestedBy: context.userId, failureReason: null, problems: [], problemCount: 0,
      } : {
        retireRequested: job.retireRequested ?? sql`now()`, retireReason: job.retireReason ?? 'Requested by application administrator',
      }).where(scope).returning();
      return updated;
    });
  }
}

@ApiTags('runtime indexes')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/indexes')
export class RuntimeIndexController {
  constructor(private readonly indexes: RuntimeIndexService) {}

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.indexes.list(context, parseInput(identifier, appId));
  }

  @Post()
  declare(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.indexes.declare(context, parseInput(identifier, appId), parseInput(indexInput, body));
  }

  @Post(':indexId/retry')
  retry(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('indexId') id: string) {
    return this.indexes.change(context, parseInput(identifier, appId), parseInput(identifier, id), 'retry');
  }

  @Delete(':indexId')
  retire(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('indexId') id: string) {
    return this.indexes.change(context, parseInput(identifier, appId), parseInput(identifier, id), 'retire');
  }
}
