import {
  Body, ConflictException, ForbiddenException, Header, CanActivate, Controller, createParamDecorator, ExecutionContext, HttpCode,
  Get, Injectable, Post, SetMetadata, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { and, eq, tenantMembers, tenants, users, sql, TenantContext, verifyApiToken, verifyLogin, withTenantTransaction } from '@suzubase/db';
import { z } from 'zod';
import { ApiTokenAction } from '@suzubase/shared-types';
import { identifier, parseInput } from './validation';

import { createSecret, lockTotp, memberScope } from './totp';
import { isSampleGuest } from './sample';

const passwordInput = z.string().min(1).max(1024).refine((value) => !/[\x00\p{Surrogate}]/u.test(value));
const factorInput = z.string().trim().regex(/^(?:[0-9]{6}|[a-f0-9]{32})$/i);
const loginInput = z.strictObject({
  email: z.email().max(254).optional(),
  loginName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i).optional(),
  password: passwordInput,
  factor: factorInput.optional(),
}).refine(({ email, loginName }) => Boolean(email) !== Boolean(loginName));

const enrollTotpInput = z.strictObject({ password: passwordInput });
const changeTotpInput = enrollTotpInput.extend({ factor: factorInput });
export const authHttp = { loginInput, enrollTotpInput, changeTotpInput };

const sessionClaims = z.object({ tenantId: identifier, sub: identifier, sessionVersion: z.number().int() });

type SessionContext = TenantContext & { readonly sessionVersion?: number };

interface AuthenticatedRequest {
  headers: { authorization?: string };
  params?: { appId?: string; id?: string };
  tenantContext: SessionContext;
}

const tokenAction = Symbol('API token action');
export const AllowApiToken = (action: ApiTokenAction) => SetMetadata(tokenAction, action);

@ApiTags('session')
@Controller('auth')
export class SessionController {
  constructor(private readonly sessions: JwtService) {}

  @Post('login')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async login(@Body() body: unknown) {
    const { email, loginName, password, factor } = parseInput(loginInput, body);
    const identity = await verifyLogin((email ?? loginName!).toLowerCase(), password);
    if (!identity) throw new UnauthorizedException('Invalid credentials');
    const result = await withTenantTransaction(identity, async (tx) => {
      const [member] = await tx.select().from(tenantMembers).where(memberScope(identity)).for('update');
      if (!member || member.disabledAt || member.sessionVersion !== identity.sessionVersion) return 'invalid';
      if (!member.isAdmin) return 'ok';
      const totp = await lockTotp(tx, identity);
      if (!totp?.enabled) return 'ok';
      if (!factor) return 'challenge';
      return await totp.verify(factor) ? 'ok' : 'invalid';
    });
    if (result === 'invalid') throw new UnauthorizedException('Invalid credentials or verification code');
    if (result === 'challenge') return { secondFactorRequired: true };
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
    if (/^sb1_[A-Za-z0-9_-]{43}$/.test(match[1])) {
      const action: ApiTokenAction | undefined = Reflect.getMetadata(tokenAction, executionContext.getHandler());
      const appId = request.params?.appId ?? request.params?.id;
      if (!action || !appId) throw new UnauthorizedException('无权限');
      const token = await verifyApiToken(match[1]);
      if (!token || token.appId !== appId.toLowerCase() || !token.actions.includes(action)) {
        throw new UnauthorizedException('无权限');
      }
      request.tenantContext = Object.freeze({ tenantId: token.tenantId, userId: token.userId });
      return true;
    }
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
      request.tenantContext = Object.freeze(Object.defineProperty(identity, 'sessionVersion', { value: claims.sessionVersion }));
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

@ApiTags('session')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('auth')
export class SessionProfileController {
  @Get('totp')
  @Header('Cache-Control', 'no-store')
  async totpStatus(@AuthenticatedTenant() context: TenantContext) {
    return withTenantTransaction(context, async (tx) => {
      const [member] = await tx.select().from(tenantMembers).where(memberScope(context));
      if (!member?.isAdmin || member.disabledAt) throw new ForbiddenException('无权限');
      const totp = await lockTotp(tx, context);
      return { enabled: totp?.enabled ?? false };
    });
  }

  @Post('totp/enrollment')
  @Header('Cache-Control', 'no-store')
  enroll(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    const { password } = parseInput(enrollTotpInput, body);
    return this.changeTotp(context, 'begin', password);
  }

  @Post('totp/enable')
  @Header('Cache-Control', 'no-store')
  enable(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    const { password, factor } = parseInput(changeTotpInput, body);
    return this.changeTotp(context, 'enable', password, factor);
  }

  @Post('totp/disable')
  @Header('Cache-Control', 'no-store')
  disable(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    const { password, factor } = parseInput(changeTotpInput, body);
    return this.changeTotp(context, 'disable', password, factor);
  }

  private async changeTotp(context: SessionContext, action: 'begin' | 'enable' | 'disable', password: string, factor = '') {
    const { email } = await this.profile(context);
    const identity = await verifyLogin(email, password);
    if (identity?.userId !== context.userId || identity.tenantId !== context.tenantId) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const result = await withTenantTransaction(context, async (tx) => {
      const scope = memberScope(context);
      const [member] = await tx.select().from(tenantMembers).where(scope).for('update');
      if (!member?.isAdmin || member.disabledAt) throw new ForbiddenException('无权限');
      if (member.sessionVersion !== identity.sessionVersion || member.sessionVersion !== context.sessionVersion) return undefined;
      const totp = await lockTotp(tx, context);
      if (!totp) return undefined;
      if (action === 'begin') {
        if (totp.enabled) throw new ConflictException('Two-factor authentication is already enabled');
        const secret = createSecret();
        await totp.begin(secret);
        return { secret, expiresIn: 600 };
      }
      if (!await totp.verify(factor, action === 'enable')) return undefined;
      const recoveryCodes = action === 'enable' ? await totp.enable() : undefined;
      if (action === 'disable') await totp.disable();
      await tx.update(tenantMembers).set({ sessionVersion: sql`${tenantMembers.sessionVersion} + 1` }).where(scope);
      return { enabled: action === 'enable', recoveryCodes };
    });
    if (!result) throw new UnauthorizedException('Invalid or expired verification code');
    return result;
  }

  @Get('profile')
  async profile(@AuthenticatedTenant() context: TenantContext) {
    return withTenantTransaction(context, async (tx) => {
      const [profile] = await tx.select({
        displayName: users.displayName, email: users.email, isAdmin: tenantMembers.isAdmin,
        canManageRecycleBin: tenantMembers.canManageRecycleBin, canReadArchivedFields: tenantMembers.canReadArchivedFields, canCreateApps: tenantMembers.canCreateApps,
        allowAppCreation: tenants.allowAppCreation, timeZone: tenants.timeZone, localDrafts: tenants.localDrafts,
      }).from(tenantMembers).innerJoin(users, and(
        eq(users.tenantId, tenantMembers.tenantId), eq(users.id, tenantMembers.userId),
      )).innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId)).where(and(
        eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, context.userId),
      ));
      if (!profile) throw new UnauthorizedException('无权限');
      return {
        ...profile, ...context, localDraftLogout: 'clear', draftExpiryHours: 168,
        sampleGuest: await isSampleGuest(context),
      };
    });
  }
}
