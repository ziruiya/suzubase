import { and, eq, files, fileReferences, isNull, sql, tableFileReferences, type TenantContext, withTenantTransaction } from '@suzubase/db';
import { attachmentKey, localAttachmentStorage, type StorageAdapter } from './storage';

export interface FileRetention {
  deletedHours: number;
  temporaryHours: number;
}

export async function cleanupFiles(context: TenantContext, retention: FileRetention,
  storage: StorageAdapter = localAttachmentStorage()) {
  return withTenantTransaction(context, async (tx) => {
    const candidates = await tx.select().from(files).where(and(
      eq(files.tenantId, context.tenantId), isNull(files.purgedAt), eq(files.referenceCount, 0),
      sql`NOT EXISTS (SELECT 1 FROM ${fileReferences}
        WHERE ${fileReferences.tenantId} = ${files.tenantId} AND ${fileReferences.appId} = ${files.appId}
        AND ${fileReferences.fileId} = ${files.id})`,
      sql`NOT EXISTS (SELECT 1 FROM ${tableFileReferences}
        WHERE ${tableFileReferences.tenantId} = ${files.tenantId} AND ${tableFileReferences.appId} = ${files.appId}
        AND ${tableFileReferences.fileId} = ${files.id})`,
      sql`((${files.state} = 'DELETED' AND ${files.deletedAt} <= now() - make_interval(hours => ${retention.deletedHours}))
        OR (${files.state} = 'TEMPORARY' AND ${files.createdAt} <= now() - make_interval(hours => ${retention.temporaryHours})))`,
    )).orderBy(files.createdAt, files.id).limit(100).for('update', { skipLocked: true });
    const result = { expiredTemporary: 0, purgedDeleted: 0, failed: 0 };
    for (const file of candidates) {
      const key = attachmentKey(file.tenantId, file.appId, file.id);
      try {
        await tx.transaction(async (item) => {
          await storage.removeIncomplete(key);
          await item.update(files).set({
            state: 'DELETED', purgedAt: sql`clock_timestamp()`, deletedAt: file.deletedAt ?? sql`clock_timestamp()`,
          }).where(and(eq(files.tenantId, file.tenantId), eq(files.appId, file.appId), eq(files.id, file.id)));
        });
        if (file.state === 'TEMPORARY') result.expiredTemporary++;
        else result.purgedDeleted++;
      } catch (error) {
        result.failed++;
        console.error('Attachment cleanup failed', { tenantId: file.tenantId, fileId: file.id, error });
      }
    }
    return result;
  });
}
