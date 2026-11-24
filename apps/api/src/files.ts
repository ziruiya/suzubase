import {
  BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Post, Query,
  StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  and, apps, eq, inArray, fileReferences, files, isNull, records, sql, tableFileReferences, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AllowApiToken, AuthenticatedTenant, SessionGuard } from './identity';
import { attachmentKey, localAttachmentStorage } from './storage';
import { SamplePolicy } from './sample';
import { identifier, parseInput } from './validation';

export const attachmentTypes = ['image/png', 'image/jpeg', 'application/pdf'] as const;
export const maxAttachmentBytes = 8 * 1024 * 1024;
export const fileIds = z.array(identifier).refine((ids) => new Set(ids).size === ids.length);
const uploadInput = z.strictObject({
  name: z.string().min(1).max(240).refine((name) => !/[\x00-\x1f\x7f/\\\p{Surrogate}]/u.test(name)),
  type: z.enum(attachmentTypes),
});

export const fileHttp = { uploadInput };

function hasSignature(type: (typeof attachmentTypes)[number], data: Buffer) {
  const signature = {
    'image/png': '89504e470d0a1a0a', 'image/jpeg': 'ffd8ff', 'application/pdf': '255044462d',
  }[type];
  return data.toString('hex', 0, signature.length / 2) === signature;
}

@Injectable()
export class FileService {
  private readonly storage = localAttachmentStorage();

  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService) {}

  private fileScope(tenantId: string, appId: string, id: string) {
    return and(eq(files.tenantId, tenantId), eq(files.appId, appId), eq(files.id, id));
  }

  async upload(context: TenantContext, appId: string, input: z.infer<typeof uploadInput>, body: Buffer) {
    const { tenantId, userId } = context;
    if (!Buffer.isBuffer(body)) throw new BadRequestException('Expected a binary upload');
    const pending = await withTenantTransaction(context, async (tx) => {
      const { app } = await this.schema.writable(tx, context, appId, 'edit').catch((error) => {
        if (!(error instanceof NotFoundException)) throw error;
        return this.schema.writable(tx, context, appId, 'create');
      });
      if (body.length > app.attachmentMaxBytes) {
        throw new BadRequestException({ file: input.name, message: 'File exceeds the application size limit' });
      }
      if (!app.attachmentTypes.includes(input.type) || !hasSignature(input.type, body)) {
        throw new BadRequestException({ file: input.name, message: 'File type is not allowed or failed its signature check' });
      }
      const [file] = await tx.insert(files).values({
        tenantId, appId, uploadedBy: userId, name: input.name, contentType: input.type, bytes: body.length,
      }).returning();
      return file;
    });
    const key = attachmentKey(tenantId, appId, pending.id);
    try {
      return await withTenantTransaction(context, async (tx) => {
        const [temporary] = await tx.select({ id: files.id }).from(files)
          .where(and(this.fileScope(tenantId, appId, pending.id), eq(files.state, 'TEMPORARY'))).for('update');
        if (!temporary) throw new Error('Pending file expired during upload');
        const result = await this.storage.put(key, body);
        const [ready] = await tx.update(files).set({ state: 'READY', sha256: result.sha256 })
          .where(and(this.fileScope(tenantId, appId, pending.id), eq(files.state, 'TEMPORARY')))
          .returning({ id: files.id, state: files.state, name: files.name, bytes: files.bytes, sha256: files.sha256 });
        if (!ready) throw new Error('Pending file changed during upload');
        return ready;
      });
    } catch (error) {
      // If storage failed, its staging file is cleaned internally. An uncertain final
      // database commit is resolved by checking the persisted state before deleting bytes.
      await withTenantTransaction(context, async (tx) => {
        const [failed] = await tx.update(files).set({ state: 'DELETED', deletedAt: sql`clock_timestamp()` })
          .where(and(this.fileScope(tenantId, appId, pending.id), eq(files.state, 'TEMPORARY'))).returning();
        if (failed) await this.storage.removeIncomplete(key);
      });
      throw error;
    }
  }

  /**
   * P4-T2: `table` carries the subtable attachment references of the table
   * fields being replaced in this write (managedFieldIds) together with
   * the full requested reference set for them. The per-record attachment
   * count limit applies to record-level and subtable files COMBINED —
   * one attachment subsystem, one counting rule.
   */
  async reconcile(
    tx: TenantTransaction, context: TenantContext, appId: string, recordId: string,
    attachments: { fieldId: string; ids: string[] }[],
    table?: { managedFieldIds: string[]; refs: { fieldId: string; rowId: string; subFieldId: string; fileId: string }[] },
  ) {
    const { tenantId } = context;
    const scope = and(eq(fileReferences.tenantId, tenantId), eq(fileReferences.appId, appId), eq(fileReferences.recordId, recordId));
    const current = await tx.select().from(fileReferences).where(scope);
    const requested = attachments.flatMap(({ fieldId, ids }) => ids.map((fileId) => ({ fieldId, fileId })));
    const tableScope = and(eq(tableFileReferences.tenantId, tenantId), eq(tableFileReferences.appId, appId),
      eq(tableFileReferences.recordId, recordId));
    const currentTable = table ? await tx.select().from(tableFileReferences).where(tableScope) : [];
    const requestedTable = table?.refs ?? [];
    const same = (a: { fieldId: string; fileId: string }, b: { fieldId: string; fileId: string }) =>
      a.fieldId === b.fieldId && a.fileId === b.fileId;
    const sameCell = (a: { fieldId: string; rowId: string; subFieldId: string; fileId: string },
      b: { fieldId: string; rowId: string; subFieldId: string; fileId: string }) =>
      a.fieldId === b.fieldId && a.rowId === b.rowId && a.subFieldId === b.subFieldId && a.fileId === b.fileId;
    const [app] = await tx.select({ limit: apps.attachmentMaxCount }).from(apps).where(and(
      eq(apps.tenantId, tenantId), eq(apps.id, appId),
    ));
    const combined = [...requested, ...requestedTable];
    if (combined.length > app.limit) {
      const overflow = combined.slice(app.limit);
      const names = await tx.select({ id: files.id, name: files.name }).from(files).where(and(
        eq(files.tenantId, tenantId), eq(files.appId, appId), eq(files.uploadedBy, context.userId),
        inArray(files.id, [...new Set(overflow.map(({ fileId }) => fileId))]),
      ));
      const byId = new Map(names.map(({ id, name }) => [id, name]));
      throw new BadRequestException({
        message: 'Attachment limit exceeded: ' + overflow.map(({ fileId }) => byId.get(fileId) ?? fileId).join(', '),
        limit: app.limit,
        files: overflow.map(({ fieldId, fileId }) => ({ fieldId, fileId, name: byId.get(fileId) ?? null })),
      });
    }
    const attach = async (fileId: string, fieldId: string) => {
      const fileScope = this.fileScope(tenantId, appId, fileId);
      const [file] = await tx.select().from(files).where(fileScope).for('update');
      if (!file || file.uploadedBy !== context.userId || (file.state !== 'READY' && file.state !== 'ATTACHED')) {
        throw new BadRequestException([{ field: fieldId, file: fileId, message: 'Attachment is unavailable' }]);
      }
      await tx.update(files).set({ state: 'ATTACHED', referenceCount: file.referenceCount + 1 }).where(fileScope);
    };
    const release = async (fileId: string) => {
      await tx.update(files).set({
        referenceCount: sql`${files.referenceCount} - 1`,
        state: sql`CASE WHEN ${files.referenceCount} = 1 THEN 'DELETED'::file_state ELSE ${files.state} END`,
        deletedAt: sql`CASE WHEN ${files.referenceCount} = 1 THEN clock_timestamp() ELSE NULL END`,
      }).where(this.fileScope(tenantId, appId, fileId));
    };
    for (const target of requested.filter((item) => !current.some((entry) => same(item, entry)))) {
      await attach(target.fileId, target.fieldId);
      await tx.insert(fileReferences).values({ tenantId, appId, recordId, ...target });
    }
    for (const stale of current.filter((item) => attachments.some(({ fieldId }) => fieldId === item.fieldId) &&
      !requested.some((entry) => same(item, entry)))) {
      await tx.delete(fileReferences).where(and(scope, eq(fileReferences.fieldId, stale.fieldId), eq(fileReferences.fileId, stale.fileId)));
      await release(stale.fileId);
    }
    for (const target of requestedTable.filter((item) => !currentTable.some((entry) => sameCell(item, entry)))) {
      await attach(target.fileId, target.fieldId);
      await tx.insert(tableFileReferences).values({ tenantId, appId, recordId, ...target });
    }
    const managed = new Set(table?.managedFieldIds ?? []);
    for (const stale of currentTable.filter((item) => managed.has(item.fieldId) &&
      !requestedTable.some((entry) => sameCell(item, entry)))) {
      await tx.delete(tableFileReferences).where(and(tableScope,
        eq(tableFileReferences.fieldId, stale.fieldId), eq(tableFileReferences.rowId, stale.rowId),
        eq(tableFileReferences.subFieldId, stale.subFieldId), eq(tableFileReferences.fileId, stale.fileId)));
      await release(stale.fileId);
    }
  }

  async readAuthorized(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      const { access, fields } = await this.schema.access(tx, context, appId, 'view');
      const fieldIds = fields.filter(({ fieldId, type }) => type === 'attachment' &&
        this.authorization.fieldDecision(access, fieldId, 'view').allowed).map(({ fieldId }) => fieldId);
      // P4-T2: a subtable file is authorized through its TABLE field —
      // the same three layers (app scope, record scope, field view).
      const tableFieldIds = fields.filter(({ fieldId, type }) => type === 'table' &&
        this.authorization.fieldDecision(access, fieldId, 'view').allowed).map(({ fieldId }) => fieldId);
      if (!fieldIds.length && !tableFieldIds.length) throw new NotFoundException('无权限');
      let found: { file: typeof files.$inferSelect } | undefined;
      if (fieldIds.length) {
        [found] = await tx.select({ file: files }).from(files).innerJoin(apps, and(
          eq(apps.tenantId, files.tenantId), eq(apps.id, files.appId), this.authorization.appScope(context, appId),
        )).innerJoin(fileReferences, and(
          eq(fileReferences.tenantId, files.tenantId), eq(fileReferences.appId, files.appId), eq(fileReferences.fileId, files.id),
        )).innerJoin(records, and(
          eq(records.tenantId, fileReferences.tenantId), eq(records.appId, fileReferences.appId), eq(records.id, fileReferences.recordId),
        )).where(and(this.fileScope(context.tenantId, appId, id), eq(files.state, 'ATTACHED'), isNull(records.deletedAt),
          inArray(fileReferences.fieldId, fieldIds), this.authorization.recordScope(access, 'view'))).limit(1).for('share', { of: files });
      }
      if (!found?.file.sha256 && tableFieldIds.length) {
        [found] = await tx.select({ file: files }).from(files).innerJoin(apps, and(
          eq(apps.tenantId, files.tenantId), eq(apps.id, files.appId), this.authorization.appScope(context, appId),
        )).innerJoin(tableFileReferences, and(
          eq(tableFileReferences.tenantId, files.tenantId), eq(tableFileReferences.appId, files.appId),
          eq(tableFileReferences.fileId, files.id),
        )).innerJoin(records, and(
          eq(records.tenantId, tableFileReferences.tenantId), eq(records.appId, tableFileReferences.appId),
          eq(records.id, tableFileReferences.recordId),
        )).where(and(this.fileScope(context.tenantId, appId, id), eq(files.state, 'ATTACHED'), isNull(records.deletedAt),
          inArray(tableFileReferences.fieldId, tableFieldIds), this.authorization.recordScope(access, 'view'))).limit(1).for('share', { of: files });
      }
      if (!found?.file.sha256) throw new NotFoundException('无权限');
      const data = await this.storage.read(attachmentKey(context.tenantId, appId, id), found.file.sha256);
      return { file: found.file, data };
    });
  }

  async download(context: TenantContext, appId: string, id: string) {
    const { file, data } = await this.readAuthorized(context, appId, id);
    return new StreamableFile(data, {
      type: 'application/octet-stream',
      disposition: "attachment; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/[!'()*]/g,
        (character) => '%' + character.charCodeAt(0).toString(16)),
    });
  }
}

@ApiTags('files')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/files')
export class FileController {
  constructor(private readonly files: FileService, private readonly sample: SamplePolicy) {}

  @Post()
  @ApiConsumes('application/octet-stream')
  async upload(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Query() query: unknown, @Body() body: Buffer) {
    await this.sample.assertNotGuest(context, '添付ファイルのアップロード');
    return this.files.upload(context, parseInput(identifier, appId), parseInput(uploadInput, query), body);
  }

  @Get(':id')
  @AllowApiToken('view')
  download(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('id') id: string) {
    return this.files.download(context, parseInput(identifier, appId), parseInput(identifier, id));
  }
}
