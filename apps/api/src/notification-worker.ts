import nodemailer from 'nodemailer';
import { NotFoundException } from '@nestjs/common';
import { and, eq, isNull, notifications, outbox, recordEvents, records, sql, users, withTenantTransaction,
  type TenantContext } from '@suzubase/db';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';

export async function deliverNotifications(context: TenantContext, emailEnabled: boolean) {
  return withTenantTransaction(context, async (tx) => {
    const queue = await tx.select({
      appId: outbox.appId, eventId: outbox.eventId, deliveries: outbox.notifications, recordId: recordEvents.recordId,
    }).from(outbox).innerJoin(recordEvents, and(eq(recordEvents.tenantId, outbox.tenantId),
      eq(recordEvents.appId, outbox.appId), eq(recordEvents.eventId, outbox.eventId)))
      .where(and(eq(outbox.tenantId, context.tenantId), isNull(outbox.processedAt)))
      .orderBy(outbox.createdAt, outbox.eventId).limit(250).for('update', { of: outbox, skipLocked: true });
    let inserted = 0;
    for (const { appId, eventId, recordId, deliveries } of queue) {
      const scope = { tenantId: context.tenantId, appId, eventId };
      for (let index = 0; index < deliveries.length; index += 250) {
        const result = await tx.insert(notifications).values(deliveries.slice(index, index + 250).map((delivery) => ({
          ...scope, recordId, ...delivery, emailState: emailEnabled ? 'pending' as const : 'skipped' as const,
        }))).onConflictDoNothing();
        inserted += result.rowCount ?? 0;
      }
      await tx.update(outbox).set({ processedAt: sql`clock_timestamp()` }).where(and(
        eq(outbox.tenantId, scope.tenantId), eq(outbox.appId, appId), eq(outbox.eventId, eventId),
      ));
    }
    return { processed: queue.length, inserted };
  });
}

export function smtpSender() {
  const { SMTP_HOST, SMTP_FROM, SMTP_USER, SMTP_PASSWORD } = process.env;
  if (!SMTP_HOST || !SMTP_FROM) return undefined;
  const port = Number(process.env.SMTP_PORT ?? '587');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP_PORT');
  const secure = port === 465;
  const transport = nodemailer.createTransport({
    host: SMTP_HOST, port, secure, requireTLS: !secure,
    ...(SMTP_USER && { auth: { user: SMTP_USER, pass: SMTP_PASSWORD ?? '' } }),
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 10000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return (email: string, deliveryId: string) => transport.sendMail({
    from: SMTP_FROM, to: email, subject: 'SuzuBase notification', text: 'Open SuzuBase to view your notification.',
    messageId: '<' + deliveryId + '@suzubase.local>',
  });
}

const auth = new AuthorizationService();
const schema = new AppSchemaService(auth);

export async function deliverNotificationEmail(context: TenantContext, send: NonNullable<ReturnType<typeof smtpSender>>) {
  return withTenantTransaction(context, async (tx) => {
    const [row] = await tx.select({
      id: notifications.id, userId: notifications.userId, appId: notifications.appId,
      recordId: notifications.recordId, attempts: notifications.emailAttempts, email: users.email,
    }).from(notifications).innerJoin(users, and(eq(users.tenantId, notifications.tenantId), eq(users.id, notifications.userId)))
      .where(and(eq(notifications.tenantId, context.tenantId), eq(notifications.emailState, 'pending'),
        sql`${notifications.emailNextAt} <= clock_timestamp()`))
      .orderBy(notifications.emailNextAt, notifications.id).limit(1).for('update', { of: notifications, skipLocked: true });
    if (!row) return false;
    const recipient = { tenantId: context.tenantId, userId: row.userId };
    const grant = await schema.access(tx, recipient, row.appId, 'view').catch((error: unknown) => {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    });
    const [visible] = grant ? await tx.select({ id: records.id }).from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, row.appId), eq(records.id, row.recordId), isNull(records.deletedAt),
      auth.recordScope(grant.access, 'view'))) : [];
    const scope = and(eq(notifications.tenantId, context.tenantId), eq(notifications.id, row.id));
    if (!visible) await tx.update(notifications).set({ emailState: 'skipped' }).where(scope);
    else {
      const attempts = row.attempts + 1;
      try {
        await send(row.email, row.id);
        await tx.update(notifications).set({ emailState: 'sent', emailAttempts: attempts }).where(scope);
      } catch {
        await tx.update(notifications).set({
          emailState: attempts >= 5 ? 'failed' : 'pending', emailAttempts: attempts,
          emailNextAt: sql`clock_timestamp() + (${2 ** attempts} * interval '1 minute')`,
        }).where(scope);
      }
    }
    return true;
  });
}
