import { sql } from 'drizzle-orm';
import {
  bigint, check, foreignKey, integer, jsonb, pgEnum, pgTable, primaryKey,
  text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';

const tenantId = () => uuid('tenant_id').notNull().references(() => tenants.id);
const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const tenants = pgTable('tenants', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
});

export const users = pgTable('users', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  email: text().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  unique().on(t.tenantId, t.email),
]);

export const tenantMembers = pgTable('tenant_members', {
  tenantId: tenantId(),
  userId: uuid('user_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.userId] }),
  foreignKey({ columns: [t.tenantId, t.userId], foreignColumns: [users.tenantId, users.id] }),
]);

export const draftStatus = pgEnum('draft_status', ['editing', 'validation-failed', 'publishable']);

export const apps = pgTable('apps', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  code: text().notNull(),
  name: text().notNull(),
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
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.version] }),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
]);

export const fieldType = pgEnum('field_type', ['text', 'number']);

export const fields = pgTable('fields', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  fieldId: uuid('field_id').notNull().defaultRandom(),
  introducedIn: integer('introduced_in').notNull(),
  code: text().notNull(),
  name: text().notNull(),
  type: fieldType().notNull(),
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
  data: jsonb().$type<Record<string, string>>().notNull(),
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
