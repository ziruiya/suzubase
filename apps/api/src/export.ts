import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  BadRequestException, Controller, Get, Injectable, NotFoundException, Param, Post, StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apiTokens, apps, appVersions, commentMentions, eq, exportJobs, fields as fieldRows, files, groupMembers, inArray,
  memberGroups, organizations, recordComments, recordEvents, recordReferences, recordTableRows, recordWorkflowState,
  appCounters, autoNumberCounters, automationGrants, automationRules, automationRuleVersions,
  automationWebhookEndpoints, records, sql, tenantMembers, users, workflowAssignments, workflowDefinitions, workflowEvents,
  deploymentInstance, withTenantTransaction, type TenantContext, type TenantTransaction,
} from '@suzubase/db';
import { AppSchemaService } from './app-schema';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { readWorkflowGraph } from './workflow-graph';
import { attachmentKey, localAttachmentStorage } from './storage';
import { identifier, parseInput } from './validation';
import {
  MINIMUM_PROGRAM_VERSION, PACKAGE_FORMAT_VERSION, SENSITIVE_DATA_NOTICE, countPayload, emptyCounts,
  sealPackage, type ObjectCounts, type PackageManifest,
} from './export-package';
import {
  AUTOMATION_PACKAGE_SCHEMA_VERSION, type AutomationPackage,
} from './automation-package';

function exportDirectory() {
  return process.env.EXPORT_DIRECTORY ??
    resolve(process.env.ATTACHMENT_DIRECTORY ?? './attachments', 'exports');
}

function jobView(job: typeof exportJobs.$inferSelect) {
  return {
    id: job.id, appId: job.appId, status: job.status, stage: job.stage, progress: job.progress,
    snapshotCutoff: job.snapshotCutoff, attempts: job.attempts, error: job.error,
    packageSha256: job.packageSha256, packageBytes: job.packageBytes,
    createdAt: job.createdAt, updatedAt: job.updatedAt, sealedAt: job.sealedAt,
    sensitiveDataNotice: SENSITIVE_DATA_NOTICE,
  };
}

const scope = (context: TenantContext, appId: string, id?: string) => and(
  eq(exportJobs.tenantId, context.tenantId), eq(exportJobs.appId, appId),
  id ? eq(exportJobs.id, id) : undefined,
);

@Injectable()
export class ExportService {
  private readonly storage = localAttachmentStorage();
  constructor(private readonly schema: AppSchemaService) {}

  async create(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'export');
      const [job] = await tx.insert(exportJobs).values({
        tenantId: context.tenantId, appId, requestedBy: context.userId,
      }).returning();
      return jobView(job);
    });
  }

  async list(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'export');
      const rows = await tx.select().from(exportJobs).where(scope(context, appId))
        .orderBy(sql`${exportJobs.createdAt} DESC`).limit(50);
      return rows.map(jobView);
    });
  }

  async get(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'export');
      const [job] = await tx.select().from(exportJobs).where(scope(context, appId, id));
      if (!job) throw new NotFoundException('无权限');
      return { ...jobView(job), manifest: job.manifest as PackageManifest | null };
    });
  }

  async resume(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'export');
      const [job] = await tx.update(exportJobs)
        .set({ status: 'queued', stage: 'queued', error: null, updatedAt: sql`clock_timestamp()` })
        .where(and(scope(context, appId, id), eq(exportJobs.status, 'failed'))).returning();
      if (!job) throw new BadRequestException('Only a failed export job can be resumed');
      return jobView(job);
    });
  }

  async cancel(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'export');
      const [job] = await tx.update(exportJobs)
        .set({ status: 'cancelled', updatedAt: sql`clock_timestamp()` })
        .where(and(scope(context, appId, id), sql`${exportJobs.status} IN ('queued', 'failed')`)).returning();
      if (!job) throw new BadRequestException('Only a queued or failed export job can be cancelled');
      return jobView(job);
    });
  }

  async download(context: TenantContext, appId: string, id: string) {
    const job = await withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'export');
      const [found] = await tx.select().from(exportJobs).where(scope(context, appId, id));
      if (!found) throw new NotFoundException('无权限');
      return found;
    });
    if (job.status !== 'sealed' || !job.packageSha256) {
      throw new BadRequestException('Only a sealed package can be downloaded');
    }
    const data = await readFile(this.packagePath(context.tenantId, id)).catch(() => {
      throw new NotFoundException('Sealed package file is missing');
    });
    if (createHash('sha256').update(data).digest('hex') !== job.packageSha256) {
      throw new BadRequestException('Sealed package checksum does not match the job record');
    }
    return new StreamableFile(data, {
      type: 'application/zip',
      disposition: `attachment; filename="suzubase-export-${id}.zip"`,
    });
  }

  private packagePath(tenantId: string, jobId: string) {
    return resolve(exportDirectory(), tenantId, `${jobId}.zip`);
  }

  /** Worker entry point: run every queued export job for one tenant, serially. */
  async processQueued(context: TenantContext) {
    const queued = await withTenantTransaction(context, (tx) =>
      tx.select({ id: exportJobs.id, appId: exportJobs.appId }).from(exportJobs)
        .where(and(eq(exportJobs.tenantId, context.tenantId), eq(exportJobs.status, 'queued')))
        .orderBy(exportJobs.createdAt).limit(5));
    const results = [];
    for (const job of queued) results.push(await this.run(context, job.appId, job.id));
    return results;
  }

  /**
   * Execute one export job (G3-01): claim -> consistent snapshot collection ->
   * pre-seal reconciliation -> sealed package file. Any failure marks the job
   * failed with the stage preserved for resume; a package file is written only
   * after sealing succeeds, so a half package can never be downloaded.
   */
  async run(context: TenantContext, appId: string, id: string) {
    const claimed = await withTenantTransaction(context, async (tx) => {
      const [job] = await tx.update(exportJobs).set({
        status: 'running', stage: 'collecting', attempts: sql`${exportJobs.attempts} + 1`,
        snapshotCutoff: sql`COALESCE(${exportJobs.snapshotCutoff}, clock_timestamp())`,
        error: null, updatedAt: sql`clock_timestamp()`,
      }).where(and(scope(context, appId, id), eq(exportJobs.status, 'queued'))).returning();
      return job;
    });
    if (!claimed) {
      const current = await this.get(context, appId, id).catch(() => null);
      if (!current) throw new NotFoundException('无权限');
      return current;
    }
    const jobContext: TenantContext = { tenantId: context.tenantId, userId: claimed.requestedBy };
    try {
      const { archive, manifest } = await withTenantTransaction(jobContext, async (tx) => {
        await this.schema.access(tx, jobContext, appId, 'export');
        return this.collect(tx, jobContext, appId, claimed);
      });
      const path = this.packagePath(context.tenantId, id);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const staging = `${path}.staging-${claimed.attempts}`;
      await writeFile(staging, archive, { mode: 0o600 });
      await rename(staging, path);
      const [sealed] = await withTenantTransaction(context, (tx) => tx.update(exportJobs).set({
        status: 'sealed', stage: 'sealed', manifest,
        packageSha256: createHash('sha256').update(archive).digest('hex'),
        packageBytes: archive.length, sealedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
        progress: manifest.counts.actual,
      }).where(scope(context, appId, id)).returning());
      return { ...jobView(sealed), manifest };
    } catch (error) {
      await rm(this.packagePath(context.tenantId, id), { force: true }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      const [failed] = await withTenantTransaction(context, (tx) => tx.update(exportJobs).set({
        status: 'failed', error: message, updatedAt: sql`clock_timestamp()`,
      }).where(scope(context, appId, id)).returning());
      return { ...jobView(failed), manifest: null };
    }
  }

  /** Collect every export surface (G3-02..G3-05) at the job snapshot cutoff. */
  private async collect(tx: TenantTransaction, context: TenantContext, appId: string,
    job: typeof exportJobs.$inferSelect) {
    const { tenantId } = context;
    const cutoff = job.snapshotCutoff!;
    const at = sql`<= ${cutoff}::timestamptz`;
    const [instance] = await tx.select({ instanceId: deploymentInstance.instanceId }).from(deploymentInstance).limit(1);
    const [app] = await tx.select().from(apps).where(and(eq(apps.tenantId, tenantId), eq(apps.id, appId)));
    if (!app) throw new NotFoundException('无权限');

    // ---- G3-02 structure: every schema version snapshot, resolved fields,
    // layouts, views; deleted-field archive definitions + surviving values.
    const versionRows = await tx.select().from(appVersions)
      .where(and(eq(appVersions.tenantId, tenantId), eq(appVersions.appId, appId))).orderBy(appVersions.version);
    const versions = [];
    for (const row of versionRows) {
      versions.push({
        version: row.version, aclConfiguration: row.aclConfiguration, fieldEdits: row.fieldEdits,
        formLayout: row.formLayout, notificationRules: row.notificationRules,
        viewConfiguration: row.viewConfiguration, migrationReport: row.migrationReport,
        fields: await this.schema.getFields(tx, context, appId, row.version),
      });
    }
    const published = versions.find(({ version }) => version === app.publishedSchemaVersion)!;
    const publishedFields = published.fields;
    const rawFieldRows = await tx.select().from(fieldRows)
      .where(and(eq(fieldRows.tenantId, tenantId), eq(fieldRows.appId, appId)));
    const deletedIds = new Set<string>();
    for (const row of versionRows) {
      for (const [fieldId, edited] of Object.entries(row.fieldEdits)) if (edited === null) deletedIds.add(fieldId);
    }
    for (const fieldId of deletedIds) {
      if (publishedFields.some((field) => field.fieldId === fieldId)) deletedIds.delete(fieldId);
    }
    const archivedDefs = deletedIds.size
      ? await this.schema.archivedDefinitions(tx, context, appId, app.publishedSchemaVersion, [...deletedIds]) : {};

    // ---- G3-03 records (all, incl. soft-deleted) + subtable rows + references.
    const recordRows = await tx.select().from(records).where(and(
      eq(records.tenantId, tenantId), eq(records.appId, appId), sql`${records.createdAt} ${at}`));
    const recordIds = recordRows.map(({ id }) => id);
    const tableRowList = recordIds.length ? await tx.select().from(recordTableRows).where(and(
      eq(recordTableRows.tenantId, tenantId), eq(recordTableRows.appId, appId))) : [];
    const referenceRows = await tx.select().from(recordReferences).where(and(
      eq(recordReferences.tenantId, tenantId), eq(recordReferences.appId, appId)));
    const workflowStates = recordIds.length ? await tx.select().from(recordWorkflowState).where(and(
      eq(recordWorkflowState.tenantId, tenantId), eq(recordWorkflowState.appId, appId))) : [];
    const assignmentRows = recordIds.length ? await tx.select().from(workflowAssignments).where(and(
      eq(workflowAssignments.tenantId, tenantId), eq(workflowAssignments.appId, appId),
      eq(workflowAssignments.active, true))) : [];
    const stateByRecord = new Map(workflowStates.map((row) => [row.recordId, row]));
    const assigneesByRecord = new Map<string, string[]>();
    for (const row of assignmentRows) {
      assigneesByRecord.set(row.recordId, [...(assigneesByRecord.get(row.recordId) ?? []), row.userId]);
    }
    const deletedValues: { recordId: string; fieldId: string; value: string }[] = [];
    const exportedRecords = recordRows.map((row) => {
      for (const [fieldId, value] of Object.entries(row.archivedData)) {
        if (deletedIds.has(fieldId)) deletedValues.push({ recordId: row.id, fieldId, value });
      }
      const workflow = stateByRecord.get(row.id);
      return {
        id: row.id, recordNo: row.recordNo.toString(), data: row.data, archivedData: row.archivedData,
        schemaVersion: row.schemaVersion, revision: row.revision, status: row.status,
        createdBy: row.createdBy, createdAt: row.createdAt, updatedBy: row.updatedBy, updatedAt: row.updatedAt,
        deletedBy: row.deletedBy, deletedAt: row.deletedAt,
        workflow: workflow ? {
          workflowId: workflow.workflowId, workflowVersion: workflow.workflowVersion,
          stateId: workflow.stateId, assignees: assigneesByRecord.get(row.id) ?? [],
        } : null,
      };
    });

    const [counterRow] = await tx.select().from(appCounters).where(and(
      eq(appCounters.tenantId, tenantId), eq(appCounters.appId, appId)));
    const autoCounters = await tx.select().from(autoNumberCounters).where(and(
      eq(autoNumberCounters.tenantId, tenantId), eq(autoNumberCounters.appId, appId)));

    // ---- G3-02 workflows: all published + draft (deactivated) versions.
    const definitionRows = await tx.select().from(workflowDefinitions).where(and(
      eq(workflowDefinitions.tenantId, tenantId), eq(workflowDefinitions.appId, appId)))
      .orderBy(workflowDefinitions.version);
    const definitions = [];
    for (const definition of definitionRows) {
      definitions.push({ id: definition.id, ...(await readWorkflowGraph(tx, definition)) });
    }

    // ---- G3-03 attachments via the Storage Adapter only (contracts 5 SS5.4.1).
    const fileRowsAll = await tx.select().from(files).where(and(
      eq(files.tenantId, tenantId), eq(files.appId, appId), sql`${files.createdAt} ${at}`));
    const temporaryExcluded = fileRowsAll.filter(({ state }) => state === 'TEMPORARY').length;
    const purgedExcluded = fileRowsAll.filter(({ state, purgedAt }) => state !== 'TEMPORARY' && purgedAt !== null).length;
    const attachmentEntries: PackageManifest['attachments'] = [];
    const attachmentBodies: Record<string, Buffer> = {};
    for (const file of fileRowsAll) {
      if (file.state === 'TEMPORARY' || file.purgedAt !== null || !file.sha256) continue;
      // Files are versioned by the storage key; the current adapter writes v1.
      const body = await this.storage.read(attachmentKey(tenantId, appId, file.id), file.sha256);
      const version = 1;
      attachmentBodies[`attachments/${file.id}/v${version}/body`] = body;
      attachmentEntries.push({
        fileId: file.id, version, sha256: file.sha256, bytes: body.length,
        state: file.state, name: file.name, contentType: file.contentType,
      });
    }
    const fileMeta = fileRowsAll.filter(({ state, purgedAt }) => state !== 'TEMPORARY' && purgedAt === null)
      .map((file) => ({
        id: file.id, uploadedBy: file.uploadedBy, name: file.name, contentType: file.contentType,
        bytes: file.bytes, sha256: file.sha256, state: file.state, version: 1,
        referenceCount: file.referenceCount, createdAt: file.createdAt, deletedAt: file.deletedAt,
      }));

    // ---- G3-04 comments (deleted: metadata + deletion trace only, no body)
    // and history events at event level, migration chain preserved as-is.
    const commentRows = await tx.select().from(recordComments).where(and(
      eq(recordComments.tenantId, tenantId), eq(recordComments.appId, appId),
      sql`${recordComments.createdAt} ${at}`)).orderBy(recordComments.createdAt, recordComments.id);
    const liveIds = commentRows.filter(({ deletedAt }) => deletedAt === null).map(({ id }) => id);
    const mentionRows = liveIds.length ? await tx.select().from(commentMentions).where(and(
      eq(commentMentions.tenantId, tenantId), eq(commentMentions.appId, appId))) : [];
    const exportedComments = commentRows.map((row) => row.deletedAt !== null ? {
      id: row.id, recordId: row.recordId, authorId: row.authorId, createdAt: row.createdAt,
      deleted: true as const, deletedAt: row.deletedAt, body: null, mentions: [],
    } : {
      id: row.id, recordId: row.recordId, authorId: row.authorId, createdAt: row.createdAt,
      deleted: false as const, deletedAt: null, body: row.body,
      mentions: mentionRows.filter(({ commentId }) => commentId === row.id)
        .map(({ userId, offset, length }) => ({ userId, offset, length })),
    });
    const eventRows = await tx.select().from(recordEvents).where(and(
      eq(recordEvents.tenantId, tenantId), eq(recordEvents.appId, appId),
      sql`${recordEvents.occurredAt} ${at}`)).orderBy(recordEvents.occurredAt, recordEvents.eventId);
    const workflowEventRows = eventRows.length ? await tx.select().from(workflowEvents).where(and(
      eq(workflowEvents.tenantId, tenantId), eq(workflowEvents.appId, appId))) : [];
    const workflowEventById = new Map(workflowEventRows.map((row) => [row.eventId, row]));
    const exportedEvents = eventRows.map((row) => ({
      eventId: row.eventId, recordId: row.recordId, recordRevision: row.recordRevision,
      schemaVersion: row.schemaVersion, actorId: row.actorId, source: row.source, kind: row.kind,
      objectType: row.objectType, objectId: row.objectId, occurredAt: row.occurredAt, changes: row.changes,
      // Migration-source chain (contracts 4 SS4.5.3): carried as-is when the
      // source event has one; never rewritten into a local event.
      importJobId: row.importJobId, sourceActorId: row.sourceActorId, sourceTimestamp: row.sourceTimestamp,
    }));
    const exportedWorkflowEvents = workflowEventRows
      .filter(({ eventId }) => exportedEvents.some((event) => event.eventId === eventId))
      .map((row) => ({
        eventId: row.eventId, workflowId: row.workflowId, actionId: row.actionId,
        fromStateId: row.fromStateId, toStateId: row.toStateId, reason: row.reason,
        assigneeIds: row.assigneeIds,
      }));

    // ---- G3-05 config: ACL, notification rules, lookup/related, token metadata.
    const acl = published.aclConfiguration;
    const tenantApps = await tx.select({ id: apps.id, code: apps.code }).from(apps)
      .where(eq(apps.tenantId, tenantId));
    const codeByAppId = new Map(tenantApps.map(({ id, code }) => [id, code]));
    const relationConfigs = publishedFields.flatMap((field) => {
      const entries = [];
      if (field.lookup) entries.push({
        fieldId: field.fieldId, kind: 'lookup' as const, config: field.lookup,
        target: { appId: field.lookup.appId, appCode: codeByAppId.get(field.lookup.appId) ?? null },
      });
      if (field.related) entries.push({
        fieldId: field.fieldId, kind: 'related' as const, config: field.related,
        target: { appId: field.related.appId, appCode: codeByAppId.get(field.related.appId) ?? null },
      });
      return entries;
    });
    // Token metadata only (decision 6): name + scope + owning app. Secrets and
    // secret hashes never enter the package.
    const tokenRows = await tx.select({
      id: apiTokens.id, label: apiTokens.label, actions: apiTokens.actions,
      createdAt: apiTokens.createdAt, revokedAt: apiTokens.revokedAt, issuedBy: apiTokens.issuedBy,
    }).from(apiTokens).where(and(eq(apiTokens.tenantId, tenantId), eq(apiTokens.appId, appId)));

    // ---- P3-D wave 2 automation (brief S7.1): rule definitions, every
    // rule version, grant REQUIREMENTS and the non-sensitive webhook
    // endpoint configuration. Secret material never enters the package:
    // neither the plaintext secret nor its AES-256-GCM ciphertext is
    // read here at all. Run history is NOT exported as replayable state;
    // business history travels in data/history.json under the existing
    // M1 contract, untouched by this section.
    const automationRuleRows = await tx.select().from(automationRules).where(and(
      eq(automationRules.tenantId, tenantId), eq(automationRules.appId, appId)))
      .orderBy(automationRules.createdAt);
    const automationVersionRows = automationRuleRows.length ? await tx.select().from(automationRuleVersions)
      .where(and(eq(automationRuleVersions.tenantId, tenantId), eq(automationRuleVersions.appId, appId)))
      .orderBy(automationRuleVersions.version) : [];
    const automationGrantRows = automationVersionRows.length ? await tx.select().from(automationGrants)
      .where(and(eq(automationGrants.tenantId, tenantId), eq(automationGrants.appId, appId))) : [];
    // Explicit non-sensitive column selection (P3 closure hardening):
    // secretEnc / previousSecretEnc are never loaded into memory here at
    // all, instead of being selected wholesale and dropped at mapping.
    const automationEndpointRows = await tx.select({
      id: automationWebhookEndpoints.id, name: automationWebhookEndpoints.name,
      url: automationWebhookEndpoints.url, policy: automationWebhookEndpoints.policy,
      keyVersion: automationWebhookEndpoints.keyVersion,
      credentialPending: automationWebhookEndpoints.credentialPending,
      validatedUrlHash: automationWebhookEndpoints.validatedUrlHash,
      createdAt: automationWebhookEndpoints.createdAt,
    }).from(automationWebhookEndpoints).where(and(
      eq(automationWebhookEndpoints.tenantId, tenantId), eq(automationWebhookEndpoints.appId, appId)))
      .orderBy(automationWebhookEndpoints.createdAt);
    const automationPackage: AutomationPackage = {
      schemaVersion: AUTOMATION_PACKAGE_SCHEMA_VERSION,
      endpoints: automationEndpointRows.map((row) => ({
        sourceEndpointId: row.id, name: row.name, url: row.url, policy: row.policy,
        keyVersion: row.keyVersion, credentialRequired: true as const,
        credentialPendingInSource: row.credentialPending,
        validatedInSource: row.validatedUrlHash !== null &&
          row.validatedUrlHash === createHash('sha256').update(row.url).digest('hex'),
      })),
      rules: automationRuleRows.map((rule) => ({
        sourceRuleId: rule.id, name: rule.name, enabledInSource: rule.enabled,
        currentVersion: rule.currentVersion, archived: rule.archivedAt !== null,
        versions: automationVersionRows.filter((version) => version.ruleId === rule.id)
          .map((version) => {
            const grants = automationGrantRows.filter((grant) =>
              grant.ruleId === rule.id && grant.ruleVersion === version.version);
            const grant = grants.find((entry) => entry.revokedAt === null) ?? grants[0];
            return {
              version: version.version, schemaVersion: version.schemaVersion,
              sourceSchemaVersion: version.sourceSchemaVersion, status: version.status,
              trigger: version.trigger, conditions: version.conditions, actions: version.actions,
              // Requirement list only: what the source approved. The
              // approver identity and timestamps are NOT exported and no
              // grant becomes effective in the target environment.
              grantRequirement: grant ? {
                sourceAppId: grant.sourceAppId, readableFieldIds: grant.readableFieldIds,
                targetAppIds: grant.targetAppIds, writableFieldIds: grant.writableFieldIds,
                allowedOperations: grant.allowedOperations,
              } : null,
            };
          }),
      })),
    };

    // ---- Directory: source identities referenced anywhere in the package.
    const userIds = new Set<string>();
    const groupIds = new Set<string>();
    const organizationIds = new Set<string>();
    const addSubject = (subject: { kind: string; id: string }) => {
      if (subject.kind === 'user') userIds.add(subject.id);
      if (subject.kind === 'group') groupIds.add(subject.id);
      if (subject.kind === 'organization') organizationIds.add(subject.id);
    };
    for (const rule of [...acl.app, ...acl.field]) addSubject(rule.subject);
    for (const rule of acl.record) if ('kind' in rule.subject && rule.subject.kind !== 'user-field' &&
      rule.subject.kind !== 'group-field' && rule.subject.kind !== 'organization-field') {
      addSubject(rule.subject as { kind: string; id: string });
    }
    for (const row of recordRows) { userIds.add(row.createdBy); userIds.add(row.updatedBy); if (row.deletedBy) userIds.add(row.deletedBy); }
    for (const row of commentRows) userIds.add(row.authorId);
    for (const row of eventRows) userIds.add(row.actorId);
    for (const ids of assigneesByRecord.values()) for (const id of ids) userIds.add(id);
    for (const rule of published.notificationRules) for (const recipient of rule.recipients) {
      if ('id' in recipient) addSubject(recipient);
    }
    for (const rule of automationPackage.rules) {
      for (const version of rule.versions) {
        for (const action of version.actions) {
          for (const id of action.notify?.recipientUserIds ?? []) userIds.add(id);
          for (const id of action.notify?.recipientGroupIds ?? []) groupIds.add(id);
        }
      }
    }
    for (const row of automationRuleRows) userIds.add(row.createdBy);
    for (const token of tokenRows) userIds.add(token.issuedBy);
    const directoryUsers = userIds.size ? await tx.select({
      id: users.id, email: users.email, loginName: users.loginName, displayName: users.displayName,
      disabled: sql<boolean>`${tenantMembers.disabledAt} IS NOT NULL`,
    }).from(users).innerJoin(tenantMembers, and(
      eq(tenantMembers.tenantId, users.tenantId), eq(tenantMembers.userId, users.id)))
      .where(and(eq(users.tenantId, tenantId), inArray(users.id, [...userIds]))) : [];
    const directoryGroups = groupIds.size ? await tx.select().from(memberGroups)
      .where(and(eq(memberGroups.tenantId, tenantId), inArray(memberGroups.id, [...groupIds]))) : [];
    const directoryOrganizations = organizationIds.size ? await tx.select().from(organizations)
      .where(and(eq(organizations.tenantId, tenantId), inArray(organizations.id, [...organizationIds]))) : [];
    const groupMemberRows = directoryGroups.length ? await tx.select().from(groupMembers)
      .where(eq(groupMembers.tenantId, tenantId)) : [];

    const filesPayload: Record<string, string> = {
      'data/app.json': JSON.stringify({
        app: {
          id: app.id, code: app.code, name: app.name, description: app.description, icon: app.icon,
          themeColor: app.themeColor, titleFieldId: app.titleFieldId, duplicateHint: app.duplicateHint,
          numericPrecision: app.numericPrecision, attachmentMaxBytes: app.attachmentMaxBytes,
          attachmentMaxCount: app.attachmentMaxCount, attachmentTypes: app.attachmentTypes,
          localDrafts: app.localDrafts, commentsEnabled: app.commentsEnabled,
          workflowEnabled: app.workflowEnabled, adminMemo: app.adminMemo,
          publishedSchemaVersion: app.publishedSchemaVersion,
          draftSchemaVersion: app.draftSchemaVersion, createdBy: app.createdBy,
        },
        recordCounter: counterRow ? counterRow.lastValue.toString() : '0',
        autoNumberCounters: autoCounters.map((row) => ({
          fieldId: row.fieldId, scope: row.scope, nextValue: row.nextValue.toString(),
        })),
      }),
      'data/schema.json': JSON.stringify({
        versions, fields: publishedFields, rawFields: rawFieldRows,
        deletedFields: [...deletedIds].map((fieldId) => ({
          fieldId, definition: archivedDefs[fieldId] ?? null, survivingValues:
            deletedValues.filter((value) => value.fieldId === fieldId),
        })),
        views: published.viewConfiguration.views, viewConfiguration: published.viewConfiguration,
        formLayout: published.formLayout,
      }),
      'data/workflows.json': JSON.stringify({ definitions }),
      'data/records.json': JSON.stringify({ records: exportedRecords }),
      'data/table-rows.json': JSON.stringify({
        rows: tableRowList.map((row) => ({
          recordId: row.recordId, fieldId: row.fieldId, rowId: row.rowId,
          rowOrder: row.rowOrder, data: row.data,
        })),
      }),
      'data/references.json': JSON.stringify({
        references: referenceRows.map((row) => ({
          recordId: row.recordId, fieldId: row.fieldId, targetAppId: row.targetAppId,
          targetAppCode: codeByAppId.get(row.targetAppId) ?? null, targetRecordId: row.targetRecordId,
        })),
      }),
      'data/attachments.json': JSON.stringify({ files: fileMeta }),
      'data/comments.json': JSON.stringify({ comments: exportedComments }),
      'data/history.json': JSON.stringify({ recordEvents: exportedEvents, workflowEvents: exportedWorkflowEvents }),
      'data/config.json': JSON.stringify({
        acl, notificationRules: published.notificationRules, relations: relationConfigs,
        apiTokens: tokenRows.map((token) => ({
          id: token.id, name: token.label, scope: token.actions, appId,
          issuedBy: token.issuedBy, createdAt: token.createdAt, revokedAt: token.revokedAt,
        })),
      }),
      'data/automation.json': JSON.stringify(automationPackage),
      'data/directory.json': JSON.stringify({
        users: directoryUsers, groups: directoryGroups.map((group) => ({
          id: group.id, name: group.name,
          memberUserIds: groupMemberRows.filter(({ groupId }) => groupId === group.id).map(({ userId }) => userId),
        })), organizations: directoryOrganizations,
      }),
    };

    const expected = emptyCounts();
    expected.apps = 1;
    expected.appVersions = versionRows.length;
    expected.fieldVersionSnapshots = versionRows.length;
    expected.fields = publishedFields.length;
    expected.deletedFields = deletedIds.size;
    expected.views = published.viewConfiguration.views.length;
    expected.workflowVersions = definitionRows.length;
    expected.records = recordRows.length;
    expected.tableRows = tableRowList.length;
    expected.references = referenceRows.length;
    expected.attachments = attachmentEntries.length;
    expected.attachmentVersions = attachmentEntries.length;
    expected.comments = commentRows.length;
    expected.historyEvents = eventRows.length;
    expected.workflowEvents = exportedWorkflowEvents.length;
    expected.aclEntries = acl.app.length + acl.record.length + acl.field.length;
    expected.notificationRules = published.notificationRules.length;
    expected.apiTokenMetadata = tokenRows.length;
    expected.automationRules = automationPackage.rules.length;
    expected.automationRuleVersions = automationPackage.rules
      .reduce((sum, rule) => sum + rule.versions.length, 0);
    expected.automationWebhookEndpoints = automationPackage.endpoints.length;
    expected.userReferences = directoryUsers.length;
    expected.groupReferences = directoryGroups.length;
    expected.organizationReferences = directoryOrganizations.length;

    return sealPackage({
      manifestBase: {
        formatVersion: PACKAGE_FORMAT_VERSION, minimumProgramVersion: MINIMUM_PROGRAM_VERSION,
        exportId: job.id, sourceInstanceId: instance?.instanceId ?? 'unknown-instance',
        sourceTenantId: tenantId, sourceAppId: appId, sourceAppCode: app.code,
        exportedAt: new Date().toISOString(), snapshotCutoff: cutoff,
        counts: { expected },
        excluded: { temporaryAttachments: temporaryExcluded, purgedAttachments: purgedExcluded },
        inclusion: {
          customFiles: 'unsupported', pluginConfig: 'unsupported', webhooks: 'unsupported',
          apiTokens: tokenRows.length ? 'included' : 'absent',
          workflows: definitionRows.length ? 'included' : 'absent',
          comments: app.commentsEnabled ? 'included' : 'absent',
          automation: automationPackage.rules.length || automationPackage.endpoints.length
            ? 'included' : 'absent',
          attachments: attachmentEntries.length ? 'included' : 'absent',
        },
        attachments: attachmentEntries, sensitiveDataNotice: SENSITIVE_DATA_NOTICE,
      },
      files: filesPayload, attachmentBodies,
    });
  }
}

@ApiTags('exports')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/exports')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Post()
  create(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.exports.create(context, parseInput(identifier, appId));
  }

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string) {
    return this.exports.list(context, parseInput(identifier, appId));
  }

  @Get(':exportId')
  get(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('exportId') id: string) {
    return this.exports.get(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Post(':exportId/run')
  run(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('exportId') id: string) {
    return this.exports.run(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Post(':exportId/resume')
  resume(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('exportId') id: string) {
    return this.exports.resume(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Post(':exportId/cancel')
  cancel(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('exportId') id: string) {
    return this.exports.cancel(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Get(':exportId/package')
  download(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('exportId') id: string) {
    return this.exports.download(context, parseInput(identifier, appId), parseInput(identifier, id));
  }
}
