import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException,
  Get, Injectable, NotFoundException, Param, Patch, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, eq, groupMembers, isNull, loginCredentials, memberGroups, organizations, records,
  sql, tenantMembers, tenants, users, type TenantContext, type TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { z } from 'zod';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { identifier, parseInput, postgresErrorCode } from './validation';

const name = z.string().trim().min(1).max(120).refine((value) => !/[\x00\p{Surrogate}]/u.test(value));
const password = z.string().min(1).max(1024).refine((value) => !/[\x00\p{Surrogate}]/u.test(value));
const newUser = z.strictObject({
  email: z.email().max(254).transform((value) => value.toLowerCase()),
  loginName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i).transform((value) => value.toLowerCase()),
  displayName: name,
  password,
});
const organization = z.strictObject({ name, parentId: identifier.nullable() });
const policy = z.strictObject({
  allowAppCreation: z.boolean(), passwordMinimum: z.number().int().min(8).max(128), passwordComplexity: z.boolean(),
});

@Injectable()
export class TenantAdminService {
  private run<T>(
    context: TenantContext,
    operation: (tx: TenantTransaction, settings: typeof tenants.$inferSelect) => Promise<T>,
  ) {
    return withTenantTransaction(context, async (tx) => {
      // Serialize tenant administration so organization moves and removals check one consistent tree.
      const [settings] = await tx.select().from(tenants).where(eq(tenants.id, context.tenantId)).for('update');
      const [member] = await tx.select().from(tenantMembers).where(and(
        eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, context.userId),
      ));
      if (!settings || !member?.isAdmin || member.disabledAt) throw new ForbiddenException('无权限');
      return operation(tx, settings);
    });
  }

  directory(context: TenantContext) {
    return this.run(context, async (tx, settings) => {
      const members = await tx.select({
        id: users.id, loginName: users.loginName, email: users.email, displayName: users.displayName,
        isAdmin: tenantMembers.isAdmin, disabledAt: tenantMembers.disabledAt, organizationId: tenantMembers.organizationId,
      }).from(users).innerJoin(tenantMembers, and(
        eq(users.tenantId, tenantMembers.tenantId), eq(users.id, tenantMembers.userId),
      )).where(eq(users.tenantId, context.tenantId));
      return {
        settings,
        members: members.map((member) => ({
          ...member,
          label: (member.displayName ?? member.email) + (member.disabledAt ? '（已停用）' : ''),
        })),
        organizations: await tx.select().from(organizations).where(eq(organizations.tenantId, context.tenantId)),
        groups: await tx.select().from(memberGroups).where(eq(memberGroups.tenantId, context.tenantId)),
        groupMembers: await tx.select().from(groupMembers).where(eq(groupMembers.tenantId, context.tenantId)),
      };
    });
  }

  settings(context: TenantContext, input: z.infer<typeof policy>) {
    return this.run(context, async (tx) => {
      const [settings] = await tx.update(tenants).set(input).where(eq(tenants.id, context.tenantId)).returning();
      return settings;
    });
  }

  private passwordHash(value: string, settings: typeof tenants.$inferSelect) {
    if ([...value].length < settings.passwordMinimum || (settings.passwordComplexity &&
      ![/\p{Lu}/u, /\p{Ll}/u, /\p{Nd}/u, /[\p{P}\p{S}]/u].every((pattern) => pattern.test(value)))) {
      throw new BadRequestException({ field: 'password', message: 'Password does not meet tenant policy' });
    }
    return sql<string>`authentication.crypt(
      encode(authentication.digest(${value}::text, 'sha256'), 'hex'), authentication.gen_salt('bf', 12)
    )`;
  }

  createUser(context: TenantContext, { password: value, ...input }: z.infer<typeof newUser>) {
    return this.run(context, async (tx, settings) => {
      const passwordHash = this.passwordHash(value, settings);
      const [email] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.tenantId, context.tenantId), sql`lower(${users.email}) = ${input.email}`,
      ));
      const [loginName] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.tenantId, context.tenantId), eq(users.loginName, input.loginName),
      ));
      const duplicates = [email && 'email', loginName && 'loginName'].filter(Boolean);
      if (duplicates.length) throw new ConflictException({ duplicates });
      const [user] = await tx.insert(users).values({ ...input, tenantId: context.tenantId }).returning();
      const identity = { tenantId: context.tenantId, userId: user.id };
      await tx.insert(tenantMembers).values(identity);
      await tx.insert(loginCredentials).values({ ...identity, email: user.email, passwordHash });
      return user;
    });
  }

  updateUser(context: TenantContext, id: string, input: { displayName?: string; organizationId?: string | null }) {
    return this.run(context, async (tx) => {
      const [user] = input.displayName === undefined
        ? await tx.select().from(users).where(and(eq(users.tenantId, context.tenantId), eq(users.id, id)))
        : await tx.update(users).set({ displayName: input.displayName })
          .where(and(eq(users.tenantId, context.tenantId), eq(users.id, id))).returning();
      if (!user) throw new NotFoundException();
      if (input.organizationId !== undefined) {
        await tx.update(tenantMembers).set({ organizationId: input.organizationId }).where(and(
          eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, id),
        ));
      }
      return user;
    }).catch(this.referenceError);
  }

  resetPassword(context: TenantContext, id: string, value: string) {
    return this.run(context, async (tx, settings) => {
      const passwordHash = this.passwordHash(value, settings);
      const [member] = await tx.update(tenantMembers).set({ sessionVersion: sql`${tenantMembers.sessionVersion} + 1` })
        .where(and(eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, id))).returning();
      if (!member) throw new NotFoundException();
      const result = await tx.update(loginCredentials).set({ passwordHash }).where(and(
        eq(loginCredentials.tenantId, context.tenantId), eq(loginCredentials.userId, id),
      ));
      if (!result.rowCount) throw new NotFoundException();
      return { updated: true };
    });
  }

  disable(context: TenantContext, id: string) {
    return this.run(context, async (tx) => {
      if (id === context.userId) throw new ConflictException('Cannot disable the current administrator');
      const [member] = await tx.select().from(tenantMembers).where(and(
        eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, id),
      )).for('update');
      if (!member) throw new NotFoundException();
      const affected = await tx.select({
        id: records.id, appId: records.appId, recordNo: sql<string>`${records.recordNo}::text`,
      }).from(records).where(and(
        eq(records.tenantId, context.tenantId), eq(records.createdBy, id), isNull(records.deletedAt),
      ));
      if (affected.length) throw new ConflictException({ message: 'Transfer records before disabling', records: affected });
      await tx.update(tenantMembers).set({ disabledAt: new Date().toISOString() }).where(and(
        eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, id),
      ));
      return { disabled: true };
    });
  }

  saveOrganization(context: TenantContext, id: string | undefined, input: z.infer<typeof organization>) {
    return this.run(context, async (tx) => {
      const tree = await tx.select().from(organizations).where(eq(organizations.tenantId, context.tenantId));
      const parents = new Map(tree.map((item) => [item.id, item.parentId]));
      const visited = new Set([id]);
      for (let parent = input.parentId; parent !== null;) {
        if (visited.has(parent)) throw new ConflictException('Organization cycle');
        if (!parents.has(parent)) throw new BadRequestException('Unknown parent organization');
        visited.add(parent);
        parent = parents.get(parent)!;
      }
      const [saved] = id
        ? await tx.update(organizations).set(input).where(and(
          eq(organizations.tenantId, context.tenantId), eq(organizations.id, id),
        )).returning()
        : await tx.insert(organizations).values({ tenantId: context.tenantId, ...input }).returning();
      if (!saved) throw new NotFoundException();
      return saved;
    });
  }

  deleteOrganization(context: TenantContext, id: string) {
    return this.run(context, async (tx) => {
      const members = await tx.select({ id: tenantMembers.userId }).from(tenantMembers).where(and(
        eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.organizationId, id),
      ));
      const children = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations)
        .where(and(eq(organizations.tenantId, context.tenantId), eq(organizations.parentId, id)));
      if (members.length || children.length) throw new ConflictException({ members, children });
      const [deleted] = await tx.delete(organizations).where(and(
        eq(organizations.tenantId, context.tenantId), eq(organizations.id, id),
      )).returning();
      if (!deleted) throw new NotFoundException();
      return { deleted: true };
    });
  }

  createGroup(context: TenantContext, label: string) {
    return this.run(context, async (tx) => {
      const [group] = await tx.insert(memberGroups).values({ tenantId: context.tenantId, name: label }).returning();
      return group;
    });
  }

  setGroupMember(context: TenantContext, groupId: string, userId: string, included: boolean) {
    return this.run(context, async (tx) => {
      if (included) {
        await tx.insert(groupMembers).values({ tenantId: context.tenantId, groupId, userId }).onConflictDoNothing();
      } else {
        await tx.delete(groupMembers).where(and(
          eq(groupMembers.tenantId, context.tenantId), eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId),
        ));
      }
      return { included };
    }).catch(this.referenceError);
  }

  private referenceError(error: unknown): never {
    if (postgresErrorCode(error) === '23503') throw new BadRequestException('Unknown directory reference');
    throw error;
  }
}

@ApiTags('tenant administration')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('tenant')
export class TenantAdminController {
  constructor(private readonly admin: TenantAdminService) {}

  @Get('directory')
  directory(@AuthenticatedTenant() context: TenantContext) {
    return this.admin.directory(context);
  }

  @Put('settings')
  settings(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    return this.admin.settings(context, parseInput(policy, body));
  }

  @Post('users')
  createUser(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    return this.admin.createUser(context, parseInput(newUser, body));
  }

  @Patch('users/:id')
  updateUser(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.updateUser(context, parseInput(identifier, id), parseInput(z.strictObject({
      displayName: name.optional(), organizationId: identifier.nullable().optional(),
    }), body));
  }

  @Put('users/:id/password')
  reset(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    const input = parseInput(z.strictObject({ password }), body);
    return this.admin.resetPassword(context, parseInput(identifier, id), input.password);
  }

  @Post('users/:id/disable')
  disable(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string) {
    return this.admin.disable(context, parseInput(identifier, id));
  }

  @Post('organizations')
  createOrganization(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    return this.admin.saveOrganization(context, undefined, parseInput(organization, body));
  }

  @Put('organizations/:id')
  updateOrganization(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string, @Body() body: unknown) {
    return this.admin.saveOrganization(context, parseInput(identifier, id), parseInput(organization, body));
  }

  @Delete('organizations/:id')
  deleteOrganization(@AuthenticatedTenant() context: TenantContext, @Param('id') id: string) {
    return this.admin.deleteOrganization(context, parseInput(identifier, id));
  }

  @Post('groups')
  createGroup(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    return this.admin.createGroup(context, parseInput(z.strictObject({ name }), body).name);
  }

  @Put('groups/:id/members/:userId')
  setGroupMember(
    @AuthenticatedTenant() context: TenantContext, @Param('id') id: string,
    @Param('userId') userId: string, @Body() body: unknown,
  ) {
    return this.admin.setGroupMember(context, parseInput(identifier, id), parseInput(identifier, userId),
      parseInput(z.strictObject({ included: z.boolean() }), body).included);
  }
}
