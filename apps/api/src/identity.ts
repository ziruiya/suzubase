import {
  Body, CanActivate, Controller, createParamDecorator, ExecutionContext, HttpCode,
  Injectable, Post, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { and, eq, tenantMembers, TenantContext, verifyLogin, withTenantTransaction } from '@suzubase/db';
import { z } from 'zod';
import { identifier, parseInput } from './validation';

const loginInput = z.strictObject({
  email: z.email().max(254).optional(),
  loginName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i).optional(),
  password: z.string().min(1).max(1024).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
}).refine(({ email, loginName }) => Boolean(email) !== Boolean(loginName));

const sessionClaims = z.object({ tenantId: identifier, sub: identifier, sessionVersion: z.number().int() });

interface AuthenticatedRequest {
  headers: { authorization?: string };
  tenantContext: TenantContext;
}

@ApiTags('session')
@Controller('auth')
export class SessionController {
  constructor(private readonly sessions: JwtService) {}

  @Post('login')
  @HttpCode(200)
  @ApiBody({
    schema: {
      type: 'object', required: ['email', 'password'], additionalProperties: false,
      properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' } },
    },
  })
  @ApiOkResponse({ description: 'One-hour session token for the UI and same-origin clients.' })
  async login(@Body() body: unknown) {
    const { email, loginName, password } = parseInput(loginInput, body);
    const identity = await verifyLogin((email ?? loginName!).toLowerCase(), password);
    if (!identity) throw new UnauthorizedException('Invalid credentials');
    return {
      accessToken: await this.sessions.signAsync({ tenantId: identity.tenantId, sessionVersion: identity.sessionVersion }, { subject: identity.userId }),
      expiresIn: 3600,
    };
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: JwtService) {}

  async canActivate(executionContext: ExecutionContext) {
    const request = executionContext.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException();
    try {
      const claims = sessionClaims.parse(await this.sessions.verifyAsync(match[1]));
      const identity = { tenantId: claims.tenantId, userId: claims.sub };
      const active = await withTenantTransaction(identity, async (tx) => {
        const [member] = await tx.select().from(tenantMembers).where(and(
          eq(tenantMembers.tenantId, identity.tenantId), eq(tenantMembers.userId, identity.userId),
        ));
        return member && member.disabledAt === null && member.sessionVersion === claims.sessionVersion;
      });
      if (!active) throw new UnauthorizedException();
      request.tenantContext = Object.freeze(identity);
    } catch {
      throw new UnauthorizedException('Invalid session');
    }
    return true;
  }
}

export const AuthenticatedTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().tenantContext,
);
