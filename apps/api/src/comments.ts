import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, NotFoundException, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, commentMentions, eq, inArray, isNull, recordComments, records, sql, tenantMembers, users, withTenantTransaction,
  type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthorizationService } from './authorization';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { NotificationPlanner } from './notification-planner';
import { serializeRecord, writeRecordEvent } from './record-events';
import { identifier, parseInput } from './validation';

const text = z.string().min(1).max(4000).refine((value) => !/[\x00\p{Surrogate}]/u.test(value));
const textPart = z.strictObject({ kind: z.literal('text'), text });
const mentionPart = z.strictObject({ kind: z.literal('mention'), userId: identifier });
const createInput = z.strictObject({
  parts: z.array(z.discriminatedUnion('kind', [textPart, mentionPart])).min(1).max(60)
    .refine((parts) => parts.some((part) => part.kind === 'mention' || part.text.trim())),
});
const listQuery = z.strictObject({ after: identifier.optional() });
const item = z.object({
  id: identifier, authorId: identifier, author: z.string(), createdAt: z.string(), deleted: z.boolean(), canDelete: z.boolean(),
  parts: z.array(z.discriminatedUnion('kind', [textPart, mentionPart.extend({ name: z.string() })])),
});
export const commentHttp = { createInput, listQuery, item, page: z.object({ items: z.array(item), next: identifier.nullable() }) };

type Scope = { tenantId: string; appId: string; recordId: string };
type Part = z.infer<typeof item>['parts'][number];

function commentScope({ tenantId, appId, recordId }: Scope) {
  return and(eq(recordComments.tenantId, tenantId), eq(recordComments.appId, appId), eq(recordComments.recordId, recordId));
}

const name = sql<string>`COALESCE(${users.displayName}, ${users.loginName}, ${users.email})`;

@Injectable()
export class CommentService {
  constructor(private readonly schema: AppSchemaService, private readonly auth: AuthorizationService,
    private readonly notifications: NotificationPlanner) {}

  private async access(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string, write = false) {
    const { app, access } = await this.schema.access(tx, context, appId, 'view', write);
    const scope = { tenantId: context.tenantId, appId, recordId };
    const where = and(eq(records.tenantId, scope.tenantId), eq(records.appId, appId), eq(records.id, recordId),
      isNull(records.deletedAt), this.auth.recordScope(access, 'view'));
    const [record] = await tx.select({ id: records.id }).from(records).where(where);
    if (!record) throw new NotFoundException('无权限');
    if (!app.commentsEnabled || write && app.archivedAt) throw new ForbiddenException('Comments are unavailable for this application');
    const [role] = await tx.select({ manage: sql<boolean>`COALESCE(${this.auth.appManagementScope(context)}, false)` })
      .from(apps).where(and(eq(apps.tenantId, scope.tenantId), eq(apps.id, appId)));
    return { scope, where, schemaVersion: app.publishedSchemaVersion, manage: role.manage, archived: Boolean(app.archivedAt) };
  }

  list(context: TenantContext, appId: string, recordId: string, after?: string) {
    return withTenantTransaction(context, async (tx) => {
      const access = await this.access(tx, context, appId, recordId);
      const scope = commentScope(access.scope);
      const [anchor] = after ? await tx.select({ id: recordComments.id, createdAt: recordComments.createdAt }).from(recordComments)
        .where(and(scope, eq(recordComments.id, after))) : [];
      if (after && !anchor) throw new BadRequestException('Invalid comment cursor');
      const limit = 20;
      const rows = await tx.select({
        id: recordComments.id, authorId: recordComments.authorId, createdAt: recordComments.createdAt,
        deleted: sql<boolean>`${recordComments.deletedAt} IS NOT NULL`,
        body: sql<string | null>`CASE WHEN ${recordComments.deletedAt} IS NULL THEN ${recordComments.body} END`,
        author: sql<string>`${name} || CASE WHEN ${tenantMembers.disabledAt} IS NULL THEN '' ELSE '（已停用）' END`,
        importJobId: recordComments.importJobId, sourceActorId: recordComments.sourceActorId,
        sourceActorName: recordComments.sourceActorName, sourceTimestamp: recordComments.sourceTimestamp,
      }).from(recordComments).innerJoin(users, and(eq(users.tenantId, recordComments.tenantId), eq(users.id, recordComments.authorId)))
        .innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, users.tenantId), eq(tenantMembers.userId, users.id)))
        .where(and(scope, anchor ? sql`(${recordComments.createdAt}, ${recordComments.id}) < (${anchor.createdAt}::timestamptz, ${anchor.id}::uuid)` : undefined))
        .orderBy(sql`${recordComments.createdAt} DESC, ${recordComments.id} DESC`).limit(limit + 1);
      const page = rows.slice(0, limit);
      const visible = page.filter(({ deleted }) => !deleted).map(({ id }) => id);
      const mentions = visible.length ? await tx.select({
        commentId: commentMentions.commentId, offset: commentMentions.offset, length: commentMentions.length,
        userId: commentMentions.userId, name,
      }).from(commentMentions).innerJoin(users, and(eq(users.tenantId, commentMentions.tenantId), eq(users.id, commentMentions.userId)))
        .where(and(eq(commentMentions.tenantId, context.tenantId), eq(commentMentions.appId, appId), eq(commentMentions.recordId, recordId),
          inArray(commentMentions.commentId, visible))).orderBy(commentMentions.offset) : [];
      const items = page.map(({ body, ...comment }) => {
        // A migrated comment keeps its original author and time visible and
        // is marked as migration-sourced; it never poses as a local comment.
        const rendered = comment.importJobId ? {
          ...comment,
          author: comment.sourceActorName ?? comment.sourceActorId ?? comment.author,
          migration: {
            importJobId: comment.importJobId, sourceActorId: comment.sourceActorId,
            sourceTimestamp: comment.sourceTimestamp,
          },
        } : comment;
        const parts: Part[] = [];
        let offset = 0;
        if (body) {
          for (const token of mentions.filter(({ commentId }) => commentId === comment.id)) {
            if (offset < token.offset) parts.push({ kind: 'text', text: body.slice(offset, token.offset) });
            parts.push({ kind: 'mention', userId: token.userId, name: token.name });
            offset = token.offset + token.length;
          }
          if (offset < body.length) parts.push({ kind: 'text', text: body.slice(offset) });
        }
        return { ...rendered, parts, canDelete: !access.archived && !comment.deleted && (access.manage || comment.authorId === context.userId) };
      });
      return { items, next: rows.length > limit ? page[limit - 1].id : null };
    });
  }

  mentionOptions(context: TenantContext, appId: string, recordId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.access(tx, context, appId, recordId);
      const { user } = await this.schema.directoryOptions(tx, context, new Set(['user']));
      return user.filter(({ disabled }) => !disabled);
    });
  }

  create(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof createInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { scope, where, schemaVersion } = await this.access(tx, context, appId, recordId, true);
      const ids = [...new Set(input.parts.flatMap((part) => part.kind === 'mention' ? [part.userId] : []))];
      const candidates = ids.length ? await tx.select({ id: users.id, name }).from(users)
        .innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, users.tenantId), eq(tenantMembers.userId, users.id)))
        .where(and(eq(users.tenantId, scope.tenantId), inArray(users.id, ids), isNull(tenantMembers.disabledAt))) : [];
      if (candidates.length !== ids.length) throw new BadRequestException('Select valid active members for mentions');
      const names = new Map(candidates.map(({ id, name }) => [id, name]));
      const mentions = [];
      let body = '';
      for (const part of input.parts) {
        if (part.kind === 'text') { body += part.text; continue; }
        const label = '@' + names.get(part.userId)!;
        mentions.push({ ...scope, userId: part.userId, offset: body.length, length: label.length });
        body += label;
      }
      if (body.length > 4000) throw new BadRequestException('Comments can contain up to 4,000 characters');
      const [comment] = await tx.insert(recordComments).values({ ...scope, body, authorId: context.userId }).returning();
      if (mentions.length) await tx.insert(commentMentions).values(mentions.map((mention) => ({ ...mention, commentId: comment.id })));
      const { eventId, record } = await this.writeEvent(tx, context, where, 'comment-created', comment.id);
      await this.notifications.recordEvent(tx, context, record, eventId, {
        source: 'api', trigger: 'comment-created', schemaVersion, mentions: ids, commentAuthor: context.userId,
      });
      return { id: comment.id, createdAt: comment.createdAt, eventId, revision: record.revision };
    });
  }

  remove(context: TenantContext, appId: string, recordId: string, commentId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { scope, where, manage } = await this.access(tx, context, appId, recordId, true);
      const [comment] = await tx.update(recordComments).set({ deletedAt: sql`clock_timestamp()` }).where(and(
        commentScope(scope), eq(recordComments.id, commentId), isNull(recordComments.deletedAt),
        manage ? undefined : eq(recordComments.authorId, context.userId),
      )).returning({ id: recordComments.id });
      if (!comment) throw new NotFoundException('无权限');
      const { eventId, record } = await this.writeEvent(tx, context, where, 'comment-deleted', commentId);
      return { deleted: true as const, eventId, revision: record.revision };
    });
  }

  private async writeEvent(tx: TenantTransaction, context: TenantContext, where: ReturnType<typeof and>,
    kind: 'comment-created' | 'comment-deleted', commentId: string,
  ) {
    const [updated] = await tx.update(records).set({ revision: sql`${records.revision} + 1`,
      updatedBy: context.userId, updatedAt: sql`clock_timestamp()` }).where(where).returning();
    if (!updated) throw new NotFoundException('无权限');
    const record = serializeRecord(updated);
    const eventId = await writeRecordEvent(tx, context, record, kind, [], 'api', { type: 'comment', id: commentId });
    return { eventId, record };
  }
}

@ApiTags('comments')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/records/:recordId/comments')
export class CommentController {
  constructor(private readonly comments: CommentService) {}

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') recordId: string, @Query() query: unknown) {
    return this.comments.list(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(listQuery, query).after);
  }
  @Get('mention-options')
  mentionOptions(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') recordId: string) {
    return this.comments.mentionOptions(context, parseInput(identifier, appId), parseInput(identifier, recordId));
  }
  @Post()
  create(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') recordId: string, @Body() body: unknown) {
    return this.comments.create(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(createInput, body));
  }
  @Delete(':commentId')
  remove(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Param('commentId') commentId: string,
  ) {
    return this.comments.remove(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(identifier, commentId));
  }
}
