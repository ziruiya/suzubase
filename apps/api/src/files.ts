import {
  BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Post, Query,
  StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  and, apps, eq, inArray, fileReferences, files, isNull, records, sql, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AllowApiToken, AuthenticatedTenant, SessionGuard } from './identity';
import { LocalStorageAdapter, StorageAdapter } from './storage';
import { identifier, parseInput } from './validation';

export const attachmentTypes = ['image/png', 'image/jpeg', 'application/pdf'] as const;
export const maxAttachmentBytes = 8 * 1024 * 1024;
export const fileIds = z.array(identifier).max(25).refine((ids) => new Set(ids).size === ids.length);
const uploadInput = z.strictObject({
  name: z.string().min(1).max(240).refine((name) => !/[\x00-\x1f\x7f/\\\p{Surrogate}]/u.test(name)),
  type: z.enum(attachmentTypes),
});

function hasSignature(type: (typeof attachmentTypes)[number], data: Buffer) {
  const signature = {
    'image/png': '89504e470d0a1a0a', 'image/jpeg': 'ffd8ff', 'application/pdf': '255044462d',
  }[type];
  return data.toString('hex', 0, signature.length / 2) === signature;
}

@Injectable()
export class FileService {
  private readonly storage: StorageAdapter = new LocalStorageAdapter(process.env.ATTACHMENT_DIRECTORY ?? './attachments');

  constructor(private readonly schema: AppSchemaService, private readonly authorization: AuthorizationService) {}

  private fileScope(tenantId: string, appId: string, id: string) {
    return and(eq(files.tenantId, tenantId), eq(files.appId, appId), eq(files.id, id));
  }

  private storageKey(tenantId: string, appId: string, id: string) {
    return [tenantId, appId, id, 1].join('/').toLowerCase();
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
    const key = this.storageKey(tenantId, appId, pending.id);
    try {
      const result = await this.storage.put(key, body);
      return await withTenantTransaction(context, async (tx) => {
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
        if (failed) await this.storage.remove(key);
      });
      throw error;
    }
  }

  async reconcile(
    tx: TenantTransaction, context: TenantContext, appId: string, recordId: string,
    attachments: { fieldId: string; ids: string[] }[],
  ) {
    const { tenantId } = context;
    const scope = and(eq(fileReferences.tenantId, tenantId), eq(fileReferences.appId, appId), eq(fileReferences.recordId, recordId));
    const current = await tx.select().from(fileReferences).where(scope);
    const requested = attachments.flatMap(({ fieldId, ids }) => ids.map((fileId) => ({ fieldId, fileId })));
    const same = (a: { fieldId: string; fileId: string }, b: { fieldId: string; fileId: string }) =>
      a.fieldId === b.fieldId && a.fileId === b.fileId;
    const [app] = await tx.select({ limit: apps.attachmentMaxCount }).from(apps).where(and(
      eq(apps.tenantId, tenantId), eq(apps.id, appId),
    ));
    if (requested.length > app.limit) throw new BadRequestException('Too many attachments for this application');
    for (const target of requested.filter((item) => !current.some((entry) => same(item, entry)))) {
      const scope = this.fileScope(tenantId, appId, target.fileId);
      const [file] = await tx.select().from(files).where(scope).for('update');
      if (!file || file.uploadedBy !== context.userId || (file.state !== 'READY' && file.state !== 'ATTACHED')) {
        throw new BadRequestException([{ field: target.fieldId, file: target.fileId, message: 'Attachment is unavailable' }]);
      }
      await tx.insert(fileReferences).values({ tenantId, appId, recordId, ...target });
      await tx.update(files).set({ state: 'ATTACHED', referenceCount: file.referenceCount + 1 }).where(scope);
    }
    for (const stale of current.filter((item) => attachments.some(({ fieldId }) => fieldId === item.fieldId) &&
      !requested.some((entry) => same(item, entry)))) {
      await tx.delete(fileReferences).where(and(scope, eq(fileReferences.fieldId, stale.fieldId), eq(fileReferences.fileId, stale.fileId)));
      await tx.update(files).set({
        referenceCount: sql`${files.referenceCount} - 1`,
        state: sql`CASE WHEN ${files.referenceCount} = 1 THEN 'DELETED'::file_state ELSE ${files.state} END`,
        deletedAt: sql`CASE WHEN ${files.referenceCount} = 1 THEN clock_timestamp() ELSE NULL END`,
      }).where(this.fileScope(tenantId, appId, stale.fileId));
    }
  }

  async readAuthorized(context: TenantContext, appId: string, id: string) {
    const file = await withTenantTransaction(context, async (tx) => {
      const { access, fields } = await this.schema.access(tx, context, appId, 'view');
      const fieldIds = fields.filter(({ fieldId, type }) => type === 'attachment' &&
        this.authorization.fieldDecision(access, fieldId, 'view').allowed).map(({ fieldId }) => fieldId);
      if (!fieldIds.length) throw new NotFoundException('无权限');
      const [found] = await tx.select({ file: files }).from(files).innerJoin(apps, and(
        eq(apps.tenantId, files.tenantId), eq(apps.id, files.appId), this.authorization.appScope(context, appId),
      )).innerJoin(fileReferences, and(
        eq(fileReferences.tenantId, files.tenantId), eq(fileReferences.appId, files.appId), eq(fileReferences.fileId, files.id),
      )).innerJoin(records, and(
        eq(records.tenantId, fileReferences.tenantId), eq(records.appId, fileReferences.appId), eq(records.id, fileReferences.recordId),
      )).where(and(this.fileScope(context.tenantId, appId, id), eq(files.state, 'ATTACHED'), isNull(records.deletedAt),
        inArray(fileReferences.fieldId, fieldIds), this.authorization.recordScope(access, 'view'))).limit(1);
      if (!found?.file.sha256) throw new NotFoundException('无权限');
      return found.file;
    });
    const data = await this.storage.read(this.storageKey(context.tenantId, appId, id), file.sha256!);
    return { file, data };
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
  constructor(private readonly files: FileService) {}

  @Post()
  @ApiConsumes('application/octet-stream')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  upload(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Query() query: unknown, @Body() body: Buffer) {
    return this.files.upload(context, parseInput(identifier, appId), parseInput(uploadInput, query), body);
  }

  @Get(':id')
  @AllowApiToken('view')
  download(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('id') id: string) {
    return this.files.download(context, parseInput(identifier, appId), parseInput(identifier, id));
  }
}
