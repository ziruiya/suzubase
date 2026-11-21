import { fieldTypes, type FieldChange, type FieldOption, type RecordData, type RecordResponse, type ViewConfiguration } from '@suzubase/shared-types';
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
