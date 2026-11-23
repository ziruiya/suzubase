// P3-D wave 1 (Webhook): delivery primitives for the automation engine.
//
// This module holds everything that must be testable without a network:
// URL structural safety, public-IP classification, DNS resolution checks,
// HMAC signing, secret encryption at rest, failure classification and the
// retry/backoff policy. The HTTP transport itself sits behind the
// WebhookTransport interface: the production implementation pins the
// connection to a DNS-validated IP (no re-resolution at connect time, no
// redirect following); tests inject a transport that dials a local fake
// endpoint while the SSRF checks still run against the injected resolver.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export const WEBHOOK_MAX_ATTEMPTS = 6; // first attempt + at most 5 retries
export const WEBHOOK_BACKOFF_MINUTES = [1, 2, 4, 8, 16] as const;
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_REQUEST_BYTES = 64 * 1024;
export const WEBHOOK_MAX_RESPONSE_SUMMARY_CHARS = 512;
export const WEBHOOK_RETRY_AFTER_CAP_MS = 60 * 60_000;
export const WEBHOOK_CLAIM_LEASE_MS = 5 * 60_000;
export const WEBHOOK_POLICIES = ['AUTO_RETRY_AT_LEAST_ONCE', 'MANUAL_ON_UNCERTAIN'] as const;
export type WebhookPolicy = (typeof WEBHOOK_POLICIES)[number];
export const MANUAL_POLICY_RISK_TEXT = '外部系统可能已经处理本次请求，重新发送可能造成重复业务操作。';
export const AUTO_POLICY_RISK_TEXT = '可能重复投递、接收方应按投递 ID 去重';

// ---------------------------------------------------------------------------
// IP classification: only globally routable addresses may be dialled.
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function inV4Range(ipInt: number, base: string, prefix: number) {
  const baseInt = ipv4ToInt(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT shared address space
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1 documentation
  ['192.88.99.0', 24],   // 6to4 relay (deprecated)
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2 documentation
  ['203.0.113.0', 24],   // TEST-NET-3 documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved / broadcast
];

export function isPublicIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return false;
    return !BLOCKED_V4.some(([base, prefix]) => inV4Range(value, base, prefix));
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    // IPv4-mapped / translated forms are judged by their embedded IPv4.
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (normalized === '::' || normalized === '::1') return false; // unspecified / loopback
    if (/^fe[89ab]/.test(normalized)) return false;                 // fe80::/10 link-local
    if (/^f[cd]/.test(normalized)) return false;                    // fc00::/7 unique local
    if (/^ff/.test(normalized)) return false;                       // ff00::/8 multicast
    if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return false; // documentation
    if (normalized.startsWith('64:ff9b:')) return false;            // NAT64 well-known prefix
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL structural safety (no DNS): HTTPS only, no credentials, no fragments.
// IP literals are classified immediately.
// ---------------------------------------------------------------------------

export type UrlSafety = { ok: true; url: URL } | { ok: false; code: string; message: string };

export function checkWebhookUrl(raw: string): UrlSafety {
  let url: URL;
  try { url = new URL(raw); } catch {
    return { ok: false, code: 'WEBHOOK_URL_INVALID', message: 'Webhook URL cannot be parsed' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'WEBHOOK_URL_NOT_HTTPS', message: 'Webhook URL must use HTTPS' };
  }
  if (url.username || url.password) {
    return { ok: false, code: 'WEBHOOK_URL_CREDENTIALS', message: 'Webhook URL must not embed credentials' };
  }
  if (!url.hostname) {
    return { ok: false, code: 'WEBHOOK_URL_INVALID', message: 'Webhook URL requires a host' };
  }
  if (url.hash) {
    return { ok: false, code: 'WEBHOOK_URL_INVALID', message: 'Webhook URL must not carry a fragment' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicIp(host)) {
    return { ok: false, code: 'WEBHOOK_URL_PRIVATE_IP', message: 'Webhook URL host is a non-public IP address' };
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    return { ok: false, code: 'WEBHOOK_URL_PRIVATE_HOST', message: 'Webhook URL host is a local/internal name' };
  }
  return { ok: true, url };
}

export function webhookUrlHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

// ---------------------------------------------------------------------------
// DNS resolution + SSRF gate. EVERY resolved address must be public; a
// single private answer poisons the whole name (rebinding defence).
// ---------------------------------------------------------------------------

export type WebhookResolver = (hostname: string) => Promise<string[]>;

export const defaultWebhookResolver: WebhookResolver = async (hostname) => {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return [host];
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export async function resolvePublicIps(rawUrl: string, resolver: WebhookResolver):
  Promise<{ ips: string[] } | { error: { code: string; message: string } }> {
  const safety = checkWebhookUrl(rawUrl);
  if (!safety.ok) return { error: { code: safety.code, message: safety.message } };
  const host = safety.url.hostname.replace(/^\[|\]$/g, '');
  let ips: string[];
  try { ips = await resolver(host); } catch (error) {
    return { error: { code: 'WEBHOOK_DNS_FAILED', message: 'Webhook host could not be resolved: ' + (error instanceof Error ? error.message : String(error)) } };
  }
  if (!ips.length) return { error: { code: 'WEBHOOK_DNS_FAILED', message: 'Webhook host resolved to no addresses' } };
  const blocked = ips.filter((ip) => !isPublicIp(ip));
  if (blocked.length) {
    return { error: { code: 'WEBHOOK_SSRF_BLOCKED', message: 'Webhook host resolves to a non-public address: ' + blocked.join(', ') } };
  }
  return { ips };
}

// ---------------------------------------------------------------------------
// Secret protection at rest: AES-256-GCM. The key derives from
// SUZUBASE_WEBHOOK_SECRET_KEY, falling back to the already-provisioned
// SUZUBASE_SYSTEM_NOTIFICATION_SECRET so the test/CI stack needs no new
// secret. Secrets are never written to logs or API responses.
// ---------------------------------------------------------------------------

function encryptionKey(): Buffer {
  const material = process.env.SUZUBASE_WEBHOOK_SECRET_KEY
    ?? process.env.SUZUBASE_SYSTEM_NOTIFICATION_SECRET
    ?? 'suzubase-local-development-webhook-secret';
  return createHash('sha256').update(material).digest();
}

export function encryptWebhookSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['gcm1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptWebhookSecret(stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split('.');
  if (version !== 'gcm1' || !iv || !tag || !ciphertext) throw new Error('Stored webhook secret has an unknown format');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Signing: HMAC-SHA256 over timestamp, event id and the exact request body.
// ---------------------------------------------------------------------------

export function webhookSignature(secret: string, timestamp: string, eventId: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${eventId}.${body}`).digest('hex');
}

export function verifyWebhookSignature(secret: string, timestamp: string, eventId: string, body: string, signature: string): boolean {
  const expected = webhookSignature(secret, timestamp, eventId, body);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Transport. Implementations MUST NOT follow redirects and MUST connect to
// the pinned IP supplied by the caller (the one that passed the SSRF gate),
// keeping the URL host for TLS SNI / certificate verification and the Host
// header. This is what defeats DNS rebinding between check and connect.
// ---------------------------------------------------------------------------

export type WebhookTransportResult =
  | { type: 'response'; status: number; headers: Record<string, string | string[] | undefined>; bodyText: string }
  | { type: 'timeout' }
  | { type: 'error'; code: string; uncertain: boolean; message: string };

export type WebhookTransport = (request: {
  url: URL; pinnedIp: string; headers: Record<string, string>; body: string; timeoutMs: number;
}) => Promise<WebhookTransportResult>;

export const defaultWebhookTransport: WebhookTransport = ({ url, pinnedIp, headers, body, timeoutMs }) => new Promise((resolve) => {
  const request = httpsRequest({
    hostname: pinnedIp,
    port: url.port ? Number(url.port) : 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { ...headers, Host: url.host },
    servername: url.hostname.replace(/^\[|\]$/g, ''),
    timeout: timeoutMs,
    // Pin the socket to the exact address that passed the SSRF gate: the
    // lookup callback never consults DNS again.
    lookup: ((_hostname: string, _options: unknown, callback: (error: null, address: string, family: number) => void) => {
      callback(null, pinnedIp, isIP(pinnedIp) === 6 ? 6 : 4);
    }) as never,
  }, (response) => {
    const chunks: Buffer[] = [];
    let received = 0;
    response.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received <= WEBHOOK_MAX_RESPONSE_SUMMARY_CHARS * 4) chunks.push(chunk);
    });
    response.on('end', () => resolve({
      type: 'response', status: response.statusCode ?? 0,
      headers: response.headers, bodyText: Buffer.concat(chunks).toString('utf8'),
    }));
    response.on('error', (error: NodeJS.ErrnoException) => resolve({
      type: 'error', code: error.code ?? 'WEBHOOK_RESPONSE_ERROR', uncertain: true,
      message: 'Response stream failed: ' + error.message,
    }));
  });
  request.on('timeout', () => {
    request.destroy();
    resolve({ type: 'timeout' });
  });
  request.on('error', (error: NodeJS.ErrnoException) => {
    const code = error.code ?? 'WEBHOOK_CONNECTION_ERROR';
    // A reset / hang-up mid-flight means the request may already have been
    // processed: the outcome is uncertain, never "did not happen".
    const uncertain = ['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(code) ||
      /socket hang up/i.test(error.message);
    resolve({ type: 'error', code, uncertain, message: error.message });
  });
  request.write(body);
  request.end();
});

// ---------------------------------------------------------------------------
// Failure classification (brief §4.4 / E-4) and retry scheduling.
// ---------------------------------------------------------------------------

export type AttemptClassification = {
  outcome: 'SUCCEEDED' | 'RETRYABLE_FAILURE' | 'UNCERTAIN' | 'PERMANENT_FAILURE';
  errorType: string;
  retryAfterMs: number | null;
};

export function parseRetryAfter(headers: Record<string, string | string[] | undefined>, now: Date): number | null {
  const raw = headers['retry-after'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, WEBHOOK_RETRY_AFTER_CAP_MS);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) {
    const delta = at - now.getTime();
    if (delta >= 0) return Math.min(delta, WEBHOOK_RETRY_AFTER_CAP_MS);
  }
  return null;
}

export function classifyTransportResult(result: WebhookTransportResult, now: Date): AttemptClassification {
  if (result.type === 'timeout') {
    return { outcome: 'UNCERTAIN', errorType: 'DELIVERY_UNCERTAIN_TIMEOUT', retryAfterMs: null };
  }
  if (result.type === 'error') {
    return result.uncertain
      ? { outcome: 'UNCERTAIN', errorType: 'DELIVERY_UNCERTAIN_' + result.code, retryAfterMs: null }
      : { outcome: 'RETRYABLE_FAILURE', errorType: 'CONNECTION_' + result.code, retryAfterMs: null };
  }
  const { status } = result;
  if (status >= 200 && status < 300) return { outcome: 'SUCCEEDED', errorType: 'NONE', retryAfterMs: null };
  if (status >= 300 && status < 400) {
    // Redirects are never followed; a 3xx is a (retryable) failure, and
    // the redirect target is never dialled (SSRF via redirect is closed).
    return { outcome: 'RETRYABLE_FAILURE', errorType: 'HTTP_REDIRECT_NOT_FOLLOWED', retryAfterMs: null };
  }
  if (status === 429) {
    return { outcome: 'RETRYABLE_FAILURE', errorType: 'HTTP_429', retryAfterMs: parseRetryAfter(result.headers, now) };
  }
  if (status >= 500) {
    return { outcome: 'RETRYABLE_FAILURE', errorType: 'HTTP_' + status, retryAfterMs: parseRetryAfter(result.headers, now) };
  }
  if (status >= 400) {
    // Other 4xx: the endpoint deterministically rejected this request;
    // retrying the identical payload cannot succeed.
    return { outcome: 'PERMANENT_FAILURE', errorType: 'HTTP_' + status, retryAfterMs: null };
  }
  return { outcome: 'PERMANENT_FAILURE', errorType: 'HTTP_' + status, retryAfterMs: null };
}

// Delay before retry number `retryIndex` (1-based: the first retry waits
// WEBHOOK_BACKOFF_MINUTES[0]). A lawful Retry-After inside the cap wins
// over the schedule. Jitter is added by the caller-provided random source
// (0..30s); tests inject random = () => 0 for an exact sequence.
export function webhookRetryDelayMs(retryIndex: number, retryAfterMs: number | null, random: () => number): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const base = WEBHOOK_BACKOFF_MINUTES[Math.min(retryIndex - 1, WEBHOOK_BACKOFF_MINUTES.length - 1)] * 60_000;
  return base + Math.floor(random() * 30_000);
}

export function summarizeResponse(bodyText: string): { summary: string; bytes: number; sha256: string } {
  return {
    summary: bodyText.slice(0, WEBHOOK_MAX_RESPONSE_SUMMARY_CHARS),
    bytes: Buffer.byteLength(bodyText, 'utf8'),
    sha256: createHash('sha256').update(bodyText).digest('hex'),
  };
}

export function hashPayload(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
