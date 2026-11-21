import { randomBytes } from 'node:crypto';
import {
  Body, ConflictException, Controller, Delete, Get, Injectable, NotFoundException, Param, Post, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { and, apiTokenHash, apiTokens, eq, isNull, sql, TenantContext, withTenantTransaction } from '@suzubase/db';
import { apiTokenActions } from '@suzubase/shared-types';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { identifier, parseInput } from './validation';

const issueInput = z.strictObject({
  label: z.string().trim().min(1).max(120).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
  actions: z.array(z.enum(apiTokenActions)).min(1).max(apiTokenActions.length)
    .refine((actions) => new Set(actions).size === actions.length),
});

const publicFields = {
  id: apiTokens.id,
  label: apiTokens.label,
  actions: apiTokens.actions,
  createdAt: apiTokens.createdAt,
  issuedBy: apiTokens.issuedBy,
  revokedAt: apiTokens.revokedAt,
};

@Injectable()
export class ApiTokenService {
  constructor(private readonly schema: AppSchemaService) {}

  private scope(context: TenantContext, appId: string) {
    return and(eq(apiTokens.tenantId, context.tenantId), eq(apiTokens.appId, appId));
  }

  issue(context: TenantContext, appId: string, input: z.infer<typeof issueInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'manage', true);
      const [active] = await tx.select({ count: sql<number>`count(*)::int` }).from(apiTokens)
        .where(and(this.scope(context, appId), isNull(apiTokens.revokedAt)));
      if (active.count >= 50) throw new ConflictException('An application may have at most 50 active API tokens');
      const token = 'sb1_' + randomBytes(32).toString('base64url');
      const [stored] = await tx.insert(apiTokens).values({
        tenantId: context.tenantId, appId, issuedBy: context.userId, secretHash: apiTokenHash(token), ...input,
      }).returning(publicFields);
      return { ...stored, token };
    });
  }

  list(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'manage');
      return tx.select(publicFields).from(apiTokens).where(this.scope(context, appId)).orderBy(apiTokens.createdAt);
    });
  }

  revoke(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'manage', true);
      const [token] = await tx.update(apiTokens).set({ revokedAt: sql`COALESCE(${apiTokens.revokedAt}, clock_timestamp())` })
        .where(and(this.scope(context, appId), eq(apiTokens.id, id))).returning(publicFields);
      if (!token) throw new NotFoundException('无权限');
      return token;
    });
  }
}

@ApiTags('app API tokens')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/tokens')
export class ApiTokenController {
  constructor(private readonly tokens: ApiTokenService) {}

  @Post()
  @ApiBody({ schema: {
    type: 'object', additionalProperties: false, required: ['label', 'actions'],
    properties: { label: { type: 'string', maxLength: 120 },
      actions: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...apiTokenActions] } } },
  } })
  @ApiCreatedResponse({ description: 'Token metadata and the bearer secret. The secret is visible only in this response.' })
  issue(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.tokens.issue(context, parseInput(identifier, appId), parseInput(issueInput, body));
  }

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.tokens.list(context, parseInput(identifier, appId));
  }

  @Delete(':tokenId')
  revoke(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('tokenId') id: string) {
    return this.tokens.revoke(context, parseInput(identifier, appId), parseInput(identifier, id));
  }
}
