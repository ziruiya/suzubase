import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, loginCredentials, tenantMembers, type TenantContext, type TenantTransaction } from '@suzubase/db';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const stepMs = 30_000;

export function createSecret() {
  return randomBytes(20).reduce((bits, byte) => bits + byte.toString(2).padStart(8, '0'), '')
    .match(/.{5}/g)!.map((bits) => alphabet[parseInt(bits, 2)]).join('');
}

function matchStep(secret: string, code: string, previous: number, now: number) {
  if (!/^\d{6}$/.test(code)) return undefined;
  const bits = Array.from(secret, (letter) => alphabet.indexOf(letter).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const current = Math.floor(now / stepMs);
  return [current, current - 1, current + 1].find((step) => {
    if (step <= previous) return false;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    const expected = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    return timingSafeEqual(Buffer.from(expected), Buffer.from(code));
  });
}

const recoveryHash = (code: string) => createHash('sha256').update(code.toLowerCase()).digest('hex');
const clearFailures = { totpFailures: 0, totpRetryAfter: null };

export const memberScope = ({ tenantId, userId }: TenantContext) =>
  and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.userId, userId));

export async function lockTotp(tx: TenantTransaction, { tenantId, userId }: TenantContext) {
  const scope = and(eq(loginCredentials.tenantId, tenantId), eq(loginCredentials.userId, userId));
  const [credential] = await tx.select({
    secret: loginCredentials.totpSecret,
    pendingUntil: loginCredentials.totpPendingUntil,
    lastStep: loginCredentials.totpLastStep,
    recoveryHashes: loginCredentials.totpRecoveryHashes,
    failures: loginCredentials.totpFailures,
    retryAfter: loginCredentials.totpRetryAfter,
  }).from(loginCredentials).where(scope).for('update');
  if (!credential) return undefined;

  const now = Date.now();
  const save = (changes: Partial<typeof loginCredentials.$inferInsert>) =>
    tx.update(loginCredentials).set(changes).where(scope);

  async function verify(code: string, enrollment = false) {
    if (!credential.secret || (credential.pendingUntil !== null) !== enrollment ||
        (enrollment && Date.parse(credential.pendingUntil!) <= now)) return false;
    if (credential.retryAfter && Date.parse(credential.retryAfter) > now && credential.failures >= 5) return false;

    const step = matchStep(credential.secret, code, credential.lastStep ?? -1, now);
    const hash = recoveryHash(code);
    if (step !== undefined) {
      await save({ ...clearFailures, totpLastStep: step });
      return true;
    }
    if (!enrollment && credential.recoveryHashes.includes(hash)) {
      await save({ ...clearFailures, totpRecoveryHashes: credential.recoveryHashes.filter((value) => value !== hash) });
      return true;
    }
    const windowActive = credential.retryAfter && Date.parse(credential.retryAfter) > now;
    await save({
      totpFailures: windowActive ? credential.failures + 1 : 1,
      totpRetryAfter: windowActive ? credential.retryAfter : new Date(now + 5 * 60_000).toISOString(),
    });
    return false;
  }

  return {
    enabled: credential.secret !== null && credential.pendingUntil === null,
    verify,
    begin: (secret: string) => save({
      totpSecret: secret, totpPendingUntil: new Date(now + 10 * 60_000).toISOString(),
      totpLastStep: null, totpRecoveryHashes: [],
    }),
    async enable() {
      const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
      await save({ totpPendingUntil: null, totpRecoveryHashes: codes.map(recoveryHash) });
      return codes;
    },
    disable: () => save({
      ...clearFailures, totpSecret: null, totpPendingUntil: null, totpLastStep: null, totpRecoveryHashes: [],
    }),
  };
}
