import {
  Body, CanActivate, Controller, createParamDecorator, ExecutionContext, HttpCode,
  Injectable, Post, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { TenantContext, verifyLogin } from '@suzubase/db';
import { z } from 'zod';
import { identifier, parseInput } from './validation';

const loginInput = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});

const sessionClaims = z.object({ tenantId: identifier, sub: identifier });

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
    const { email, password } = parseInput(loginInput, body);
    const identity = await verifyLogin(email.toLowerCase(), password);
    if (!identity) throw new UnauthorizedException('Invalid credentials');
    return {
      accessToken: await this.sessions.signAsync({ tenantId: identity.tenantId }, { subject: identity.userId }),
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
      request.tenantContext = Object.freeze({ tenantId: claims.tenantId, userId: claims.sub });
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
