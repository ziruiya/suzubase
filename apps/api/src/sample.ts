import {
  Body, Controller, ForbiddenException, Get, Header, HttpCode, HttpException, HttpStatus,
  Injectable, NotFoundException, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import {
  and, eq, getSampleSite, tenantMembers, withTenantTransaction,
  type SampleSiteConfiguration, type TenantContext,
} from '@suzubase/db';
import { z } from 'zod';
import { parseInput } from './validation';

// Public sample site (migration 0052): one designated tenant + guest member
// is reachable without a password. The guest member never holds login
// credentials; sessions are minted here after a Turnstile check. Guest
// writes are constrained in three layers:
//   1. Field ACL (the sample apps grant field-edit only to the sample admin
//      for free-text / attachment fields) -- enforced by assertEditable and
//      rendered read-only by the web form.
//   2. SamplePolicy checks in the record/file/comment services (this file).
//   3. Turnstile verification on every guest submit (controller layer).

export type SampleSite = SampleSiteConfiguration;

const cache: { at: number; site?: SampleSite } = { at: 0, site: undefined };

export async function sampleSite(): Promise<SampleSite | undefined> {
  const now = Date.now();
  // Positive results cache briefly; negative results even more briefly, so
  // enabling or disabling the sample site takes effect quickly without
  // hammering the DB (the lookup is a single-row function call).
  const ttl = cache.site ? 10_000 : 5_000;
  if (now - cache.at < ttl) return cache.site;
  const site = await getSampleSite().catch(() => undefined);
  cache.at = now;
  cache.site = site;
  return site;
}

export async function isSampleGuest(context: TenantContext): Promise<boolean> {
  const site = await sampleSite();
  return Boolean(site && site.tenantId === context.tenantId && site.guestUserId === context.userId);
}

const FREE_TEXT_FIELD_TYPES: ReadonlySet<string> = new Set(['text', 'multiline', 'richText', 'url', 'phone', 'email']);

export function isFreeTextFieldType(type: string): boolean {
  return FREE_TEXT_FIELD_TYPES.has(type);
}

interface RateWindow { count: number; resetAt: number }
const sessionWindows = new Map<string, RateWindow>();
const SESSION_LIMIT = 20;
const SESSION_WINDOW_MS = 10 * 60_000;

function sessionRateLimited(ip: string): boolean {
  const now = Date.now();
  const window = sessionWindows.get(ip);
  if (!window || now >= window.resetAt) {
    sessionWindows.set(ip, { count: 1, resetAt: now + SESSION_WINDOW_MS });
    return false;
  }
  window.count += 1;
  return window.count > SESSION_LIMIT;
}

export function clientIp(request: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const cf = request.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  const forwarded = request.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
  if (first?.trim()) return first.trim();
  return request.ip ?? 'unknown';
}

@Injectable()
export class SamplePolicy {
  async site(): Promise<SampleSite | undefined> {
    return sampleSite();
  }

  async isGuest(context: TenantContext): Promise<boolean> {
    return isSampleGuest(context);
  }

  async verifyTurnstile(token: string | undefined, remoteIp?: string): Promise<boolean> {
    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret || !token) return false;
    const url = process.env.TURNSTILE_SITEVERIFY_URL
      ?? 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}),
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { success?: boolean };
      return result.success === true;
    } catch {
      return false;
    }
  }

  // Guest record submits (create / update / batch) must carry a fresh
  // Turnstile token in the x-turnstile-token header. Non-guests pass through.
  async requireGuestTurnstile(context: TenantContext, token: string | undefined, remoteIp?: string): Promise<void> {
    if (!await this.isGuest(context)) return;
    if (!await this.verifyTurnstile(token, remoteIp)) {
      throw new ForbiddenException('人机验证未通过：样品站提交前请完成人机验证');
    }
  }

  // Actions that are closed to the sample guest entirely (deletes, uploads,
  // comments -- comments are free text).
  async assertNotGuest(context: TenantContext, action: string): Promise<void> {
    if (await this.isGuest(context)) throw new ForbiddenException(`样品站访客不能${action}`);
  }
}

const sampleSessionInput = z.strictObject({
  turnstileToken: z.string().min(1).max(4096),
});
export const sampleHttp = { sampleSessionInput };

@ApiTags('session')
@Controller('auth')
export class SampleController {
  constructor(
    private readonly sessions: JwtService,
    private readonly policy: SamplePolicy,
  ) {}

  @Get('sample')
  @Header('Cache-Control', 'no-store')
  async sample() {
    const site = await this.policy.site();
    if (!site) return { enabled: false as const };
    return { enabled: true as const, siteKey: site.siteKey };
  }

  @Post('sample-session')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  async sampleSession(@Body() body: unknown, @Req() request: { ip?: string; headers: Record<string, string | string[] | undefined> }) {
    const site = await this.policy.site();
    if (!site) throw new NotFoundException('Sample site is not enabled');
    const ip = clientIp(request);
    if (sessionRateLimited(ip)) {
      throw new HttpException('Too many sample session requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const { turnstileToken } = parseInput(sampleSessionInput, body);
    if (!await this.policy.verifyTurnstile(turnstileToken, ip)) {
      throw new ForbiddenException('人机验证未通过');
    }
    const identity = { tenantId: site.tenantId, userId: site.guestUserId };
    const member = await withTenantTransaction(identity, async (tx) => {
      const [row] = await tx.select({
        sessionVersion: tenantMembers.sessionVersion, disabledAt: tenantMembers.disabledAt,
      }).from(tenantMembers).where(and(
        eq(tenantMembers.tenantId, identity.tenantId), eq(tenantMembers.userId, identity.userId),
      ));
      return row;
    });
    if (!member || member.disabledAt) throw new UnauthorizedException('Sample guest is unavailable');
    return {
      accessToken: await this.sessions.signAsync(
        { tenantId: identity.tenantId, sessionVersion: member.sessionVersion },
        { subject: identity.userId },
      ),
      expiresIn: 3600,
    };
  }
}
