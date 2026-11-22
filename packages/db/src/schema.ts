import { fieldTypes, type AclConfiguration, type ApiTokenAction, type AutoNumberConfiguration, type FieldChange, type FieldOption, type RecordData, type RecordResponse, type ViewConfiguration, type TextSearchMode, type Formula, type LayoutElement, type FieldDefinition, type FormLayout, type IndexPurpose, type FieldType, type LookupConfiguration, type RelatedConfiguration, type TableConfiguration, type NotificationRule, type NotificationDelivery, type WorkflowCondition, type AssigneeSource, type ViewCondition } from '@suzubase/shared-types';
import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgSchema, pgTable, primaryKey, uniqueIndex,
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
  canReadArchivedFields: boolean('can_read_archived_fields').notNull().default(false),
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
  commentsEnabled: boolean('comments_enabled').notNull().default(true),
  workflowEnabled: boolean('workflow_enabled').notNull().default(false),
  adminMemo: text('admin_memo').notNull().default(''),
  archivedAt: time('archived_at'),
  deletedAt: time('deleted_at'),
  activationState: text('activation_state').notNull().default('active'),
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
  fieldEdits: jsonb('field_edits').$type<Record<string, FieldDefinition | null>>().notNull().default(sql`'{}'::jsonb`),
  formLayout: jsonb('form_layout').$type<FormLayout>().notNull().default(sql`'[]'::jsonb`),
  notificationRules: jsonb('notification_rules').$type<NotificationRule[]>().notNull().default(sql`'[]'::jsonb`),
  migrationReport: jsonb('migration_report').$type<unknown>(),
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
  lookup: jsonb().$type<LookupConfiguration>(),
  table: jsonb().$type<TableConfiguration>(),
  related: jsonb().$type<RelatedConfiguration>(),
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
  archivedData: jsonb('archived_data').$type<RecordData>().notNull().default(sql`'{}'::jsonb`),
  schemaVersion: integer('schema_version').notNull(),
  revision: integer().notNull().default(1),
  status: text().notNull().default('active'),
  createdBy: uuid('created_by').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: time('updated_at').notNull().defaultNow(),
  deletedBy: uuid('deleted_by'),
  deletedAt: time('deleted_at'),
  importJobId: uuid('import_job_id'),
  sourceActorId: text('source_actor_id'),
  sourceActorName: text('source_actor_name'),
  sourceTimestamp: time('source_timestamp'),
  sourceRecordNo: text('source_record_no'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  unique().on(t.tenantId, t.appId, t.recordNo),
  foreignKey({ columns: [t.tenantId, t.importJobId], foreignColumns: [importJobs.tenantId, importJobs.id] }),
  check('records_data_object', sql`jsonb_typeof(${t.data}) = 'object'`),
  foreignKey({
    columns: [t.tenantId, t.appId, t.schemaVersion],
    foreignColumns: [appVersions.tenantId, appVersions.appId, appVersions.version],
  }),
  foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.updatedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.deletedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const workflowDefinitions = pgTable('workflow_definitions', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  version: integer().notNull(),
  status: text().$type<'draft' | 'published'>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  unique().on(t.tenantId, t.appId, t.version),
  unique().on(t.tenantId, t.appId, t.id, t.version),
  uniqueIndex('workflow_one_draft').on(t.tenantId, t.appId).where(sql`${t.status} = 'draft'`),
  check('workflow_definition_status', sql`${t.status} IN ('draft', 'published')`),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
]);

export const workflowStates = pgTable('workflow_states', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  id: uuid().notNull(),
  code: text().notNull(),
  name: text().notNull(),
  terminal: boolean().notNull(),
  initial: boolean().notNull(),
  assignees: jsonb().$type<AssigneeSource[]>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.workflowId, t.id] }),
  unique().on(t.tenantId, t.appId, t.workflowId, t.code),
  foreignKey({
    name: 'workflow_states_definition_fk',
    columns: [t.tenantId, t.appId, t.workflowId],
    foreignColumns: [workflowDefinitions.tenantId, workflowDefinitions.appId, workflowDefinitions.id],
  }),
]);

export const workflowActions = pgTable('workflow_actions', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  id: uuid().notNull(),
  name: text().notNull(),
  fromStateId: uuid('from_state_id').notNull(),
  toStateId: uuid('to_state_id').notNull(),
  conditions: jsonb('condition_expr').$type<WorkflowCondition[]>().notNull(),
  assignees: jsonb('assignee_rule').$type<AssigneeSource[]>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.workflowId, t.id] }),
  foreignKey({
    name: 'workflow_actions_from_state_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.fromStateId],
    foreignColumns: [workflowStates.tenantId, workflowStates.appId, workflowStates.workflowId, workflowStates.id],
  }),
  foreignKey({
    name: 'workflow_actions_to_state_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.toStateId],
    foreignColumns: [workflowStates.tenantId, workflowStates.appId, workflowStates.workflowId, workflowStates.id],
  }),
]);

export const recordWorkflowState = pgTable('record_workflow_state', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  workflowVersion: integer('workflow_version').notNull(),
  stateId: uuid('state_id').notNull(),
  revision: integer().notNull(),
  attentionReason: text('attention_reason'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId] }),
  foreignKey({
    name: 'record_workflow_state_record_fk',
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
  foreignKey({
    name: 'record_workflow_state_version_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.workflowVersion],
    foreignColumns: [workflowDefinitions.tenantId, workflowDefinitions.appId, workflowDefinitions.id, workflowDefinitions.version],
  }),
  foreignKey({
    name: 'record_workflow_state_state_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.stateId],
    foreignColumns: [workflowStates.tenantId, workflowStates.appId, workflowStates.workflowId, workflowStates.id],
  }),
  index('record_workflow_state_state_idx').on(t.tenantId, t.appId, t.stateId),
]);

export const workflowAssignments = pgTable('workflow_assignments', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  userId: uuid('user_id').notNull(),
  role: text().notNull(),
  active: boolean().notNull().default(true),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.userId] }),
  foreignKey({
    name: 'workflow_assignments_record_state_fk',
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [recordWorkflowState.tenantId, recordWorkflowState.appId, recordWorkflowState.recordId],
  }),
  foreignKey({
    name: 'workflow_assignments_user_fk',
    columns: [t.tenantId, t.userId],
    foreignColumns: [tenantMembers.tenantId, tenantMembers.userId],
  }),
  index('workflow_assignments_active_user_idx').on(t.tenantId, t.userId).where(sql`${t.active}`),
]);

export const recordTableRows = pgTable('record_table_rows', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  rowId: uuid('row_id').notNull(),
  rowOrder: integer('row_order').notNull(),
  data: jsonb().$type<RecordData>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.fieldId, t.rowId] }),
  unique().on(t.tenantId, t.appId, t.recordId, t.fieldId, t.rowOrder),
  check('record_table_rows_data_object', sql`jsonb_typeof(${t.data}) = 'object'`),
  foreignKey({
    name: 'record_table_rows_record_fk',
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
  foreignKey({
    name: 'record_table_rows_field_fk',
    columns: [t.tenantId, t.appId, t.fieldId],
    foreignColumns: [fields.tenantId, fields.appId, fields.fieldId],
  }),
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

export const recordComments = pgTable('record_comments', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  authorId: uuid('author_id').notNull(),
  body: text().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  deletedAt: time('deleted_at'),
  importJobId: uuid('import_job_id'),
  sourceActorId: text('source_actor_id'),
  sourceActorName: text('source_actor_name'),
  sourceTimestamp: time('source_timestamp'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.id] }),
  foreignKey({
    name: 'record_comments_record_fk',
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
  foreignKey({
    name: 'record_comments_author_fk',
    columns: [t.tenantId, t.authorId],
    foreignColumns: [tenantMembers.tenantId, tenantMembers.userId],
  }),
  foreignKey({ columns: [t.tenantId, t.importJobId], foreignColumns: [importJobs.tenantId, importJobs.id] }),
  index('record_comments_page_idx').on(t.tenantId, t.appId, t.recordId, t.createdAt.desc(), t.id.desc()),
]);

export const commentMentions = pgTable('comment_mentions', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  recordId: uuid('record_id').notNull(),
  commentId: uuid('comment_id').notNull(),
  userId: uuid('user_id').notNull(),
  offset: integer().notNull(),
  length: integer().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.recordId, t.commentId, t.offset] }),
  foreignKey({
    name: 'comment_mentions_comment_fk',
    columns: [t.tenantId, t.appId, t.recordId, t.commentId],
    foreignColumns: [recordComments.tenantId, recordComments.appId, recordComments.recordId, recordComments.id],
  }),
  foreignKey({
    name: 'comment_mentions_user_fk',
    columns: [t.tenantId, t.userId],
    foreignColumns: [tenantMembers.tenantId, tenantMembers.userId],
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
  objectType: text('object_type').notNull().default('record'),
  objectId: uuid('object_id'),
  occurredAt: time('occurred_at').notNull().defaultNow(),
  changes: jsonb().$type<FieldChange[]>().notNull(),
  importJobId: uuid('import_job_id'),
  sourceActorId: text('source_actor_id'),
  sourceTimestamp: time('source_timestamp'),
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

export const workflowEvents = pgTable('workflow_events', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  eventId: uuid('event_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  actionId: uuid('action_id'),
  fromStateId: uuid('from_state_id'),
  toStateId: uuid('to_state_id').notNull(),
  reason: text(),
  assigneeIds: jsonb('assignee_ids').$type<string[]>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.eventId] }),
  foreignKey({
    name: 'workflow_events_record_event_fk',
    columns: [t.tenantId, t.appId, t.eventId],
    foreignColumns: [recordEvents.tenantId, recordEvents.appId, recordEvents.eventId],
  }),
  foreignKey({
    name: 'workflow_events_action_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.actionId],
    foreignColumns: [workflowActions.tenantId, workflowActions.appId, workflowActions.workflowId, workflowActions.id],
  }),
  foreignKey({
    name: 'workflow_events_from_state_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.fromStateId],
    foreignColumns: [workflowStates.tenantId, workflowStates.appId, workflowStates.workflowId, workflowStates.id],
  }),
  foreignKey({
    name: 'workflow_events_to_state_fk',
    columns: [t.tenantId, t.appId, t.workflowId, t.toStateId],
    foreignColumns: [workflowStates.tenantId, workflowStates.appId, workflowStates.workflowId, workflowStates.id],
  }),
]);

export const outbox = pgTable('outbox', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  eventId: uuid('event_id').notNull(),
  topic: text().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  notifications: jsonb().$type<NotificationDelivery[]>().notNull().default(sql`'[]'::jsonb`),
  processedAt: time('processed_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.eventId] }),
  foreignKey({
    columns: [t.tenantId, t.appId, t.eventId],
    foreignColumns: [recordEvents.tenantId, recordEvents.appId, recordEvents.eventId],
  }),
]);

export const notifications = pgTable('notifications', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  sourceType: text('source_type').$type<'RECORD' | 'SYSTEM'>().notNull().default('RECORD'),
  appId: uuid('app_id'),
  recordId: uuid('record_id'),
  eventId: uuid('event_id'),
  userId: uuid('user_id').notNull(),
  ruleKey: text('rule_key').notNull(),
  title: text().notNull(),
  body: text().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  readAt: time('read_at'),
  occurredAt: time('occurred_at').notNull().defaultNow(),
  sourceEventId: uuid('source_event_id'),
  dedupKey: text('dedup_key'),
  eventType: text('event_type'),
  targetRole: text('target_role'),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  emailState: text('email_state').$type<'pending' | 'sent' | 'skipped' | 'failed'>().notNull(),
  emailAttempts: integer('email_attempts').notNull().default(0),
  emailNextAt: time('email_next_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  unique().on(t.tenantId, t.appId, t.eventId, t.userId, t.ruleKey),
  foreignKey({
    name: 'notification_outbox_fk',
    columns: [t.tenantId, t.appId, t.eventId],
    foreignColumns: [outbox.tenantId, outbox.appId, outbox.eventId],
  }),
  foreignKey({
    name: 'notification_record_fk',
    columns: [t.tenantId, t.appId, t.recordId],
    foreignColumns: [records.tenantId, records.appId, records.id],
  }),
  foreignKey({
    name: 'notification_user_fk',
    columns: [t.tenantId, t.userId],
    foreignColumns: [tenantMembers.tenantId, tenantMembers.userId],
  }),
  index('notifications_center_idx').on(t.tenantId, t.userId, t.createdAt.desc(), t.id.desc()),
  index('notifications_email_idx').on(t.tenantId, t.emailNextAt).where(sql`${t.emailState} = 'pending'`),
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
  purgedAt: time('purged_at'),
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
  recordConditions: jsonb('record_conditions').$type<ViewCondition[]>(),
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
  rows: jsonb().$type<{ line: number; data: RecordData; recordNo?: string; lines?: number[] }[]>().notNull(),
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


export const runtimeIndexState = pgEnum('runtime_index_state', ['building', 'available', 'failed']);
export const runtimeIndexes = pgTable('runtime_indexes', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  fieldId: uuid('field_id').notNull(),
  fieldType: fieldType('field_type').$type<FieldType>().notNull(),
  purpose: text().$type<IndexPurpose>().notNull(),
  reason: text().notNull(),
  state: runtimeIndexState().notNull().default('building'),
  requestedBy: uuid('requested_by').notNull(),
  requestedAt: time('requested_at').notNull().defaultNow(),
  availableAt: time('available_at'),
  failureReason: text('failure_reason'),
  problems: jsonb().$type<{ recordNo: string; value: string | null; reason: string }[]>().notNull().default(sql`'[]'::jsonb`),
  problemCount: integer('problem_count').notNull().default(0),
  retireRequested: time('retire_requested'),
  retireReason: text('retire_reason'),
  retiredAt: time('retired_at'),
  lastUsedAt: time('last_used_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.appId, t.fieldId], foreignColumns: [fields.tenantId, fields.appId, fields.fieldId] }),
  foreignKey({ columns: [t.tenantId, t.requestedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  check('runtime_index_purpose', sql`${t.purpose} IN ('filter','sort','search')`),
]);

export const deploymentInstance = pgTable('deployment_instance', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  instanceId: uuid('instance_id').notNull().defaultRandom(),
});

export const exportJobs = pgTable('export_jobs', {
  tenantId: tenantId(),
  appId: uuid('app_id').notNull(),
  id: uuid().notNull().defaultRandom(),
  requestedBy: uuid('requested_by').notNull(),
  status: text().notNull().default('queued'),
  stage: text().notNull().default('queued'),
  progress: jsonb().$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  snapshotCutoff: time('snapshot_cutoff'),
  manifest: jsonb().$type<unknown>(),
  packageSha256: text('package_sha256'),
  packageBytes: integer('package_bytes'),
  error: text(),
  attempts: integer().notNull().default(0),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
  sealedAt: time('sealed_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.appId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.appId], foreignColumns: [apps.tenantId, apps.id] }),
  foreignKey({ columns: [t.tenantId, t.requestedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const importJobs = pgTable('import_jobs', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  createdBy: uuid('created_by').notNull(),
  sourceExportId: text('source_export_id'),
  sourceInstanceId: text('source_instance_id'),
  sourceTenantId: text('source_tenant_id'),
  sourceAppId: text('source_app_id'),
  sourceAppCode: text('source_app_code'),
  packageSha256: text('package_sha256').notNull(),
  packageBytes: integer('package_bytes').notNull(),
  status: text().notNull().default('uploaded'),
  stage: text().notNull().default('uploaded'),
  targetAppId: uuid('target_app_id'),
  duplicateOf: uuid('duplicate_of'),
  duplicateConfirmed: boolean('duplicate_confirmed').notNull().default(false),
  entityMapping: jsonb('entity_mapping').$type<SourceIdMapRow[]>().notNull().default(sql`'[]'::jsonb`),
  userMapping: jsonb('user_mapping').$type<Record<string, string | null>>().notNull().default(sql`'{}'::jsonb`),
  groupMapping: jsonb('group_mapping').$type<Record<string, string | null>>().notNull().default(sql`'{}'::jsonb`),
  organizationMapping: jsonb('organization_mapping').$type<Record<string, string | null>>().notNull().default(sql`'{}'::jsonb`),
  dependencyDecisions: jsonb('dependency_decisions').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  pending: jsonb().$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  completion: text(),
  report: jsonb().$type<unknown>(),
  errorReport: jsonb('error_report').$type<unknown>(),
  error: text(),
  attempts: integer().notNull().default(0),
  executeRequested: boolean('execute_requested').notNull().default(false),
  executeTokenId: uuid('execute_token_id'),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
  activatedAt: time('activated_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.createdBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
  foreignKey({ columns: [t.tenantId, t.targetAppId], foreignColumns: [apps.tenantId, apps.id] }),
]);

export interface SourceIdMapRow {
  objectType: string;
  sourceId: string;
  targetId: string;
  status: 'created' | 'existing';
}

export const migrationAuditLog = pgTable('migration_audit_log', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  importJobId: uuid('import_job_id').notNull(),
  targetAppId: uuid('target_app_id'),
  operatorId: uuid('operator_id').notNull(),
  action: text().notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id'),
  fieldSurface: jsonb('field_surface').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: time('created_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.importJobId], foreignColumns: [importJobs.tenantId, importJobs.id] }),
  foreignKey({ columns: [t.tenantId, t.operatorId], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);

export const migrationTokens = authentication.table('migration_tokens', {
  tenantId: tenantId(),
  id: uuid().notNull().defaultRandom(),
  importJobId: uuid('import_job_id').notNull(),
  targetAppId: uuid('target_app_id'),
  issuedBy: uuid('issued_by').notNull(),
  secretHash: text('secret_hash').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  revokedAt: time('revoked_at'),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.id] }),
  unique().on(t.secretHash),
  foreignKey({ columns: [t.tenantId, t.importJobId], foreignColumns: [importJobs.tenantId, importJobs.id] }),
  foreignKey({ columns: [t.tenantId, t.issuedBy], foreignColumns: [tenantMembers.tenantId, tenantMembers.userId] }),
]);
