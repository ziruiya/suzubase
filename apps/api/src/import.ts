import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  BadRequestException, Body, CanActivate, Controller, createParamDecorator, ExecutionContext, ForbiddenException,
  Get, Injectable, NotFoundException, Param, Post, Put, StreamableFile, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { unzipSync } from 'fflate';
import {
  and, apiTokenHash, apps, eq, importJobs, inArray, memberGroups, migrationAuditLog, migrationTokens, organizations,
  sql, tenantMembers, users, verifyMigrationToken, withTenantTransaction,
  type SourceIdMapRow, type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import { z } from 'zod';
import { AppSchemaService } from './app-schema';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { identifier, parseInput } from './validation';
import {
  PACKAGE_FORMAT_VERSION, SENSITIVE_DATA_NOTICE, verifyPackage, type PackageManifest,
} from './export-package';

/**
 * Gate 3 Wave B: M1 package import (G3-06 migration channel, G3-07 job state
 * machine + preflight, G3-08 mapping wizard, G3-09 verification + difference
 * report). Contracts ch.4 and brief decisions 4/5/6/7/8 govern this module.
 *
 * Channel separation (decision 7): wizard decisions and job administration run
 * on the ordinary session of a tenant administrator, but every write of system
 * fields (record status, assignees, creator/updater/timestamps, comment
 * authorship, history source time/author) runs through the migration channel,
 * authenticated by a single-job migration token (MigrationGuard). The staging
 * executor therefore never runs under a bare session.
 */
// Deployment program version for the M1 import gate. Raised to 1.1.0 at
// the P4 merge finalization together with MINIMUM_PROGRAM_VERSION (see
// export-package.ts): this deployment understands P4 packages; pre-P4
// deployments stay at 1.0.0 and reject them explicitly.
export const PROGRAM_VERSION = '1.1.0';
/** Route-scoped body limit for POST /imports/upload (Wave C gap fix).
 * Import packages are tenant-admin-only whole-application archives and can
 * legitimately exceed the 8 MB single-attachment limit; the parser in
 * main.ts applies this larger limit ONLY to the import upload route and
 * keeps maxAttachmentBytes for every other octet-stream route. */
export const maxImportPackageBytes = 256 * 1024 * 1024;
export const MIGRATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface MigrationContext extends TenantContext {
  readonly importJobId: string;
  readonly targetAppId: string | null;
}

interface MigrationRequest {
  headers: { authorization?: string };
  migrationContext: MigrationContext;
}

@Injectable()
export class MigrationGuard implements CanActivate {
  async canActivate(executionContext: ExecutionContext) {
    const request = executionContext.switchToHttp().getRequest<MigrationRequest>();
    const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '');
    if (!match || !/^sbm1_[A-Za-z0-9_-]{43}$/.test(match[1])) throw new UnauthorizedException('Migration token required');
    const token = await verifyMigrationToken(match[1]);
    if (!token) throw new UnauthorizedException('Migration token is invalid, expired or its job is finished');
    request.migrationContext = Object.freeze({
      tenantId: token.tenantId, userId: token.userId,
      importJobId: token.importJobId, targetAppId: token.targetAppId,
    });
    return true;
  }
}

export const MigrationChannel = createParamDecorator(
  (_data: unknown, context: ExecutionContext): MigrationContext =>
    context.switchToHttp().getRequest<MigrationRequest>().migrationContext,
);

// ---------------------------------------------------------------------------
// Package payload shapes (mirror of the export collector in export.ts).
// ---------------------------------------------------------------------------
export interface PkgApp { id: string; code: string; name: string; description: string; icon: string | null;
  themeColor: string | null; titleFieldId: string | null; duplicateHint: boolean; numericPrecision: number;
  attachmentMaxBytes: number; attachmentMaxCount: number; attachmentTypes: string[]; localDrafts: boolean;
  commentsEnabled: boolean; workflowEnabled: boolean; adminMemo: string;
  publishedSchemaVersion: number; draftSchemaVersion: number | null; createdBy: string }
export interface PkgField { fieldId: string; code: string; name: string; type: string; required: boolean;
  uniqueValue: boolean; searchMode: string | null; formula: unknown; lookup: any; related: any; table: any;
  layoutElement: unknown; autoNumber: any; options: unknown[] }
export interface PkgVersion { version: number; aclConfiguration: any; fieldEdits: Record<string, any>;
  formLayout: any; notificationRules: any[]; viewConfiguration: any; migrationReport: unknown; fields: PkgField[];
  /** P4-T1 additive key; absent in pre-P4 packages. */
  categories?: { enabled: boolean; nodes: { id: string; parentId: string | null; name: string; sortOrder: number }[] } }
export interface PkgRecord { id: string; recordNo: string; data: Record<string, string>;
  archivedData: Record<string, string>; schemaVersion: number; revision: number; status: string;
  createdBy: string; createdAt: string; updatedBy: string; updatedAt: string;
  deletedBy: string | null; deletedAt: string | null;
  /** P4-T1 additive key; absent in pre-P4 packages. */
  categoryIds?: string[];
  workflow: { workflowId: string; workflowVersion: number; stateId: string; assignees: string[] } | null }
export interface PkgPackage {
  manifest: PackageManifest;
  app: PkgApp;
  recordCounter: string;
  autoNumberCounters: { fieldId: string; scope: string; nextValue: string }[];
  versions: PkgVersion[];
  rawFields: (PkgField & { introducedIn: number; tenantId?: string; appId?: string })[];
  deletedFields: { fieldId: string; definition: PkgField | null }[];
  workflows: { id: string; version: number; status: string; states: any[]; actions: any[] }[];
  records: PkgRecord[];
  tableRows: { recordId: string; fieldId: string; rowId: string; rowOrder: number; data: Record<string, string> }[];
  references: { recordId: string; fieldId: string; targetAppId: string; targetAppCode: string | null; targetRecordId: string }[];
  filesMeta: { id: string; uploadedBy: string; name: string; contentType: string; bytes: number;
    sha256: string | null; state: string; version: number; createdAt: string; deletedAt: string | null }[];
  comments: { id: string; recordId: string; authorId: string; createdAt: string; deleted: boolean;
    deletedAt: string | null; body: string | null; mentions: { userId: string; offset: number; length: number }[] }[];
  recordEvents: any[];
  workflowEvents: any[];
  config: { acl: any; notificationRules: any[]; relations: any[]; apiTokens: any[] };
  /** P3-D wave 2: automation section; null for pre-wave-2 packages. */
  automation: AutomationPackage | null;
  directory: { users: { id: string; email: string; loginName: string | null; displayName: string | null; disabled: boolean }[];
    groups: { id: string; name: string; memberUserIds: string[] }[];
    organizations: { id: string; name: string; parentId: string | null }[] };
  attachmentBodies: Map<string, Buffer>;
}

export function readPackage(archive: Buffer): PkgPackage {
  const entries = unzipSync(new Uint8Array(archive));
  const json = <T,>(path: string): T => {
    const body = entries[path];
    if (!body) throw new BadRequestException(`Package is missing ${path}`);
    return JSON.parse(Buffer.from(body).toString('utf8')) as T;
  };
  const manifest = json<PackageManifest>('manifest.json');
  const appFile = json<any>('data/app.json');
  const schema = json<any>('data/schema.json');
  const workflows = json<any>('data/workflows.json');
  const records = json<any>('data/records.json');
  const rows = json<any>('data/table-rows.json');
  const references = json<any>('data/references.json');
  const attachments = json<any>('data/attachments.json');
  const comments = json<any>('data/comments.json');
  const history = json<any>('data/history.json');
  const config = json<any>('data/config.json');
  const directory = json<any>('data/directory.json');
  const automationBody = entries['data/automation.json'];
  const automation = automationBody
    ? JSON.parse(Buffer.from(automationBody).toString('utf8')) as AutomationPackage : null;
  const attachmentBodies = new Map<string, Buffer>();
  for (const [path, body] of Object.entries(entries)) {
    if (path.startsWith('attachments/')) attachmentBodies.set(path, Buffer.from(body));
  }
  return {
    manifest, app: appFile.app, recordCounter: appFile.recordCounter ?? '0',
    autoNumberCounters: appFile.autoNumberCounters ?? [],
    versions: schema.versions ?? [], rawFields: schema.rawFields ?? [], deletedFields: schema.deletedFields ?? [],
    workflows: workflows.definitions ?? [], records: records.records ?? [], tableRows: rows.rows ?? [],
    references: references.references ?? [], filesMeta: attachments.files ?? [], comments: comments.comments ?? [],
    recordEvents: history.recordEvents ?? [], workflowEvents: history.workflowEvents ?? [],
    config, directory, attachmentBodies, automation,
  };
}

function importDirectory() {
  return process.env.IMPORT_DIRECTORY ??
    resolve(process.env.ATTACHMENT_DIRECTORY ?? './attachments', 'imports');
}

export function importPackagePath(tenantId: string, jobId: string) {
  return resolve(importDirectory(), tenantId, `${jobId}.zip`);
}

type JobRow = typeof importJobs.$inferSelect;

export function jobView(job: JobRow) {
  return {
    id: job.id, status: job.status, stage: job.stage, completion: job.completion,
    sourceExportId: job.sourceExportId, sourceInstanceId: job.sourceInstanceId,
    sourceTenantId: job.sourceTenantId, sourceAppId: job.sourceAppId, sourceAppCode: job.sourceAppCode,
    packageSha256: job.packageSha256, packageBytes: job.packageBytes,
    targetAppId: job.targetAppId, duplicateOf: job.duplicateOf, duplicateConfirmed: job.duplicateConfirmed,
    userMapping: job.userMapping, groupMapping: job.groupMapping, organizationMapping: job.organizationMapping,
    dependencyDecisions: job.dependencyDecisions, pending: job.pending,
    entityMapping: job.entityMapping, attempts: job.attempts, error: job.error,
    report: job.report, errorReport: job.errorReport,
    createdAt: job.createdAt, updatedAt: job.updatedAt, activatedAt: job.activatedAt,
    sensitiveDataNotice: SENSITIVE_DATA_NOTICE,
  };
}

const mappingsInput = z.strictObject({
  users: z.record(identifier, identifier.nullable()).optional(),
  groups: z.record(identifier, identifier.nullable()).optional(),
  organizations: z.record(identifier, identifier.nullable()).optional(),
  dependencies: z.record(z.string(), z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('map'), targetAppId: identifier,
      fieldMappings: z.record(z.string(), identifier).default({}) }),
    z.strictObject({ action: z.literal('disable') }),
    z.strictObject({ action: z.literal('skip') }),
  ])).optional(),
  confirmDuplicate: z.boolean().optional(),
});
export const importHttp = { mappingsInput };

@Injectable()
export class ImportService {
  constructor(private readonly schema: AppSchemaService) {}

  /** Tenant administrators only: token issuance and wizard administration. */
  async requireAdmin(tx: TenantTransaction, context: TenantContext) {
    const [member] = await tx.select({ isAdmin: tenantMembers.isAdmin, disabledAt: tenantMembers.disabledAt })
      .from(tenantMembers).where(and(eq(tenantMembers.tenantId, context.tenantId),
        eq(tenantMembers.userId, context.userId)));
    if (!member?.isAdmin || member.disabledAt) throw new ForbiddenException('无权限');
  }

  async jobRow(tx: TenantTransaction, context: TenantContext, jobId: string) {
    const [job] = await tx.select().from(importJobs).where(and(
      eq(importJobs.tenantId, context.tenantId), eq(importJobs.id, jobId)));
    if (!job) throw new NotFoundException('无权限');
    return job;
  }

  async audit(tx: TenantTransaction, context: TenantContext, job: JobRow, entry: {
    action: string; objectType: string; objectId?: string; fieldSurface?: string[]; operatorId?: string;
  }) {
    await tx.insert(migrationAuditLog).values({
      tenantId: context.tenantId, importJobId: job.id, targetAppId: job.targetAppId,
      operatorId: entry.operatorId ?? context.userId, action: entry.action,
      objectType: entry.objectType, objectId: entry.objectId ?? null, fieldSurface: entry.fieldSurface ?? [],
    });
  }

  async upload(context: TenantContext, archive: Buffer) {
    if (!archive?.length) throw new BadRequestException('Package body is empty');
    const packageSha256 = createHash('sha256').update(archive).digest('hex');
    let manifest: PackageManifest | null = null;
    try {
      const entries = unzipSync(new Uint8Array(archive));
      if (entries['manifest.json']) {
        manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString('utf8')) as PackageManifest;
      }
    } catch { manifest = null; }
    const job = await withTenantTransaction(context, async (tx) => {
      await this.requireAdmin(tx, context);
      const [created] = await tx.insert(importJobs).values({
        tenantId: context.tenantId, createdBy: context.userId,
        sourceExportId: manifest?.exportId ?? null, sourceInstanceId: manifest?.sourceInstanceId ?? null,
        sourceTenantId: manifest?.sourceTenantId ?? null, sourceAppId: manifest?.sourceAppId ?? null,
        sourceAppCode: manifest?.sourceAppCode ?? null,
        packageSha256, packageBytes: archive.length,
      }).returning();
      // Duplicate-package detection (G3-07): the same sealed package already
      // imported by a live job in this tenant. The new job is flagged, never
      // silently merged; validation stays blocked until an admin confirms.
      const [duplicate] = await tx.select({ id: importJobs.id }).from(importJobs).where(and(
        eq(importJobs.tenantId, context.tenantId), eq(importJobs.packageSha256, packageSha256),
        sql`${importJobs.id} <> ${created.id}`,
        sql`${importJobs.status} NOT IN ('failed', 'cancelled')`,
      )).limit(1);
      if (!duplicate) return created;
      const [flagged] = await tx.update(importJobs).set({ duplicateOf: duplicate.id })
        .where(eq(importJobs.id, created.id)).returning();
      return flagged;
    });
    const path = importPackagePath(context.tenantId, job.id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, archive, { mode: 0o600 });
    return {
      ...jobView(job),
      duplicateWarning: job.duplicateOf
        ? 'This package was already uploaded for import in this tenant. Continuing will create a second copy of the application and its data; an administrator must explicitly confirm before validation.'
        : null,
    };
  }

  async list(context: TenantContext) {
    return withTenantTransaction(context, async (tx) => {
      await this.requireAdmin(tx, context);
      const rows = await tx.select().from(importJobs).where(eq(importJobs.tenantId, context.tenantId))
        .orderBy(sql`${importJobs.createdAt} DESC`).limit(50);
      return rows.map(jobView);
    });
  }

  /** Job detail plus the wizard's mapping suggestions (decision 4). */
  async get(context: TenantContext, jobId: string) {
    const job = await withTenantTransaction(context, async (tx) => {
      await this.requireAdmin(tx, context);
      return this.jobRow(tx, context, jobId);
    });
    let pkg: PkgPackage | null = null;
    try { pkg = readPackage(await readFile(importPackagePath(context.tenantId, jobId))); } catch { pkg = null; }
    const directory = await withTenantTransaction(context, async (tx) => {
      const targetUsers = await tx.select({
        id: users.id, email: users.email, loginName: users.loginName, displayName: users.displayName,
        disabled: sql<boolean>`${tenantMembers.disabledAt} IS NOT NULL`,
      }).from(users).innerJoin(tenantMembers, and(eq(tenantMembers.tenantId, users.tenantId),
        eq(tenantMembers.userId, users.id))).where(eq(users.tenantId, context.tenantId));
      const targetGroups = await tx.select().from(memberGroups).where(eq(memberGroups.tenantId, context.tenantId));
      const targetOrganizations = await tx.select().from(organizations)
        .where(eq(organizations.tenantId, context.tenantId));
      return { targetUsers, targetGroups, targetOrganizations };
    });
    const suggestUser = (source: { email: string; loginName: string | null }) =>
      directory.targetUsers.find((user) => user.email.toLowerCase() === source.email.toLowerCase())?.id ??
      directory.targetUsers.find((user) => user.loginName && source.loginName &&
        user.loginName.toLowerCase() === source.loginName.toLowerCase())?.id ?? null;
    return {
      ...jobView(job),
      report: job.report, errorReport: job.errorReport,
      source: pkg ? {
        manifest: pkg.manifest,
        users: pkg.directory.users.map((user) => ({ ...user, suggestion: suggestUser(user) })),
        groups: pkg.directory.groups.map((group) => ({
          ...group,
          suggestion: directory.targetGroups.find((target) => target.name === group.name)?.id ?? null,
        })),
        organizations: pkg.directory.organizations.map((organization) => ({
          ...organization,
          suggestion: directory.targetOrganizations.find((target) => target.name === organization.name)?.id ?? null,
        })),
        relations: pkg.config.relations,
        apiTokens: pkg.config.apiTokens,
      } : null,
      target: directory,
    };
  }

  async saveMappings(context: TenantContext, jobId: string, input: z.infer<typeof mappingsInput>) {
    return withTenantTransaction(context, async (tx) => {
      await this.requireAdmin(tx, context);
      const job = await this.jobRow(tx, context, jobId);
      if (!['uploaded', 'staging', 'ready'].includes(job.status)) {
        throw new BadRequestException('Mappings can only change before activation');
      }
      const check = async (ids: (string | null)[], kind: 'user' | 'group' | 'organization') => {
        const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
        if (!wanted.length) return;
        const table = kind === 'user' ? tenantMembers : kind === 'group' ? memberGroups : organizations;
        const column = kind === 'user' ? tenantMembers.userId : (table as typeof memberGroups).id;
        const rows = await tx.select({ id: column }).from(table)
          .where(and(eq(table.tenantId, context.tenantId), inArray(column, wanted)));
        if (rows.length !== wanted.length) {
          throw new BadRequestException(`Mapping target ${kind} does not exist in this tenant`);
        }
      };
      await check(Object.values(input.users ?? {}), 'user');
      await check(Object.values(input.groups ?? {}), 'group');
      await check(Object.values(input.organizations ?? {}), 'organization');
      const [saved] = await tx.update(importJobs).set({
        userMapping: { ...job.userMapping, ...(input.users ?? {}) },
        groupMapping: { ...job.groupMapping, ...(input.groups ?? {}) },
        organizationMapping: { ...job.organizationMapping, ...(input.organizations ?? {}) },
        dependencyDecisions: { ...job.dependencyDecisions, ...(input.dependencies ?? {}) },
        ...(input.confirmDuplicate !== undefined && { duplicateConfirmed: input.confirmDuplicate }),
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId)).returning();
      return jobView(saved);
    });
  }

  /** Decision 7: tenant-admin issuance, plaintext once, 24h / terminal expiry. */
  async issueToken(context: TenantContext, jobId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.requireAdmin(tx, context);
      const job = await this.jobRow(tx, context, jobId);
      if (['activated', 'failed', 'cancelled'].includes(job.status)) {
        throw new BadRequestException('The import job is finished; its migration tokens have expired');
      }
      const token = 'sbm1_' + randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + MIGRATION_TOKEN_TTL_MS).toISOString();
      const [stored] = await tx.insert(migrationTokens).values({
        tenantId: context.tenantId, importJobId: jobId, targetAppId: job.targetAppId,
        issuedBy: context.userId, secretHash: apiTokenHash(token), expiresAt,
      }).returning({ id: migrationTokens.id });
      await this.audit(tx, context, job, {
        action: 'token-issued', objectType: 'migration-token', objectId: stored.id,
      });
      return { id: stored.id, token, expiresAt, importJobId: jobId, targetAppId: job.targetAppId };
    });
  }
}

// ---------------------------------------------------------------------------
// G3-07 preflight (VALIDATING): package integrity, version compatibility,
// reference integrity item by item, and field-structure compatibility.
// Fatal problems fail the job with a downloadable, object-level error report;
// nothing is ever half-imported on a fatal problem.
// ---------------------------------------------------------------------------
export interface PreflightIssue {
  object: string;
  referrer?: string;
  missingTarget?: string;
  field?: string;
  message: string;
}

function compareVersion(a: string, b: string) {
  const pa = a.split('.').map((part) => Number(part) || 0);
  const pb = b.split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export function preflightPackage(pkg: PkgPackage, archive: Buffer) {
  const errors: PreflightIssue[] = [];
  const missingReferences: PreflightIssue[] = [];
  for (const problem of verifyPackage(archive).problems) {
    errors.push({ object: 'package', message: problem });
  }
  if (compareVersion(pkg.manifest.minimumProgramVersion, PROGRAM_VERSION) > 0) {
    errors.push({
      object: 'package',
      message: `Package requires program version ${pkg.manifest.minimumProgramVersion} or newer; this deployment runs ${PROGRAM_VERSION}. Upgrade the deployment, then import again.`,
    });
  }
  if (pkg.manifest.formatVersion !== PACKAGE_FORMAT_VERSION) {
    errors.push({
      object: 'package',
      message: `Package format ${pkg.manifest.formatVersion} is outside the supported window (this deployment imports format ${PACKAGE_FORMAT_VERSION}). Re-export with a supported version or use the format conversion path when it ships.`,
    });
  }
  const recordIds = new Set(pkg.records.map((record) => record.id));
  const fieldIds = new Set(pkg.rawFields.map((field) => field.fieldId));
  const directoryUserIds = new Set(pkg.directory.users.map((user) => user.id));
  const eventIds = new Set(pkg.recordEvents.map((event) => event.eventId));
  // Field-structure compatibility.
  const codes = new Set<string>();
  for (const field of pkg.rawFields) {
    if (codes.has(field.code)) {
      errors.push({ object: 'field', field: field.fieldId, message: `Duplicate field code ${field.code}` });
    }
    codes.add(field.code);
  }
  for (const version of pkg.versions) {
    for (const field of version.fields) {
      if (!fieldIds.has(field.fieldId)) fieldIds.add(field.fieldId);
    }
  }
  // Internal reference integrity, item by item (contracts 4 SS4.7.5).
  for (const row of pkg.tableRows) {
    if (!recordIds.has(row.recordId)) {
      errors.push({ object: 'table-row', referrer: row.rowId, missingTarget: row.recordId,
        message: 'Subtable row references a record that is not in the package' });
    }
    if (!fieldIds.has(row.fieldId)) {
      errors.push({ object: 'table-row', referrer: row.rowId, missingTarget: row.fieldId,
        message: 'Subtable row references a field that is not in the package' });
    }
  }
  for (const comment of pkg.comments) {
    if (!recordIds.has(comment.recordId)) {
      errors.push({ object: 'comment', referrer: comment.id, missingTarget: comment.recordId,
        message: 'Comment references a record that is not in the package' });
    }
    for (const mention of comment.mentions) {
      if (!directoryUserIds.has(mention.userId)) {
        missingReferences.push({ object: 'mention', referrer: comment.id, missingTarget: mention.userId,
          message: 'Mentioned user is not part of the package directory; the mention will not be restored' });
      }
    }
  }
  for (const event of pkg.recordEvents) {
    if (!recordIds.has(event.recordId)) {
      errors.push({ object: 'history-event', referrer: event.eventId, missingTarget: event.recordId,
        message: 'History event references a record that is not in the package' });
    }
  }
  for (const event of pkg.workflowEvents) {
    if (!eventIds.has(event.eventId)) {
      errors.push({ object: 'workflow-event', referrer: event.eventId, missingTarget: event.eventId,
        message: 'Workflow event has no matching record event in the package' });
    }
  }
  for (const reference of pkg.references) {
    if (!recordIds.has(reference.recordId)) {
      errors.push({ object: 'reference', referrer: reference.recordId, missingTarget: reference.recordId,
        message: 'Reference row belongs to a record that is not in the package' });
    }
    if (reference.targetAppId === pkg.app.id) {
      if (!recordIds.has(reference.targetRecordId)) {
        errors.push({ object: 'reference', referrer: `${reference.recordId}/${reference.fieldId}`,
          missingTarget: reference.targetRecordId,
          message: 'Lookup reference target record is not in the package' });
      }
    } else {
      missingReferences.push({ object: 'reference', referrer: `${reference.recordId}/${reference.fieldId}`,
        missingTarget: reference.targetRecordId,
        message: `Lookup target lives in another application (${reference.targetAppCode ?? reference.targetAppId}); it resolves only through a cross-application dependency decision` });
    }
  }
  // P3-D wave 2: automation section integrity. A malformed section is a
  // fatal preflight problem; dangling webhook endpoint references are
  // missing references (the rule imports as a disabled draft and the
  // reference is reported, never guessed).
  if (pkg.automation) {
    if (pkg.automation.schemaVersion !== AUTOMATION_PACKAGE_SCHEMA_VERSION) {
      errors.push({ object: 'automation', message:
        `Automation section schema version ${pkg.automation.schemaVersion} is not supported by this deployment (expects ${AUTOMATION_PACKAGE_SCHEMA_VERSION})` });
    }
    if (!Array.isArray(pkg.automation.rules) || !Array.isArray(pkg.automation.endpoints)) {
      errors.push({ object: 'automation', message: 'Automation section is malformed: rules and endpoints must be arrays' });
    } else {
      const ruleIds = new Set<string>();
      for (const rule of pkg.automation.rules) {
        if (ruleIds.has(rule.sourceRuleId)) {
          errors.push({ object: 'automation-rule', referrer: rule.sourceRuleId,
            message: 'Duplicate automation rule id in the package' });
        }
        ruleIds.add(rule.sourceRuleId);
      }
      const endpointIds = new Set(pkg.automation.endpoints.map((endpoint) => endpoint.sourceEndpointId));
      for (const rule of pkg.automation.rules) {
        for (const version of rule.versions) {
          for (const action of version.actions) {
            if (action.type === 'WEBHOOK' && action.webhook?.endpointId &&
              !endpointIds.has(action.webhook.endpointId)) {
              missingReferences.push({ object: 'automation-webhook', referrer: rule.sourceRuleId,
                missingTarget: action.webhook.endpointId,
                message: 'Webhook action references an endpoint that is not in the package; the reference stays unresolved after import' });
            }
          }
        }
      }
    }
  }
  // Preserved auto numbers and unique values must not collide inside the package.
  const autoSeen = new Set<string>();
  const uniqueSeen = new Map<string, string>();
  const uniqueFields = new Set(pkg.rawFields.filter((field) => field.uniqueValue).map((field) => field.fieldId));
  for (const record of pkg.records) {
    for (const [fieldId, value] of Object.entries(record.data)) {
      const field = pkg.rawFields.find((candidate) => candidate.fieldId === fieldId);
      if (field?.autoNumber && value) {
        const key = `${fieldId}:${value}`;
        if (autoSeen.has(key)) {
          errors.push({ object: 'record', referrer: record.id, field: fieldId,
            message: `Duplicate preserved auto number ${value}` });
        }
        autoSeen.add(key);
      }
      if (uniqueFields.has(fieldId) && value && !record.deletedAt) {
        const key = `${fieldId}:${value.normalize('NFKC').toLowerCase()}`;
        const holder = uniqueSeen.get(key);
        if (holder && holder !== record.id) {
          errors.push({ object: 'record', referrer: record.id, field: fieldId,
            message: 'Duplicate value for a unique field inside the package' });
        }
        uniqueSeen.set(key, record.id);
      }
    }
  }
  return { errors, missingReferences };
}

// ---------------------------------------------------------------------------
// Mapping helpers shared by the staging executor and the report builder.
// ---------------------------------------------------------------------------
export interface DependencyDecision {
  action: 'map' | 'disable' | 'skip';
  targetAppId?: string;
  fieldMappings?: Record<string, string>;
}

export class IdMap {
  readonly rows: SourceIdMapRow[] = [];
  private readonly byKey = new Map<string, string>();
  constructor(existing: SourceIdMapRow[] = []) {
    for (const row of existing) {
      this.rows.push(row);
      this.byKey.set(`${row.objectType}:${row.sourceId}`, row.targetId);
    }
  }
  get(objectType: string, sourceId: string) {
    return this.byKey.get(`${objectType}:${sourceId}`);
  }
  set(objectType: string, sourceId: string, targetId: string) {
    const key = `${objectType}:${sourceId}`;
    if (this.byKey.has(key)) return this.byKey.get(key)!;
    this.byKey.set(key, targetId);
    this.rows.push({ objectType, sourceId, targetId, status: 'created' });
    return targetId;
  }
  /** Assign (or reuse) a fresh target id for a source object. */
  assign(objectType: string, sourceId: string) {
    return this.get(objectType, sourceId) ?? this.set(objectType, sourceId, randomUUID());
  }
}

export function mappedSubject(
  subject: { kind: string; id: string },
  job: JobRow,
  fieldMap: IdMap,
): { kind: string; id: string } | null {
  if (subject.kind === 'user-field' || subject.kind === 'group-field' || subject.kind === 'organization-field') {
    const fieldId = fieldMap.get('field', subject.id);
    return fieldId ? { kind: subject.kind, id: fieldId } : null;
  }
  const mapping = subject.kind === 'user' ? job.userMapping
    : subject.kind === 'group' ? job.groupMapping : job.organizationMapping;
  const target = mapping[subject.id];
  return target ? { kind: subject.kind, id: target } : null;
}

export function remapConditions(conditions: any[] | undefined, fieldMap: IdMap) {
  return (conditions ?? []).map((condition) => ({
    ...condition, fieldId: fieldMap.get('field', condition.fieldId) ?? condition.fieldId,
  }));
}

export function remapAcl(acl: any, job: JobRow, fieldMap: IdMap, dropped: any[]) {
  const mapRules = (rules: any[], layer: string) => (rules ?? []).flatMap((rule) => {
    const subject = mappedSubject(rule.subject, job, fieldMap);
    if (!subject) {
      // Default-deny (contracts 4 SS4.7.4): an unmapped ACL subject means the
      // rule does not take effect at all. It is never widened to everyone.
      dropped.push({ layer, ruleId: rule.id, subject: rule.subject, action: rule.action });
      return [];
    }
    return [{
      ...rule, subject,
      ...(rule.conditions && { conditions: remapConditions(rule.conditions, fieldMap) }),
      ...(rule.fieldId && { fieldId: fieldMap.get('field', rule.fieldId) ?? rule.fieldId }),
    }];
  });
  return {
    app: mapRules(acl?.app, 'app'),
    record: mapRules(acl?.record, 'record'),
    field: mapRules(acl?.field, 'field'),
  };
}

export function remapAssignees(sources: any[] | undefined, job: JobRow, fieldMap: IdMap, dropped: any[]) {
  return (sources ?? []).flatMap((source) => {
    if (source.kind === 'creator' || source.kind === 'previous') return [source];
    if (source.kind === 'user-field') {
      const fieldId = fieldMap.get('field', source.id);
      return fieldId ? [{ ...source, id: fieldId }] : [];
    }
    const mapped = mappedSubject(source, job, fieldMap);
    if (!mapped) {
      dropped.push({ source });
      return [];
    }
    return [mapped];
  });
}

// ---------------------------------------------------------------------------
// Staging executor. Every batch is one transaction (batch-atomic, resumable
// across batches, contracts 4 SS4.7.2); the source_id_map persisted on the job
// after each batch makes a re-run skip everything already written, so the same
// job can never produce duplicates. Side effects are suppressed by
// construction: the executor never touches the notification planner and never
// inserts outbox rows, so an import produces exactly zero notifications.
// ---------------------------------------------------------------------------
import {
  appCounters, appVersions, autoNumberCounters, automationRules, automationRuleVersions,
  automationWebhookEndpoints, commentMentions, fields as fieldRows, fileReferences, files,
  recordCategories, recordComments, recordEvents, recordReferences, recordTableRows, recordUniqueValues,
  recordWorkflowState, records, tableFileReferences, workflowActions, workflowAssignments, workflowDefinitions, workflowEvents,
  workflowStates,
} from '@suzubase/db';
import {
  AUTOMATION_PACKAGE_SCHEMA_VERSION, automationVersionAppIds, remapAutomationVersion,
  type AutomationPackage, type AutomationResolvers,
} from './automation-package';
import { cycleFindings } from './automation';
import type { FieldDefinition } from '@suzubase/shared-types';
import { AuthorizationService } from './authorization';
import { assignAutoNumber, numberScope } from './auto-number';
import { projectSearchValues } from './search-projection';
import { uniqueKey } from './schema-preflight';
import { attachmentKey, localAttachmentStorage } from './storage';

export interface AutomationImportState {
  createdRules: any[];
  unresolved: any[];
  credentialsPending: any[];
  grantRequirements: any[];
  cycleFindings: any[];
}
export function emptyAutomationState(): AutomationImportState {
  return { createdRules: [], unresolved: [], credentialsPending: [], grantRequirements: [], cycleFindings: [] };
}

interface ExecState {
  map: IdMap;
  droppedAcl: any[];
  droppedAssignees: any[];
  disabledDependencies: any[];
  pendingDependencies: any[];
  automation: AutomationImportState;
}

@Injectable()
export class ImportExecutionService {
  private readonly storage = localAttachmentStorage();
  constructor(
    private readonly schema: AppSchemaService,
    private readonly authorization: AuthorizationService,
    private readonly imports: ImportService,
  ) {}

  // ----- G3-07 validation -------------------------------------------------
  async validate(context: TenantContext, jobId: string) {
    const job = await withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
      return this.imports.jobRow(tx, context, jobId);
    });
    if (job.status !== 'uploaded') throw new BadRequestException('Only an uploaded job can be validated');
    if (job.duplicateOf && !job.duplicateConfirmed) {
      throw new BadRequestException(
        'This package duplicates an earlier import. Confirm explicitly that a second copy should be created before validating.');
    }
    await withTenantTransaction(context, (tx) => tx.update(importJobs)
      .set({ status: 'validating', stage: 'validating', updatedAt: sql`clock_timestamp()` })
      .where(eq(importJobs.id, jobId)));
    const archive = await readFile(importPackagePath(context.tenantId, jobId)).catch(() => {
      throw new BadRequestException('Uploaded package file is missing');
    });
    let pkg: PkgPackage;
    try {
      pkg = readPackage(archive);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.failValidation(context, job, [{ object: 'package', message }], []);
    }
    const { errors, missingReferences } = preflightPackage(pkg, archive);
    if (errors.length) return this.failValidation(context, job, errors, missingReferences);
    const [saved] = await withTenantTransaction(context, (tx) => tx.update(importJobs).set({
      status: 'staging', stage: 'validated',
      pending: { ...job.pending, preflight: { missingReferences, checkedAt: new Date().toISOString() } },
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(importJobs.id, jobId)).returning());
    return jobView(saved);
  }

  private async failValidation(context: TenantContext, job: JobRow, errors: PreflightIssue[],
    missingReferences: PreflightIssue[]) {
    const [saved] = await withTenantTransaction(context, (tx) => tx.update(importJobs).set({
      status: 'failed', stage: 'validating',
      error: `Preflight failed with ${errors.length} unfixable problem(s)`,
      errorReport: { generatedAt: new Date().toISOString(), errors, missingReferences },
      updatedAt: sql`clock_timestamp()`,
    }).where(eq(importJobs.id, job.id)).returning());
    return jobView(saved);
  }

  async resume(context: TenantContext, jobId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
      const job = await this.imports.jobRow(tx, context, jobId);
      if (job.status !== 'staging' || job.stage !== 'writing') {
        throw new BadRequestException('Only an interrupted staging run can be resumed');
      }
      const [saved] = await tx.update(importJobs).set({ stage: 'validated', updatedAt: sql`clock_timestamp()` })
        .where(eq(importJobs.id, jobId)).returning();
      return jobView(saved);
    });
  }

  // ----- field definition remapping ---------------------------------------
  remapReferenceConfigPublic(config: any, kind: 'lookup' | 'related', sourceFieldId: string,
    pkg: PkgPackage, job: JobRow, state: ExecState) {
    return this.remapReferenceConfig(config, kind, sourceFieldId, pkg, job, state);
  }

  private remapReferenceConfig(config: any, kind: 'lookup' | 'related', sourceFieldId: string,
    pkg: PkgPackage, job: JobRow, state: ExecState) {
    if (!config) return null;
    const fieldMap = state.map;
    const decision = (job.dependencyDecisions[sourceFieldId] ?? null) as DependencyDecision | null;
    const presentation = (target: (sourceId: string) => string) => ({
      ...(config.displayFieldIds && {
        displayFieldIds: config.displayFieldIds.map((id: string) => target(id)),
      }),
      ...(config.conditions && {
        conditions: config.conditions.map((condition: any) => ({ ...condition, fieldId: target(condition.fieldId) })),
      }),
      ...(config.sort && { sort: { ...config.sort, fieldId: target(config.sort.fieldId) } }),
    });
    if (config.appId === pkg.app.id) {
      const own = (id: string) => fieldMap.get('field', id) ?? id;
      return {
        ...config, appId: state.map.get('app', pkg.app.id)!,
        ...(kind === 'lookup' ? {
          keyFieldId: own(config.keyFieldId), localKeyFieldId: own(config.localKeyFieldId),
          copies: config.copies.map((copy: any) => ({
            sourceFieldId: own(copy.sourceFieldId), targetFieldId: own(copy.targetFieldId),
          })),
          ...presentation(own),
        } : {
          localFieldId: own(config.localFieldId), matchFieldId: own(config.matchFieldId),
          ...presentation(own),
        }),
      };
    }
    // Cross-application dependency (G3-08): never silently re-pointed.
    const relation = pkg.config.relations.find((entry) => entry.fieldId === sourceFieldId && entry.kind === kind);
    const sourceAppCode = relation?.target?.appCode ?? config.appId;
    if (decision?.action === 'disable') {
      state.disabledDependencies.push({ fieldId: sourceFieldId, kind, sourceAppId: config.appId, sourceAppCode });
      return null;
    }
    if (decision?.action === 'map' && decision.targetAppId) {
      const foreign = (id: string) => decision.fieldMappings?.[id] ?? id;
      const own = (id: string) => fieldMap.get('field', id) ?? id;
      return {
        ...config, appId: decision.targetAppId,
        ...(kind === 'lookup' ? {
          keyFieldId: foreign(config.keyFieldId), localKeyFieldId: own(config.localKeyFieldId),
          copies: config.copies.map((copy: any) => ({
            sourceFieldId: foreign(copy.sourceFieldId), targetFieldId: own(copy.targetFieldId),
          })),
          ...presentation(foreign),
        } : {
          localFieldId: own(config.localFieldId), matchFieldId: foreign(config.matchFieldId),
          ...presentation(foreign),
        }),
      };
    }
    state.pendingDependencies.push({ fieldId: sourceFieldId, kind, sourceAppId: config.appId, sourceAppCode });
    return null;
  }

  private remapFieldDef(field: any, pkg: PkgPackage, job: JobRow, state: ExecState): any {
    const fieldMap = state.map;
    const remapped: any = {
      ...field,
      fieldId: fieldMap.assign('field', field.fieldId),
      formula: field.formula
        ? field.formula.map((token: any) => token.kind === 'field'
          ? { ...token, fieldId: fieldMap.get('field', token.fieldId) ?? token.fieldId } : token)
        : field.formula,
      autoNumber: field.autoNumber ? {
        ...field.autoNumber,
        scopeFieldId: field.autoNumber.scopeFieldId
          ? fieldMap.get('field', field.autoNumber.scopeFieldId) ?? field.autoNumber.scopeFieldId : null,
      } : field.autoNumber,
      lookup: this.remapReferenceConfig(field.lookup, 'lookup', field.fieldId, pkg, job, state),
      related: this.remapReferenceConfig(field.related, 'related', field.fieldId, pkg, job, state),
      table: field.table ? {
        ...field.table,
        fields: field.table.fields.map((child: any) => ({
          ...child,
          fieldId: fieldMap.assign('tableField', child.fieldId),
          formula: child.formula
            ? child.formula.map((token: any) => token.kind === 'field'
              ? { ...token, fieldId: fieldMap.get('tableField', token.fieldId) ?? token.fieldId } : token)
            : child.formula,
        })),
      } : field.table,
    };
    return remapped;
  }

  private remapLayout(layout: any[], fieldMap: IdMap) {
    return (layout ?? []).map((row) => ({
      ...row,
      ...(row.groupFieldId && { groupFieldId: fieldMap.get('field', row.groupFieldId) ?? row.groupFieldId }),
      cells: (row.cells ?? []).map((cell: any) => ({
        ...cell, fieldId: fieldMap.get('field', cell.fieldId) ?? cell.fieldId,
      })),
    }));
  }

  private remapViews(configuration: any, fieldMap: IdMap) {
    if (!configuration) return configuration;
    return {
      ...configuration,
      views: (configuration.views ?? []).map((view: any) => ({
        ...view,
        columns: (view.columns ?? []).map((column: any) => ({
          ...column, fieldId: fieldMap.get('field', column.fieldId) ?? column.fieldId,
        })),
        conditions: remapConditions(view.conditions, fieldMap),
        ...(view.sort && { sort: { ...view.sort, fieldId: fieldMap.get('field', view.sort.fieldId) ?? view.sort.fieldId } }),
        ...(view.pastDateFieldId && {
          pastDateFieldId: fieldMap.get('field', view.pastDateFieldId) ?? view.pastDateFieldId,
        }),
        ...(view.aggregateFields && {
          aggregateFields: view.aggregateFields.map((id: string) => fieldMap.get('field', id) ?? id),
        }),
      })),
    };
  }

  private remapNotificationRules(rules: any[], job: JobRow, state: ExecState) {
    // Imported notification rules are ALWAYS disabled (contracts 4 SS4.2.10):
    // an administrator re-enables them manually after checking recipients.
    return (rules ?? []).map((rule) => ({
      ...rule,
      enabled: false,
      conditions: remapConditions(rule.conditions, state.map),
      recipients: (rule.recipients ?? []).flatMap((recipient: any) => {
        if ('id' in recipient && recipient.id) {
          if (recipient.kind === 'user-field') {
            const fieldId = state.map.get('field', recipient.id);
            return fieldId ? [{ ...recipient, id: fieldId }] : [];
          }
          const mapped = mappedSubject(recipient, job, state.map);
          return mapped ? [mapped] : [];
        }
        return [recipient];
      }),
      title: rule.title, body: rule.body,
    }));
  }

  // ----- staging batches ----------------------------------------------------
  private async saveMap(tx: TenantTransaction, job: JobRow, state: ExecState, extra: Partial<JobRow> = {}) {
    await tx.update(importJobs).set({
      entityMapping: state.map.rows, targetAppId: state.map.get('app', job.sourceAppId ?? '') ?? job.targetAppId,
      updatedAt: sql`clock_timestamp()`, ...extra,
    }).where(eq(importJobs.id, job.id));
  }

  async batchStructure(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState) {
    const { tenantId } = ctx;
    // Assign every structural id up front so cross-references inside version
    // snapshots resolve within this same transaction.
    for (const field of pkg.rawFields) state.map.assign('field', field.fieldId);
    for (const field of pkg.rawFields) {
      for (const child of field.table?.fields ?? []) state.map.assign('tableField', child.fieldId);
    }
    // P4-T1: category node ids are remapped like every other object type
    // (source_id_map object type 'category'); the same source node keeps
    // one target id across all schema versions in the package.
    for (const version of pkg.versions) {
      for (const node of version.categories?.nodes ?? []) state.map.assign('category', node.id);
    }
    for (const definition of pkg.workflows) {
      state.map.assign('workflow', definition.id);
      for (const wfState of definition.states) state.map.assign('workflowState', wfState.id);
      for (const action of definition.actions) state.map.assign('workflowAction', action.id);
    }
    let targetAppId = state.map.get('app', pkg.app.id);
    if (!targetAppId) {
      const existing = await tx.select({ code: apps.code }).from(apps).where(eq(apps.tenantId, tenantId));
      const taken = new Set(existing.map(({ code }) => code));
      let code = pkg.app.code;
      if (taken.has(code)) code = `${code.slice(0, 50)}-${job.id.slice(0, 8)}`;
      const [app] = await tx.insert(apps).values({
        tenantId, code, name: pkg.app.name, description: pkg.app.description ?? '', icon: pkg.app.icon,
        themeColor: pkg.app.themeColor, titleFieldId: null, duplicateHint: pkg.app.duplicateHint,
        numericPrecision: pkg.app.numericPrecision, attachmentMaxBytes: pkg.app.attachmentMaxBytes,
        attachmentMaxCount: pkg.app.attachmentMaxCount, attachmentTypes: pkg.app.attachmentTypes,
        localDrafts: pkg.app.localDrafts, commentsEnabled: pkg.app.commentsEnabled,
        workflowEnabled: pkg.app.workflowEnabled, adminMemo: pkg.app.adminMemo ?? '',
        publishedSchemaVersion: pkg.app.publishedSchemaVersion,
        draftSchemaVersion: pkg.app.draftSchemaVersion,
        draftStatus: pkg.app.draftSchemaVersion ? 'editing' : null,
        createdBy: ctx.userId, activationState: 'import-pending',
      }).returning();
      targetAppId = app.id;
      state.map.set('app', pkg.app.id, targetAppId);
      await tx.insert(appCounters).values({ tenantId, appId: targetAppId });
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'application', objectId: targetAppId,
        fieldSurface: ['metadata', 'activationState'],
      });
    }
    const identity = { tenantId, appId: targetAppId };
    const existingVersions = await tx.select({ version: appVersions.version }).from(appVersions)
      .where(and(eq(appVersions.tenantId, tenantId), eq(appVersions.appId, targetAppId)));
    const haveVersions = new Set(existingVersions.map(({ version }) => version));
    for (const version of [...pkg.versions].sort((a, b) => a.version - b.version)) {
      if (haveVersions.has(version.version)) continue;
      const fieldEdits: Record<string, unknown> = {};
      for (const field of version.fields) {
        fieldEdits[state.map.get('field', field.fieldId)!] = this.remapFieldDef(field, pkg, job, state);
      }
      for (const [sourceId, edited] of Object.entries(version.fieldEdits ?? {})) {
        if (edited === null) fieldEdits[state.map.assign('field', sourceId)] = null;
      }
      await tx.insert(appVersions).values({
        ...identity, version: version.version,
        aclConfiguration: remapAcl(version.aclConfiguration, job, state.map, state.droppedAcl),
        fieldEdits: fieldEdits as any, formLayout: this.remapLayout(version.formLayout, state.map) ?? [],
        notificationRules: this.remapNotificationRules(version.notificationRules, job, state),
        viewConfiguration: this.remapViews(version.viewConfiguration, state.map) ?? { views: [], defaultId: null },
        categoryConfiguration: version.categories ? {
          enabled: version.categories.enabled,
          nodes: version.categories.nodes.map((node) => ({
            id: state.map.get('category', node.id)!, name: node.name, sortOrder: node.sortOrder,
            parentId: node.parentId ? state.map.get('category', node.parentId)! : null,
          })),
        } : undefined,
        migrationReport: version.migrationReport as any,
      });
    }
    const existingFields = await tx.select({ fieldId: fieldRows.fieldId }).from(fieldRows)
      .where(and(eq(fieldRows.tenantId, tenantId), eq(fieldRows.appId, targetAppId)));
    const haveFields = new Set(existingFields.map(({ fieldId }) => fieldId));
    for (const raw of pkg.rawFields) {
      const targetId = state.map.get('field', raw.fieldId)!;
      if (haveFields.has(targetId)) continue;
      const def = this.remapFieldDef(raw, pkg, job, state);
      await tx.insert(fieldRows).values({
        ...identity, fieldId: targetId, introducedIn: raw.introducedIn, code: raw.code, name: raw.name,
        type: raw.type as any, required: raw.required, uniqueValue: raw.uniqueValue,
        searchMode: raw.searchMode as any, formula: def.formula, lookup: def.lookup, table: def.table,
        related: def.related, layoutElement: raw.layoutElement as any, autoNumber: def.autoNumber,
        options: raw.options as any,
      });
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'field', objectId: targetId, fieldSurface: ['definition'],
      });
    }
    if (pkg.app.titleFieldId) {
      const titleFieldId = state.map.get('field', pkg.app.titleFieldId);
      if (titleFieldId) {
        await tx.update(apps).set({ titleFieldId }).where(and(
          eq(apps.tenantId, tenantId), eq(apps.id, targetAppId)));
      }
    }
    const existingWorkflows = await tx.select({ id: workflowDefinitions.id }).from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.appId, targetAppId)));
    const haveWorkflows = new Set(existingWorkflows.map(({ id }) => id));
    for (const definition of pkg.workflows) {
      const targetId = state.map.get('workflow', definition.id)!;
      if (haveWorkflows.has(targetId)) continue;
      // RLS only allows inserting a DRAFT definition; the graph rows may be
      // inserted while it is a draft, and publishing is an UPDATE (the same
      // lifecycle the workflow service itself uses).
      await tx.insert(workflowDefinitions).values({
        ...identity, id: targetId, version: definition.version, status: 'draft',
      });
      const wfIdentity = { ...identity, workflowId: targetId };
      if (definition.states.length) {
        await tx.insert(workflowStates).values(definition.states.map((wfState: any) => ({
          ...wfIdentity, id: state.map.get('workflowState', wfState.id)!, code: wfState.code,
          name: wfState.name, terminal: wfState.terminal, initial: wfState.initial,
          assignees: remapAssignees(wfState.assignees, job, state.map, state.droppedAssignees),
        })));
      }
      if (definition.actions.length) {
        await tx.insert(workflowActions).values(definition.actions.map((action: any) => ({
          ...wfIdentity, id: state.map.get('workflowAction', action.id)!, name: action.name,
          fromStateId: state.map.get('workflowState', action.fromStateId)!,
          toStateId: state.map.get('workflowState', action.toStateId)!,
          conditions: remapConditions(action.conditions, state.map),
          assignees: remapAssignees(action.assignees, job, state.map, state.droppedAssignees),
        })));
      }
      if (definition.status === 'published') {
        await tx.update(workflowDefinitions).set({ status: 'published' }).where(and(
          eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.appId, targetAppId),
          eq(workflowDefinitions.id, targetId)));
      }
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'workflow', objectId: targetId, fieldSurface: ['definition'],
      });
    }
    await this.saveMap(tx, job, state);
    return targetAppId;
  }

  async batchFiles(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState, targetAppId: string) {
    const { tenantId } = ctx;
    const identity = { tenantId, appId: targetAppId };
    for (const meta of pkg.filesMeta) {
      if (state.map.get('attachment', meta.id)) continue;
      const body = pkg.attachmentBodies.get(`attachments/${meta.id}/v${meta.version}/body`);
      if (!body) throw new Error(`Attachment body missing from package for ${meta.id}`);
      if (createHash('sha256').update(body).digest('hex') !== meta.sha256) {
        throw new Error(`Attachment hash mismatch for ${meta.id}`);
      }
      const targetId = randomUUID();
      await this.storage.put(attachmentKey(tenantId, targetAppId, targetId), body);
      await tx.insert(files).values({
        ...identity, id: targetId, uploadedBy: job.userMapping[meta.uploadedBy] ?? ctx.userId,
        name: meta.name, contentType: meta.contentType, bytes: meta.bytes, sha256: meta.sha256,
        state: meta.state as any, referenceCount: 0, createdAt: meta.createdAt, deletedAt: meta.deletedAt,
      });
      state.map.set('attachment', meta.id, targetId);
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'attachment', objectId: targetId,
        fieldSurface: ['body', 'metadata', 'uploadedBy', 'createdAt'],
      });
    }
    await this.saveMap(tx, job, state);
  }

  private remapRecordData(data: Record<string, string>, pkg: PkgPackage, job: JobRow,
    state: ExecState, targetFields: FieldDefinition[]) {
    const byTargetId = new Map(targetFields.map((field) => [field.fieldId, field]));
    const result: Record<string, string> = {};
    for (const [sourceFieldId, value] of Object.entries(data)) {
      const targetFieldId = state.map.get('field', sourceFieldId);
      if (!targetFieldId) continue;
      const field = byTargetId.get(targetFieldId);
      if (!field) { result[targetFieldId] = value; continue; }
      if (field.type === 'attachment') {
        try {
          const ids = JSON.parse(value || '[]') as string[];
          result[targetFieldId] = JSON.stringify(ids
            .map((id) => state.map.get('attachment', id)).filter((id): id is string => Boolean(id)));
        } catch { result[targetFieldId] = '[]'; }
      } else if (field.type === 'user') {
        result[targetFieldId] = job.userMapping[value] ?? value;
      } else if (field.type === 'organization') {
        result[targetFieldId] = job.organizationMapping[value] ?? value;
      } else if (field.type === 'group') {
        result[targetFieldId] = job.groupMapping[value] ?? value;
      } else {
        result[targetFieldId] = value;
      }
    }
    return result;
  }

  async batchRecords(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState, targetAppId: string) {
    const { tenantId } = ctx;
    const identity = { tenantId, appId: targetAppId };
    const targetFields = await this.schema.getFields(tx, ctx, targetAppId, pkg.app.publishedSchemaVersion);
    const directoryNames = new Map(pkg.directory.users.map((user) => [
      user.id, user.displayName ?? user.loginName ?? user.email,
    ]));
    const rowsByRecord = new Map<string, typeof pkg.tableRows>();
    for (const row of pkg.tableRows) {
      rowsByRecord.set(row.recordId, [...(rowsByRecord.get(row.recordId) ?? []), row]);
    }
    for (const source of pkg.records) {
      if (state.map.get('record', source.id)) continue;
      const targetId = randomUUID();
      const data = this.remapRecordData(source.data, pkg, job, state, targetFields);
      const archivedData: Record<string, string> = {};
      for (const [sourceFieldId, value] of Object.entries(source.archivedData)) {
        const targetFieldId = state.map.get('field', sourceFieldId);
        if (targetFieldId) archivedData[targetFieldId] = value;
      }
      // Decision 8: F27 auto numbers are preserved verbatim; the counter is
      // advanced past every imported number by assignAutoNumber itself.
      for (const field of targetFields) {
        if (!field.autoNumber || !data[field.fieldId]) continue;
        const scope = field.autoNumber.scopeFieldId ? (data[field.autoNumber.scopeFieldId] ?? '') : '';
        await assignAutoNumber(tx, ctx, targetAppId, field.fieldId, field.autoNumber, scope, data[field.fieldId]);
      }
      const [counter] = await tx.update(appCounters)
        .set({ lastValue: sql`${appCounters.lastValue} + 1` })
        .where(and(eq(appCounters.tenantId, tenantId), eq(appCounters.appId, targetAppId)))
        .returning({ recordNo: appCounters.lastValue });
      // Migration channel writes (G3-06): status, creator/updater and their
      // timestamps are written verbatim from the package. The daily API
      // rejects every one of these surfaces (see the G3-06 tests).
      const [row] = await tx.insert(records).values({
        ...identity, id: targetId, recordNo: counter.recordNo, data, archivedData,
        schemaVersion: source.schemaVersion, revision: source.revision, status: source.status,
        createdBy: job.userMapping[source.createdBy] ?? ctx.userId, createdAt: source.createdAt,
        updatedBy: job.userMapping[source.updatedBy] ?? ctx.userId, updatedAt: source.updatedAt,
        deletedBy: source.deletedBy ? (job.userMapping[source.deletedBy] ?? ctx.userId) : null,
        deletedAt: source.deletedAt,
        importJobId: job.id, sourceActorId: source.createdBy,
        sourceActorName: directoryNames.get(source.createdBy) ?? null,
        sourceTimestamp: source.createdAt, sourceRecordNo: source.recordNo,
      }).returning();
      state.map.set('record', source.id, targetId);
      const response = {
        id: row.id, appId: targetAppId, recordNo: row.recordNo.toString(), data: row.data,
        schemaVersion: row.schemaVersion, revision: row.revision, status: row.status,
        createdBy: row.createdBy, createdAt: row.createdAt, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
      };
      await projectSearchValues(tx, ctx, response as any, targetFields);
      if (!source.deletedAt) {
        for (const field of targetFields) {
          const value = data[field.fieldId];
          if (!field.uniqueValue || !value) continue;
          const [inserted] = await tx.insert(recordUniqueValues).values({
            ...identity, fieldId: field.fieldId, normalizedValue: uniqueKey(value), recordId: targetId,
          }).onConflictDoNothing().returning({ recordId: recordUniqueValues.recordId });
          if (!inserted) throw new Error(`Unique value collision on import for field ${field.code}`);
        }
      }
      for (const tableRow of rowsByRecord.get(source.id) ?? []) {
        const targetFieldId = state.map.get('field', tableRow.fieldId);
        if (!targetFieldId) continue;
        const targetTable = targetFields.find(({ fieldId }) => fieldId === targetFieldId)?.table;
        const rowData: Record<string, string> = {};
        for (const [childId, value] of Object.entries(tableRow.data)) {
          const targetChildId = state.map.get('tableField', childId);
          if (!targetChildId) continue;
          // P4-T2: attachment child values hold source file ids and are
          // remapped like record-level attachment values.
          if (targetTable?.fields.some(({ fieldId, type }) => fieldId === targetChildId && type === 'attachment')) {
            try {
              const ids = JSON.parse(value || '[]') as string[];
              rowData[targetChildId] = JSON.stringify(ids
                .map((id) => state.map.get('attachment', id)).filter((id): id is string => Boolean(id)));
            } catch { rowData[targetChildId] = '[]'; }
          } else {
            rowData[targetChildId] = value;
          }
        }
        const targetRowId = randomUUID();
        await tx.insert(recordTableRows).values({
          ...identity, recordId: targetId, fieldId: targetFieldId, rowId: targetRowId,
          rowOrder: tableRow.rowOrder, data: rowData,
        });
        state.map.set('tableRow', tableRow.rowId, targetRowId);
        // P4-T2: subtable attachment references for the restored row.
        for (const child of targetTable?.fields ?? []) {
          if (child.type !== 'attachment') continue;
          const ids = JSON.parse(rowData[child.fieldId] || '[]') as string[];
          for (const fileId of ids) {
            await tx.insert(tableFileReferences).values({
              ...identity, recordId: targetId, fieldId: targetFieldId, rowId: targetRowId,
              subFieldId: child.fieldId, fileId,
            }).onConflictDoNothing();
          }
        }
      }
      // P4-T1: record category assignments (additive records.json key;
      // source node ids resolve through the same id map as the tree).
      for (const sourceCategoryId of source.categoryIds ?? []) {
        const targetCategoryId = state.map.get('category', sourceCategoryId);
        if (targetCategoryId) {
          await tx.insert(recordCategories).values({
            ...identity, recordId: targetId, categoryId: targetCategoryId,
          }).onConflictDoNothing();
        }
      }
      // Attachment references + reference counts (files become ATTACHED).
      for (const field of targetFields) {
        if (field.type !== 'attachment') continue;
        const ids = JSON.parse(data[field.fieldId] || '[]') as string[];
        for (const fileId of ids) {
          await tx.insert(fileReferences).values({
            ...identity, recordId: targetId, fieldId: field.fieldId, fileId,
          }).onConflictDoNothing();
        }
      }
      if (source.workflow) {
        const workflowId = state.map.get('workflow', source.workflow.workflowId);
        const stateId = state.map.get('workflowState', source.workflow.stateId);
        if (workflowId && stateId) {
          await tx.insert(recordWorkflowState).values({
            ...identity, recordId: targetId, workflowId, workflowVersion: source.workflow.workflowVersion,
            stateId, revision: source.revision,
          });
          for (const assignee of source.workflow.assignees) {
            const mapped = job.userMapping[assignee];
            if (!mapped) continue; // pending-completion (decision 5), never the operator
            await tx.insert(workflowAssignments).values({
              ...identity, recordId: targetId, userId: mapped, role: 'migration', active: true,
            }).onConflictDoNothing();
          }
        }
      }
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'record', objectId: targetId,
        fieldSurface: ['status', 'assignees', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'data'],
      });
    }
    // Recompute attachment reference counts from the restored references
    // (record-level and subtable references count as one system, P4-T2).
    await tx.execute(sql`
      UPDATE files f SET reference_count = (
        (SELECT count(*)::int FROM file_references r
          WHERE r.tenant_id = f.tenant_id AND r.app_id = f.app_id AND r.file_id = f.id)
        + (SELECT count(*)::int FROM table_file_references r
          WHERE r.tenant_id = f.tenant_id AND r.app_id = f.app_id AND r.file_id = f.id)
      ), state = CASE WHEN EXISTS (
        SELECT 1 FROM file_references r
        WHERE r.tenant_id = f.tenant_id AND r.app_id = f.app_id AND r.file_id = f.id
      ) OR EXISTS (
        SELECT 1 FROM table_file_references r
        WHERE r.tenant_id = f.tenant_id AND r.app_id = f.app_id AND r.file_id = f.id
      ) THEN 'ATTACHED' ELSE f.state END
      WHERE f.tenant_id = ${tenantId} AND f.app_id = ${targetAppId}`);
    // Decision 8: advance every auto-number counter at least to the source
    // counter position so post-import numbers can never collide.
    for (const counterRow of pkg.autoNumberCounters) {
      const targetFieldId = state.map.get('field', counterRow.fieldId);
      if (!targetFieldId) continue;
      await tx.insert(autoNumberCounters).values({
        ...identity, fieldId: targetFieldId, scope: counterRow.scope, nextValue: BigInt(counterRow.nextValue),
      }).onConflictDoUpdate({
        target: [autoNumberCounters.tenantId, autoNumberCounters.appId, autoNumberCounters.fieldId, autoNumberCounters.scope],
        set: { nextValue: sql`GREATEST(${autoNumberCounters.nextValue}, ${BigInt(counterRow.nextValue)})` },
      });
    }
    await this.saveMap(tx, job, state);
  }

  async batchComments(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState, targetAppId: string) {
    const { tenantId } = ctx;
    const identity = { tenantId, appId: targetAppId };
    const directoryNames = new Map(pkg.directory.users.map((user) => [
      user.id, user.displayName ?? user.loginName ?? user.email,
    ]));
    for (const comment of pkg.comments) {
      if (state.map.get('comment', comment.id)) continue;
      const recordId = state.map.get('record', comment.recordId);
      if (!recordId) continue;
      const targetId = randomUUID();
      await tx.insert(recordComments).values({
        ...identity, recordId, id: targetId,
        authorId: job.userMapping[comment.authorId] ?? ctx.userId,
        // Deleted comments keep only their deletion trace (Gate 2 rule): the
        // package carries no body for them and none is restored.
        body: comment.deleted ? '' : (comment.body ?? ''),
        createdAt: comment.createdAt, deletedAt: comment.deletedAt,
        importJobId: job.id, sourceActorId: comment.authorId,
        sourceActorName: directoryNames.get(comment.authorId) ?? null,
        sourceTimestamp: comment.createdAt,
      });
      state.map.set('comment', comment.id, targetId);
      for (const mention of comment.mentions) {
        const mapped = job.userMapping[mention.userId];
        if (!mapped) continue;
        await tx.insert(commentMentions).values({
          ...identity, recordId, commentId: targetId, userId: mapped,
          offset: mention.offset, length: mention.length,
        }).onConflictDoNothing();
      }
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'comment', objectId: targetId,
        fieldSurface: ['authorId', 'createdAt', 'body'],
      });
    }
    await this.saveMap(tx, job, state);
  }

  async batchHistory(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState, targetAppId: string) {
    const { tenantId } = ctx;
    const identity = { tenantId, appId: targetAppId };
    const workflowEventById = new Map(pkg.workflowEvents.map((event) => [event.eventId, event]));
    for (const event of pkg.recordEvents) {
      if (state.map.get('historyEvent', event.eventId)) continue;
      const recordId = state.map.get('record', event.recordId);
      if (!recordId) continue;
      const targetEventId = randomUUID();
      const changes = (event.changes ?? []).map((change: any) => ({
        ...change,
        fieldId: state.map.get('field', change.fieldId) ?? change.fieldId,
        ...(change.childFieldId && {
          childFieldId: state.map.get('tableField', change.childFieldId) ?? change.childFieldId,
        }),
        ...(change.rowId && { rowId: state.map.get('tableRow', change.rowId) ?? change.rowId }),
      }));
      // G3-04: an event that is already migration-sourced keeps its original
      // chain verbatim; a local source event gains this job's chain. Either
      // way the restored event is marked source='migration', never laundered
      // into a local event.
      const [inserted] = await tx.insert(recordEvents).values({
        ...identity, eventId: targetEventId, recordId, recordRevision: event.recordRevision,
        schemaVersion: event.schemaVersion,
        actorId: job.userMapping[event.actorId] ?? ctx.userId,
        source: 'migration', kind: event.kind, objectType: event.objectType,
        objectId: event.objectType === 'comment' && event.objectId
          ? (state.map.get('comment', event.objectId) ?? null) : event.objectId,
        occurredAt: event.occurredAt, changes,
        importJobId: event.importJobId ?? job.id,
        sourceActorId: event.sourceActorId ?? event.actorId,
        sourceTimestamp: event.sourceTimestamp ?? event.occurredAt,
      }).returning({ eventId: recordEvents.eventId });
      state.map.set('historyEvent', event.eventId, targetEventId);
      const workflowEvent = workflowEventById.get(event.eventId);
      if (workflowEvent) {
        const workflowId = state.map.get('workflow', workflowEvent.workflowId);
        const toStateId = state.map.get('workflowState', workflowEvent.toStateId);
        if (workflowId && toStateId) {
          await tx.insert(workflowEvents).values({
            ...identity, eventId: inserted.eventId, workflowId,
            actionId: workflowEvent.actionId
              ? (state.map.get('workflowAction', workflowEvent.actionId) ?? null) : null,
            fromStateId: workflowEvent.fromStateId
              ? (state.map.get('workflowState', workflowEvent.fromStateId) ?? null) : null,
            toStateId, reason: workflowEvent.reason,
            assigneeIds: (workflowEvent.assigneeIds ?? []).map(
              (id: string) => job.userMapping[id] ?? id),
          });
        }
      }
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'history-event', objectId: targetEventId,
        fieldSurface: ['occurredAt', 'actorId', 'source'],
      });
    }
    await this.saveMap(tx, job, state);
  }

  async batchReferences(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState, targetAppId: string) {
    const { tenantId } = ctx;
    const identity = { tenantId, appId: targetAppId };
    for (const reference of pkg.references) {
      const recordId = state.map.get('record', reference.recordId);
      const fieldId = state.map.get('field', reference.fieldId);
      if (!recordId || !fieldId) continue;
      let target: { appId: string; recordId: string } | null = null;
      if (reference.targetAppId === pkg.app.id) {
        const targetRecordId = state.map.get('record', reference.targetRecordId);
        if (targetRecordId) target = { appId: targetAppId, recordId: targetRecordId };
      } else {
        target = await this.resolveCrossAppRecord(tx, job, pkg, reference);
      }
      if (!target) continue;
      await tx.insert(recordReferences).values({
        ...identity, recordId, fieldId, targetAppId: target.appId, targetRecordId: target.recordId,
      }).onConflictDoNothing();
    }
    await this.saveMap(tx, job, state);
  }


  // ----- P3-D wave 2: automation import (brief S7.2/S7.3, V-08) ----------
  // Imported rules are ALWAYS disabled drafts: never enabled, never
  // published-effective, never granted, and importing records never
  // triggers them (the executor writes no outbox rows, so no run, no
  // notification and no webhook delivery can result). Webhook endpoints
  // are recreated as credential placeholders. Schedule rows are NOT
  // copied: cadence/date-relative plans are recomputed by the target
  // environment when a rule is re-published and enabled there.

  /** Resolve an application that an earlier import brought into this
   * tenant, through that job's persisted entity mapping (never a guess). */
  private async resolveImportedApp(tx: TenantTransaction, job: JobRow, sourceAppId: string) {
    const candidates = await tx.select({
      entityMapping: importJobs.entityMapping, targetAppId: importJobs.targetAppId,
    }).from(importJobs).where(and(eq(importJobs.tenantId, job.tenantId),
      eq(importJobs.sourceAppId, sourceAppId),
      sql`${importJobs.status} IN ('ready', 'activated')`, sql`${importJobs.id} <> ${job.id}`));
    for (const candidate of candidates) {
      if (!candidate.targetAppId) continue;
      const fields = new Map<string, string>();
      for (const row of candidate.entityMapping as SourceIdMapRow[]) {
        if (row.objectType === 'field') fields.set(row.sourceId, row.targetId);
      }
      return { targetAppId: candidate.targetAppId, fields };
    }
    return null;
  }

  private async automationResolvers(tx: TenantTransaction, job: JobRow, pkg: PkgPackage,
    state: ExecState, targetAppId: string): Promise<AutomationResolvers> {
    const crossApps = new Map<string, { targetAppId: string; fields: Map<string, string> }>();
    if (pkg.automation) {
      const referenced = new Set<string>();
      for (const rule of pkg.automation.rules) {
        for (const version of rule.versions) {
          for (const id of automationVersionAppIds(version)) {
            if (id !== pkg.app.id) referenced.add(id);
          }
        }
      }
      for (const sourceAppId of referenced) {
        const resolved = await this.resolveImportedApp(tx, job, sourceAppId);
        if (resolved) crossApps.set(sourceAppId, resolved);
      }
    }
    return {
      field: (id) => state.map.get('field', id) ?? null,
      targetField: (appSourceId, fieldId) => appSourceId === pkg.app.id
        ? (state.map.get('field', fieldId) ?? null)
        : (crossApps.get(appSourceId)?.fields.get(fieldId) ?? null),
      app: (id) => id === pkg.app.id ? targetAppId : (crossApps.get(id)?.targetAppId ?? null),
      user: (id) => job.userMapping[id] ?? null,
      group: (id) => job.groupMapping[id] ?? null,
      workflowState: (id) => state.map.get('workflowState', id) ?? null,
      workflowAction: (id) => state.map.get('workflowAction', id) ?? null,
      endpoint: (id) => state.map.get('webhookEndpoint', id) ?? null,
    };
  }

  async batchAutomation(tx: TenantTransaction, ctx: TenantContext, job: JobRow,
    pkg: PkgPackage, state: ExecState, targetAppId: string) {
    if (!pkg.automation) return;
    const { tenantId } = ctx;
    const auto = state.automation;
    const resolvers = await this.automationResolvers(tx, job, pkg, state, targetAppId);

    for (const endpoint of pkg.automation.endpoints) {
      if (state.map.get('webhookEndpoint', endpoint.sourceEndpointId)) continue;
      const targetId = randomUUID();
      await tx.insert(automationWebhookEndpoints).values({
        tenantId, appId: targetAppId, id: targetId, name: endpoint.name, url: endpoint.url,
        policy: endpoint.policy as 'AUTO_RETRY_AT_LEAST_ONCE' | 'MANUAL_ON_UNCERTAIN',
        // Placeholder: the package carries no secret material by design.
        secretEnc: '', credentialPending: true, keyVersion: 1,
        validatedUrlHash: null, validatedAt: null, createdBy: ctx.userId,
      });
      state.map.set('webhookEndpoint', endpoint.sourceEndpointId, targetId);
      auto.credentialsPending.push({
        sourceEndpointId: endpoint.sourceEndpointId, targetEndpointId: targetId,
        name: endpoint.name, url: endpoint.url, action: 'supply-secret',
      });
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'webhook-endpoint', objectId: targetId,
        fieldSurface: ['name', 'url', 'policy', 'credentialPending'],
      });
    }

    const importedConfigs: { appId: string; config: any }[] = [];
    for (const rule of pkg.automation.rules) {
      if (state.map.get('automationRule', rule.sourceRuleId)) continue;
      const targetRuleId = state.map.assign('automationRule', rule.sourceRuleId);
      await tx.insert(automationRules).values({
        tenantId, appId: targetAppId, id: targetRuleId, name: rule.name,
        currentVersion: null, enabled: false,
        archivedAt: rule.archived ? new Date().toISOString() : null, createdBy: ctx.userId,
      });
      const createdVersions: number[] = [];
      for (const version of [...rule.versions].sort((a, b) => a.version - b.version)) {
        const remapped = remapAutomationVersion(version, resolvers, rule.sourceRuleId);
        await tx.insert(automationRuleVersions).values({
          tenantId, appId: targetAppId, ruleId: targetRuleId, version: version.version,
          schemaVersion: version.schemaVersion, sourceSchemaVersion: version.sourceSchemaVersion,
          trigger: remapped.trigger, conditions: remapped.conditions, actions: remapped.actions,
          status: 'draft', createdBy: ctx.userId,
        });
        for (const entry of remapped.unresolved) auto.unresolved.push({ ...entry, targetRuleId });
        if (remapped.grantRequirement) {
          // Requirement only: no automation_grants row is ever written by
          // an import. Re-approval happens in the target through the
          // ordinary grant flow after re-preflight (brief S7.3).
          auto.grantRequirements.push({
            sourceRuleId: rule.sourceRuleId, targetRuleId, version: version.version,
            requirement: remapped.grantRequirement,
          });
        }
        createdVersions.push(version.version);
        importedConfigs.push({ appId: targetAppId, config: {
          schemaVersion: version.schemaVersion, trigger: remapped.trigger,
          conditions: remapped.conditions, actions: remapped.actions,
        } });
      }
      auto.createdRules.push({
        sourceRuleId: rule.sourceRuleId, targetRuleId, name: rule.name,
        versions: createdVersions, enabled: false, status: 'draft',
      });
      await this.imports.audit(tx, ctx, { ...job, targetAppId }, {
        action: 'write', objectType: 'automation-rule', objectId: targetRuleId,
        fieldSurface: ['definition', 'versions', 'enabled=false', 'status=draft'],
      });
    }

    // Static cycle check re-run in the target environment: the imported
    // configs are analysed together with every currently enabled rule's
    // current version in this tenant. BLOCKING findings are recorded as
    // blockers (they also block publish through the ordinary preflight);
    // POTENTIAL findings are warnings.
    const enabledRows = await tx.select({
      appId: automationRules.appId, trigger: automationRuleVersions.trigger,
      conditions: automationRuleVersions.conditions, actions: automationRuleVersions.actions,
    }).from(automationRules).innerJoin(automationRuleVersions, and(
      eq(automationRuleVersions.tenantId, automationRules.tenantId),
      eq(automationRuleVersions.appId, automationRules.appId),
      eq(automationRuleVersions.ruleId, automationRules.id),
      eq(automationRuleVersions.version, automationRules.currentVersion),
    )).where(and(eq(automationRules.tenantId, tenantId), eq(automationRules.enabled, true),
      sql`${automationRules.archivedAt} IS NULL`));
    const cycles = cycleFindings([
      ...enabledRows.map((row) => ({ appId: row.appId, config: {
        schemaVersion: 1, trigger: row.trigger, conditions: row.conditions, actions: row.actions,
      } as any })),
      ...importedConfigs,
    ]);
    auto.cycleFindings = cycles.map((cycle) => ({
      code: cycle.code, severity: cycle.code === 'BLOCKING_CYCLE' ? 'BLOCKING' : 'WARNING',
      apps: cycle.apps,
    }));

    // Persist the automation detail on the job so the finalizer can fold
    // it into the pending-completion list and the difference report with
    // exactly the same shape the dry-run preview produces.
    const mergedPending = {
      ...((job.pending ?? {}) as Record<string, unknown>),
      automationImport: {
        createdRules: auto.createdRules, unresolved: auto.unresolved,
        credentialsPending: auto.credentialsPending,
        grantRequirements: auto.grantRequirements, cycleFindings: auto.cycleFindings,
      },
    };
    await tx.update(importJobs).set({ pending: mergedPending })
      .where(eq(importJobs.id, job.id));
    await this.saveMap(tx, job, state);
  }

  /**
   * Dry-run difference report for the automation section (brief S7.2):
   * previews, against the job's current mappings and this tenant's
   * already-restored applications, what an import would create, which
   * references would stay unresolved, what a human must still supply
   * (webhook secrets, grant re-approval) and the package-internal cycle
   * verdict. Zero writes of any kind.
   */
  async automationDryRun(context: TenantContext, jobId: string) {
    const job = await withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
      return this.imports.jobRow(tx, context, jobId);
    });
    const archive = await readFile(importPackagePath(context.tenantId, jobId)).catch(() => {
      throw new BadRequestException('Uploaded package file is missing');
    });
    const pkg = readPackage(archive);
    if (!pkg.automation) {
      return {
        automation: null,
        willCreate: { rules: 0, ruleVersions: 0, webhookEndpoints: 0 },
        unresolved: [] as any[], manualActions: [] as any[], cycleFindings: [] as any[],
        grantsEffective: false, rulesEnabled: false,
        scheduleHandling: 'Package carries no automation section; nothing to preview.',
      };
    }
    const packageFieldIds = new Set<string>(pkg.rawFields.map((field) => field.fieldId));
    for (const version of pkg.versions) for (const field of version.fields) packageFieldIds.add(field.fieldId);
    const workflowStateIds = new Set(pkg.workflows.flatMap((wf) => wf.states.map((s: any) => s.id)));
    const workflowActionIds = new Set(pkg.workflows.flatMap((wf) => wf.actions.map((a: any) => a.id)));
    const endpointIds = new Set(pkg.automation.endpoints.map((endpoint) => endpoint.sourceEndpointId));
    const crossApps = new Map<string, { targetAppId: string; fields: Map<string, string> }>();
    await withTenantTransaction(context, async (tx) => {
      const referenced = new Set<string>();
      for (const rule of pkg.automation!.rules) {
        for (const version of rule.versions) {
          for (const id of automationVersionAppIds(version)) {
            if (id !== pkg.app.id) referenced.add(id);
          }
        }
      }
      for (const sourceAppId of referenced) {
        const resolved = await this.resolveImportedApp(tx, job, sourceAppId);
        if (resolved) crossApps.set(sourceAppId, resolved);
      }
    });
    const resolvers: AutomationResolvers = {
      field: (id) => packageFieldIds.has(id) ? id : null,
      targetField: (appSourceId, fieldId) => appSourceId === pkg.app.id
        ? (packageFieldIds.has(fieldId) ? fieldId : null)
        : (crossApps.get(appSourceId)?.fields.has(fieldId) ? fieldId : null),
      app: (id) => id === pkg.app.id || crossApps.has(id) ? id : null,
      user: (id) => job.userMapping[id] ?? null,
      group: (id) => job.groupMapping[id] ?? null,
      workflowState: (id) => workflowStateIds.has(id) ? id : null,
      workflowAction: (id) => workflowActionIds.has(id) ? id : null,
      endpoint: (id) => endpointIds.has(id) ? id : null,
    };
    const unresolved: any[] = [];
    const manualActions: any[] = [];
    const configs: { appId: string; config: any }[] = [];
    let ruleVersions = 0;
    for (const rule of pkg.automation.rules) {
      for (const version of rule.versions) {
        ruleVersions += 1;
        const remapped = remapAutomationVersion(version, resolvers, rule.sourceRuleId);
        unresolved.push(...remapped.unresolved);
        if (remapped.grantRequirement) {
          manualActions.push({
            kind: 'grant-reauthorization', sourceRuleId: rule.sourceRuleId,
            version: version.version, requirement: remapped.grantRequirement,
            note: 'Grants never transfer. Re-run preflight and re-approve the grant in the target before the rule can be enabled.',
          });
        }
        configs.push({ appId: pkg.app.id, config: {
          schemaVersion: version.schemaVersion, trigger: version.trigger,
          conditions: version.conditions, actions: version.actions,
        } });
      }
    }
    for (const endpoint of pkg.automation.endpoints) {
      manualActions.push({
        kind: 'webhook-credential', sourceEndpointId: endpoint.sourceEndpointId,
        name: endpoint.name, url: endpoint.url, action: 'supply-secret',
        note: 'The endpoint is imported as a credential placeholder and cannot deliver until a signing secret is supplied.',
      });
    }
    const cycles = cycleFindings(configs).map((cycle) => ({
      code: cycle.code, severity: cycle.code === 'BLOCKING_CYCLE' ? 'BLOCKING' : 'WARNING',
      apps: cycle.apps,
    }));
    return {
      automation: { schemaVersion: pkg.automation.schemaVersion },
      willCreate: {
        rules: pkg.automation.rules.length, ruleVersions,
        webhookEndpoints: pkg.automation.endpoints.length,
        ruleStatus: 'disabled-draft', grantsEffective: false,
      },
      unresolved, manualActions, cycleFindings: cycles,
      grantsEffective: false, rulesEnabled: false,
      scheduleHandling: 'No source schedule rows are copied; cadence and date-relative plans are recomputed by the target environment when a rule is re-published and enabled there.',
    };
  }

  /** A cross-app reference resolves through an earlier import of the target
   * application in this tenant (its source_id_map), never by guessing. */
  private async resolveCrossAppRecord(tx: TenantTransaction, job: JobRow, pkg: PkgPackage,
    reference: PkgPackage['references'][number]) {
    const decision = Object.values(job.dependencyDecisions)
      .find((entry) => (entry as DependencyDecision)?.action === 'map') as DependencyDecision | undefined;
    void decision;
    const candidates = await tx.select({
      entityMapping: importJobs.entityMapping, targetAppId: importJobs.targetAppId,
    }).from(importJobs).where(and(eq(importJobs.tenantId, job.tenantId),
      eq(importJobs.sourceAppCode, reference.targetAppCode ?? ''),
      sql`${importJobs.status} IN ('ready', 'activated')`));
    for (const candidate of candidates) {
      if (!candidate.targetAppId) continue;
      const row = (candidate.entityMapping as SourceIdMapRow[])
        .find((entry) => entry.objectType === 'record' && entry.sourceId === reference.targetRecordId);
      if (row) return { appId: candidate.targetAppId, recordId: row.targetId };
    }
    return null;
  }

}

import {
  apiTokens, exportJobs, issuedAutoNumbers, notifications, outbox, recordCreateKeys,
  recordSearchValues,
} from '@suzubase/db';
import { formulaReferences } from './authorization';

const resolveAssigneesInput = z.strictObject({
  items: z.array(z.strictObject({
    recordId: identifier, sourceUserId: z.string().min(1).max(128), userId: identifier.nullable(),
  })).min(1).max(500),
});
const markReissuedInput = z.strictObject({ name: z.string().min(1).max(120) });


function subjectMatchesDirectory(principal: { userId: string; organizationId: string | null; groups: string[] },
  subject: { kind: string; id: string }) {
  if (subject.kind === 'user') return subject.id === principal.userId;
  if (subject.kind === 'group') return principal.groups.includes(subject.id);
  if (subject.kind === 'organization') return subject.id === principal.organizationId;
  return false;
}

function sourceRecordRuleMatches(
  principal: { userId: string; organizationId: string | null; groups: string[] },
  rule: any, data: Record<string, string>,
) {
  const subject = rule.subject;
  let subjectOk: boolean;
  if (subject.kind === 'user-field') subjectOk = data[subject.id] === principal.userId;
  else if (subject.kind === 'group-field') subjectOk = principal.groups.includes(data[subject.id] ?? '');
  else if (subject.kind === 'organization-field') subjectOk = data[subject.id] === principal.organizationId;
  else subjectOk = subjectMatchesDirectory(principal, subject);
  if (!subjectOk) return false;
  return (rule.conditions ?? []).every((condition: any) => {
    const value = data[condition.fieldId];
    switch (condition.operator) {
      case 'eq': return (value ?? '') === condition.value;
      case 'ne': return (value ?? '') !== condition.value;
      case 'empty': return !value;
      case 'nonempty': return Boolean(value);
      case 'current-user': return value === principal.userId;
      case 'current-user-group': return principal.groups.includes(value ?? '');
      default: return false;
    }
  });
}

@Injectable()
export class ImportFinalizer {
  readonly storage = localAttachmentStorage();
  constructor(
    private readonly schema: AppSchemaService,
    private readonly authorization: AuthorizationService,
    private readonly imports: ImportService,
  ) {}

  /** Derive the pending-completion state from the database + package, so it
   * can be recomputed identically after staging, after every resolution, and
   * again at the activation gate (G3-08). */
  async computePending(tx: TenantTransaction, job: JobRow, pkg: PkgPackage, targetAppId: string) {
    const map = new IdMap(job.entityMapping as SourceIdMapRow[]);
    const previous = (job.pending ?? {}) as any;
    const resolutions: Record<string, string> = previous.assigneeResolutions ?? {};
    const directoryNames = new Map(pkg.directory.users.map((user) => [
      user.id, user.displayName ?? user.loginName ?? user.email,
    ]));
    const assignees: any[] = [];
    for (const record of pkg.records) {
      const targetRecordId = map.get('record', record.id);
      if (!targetRecordId || !record.workflow) continue;
      for (const sourceUserId of record.workflow.assignees) {
        if (job.userMapping[sourceUserId]) continue;
        const key = `${targetRecordId}:${sourceUserId}`;
        assignees.push({
          recordId: targetRecordId, sourceRecordId: record.id, sourceUserId,
          sourceUserName: directoryNames.get(sourceUserId) ?? null,
          resolution: resolutions[key] ?? null,
        });
      }
    }
    const targetFields = await this.schema.getFields(tx, { tenantId: job.tenantId, userId: job.createdBy },
      targetAppId, pkg.app.publishedSchemaVersion);
    const targetBySource = new Map<string, FieldDefinition>();
    for (const field of targetFields) {
      const sourceId = (job.entityMapping as SourceIdMapRow[])
        .find((row) => row.objectType === 'field' && row.targetId === field.fieldId)?.sourceId;
      if (sourceId) targetBySource.set(sourceId, field);
    }
    const foreignFieldIdsOf = (pkgData: PkgPackage, relation: any) => {
      const sourceField = pkgData.rawFields.find((field) => field.fieldId === relation.fieldId);
      const reference: any = relation.kind === 'lookup' ? sourceField?.lookup : sourceField?.related;
      if (!reference) return [];
      return [...new Set([
        ...(reference.keyFieldId ? [reference.keyFieldId] : []),
        ...(reference.matchFieldId ? [reference.matchFieldId] : []),
        ...((reference.copies ?? []).map((copy: any) => copy.sourceFieldId)),
        ...(reference.displayFieldIds ?? []),
        ...((reference.conditions ?? []).map((condition: any) => condition.fieldId)),
        ...(reference.sort?.fieldId ? [reference.sort.fieldId] : []),
      ])];
    };
    const dependencies: any[] = [];
    for (const relation of pkg.config.relations) {
      const decision = (job.dependencyDecisions[relation.fieldId] ?? null) as DependencyDecision | null;
      if (decision?.action === 'disable') continue;
      const targetField = targetBySource.get(relation.fieldId);
      const config = relation.kind === 'lookup' ? targetField?.lookup : targetField?.related;
      if (config) continue;
      dependencies.push({
        fieldId: targetField?.fieldId ?? null, sourceFieldId: relation.fieldId, kind: relation.kind,
        sourceAppId: relation.target.appId, sourceAppCode: relation.target.appCode,
        foreignFieldIds: foreignFieldIdsOf(pkg, relation),
      });
    }
    const references: any[] = [];
    for (const reference of pkg.references) {
      if (reference.targetAppId === pkg.app.id) continue;
      const recordId = map.get('record', reference.recordId);
      const fieldId = map.get('field', reference.fieldId);
      if (!recordId || !fieldId) continue;
      const decision = (job.dependencyDecisions[reference.fieldId] ?? null) as DependencyDecision | null;
      if (decision?.action === 'skip') continue;
      const [row] = await tx.select({ recordId: recordReferences.recordId }).from(recordReferences)
        .where(and(eq(recordReferences.tenantId, job.tenantId), eq(recordReferences.appId, targetAppId),
          eq(recordReferences.recordId, recordId), eq(recordReferences.fieldId, fieldId)));
      if (!row) {
        references.push({
          recordId, fieldId, sourceRecordId: reference.recordId, sourceFieldId: reference.fieldId,
          targetAppId: reference.targetAppId, targetAppCode: reference.targetAppCode,
          targetRecordId: reference.targetRecordId,
        });
      }
    }
    // P3-D wave 2: automation pending. The import batch persisted its
    // detail under pending.automationImport (kept across finalizer
    // rewrites as automation.importState). Unresolved references and
    // BLOCKING cycle findings count toward pending completion; grant
    // re-approvals and webhook credentials are explicit manual follow-ups
    // that do NOT block application activation, because the imported
    // rules are disabled drafts that cannot execute until an
    // administrator re-authorizes them in the target (brief S7.3).
    const storedAutomation = (previous.automationImport ?? previous.automation?.importState ?? null) as any;
    let automationPending: any = null;
    let automationBlockers = 0;
    if (pkg.automation) {
      const stored = storedAutomation ?? {
        createdRules: [], unresolved: [], credentialsPending: [],
        grantRequirements: [], cycleFindings: [],
      };
      const blockingCycles = (stored.cycleFindings ?? [])
        .filter((finding: any) => finding.severity === 'BLOCKING');
      automationBlockers = (stored.unresolved ?? []).length + blockingCycles.length;
      automationPending = {
        importState: stored,
        rules: stored.createdRules ?? [],
        unresolved: stored.unresolved ?? [],
        credentialsPending: stored.credentialsPending ?? [],
        grantRequirements: stored.grantRequirements ?? [],
        cycleFindings: stored.cycleFindings ?? [],
        manualActions: [
          ...(stored.credentialsPending ?? []).map((entry: any) => ({
            kind: 'webhook-credential', ...entry,
          })),
          ...(stored.grantRequirements ?? []).map((entry: any) => ({
            kind: 'grant-reauthorization', ...entry,
          })),
        ],
        scheduleHandling: 'No source schedule rows were copied; cadence and date-relative plans are recomputed by the target environment when a rule is re-published and enabled there.',
      };
    }
    const unmappedUsers = pkg.directory.users
      .filter((user) => !job.userMapping[user.id])
      .map((user) => ({ id: user.id, name: directoryNames.get(user.id) ?? null, email: user.email }));
    const unmappedGroups = pkg.directory.groups
      .filter((group) => !job.groupMapping[group.id])
      .map((group) => ({ id: group.id, name: group.name }));
    const published = pkg.versions.find((version) => version.version === pkg.app.publishedSchemaVersion);
    const droppedAcl: any[] = [];
    if (published) remapAcl(published.aclConfiguration, job, map, droppedAcl);
    const unresolvedAssignees = assignees.filter((entry) => !entry.resolution).length;
    const completion = unresolvedAssignees + dependencies.length + references.length + automationBlockers === 0
      ? 'complete' as const : 'pending' as const;
    return {
      pending: {
        assignees, assigneeResolutions: resolutions, dependencies, references,
        automation: automationPending,
        unmappedUsers, unmappedGroups, droppedAcl,
        disabledDependencies: Object.entries(job.dependencyDecisions)
          .filter(([, decision]) => (decision as DependencyDecision)?.action === 'disable')
          .map(([fieldId]) => ({ fieldId })),
      },
      completion,
    };
  }

  /** G3-09 evidence chain: counts, dependency report, verification results,
   * and the difference report. Generated automatically after staging and
   * regenerated after every resolution; activation is impossible without it. */
  async generateReport(tx: TenantTransaction, ctx: TenantContext, job: JobRow, pkg: PkgPackage,
    targetAppId: string, pending: any) {
    const { tenantId } = ctx;
    const identity = { tenantId, appId: targetAppId };
    const count = async (table: any, where: any) => {
      const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(where);
      return row.n;
    };
    const appScope = and(eq(records.tenantId, tenantId), eq(records.appId, targetAppId));
    const target = {
      apps: 1,
      fields: await count(fieldRows, and(eq(fieldRows.tenantId, tenantId), eq(fieldRows.appId, targetAppId))),
      records: await count(records, appScope),
      tableRows: await count(recordTableRows, and(eq(recordTableRows.tenantId, tenantId),
        eq(recordTableRows.appId, targetAppId))),
      references: await count(recordReferences, and(eq(recordReferences.tenantId, tenantId),
        eq(recordReferences.appId, targetAppId))),
      attachments: await count(files, and(eq(files.tenantId, tenantId), eq(files.appId, targetAppId))),
      comments: await count(recordComments, and(eq(recordComments.tenantId, tenantId),
        eq(recordComments.appId, targetAppId))),
      historyEvents: await count(recordEvents, and(eq(recordEvents.tenantId, tenantId),
        eq(recordEvents.appId, targetAppId))),
      workflowEvents: await count(workflowEvents, and(eq(workflowEvents.tenantId, tenantId),
        eq(workflowEvents.appId, targetAppId))),
      workflowVersions: await count(workflowDefinitions, and(eq(workflowDefinitions.tenantId, tenantId),
        eq(workflowDefinitions.appId, targetAppId))),
    };
    const [publishedRow] = await tx.select().from(appVersions).where(and(
      eq(appVersions.tenantId, tenantId), eq(appVersions.appId, targetAppId),
      eq(appVersions.version, pkg.app.publishedSchemaVersion)));
    const targetAcl = publishedRow.aclConfiguration as any;
    const targetCounts: Record<string, number> = {
      ...target,
      views: (publishedRow.viewConfiguration as any)?.views?.length ?? 0,
      aclEntries: (targetAcl.app?.length ?? 0) + (targetAcl.record?.length ?? 0) + (targetAcl.field?.length ?? 0),
      notificationRules: (publishedRow.notificationRules as any[])?.length ?? 0,
    };
    const source = pkg.manifest.counts.actual as unknown as Record<string, number>;
    const matches: Record<string, boolean> = {};
    for (const key of Object.keys(targetCounts)) matches[key] = targetCounts[key] === source[key];

    // Per-attachment hash verification against the restored bodies.
    const fileRowsRestored = await tx.select().from(files).where(and(
      eq(files.tenantId, tenantId), eq(files.appId, targetAppId)));
    const attachmentFailures: string[] = [];
    for (const file of fileRowsRestored) {
      if (!file.sha256) { attachmentFailures.push(file.id); continue; }
      try {
        await this.storage.read(attachmentKey(tenantId, targetAppId, file.id), file.sha256);
      } catch { attachmentFailures.push(file.id); }
    }
    // Reference integrity recheck on the restored data.
    const missingRefs = await tx.execute(sql`
      SELECT r.record_id AS "recordId", r.field_id AS "fieldId"
      FROM record_references r
      LEFT JOIN records t ON t.tenant_id = r.tenant_id AND t.app_id = r.target_app_id AND t.id = r.target_record_id
      WHERE r.tenant_id = ${tenantId} AND r.app_id = ${targetAppId} AND t.id IS NULL`);
    // Three-layer ACL consistency: the restored ACL is evaluated with the
    // same authorization service used by live queries, for mapped sample
    // users, and the conclusions are compared with the source ACL evaluated
    // under the same conditions.
    const aclCheck = await this.checkAcl(tx, ctx, job, pkg, targetAppId, targetAcl);

    const notInherited: any[] = [];
    if (pending.unmappedUsers.length) {
      notInherited.push({
        item: 'user identities',
        reason: `${pending.unmappedUsers.length} source user(s) have no target mapping. No credential account was created; their authorship is preserved as source identity (source_actor_id / source_actor_name) and their assignee entries follow the pending-completion path.`,
      });
    }
    for (const dropped of pending.droppedAcl) {
      notInherited.push({
        item: `ACL rule (${dropped.layer})`,
        reason: `Subject ${dropped.subject.kind}:${dropped.subject.id} is not mapped; the rule does not take effect (default-deny, never widened).`,
      });
    }
    for (const dependency of pending.disabledDependencies) {
      notInherited.push({
        item: 'cross-application dependency',
        reason: `Dependency of field ${dependency.fieldId} was explicitly disabled by the administrator.`,
      });
    }
    for (const dependency of pending.dependencies) {
      notInherited.push({
        item: 'cross-application dependency',
        reason: `Lookup/related configuration of source field ${dependency.sourceFieldId} points at ${dependency.sourceAppCode ?? dependency.sourceAppId}, which has not been mapped to a target application.`,
      });
    }
    for (const entry of pending.assignees.filter((item: any) => !item.resolution)) {
      notInherited.push({
        item: 'record assignee',
        reason: `Assignee ${entry.sourceUserName ?? entry.sourceUserId} of record ${entry.sourceRecordId} is not mapped and has not been reassigned or explicitly accepted as unassigned.`,
      });
    }
    for (const [name, inclusion] of Object.entries(pkg.manifest.inclusion)) {
      if (inclusion === 'unsupported') {
        notInherited.push({
          item: name,
          reason: 'Not supported by this product version; the source manifest marks it unsupported and it was not migrated.',
        });
      }
    }
    if (pending.automation) {
      for (const entry of pending.automation.unresolved ?? []) {
        notInherited.push({
          item: 'automation reference',
          reason: `Automation rule ${entry.ruleSourceId ?? ''} v${entry.version ?? ''}: ${entry.kind} reference ${entry.sourceId} (${entry.context}) has no target mapping; it stays unresolved on the disabled draft and blocks completion until remapped.`,
        });
      }
      for (const entry of pending.automation.credentialsPending ?? []) {
        notInherited.push({
          item: 'webhook credential',
          reason: `Webhook endpoint "${entry.name}" (${entry.url}) was imported as a credential placeholder; a signing secret must be supplied in the target before it can deliver. No secret material was in the package.`,
        });
      }
      for (const entry of pending.automation.grantRequirements ?? []) {
        notInherited.push({
          item: 'automation grant',
          reason: `Automation rule ${entry.sourceRuleId} v${entry.version} needs its grant re-approved in the target; imported grants never take effect.`,
        });
      }
      for (const finding of (pending.automation.cycleFindings ?? []).filter((entry: any) => entry.severity === 'BLOCKING')) {
        notInherited.push({
          item: 'automation cycle check',
          reason: `Re-running the static cycle check in the target found a BLOCKING cycle (${finding.code}); the affected rules cannot be published until the loop is removed.`,
        });
      }
    }
    const pendingTokenReissues = pkg.config.apiTokens.map((token) => ({
      name: token.name, scope: token.scope, sourceTokenId: token.id, reissuedAt: null as string | null,
    }));
    const inherited = Object.keys(targetCounts).filter((key) => matches[key]);
    return {
      generatedAt: new Date().toISOString(),
      counts: { source, target: targetCounts, matches },
      dependencies: {
        relations: pkg.config.relations.map((relation) => ({
          fieldId: relation.fieldId, kind: relation.kind, targetAppCode: relation.target.appCode,
          status: pending.dependencies.some((entry: any) => entry.sourceFieldId === relation.fieldId)
            ? 'pending' : 'resolved',
        })),
        userMapping: {
          mapped: pkg.directory.users.length - pending.unmappedUsers.length,
          unmapped: pending.unmappedUsers,
        },
        groupMapping: {
          mapped: pkg.directory.groups.length - pending.unmappedGroups.length,
          unmapped: pending.unmappedGroups,
        },
      },
      automation: pending.automation ? {
        rulesImported: (pending.automation.rules ?? []).length,
        ruleVersionsImported: (pending.automation.rules ?? [])
          .reduce((sum: number, rule: any) => sum + (rule.versions?.length ?? 0), 0),
        rulesEnabled: 0,
        grantsEffective: 0,
        unresolved: pending.automation.unresolved ?? [],
        credentialsPending: pending.automation.credentialsPending ?? [],
        grantRequirements: pending.automation.grantRequirements ?? [],
        cycleFindings: pending.automation.cycleFindings ?? [],
        scheduleHandling: pending.automation.scheduleHandling,
      } : null,
      verification: {
        recordsMatch: matches.records, tableRowsMatch: matches.tableRows,
        attachments: { checked: fileRowsRestored.length, failed: attachmentFailures },
        references: { checked: targetCounts.references, missing: (missingRefs as any).rows ?? missingRefs },
        acl: aclCheck,
        outboxEventsProduced: await count(outbox, and(eq(outbox.tenantId, tenantId),
          eq(outbox.appId, targetAppId))),
      },
      difference: {
        inherited, notInherited, pendingTokenReissues,
        externalSystemsToNotify: [
          ...pkg.config.apiTokens.map((token) =>
            `The integration using API token "${token.name}" must be given the re-issued token value.`),
          'Any webhook endpoints configured outside this product must be re-created manually; webhooks are not migrated.',
        ],
        sensitiveDataNotice: SENSITIVE_DATA_NOTICE,
        hashNote: 'SHA-256 checks prove the package and the restored attachment bodies were not modified in transit. They do not by themselves prove content completeness; completeness is established by the count reconciliation and the checks in this report.',
      },
    };
  }

  private async checkAcl(tx: TenantTransaction, ctx: TenantContext, job: JobRow, pkg: PkgPackage,
    targetAppId: string, targetAcl: any) {
    const samples: any[] = [];
    const mismatches: any[] = [];
    const targetFields = await this.schema.getFields(tx, ctx, targetAppId, pkg.app.publishedSchemaVersion);
    const sourceVersion = pkg.versions.find((version) => version.version === pkg.app.publishedSchemaVersion);
    const sourceFields = (sourceVersion?.fields ?? []) as unknown as FieldDefinition[];
    const map = new IdMap(job.entityMapping as SourceIdMapRow[]);
    const mappedUsers = pkg.directory.users.filter((user) => job.userMapping[user.id]).slice(0, 5);
    for (const sourceUser of mappedUsers) {
      const targetUserId = job.userMapping[sourceUser.id]!;
      const targetPrincipal = await this.authorization.principal(tx, { tenantId: ctx.tenantId, userId: targetUserId });
      const sourcePrincipal = {
        userId: sourceUser.id, organizationId: null as string | null,
        groups: pkg.directory.groups.filter((group) => group.memberUserIds.includes(sourceUser.id))
          .map((group) => group.id),
      };
      const sourceAccess = {
        principal: { ...ctx, ...sourcePrincipal }, acl: sourceVersion!.aclConfiguration,
        types: new Map(sourceFields.map((field) => [field.fieldId, field.type])),
        formulaRefs: formulaReferences(sourceFields),
      } as any;
      const targetAccess = {
        principal: targetPrincipal, acl: targetAcl,
        types: new Map(targetFields.map((field) => [field.fieldId, field.type])),
        formulaRefs: formulaReferences(targetFields),
      } as any;
      const entry: any = { sourceUserId: sourceUser.id, targetUserId, app: {}, fields: {}, records: {} };
      for (const action of ['view', 'create', 'edit', 'delete', 'export', 'manage'] as const) {
        const sourceAllowed = (sourceVersion!.aclConfiguration.app ?? [])
          .some((rule: any) => rule.action === action && subjectMatchesDirectory(sourcePrincipal, rule.subject));
        const targetAllowed = (targetAcl.app ?? [])
          .some((rule: any) => rule.action === action && subjectMatchesDirectory(targetPrincipal, rule.subject));
        entry.app[action] = { source: sourceAllowed, target: targetAllowed };
        if (sourceAllowed !== targetAllowed) {
          mismatches.push({ user: sourceUser.id, layer: 'app', action, source: sourceAllowed, target: targetAllowed });
        }
      }
      for (const sourceField of sourceFields) {
        const targetFieldId = map.get('field', sourceField.fieldId);
        if (!targetFieldId) continue;
        for (const action of ['view', 'edit'] as const) {
          const sourceDecision = this.authorization.fieldDecision(sourceAccess, sourceField.fieldId, action).allowed;
          const targetDecision = this.authorization.fieldDecision(targetAccess, targetFieldId, action).allowed;
          if (sourceDecision !== targetDecision) {
            mismatches.push({ user: sourceUser.id, layer: 'field', fieldId: sourceField.fieldId, action,
              source: sourceDecision, target: targetDecision });
          }
        }
      }
      for (const sourceRecord of pkg.records.slice(0, 3)) {
        const targetRecordId = map.get('record', sourceRecord.id);
        if (!targetRecordId) continue;
        const sourceRules = (sourceVersion!.aclConfiguration.record ?? [])
          .filter((rule: any) => rule.action === 'view');
        const sourceAllowed = sourceRules.length === 0 ||
          sourceRules.some((rule: any) => sourceRecordRuleMatches(sourcePrincipal, rule, sourceRecord.data));
        const [visible] = await tx.select({ id: records.id }).from(records).where(and(
          eq(records.tenantId, ctx.tenantId), eq(records.appId, targetAppId), eq(records.id, targetRecordId),
          this.authorization.recordScope(targetAccess, 'view')));
        const targetAllowed = Boolean(visible);
        entry.records[sourceRecord.id] = { source: sourceAllowed, target: targetAllowed };
        if (sourceAllowed !== targetAllowed) {
          mismatches.push({ user: sourceUser.id, layer: 'record', recordId: sourceRecord.id,
            source: sourceAllowed, target: targetAllowed });
        }
      }
      samples.push(entry);
    }
    return { samples, consistent: mismatches.length === 0, mismatches };
  }
}

// ---------------------------------------------------------------------------
// Orchestration: staging runs, resolutions, activation, cancellation and the
// failure cleanup that leaves zero half-imported data behind (G3-07/G3-08).
// ---------------------------------------------------------------------------
@Injectable()
export class ImportOrchestrator {
  private readonly storage = localAttachmentStorage();
  constructor(
    private readonly execution: ImportExecutionService,
    private readonly finalizer: ImportFinalizer,
    private readonly imports: ImportService,
    private readonly schema: AppSchemaService,
  ) {}

  private async loadJob(ctx: TenantContext, jobId: string) {
    return withTenantTransaction(ctx, (tx) => this.imports.jobRow(tx, ctx, jobId));
  }

  async queueRun(mig: MigrationContext, jobId: string) {
    if (mig.importJobId !== jobId) throw new ForbiddenException('Migration token is bound to a different import job');
    return withTenantTransaction(mig, async (tx) => {
      const job = await this.imports.jobRow(tx, mig, jobId);
      if (job.status !== 'staging') throw new BadRequestException('Only a validated (staging) job can be queued');
      const [saved] = await tx.update(importJobs).set({
        executeRequested: true, updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId)).returning();
      await this.imports.audit(tx, mig, job, { action: 'execution-queued', objectType: 'import-job', objectId: jobId });
      return jobView(saved);
    });
  }

  /** Worker entry point: execute queued staging runs for one tenant. */
  async processQueued(context: TenantContext) {
    const queued = await withTenantTransaction(context, (tx) => tx.select().from(importJobs)
      .where(and(eq(importJobs.tenantId, context.tenantId), eq(importJobs.status, 'staging'),
        eq(importJobs.executeRequested, true))).orderBy(importJobs.createdAt).limit(5));
    const results = [];
    for (const job of queued) {
      const mig: MigrationContext = {
        tenantId: context.tenantId, userId: job.createdBy,
        importJobId: job.id, targetAppId: job.targetAppId,
      };
      results.push(await this.run(mig, job.id));
    }
    return results;
  }

  async run(mig: MigrationContext, jobId: string) {
    if (mig.importJobId !== jobId) throw new ForbiddenException('Migration token is bound to a different import job');
    const ctx: TenantContext = { tenantId: mig.tenantId, userId: mig.userId };
    const initial = await this.loadJob(ctx, jobId);
    if (initial.status === 'ready') return jobView(initial);
    if (initial.status !== 'staging') {
      throw new BadRequestException('Only a validated (staging) job can be executed');
    }
    if (initial.duplicateOf && !initial.duplicateConfirmed) {
      throw new BadRequestException('Duplicate package: an administrator must confirm the second copy first');
    }
    // Atomic claim: a concurrent re-run of the same job observes the claim and
    // returns the in-flight state instead of writing anything twice (G3-07).
    const claimed = await withTenantTransaction(ctx, async (tx) => {
      const [row] = await tx.update(importJobs).set({
        stage: 'writing', executeRequested: false, attempts: sql`${importJobs.attempts} + 1`,
        updatedAt: sql`clock_timestamp()`,
      }).where(and(eq(importJobs.id, jobId), eq(importJobs.stage, 'validated'))).returning();
      return row;
    });
    if (!claimed) return jobView(await this.loadJob(ctx, jobId));
    const pkg = readPackage(await readFile(importPackagePath(ctx.tenantId, jobId)));
    const state: ExecState = {
      map: new IdMap(claimed.entityMapping as SourceIdMapRow[]),
      droppedAcl: [], droppedAssignees: [], disabledDependencies: [], pendingDependencies: [],
      automation: emptyAutomationState(),
    };
    try {
      let job = claimed;
      const targetAppId = await withTenantTransaction(ctx, async (tx) => {
        job = await this.imports.jobRow(tx, ctx, jobId);
        return this.execution.batchStructure(tx, ctx, job, pkg, state);
      });
      const batches = [
        this.execution.batchFiles, this.execution.batchRecords, this.execution.batchComments,
        this.execution.batchHistory, this.execution.batchReferences, this.execution.batchAutomation,
      ];
      for (const batch of batches) {
        await withTenantTransaction(ctx, async (tx) => {
          job = await this.imports.jobRow(tx, ctx, jobId);
          await batch.call(this.execution, tx, ctx, job, pkg, state, targetAppId);
        });
      }
      await this.finalize(ctx, jobId, pkg);
      return jobView(await this.loadJob(ctx, jobId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withTenantTransaction(ctx, (tx) => tx.update(importJobs).set({
        status: 'failed', stage: 'failed', error: message, updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId))).catch(() => undefined);
      // Failure cleanup (G3-07): a FAILED job leaves no half-imported data.
      const cleanup = await this.cleanupApp(ctx, jobId).catch(() => null);
      if (cleanup) {
        await withTenantTransaction(ctx, async (tx) => {
          const job = await this.imports.jobRow(tx, ctx, jobId);
          await tx.update(importJobs).set({
            pending: { ...(job.pending as object), cleanup },
            updatedAt: sql`clock_timestamp()`,
          }).where(eq(importJobs.id, jobId));
        }).catch(() => undefined);
      }
      return jobView(await this.loadJob(ctx, jobId));
    }
  }

  /** Recompute pending state + regenerate the evidence chain (G3-09). */
  async finalize(ctx: TenantContext, jobId: string, pkg?: PkgPackage) {
    const packageData = pkg ?? readPackage(await readFile(importPackagePath(ctx.tenantId, jobId)));
    return withTenantTransaction(ctx, async (tx) => {
      const job = await this.imports.jobRow(tx, ctx, jobId);
      if (!job.targetAppId) throw new BadRequestException('The job has no staged application yet');
      const { pending, completion } = await this.finalizer.computePending(tx, job, packageData, job.targetAppId);
      const report = await this.finalizer.generateReport(tx, ctx, job, packageData, job.targetAppId, pending);
      const [saved] = await tx.update(importJobs).set({
        status: job.status === 'staging' ? 'ready' : job.status,
        stage: job.status === 'staging' ? 'ready' : job.stage,
        pending, completion, report, updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId)).returning();
      return saved;
    });
  }

  async resolveAssignees(mig: MigrationContext, jobId: string, input: z.infer<typeof resolveAssigneesInput>) {
    if (mig.importJobId !== jobId) throw new ForbiddenException('Migration token is bound to a different import job');
    const ctx: TenantContext = { tenantId: mig.tenantId, userId: mig.userId };
    await withTenantTransaction(ctx, async (tx) => {
      const job = await this.imports.jobRow(tx, mig, jobId);
      if (job.status !== 'ready' || !job.targetAppId) {
        throw new BadRequestException('Assignees can only be resolved on a staged import');
      }
      const pending = (job.pending ?? {}) as any;
      const resolutions: Record<string, string> = { ...(pending.assigneeResolutions ?? {}) };
      for (const item of input.items) {
        const [record] = await tx.select({ id: records.id }).from(records).where(and(
          eq(records.tenantId, mig.tenantId), eq(records.appId, job.targetAppId), eq(records.id, item.recordId)));
        if (!record) throw new BadRequestException('Unknown staged record ' + item.recordId);
        const key = `${item.recordId}:${item.sourceUserId}`;
        if (item.userId) {
          const [member] = await tx.select({ userId: tenantMembers.userId }).from(tenantMembers)
            .where(and(eq(tenantMembers.tenantId, mig.tenantId), eq(tenantMembers.userId, item.userId)));
          if (!member) throw new BadRequestException('Assignee must be an existing member of this tenant');
          await tx.insert(workflowAssignments).values({
            tenantId: mig.tenantId, appId: job.targetAppId, recordId: item.recordId,
            userId: item.userId, role: 'migration', active: true,
          }).onConflictDoUpdate({
            target: [workflowAssignments.tenantId, workflowAssignments.appId,
              workflowAssignments.recordId, workflowAssignments.userId],
            set: { active: true, role: 'migration' },
          });
          resolutions[key] = `reassigned:${item.userId}`;
          await this.imports.audit(tx, mig, job, {
            action: 'assignee-reassigned', objectType: 'record', objectId: item.recordId,
            fieldSurface: ['assignees'],
          });
        } else {
          // Decision 5: explicitly accepting "no assignee" is a recorded
          // administrator decision, never a silent default.
          resolutions[key] = 'accepted-none';
          await this.imports.audit(tx, mig, job, {
            action: 'assignee-accepted-none', objectType: 'record', objectId: item.recordId,
            fieldSurface: ['assignees'],
          });
        }
      }
      await tx.update(importJobs).set({
        pending: { ...pending, assigneeResolutions: resolutions }, updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId));
    });
    await this.finalize(ctx, jobId);
    return jobView(await this.loadJob(ctx, jobId));
  }

  async resolveDependencies(mig: MigrationContext, jobId: string,
    decisions: Record<string, DependencyDecision>) {
    if (mig.importJobId !== jobId) throw new ForbiddenException('Migration token is bound to a different import job');
    const ctx: TenantContext = { tenantId: mig.tenantId, userId: mig.userId };
    const pkg = readPackage(await readFile(importPackagePath(ctx.tenantId, jobId)));
    await withTenantTransaction(ctx, async (tx) => {
      const job = await this.imports.jobRow(tx, mig, jobId);
      const merged = { ...job.dependencyDecisions, ...decisions };
      await tx.update(importJobs).set({
        dependencyDecisions: merged, updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId));
      if (!job.targetAppId) return;
      const fresh = { ...job, dependencyDecisions: merged };
      const state: ExecState = {
        map: new IdMap(job.entityMapping as SourceIdMapRow[]),
        droppedAcl: [], droppedAssignees: [], disabledDependencies: [], pendingDependencies: [],
        automation: emptyAutomationState(),
      };
      for (const [sourceFieldId, decision] of Object.entries(decisions)) {
        const targetFieldId = state.map.get('field', sourceFieldId);
        if (!targetFieldId) continue;
        const sourceField = pkg.rawFields.find((field) => field.fieldId === sourceFieldId);
        if (!sourceField) continue;
        if (decision.action === 'map') {
          // Rebuild the field's reference configuration against the chosen
          // target application and rewrite it in the field row and in every
          // schema version snapshot that carries the field.
          const scratch: ExecState = {
            map: state.map, droppedAcl: [], droppedAssignees: [],
            disabledDependencies: [], pendingDependencies: [],
            automation: emptyAutomationState(),
          };
          const lookup = sourceField.lookup
            ? this.execution.remapReferenceConfigPublic(sourceField.lookup, 'lookup', sourceFieldId, pkg, fresh, scratch)
            : undefined;
          const related = sourceField.related
            ? this.execution.remapReferenceConfigPublic(sourceField.related, 'related', sourceFieldId, pkg, fresh, scratch)
            : undefined;
          // The fields table itself is not updatable by the runtime role;
          // the definer function rewrites the staged field's configuration
          // (import-pending apps only). Version snapshots are patched below
          // through the normal field_edits grant.
          if (lookup !== undefined) {
            await tx.execute(sql`SELECT public.set_imported_field_reference(
              ${mig.tenantId}, ${job.targetAppId}, ${targetFieldId}, 'lookup',
              ${lookup ? JSON.stringify(lookup) : null}::jsonb)`);
          }
          if (related !== undefined) {
            await tx.execute(sql`SELECT public.set_imported_field_reference(
              ${mig.tenantId}, ${job.targetAppId}, ${targetFieldId}, 'related',
              ${related ? JSON.stringify(related) : null}::jsonb)`);
          }
          const versions = await tx.select().from(appVersions).where(and(
            eq(appVersions.tenantId, mig.tenantId), eq(appVersions.appId, job.targetAppId)));
          for (const version of versions) {
            const edits = { ...(version.fieldEdits as Record<string, any>) };
            const edited = edits[targetFieldId];
            if (edited) {
              if (lookup !== undefined) edited.lookup = lookup;
              if (related !== undefined) edited.related = related;
              edits[targetFieldId] = edited;
              await tx.update(appVersions).set({ fieldEdits: edits }).where(and(
                eq(appVersions.tenantId, mig.tenantId), eq(appVersions.appId, job.targetAppId),
                eq(appVersions.version, version.version)));
            }
          }
          await this.execution.batchReferences(tx, ctx, fresh, pkg, state, job.targetAppId);
        }
        await this.imports.audit(tx, mig, fresh, {
          action: `dependency-${decision.action}`, objectType: 'field', objectId: targetFieldId,
          fieldSurface: ['lookup', 'related'],
        });
      }
    });
    await this.finalize(ctx, jobId);
    return jobView(await this.loadJob(ctx, jobId));
  }

  /** Activation gate (G3-08/G3-09): report must exist and every pending item
   * must be resolved; the activation itself is audit-logged. */
  async activate(context: TenantContext, jobId: string) {
    const job = await this.loadJob(context, jobId);
    if (job.status !== 'ready') throw new BadRequestException('Only a staged (ready) import can be activated');
    if (!job.report) {
      throw new BadRequestException('The restore verification and difference report has not been generated yet');
    }
    const refreshed = await this.finalize(context, jobId);
    if (refreshed.completion !== 'complete') {
      const pending = refreshed.pending as any;
      throw new BadRequestException(
        `Import is still pending completion: ${pending.assignees?.filter((a: any) => !a.resolution).length ?? 0} assignee(s), ` +
        `${pending.dependencies?.length ?? 0} dependency(ies), ${pending.references?.length ?? 0} reference(s), ` +
        `${(pending.automation?.unresolved?.length ?? 0) + (pending.automation?.cycleFindings?.filter((finding: any) => finding.severity === 'BLOCKING').length ?? 0)} automation item(s) unresolved. ` +
        'Resolve them, explicitly disable or skip them, or cancel the import.');
    }
    return withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
      const fresh = await this.imports.jobRow(tx, context, jobId);
      await tx.update(apps).set({ activationState: 'active' }).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, fresh.targetAppId!)));
      const [saved] = await tx.update(importJobs).set({
        status: 'activated', stage: 'activated', activatedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId)).returning();
      await this.imports.audit(tx, context, fresh, {
        action: 'activate', objectType: 'application', objectId: fresh.targetAppId ?? undefined,
        fieldSurface: ['activationState'],
      });
      return jobView(saved);
    });
  }

  async cancel(context: TenantContext, jobId: string) {
    const job = await this.loadJob(context, jobId);
    if (job.status === 'activated') throw new BadRequestException('An activated import can no longer be cancelled');
    await withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
    });
    const cleanup = await this.cleanupApp(context, jobId);
    const [saved] = await withTenantTransaction(context, async (tx) => {
      const fresh = await this.imports.jobRow(tx, context, jobId);
      const [row] = await tx.update(importJobs).set({
        status: 'cancelled', stage: 'cancelled',
        pending: { ...(fresh.pending as object), cleanup },
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(importJobs.id, jobId)).returning();
      await this.imports.audit(tx, context, fresh, {
        action: 'cancel', objectType: 'import-job', objectId: jobId,
      });
      return [row];
    });
    await rm(importPackagePath(context.tenantId, jobId), { force: true }).catch(() => undefined);
    return { ...jobView(saved), cleanup };
  }

  /** Delete every object a job staged, in dependency order, and prove the
   * counts return to zero (G3-07 failure cleanup). */
  async cleanupApp(ctx: TenantContext, jobId: string) {
    const job = await this.loadJob(ctx, jobId);
    const targetAppId = job.targetAppId;
    if (!targetAppId) return { before: {}, after: {}, removedFiles: 0 };
    const { tenantId } = ctx;
    const counts = async (tx: TenantTransaction) => {
      const tally = async (statement: ReturnType<typeof sql>) => {
        const result = await tx.execute(sql`SELECT (${statement})::int AS n`);
        return (result as any).rows?.[0]?.n ?? (result as any)[0]?.n ?? 0;
      };
      return {
        records: await tally(sql`SELECT count(*) FROM records WHERE tenant_id = ${tenantId} AND app_id = ${targetAppId}`),
        comments: await tally(sql`SELECT count(*) FROM record_comments WHERE tenant_id = ${tenantId} AND app_id = ${targetAppId}`),
        historyEvents: await tally(sql`SELECT count(*) FROM record_events WHERE tenant_id = ${tenantId} AND app_id = ${targetAppId}`),
        attachments: await tally(sql`SELECT count(*) FROM files WHERE tenant_id = ${tenantId} AND app_id = ${targetAppId}`),
      };
    };
    const before = await withTenantTransaction(ctx, counts);
    const fileIds = await withTenantTransaction(ctx, async (tx) => {
      const rows = await tx.select({ id: files.id }).from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.appId, targetAppId)));
      return rows.map(({ id }) => id);
    });
    // The runtime role has no DELETE grant on business tables by design; the
    // purge runs through the SECURITY DEFINER function from migration 0033,
    // which only ever touches an application still isolated as import-pending.
    const purge = await withTenantTransaction(ctx, async (tx) => {
      await tx.update(importJobs).set({ targetAppId: null }).where(eq(importJobs.id, jobId));
      const result = await tx.execute(
        sql`SELECT public.purge_imported_app(${tenantId}, ${targetAppId}) AS outcome`);
      return (result as any).rows?.[0]?.outcome ?? (result as any)[0]?.outcome ?? null;
    });
    for (const fileId of fileIds) {
      await this.storage.remove(attachmentKey(tenantId, targetAppId, fileId)).catch(() => undefined);
    }
    const after = await withTenantTransaction(ctx, counts);
    return { before, after, removedFiles: fileIds.length, purge };
  }

  // ----- Decision 6: pending API-token re-issuance, per application --------
  async tokenReissues(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schemaAccess(tx, context, appId);
      const jobs = await tx.select().from(importJobs).where(and(
        eq(importJobs.tenantId, context.tenantId), eq(importJobs.targetAppId, appId),
        eq(importJobs.status, 'activated')));
      return jobs.flatMap((job) => {
        const report = job.report as any;
        return (report?.difference?.pendingTokenReissues ?? []).map((entry: any) => ({
          jobId: job.id, ...entry,
        }));
      });
    });
  }

  async markTokenReissued(context: TenantContext, appId: string, jobId: string, name: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schemaAccess(tx, context, appId);
      const job = await this.imports.jobRow(tx, context, jobId);
      if (job.targetAppId !== appId) throw new NotFoundException('无权限');
      const report = structuredClone(job.report) as any;
      const entry = (report?.difference?.pendingTokenReissues ?? [])
        .find((candidate: any) => candidate.name === name);
      if (!entry) throw new NotFoundException('No such pending token re-issuance');
      entry.reissuedAt = new Date().toISOString();
      await tx.update(importJobs).set({ report, updatedAt: sql`clock_timestamp()` })
        .where(eq(importJobs.id, jobId));
      await this.imports.audit(tx, context, job, {
        action: 'token-reissued', objectType: 'api-token', objectId: name,
      });
      return { jobId, ...entry };
    });
  }

  private async schemaAccess(tx: TenantTransaction, context: TenantContext, appId: string) {
    await this.schema.access(tx, context, appId, 'manage');
  }
}


// ---------------------------------------------------------------------------
// HTTP surface. Session routes administer the job (tenant administrators);
// migration-channel routes perform every system-field write and require a
// migration token bound to this job (decision 7). The two channels are
// distinguishable in code and in the audit log.
// ---------------------------------------------------------------------------
export const importHttp2 = { resolveAssigneesInput, markReissuedInput };

const dependencyDecisionsInput = z.strictObject({
  decisions: z.record(z.string(), z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('map'), targetAppId: identifier,
      fieldMappings: z.record(z.string(), identifier).default({}) }),
    z.strictObject({ action: z.literal('disable') }),
    z.strictObject({ action: z.literal('skip') }),
  ])),
});
export const importHttp3 = { dependencyDecisionsInput };

@ApiTags('imports')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('imports')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly execution: ImportExecutionService,
    private readonly orchestrator: ImportOrchestrator,
  ) {}

  @Post('upload')
  upload(@AuthenticatedTenant() context: TenantContext, @Body() body: Buffer) {
    return this.imports.upload(context, body);
  }

  @Get()
  list(@AuthenticatedTenant() context: TenantContext) {
    return this.imports.list(context);
  }

  @Get(':jobId')
  get(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.imports.get(context, parseInput(identifier, jobId));
  }

  @Get(':jobId/error-report')
  async errorReport(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    const id = parseInput(identifier, jobId);
    const job = await withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
      return this.imports.jobRow(tx, context, id);
    });
    if (!job.errorReport) throw new NotFoundException('No error report for this job');
    return new StreamableFile(Buffer.from(JSON.stringify(job.errorReport, null, 2)), {
      type: 'application/json',
      disposition: `attachment; filename="suzubase-import-${id}-errors.json"`,
    });
  }

  @Get(':jobId/audit')
  async audit(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    const id = parseInput(identifier, jobId);
    return withTenantTransaction(context, async (tx) => {
      await this.imports.requireAdmin(tx, context);
      await this.imports.jobRow(tx, context, id);
      return tx.select().from(migrationAuditLog).where(and(
        eq(migrationAuditLog.tenantId, context.tenantId), eq(migrationAuditLog.importJobId, id)))
        .orderBy(migrationAuditLog.createdAt).limit(1000);
    });
  }

  @Post(':jobId/validate')
  validate(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.execution.validate(context, parseInput(identifier, jobId));
  }

  @Post(':jobId/automation-dry-run')
  automationDryRun(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.execution.automationDryRun(context, parseInput(identifier, jobId));
  }

  @Post(':jobId/resume')
  resume(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.execution.resume(context, parseInput(identifier, jobId));
  }

  @Put(':jobId/mappings')
  mappings(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.imports.saveMappings(context, parseInput(identifier, jobId), parseInput(mappingsInput, body));
  }

  @Post(':jobId/migration-token')
  issueToken(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.imports.issueToken(context, parseInput(identifier, jobId));
  }

  @Post(':jobId/activate')
  activate(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.orchestrator.activate(context, parseInput(identifier, jobId));
  }

  @Post(':jobId/cancel')
  cancel(@AuthenticatedTenant() context: TenantContext, @Param('jobId') jobId: string) {
    return this.orchestrator.cancel(context, parseInput(identifier, jobId));
  }
}

@ApiTags('imports (migration channel)')
@UseGuards(MigrationGuard)
@Controller('imports')
export class MigrationController {
  constructor(private readonly orchestrator: ImportOrchestrator) {}

  @Post(':jobId/run')
  run(@MigrationChannel() mig: MigrationContext, @Param('jobId') jobId: string) {
    return this.orchestrator.run(mig, parseInput(identifier, jobId));
  }

  @Post(':jobId/queue-run')
  queueRun(@MigrationChannel() mig: MigrationContext, @Param('jobId') jobId: string) {
    return this.orchestrator.queueRun(mig, parseInput(identifier, jobId));
  }

  @Post(':jobId/resolve-assignees')
  resolveAssignees(@MigrationChannel() mig: MigrationContext, @Param('jobId') jobId: string,
    @Body() body: unknown) {
    return this.orchestrator.resolveAssignees(mig, parseInput(identifier, jobId),
      parseInput(resolveAssigneesInput, body));
  }

  @Post(':jobId/resolve-dependencies')
  resolveDependencies(@MigrationChannel() mig: MigrationContext, @Param('jobId') jobId: string,
    @Body() body: unknown) {
    const { decisions } = parseInput(dependencyDecisionsInput, body);
    return this.orchestrator.resolveDependencies(mig, parseInput(identifier, jobId),
      decisions as Record<string, DependencyDecision>);
  }
}

@ApiTags('token reissues')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/token-reissues')
export class TokenReissueController {
  constructor(private readonly orchestrator: ImportOrchestrator) {}

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.orchestrator.tokenReissues(context, parseInput(identifier, appId));
  }

  @Post(':jobId/mark')
  mark(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('jobId') jobId: string, @Body() body: unknown) {
    const { name } = parseInput(markReissuedInput, body);
    return this.orchestrator.markTokenReissued(context, parseInput(identifier, appId),
      parseInput(identifier, jobId), name);
  }
}
