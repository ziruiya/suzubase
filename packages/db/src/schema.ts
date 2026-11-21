import { fieldTypes, type AclConfiguration, type ApiTokenAction, type AutoNumberConfiguration, type FieldChange, type FieldOption, type RecordData, type RecordResponse, type ViewConfiguration, type TextSearchMode, type Formula, type LayoutElement } from '@suzubase/shared-types';
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgSchema, pgTable, primaryKey,
  text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const tenants = pgTable('tenants', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  allowAppCreation: boolean('allow_app_creation').notNull().default(false),
  localDrafts: boolean('local_drafts').notNull().default(true),
  timeZone: text('time_zone').notNull().default('Asia/Tokyo'),
  passwordMinimum: integer('password_minimum').notNull().default(12),
  passwordComplexity: boolean('password_complexity').notNull().default(true),
});

export const organizations = pgTable('organizations', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  name: text().notNull(),
  parentId: uuid('parent_id'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.parentId], foreignColumns: [t.tenantId, t.id] }),
]);

export const users = pgTable('users', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  email: text().notNull(),
  loginName: text('login_name'),
  displayName: text('display_name'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  unique().on(t.tenantId, t.email),
  unique().on(t.tenantId, t.loginName),
]);

export const tenantMembers = pgTable('tenant_members', {
  tenantId: tenantId(),
  userId: uuid('user_id').notNull(),
  canManageRecycleBin: boolean('can_manage_recycle_bin').notNull().default(false),
  isAdmin: boolean('is_admin').notNull().default(false),
  disabledAt: time('disabled_at'),
  sessionVersion: integer('session_version').notNull().default(0),
  organizationId: uuid('organization_id'),
  canCreateApps: boolean('can_create_apps').notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.userId] }),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
  foreignKey({ columns: [t.tenantId, t.organizationId], foreignColumns: [organizations.tenantId, organizations.id] }),
]);

export const authentication = pgSchema('authentication');

export const loginCredentials = authentication.table('login_credentials', {
  tenantId: tenantId(),
  userId: uuid('user_id').notNull(),
  email: text().notNull(),
  passwordHash: text('password_hash').notNull(),
  totpSecret: text('totp_secret'),
  totpPendingUntil: time('totp_pending_until'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  totpRecoveryHashes: text('totp_recovery_hashes').array().notNull().default(sql`'{}'`),
  totpFailures: integer('totp_failures').notNull().default(0),
  totpRetryAfter: time('totp_retry_after'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.userId] }),
  unique().on(t.tenantId, t.email),
  index().on(t.email),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const draftStatus = pgEnum('draft_status', ['editing', 'validation-failed', 'publishable']);

export const apps = pgTable('apps', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  code: text().notNull(),
  name: text().notNull(),
  description: text().notNull().default(''),
  icon: text(),
  themeColor: text('theme_color'),
  titleFieldId: uuid('title_field_id'),
  duplicateHint: boolean('duplicate_hint').notNull().default(false),
  numericPrecision: integer('numeric_precision').notNull().default(2),
  attachmentMaxBytes: integer('attachment_max_bytes').notNull().default(1048576),
  attachmentMaxCount: integer('attachment_max_count').notNull().default(5),
  attachmentTypes: jsonb('attachment_types').$type<string[]>().notNull().default(sql`'["image/png","image/jpeg","application/pdf"]'::jsonb`),
  localDrafts: boolean('local_drafts').notNull().default(true),
  adminMemo: text('admin_memo').notNull().default(''),
  archivedAt: time('archived_at'),
  deletedAt: time('deleted_at'),
  createdBy: uuid('created_by').notNull(),
  publishedSchemaVersion: integer('published_schema_version').notNull().default(1),
  draftSchemaVersion: integer('draft_schema_version'),
  draftStatus: draftStatus('draft_status'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  unique().on(t.tenantId, t.code),
  foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  check('apps_draft_pair', sql`(${t.draftSchemaVersion} is null) = (${t.draftStatus} is null)`),
]);

export const appVersions = pgTable('app_versions', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  version: integer().notNull(),
  aclConfiguration: jsonb('acl_configuration').$type<AclConfiguration>().notNull().default(sql`'{"app":[],"record":[],"field":[]}'::jsonb`),
  viewConfiguration: jsonb('view_configuration').$type<ViewConfiguration>().notNull().default(sql`'{"views":[],"defaultId":null}'::jsonb`),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.version] }),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
]);

export const fieldType = pgEnum('field_type', fieldTypes);

export const fields = pgTable('fields', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  fieldId: uuid('field_id').notNull().defaultRandom(),
  introducedIn: integer('introduced_in').notNull(),
  code: text().notNull(),
  name: text().notNull(),
  type: fieldType().notNull(),
  required: boolean().notNull().default(false),
  uniqueValue: boolean('unique_value').notNull().default(false),
  searchMode: text('search_mode').$type<TextSearchMode>(),
  formula: jsonb().$type<Formula>(),
  layoutElement: jsonb('layout_element').$type<LayoutElement>(),
  autoNumber: jsonb('auto_number').$type<AutoNumberConfiguration>(),
  options: jsonb().$type<FieldOption[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.fieldId] }),
  unique().on(t.tenantId, t.appId, t.code),
  foreignKey({
    columns: [t.tenantId, t.appId, t.introducedIn],
    foreignColumns: [appVersions.tenantId, appVersions.appId, appVersions.version],
  }),
]);

export const appCounters = pgTable('app_counters', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  lastValue: bigint('last_value', { mode: 'bigint' }).notNull().default(sql`0`),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId] }),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
]);

export const records = pgTable('records', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  recordNo: bigint('record_no', { mode: 'bigint' }).notNull(),
  data: jsonb().$type<RecordData>().notNull(),
  schemaVersion: integer('schema_version').notNull(),
  revision: integer().notNull().default(1),
  status: text().notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: time('updated_at').notNull().defaultNow(),
  deletedBy: uuid('deleted_by'),
  deletedAt: time('deleted_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  unique().on(t.tenantId, t.appId, t.recordNo),
  check('records_data_object', sql`jsonb_typeof(${t.data}) = 'object'`),
  foreignKey({
    columns: [t.tenantId, t.appId, t.schemaVersion],
    foreignColumns: [appVersions.tenantId, appVersions.appId, appVersions.version],
  }),
  foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.updatedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.deletedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const recordReferences = pgTable('record_references', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  targetAppId: uuid('target_app_id').notNull(),
  targetRecordId: uuid('target_record_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.fieldId] }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.fieldId],
    foreignColumns: [fields.tenantId, fields.appId, fields.fieldId],
  }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
  foreignKey({
    name: 'record_references_target_fk',
    columns: [t.tenantId, t.targetAppId, t.targetRecordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
]);

export const recordEvents = pgTable('record_events', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  eventId: uuid('event_id').notNull().defaultRandom(),
  recordId: uuid('record_id').notNull(),
  recordRevision: integer('record_revision').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  actorId: uuid('actor_id').notNull(),
  source: text().notNull(),
  kind: text().notNull(),
  occurredAt: time('occurred_at').notNull().defaultNow(),
  changes: jsonb().$type<FieldChange[]>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.eventId] }),
  unique().on(t.tenantId, t.appId, t.recordId, t.recordRevision),
  foreignKey({
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.schemaVersion],
    foreignColumns: [appVersions.tenantId, appVersions.appId, appVersions.version],
  }),
  foreignKey({ columns: [t.tenantId, t.actorId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const outbox = pgTable('outbox', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  eventId: uuid('event_id').notNull(),
  topic: text().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  processedAt: time('processed_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.eventId] }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.eventId],
    foreignColumns: [recordEvents.tenantId, recordEvents.appId, recordEvents.eventId],
  }),
]);

export const recordCreateKeys = pgTable('record_create_keys', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  userId: uuid('user_id').notNull(),
  key: text().notNull(),
  recordId: uuid('record_id').notNull(),
  response: jsonb().$type<RecordResponse>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.userId, t.key] }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }).onDelete('cascade'),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const memberGroups = pgTable('member_groups', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  name: text().notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.id] })]);

export const groupMembers = pgTable('group_members', {
  tenantId: tenantId(),
  groupId: uuid('group_id').notNull(),
  userId: uuid('user_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.groupId, t.userId] }),
  foreignKey({ columns: [t.tenantId, t.groupId], foreignColumns: [memberGroups.tenantId, memberGroups.id] }),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const recordUniqueValues = pgTable('record_unique_values', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  normalizedValue: text('normalized_value').notNull(),
  recordId: uuid('record_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.fieldId, t.normalizedValue] }),
  index().on(t.tenantId, t.appId, t.recordId),
  foreignKey({ columns: [t.tenantId, t.appId, t.fieldId], foreignColumns: [fields.tenantId, fields.appId, fields.fieldId] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.recordId], foreignColumns: [records.tenantId, records.appId, records.id] }),
]);

export const fileState = pgEnum('file_state', ['TEMPORARY', 'READY', 'ATTACHED', 'DELETED']);

export const files = pgTable('files', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  uploadedBy: uuid('uploaded_by').notNull(),
  name: text().notNull(),
  contentType: text('content_type').notNull(),
  bytes: integer().notNull(),
  sha256: text(),
  state: fileState().notNull().default('TEMPORARY'),
  referenceCount: integer('reference_count').notNull().default(0),
  createdAt: time('created_at').notNull().defaultNow(),
  deletedAt: time('deleted_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
  foreignKey({ columns: [t.tenantId, t.uploadedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  check('file_reference_count_nonnegative', sql`${t.referenceCount} >= 0`),
]);

export const fileReferences = pgTable('file_references', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  fileId: uuid('file_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.fieldId, t.fileId] }),
  index().on(t.tenantId, t.appId, t.fileId),
  foreignKey({ columns: [t.tenantId, t.appId, t.recordId], foreignColumns: [records.tenantId, records.appId, records.id] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.fieldId], foreignColumns: [fields.tenantId, fields.appId, fields.fieldId] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.fileId], foreignColumns: [files.tenantId, files.appId, files.id] }),
]);

export const permissionAudit = pgTable('permission_audit', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  actorId: uuid('actor_id').notNull(),
  targetUserId: uuid('target_user_id').notNull(),
  recordId: uuid('record_id'),
  occurredAt: time('occurred_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
  foreignKey({ columns: [t.tenantId, t.actorId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.targetUserId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const autoNumberCounters = pgTable('auto_number_counters', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  scope: text().notNull(),
  nextValue: bigint('next_value', { mode: 'bigint' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.fieldId, t.scope] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.fieldId], foreignColumns: [fields.tenantId, fields.appId, fields.fieldId] }),
]);

export const issuedAutoNumbers = pgTable('issued_auto_numbers', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  scope: text().notNull(),
  number: bigint({ mode: 'bigint' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.fieldId, t.scope, t.number] }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.fieldId, t.scope],
    foreignColumns: [autoNumberCounters.tenantId, autoNumberCounters.appId, autoNumberCounters.fieldId, autoNumberCounters.scope],
  }),
]);

export const recordSearchValues = pgTable('record_search_values', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  kind: text().notNull(),
  value: text().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.fieldId, t.kind] }),
  index('record_search_values_prefix_idx').on(t.tenantId, t.appId, t.fieldId, t.kind, t.value.op('text_pattern_ops')),
  foreignKey({ columns: [t.tenantId, t.appId, t.recordId], foreignColumns: [records.tenantId, records.appId, records.id] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.fieldId], foreignColumns: [fields.tenantId, fields.appId, fields.fieldId] }),
]);

export const csvJobs = pgTable('csv_jobs', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  userId: uuid('user_id').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  rows: jsonb().$type<{ line: number; data: RecordData }[]>().notNull(),
  headers: jsonb().$type<string[]>().notNull(),
  errors: jsonb().$type<{ line: number; cells: string[]; issues: unknown[] }[]>().notNull(),
  lookupColumns: jsonb('lookup_columns').$type<string[]>().notNull(),
  imported: integer().notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.schemaVersion], foreignColumns: [appVersions.tenantId, appVersions.appId, appVersions.version] }),
]);

export const apiTokens = authentication.table('api_tokens', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  issuedBy: uuid('issued_by').notNull(),
  label: text().notNull(),
  secretHash: text('secret_hash').notNull(),
  actions: jsonb().$type<ApiTokenAction[]>().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  revokedAt: time('revoked_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  unique().on(t.secretHash),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
  foreignKey({ columns: [t.tenantId, t.issuedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);
