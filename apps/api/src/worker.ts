import { setTimeout as delay } from 'node:timers/promises';
import { maintenanceTenants } from '@suzubase/db';
import { cleanupFiles } from './file-maintenance';

function configuredInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > 87600) throw new Error('Invalid ' + name);
  return value;
}

async function main() {
  const interval = configuredInteger('MAINTENANCE_INTERVAL_SECONDS', 60);
  const retention = {
    deletedHours: configuredInteger('ATTACHMENT_RETENTION_HOURS', 720),
    temporaryHours: configuredInteger('ATTACHMENT_TEMPORARY_EXPIRY_HOURS', 24),
  };
  const once = process.argv.includes('--once');
  let stopping = false;
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    stopping = true;
    stop.abort();
  });
  do {
    try {
      for (const context of await maintenanceTenants()) {
        if (stopping) break;
        try {
          const result = await cleanupFiles(context, retention);
          if (result.expiredTemporary || result.purgedDeleted || result.failed) {
            console.info('Attachment cleanup', { tenantId: context.tenantId, ...result });
          }
          if (once && result.failed) process.exitCode = 1;
        } catch (error) {
          console.error('Attachment maintenance failed', { tenantId: context.tenantId, error });
          if (once) process.exitCode = 1;
        }
      }
    } catch (error) {
      console.error('Could not enumerate maintenance tenants', error);
      if (once) process.exitCode = 1;
    }
    if (!once && !stopping) await delay(interval * 1000, undefined, { signal: stop.signal }).catch(() => undefined);
  } while (!once && !stopping);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
