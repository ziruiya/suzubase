import { createHash } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Headers, Injectable,
  NotFoundException, Param, Patch, Post, Put, Query, StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  and, appCounters, eq, gt, inArray, isNull, memberGroups, organizations, tenantMembers, recordCategories, recordCreateKeys, recordEvents, recordReferences, recordTableRows, recordUniqueValues, records, sql, TenantContext,
  TenantTransaction, users, withTenantTransaction, workflowActions, workflowEvents, workflowStates,
} from '@suzubase/db';
import { categorySubtreeIds, FieldChange, FieldDefinition, isRecordInput, lookupTargets, multiOptionFieldTypes, RecordAction, RecordData, RecordResponse, TableRow } from '@suzubase/shared-types';
import { z } from 'zod';
import { assignAutoNumber, numberScope } from './auto-number';
import { AppSchemaService } from './app-schema';
import { AuthorizationService, formulaReferences, RecordAccess } from './authorization';
import { AllowApiToken, AuthenticatedTenant, SessionGuard } from './identity';
import { NotificationPlanner } from './notification-planner';
import { RecordQueryService } from './record-query';
import { fieldChanges, serializeRecord, writeRecordEvent, type EventCausation } from './record-events';
import { FileService, fileIds } from './files';
import { assertCategoryAssignments, categoryIdsInput, recordCategoryIds, replaceRecordCategories } from './categories';
import { SearchService, searchInput } from './search';
import { projectSearchValues } from './search-projection';
import { prepareTableRows, replaceTableRows, tableRowScope } from './table-rows';
import { attachInitialWorkflow, initialWorkflow } from './workflow-data';
import { uniqueKey } from './schema-preflight';
import { calculateFields } from './formula';
import { normalizeValue } from './field-values';
import { identifier, parseInput } from './validation';

const dataInput = z.record(identifier, z.string());
const createInput = z.strictObject({ data: dataInput, categoryIds: categoryIdsInput.optional() });
const updateInput = z.strictObject({
  data: dataInput, revision: z.int().min(1).max(2147483647), categoryIds: categoryIdsInput.optional(),
});
const revisionInput = updateInput.pick({ revision: true });
const lookupPreviewInput = z.strictObject({ fieldId: identifier, key: z.string().min(1).max(4000) });
const lookupSearchInput = z.strictObject({
  fieldId: identifier, query: z.string().max(200).regex(/^[^\x00\p{Surrogate}]*$/u).default(''),
  recordId: identifier.optional(),
  after: z.string().regex(/^[0-9]{1,19}$/).refine((value) => BigInt(value) <= 9223372036854775807n).optional(),
});
const lookupRefreshInput = revisionInput.extend({ confirmation: z.string().regex(/^[a-f0-9]{64}$/) });
const batchUpdateInput = z.strictObject({
  fieldId: identifier, value: z.string().nullable(),
  items: z.array(revisionInput.extend({ id: identifier })).min(1).max(100)
    .refine((items) => new Set(items.map(({ id }) => id.toLowerCase())).size === items.length),
});
type SingleFieldUpdate = z.infer<typeof batchUpdateInput>['items'][number] & { fieldId: string; value: string | null };
const pageInput = z.strictObject({
  view: identifier.optional(),
  category: identifier.optional(),
  after: z.string().regex(/^[0-9]{1,19}$/).refine((value) => BigInt(value) <= 9223372036854775807n).optional(),
  limit: z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(100)).optional(),
});
const relatedQuery = pageInput.pick({ after: true });
const aggregateQuery = z.strictObject({
  view: identifier.optional(),
  fields: z.string().max(369).transform((value) => value.split(','))
    .pipe(z.array(identifier).max(10).refine((values) => new Set(values).size === values.length)).optional(),
});
const recycleQuery = pageInput.omit({ view: true });
const batchCreateInput = z.strictObject({ items: z.array(createInput).min(1).max(100) });
const historyExportQuery = z.strictObject({ includeArchived: z.enum(['true', 'false']).optional() });
const historyQuery = z.strictObject({ kind: z.string().min(1).max(64).optional(), fieldId: identifier.optional() });
export const recordHttp = { createInput, updateInput, revisionInput, batchUpdateInput, batchCreateInput,
  pageInput, searchInput, aggregateQuery, recycleQuery, historyExportQuery, historyQuery, lookupPreviewInput, lookupRefreshInput, lookupSearchInput, relatedQuery };

const keyPattern = /^[!-~]{1,128}$/;
const createKey = z.string().regex(keyPattern).optional();

@Injectable()
export class RecordService {
  constructor(
    private readonly appSchema: AppSchemaService,
    private readonly authorization: AuthorizationService,
    private readonly query: RecordQueryService,
    private readonly files: FileService,
    private readonly notifications: NotificationPlanner,
  ) {}

  private async normalizeData(
    tx: TenantTransaction, context: TenantContext, appId: string, version: number, data: RecordData,
    existing?: { data: RecordData; fields: Awaited<ReturnType<AppSchemaService['getFields']>> },
  ): Promise<RecordData> {
    const definitions = await this.appSchema.getFields(tx, context, appId, version);
    const fields = new Map(definitions.map((field) => [field.fieldId, field]));
    const errors: { field: string; message: string }[] = [];
    const normalizedData: RecordData = {};
    for (const [fieldId, value] of Object.entries(data)) {
      const field = fields.get(fieldId);
      if (!field) {
        errors.push({ field: fieldId, message: 'Unknown field' });
        continue;
      }
      let normalized: string | undefined;
      if (!isRecordInput(field.type)) {
        errors.push({ field: fieldId, message: 'This field is read-only' });
        continue;
      }
      if (field.type === 'attachment') {
        try {
          const parsed = fileIds.safeParse(JSON.parse(value || '[]'));
          if (parsed.success) normalized = JSON.stringify(parsed.data);
        } catch {
          normalized = undefined;
        }
      } else {
        const current = existing?.fields.find((entry) => entry.fieldId === fieldId);
        const options = current?.options ?? field.options;
        const previous = existing?.data[fieldId];
        const priorChoices: string[] = previous && multiOptionFieldTypes.has(field.type) ? JSON.parse(previous) : previous ? [previous] : [];
        const allowed = options.map((option) => ({ ...option, disabled: option.disabled && !priorChoices.includes(option.value) }));
        normalized = value === '' && field.type !== 'number' ? '' : normalizeValue(field.type, value, allowed);
      }
      if (normalized === undefined || normalized !== existing?.data[fieldId] &&
          !await this.validDirectoryValue(tx, context, field.type, normalized)) {
        errors.push({ field: fieldId, message: `Invalid ${field.type} value` });
      } else {
        normalizedData[fieldId] = normalized;
      }
    }
    for (const field of definitions) {
      const required = existing?.fields.find((entry) => entry.fieldId === field.fieldId)?.required ?? field.required;
      const value = normalizedData[field.fieldId];
      if (required && (!value || ((multiOptionFieldTypes.has(field.type) || field.type === 'attachment') && value === '[]'))) {
        errors.push({ field: field.fieldId, message: 'Required field' });
      }
    }
    if (errors.length) throw new BadRequestException(errors);
    return normalizedData;
  }

  private async validDirectoryValue(tx: TenantTransaction, context: TenantContext, type: string, id: string) {
    if (!id) return true;
    switch (type) {
      case 'user': {
        const [user] = await tx.select({ id: tenantMembers.userId }).from(tenantMembers).where(and(
          eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, id), isNull(tenantMembers.disabledAt),
        ));
        return Boolean(user);
      }
      case 'organization': {
        const [organization] = await tx.select({ id: organizations.id }).from(organizations).where(and(
          eq(organizations.tenantId, context.tenantId), eq(organizations.id, id),
        )).for('key share');
        return Boolean(organization);
      }
      case 'group': {
        const [group] = await tx.select({ id: memberGroups.id }).from(memberGroups).where(and(
          eq(memberGroups.tenantId, context.tenantId), eq(memberGroups.id, id),
        )).for('key share');
        return Boolean(group);
      }
      default: return true;
    }
  }

  async create(context: TenantContext, appId: string, input: z.infer<typeof createInput>, key?: string) {
    return withTenantTransaction(context, async (tx) => {
      const grant = await this.appSchema.writable(tx, context, appId, 'create');
      return this.persistCreate(tx, context, appId, input.data, grant, 'api', key, undefined, input.categoryIds);
    });
  }

  async persistCreate(
    tx: TenantTransaction, context: TenantContext, appId: string, input: RecordData,
    { app, access, fields }: Awaited<ReturnType<AppSchemaService['writable']>>,
    source: 'api' | 'import', key?: string, causation?: EventCausation, categoryIds?: string[],
  ) {
    const schemaVersion = app.publishedSchemaVersion;
    if (categoryIds !== undefined) {
      const configuration = (await this.appSchema.getVersion(tx, context, appId, schemaVersion)).categoryConfiguration;
      assertCategoryAssignments(configuration, categoryIds);
    }
    this.assertEditable(access, input, fields);
    const identity = { tenantId: context.tenantId, appId };
    const counterScope = and(eq(appCounters.tenantId, context.tenantId), eq(appCounters.appId, appId));
    if (key !== undefined) {
      // Serialize key lookup and insertion on the same per-app row used for number allocation.
      await tx.select({ appId: appCounters.appId }).from(appCounters).where(counterScope).for('update');
      const [previous] = await tx.select({ response: recordCreateKeys.response }).from(recordCreateKeys).where(and(
        eq(recordCreateKeys.tenantId, context.tenantId), eq(recordCreateKeys.appId, appId),
        eq(recordCreateKeys.userId, context.userId), eq(recordCreateKeys.key, key),
      ));
      if (previous) {
        await this.findRecord(tx, context, appId, previous.response.id);
        const oldFields = await this.appSchema.getFields(tx, context, appId, previous.response.schemaVersion);
        return this.visibleRecord({ ...access, formulaRefs: formulaReferences(oldFields) }, previous.response);
      }
    }

    const preserved = new Map<string, string>();
    const fieldData: RecordData = { ...input };
    if (source === 'import') {
      for (const field of fields) {
        if (field.autoNumber && Object.hasOwn(fieldData, field.fieldId)) {
          if (fieldData[field.fieldId]) preserved.set(field.fieldId, fieldData[field.fieldId]);
          delete fieldData[field.fieldId];
        }
      }
    }
    const tables = await prepareTableRows(fields, fieldData, new Map(), true, (type, value) =>
      this.validDirectoryValue(tx, context, type, value));
    const data = await this.normalizeData(tx, context, appId, schemaVersion, fieldData);
    for (const field of fields) {
      const config = field.autoNumber;
      const supplied = preserved.get(field.fieldId);
      if (!config || (!config.enabled && supplied === undefined)) continue;
      const scope = numberScope(config, data);
      const number = await assignAutoNumber(tx, context, appId, field.fieldId, config, scope, supplied);
      if (number) data[field.fieldId] = number;
    }
    const references = await this.resolveLookups(tx, context, fields, data);
    calculateFields(fields, data);
    const [counter] = await tx.update(appCounters).set({ lastValue: sql`${appCounters.lastValue} + 1` })
      .where(counterScope).returning({ recordNo: appCounters.lastValue });
    const initial = app.workflowEnabled ? await initialWorkflow(tx, identity) : undefined;
    const [row] = await tx.insert(records).values({
      ...identity, recordNo: counter.recordNo, schemaVersion, data, status: initial?.state.code,
      createdBy: context.userId, updatedBy: context.userId,
    }).returning();
    const record = serializeRecord(row);
    await replaceTableRows(tx, { ...identity, recordId: record.id }, tables.replacements);
    if (categoryIds !== undefined) {
      await replaceRecordCategories(tx, context, appId, record.id, categoryIds);
      record.categoryIds = categoryIds;
    } else {
      const configuration = (await this.appSchema.getVersion(tx, context, appId, schemaVersion)).categoryConfiguration;
      if (configuration.enabled) record.categoryIds = [];
    }
    await this.saveLookupReferences(tx, context, record, references);
    await this.reserveUniqueValues(tx, context, record);
    await this.reconcileFiles(tx, context, record, tables.replacements);
    await projectSearchValues(tx, context, record, fields);
    const eventId = await writeRecordEvent(tx, context, record, 'created', [...fieldChanges({}, data), ...tables.changes], source, undefined, causation);
    if (initial) await attachInitialWorkflow(tx, context.tenantId, record, initial, eventId);
    await this.notifications.recordEvent(tx, context, record, eventId, { source, trigger: 'created', schemaVersion,
      stateCode: initial?.state.code });
    if (key !== undefined) {
      await tx.insert(recordCreateKeys).values({
        ...identity, userId: context.userId, key, recordId: record.id,
        response: { ...record, data: { ...record.data, ...Object.fromEntries(
          [...tables.replacements].map(([id, rows]) => [id, JSON.stringify(rows)]),
        ) } },
      });
    }
    if (source === 'import') return this.visibleRecord(access, record);
    if (access.acl.record.some(({ action }) => action === 'view')) {
      return this.findRecord(tx, context, appId, record.id);
    }
    return this.withTableRows(tx, context, this.visibleRecord(access, record), access);
  }

  // Gate 2 decision (GATE2-REPORT.md): grouped subtable CSV import uses REPLACE
  // semantics per table field present in the file — the file's grouped rows become
  // that table's rows, so an export → import round trip is idempotent.
  async replaceImportedRows(tx: TenantTransaction, context: TenantContext, appId: string, recordNo: string, tables: RecordData) {
    const { access } = await this.appSchema.access(tx, context, appId, 'edit');
    const [entry] = await tx.select({ id: records.id }).from(records).where(and(eq(records.tenantId, context.tenantId),
      eq(records.appId, appId), eq(records.recordNo, BigInt(recordNo)), isNull(records.deletedAt),
      this.authorization.recordScope(access, 'view'), this.authorization.recordScope(access, 'edit')));
    if (!entry) throw new BadRequestException('No visible editable parent matches record number ' + recordNo);
    const current = await this.findRecord(tx, context, appId, entry.id, 'edit', false, true);
    const definitions = await this.appSchema.getFields(tx, context, appId, current.schemaVersion);
    const tableIds = Object.keys(tables);
    const before = await this.readTableRows(tx, context, appId, entry.id, tableIds);
    const candidate: RecordData = {};
    for (const fieldId of tableIds) {
      const table = definitions.find((field) => field.fieldId === fieldId)?.table;
      if (!table || !access.types.has(fieldId)) throw new BadRequestException('The parent record does not use this subtable');
      if (!this.authorization.editable(access, fieldId)) throw new ForbiddenException('无权限');
      const writable = new Set(table.fields.filter(({ type }) => type !== 'calculation').map((field) => field.fieldId));
      const incoming = (JSON.parse(tables[fieldId]) as TableRow[]).map(({ rowId, data }) => ({
        rowId, data: Object.fromEntries(Object.entries(data).filter(([id]) => writable.has(id))),
      }));
      candidate[fieldId] = JSON.stringify(incoming);
    }
    const { replacements, changes } = await prepareTableRows(definitions, candidate, before, false, (type, value) =>
      this.validDirectoryValue(tx, context, type, value));
    const scope = { tenantId: context.tenantId, appId, recordId: entry.id };
    const [updated] = await tx.update(records).set({ revision: sql`${records.revision} + 1`,
      updatedBy: context.userId, updatedAt: sql`clock_timestamp()` }).where(and(eq(records.tenantId, scope.tenantId),
      eq(records.appId, scope.appId), eq(records.id, scope.recordId), eq(records.revision, current.revision))).returning();
    if (!updated) throw new ConflictException('The parent record changed. Run preflight again.');
    await replaceTableRows(tx, scope, replacements);
    await this.reconcileFiles(tx, context, serializeRecord(updated), replacements);
    await writeRecordEvent(tx, context, serializeRecord(updated), 'updated', changes, 'import');
  }

  async get(context: TenantContext, appId: string, recordId: string) {
    return withTenantTransaction(context, (tx) => this.findRecord(tx, context, appId, recordId));
  }

  private async findRecord(
    tx: TenantTransaction, context: TenantContext, appId: string, recordId: string,
    action: RecordAction = 'view', deleted = false, raw = false,
  ) {
    const { access, app } = await this.appSchema.access(tx, context, appId, 'view').catch((error: unknown) => {
      if (error instanceof NotFoundException) throw new NotFoundException();
      throw error;
    });
    const [row] = await tx.select({
      id: records.id, tenantId: records.tenantId, appId: records.appId, recordNo: records.recordNo,
      schemaVersion: records.schemaVersion, revision: records.revision, status: records.status,
      createdAt: records.createdAt, createdBy: records.createdBy, updatedAt: records.updatedAt,
      updatedBy: records.updatedBy, deletedAt: records.deletedAt, deletedBy: records.deletedBy,
      importJobId: records.importJobId, sourceActorId: records.sourceActorId,
      sourceActorName: records.sourceActorName, sourceTimestamp: records.sourceTimestamp,
      sourceRecordNo: records.sourceRecordNo,
      data: raw ? records.data : this.authorization.projection(access),
    }).from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, recordId),
      deleted ? sql`${records.deletedAt} IS NOT NULL` : isNull(records.deletedAt),
      this.authorization.recordScope(access, 'view'),
      action !== 'view' ? this.authorization.recordScope(access, action) : undefined,
    ));
    if (!row) {
      const hasRecordRules = access.acl.record.some((rule) => rule.action === 'view' || rule.action === action);
      throw new NotFoundException(hasRecordRules ? '无权限' : undefined);
    }
    const record = serializeRecord(row);
    // Migration provenance (contracts 4 SS4.5.3): a restored record is visibly
    // marked as migration-sourced, never disguised as locally created.
    if (row.importJobId) {
      record.migration = {
        importJobId: row.importJobId, sourceActorId: row.sourceActorId,
        sourceActorName: row.sourceActorName, sourceTimestamp: row.sourceTimestamp,
        sourceRecordNo: row.sourceRecordNo,
      };
    }
    // P4-T1: categoryIds is an additive response key — present when the
    // app's categories are enabled or the record carries assignments, so
    // applications that never use categories keep the legacy shape.
    // P4 fix batch (C2) semantic lock: absence means "not provided by
    // this compatibility response", never proof of an empty assignment
    // set ([] is the explicit empty set), and the property must never
    // be used as an authorization signal.
    const assignedIds = (await recordCategoryIds(tx, context, appId, [record.id])).get(record.id);
    const categoriesEnabled = (await this.appSchema.getVersion(tx, context, appId, app.publishedSchemaVersion))
      .categoryConfiguration.enabled;
    if (categoriesEnabled || assignedIds?.length) record.categoryIds = assignedIds ?? [];
    return raw || deleted ? record : this.withTableRows(tx, context, record, access);  }

  private async readTableRows(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string, ids: string[]) {
    const result = new Map<string, TableRow[]>();
    if (!ids.length) return result;
    const rows = await tx.select({ fieldId: recordTableRows.fieldId, rowId: recordTableRows.rowId, data: recordTableRows.data })
      .from(recordTableRows).where(and(tableRowScope({ tenantId: context.tenantId, appId, recordId }),
        inArray(recordTableRows.fieldId, ids))).orderBy(recordTableRows.rowOrder);
    for (const { fieldId, ...row } of rows) {
      const existing = result.get(fieldId);
      if (existing) existing.push(row);
      else result.set(fieldId, [row]);
    }
    return result;
  }

  private async withTableRows(tx: TenantTransaction, context: TenantContext, record: RecordResponse, access: RecordAccess) {
    const ids = [...access.types].filter(([id, type]) => type === 'table' &&
      this.authorization.fieldDecision(access, id, 'view').allowed).map(([id]) => id);
    const rows = await this.readTableRows(tx, context, record.appId, record.id, ids);
    for (const id of ids) record.data[id] = JSON.stringify(rows.get(id) ?? []);
    return record;
  }

  private visibleRecord(access: RecordAccess, record: RecordResponse): RecordResponse {
    return { ...record, data: Object.fromEntries(Object.entries(record.data).filter(([id]) =>
      access.types.has(id) && this.authorization.fieldDecision(access, id, 'view').allowed)) };
  }

  private assertEditable(access: RecordAccess, data: RecordData, definitions: FieldDefinition[]) {
    const targets = lookupTargets(definitions);
    for (const id of Object.keys(data)) {
      if (targets.has(id)) throw new BadRequestException([{ field: id, message: 'Lookup snapshot fields are read-only' }]);
      if (!this.authorization.editable(access, id)) throw new ForbiddenException('无权限');
    }
  }

  async update(context: TenantContext, appId: string, recordId: string, input: z.infer<typeof updateInput> | SingleFieldUpdate | { revision: number; lookupFieldId: string; confirmation: string }) {
    return withTenantTransaction(context, (tx) => this.persistUpdate(tx, context, appId, recordId, input));
  }

  // P3-B: transaction-scoped update core shared by the HTTP path and the
  // automation engine, which supplies the delegated grant-approver context
  // plus the causation quintuple for the emitted record event.
  async persistUpdate(tx: TenantTransaction, context: TenantContext, appId: string, recordId: string,
    input: z.infer<typeof updateInput> | SingleFieldUpdate | { revision: number; lookupFieldId: string; confirmation: string },
    causation?: EventCausation) {
      const { app, access, fields } = await this.appSchema.writable(tx, context, appId, 'edit');
      const current = await this.findRecord(tx, context, appId, recordId, 'edit', false, true);
      if (current.revision !== input.revision) this.rejectRevision(this.visibleRecord(access, current));
      const definitions = await this.appSchema.getFields(tx, context, appId, current.schemaVersion);
      const inputTypes = new Map(definitions.map(({ fieldId, type }) => [fieldId, type]));
      let candidate: RecordData;
      if ('lookupFieldId' in input) {
        candidate = { ...current.data };
      } else if ('fieldId' in input) {
        const type = inputTypes.get(input.fieldId);
        if (!type || type === 'table' || !isRecordInput(type)) throw new BadRequestException([{ field: input.fieldId, message: 'Field is not writable in this record version' }]);
        this.assertEditable(access, { [input.fieldId]: input.value ?? '' }, definitions);
        candidate = Object.fromEntries(Object.entries(current.data).filter(([id]) => isRecordInput(inputTypes.get(id))));
        if (input.value === null) delete candidate[input.fieldId];
        else candidate[input.fieldId] = input.value;
      } else {
        this.assertEditable(access, input.data, definitions);
        const retained = Object.fromEntries(Object.entries(current.data).filter(([id]) =>
          !this.authorization.editable(access, id) && isRecordInput(inputTypes.get(id))));
        candidate = { ...retained, ...input.data };
      }
      const targets = lookupTargets(definitions);
      for (const id of targets) delete candidate[id];
      const refresh = 'lookupFieldId' in input ? await this.refreshValues(tx, context, current, definitions, access, input.lookupFieldId) : undefined;
      if (refresh && 'lookupFieldId' in input && input.confirmation !== refresh.confirmation) {
        throw new ConflictException('Lookup values changed. Preview again before confirming.');
      }
      const tableIds = definitions.filter((field) => field.table && Object.hasOwn(candidate, field.fieldId)).map(({ fieldId }) => fieldId);
      const before = await this.readTableRows(tx, context, appId, recordId, tableIds);
      const tables = await prepareTableRows(definitions, candidate, before, false, (type, value) =>
        this.validDirectoryValue(tx, context, type, value));
      const categoryIds = 'data' in input ? (input as z.infer<typeof updateInput>).categoryIds : undefined;
      if (categoryIds !== undefined) {
        const configuration = (await this.appSchema.getVersion(tx, context, appId, app.publishedSchemaVersion)).categoryConfiguration;
        assertCategoryAssignments(configuration, categoryIds);
      }
      const data = refresh ? { ...current.data } :
        await this.normalizeData(tx, context, appId, current.schemaVersion, candidate, { data: current.data, fields });
      const references = refresh ? [] : await this.resolveLookups(tx, context, definitions, data, current.data);
      if (refresh) this.copyLookupValues(refresh.field, refresh.source.data, data);
      for (const [id, value] of Object.entries(current.data)) {
        if (inputTypes.get(id) === 'autoNumber') data[id] = value;
      }
      calculateFields(definitions, data);
      const [row] = await tx.update(records).set({
        data, revision: sql`${records.revision} + 1`, updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
      }).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, recordId),
        eq(records.revision, input.revision), isNull(records.deletedAt),
      )).returning();
      if (!row) this.rejectRevision(await this.findRecord(tx, context, appId, recordId));
      const updated = serializeRecord(row);
      await replaceTableRows(tx, { tenantId: context.tenantId, appId, recordId }, tables.replacements);
      if (categoryIds !== undefined) await replaceRecordCategories(tx, context, appId, recordId, categoryIds);
      await this.saveLookupReferences(tx, context, updated, references);
      await tx.delete(recordUniqueValues).where(this.uniqueValuesScope(context, appId, recordId));
      await this.reserveUniqueValues(tx, context, updated);
      await this.reconcileFiles(tx, context, updated, tables.replacements);
      await projectSearchValues(tx, context, updated, definitions);
      const eventId = await writeRecordEvent(tx, context, updated, refresh ? 'lookup-refetched' : 'updated',
        [...fieldChanges(current.data, data), ...tables.changes], 'api', undefined, causation);
      await this.notifications.recordEvent(tx, context, updated, eventId, {
        source: 'api', trigger: 'updated', schemaVersion: app.publishedSchemaVersion,
      });
      return this.findRecord(tx, context, appId, recordId);
  }

  private copyLookupValues(field: FieldDefinition, source: RecordData, data: RecordData) {
    for (const { sourceFieldId, targetFieldId } of field.lookup!.copies) {
      const value = source[sourceFieldId];
      if (value === undefined) delete data[targetFieldId];
      else data[targetFieldId] = value;
    }
  }

  private async resolveLookups(tx: TenantTransaction, context: TenantContext, fields: FieldDefinition[],
    data: RecordData, previous?: RecordData,
  ) {
    const references: { fieldId: string; targetAppId: string; targetRecordId: string }[] = [];
    for (const field of fields) {
      const config = field.lookup;
      if (!config) continue;
      const key = data[config.localKeyFieldId];
      if (previous?.[config.localKeyFieldId] === key && previous) {
        for (const { targetFieldId } of config.copies) {
          if (previous[targetFieldId] !== undefined) data[targetFieldId] = previous[targetFieldId];
        }
        continue;
      }
      const source = key && await this.query.lookupSource(tx, context, config, { key });
      if (!source && (key || previous?.[config.localKeyFieldId])) {
        throw new BadRequestException([{ field: config.localKeyFieldId, message: 'No visible record matches this lookup key' }]);
      }
      if (!source) continue;
      this.copyLookupValues(field, source.data, data);
      references.push({ fieldId: field.fieldId, targetAppId: config.appId, targetRecordId: source.id });
    }
    return references;
  }

  private async saveLookupReferences(tx: TenantTransaction, context: TenantContext, record: RecordResponse,
    references: { fieldId: string; targetAppId: string; targetRecordId: string }[],
  ) {
    if (!references.length) return;
    const identity = { tenantId: context.tenantId, appId: record.appId, recordId: record.id };
    for (const reference of references) {
      await tx.insert(recordReferences).values({ ...identity, ...reference }).onConflictDoUpdate({
        target: [recordReferences.tenantId, recordReferences.appId, recordReferences.recordId, recordReferences.fieldId],
        set: { targetAppId: reference.targetAppId, targetRecordId: reference.targetRecordId },
      });
    }
  }

  private lookupField(definitions: FieldDefinition[], access: RecordAccess, fieldId: string) {
    const field = definitions.find((field) => field.fieldId === fieldId);
    if (!field?.lookup || !this.authorization.fieldDecision(access, fieldId, 'view').allowed ||
        !this.authorization.editable(access, field.lookup.localKeyFieldId)) throw new NotFoundException('无权限');
    return { ...field, lookup: field.lookup };
  }

  private lookupChanges(definitions: FieldDefinition[], access: RecordAccess, field: FieldDefinition, before: RecordData, source: RecordData) {
    return field.lookup!.copies.filter(({ targetFieldId }) =>
      access.types.has(targetFieldId) && this.authorization.fieldDecision(access, targetFieldId, 'view').allowed)
      .map(({ sourceFieldId, targetFieldId }) => ({
        fieldId: targetFieldId, name: definitions.find(({ fieldId }) => fieldId === targetFieldId)?.name,
        current: before[targetFieldId] ?? null, incoming: source[sourceFieldId] ?? null,
      }));
  }

  async previewLookup(context: TenantContext, appId: string, fieldId: string, rawKey: string, recordId?: string) {
    return withTenantTransaction(context, async (tx) => {
      const { app, access } = await this.appSchema.writable(tx, context, appId, recordId ? 'edit' : 'create');
      const record = recordId ? await this.findRecord(tx, context, appId, recordId, 'edit') : undefined;
      const definitions = await this.appSchema.getFields(tx, context, appId, record?.schemaVersion ?? app.publishedSchemaVersion);
      const field = this.lookupField(definitions, access, fieldId);
      const local = definitions.find(({ fieldId }) => fieldId === field.lookup.localKeyFieldId)!;
      const key = normalizeValue(local.type, rawKey, local.options);
      const source = key && await this.query.lookupSource(tx, context, field.lookup, { key });
      if (!source) throw new BadRequestException('No visible record matches this lookup key');
      return { changes: this.lookupChanges(definitions, access, field, record?.data ?? {}, source.data) };
    });
  }

  async relatedRecords(context: TenantContext, appId: string, recordId: string, fieldId: string, after?: string) {
    return withTenantTransaction(context, async (tx) => {
      const record = await this.findRecord(tx, context, appId, recordId);
      const { access } = await this.appSchema.access(tx, context, appId, 'view');
      const definitions = await this.appSchema.getFields(tx, context, appId, record.schemaVersion);
      const config = definitions.find((field) => field.fieldId === fieldId)?.related;
      if (!config || [fieldId, config.localFieldId].some((id) =>
        !access.types.has(id) || !this.authorization.fieldDecision(access, id, 'view').allowed)) {
        throw new NotFoundException('无权限');
      }
      return this.query.relatedPage(tx, context, config, record.data, after);
    });
  }

  async referenceSearch(context: TenantContext, appId: string, input: z.infer<typeof lookupSearchInput>) {
    return withTenantTransaction(context, async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '1500ms'`);
      const { app, access } = await this.appSchema.writable(tx, context, appId, input.recordId ? 'edit' : 'create');
      const record = input.recordId ? await this.findRecord(tx, context, appId, input.recordId, 'edit') : undefined;
      const fields = await this.appSchema.getFields(tx, context, appId, record?.schemaVersion ?? app.publishedSchemaVersion);
      const { lookup } = this.lookupField(fields, access, input.fieldId);
      return this.query.referencePage(tx, context, lookup.appId, lookup,
        { fieldId: lookup.keyFieldId, value: input.query, prefix: true }, 20, input.after);
    });
  }

  private async refreshValues(tx: TenantTransaction, context: TenantContext, record: RecordResponse,
    definitions: FieldDefinition[], access: RecordAccess, fieldId: string,
  ) {
    const field = this.lookupField(definitions, access, fieldId);
    const [reference] = await tx.select().from(recordReferences).where(and(
      eq(recordReferences.tenantId, context.tenantId), eq(recordReferences.appId, record.appId),
      eq(recordReferences.recordId, record.id), eq(recordReferences.fieldId, fieldId),
    ));
    const source = reference && reference.targetAppId === field.lookup.appId &&
      await this.query.lookupSource(tx, context, field.lookup, { recordId: reference.targetRecordId });
    if (!source) throw new NotFoundException('无权限');
    const changes = this.lookupChanges(definitions, access, field, record.data, source.data);
    const confirmation = createHash('sha256').update(JSON.stringify([
      context.tenantId, context.userId, record.appId, record.id, record.revision, fieldId, source.id, source.revision, changes,
    ])).digest('hex');
    return { field, source, changes, confirmation };
  }

  async previewRefresh(context: TenantContext, appId: string, recordId: string, fieldId: string) {
    return withTenantTransaction(context, async (tx) => {
      const { access } = await this.appSchema.writable(tx, context, appId, 'edit');
      const record = await this.findRecord(tx, context, appId, recordId, 'edit', false, true);
      const definitions = await this.appSchema.getFields(tx, context, appId, record.schemaVersion);
      const { changes, confirmation } = await this.refreshValues(tx, context, record, definitions, access, fieldId);
      return { changes, confirmation, revision: record.revision };
    });
  }

  private async reconcileFiles(tx: TenantTransaction, context: TenantContext, record: RecordResponse,
    replacements?: Map<string, TableRow[]>) {
    const definitions = await this.appSchema.getFields(tx, context, record.appId, record.schemaVersion);
    const attachments = definitions.filter(({ type }) => type === 'attachment').map(({ fieldId }) => ({
      fieldId, ids: JSON.parse(record.data[fieldId] || '[]') as string[],
    }));
    // P4-T2: subtable attachment references are derived from the same row
    // replacement set that rewrites the rows, so references and rows can
    // never drift apart within a write.
    let table: { managedFieldIds: string[]; refs: { fieldId: string; rowId: string; subFieldId: string; fileId: string }[] } | undefined;
    if (replacements) {
      const refs: NonNullable<typeof table>['refs'] = [];
      const managedFieldIds: string[] = [];
      for (const [fieldId, rows] of replacements) {
        const definition = definitions.find((field) => field.fieldId === fieldId);
        const attachmentChildren = definition?.table?.fields.filter(({ type }) => type === 'attachment') ?? [];
        if (!attachmentChildren.length) continue;
        managedFieldIds.push(fieldId);
        for (const row of rows) {
          for (const child of attachmentChildren) {
            const ids = JSON.parse(row.data[child.fieldId] || '[]') as string[];
            for (const fileId of ids) refs.push({ fieldId, rowId: row.rowId, subFieldId: child.fieldId, fileId });
          }
        }
      }
      table = { managedFieldIds, refs };
    }
    if (attachments.length || table?.managedFieldIds.length) {
      await this.files.reconcile(tx, context, record.appId, record.id, attachments, table);
    }
  }

  private uniqueValuesScope(context: TenantContext, appId: string, recordId: string) {
    return and(eq(recordUniqueValues.tenantId, context.tenantId),
      eq(recordUniqueValues.appId, appId), eq(recordUniqueValues.recordId, recordId));
  }

  private async reserveUniqueValues(tx: TenantTransaction, context: TenantContext, record: RecordResponse) {
    const definitions = await this.appSchema.getFields(tx, context, record.appId, record.schemaVersion);
    for (const field of definitions) {
      const value = record.data[field.fieldId];
      if (!field.uniqueValue || !value) continue;
      const normalizedValue = uniqueKey(value);
      // Bound the indexed key in bytes for PostgreSQL's btree entry size.
      if (Buffer.byteLength(normalizedValue) > 1000) {
        throw new BadRequestException([{ field: field.fieldId, message: 'Unique value is too long' }]);
      }
      const identity = { tenantId: context.tenantId, appId: record.appId, fieldId: field.fieldId, normalizedValue };
      const [inserted] = await tx.insert(recordUniqueValues).values({ ...identity, recordId: record.id })
        .onConflictDoNothing().returning({ recordId: recordUniqueValues.recordId });
      if (!inserted) {
        const [holder] = await tx.select({ recordId: recordUniqueValues.recordId }).from(recordUniqueValues).where(and(
          eq(recordUniqueValues.tenantId, identity.tenantId), eq(recordUniqueValues.appId, identity.appId),
          eq(recordUniqueValues.fieldId, identity.fieldId), eq(recordUniqueValues.normalizedValue, normalizedValue),
        ));
        let visibleHolder: string | undefined;
        if (holder) {
          try {
            const visible = await this.findRecord(tx, context, record.appId, holder.recordId);
            if (Object.hasOwn(visible.data, field.fieldId)) visibleHolder = visible.id;
          } catch (error) {
            if (!(error instanceof NotFoundException)) throw error;
          }
        }
        if (!visibleHolder) throw new ForbiddenException('无权限');
        throw new ConflictException({ field: field.fieldId, message: 'Unique value is occupied', recordId: visibleHolder });
      }
    }
  }

  async list(context: TenantContext, appId: string, { after, limit = 50, view, category }: z.infer<typeof pageInput>) {
    return withTenantTransaction(context, async (tx) => {
      const { where, sort, sortValue, numericSort, descending, data, fields } = await this.query.scope(tx, context, appId, view);
      // P4-T1: category filtering is descendant-inclusive and deduplicated
      // (EXISTS over the assignment link table), mirroring kintone.
      const { app } = await this.appSchema.access(tx, context, appId, 'view');
      const configuration = (await this.appSchema.getVersion(tx, context, appId, app.publishedSchemaVersion)).categoryConfiguration;
      let categoryCondition;
      if (category) {
        if (!configuration.enabled || !configuration.nodes.some(({ id }) => id === category)) {
          throw new BadRequestException('Unknown category');
        }
        const ids = [...categorySubtreeIds(configuration, category)];
        categoryCondition = sql`EXISTS (SELECT 1 FROM ${recordCategories} WHERE ${recordCategories.tenantId} = ${records.tenantId}
          AND ${recordCategories.appId} = ${records.appId} AND ${recordCategories.recordId} = ${records.id}
          AND ${recordCategories.categoryId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))`;
      }
      let afterCondition = after === undefined ? undefined : gt(records.recordNo, BigInt(after));
      if (after !== undefined && sort) {
        const [cursor] = await tx.select({ value: sortValue! }).from(records)
          .where(and(where, eq(records.recordNo, BigInt(after))));
        if (!cursor) throw new BadRequestException('Cursor no longer belongs to this view');
        const tieBreaker = afterCondition;
        const value = numericSort ? sql`${cursor.value}::numeric` : sql`${cursor.value}::text`;
        afterCondition = cursor.value === null
          ? sql`(${sort} IS NULL AND ${tieBreaker})`
          : sql`(
            ${sort} ${descending ? sql`<` : sql`>`} ${value}
            OR (${sort} = ${value} AND ${tieBreaker})
            OR ${sort} IS NULL
          )`;
      }
      const order = sort ? [sql`${sort} ${descending ? sql`DESC` : sql`ASC`} NULLS LAST`, records.recordNo]
        : [records.recordNo];
      const rows = await tx.select({
        id: records.id, tenantId: records.tenantId, appId: records.appId, recordNo: records.recordNo,
        schemaVersion: records.schemaVersion, revision: records.revision, status: records.status,
        createdAt: records.createdAt, createdBy: records.createdBy, updatedAt: records.updatedAt,
        updatedBy: records.updatedBy, deletedAt: records.deletedAt, deletedBy: records.deletedBy, data,
      }).from(records).where(and(where, categoryCondition, afterCondition)).orderBy(...order).limit(limit + 1);
      const items = rows.slice(0, limit).map(serializeRecord);
      if (items.length) {
        const categoryMap = await recordCategoryIds(tx, context, appId, items.map(({ id }) => id));
        for (const item of items) {
          const assignedIds = categoryMap.get(item.id);
          if (configuration.enabled || assignedIds?.length) item.categoryIds = assignedIds ?? [];
        }
      }
      const tables = fields.filter(({ type }) => type === 'table');
      if (items.length && tables.length) {
        const counts = await tx.select({
          recordId: recordTableRows.recordId, fieldId: recordTableRows.fieldId, count: sql<string>`count(*)::text`,
        }).from(recordTableRows).where(and(eq(recordTableRows.tenantId, context.tenantId), eq(recordTableRows.appId, appId),
          inArray(recordTableRows.recordId, items.map(({ id }) => id)), inArray(recordTableRows.fieldId, tables.map(({ fieldId }) => fieldId)),
        )).groupBy(recordTableRows.recordId, recordTableRows.fieldId);
        const byRecordField = new Map(counts.map(({ recordId, fieldId, count }) => [recordId + fieldId, count]));
        for (const item of items) {
          for (const { fieldId } of tables) item.data[fieldId] = byRecordField.get(item.id + fieldId) ?? '0';
        }
      }
      return {
        items,
        nextCursor: rows.length > limit ? rows[limit - 1].recordNo.toString() : null,
      };
    });
  }

  async batchCreate(context: TenantContext, appId: string, inputs: z.infer<typeof createInput>[]) {
    const results = [];
    for (const [index, input] of inputs.entries()) {
      try {
        results.push({ index, record: await this.create(context, appId, input) });
      } catch (error) {
        if (!(error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException)) throw error;
        results.push({ index, status: error.getStatus(), error: error.getResponse() });
      }
    }
    return { results };
  }

  async batchUpdate(context: TenantContext, appId: string, { fieldId, value, items }: z.infer<typeof batchUpdateInput>) {
    const results = [];
    for (const [index, item] of items.entries()) {
      const { id } = item;
      try {
        const record = await this.update(context, appId, id, { ...item, fieldId, value });
        results.push({ index, id, status: 200, record });
      } catch (error) {
        if (!(error instanceof BadRequestException || error instanceof ConflictException ||
          error instanceof ForbiddenException || error instanceof NotFoundException)) throw error;
        results.push({ index, id, status: error.getStatus(), error: error.getResponse() });
      }
    }
    return { results };
  }

  async recycleBin(context: TenantContext, appId: string, cursor: { after?: string; limit?: number }) {
    return withTenantTransaction(context, async (tx) => {
      if (!await this.authorization.requireRecycleAccess(tx, context)) throw new ForbiddenException('无权限');
      await this.appSchema.access(tx, context, appId, 'delete');
      const { access } = await this.appSchema.access(tx, context, appId, 'view');
      const limit = cursor.limit ?? 50;
      const rows = await tx.select({ id: records.id, recordNo: records.recordNo, revision: records.revision, deletedAt: records.deletedAt })
        .from(records).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId),
          sql`${records.deletedAt} IS NOT NULL`, this.authorization.recordScope(access, 'view'),
          this.authorization.recordScope(access, 'delete'), cursor.after ? sql`${records.recordNo} > ${cursor.after}::bigint` : undefined,
        )).orderBy(records.recordNo).limit(limit + 1);
      const items = rows.slice(0, limit).map((row) => ({ ...row, recordNo: row.recordNo.toString() }));
      return { items, nextCursor: rows.length > limit ? items.at(-1)!.recordNo : null };
    });
  }

  async changeLifecycle(context: TenantContext, appId: string, id: string, revision: number, restore: boolean) {
    return withTenantTransaction(context, async (tx) => {
      if (restore && !await this.authorization.requireRecycleAccess(tx, context)) throw new ForbiddenException('无权限');
      const { access } = await this.appSchema.writable(tx, context, appId, 'delete');
      const current = await this.findRecord(tx, context, appId, id, 'delete', restore);
      if (current.revision !== revision) this.rejectRevision(current);
      const [row] = await tx.update(records).set({
        revision: sql`${records.revision} + 1`, updatedBy: context.userId, updatedAt: sql`clock_timestamp()`,
        deletedAt: restore ? null : sql`clock_timestamp()`, deletedBy: restore ? null : context.userId,
      }).where(and(
        eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, id), eq(records.revision, revision),
      )).returning();
      if (!row) throw new ConflictException('The record changed');
      const record = serializeRecord(row);
      if (restore) await this.reserveUniqueValues(tx, context, record);
      else await tx.delete(recordUniqueValues).where(this.uniqueValuesScope(context, appId, id));
      await writeRecordEvent(tx, context, record, restore ? 'restored' : 'deleted', []);
      return this.visibleRecord(access, record);
    });
  }

  async form(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      const { access, app, fields: published } = await this.appSchema.access(tx, context, appId, 'view');
      const record = await this.findRecord(tx, context, appId, id);
      const fields = await this.appSchema.getFields(tx, context, appId, record.schemaVersion);
      const matchingActions = await tx.select({
        edit: sql<boolean>`COALESCE(${this.authorization.recordScope(access, 'edit') ?? sql`true`}, false)`,
        delete: sql<boolean>`COALESCE(${this.authorization.recordScope(access, 'delete') ?? sql`true`}, false)`,
      }).from(records).where(and(eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, id)));
      const visible = this.appSchema.formFields(fields.filter(({ fieldId }) => access.types.has(fieldId)).map((field) => ({
        ...field, options: published.find(({ fieldId }) => fieldId === field.fieldId)?.options ?? field.options,
      })), access);
      const formLayout = this.appSchema.visibleLayout(await this.appSchema.layout(tx, context, appId, app.publishedSchemaVersion), visible);
      return { record, fields: visible, formLayout, can: matchingActions[0] };
    });
  }

  async readArchive(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, (tx) => this.archive(tx, context, appId, id));
  }

  private async archive(tx: TenantTransaction, context: TenantContext, appId: string, id: string) {
    const [grant] = await tx.select({ allowed: tenantMembers.canReadArchivedFields }).from(tenantMembers).where(and(
      eq(tenantMembers.tenantId, context.tenantId), eq(tenantMembers.userId, context.userId), isNull(tenantMembers.disabledAt),
    ));
    if (!grant?.allowed) throw new NotFoundException('无权限');
    const { app, access } = await this.appSchema.access(tx, context, appId, 'view');
    const [row] = await tx.select({ data: records.archivedData }).from(records).where(and(
      eq(records.tenantId, context.tenantId), eq(records.appId, appId), eq(records.id, id),
      isNull(records.deletedAt), this.authorization.recordScope(access, 'view'),
    ));
    if (!row) throw new NotFoundException('无权限');
    const definitions = await this.appSchema.archivedDefinitions(tx, context, appId, app.publishedSchemaVersion, Object.keys(row.data));
    return { data: row.data, definitions };
  }

  async history(context: TenantContext, appId: string, id: string, filter: z.infer<typeof historyQuery> = {}) {
    return withTenantTransaction(context, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await this.findRecord(tx, context, appId, id);
      return this.historySnapshot(tx, context, appId, id, filter);
    });
  }

  async historyExport(context: TenantContext, appId: string, id: string, includeArchived: boolean) {
    return withTenantTransaction(context, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await this.appSchema.access(tx, context, appId, 'export');
      const record = await this.findRecord(tx, context, appId, id);
      const archive = includeArchived ? await this.archive(tx, context, appId, id) : undefined;
      const history = await this.historySnapshot(tx, context, appId, id);
      const body = {
        recordId: record.id, recordNo: record.recordNo, recordRevision: record.revision, ...history,
        ...(archive && { archive }),
      };
      return new StreamableFile(Buffer.from(JSON.stringify(body, null, 2) + '\n'), {
        type: 'application/json; charset=utf-8', disposition: 'attachment; filename="record-' + record.recordNo + '-history.json"',
      });
    });
  }

  private async historySnapshot(tx: TenantTransaction, context: TenantContext, appId: string, id: string,
    filter: z.infer<typeof historyQuery> = {}) {
    const { access } = await this.appSchema.access(tx, context, appId, 'view');
    const eventScope = and(eq(recordEvents.tenantId, context.tenantId), eq(recordEvents.appId, appId), eq(recordEvents.recordId, id));
    const versions = await tx.selectDistinct({ version: recordEvents.schemaVersion }).from(recordEvents).where(eventScope);
    const schemas = new Map<number, Awaited<ReturnType<AppSchemaService['getFields']>>>();
    const filters = [];
    const versionFields = new Map<number, Awaited<ReturnType<AppSchemaService['getFields']>>>();
    for (const { version } of versions) {
      versionFields.set(version, await this.appSchema.getFields(tx, context, appId, version));
    }
    const restrictedOldCalculations = new Set([...versionFields.values()].flatMap((fields) => {
      const refs = formulaReferences(fields);
      return [...refs.keys()].filter((fieldId) => !this.authorization.fieldDecision({ ...access, formulaRefs: refs }, fieldId, 'view').allowed);
    }));
    for (const [version, fields] of versionFields) {
      const historic = { ...access, formulaRefs: formulaReferences(fields) };
      const allowed = fields.filter(({ fieldId }) => access.types.has(fieldId) &&
        this.authorization.fieldDecision(historic, fieldId, 'view').allowed);
      schemas.set(version, allowed);
      const oldCalculations = allowed.filter(({ fieldId }) => restrictedOldCalculations.has(fieldId));
      const hideMigrationValues = oldCalculations.length ? sql`AND (${recordEvents.source} <> 'migration' OR
        change.value->>'fieldId' NOT IN (${sql.join(oldCalculations.map(({ fieldId }) => sql`${fieldId}`), sql`,`)}))` : sql``;
      if (allowed.length) filters.push(sql`(${recordEvents.schemaVersion} = ${version} AND change.value->>'fieldId' IN
        (${sql.join(allowed.map(({ fieldId }) => sql`${fieldId}`), sql`,`)}) ${hideMigrationValues})`);
    }
    const visibleChanges = filters.length ? sql<FieldChange[]>`COALESCE((
      SELECT jsonb_agg(change.value ORDER BY change.position)
      FROM jsonb_array_elements(${recordEvents.changes}) WITH ORDINALITY AS change(value, position)
      WHERE ${sql.join(filters, sql` OR `)}
    ), '[]'::jsonb)` : sql<FieldChange[]>`'[]'::jsonb`;
    const events = await tx.select({
      event: {
        eventId: recordEvents.eventId, recordRevision: recordEvents.recordRevision, schemaVersion: recordEvents.schemaVersion,
        occurredAt: recordEvents.occurredAt, actorId: recordEvents.actorId, source: recordEvents.source,
        kind: recordEvents.kind, objectType: recordEvents.objectType, objectId: recordEvents.objectId, changes: visibleChanges,
        importJobId: recordEvents.importJobId, sourceActorId: recordEvents.sourceActorId,
        sourceTimestamp: recordEvents.sourceTimestamp,
      }, name: users.displayName, email: users.email, disabledAt: tenantMembers.disabledAt,
    }).from(recordEvents).innerJoin(users, and(
      eq(users.tenantId, recordEvents.tenantId), eq(users.id, recordEvents.actorId),
    )).innerJoin(tenantMembers, and(
      eq(tenantMembers.tenantId, users.tenantId), eq(tenantMembers.userId, users.id),
    )).where(eventScope).orderBy(recordEvents.recordRevision);
    // Enrich workflow events from the single-source workflow_events side table
    // (the same rows the workflow history view reads) so the record history
    // renders action, from→to state names, reason and assignees inline.
    const workflowDetail = new Map<string, {
      action: string | null; from: string | null; to: string | null; reason: string | null; assigneeIds: string[];
    }>();
    if (events.length) {
      const stateName = (column: typeof workflowEvents.fromStateId | typeof workflowEvents.toStateId) => sql<string | null>`(
        SELECT ${workflowStates.name} FROM ${workflowStates}
        WHERE ${workflowStates.tenantId} = ${workflowEvents.tenantId} AND ${workflowStates.appId} = ${workflowEvents.appId}
          AND ${workflowStates.workflowId} = ${workflowEvents.workflowId} AND ${workflowStates.id} = ${column})`;
      const rows = await tx.select({
        eventId: workflowEvents.eventId, action: workflowActions.name, reason: workflowEvents.reason,
        assigneeIds: workflowEvents.assigneeIds,
        from: stateName(workflowEvents.fromStateId), to: stateName(workflowEvents.toStateId),
      }).from(workflowEvents).leftJoin(workflowActions, and(
        eq(workflowActions.tenantId, workflowEvents.tenantId), eq(workflowActions.appId, workflowEvents.appId),
        eq(workflowActions.workflowId, workflowEvents.workflowId), eq(workflowActions.id, workflowEvents.actionId),
      )).where(and(eq(workflowEvents.tenantId, context.tenantId), eq(workflowEvents.appId, appId),
        inArray(workflowEvents.eventId, events.map(({ event }) => event.eventId))));
      for (const row of rows) workflowDetail.set(row.eventId, row);
    }
    const enriched = events.map(({ event, name, email, disabledAt }) => ({
      ...event, actorLabel: (name ?? email) + (disabledAt ? '（已停用）' : ''),
      ...(event.importJobId ? {
        migration: {
          importJobId: event.importJobId, sourceActorId: event.sourceActorId,
          sourceTimestamp: event.sourceTimestamp,
        },
      } : {}),
      ...(workflowDetail.has(event.eventId) ? { workflow: workflowDetail.get(event.eventId)! } : {}),
    }));
    const filtered = enriched.filter((event) =>
      (!filter.kind || event.kind === filter.kind) &&
      (!filter.fieldId || event.changes.some((change) => change.fieldId === filter.fieldId || change.childFieldId === filter.fieldId)));
    return { events: filtered, schemas: Object.fromEntries(schemas) };
  }

  private rejectRevision(current: RecordResponse): never {
    throw new ConflictException({ code: 'REVISION_CONFLICT', message: 'The record changed', current });
  }
}

@ApiTags('records')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/records')
export class RecordsController {
  constructor(
    private readonly service: RecordService, private readonly queries: RecordQueryService, private readonly search: SearchService,
  ) {}

  @Post()
  @AllowApiToken('create')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Scoped to tenant, user, app and record creation. Retained until physical deletion of the record. A replay returns the original 201 response.',
    schema: { type: 'string', pattern: keyPattern.source },
  })
  create(
    @AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Body() body: unknown, @Headers('idempotency-key') key: unknown,
  ) {
    return this.service.create(context, parseInput(identifier, appId), parseInput(createInput, body), parseInput(createKey, key));
  }

  @Get()
  @AllowApiToken('view')
  list(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    return this.service.list(context, parseInput(identifier, appId), parseInput(pageInput, query));
  }

  @Get(':recordId/related/:fieldId')
  relatedRecords(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Param('fieldId') fieldId: string, @Query() query: unknown,
  ) {
    return this.service.relatedRecords(context, parseInput(identifier, appId), parseInput(identifier, recordId),
      parseInput(identifier, fieldId), parseInput(relatedQuery, query).after);
  }

  @Get('reference-search')
  referenceSearch(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    return this.service.referenceSearch(context, parseInput(identifier, appId), parseInput(lookupSearchInput, query));
  }

  @Post('lookup-preview')
  lookupPreview(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    const input = parseInput(lookupPreviewInput.extend({ recordId: identifier.optional() }), body);
    return this.service.previewLookup(context, parseInput(identifier, appId), input.fieldId, input.key, input.recordId);
  }

  @Get(':recordId/lookups/:fieldId/refresh')
  lookupRefreshPreview(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Param('fieldId') fieldId: string) {
    return this.service.previewRefresh(context, parseInput(identifier, appId), parseInput(identifier, recordId), parseInput(identifier, fieldId));
  }

  @Post(':recordId/lookups/:fieldId/refresh')
  lookupRefresh(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') recordId: string, @Param('fieldId') fieldId: string, @Body() body: unknown) {
    return this.service.update(context, parseInput(identifier, appId), parseInput(identifier, recordId), {
      ...parseInput(lookupRefreshInput, body), lookupFieldId: parseInput(identifier, fieldId),
    });
  }

  @Get('search')
  @AllowApiToken('view')
  searchRecords(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    return this.search.search(context, parseInput(identifier, appId), parseInput(searchInput, query));
  }

  @Get('aggregates')
  @AllowApiToken('view')
  aggregate(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    const { view, fields } = parseInput(aggregateQuery, query);
    return this.queries.aggregate(context, parseInput(identifier, appId), view, fields ?? []);
  }

  @Get('recycle')
  recycle(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    return this.service.recycleBin(context, parseInput(identifier, appId), parseInput(recycleQuery, query));
  }

  @Post('batch')
  @AllowApiToken('create')
  batch(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    const { items } = parseInput(batchCreateInput, body);
    return this.service.batchCreate(context, parseInput(identifier, appId), items);
  }

  @Patch('batch')
  @AllowApiToken('edit')
  batchUpdate(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.service.batchUpdate(context, parseInput(identifier, appId), parseInput(batchUpdateInput, body));
  }

  @Delete(':recordId')
  @AllowApiToken('delete')
  remove(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Body() body: unknown) {
    const { revision } = parseInput(revisionInput, body);
    return this.service.changeLifecycle(context, parseInput(identifier, appId), parseInput(identifier, id), revision, false);
  }

  @Post(':recordId/restore')
  @AllowApiToken('delete')
  restore(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Body() body: unknown) {
    const { revision } = parseInput(revisionInput, body);
    return this.service.changeLifecycle(context, parseInput(identifier, appId), parseInput(identifier, id), revision, true);
  }

  @Get(':recordId/form')
  @AllowApiToken('view')
  form(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string) {
    return this.service.form(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Get(':recordId/archived-fields')
  archivedFields(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string) {
    return this.service.readArchive(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Get(':recordId/history/export')
  @ApiProduces('application/json')
  exportHistory(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Query() query: unknown) {
    const { includeArchived } = parseInput(historyExportQuery, query);
    return this.service.historyExport(context, parseInput(identifier, appId), parseInput(identifier, id), includeArchived === 'true');
  }

  @Get(':recordId/history')
  @AllowApiToken('view')
  history(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string,
    @Query() query: unknown) {
    return this.service.history(context, parseInput(identifier, appId), parseInput(identifier, id),
      parseInput(historyQuery, query ?? {}));
  }

  @Get(':recordId')
  @AllowApiToken('view')
  get(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('recordId') id: string) {
    return this.service.get(context, parseInput(identifier, appId), parseInput(identifier, id));
  }

  @Put(':recordId')
  @AllowApiToken('edit')
  update(
    @AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('recordId') id: string, @Body() body: unknown,
  ) {
    return this.service.update(context, parseInput(identifier, appId), parseInput(identifier, id), parseInput(updateInput, body));
  }
}
