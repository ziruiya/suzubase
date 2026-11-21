import { randomUUID } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException,
  Delete, Param, Patch, Post, Put, Query, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  and, apps, appCounters, appVersions, eq, records, fields, isNull, lte, memberGroups, organizations, recordReferences, recordUniqueValues, sql, tenantMembers, users, TenantContext, TenantTransaction, withTenantTransaction,
} from '@suzubase/db';
import { AclConfiguration, AppAction, autoNumberHelp, fieldContract, fieldTypes, isRecordInput, layoutKinds, lookupTargets, optionFieldTypes, type FieldDefinition, type FormLayout, SavedView, tableFieldTypes, tableRowLimit, textSearchModes, ViewConfiguration } from '@suzubase/shared-types';
import { z } from 'zod';
import { AuthorizationService, formulaReferences, RecordAccess } from './authorization';
import { AllowApiToken, AuthenticatedTenant, SessionGuard } from './identity';
import { aclInput } from './acl-input';
import { formulaInput, formulaProblems } from './formula';
import { normalizeValue } from './field-values';
import { dataPreflight, formLayoutInput, isDestructive, migrationInput, referencesPreflight, uniqueKey,
  validLayout, withoutLayoutField, type MigrationStrategy } from './schema-preflight';
import { retireChangedIndexes } from './runtime-index-state';
import { fieldChanges, serializeRecord, writeRecordEvent } from './record-events';
import { projectSearchValues } from './search-projection';
import { normalizeReferencePresentation, referencePresentation } from './reference-config';
import { copyWorkflow } from './workflow-graph';
import { conditions, viewInput } from './view-input';
import { identifier, parseInput, postgresErrorCode } from './validation';

const codePattern = /^[a-z][a-z0-9_-]{0,63}$/;
const metadata = {
  code: z.string().regex(codePattern),
  name: z.string().trim().min(1).max(120).refine((value) => !/[\x00\p{Surrogate}]/u.test(value)),
};
const appInput = z.strictObject(metadata);
const createAppInput = appInput.extend({ template: z.literal('customers').optional() });
const settingsInput = z.strictObject({
  name: metadata.name.optional(),
  description: z.string().max(4000).optional(),
  localDrafts: z.boolean().optional(),
  icon: z.string().max(64).nullable().optional(),
  themeColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().optional(),
  titleFieldId: identifier.nullable().optional(),
  duplicateHint: z.boolean().optional(),
  numericPrecision: z.int().min(0).max(12).optional(),
  adminMemo: z.string().max(4000).optional(),
  attachmentMaxBytes: z.int().min(1).max(8 * 1024 * 1024).optional(),
  attachmentMaxCount: z.int().min(0).max(25).optional(),
  attachmentTypes: z.array(z.enum(['image/png', 'image/jpeg', 'application/pdf'])).max(3).optional(),
}).refine((settings) => Object.keys(settings).length > 0 &&
  [settings.description, settings.icon, settings.adminMemo].every((value) => !value || !/[\x00\p{Surrogate}]/u.test(value)));
const option = z.strictObject({ value: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/i), label: metadata.name, disabled: z.boolean().default(false) });
const numbering = z.strictObject({
  prefix: z.string().max(32).regex(/^[A-Za-z0-9_-]*$/),
  scopeFieldId: identifier.nullable(),
  nextValue: z.string().regex(/^[1-9][0-9]{0,17}$/),
  padding: z.int().min(0).max(32),
  enabled: z.boolean(),
});
const layoutInput = z.strictObject({ kind: z.enum(layoutKinds), text: metadata.name.optional().default('') });
const lookupInput = z.strictObject({
  ...referencePresentation,
  appId: identifier, keyFieldId: identifier, localKeyFieldId: identifier,
  copies: z.array(z.strictObject({ sourceFieldId: identifier, targetFieldId: identifier })).min(1).max(50),
}).refine(({ copies }) => new Set(copies.map(({ targetFieldId }) => targetFieldId)).size === copies.length,
  { message: 'Each lookup destination must be distinct' });
const relatedInput = z.strictObject({
  ...referencePresentation,
  appId: identifier, localFieldId: identifier, matchFieldId: identifier, pageSize: z.int().min(1).max(100),
});
const tableFieldInput = z.strictObject({
  ...metadata, fieldId: identifier, type: z.enum(tableFieldTypes), required: z.boolean().default(false),
  uniqueValue: z.boolean().default(false), options: z.array(option).max(200).default([]),
  formula: formulaInput.nullable().default(null),
}).refine(({ type, formula, required, uniqueValue, options }) =>
  (type === 'calculation') === Boolean(formula) && !(formula && required) &&
  (!uniqueValue || fieldContract[type].unique) &&
  optionFieldTypes.has(type) === (options.length > 0) && new Set(options.map(({ value }) => value)).size === options.length,
{ message: 'Unsupported child field options, validation or formula' });
const tableInput = z.strictObject({
  fields: z.array(tableFieldInput).min(1).max(25),
  minRows: z.int().min(0).max(tableRowLimit), maxRows: z.int().min(1).max(tableRowLimit),
  addRows: z.boolean(), deleteRows: z.boolean(), reorderRows: z.boolean(),
}).refine(({ fields, minRows, maxRows }) => minRows <= maxRows &&
  new Set(fields.map(({ fieldId }) => fieldId)).size === fields.length &&
  new Set(fields.map(({ code }) => code)).size === fields.length,
{ message: 'Check row bounds and duplicate child field IDs or codes' });
const fieldProperties = z.strictObject({
  ...metadata, type: z.enum(fieldTypes), lookup: lookupInput.optional(), related: relatedInput.optional(), table: tableInput.optional(), formula: formulaInput.optional(), layoutElement: layoutInput.optional(), autoNumber: numbering.optional(), searchMode: z.enum(textSearchModes).optional(), required: z.boolean().default(false), uniqueValue: z.boolean().default(false), options: z.array(option).max(200).default([]),
});
const fieldPatch = fieldProperties.extend({
  required: z.boolean(), uniqueValue: z.boolean(), options: z.array(option).max(200),
}).partial().refine((value) => Object.keys(value).length > 0);
const fieldInput = fieldProperties.refine(({ options, type }) => optionFieldTypes.has(type) === (options.length > 0)
  && new Set(options.map(({ value }) => value)).size === options.length, { path: ['options'] })
  .refine(({ type, uniqueValue }) => !uniqueValue || fieldContract[type].unique, { path: ['uniqueValue'] })
  .refine(({ type, autoNumber, required }) => (type === 'autoNumber') === Boolean(autoNumber) &&
    !(type === 'autoNumber' && required), { path: ['autoNumber'] })
  .refine(({ type, formula, layoutElement, required }) => (type === 'calculation') === Boolean(formula) &&
    (type === 'layout') === Boolean(layoutElement) && (!required || isRecordInput(type) && type !== 'table'), { path: ['type'] })
  .refine(({ type, table }) => (type === 'table') === Boolean(table), { path: ['table'] })
  .refine(({ type, related }) => (type === 'related') === Boolean(related), { path: ['related'] })
  .refine(({ type, lookup }) => (type === 'lookup') === Boolean(lookup), { path: ['lookup'] })
  .refine(({ type, searchMode }) => !searchMode || type === 'text', { path: ['searchMode'] });
const lifecycleInput = z.strictObject({ action: z.enum(['archive', 'activate', 'restore']) });
const defaultViewInput = z.strictObject({ viewId: identifier.nullable() });
const previewInput = z.strictObject({
  userId: identifier, recordId: identifier.optional(), conditions: conditions.min(1).optional(),
}).refine((input) => !(input.recordId && input.conditions));
const publishInput = z.strictObject({ migration: migrationInput.optional() });
const binQuery = z.enum(['true', 'false']).optional();

export const appHttp = {
  createAppInput, appInput, settingsInput, lifecycleInput, fieldInput, fieldPatch, layoutInput, option, numbering, lookupInput, relatedInput, tableInput,
  formLayoutInput, viewInput, defaultViewInput, aclInput, previewInput, publishInput, binQuery,
};


@Injectable()
export class AppSchemaService {
  constructor(private readonly authorization: AuthorizationService) {}

  async createApp(context: TenantContext, { template, ...input }: z.infer<typeof createAppInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        if (!await this.authorization.canCreateApp(tx, context)) throw new ForbiddenException('Permission denied');
        const [app] = await tx.insert(apps).values({
          ...input, tenantId: context.tenantId, createdBy: context.userId,
        }).returning();
        const identity = { tenantId: context.tenantId, appId: app.id };
        await tx.insert(appVersions).values({ ...identity, version: app.publishedSchemaVersion });
        await tx.insert(appCounters).values(identity);
        if (template === 'customers') {
          const [customer] = await tx.insert(fields).values([
            { ...identity, introducedIn: 1, type: 'text', code: 'name', name: 'Name', searchMode: 'name' },
            { ...identity, introducedIn: 1, type: 'text', code: 'name-kana', name: 'Name kana', searchMode: 'kana' },
            { ...identity, introducedIn: 1, type: 'text', code: 'customer-id', name: 'Customer ID', searchMode: 'customer-id' },
            { ...identity, introducedIn: 1, type: 'phone', code: 'phone', name: 'Phone' },
            { ...identity, introducedIn: 1, type: 'email', code: 'email', name: 'Email' },
          ]).returning({ fieldId: fields.fieldId });
          app.titleFieldId = customer.fieldId;
          await tx.update(apps).set({ titleFieldId: customer.fieldId }).where(and(
            eq(apps.tenantId, context.tenantId), eq(apps.id, app.id),
          ));
        }
        return app;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('App code already in use');
      throw error;
    }
  }

  async list(context: TenantContext, bin: boolean) {
    return withTenantTransaction(context, async (tx) => {
      if (bin && !await this.authorization.requireRecycleAccess(tx, context)) throw new ForbiddenException('无权限');
      return tx.select({
        id: apps.id, code: apps.code, name: apps.name, description: apps.description, archivedAt: apps.archivedAt,
        deletedAt: apps.deletedAt,
      }).from(apps).where(and(
        bin ? this.authorization.appManagementScope(context) : this.authorization.appScope(context, undefined),
        bin ? sql`${apps.deletedAt} IS NOT NULL` : isNull(apps.deletedAt),
      )).orderBy(apps.name, apps.id);
    });
  }

  async managedApp(tx: TenantTransaction, context: TenantContext, appId: string, deleted = false) {
    const [app] = await tx.select().from(apps).where(and(
      this.authorization.appManagementScope(context), eq(apps.id, appId),
      deleted ? sql`${apps.deletedAt} IS NOT NULL` : isNull(apps.deletedAt),
    )).for('update');
    if (!app) throw new NotFoundException('无权限');
    return app;
  }

  async settings(context: TenantContext, appId: string, input?: z.infer<typeof settingsInput>) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      if (!input) return app;
      if (input.titleFieldId) {
        const definitions = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
        if (!definitions.some(({ fieldId }) => fieldId === input.titleFieldId)) {
          throw new ConflictException('Title field must exist in the published version');
        }
      }
      const [saved] = await tx.update(apps).set(input).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, appId),
      )).returning();
      return saved;
    });
  }

  async changeLifecycle(context: TenantContext, appId: string, action: 'archive' | 'activate' | 'delete' | 'restore') {
    return withTenantTransaction(context, async (tx) => {
      if (action === 'restore' && !await this.authorization.requireRecycleAccess(tx, context)) {
        throw new ForbiddenException('无权限');
      }
      const app = await this.managedApp(tx, context, appId, action === 'restore');
      const inbound = await tx.select({ appId: recordReferences.appId }).from(recordReferences).where(and(
        eq(recordReferences.tenantId, context.tenantId), eq(recordReferences.targetAppId, appId),
      )).limit(1);
      if (action === 'delete' && inbound.length) throw new ConflictException('The application has incoming record references');
      if (action === 'restore') {
        const [outbound] = await tx.select({ appId: recordReferences.targetAppId }).from(recordReferences)
          .innerJoin(apps, and(eq(apps.tenantId, recordReferences.tenantId), eq(apps.id, recordReferences.targetAppId)))
          .where(and(eq(recordReferences.tenantId, context.tenantId), eq(recordReferences.appId, appId),
            sql`${apps.deletedAt} IS NOT NULL`)).limit(1);
        if (outbound) throw new ConflictException('A referenced application is in the recycle bin');
      }
      const now = new Date().toISOString();
      const change = {
        archive: { archivedAt: now }, activate: { archivedAt: null }, delete: { deletedAt: now }, restore: { deletedAt: null },
      }[action];
      const [saved] = await tx.update(apps).set(change).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, app.id),
      )).returning();
      return saved;
    });
  }

  async copy(context: TenantContext, appId: string, input: z.infer<typeof appInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        if (!await this.authorization.canCreateApp(tx, context)) throw new ForbiddenException('无权限');
        const source = await this.managedApp(tx, context, appId);
        const { description, icon, themeColor, duplicateHint, numericPrecision, adminMemo, attachmentMaxBytes, attachmentMaxCount, attachmentTypes, localDrafts } = source;
        const [copy] = await tx.insert(apps).values({
          ...input, description, icon, themeColor, duplicateHint, numericPrecision, adminMemo, attachmentMaxBytes, attachmentMaxCount, attachmentTypes, localDrafts,
          tenantId: context.tenantId, createdBy: context.userId,
        }).returning();
        const identity = { tenantId: context.tenantId, appId: copy.id };
        await tx.insert(appVersions).values({ ...identity, version: 1 });
        await tx.insert(appCounters).values(identity);
        const definitions = await this.getFields(tx, context, appId, source.publishedSchemaVersion);
        const fieldMapping = new Map(definitions.map(({ fieldId }) => [fieldId, randomUUID()]));
        for (const { fieldId, code, name, type, required, uniqueValue, options, autoNumber, searchMode, formula, layoutElement, lookup, related, table } of definitions) {
          const copiedId = fieldMapping.get(fieldId)!;
          const rowFields = new Map(table?.fields.map(({ fieldId }) => [fieldId, randomUUID()]));
          await tx.insert(fields).values({
            ...identity, fieldId: copiedId, code, name, type, required, uniqueValue, options, searchMode, layoutElement, introducedIn: 1,
            table: table && { ...table, fields: table.fields.map((child) => ({
              ...child, fieldId: rowFields.get(child.fieldId)!,
              formula: child.formula?.map((part) => part.kind === 'field' ? { ...part, fieldId: rowFields.get(part.fieldId)! } : part) ?? null,
            })) },
            related: related && { ...related, localFieldId: fieldMapping.get(related.localFieldId)! },
            lookup: lookup && {
              ...lookup,
              localKeyFieldId: fieldMapping.get(lookup.localKeyFieldId)!,
              copies: lookup.copies.map((entry) => ({ ...entry, targetFieldId: fieldMapping.get(entry.targetFieldId)! })),
            },
            formula: formula?.map((token) => token.kind === 'field' ? { ...token, fieldId: fieldMapping.get(token.fieldId)! } : token),
            autoNumber: autoNumber && {
              ...autoNumber, scopeFieldId: autoNumber.scopeFieldId && fieldMapping.get(autoNumber.scopeFieldId)!,
            },
          });
          if (source.titleFieldId === fieldId) copy.titleFieldId = copiedId;
        }
        if (copy.titleFieldId) await tx.update(apps).set({ titleFieldId: copy.titleFieldId })
          .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, copy.id)));
        const sourceViews = await this.getViews(tx, context, appId, source.publishedSchemaVersion);
        const viewMapping = new Map(sourceViews.views.map(({ id }) => [id, randomUUID()]));
        const remap = <T extends { fieldId: string }>(value: T): T => ({
          ...value, fieldId: fieldMapping.get(value.fieldId)!,
        });
        const viewConfiguration: ViewConfiguration = {
          defaultId: sourceViews.defaultId ? viewMapping.get(sourceViews.defaultId)! : null,
          views: sourceViews.views.map((view) => ({
            ...view, id: viewMapping.get(view.id)!,
            columns: view.columns.map(remap), conditions: view.conditions.map(remap),
            aggregateFields: view.aggregateFields?.map((id) => fieldMapping.get(id)!),
            sort: view.sort && remap(view.sort),
          })),
        };
        const formLayout = (await this.layout(tx, context, appId, source.publishedSchemaVersion)).map((row) => ({
          ...row, id: randomUUID(), cells: row.cells.map(remap),
          ...(row.groupFieldId && { groupFieldId: fieldMapping.get(row.groupFieldId)! }),
        }));
        await tx.update(appVersions).set({ viewConfiguration, formLayout }).where(this.versionScope(context, copy.id, 1));
        await copyWorkflow(tx, { tenantId: context.tenantId, appId }, identity, fieldMapping);
        return copy;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('App code already in use');
      throw error;
    }
  }

  async access(
    tx: TenantTransaction, context: TenantContext, appId: string, action: AppAction, lock = false,
  ) {
    const query = tx.select().from(apps).where(this.authorization.appScope(context, appId, action));
    const [app] = await (lock ? query.for('update') : query);
    if (!app) throw new NotFoundException('无权限');
    const acl = await this.authorization.configuration(tx, context, appId, app.publishedSchemaVersion);
    const fields = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
    const principal = await this.authorization.principal(tx, context);
    const access: RecordAccess = {
      acl, principal, types: new Map(fields.map(({ fieldId, type }) => [fieldId, type])),
      formulaRefs: formulaReferences(fields),
    };
    return { app, fields, access };
  }

  async getPublished(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { app, fields, access } = await this.access(tx, context, appId, 'view');
      const definitions = this.formFields(fields, access);
      const can = await this.formActions(tx, context, appId);
      const views = this.visibleViews(await this.getViews(tx, context, appId, app.publishedSchemaVersion), access);
      return { id: app.id, name: app.name, code: app.code, description: app.description, icon: app.icon,
        themeColor: app.themeColor,
        titleFieldId: app.titleFieldId && this.authorization.fieldDecision(access, app.titleFieldId, 'view').allowed
          ? app.titleFieldId : null,
        formLayout: this.visibleLayout(await this.layout(tx, context, appId, app.publishedSchemaVersion), definitions),
        archivedAt: app.archivedAt, localDrafts: app.localDrafts, can, schemaVersion: app.publishedSchemaVersion, fields: definitions, ...views };
    });
  }

  async selectorOptions(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { fields, access } = await this.access(tx, context, appId, 'view');
      const visible = new Set(fields.filter(({ fieldId }) => this.authorization.fieldDecision(access, fieldId, 'view').allowed)
        .flatMap(({ type, table }) => [type, ...table?.fields.map((field) => field.type) ?? []]));
      return this.directoryOptions(tx, context, visible);
    });
  }

  async directoryOptions(tx: TenantTransaction, context: TenantContext, visible: ReadonlySet<string>) {
    const user = visible.has('user') ? await tx.select({
      id: users.id, name: sql<string>`COALESCE(${users.displayName}, ${users.loginName}, ${users.email})`,
      disabled: sql<boolean>`${tenantMembers.disabledAt} IS NOT NULL`,
    }).from(users).innerJoin(tenantMembers, and(eq(users.tenantId, tenantMembers.tenantId), eq(users.id, tenantMembers.userId)))
      .where(eq(users.tenantId, context.tenantId)).orderBy(sql`2`, users.id) : [];
    const organization = visible.has('organization') ? await tx.select({ id: organizations.id, name: organizations.name })
      .from(organizations).where(eq(organizations.tenantId, context.tenantId)).orderBy(organizations.name, organizations.id) : [];
    const group = visible.has('group') ? await tx.select({ id: memberGroups.id, name: memberGroups.name })
      .from(memberGroups).where(eq(memberGroups.tenantId, context.tenantId)).orderBy(memberGroups.name, memberGroups.id) : [];
    return { user, organization, group };
  }

  visibleLayout(layout: FormLayout, fields: FieldDefinition[]) {
    const visible = new Set(fields.map(({ fieldId }) => fieldId));
    return layout.map(({ id, groupFieldId, cells }) => ({
      id, ...(groupFieldId && visible.has(groupFieldId) && { groupFieldId }),
      cells: cells.filter(({ fieldId }) => visible.has(fieldId)),
    })).filter(({ cells }) => cells.length);
  }

  formFields(fields: Awaited<ReturnType<AppSchemaService['getFields']>>, access: RecordAccess) {
    const targets = lookupTargets(fields);
    return fields.filter(({ fieldId }) => this.authorization.fieldDecision(access, fieldId, 'view').allowed)
      .map((field) => ({ ...field, editable: isRecordInput(field.type) && !targets.has(field.fieldId) &&
        this.authorization.editable(access, field.fieldId) }));
  }

  async formActions(tx: TenantTransaction, context: TenantContext, appId: string) {
    const [allowed] = await tx.select({
      create: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'create')}, false)`,
      edit: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'edit')}, false)`,
      delete: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'delete')}, false)`,
      manage: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'manage')}, false)`,
      export: sql<boolean>`COALESCE(${this.authorization.appScope(context, appId, 'export')}, false)`,
    }).from(apps).where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
    return allowed;
  }

  visibleViews(configuration: ViewConfiguration, access: RecordAccess) {
    const visible = (fieldId: string) => this.authorization.fieldDecision(access, fieldId, 'view').allowed;
    const views = configuration.views.filter((view) =>
      view.conditions.every(({ fieldId }) => visible(fieldId)) && (!view.sort || visible(view.sort.fieldId)),
    ).map((view) => ({
      ...view, columns: view.columns.filter(({ fieldId }) => visible(fieldId)),
      aggregateFields: view.aggregateFields?.filter(visible),
    }));
    return { views, defaultId: views.some(({ id }) => id === configuration.defaultId) ? configuration.defaultId : null };
  }

  async getFields(tx: TenantTransaction, context: TenantContext, appId: string, version: number): Promise<FieldDefinition[]> {
    const definitionRows = await tx.select({
      fieldId: fields.fieldId, code: fields.code, name: fields.name, type: fields.type, required: fields.required,
      uniqueValue: fields.uniqueValue, autoNumber: fields.autoNumber, searchMode: fields.searchMode,
      options: fields.options, lookup: fields.lookup, related: fields.related, table: fields.table, formula: fields.formula, layoutElement: fields.layoutElement,
    }).from(fields).where(and(
      eq(fields.tenantId, context.tenantId), eq(fields.appId, appId), lte(fields.introducedIn, version),
    )).orderBy(fields.introducedIn, fields.code);
    const snapshot = await this.getVersion(tx, context, appId, version);
    return definitionRows.flatMap((field) => {
      const edited = snapshot.fieldEdits[field.fieldId];
      return edited === null ? [] : [edited ?? field];
    });
  }

  async layout(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    return (await this.getVersion(tx, context, appId, version)).formLayout;
  }

  async archivedDefinitions(tx: TenantTransaction, context: TenantContext, appId: string, version: number, ids: string[]) {
    const definitions = new Map<string, FieldDefinition>();
    const wanted = new Set(ids);
    for (let prior = version - 1; prior > 0 && wanted.size; prior--) {
      for (const field of await this.getFields(tx, context, appId, prior)) {
        if (wanted.delete(field.fieldId)) definitions.set(field.fieldId, field);
      }
    }
    return Object.fromEntries(definitions);
  }

  private async getVersion(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    const [snapshot] = await tx.select().from(appVersions).where(this.versionScope(context, appId, version));
    if (!snapshot) throw new NotFoundException();
    return snapshot;
  }

  private async beginDraft(tx: TenantTransaction, context: TenantContext, app: typeof apps.$inferSelect) {
    const appId = app.id;
    const version = app.draftSchemaVersion ?? app.publishedSchemaVersion + 1;
    if (app.draftSchemaVersion === null) {
      const { aclConfiguration, viewConfiguration, fieldEdits, formLayout } = await this.getVersion(tx, context, appId, app.publishedSchemaVersion);
      await tx.insert(appVersions).values({ tenantId: context.tenantId, appId, version, aclConfiguration, viewConfiguration, fieldEdits, formLayout });
    }
    await tx.update(apps).set({ draftSchemaVersion: version, draftStatus: 'editing' })
      .where(and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId)));
    return version;
  }

  async addField(context: TenantContext, appId: string, input: z.infer<typeof fieldInput>) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        const app = await this.managedApp(tx, context, appId);
        const version = await this.beginDraft(tx, context, app);
        const identity = { tenantId: context.tenantId, appId };
        const definitions = await this.getFields(tx, context, appId, version);
        if (definitions.some((field) => field.code === input.code)) throw new ConflictException('Field code already in use');
        if (input.autoNumber?.scopeFieldId) {
          const scope = definitions.find(({ fieldId }) => fieldId === input.autoNumber!.scopeFieldId);
          if (!scope || !fieldContract[scope.type].sort || scope.type === 'autoNumber') {
            throw new BadRequestException('Automatic numbering requires a scalar scope field');
          }
        }
        if (input.lookup) await this.validateLookup(tx, context, input.lookup, definitions);
        if (input.related) await this.validateRelated(tx, context, input.related, definitions);
        if (input.table) this.validateTable(input.table);
        const [field] = await tx.insert(fields).values({ ...identity, ...input, introducedIn: version }).returning();
        return field;
      });
    } catch (error) {
      if (postgresErrorCode(error) === '23505') throw new ConflictException('Field code already in use');
      throw error;
    }
  }

  private validateTable(config: z.infer<typeof tableInput>) {
    const problems = formulaProblems(config.fields, []);
    if (problems.length) throw new BadRequestException(problems);
  }

  private async validateRelated(tx: TenantTransaction, context: TenantContext,
    config: z.infer<typeof relatedInput>, localFields: FieldDefinition[],
  ) {
    const { fields: targetFields } = await this.access(tx, context, config.appId, 'view');
    const local = localFields.find(({ fieldId }) => fieldId === config.localFieldId);
    const target = targetFields.find(({ fieldId }) => fieldId === config.matchFieldId);
    if (!local || !target || local.type !== target.type || !fieldContract[target.type].sort) {
      throw new BadRequestException('Related records require matching scalar field types');
    }
    config.conditions = normalizeReferencePresentation(config, targetFields);
  }

  private async validateLookup(tx: TenantTransaction, context: TenantContext,
    config: z.infer<typeof lookupInput>, localFields: FieldDefinition[],
  ) {
    const local = new Map(localFields.map((field) => [field.fieldId, field]));
    const usedTargets = lookupTargets(localFields);
    const { fields: sourceFields } = await this.access(tx, context, config.appId, 'view');
    config.conditions = normalizeReferencePresentation(config, sourceFields);
    const source = new Map(sourceFields.map((field) => [field.fieldId, field]));
    const key = source.get(config.keyFieldId);
    const localKey = local.get(config.localKeyFieldId);
    if (!key?.uniqueValue) throw new BadRequestException('The reference key must be a published unique field');
    if (!localKey || localKey.type !== key.type || usedTargets.has(localKey.fieldId)) {
      throw new BadRequestException('The local key must be a writable field of the same type as the reference key');
    }
    for (const { sourceFieldId, targetFieldId } of config.copies) {
      const from = source.get(sourceFieldId);
      const to = local.get(targetFieldId);
      if (!from || !to || !isRecordInput(to.type) || ['attachment', 'table'].includes(to.type) || from.type !== to.type ||
          to.required || to.uniqueValue || targetFieldId === config.localKeyFieldId || usedTargets.has(targetFieldId) ||
          localFields.some((field) => field.lookup?.localKeyFieldId === targetFieldId) ||
          JSON.stringify(from.options.map(({ value }) => value).sort()) !== JSON.stringify(to.options.map(({ value }) => value).sort())) {
        throw new BadRequestException('Lookup copies require matching fields and distinct optional destinations');
      }
    }
  }

  async getDraft(context: TenantContext, appId: string) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const version = app.draftSchemaVersion;
      return {
        version, status: app.draftStatus, autoNumberHelp,
        publishedFields: await this.getFields(tx, context, appId, app.publishedSchemaVersion),
        fields: version === null ? [] : await this.getFields(tx, context, appId, version),
        formLayout: (await this.getVersion(tx, context, appId, version ?? app.publishedSchemaVersion)).formLayout,
        ...await this.getViews(tx, context, appId, version ?? app.publishedSchemaVersion),
      };
    });
  }

  async editField(context: TenantContext, appId: string, fieldId: string, patch: z.infer<typeof fieldPatch> | null) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const current = app.draftSchemaVersion ?? app.publishedSchemaVersion;
      const definitions = await this.getFields(tx, context, appId, current);
      const field = definitions.find((entry) => entry.fieldId === fieldId);
      if (!field) throw new NotFoundException();
      let edited: FieldDefinition | null = null;
      if (patch) {
        const { fieldId: id, ...before } = field;
        const type = patch.type ?? before.type;
        const sameType = type === before.type;
        if (!sameType && (type === 'table' || before.type === 'table' || !isRecordInput(type) || type === 'attachment' || before.type === 'attachment' || before.type === 'autoNumber')) {
          throw new BadRequestException('Create a separate field when changing attachment, layout or generated value types');
        }
        const input = parseInput(fieldInput, {
          ...before, ...patch, type,
          formula: patch.formula ?? (sameType ? before.formula ?? undefined : undefined),
          autoNumber: patch.autoNumber ?? (sameType ? before.autoNumber ?? undefined : undefined),
          table: patch.table ?? (sameType ? before.table ?? undefined : undefined),
          related: patch.related ?? (sameType ? before.related ?? undefined : undefined),
          lookup: patch.lookup ?? (sameType ? before.lookup ?? undefined : undefined),
          layoutElement: patch.layoutElement ?? (sameType ? before.layoutElement ?? undefined : undefined),
          searchMode: patch.searchMode ?? (sameType ? before.searchMode ?? undefined : undefined),
          options: patch.options ?? (sameType ? before.options : []),
        });
        if (definitions.some((entry) => entry.fieldId !== id && entry.code === input.code)) {
          throw new ConflictException('Field code already in use');
        }
        if (sameType && field.options.some((option) => !input.options.some((entry) =>
          entry.value === option.value && (!option.disabled || entry.disabled)))) {
          throw new BadRequestException('Existing option values must be retained. Deactivate an option to stop new selections.');
        }
        if (sameType && type === 'autoNumber' && JSON.stringify(input.autoNumber) !== JSON.stringify(before.autoNumber)) {
          throw new BadRequestException('An established automatic-number sequence cannot be reconfigured here');
        }
        if (input.lookup) await this.validateLookup(tx, context, input.lookup, definitions.filter((entry) => entry.fieldId !== id));
        if (input.related) await this.validateRelated(tx, context, input.related, definitions.filter((entry) => entry.fieldId !== id));
        if (input.table) this.validateTable(input.table);
        edited = { ...input, fieldId: id, table: input.table ?? null, related: input.related ?? null, lookup: input.lookup ?? null, autoNumber: input.autoNumber ?? null, formula: input.formula ?? null,
          layoutElement: input.layoutElement ?? null, searchMode: input.searchMode ?? null };
      }
      const version = await this.beginDraft(tx, context, app);
      const { fieldEdits, formLayout } = await this.getVersion(tx, context, appId, version);
      fieldEdits[fieldId] = edited;
      await tx.update(appVersions).set({
        fieldEdits, formLayout: patch ? formLayout : withoutLayoutField(formLayout, fieldId),
      }).where(this.versionScope(context, appId, version));
      return edited ?? { fieldId, deleted: true };
    });
  }

  async saveLayout(context: TenantContext, appId: string, formLayout: FormLayout) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const version = await this.beginDraft(tx, context, app);
      if (!validLayout(formLayout, await this.getFields(tx, context, appId, version))) {
        throw new BadRequestException('Layout contains an unknown field, duplicate references or an overfilled row');
      }
      await tx.update(appVersions).set({ formLayout }).where(this.versionScope(context, appId, version));
      return { version, formLayout };
    });
  }

  async rollbackDisplay(context: TenantContext, appId: string) {
    const result = await withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      if (app.draftSchemaVersion !== null || app.publishedSchemaVersion < 2) {
        throw new ConflictException('Rollback requires a prior published version and no open draft');
      }
      const previous = await this.getVersion(tx, context, appId, app.publishedSchemaVersion - 1);
      const current = await this.getVersion(tx, context, appId, app.publishedSchemaVersion);
      if (JSON.stringify(previous.formLayout) === JSON.stringify(current.formLayout) &&
          JSON.stringify(previous.viewConfiguration) === JSON.stringify(current.viewConfiguration)) {
        throw new ConflictException('There are no previous layout or view changes to restore');
      }
      const fields = await this.getFields(tx, context, appId, current.version);
      const earlierFields = await this.getFields(tx, context, appId, previous.version);
      const problems = referencesPreflight(earlierFields, fields, previous.viewConfiguration, current.aclConfiguration, app.titleFieldId);
      if (problems.length || !validLayout(previous.formLayout, fields)) {
        throw new ConflictException({ message: 'Previous display configuration is incompatible', problems });
      }
      const version = current.version + 1;
      await tx.insert(appVersions).values({
        tenantId: context.tenantId, appId, version, fieldEdits: current.fieldEdits, aclConfiguration: current.aclConfiguration,
        formLayout: previous.formLayout, viewConfiguration: previous.viewConfiguration,
      });
      const [published] = await tx.update(apps).set({ publishedSchemaVersion: version }).where(and(
        eq(apps.tenantId, context.tenantId), eq(apps.id, appId),
      )).returning();
      return published;
    });
    return result;
  }

  async publish(context: TenantContext, appId: string, migration?: MigrationStrategy) {
    const result = await withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const version = app.draftSchemaVersion;
      if (version === null) throw new ConflictException('No draft to publish');
      const previous = await this.getVersion(tx, context, appId, app.publishedSchemaVersion);
      const draft = await this.getVersion(tx, context, appId, version);
      const currentFields = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
      const draftFields = await this.getFields(tx, context, appId, version);
      const dependencyProblems = referencesPreflight(currentFields, draftFields, draft.viewConfiguration, draft.aclConfiguration, app.titleFieldId);
      if (!validLayout(draft.formLayout, draftFields)) {
        dependencyProblems.push({ fieldId: '', dependency: 'layout', reason: 'Update invalid layout references' });
      }
      const existing = new Map(currentFields.map((field) => [field.fieldId, field]));
      const destructive = isDestructive(currentFields, draftFields) || draftFields.some(({ fieldId, formula, searchMode }) => {
        const old = existing.get(fieldId);
        return old && (JSON.stringify(old.formula) !== JSON.stringify(formula) || old.searchMode !== searchMode);
      });
      const { issues, repaired, plan } = await dataPreflight(tx, context, appId, currentFields, draftFields, destructive, migration, !dependencyProblems.some(({ dependency }) => dependency === 'formula'));
      if (app.archivedAt && plan.length) throw new ConflictException('Application is archived');
      const disclose = async (items: typeof issues) => {
        if (!items.length) return [];
        const { access } = await this.access(tx, context, appId, 'view').catch((error) => {
          if (error instanceof NotFoundException) return { access: undefined };
          throw error;
        });
        if (!access) return [{ reason: 'Incompatible values require review by a user with record access' }];
        const recordRule = this.authorization.recordScope(access, 'view');
        const visible = recordRule ? new Set((await tx.select({ number: records.recordNo }).from(records).where(and(
          eq(records.tenantId, context.tenantId), eq(records.appId, appId), recordRule,
        ))).map(({ number }) => number.toString())) : undefined;
        const details = items.filter(({ recordNo, fieldId }) => (!visible || visible.has(recordNo)) &&
          this.authorization.fieldDecision(access, fieldId, 'view').allowed);
        return details.length === items.length ? details : [...details, { reason: 'Additional incompatible values require authorized review' }];
      };
      const disclosedIssues = await disclose(issues);
      const disclosedRepairs = await disclose(repaired);
      const changes = JSON.stringify([draftFields, draft.formLayout, draft.viewConfiguration, draft.aclConfiguration]) !==
        JSON.stringify([currentFields, previous.formLayout, previous.viewConfiguration, previous.aclConfiguration]);
      const scope = and(eq(apps.tenantId, context.tenantId), eq(apps.id, appId));
      const needsMigration = destructive && plan.length > 0 && !migration;
      if (version !== app.publishedSchemaVersion + 1 || !changes || issues.length || dependencyProblems.length || needsMigration) {
        await tx.update(apps).set({ draftStatus: 'validation-failed' }).where(scope);
        return { failure: {
          appId, version,
          message: issues.length ? 'Existing records are incompatible' : dependencyProblems.length ? 'Dependency check failed' :
            needsMigration ? 'Choose an explicit data migration strategy' : 'Draft has no changes',
          problems: [...disclosedIssues, ...dependencyProblems], migrationRequired: needsMigration, skippedDependencies: ['workflow', 'lookup'],
        } };
      }
      const retiring = await retireChangedIndexes(tx, context, appId, currentFields, draftFields);
      if (retiring.length) {
        await tx.update(apps).set({ draftStatus: 'validation-failed' }).where(scope);
        return { failure: { appId, version, message: 'Wait for concurrent index retirement, then publish again',
          problems: retiring.map(({ fieldId, id }) => ({ fieldId, indexId: id, dependency: 'runtime-index', reason: 'Retirement queued' })),
          skippedDependencies: ['workflow', 'lookup'],
        } };
      }
      await tx.update(apps).set({ draftStatus: 'publishable' }).where(scope);
      const [published] = await tx.update(apps).set({
        publishedSchemaVersion: version, draftSchemaVersion: null, draftStatus: null,
      }).where(scope).returning();
      const confirmation = { ...published, skippedDependencies: ['workflow', 'lookup'] };
      if (!plan.length) return { published: confirmation };
      const report = await this.applyMigration(tx, context, appId, version, draftFields, plan, disclosedRepairs, migration!);
      return { published: { ...confirmation, migrationReport: report } };
    });
    if (result.failure) throw new ConflictException(result.failure);
    return result.published;
  }

  private async applyMigration(tx: TenantTransaction, context: TenantContext, appId: string, version: number,
    definitions: FieldDefinition[], plan: Awaited<ReturnType<typeof dataPreflight>>['plan'],
    repaired: { reason: string }[], strategy: MigrationStrategy) {
    const identity = { tenantId: context.tenantId, appId };
    await tx.delete(recordUniqueValues).where(and(eq(recordUniqueValues.tenantId, context.tenantId), eq(recordUniqueValues.appId, appId)));
    const uniqueFields = definitions.filter((field) => field.uniqueValue);
    for (const { row, data, archive } of plan) {
      const [updated] = await tx.update(records).set({
        data, archivedData: archive, schemaVersion: version, revision: sql`${records.revision} + 1`,
        updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
      }).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, row.id))).returning();
      if (!row.deletedAt) {
        const values = uniqueFields.filter(({ fieldId }) => data[fieldId]).map(({ fieldId }) => ({
          ...identity, fieldId, recordId: row.id, normalizedValue: uniqueKey(data[fieldId]),
        }));
        if (values.length) await tx.insert(recordUniqueValues).values(values);
      }
      const record = serializeRecord(updated);
      await projectSearchValues(tx, context, record, definitions);
      await writeRecordEvent(tx, context, record, 'schema-migrated', fieldChanges(row.data, data), 'migration');
    }
    const report = { strategy, actorId: context.userId, occurredAt: new Date().toISOString(),
      migrated: plan.length, failed: 0, incompatibleValues: repaired };
    await tx.update(appVersions).set({ migrationReport: report }).where(this.versionScope(context, appId, version));
    return report;
  }

  private versionScope(context: TenantContext, appId: string, version: number) {
    return and(eq(appVersions.tenantId, context.tenantId), eq(appVersions.appId, appId), eq(appVersions.version, version));
  }

  async getViews(tx: TenantTransaction, context: TenantContext, appId: string, version: number) {
    const [snapshot] = await tx.select({ configuration: appVersions.viewConfiguration }).from(appVersions)
      .where(this.versionScope(context, appId, version));
    if (!snapshot) throw new NotFoundException();
    return snapshot.configuration;
  }

  async editView(
    context: TenantContext, appId: string,
    change: { action: 'save'; id?: string; value: z.infer<typeof viewInput> }
      | { action: 'delete'; id: string } | { action: 'default'; id: string | null },
  ) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const current = app.draftSchemaVersion ?? app.publishedSchemaVersion;
      const configuration = await this.getViews(tx, context, appId, current);
      const view = configuration.views.find(({ id }) => id === change.id);
      if (change.id && !view) throw new NotFoundException();
      if (change.action === 'save') {
        const fields = await this.getFields(tx, context, appId, current);
        const input = change.value;
        const definitions = new Map(fields.map((field) => [field.fieldId, field]));
        const columnsValid = input.columns.every(({ fieldId }) => definitions.has(fieldId) && definitions.get(fieldId)!.type !== 'layout');
        const sortField = input.sort && definitions.get(input.sort.fieldId);
        if (input.aggregateFields?.some((id) => {
          const field = definitions.get(id);
          return !field || !fieldContract[field.type].aggregate;
        })) throw new BadRequestException('View summaries require numeric fields');
        if (!columnsValid || (input.sort && (!sortField || !fieldContract[sortField.type].sort))) {
          throw new BadRequestException('Unsupported view column or sort');
        }
        const conditions = [];
        for (const condition of input.conditions) {
          const field = definitions.get(condition.fieldId);
          if (!field || !fieldContract[field.type].filter ||
            (condition.operator === 'current-user' && field.type !== 'user') ||
            (condition.operator === 'current-user-group' && field.type !== 'group')) {
            throw new BadRequestException('Unsupported view condition');
          }
          if ('value' in condition) {
            const value = normalizeValue(field.type, condition.value, field.options);
            if (value === undefined) throw new BadRequestException('Invalid view condition value');
            if (field.type === 'organization' || field.type === 'group') {
              await this.authorization.validateDirectorySubject(tx, context, { kind: field.type, id: value });
            }
            conditions.push({ ...condition, value });
          } else conditions.push(condition);
        }
        const saved: SavedView = { ...input, id: change.id ?? randomUUID(), conditions };
        if (view) Object.assign(view, saved);
        else configuration.views.push(saved);
      } else if (change.action === 'delete') {
        configuration.views = configuration.views.filter(({ id }) => id !== change.id);
        if (configuration.defaultId === change.id) configuration.defaultId = null;
      } else {
        configuration.defaultId = change.id;
      }
      const version = await this.beginDraft(tx, context, app);
      await tx.update(appVersions).set({ viewConfiguration: configuration }).where(this.versionScope(context, appId, version));
      return { version, ...configuration };
    });
  }

  async editAcl(context: TenantContext, appId: string, input?: z.infer<typeof aclInput>) {
    return withTenantTransaction(context, async (tx) => {
      const app = await this.managedApp(tx, context, appId);
      const current = app.draftSchemaVersion ?? app.publishedSchemaVersion;
      if (!input) return this.authorization.configuration(tx, context, appId, current);
      const fields = await this.getFields(tx, context, appId, current);
      const definitions = new Map(fields.map((field) => [field.fieldId, field]));
      for (const { subject } of [...input.app, ...input.field, ...input.record]) {
        if (subject.kind === 'user' || subject.kind === 'group' || subject.kind === 'organization') {
          await this.authorization.validateDirectorySubject(tx, context, subject);
        } else if (definitions.get(subject.id)?.type !== subject.kind.replace('-field', '')) {
          throw new BadRequestException('Invalid record subject field');
        }
      }
      if (input.field.some(({ fieldId }) => !definitions.has(fieldId))) throw new BadRequestException('Unknown permission field');
      for (const rule of input.record) for (const condition of rule.conditions) {
        const field = definitions.get(condition.fieldId);
        if ('value' in condition && (field?.type === 'organization' || field?.type === 'group')) {
          const value = normalizeValue(field.type, condition.value, field.options);
          if (value === undefined) throw new BadRequestException('Invalid permission condition value');
          await this.authorization.validateDirectorySubject(tx, context, { kind: field.type, id: value });
        }
      }
      const aclConfiguration: AclConfiguration = {
        app: input.app.map((rule) => ({ ...rule, id: randomUUID() })),
        field: input.field.map((rule) => ({ ...rule, id: randomUUID() })),
        record: input.record.map((rule) => ({
          ...rule, id: randomUUID(), conditions: rule.conditions.map((condition) => {
            const field = definitions.get(condition.fieldId);
            if (!field || !fieldContract[field.type].filter ||
              (condition.operator === 'current-user' && field.type !== 'user') ||
              (condition.operator === 'current-user-group' && field.type !== 'group')) {
              throw new BadRequestException('Unsupported permission condition');
            }
            if ('value' in condition) {
              const value = normalizeValue(field.type, condition.value, field.options);
              if (value === undefined) throw new BadRequestException('Invalid permission condition value');
              return { ...condition, value };
            }
            return condition;
          }),
        })),
      };
      const version = await this.beginDraft(tx, context, app);
      await tx.update(appVersions).set({ aclConfiguration }).where(this.versionScope(context, appId, version));
      return aclConfiguration;
    });
  }

  async previewPermissions(context: TenantContext, appId: string, target: string,
    selection: { recordId?: string; conditions?: z.infer<typeof conditions> }) {
    try {
      return await withTenantTransaction(context, async (tx) => {
        if (selection.conditions) await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
        const app = await this.managedApp(tx, context, appId);
        const fields = await this.getFields(tx, context, appId, app.publishedSchemaVersion);
        const byId = new Map(fields.map((field) => [field.fieldId, field]));
        const normalized = selection.conditions?.map((condition) => {
          const field = byId.get(condition.fieldId);
          if (!field || !fieldContract[field.type].filter ||
              (condition.operator === 'current-user' && field.type !== 'user') ||
              (condition.operator === 'current-user-group' && field.type !== 'group')) {
            throw new BadRequestException('Unsupported permission preview condition');
          }
          if (!('value' in condition)) return condition;
          const value = normalizeValue(field.type, condition.value, field.options);
          if (value === undefined) throw new BadRequestException('Invalid permission preview value');
          return { ...condition, value };
        });
        return this.authorization.preview(tx, context, appId, target, { recordId: selection.recordId, conditions: normalized }, fields);
      });
    } catch (error) {
      if (postgresErrorCode(error) === '57014') {
        throw new ServiceUnavailableException('Permission preview timed out. Narrow the conditions and retry.');
      }
      throw error;
    }
  }

  async writable(tx: TenantTransaction, context: TenantContext, appId: string, action: AppAction) {
    const authorized = await this.access(tx, context, appId, action, true);
    if (authorized.app.archivedAt) throw new ConflictException('Application is archived');
    return authorized;
  }

}

@ApiTags('app schema')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps')
export class AppSchemaController {
  constructor(private readonly schemas: AppSchemaService) {}

  @Post()
  create(@AuthenticatedTenant() context: TenantContext, @Body() body: unknown) {
    return this.schemas.createApp(context, parseInput(createAppInput, body));
  }

  @Get()
  list(@AuthenticatedTenant() context: TenantContext, @Query('bin') bin: unknown) {
    return this.schemas.list(context, parseInput(binQuery, bin) === 'true');
  }

  @Get(':appId/settings')
  @AllowApiToken('manage')
  settings(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.settings(context, parseInput(identifier, id));
  }

  @Patch(':appId/settings')
  @AllowApiToken('manage')
  updateSettings(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.settings(context, parseInput(identifier, id), parseInput(settingsInput, body));
  }

  @Post(':appId/lifecycle')
  @AllowApiToken('manage')
  lifecycle(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { action } = parseInput(lifecycleInput, body);
    return this.schemas.changeLifecycle(context, parseInput(identifier, id), action);
  }

  @Delete(':appId')
  @AllowApiToken('manage')
  remove(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.changeLifecycle(context, parseInput(identifier, id), 'delete');
  }

  @Post(':appId/copy')
  copy(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.copy(context, parseInput(identifier, id), parseInput(appInput, body));
  }

  @Get(':appId')
  @AllowApiToken('view')
  get(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.getPublished(context, parseInput(identifier, id));
  }

  @Get(':appId/selector-options')
  selectorOptions(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.selectorOptions(context, parseInput(identifier, id));
  }

  @Post(':appId/fields')
  @AllowApiToken('manage')
  addField(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.addField(context, parseInput(identifier, id), parseInput(fieldInput, body));
  }

  @Get(':appId/draft')
  @AllowApiToken('manage')
  draft(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.getDraft(context, parseInput(identifier, id));
  }

  @Patch(':appId/draft/fields/:fieldId')
  @AllowApiToken('manage')
  editDraft(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string,
    @Param('fieldId') fieldId: string, @Body() body: unknown) {
    return this.schemas.editField(context, parseInput(identifier, id), parseInput(identifier, fieldId), parseInput(fieldPatch, body));
  }

  @Delete(':appId/draft/fields/:fieldId')
  @AllowApiToken('manage')
  deleteField(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Param('fieldId') fieldId: string) {
    return this.schemas.editField(context, parseInput(identifier, id), parseInput(identifier, fieldId), null);
  }

  @Put(':appId/draft/layout')
  @AllowApiToken('manage')
  layout(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.saveLayout(context, parseInput(identifier, id), parseInput(formLayoutInput, body));
  }

  @Post(':appId/rollback-display')
  @AllowApiToken('manage')
  rollbackDisplay(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.rollbackDisplay(context, parseInput(identifier, id));
  }

  @Post(':appId/draft/views')
  @AllowApiToken('manage')
  createView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.editView(context, parseInput(identifier, id), { action: 'save', value: parseInput(viewInput, body) });
  }

  @Put(':appId/draft/views/default')
  @AllowApiToken('manage')
  defaultView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { viewId } = parseInput(defaultViewInput, body);
    return this.schemas.editView(context, parseInput(identifier, id), { action: 'default', id: viewId });
  }

  @Put(':appId/draft/views/:viewId')
  @AllowApiToken('manage')
  updateView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string,
    @Param('viewId') viewId: string, @Body() body: unknown) {
    return this.schemas.editView(context, parseInput(identifier, id), {
      action: 'save', id: parseInput(identifier, viewId), value: parseInput(viewInput, body),
    });
  }

  @Delete(':appId/draft/views/:viewId')
  @AllowApiToken('manage')
  deleteView(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Param('viewId') viewId: string) {
    return this.schemas.editView(context, parseInput(identifier, id), { action: 'delete', id: parseInput(identifier, viewId) });
  }

  @Get(':appId/draft/acl')
  @AllowApiToken('manage')
  acl(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string) {
    return this.schemas.editAcl(context, parseInput(identifier, id));
  }

  @Put(':appId/draft/acl')
  @AllowApiToken('manage')
  saveAcl(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    return this.schemas.editAcl(context, parseInput(identifier, id), parseInput(aclInput, body));
  }

  @Post(':appId/permissions/preview')
  preview(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { userId, ...selection } = parseInput(previewInput, body);
    return this.schemas.previewPermissions(context, parseInput(identifier, id), userId, selection);
  }

  @Post(':appId/publish')
  @AllowApiToken('manage')
  publish(@AuthenticatedTenant() context: TenantContext, @Param('appId') id: string, @Body() body: unknown) {
    const { migration } = parseInput(publishInput, body ?? {});
    return this.schemas.publish(context, parseInput(identifier, id), migration);
  }
}
