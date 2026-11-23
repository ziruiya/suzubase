import { setTimeout as delay } from 'node:timers/promises';
import { maintenanceTenants, withIndexDdl } from '@suzubase/db';
import { runIndexJob } from './runtime-index-worker';
import { deliverNotificationEmail, deliverNotifications, smtpSender } from './notification-worker';
import { cleanupFiles } from './file-maintenance';
import { ExportService } from './export';
import { ImportExecutionService, ImportFinalizer, ImportOrchestrator, ImportService } from './import';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AutomationService } from './automation';
import { NotificationPlanner } from './notification-planner';
import { RecordQueryService } from './record-query';
import { FileService } from './files';
import { RecordService } from './records';
import { WorkflowRuntimeService } from './workflow-runtime';

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
  let send: ReturnType<typeof smtpSender>;
  try { send = smtpSender(); } catch (error) {
    console.error('SMTP configuration rejected', error instanceof Error ? error.message : String(error));
  }
  const once = process.argv.includes('--once');
  let stopping = false;
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    stopping = true;
    stop.abort();
  });
  do {
    try {
      const tenants = await maintenanceTenants();
      for (const context of tenants) {
        if (stopping) break;
        try {
          const notifications = await deliverNotifications(context, Boolean(send));
          if (notifications.inserted) console.info('Notification delivery', { tenantId: context.tenantId, ...notifications });
          if (send) {
            for (let i = 0; i < 20 && !stopping; i++) {
              if (!await deliverNotificationEmail(context, send)) break;
            }
          }
        } catch (error) {
          console.error('Notification worker failed', { tenantId: context.tenantId, error });
          if (once) process.exitCode = 1;
        }
        try {
          const authorization = new AuthorizationService();
          const schema = new AppSchemaService(authorization);
          const planner = new NotificationPlanner(schema, authorization);
          const automation = new AutomationService(schema, authorization,
            new RecordService(schema, authorization, new RecordQueryService(schema, authorization),
              new FileService(schema, authorization), planner),
            new WorkflowRuntimeService(schema, authorization, planner));
          const processed = await automation.processOutbox(context);
          if (processed.events || processed.createdRuns) console.info('Automation outbox', { tenantId: context.tenantId, ...processed });
          const schedules = await automation.processSchedules(context);
          if (schedules.claimedPlans || schedules.resumedSlots || schedules.runsCreated || schedules.slotsSkipped) {
            console.info('Automation schedules', { tenantId: context.tenantId, ...schedules });
          }
          const dateRelative = await automation.processDateRelativeSchedules(context);
          if (dateRelative.backfilledRecords || dateRelative.claimed || dateRelative.missed || dateRelative.invalidated) {
            console.info('Automation date-relative schedules', { tenantId: context.tenantId, ...dateRelative });
          }
          const pruned = await automation.pruneRunHistory(context);
          if (pruned.pruned) console.info('Automation run history pruned', { tenantId: context.tenantId, ...pruned });
        } catch (error) {
          console.error('Automation worker failed', { tenantId: context.tenantId, error });
          if (once) process.exitCode = 1;
        }
        try {
          const exports = new ExportService(new AppSchemaService(new AuthorizationService()));
          const done = await exports.processQueued(context);
          for (const job of done) {
            if (job.status === 'sealed') console.info('Export sealed', { tenantId: context.tenantId, ...job });
            else if (job.status === 'failed') console.error('Export failed', { tenantId: context.tenantId, ...job });
          }
        } catch (error) {
          console.error('Export worker failed', { tenantId: context.tenantId, error });
          if (once) process.exitCode = 1;
        }
        try {
          const authorization = new AuthorizationService();
          const schema = new AppSchemaService(authorization);
          const imports = new ImportService(schema);
          const orchestrator = new ImportOrchestrator(
            new ImportExecutionService(schema, authorization, imports),
            new ImportFinalizer(schema, authorization, imports), imports, schema);
          const done = await orchestrator.processQueued(context);
          for (const job of done) {
            if (job.status === 'ready') console.info('Import staged', { tenantId: context.tenantId, ...job });
            else if (job.status === 'failed') console.error('Import failed', { tenantId: context.tenantId, ...job });
          }
        } catch (error) {
          console.error('Import worker failed', { tenantId: context.tenantId, error });
          if (once) process.exitCode = 1;
        }
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
      const indexConnection = process.env.INDEX_DATABASE_URL;
      if (indexConnection && !stopping) {
        await withIndexDdl(indexConnection, async (ddl) => {
          for (const context of tenants) {
            if (stopping) break;
            const result = await runIndexJob(context, ddl);
            if (result) console.info('Runtime index job', { tenantId: context.tenantId, ...result });
          }
        }).catch((error) => {
          console.error('Runtime index channel failed', error instanceof Error ? error.message : String(error));
          if (once) process.exitCode = 1;
        });
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
