import type { OpenAPIObject, OperationObject, ParameterObject, ResponseObject, SchemaObject } from '@nestjs/swagger';
import { apiTokenActions, fieldTypes, indexPurposes, textSearchModes } from '@suzubase/shared-types';
import { z } from 'zod';
import { appHttp } from './app-schema';
import { authHttp } from './identity';
import { notificationHttp, systemNotificationHttp } from './notifications';
import { commentHttp } from './comments';
import { csvHttp } from './csv';
import { fileHttp } from './files';
import { recordHttp } from './records';
import { indexHttp } from './runtime-indexes';
import { tenantHttp } from './tenant-admin';
import { workflowRuntimeHttp } from './workflow-runtime';
import { workflowHttp } from './workflow-definitions';
import { tokenHttp } from './api-tokens';
import { formulaInput } from './formula';
import { importHttp, importHttp2, importHttp3 } from './import';
import { identifier } from './validation';

const id = identifier;
const text = z.string();
const integer = z.int();
const flag = z.boolean();
const timestamp = text.describe('PostgreSQL timestamp with time zone');
const dateOrNull = timestamp.nullable();
const nullableId = id.nullable();
const recordNo = text.regex(/^[0-9]+$/);
const tenantId = z.object({ tenantId: id });
const appId = tenantId.extend({ appId: id });
const result = (name: string) => z.object({ [name]: z.literal(true) });
const field = z.object({
  fieldId: id, code: text, name: text, type: z.enum(fieldTypes), required: flag, uniqueValue: flag,
  options: z.array(appHttp.option), formula: formulaInput.nullable(), layoutElement: appHttp.layoutInput.nullable(),
  lookup: appHttp.lookupInput.nullable().optional(),
  related: appHttp.relatedInput.nullable().optional(),
  table: appHttp.tableInput.nullable().optional(),
  autoNumber: appHttp.numbering.nullable(), searchMode: z.enum(textSearchModes).nullable(),
});
const formField = field.extend({ editable: flag });
const viewConfiguration = z.object({
  views: z.array(appHttp.viewInput.extend({ id })), defaultId: nullableId,
});
const versionedViews = viewConfiguration.extend({ version: integer });
const acl = z.object({
  app: z.array(appHttp.aclInput.shape.app.element.extend({ id })),
  record: z.array(appHttp.aclInput.shape.record.element.extend({ id })),
  field: z.array(appHttp.aclInput.shape.field.element.extend({ id })),
});
const grant = z.object({ allowed: flag, matched: z.array(text), allowedRecords: recordNo.optional() });
const preview = z.object({
  app: z.record(text, grant), record: z.record(text, grant), fields: z.record(text, z.record(text, grant)), matchedRecords: recordNo.optional(),
});
const appSummary = z.object({ id, name: text, code: text, description: text, archivedAt: dateOrNull, deletedAt: dateOrNull });
const draftStatus = z.enum(['editing', 'validation-failed', 'publishable']).nullable();
const app = appSummary.extend({
  tenantId: id, icon: text.nullable(), themeColor: text.nullable(), titleFieldId: nullableId, duplicateHint: flag,
  numericPrecision: integer, attachmentMaxBytes: integer, attachmentMaxCount: integer, attachmentTypes: z.array(text),
  localDrafts: flag, adminMemo: text, createdBy: id, publishedSchemaVersion: integer,
  draftSchemaVersion: integer.nullable(), draftStatus,
});
const migrationIssue = z.looseObject({
  fieldId: text.optional(), recordNo: recordNo.optional(), value: text.nullable().optional(), reason: text,
});
const migrationReport = z.object({
  strategy: z.object({ incompatible: z.enum(['reject', 'clear-optional']) }), actorId: id, occurredAt: timestamp,
  migrated: integer, failed: integer, incompatibleValues: z.array(migrationIssue),
});
const publishConflict = z.looseObject({
  message: text, appId: id.optional(), version: integer.optional(), problems: z.array(migrationIssue).optional(),
  migrationRequired: flag.optional(), skippedDependencies: z.array(text).optional(),
});
const publishedApp = appSummary.omit({ deletedAt: true }).extend({
  icon: text.nullable(), themeColor: text.nullable(), titleFieldId: nullableId, localDrafts: flag, schemaVersion: integer,
  commentsEnabled: flag, workflowStates: z.array(z.object({ code: text, name: text })),
  fields: z.array(formField), formLayout: appHttp.formLayoutInput,
  can: z.object({ edit: flag, delete: flag, create: flag, manage: flag, export: flag }),
  ...viewConfiguration.shape,
});
const draft = z.object({
  version: integer.nullable(), status: draftStatus, autoNumberHelp: text,
  fields: z.array(field), publishedFields: z.array(field), formLayout: appHttp.formLayoutInput, ...viewConfiguration.shape,
});
const choice = z.object({ id, name: text });
const selectors = z.object({ user: z.array(choice.extend({ disabled: flag })), organization: z.array(choice), group: z.array(choice) });
const data = z.record(text, text).describe('Values keyed by field UUID. Numeric values are canonical decimal strings.');
const record = z.object({
  id, appId: id, recordNo, data, schemaVersion: integer, revision: integer, status: text,
  createdBy: id, createdAt: timestamp, updatedBy: id, updatedAt: timestamp,
});
const revisionConflict = z.looseObject({ code: z.literal('REVISION_CONFLICT'), message: text, current: record });
const recordForm = z.object({
  record, fields: z.array(formField), formLayout: appHttp.formLayoutInput, can: z.object({ edit: flag, delete: flag }),
});
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: recordNo.nullable() });
const recycle = z.object({ id, recordNo, revision: integer, deletedAt: timestamp });
const rowIssue = z.object({ field: text, message: text });
const errorSchema = z.looseObject({
  statusCode: integer.optional(), error: text.optional(),
  message: z.union([text, z.array(text), z.array(rowIssue)]).optional(),
});
const rowError = z.union([text, errorSchema]);
const batch = z.object({
  results: z.array(z.union([z.object({ index: integer, record }), z.object({ index: integer, status: integer, error: rowError })])),
});
const batchUpdate = z.object({
  results: z.array(z.union([
    z.object({ index: integer, id, status: z.literal(200), record }),
    z.object({ index: integer, id, status: integer, error: rowError }),
  ])),
});
const search = z.object({
  count: recordNo, items: z.array(record.pick({ id: true, recordNo: true, data: true, revision: true, schemaVersion: true })),
  databaseRoundTripMs: z.number().optional(),
});
const aggregates = z.object({
  count: recordNo, fields: z.array(z.object({ fieldId: id, sum: text.nullable(), average: text.nullable() })),
});
const archive = z.object({ data, definitions: z.record(text, field) });
const history = z.object({
  schemas: z.record(text, z.array(field)),
  events: z.array(z.object({
    eventId: id, recordRevision: integer, schemaVersion: integer, occurredAt: timestamp, actorId: id,
    actorLabel: text, source: text, kind: text, objectType: text, objectId: nullableId,
    workflow: z.object({ action: text.nullable(), from: text.nullable(), to: text.nullable(),
      reason: text.nullable(), assigneeIds: z.array(id) }).optional(),
    changes: z.array(z.object({ fieldId: id, rowId: id.optional(), childFieldId: id.optional(),
      rowChange: z.enum(['added', 'removed', 'moved']).optional(), oldValue: text.nullable(), newValue: text.nullable() })),
  })),
});
const historyExport = history.extend({ recordId: id, recordNo, recordRevision: integer, archive: archive.optional() });
const settings = z.object({
  id, name: text, allowAppCreation: flag, localDrafts: flag, timeZone: text, passwordMinimum: integer, passwordComplexity: flag,
});
const user = z.object({ id, email: text, loginName: text.nullable(), displayName: text.nullable() });
const grants = z.object({ canManageRecycleBin: flag, canReadArchivedFields: flag, isAdmin: flag });
const profile = user.pick({ email: true, displayName: true }).extend({
  tenantId: id, userId: id, ...grants.shape, canCreateApps: flag, allowAppCreation: flag, localDrafts: flag,
  timeZone: text, localDraftLogout: z.literal('clear'), draftExpiryHours: integer,
});
const organization = tenantId.extend({ id, name: text, parentId: nullableId });
const group = tenantId.extend({ id, name: text });
const directory = z.object({
  settings, members: z.array(user.extend({ ...grants.shape, label: text, disabledAt: dateOrNull, organizationId: nullableId })),
  organizations: z.array(organization), groups: z.array(group), groupMembers: z.array(tenantId.extend({ groupId: id, userId: id })),
});
const file = z.object({ id, state: z.literal('READY'), name: text, bytes: integer, sha256: text });
const importJob = z.object({
  id, schemaVersion: integer, eligible: integer, failed: integer, imported: integer, remaining: integer,
  eligibleRows: integer, importedRows: integer,
  lookupColumns: z.array(text),
  errorReport: z.array(z.object({ line: integer, issues: z.array(z.union([errorSchema, z.object({ column: text, message: text })])) })),
});
const token = z.object({
  id, label: text, actions: z.array(z.enum(apiTokenActions)), createdAt: timestamp, issuedBy: id, revokedAt: dateOrNull,
});
const runtimeIndex = appId.extend({
  id, fieldId: id, fieldType: z.enum(fieldTypes), purpose: z.enum(indexPurposes), reason: text,
  state: z.enum(['building', 'available', 'failed']), requestedBy: id, requestedAt: timestamp, availableAt: dateOrNull,
  failureReason: text.nullable(), problems: z.array(z.object({ recordNo, value: text.nullable(), reason: text })),
  problemCount: integer, retireRequested: dateOrNull, retireReason: text.nullable(), retiredAt: dateOrNull, lastUsedAt: dateOrNull,
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Media = 'application/json' | 'application/octet-stream' | 'application/zip' | 'text/csv';
type Contract = {
  reply?: z.ZodType;
  body?: z.ZodType;
  query?: z.ZodType;
  status?: number;
  optionalBody?: boolean;
  description?: string;
  conflict?: z.ZodType;
  download?: Media[];
  binaryBody?: boolean;
};

const exportJob = z.object({
  id, appId: id, status: z.enum(['queued', 'running', 'sealed', 'failed', 'cancelled']),
  stage: text, progress: z.record(text, integer), snapshotCutoff: timestamp.nullable(),
  attempts: integer, error: text.nullable(), packageSha256: text.nullable(), packageBytes: integer.nullable(),
  createdAt: timestamp, updatedAt: timestamp, sealedAt: timestamp.nullable(), sensitiveDataNotice: text,
});
const exportDetail = exportJob.extend({ manifest: z.looseObject({}).nullable() });

const migrationJob = z.object({
  id, status: z.enum(['uploaded', 'staging', 'ready', 'activated', 'failed', 'cancelled']),
  stage: text, completion: z.enum(['complete', 'pending']).nullable(),
  sourceExportId: text.nullable(), sourceInstanceId: text.nullable(), sourceTenantId: nullableId,
  sourceAppId: nullableId, sourceAppCode: text.nullable(), packageSha256: text, packageBytes: integer,
  targetAppId: nullableId, duplicateOf: nullableId, duplicateConfirmed: flag,
  userMapping: z.record(text, text), groupMapping: z.record(text, text),
  organizationMapping: z.record(text, text), dependencyDecisions: z.looseObject({}),
  pending: z.looseObject({}), entityMapping: z.array(z.looseObject({})),
  attempts: integer, error: text.nullable(), report: z.looseObject({}).nullable(),
  errorReport: z.looseObject({}).nullable(),
  createdAt: timestamp, updatedAt: timestamp, activatedAt: timestamp.nullable(),
  sensitiveDataNotice: text,
});
const migrationAuditEntry = z.object({
  id, action: text, objectType: text, objectId: text.nullable(),
  fieldSurface: z.array(text), createdAt: timestamp,
});

const applications = '/apps/{appId}';
const records = applications + '/records';
const entry = records + '/{recordId}';
const tenant = '/tenant';
const csv = applications + '/csv';
const views = applications + '/draft/views';
const indexes = applications + '/indexes';
const contracts: Record<string, Partial<Record<Method, Contract>>> = {
  '/health': { get: { reply: z.object({ status: z.literal('ok'), database: z.literal('connected') }) } },
  '/auth/login': { post: { status: 200, body: authHttp.loginInput, description: 'Supply exactly one email or login name. Supply a factor after a two-factor challenge.',
    reply: z.union([z.object({ accessToken: text, expiresIn: integer }), z.object({ secondFactorRequired: z.literal(true) })]) } },
  '/auth/profile': { get: { reply: profile } },
  '/auth/totp': { get: { reply: z.object({ enabled: flag }) } },
  '/auth/totp/enrollment': { post: { body: authHttp.enrollTotpInput, reply: z.object({ secret: text, expiresIn: integer }) } },
  '/auth/totp/enable': { post: { body: authHttp.changeTotpInput, reply: z.object({ enabled: z.literal(true), recoveryCodes: z.array(text).length(10) }),
    description: 'Enables two-factor authentication and revokes previous sessions. Store the one-time recovery codes before leaving this screen.' } },
  '/auth/totp/disable': { post: { body: authHttp.changeTotpInput, reply: z.object({ enabled: z.literal(false) }) } },
  '/apps': {
    get: { query: z.object({ bin: appHttp.binQuery }), reply: z.array(appSummary) },
    post: { body: appHttp.createAppInput, reply: app, conflict: errorSchema },
  },
  [applications]: { get: { reply: publishedApp }, delete: { reply: app, conflict: errorSchema } },
  [applications + '/settings']: { get: { reply: app }, patch: { body: appHttp.settingsInput, reply: app, conflict: errorSchema } },
  [applications + '/lifecycle']: { post: { body: appHttp.lifecycleInput, reply: app, conflict: errorSchema } },
  [applications + '/copy']: { post: { body: appHttp.appInput, reply: app, conflict: errorSchema } },
  [applications + '/selector-options']: { get: { reply: selectors } },
  [applications + '/fields']: { post: { body: appHttp.fieldInput, reply: field.extend({ tenantId: id, appId: id, introducedIn: integer }), conflict: errorSchema } },
  [applications + '/draft']: { get: { reply: draft } },
  [applications + '/draft/fields/{fieldId}']: {
    patch: { body: appHttp.fieldPatch, reply: field, conflict: errorSchema },
    delete: { reply: z.object({ fieldId: id, deleted: z.literal(true) }) },
  },
  [applications + '/draft/layout']: { put: { body: appHttp.formLayoutInput, reply: z.object({ version: integer, formLayout: appHttp.formLayoutInput }) } },
  [applications + '/rollback-display']: { post: { reply: app, conflict: errorSchema } },
  [views]: { post: { body: appHttp.viewInput, reply: versionedViews } },
  [views + '/default']: { put: { body: appHttp.defaultViewInput, reply: versionedViews } },
  [views + '/{viewId}']: { put: { body: appHttp.viewInput, reply: versionedViews }, delete: { reply: versionedViews } },
  [applications + '/draft/acl']: { get: { reply: acl }, put: { body: appHttp.aclInput, reply: acl } },
  [applications + '/permissions/preview']: { post: { body: appHttp.previewInput, reply: preview,
    description: 'Evaluate a published record, a bounded set of matching records, or application permissions. Preview calls are audited.' } },
  [applications + '/notification-rules']: {
    get: { reply: z.object({ published: z.array(notificationHttp.ruleInput), draft: z.array(notificationHttp.ruleInput).nullable(),
      actions: z.array(choice), states: z.array(z.object({ code: text, name: text })), directory: selectors }) },
    put: { body: notificationHttp.rulesInput, reply: notificationHttp.rulesInput },
  },
  '/notifications': { get: { query: notificationHttp.centerFilter, reply: notificationHttp.centerReply } },
  '/notifications/unread': { get: { query: notificationHttp.appFilter, reply: z.object({ count: recordNo }) } },
  '/notifications/read-all': { post: { query: notificationHttp.appFilter, reply: result('read') } },
  '/notifications/system/deliver': { post: {
    body: systemNotificationHttp.systemNotificationInput,
    reply: z.object({ delivered: integer, inserted: integer }),
  } },
  '/notifications/{id}/read': { post: { reply: result('read') } },
  '/notifications/{id}/open': { post: { reply: z.object({ appId: id.nullable(), recordId: id.nullable() }) } },
  [applications + '/workflow/directory']: { get: { reply: selectors } },
  [applications + '/workflow']: { get: { reply: workflowHttp.settings } },
  [applications + '/workflow/versions/{version}']: { get: { reply: workflowHttp.definition } },
  [applications + '/workflow/draft']: { put: { body: workflowHttp.graphInput, reply: workflowHttp.definition } },
  [applications + '/workflow/publish']: { post: { reply: workflowHttp.definition, conflict: errorSchema } },
  [applications + '/workflow/enabled']: { patch: { body: workflowHttp.enabledInput, reply: workflowHttp.enabledInput, conflict: errorSchema } },
  [applications + '/publish']: { post: { body: appHttp.publishInput, optionalBody: true,
    reply: app.extend({ migrationReport: migrationReport.optional(), skippedDependencies: z.array(text), resolvedDependencies: z.array(z.looseObject({ fieldId: text, dependency: text, reason: text })) }), conflict: publishConflict } },
  [records]: { get: { query: recordHttp.pageInput, reply: page(record) }, post: { body: recordHttp.createInput, reply: record, conflict: errorSchema } },
  [entry + '/comments']: {
    get: { query: commentHttp.listQuery, reply: commentHttp.page },
    post: { body: commentHttp.createInput, reply: z.object({ id, createdAt: timestamp, eventId: id, revision: integer }) },
  },
  [entry + '/comments/mention-options']: { get: { reply: z.array(choice.extend({ disabled: flag })) } },
  [entry + '/comments/{commentId}']: { delete: { reply: result('deleted').extend({ eventId: id, revision: integer }) } },
  [entry + '/workflow']: { get: { reply: z.object({ workflow: workflowRuntimeHttp.runtimeSummary.nullable() }) } },
  [entry + '/workflow/actions']: { post: { body: workflowRuntimeHttp.executeInput, reply: workflowRuntimeHttp.mutation, conflict: errorSchema } },
  [entry + '/workflow/reassign']: { post: { body: workflowRuntimeHttp.reassignInput, reply: workflowRuntimeHttp.mutation, conflict: errorSchema } },
  [entry + '/workflow/handoff']: { post: { body: workflowRuntimeHttp.handoffInput, reply: workflowRuntimeHttp.mutation, conflict: errorSchema } },
  [entry + '/workflow/repair']: { post: { body: workflowRuntimeHttp.repairInput, reply: workflowRuntimeHttp.mutation, conflict: errorSchema } },
  [entry + '/workflow/history']: { get: { reply: workflowRuntimeHttp.history } },
  '/workflow/tasks': { get: { query: workflowRuntimeHttp.taskQuery, reply: workflowRuntimeHttp.taskPage } },
  '/workflow/unassigned': { get: { query: workflowRuntimeHttp.taskQuery, reply: workflowRuntimeHttp.taskPage } },
  [entry + '/related/{fieldId}']: { get: { query: recordHttp.relatedQuery, reply: z.object({
    columns: z.array(z.object({ fieldId: id, name: text })), items: z.array(data), next: recordNo.nullable(), count: text,
  }) } },
  [records + '/reference-search']: { get: { query: recordHttp.lookupSearchInput, reply: z.object({
    columns: z.array(z.object({ fieldId: id, name: text })), items: z.array(data), next: recordNo.nullable(),
  }) } },
  [records + '/lookup-preview']: { post: { body: recordHttp.lookupPreviewInput.extend({ recordId: id.optional() }),
    reply: z.object({ changes: z.array(z.object({ fieldId: id, name: text, current: text.nullable(), incoming: text.nullable() })) }) } },
  [entry + '/lookups/{fieldId}/refresh']: {
    get: { reply: z.object({ revision: integer, confirmation: text,
      changes: z.array(z.object({ fieldId: id, name: text, current: text.nullable(), incoming: text.nullable() })) }) },
    post: { body: recordHttp.lookupRefreshInput, reply: record, conflict: z.union([revisionConflict, errorSchema]) },
  },
  [records + '/search']: { get: { query: recordHttp.searchInput, reply: search } },
  [records + '/aggregates']: { get: { query: recordHttp.aggregateQuery, reply: aggregates } },
  [records + '/recycle']: { get: { query: recordHttp.recycleQuery, reply: page(recycle) } },
  [records + '/batch']: {
    post: { body: recordHttp.batchCreateInput, reply: batch },
    patch: { body: recordHttp.batchUpdateInput, reply: batchUpdate,
      description: 'Change one field on each listed record. A null value clears the field. Each row uses its own revision and reports its own outcome.' },
  },
  [entry]: {
    get: { reply: record },
    put: { body: recordHttp.updateInput, reply: record, conflict: z.union([revisionConflict, errorSchema]) },
    delete: { body: recordHttp.revisionInput, reply: record, conflict: z.union([revisionConflict, errorSchema]) },
  },
  [entry + '/restore']: { post: { body: recordHttp.revisionInput, reply: record, conflict: z.union([revisionConflict, errorSchema]) } },
  [entry + '/form']: { get: { reply: recordForm } },
  [entry + '/archived-fields']: { get: { reply: archive, description: 'Requires the independent archived-field grant and record view permission.' } },
  [entry + '/history']: { get: { query: recordHttp.historyQuery, reply: history } },
  [entry + '/history/export']: { get: { query: recordHttp.historyExportQuery, reply: historyExport, download: ['application/json'],
    description: 'Include deleted field definitions and values only with the independent archived-field grant.' } },
  [tenant + '/directory']: { get: { reply: directory } },
  [tenant + '/settings']: { put: { body: tenantHttp.policy, reply: settings } },
  [tenant + '/users']: { post: { body: tenantHttp.newUser, reply: tenantId.extend(user.shape), conflict: errorSchema } },
  [tenant + '/users/{id}']: { patch: { body: tenantHttp.userPatch, reply: tenantId.extend(user.shape) } },
  [tenant + '/users/{id}/password']: { put: { body: tenantHttp.resetInput, reply: result('updated') } },
  [tenant + '/users/{id}/disable']: { get: { reply: z.object({
    records: z.array(z.object({ id, appId: id, recordNo })),
    assignments: z.array(z.object({ id, appId: id, recordNo, revision: integer, state: text, appName: text })),
  }) }, post: { reply: result('disabled'), conflict: errorSchema } },
  [tenant + '/organizations']: { post: { body: tenantHttp.organization, reply: organization, conflict: errorSchema } },
  [tenant + '/organizations/{id}']: {
    put: { body: tenantHttp.organization, reply: organization, conflict: errorSchema },
    delete: { reply: result('deleted'), conflict: errorSchema },
  },
  [tenant + '/groups']: { post: { body: tenantHttp.groupInput, reply: group } },
  [tenant + '/groups/{id}']: { patch: { body: tenantHttp.groupInput, reply: group }, delete: { reply: result('deleted'), conflict: errorSchema } },
  [tenant + '/groups/{id}/members/{userId}']: { put: { body: tenantHttp.membershipInput, reply: z.object({ included: flag }) } },
  [applications + '/files']: { post: { query: fileHttp.uploadInput, binaryBody: true, reply: file } },
  [applications + '/files/{id}']: { get: { download: ['application/octet-stream'] } },
  [csv + '/preflight']: { post: { body: csvHttp.preflightInput, reply: importJob } },
  [csv + '/{jobId}/apply']: { post: { body: csvHttp.batchInput, reply: importJob, conflict: errorSchema } },
  [csv + '/{jobId}/errors']: { get: { download: ['text/csv'] } },
  [csv + '/export']: { get: { query: csvHttp.exportQuery, download: ['text/csv', 'application/zip'],
    description: 'Supply field and query together for search export. An attachment bundle includes a manifest and the authorized file bytes.' } },
  [applications + '/tokens']: {
    get: { reply: z.array(token) },
    post: { body: tokenHttp.issueInput, reply: token.extend({ token: text }), conflict: errorSchema,
      description: 'The bearer secret appears only in this issuance response.' },
  },
  [applications + '/tokens/{tokenId}']: { delete: { reply: token } },
  [indexes]: {
    get: { reply: z.array(runtimeIndex.extend({ name: text, fieldName: text })) },
    post: { body: indexHttp.indexInput, reply: runtimeIndex, conflict: errorSchema },
  },
  [indexes + '/{indexId}/retry']: { post: { reply: runtimeIndex, conflict: errorSchema } },
  [indexes + '/{indexId}']: { delete: { reply: runtimeIndex } },
  [applications + '/exports']: {
    get: { reply: z.array(exportJob) },
    post: { reply: exportJob, description: 'Creates a background export job. The package contains complete business data and must be handled as sensitive data.' },
  },
  [applications + '/exports/{exportId}']: { get: { reply: exportDetail } },
  [applications + '/exports/{exportId}/run']: { post: { reply: exportDetail } },
  [applications + '/exports/{exportId}/resume']: { post: { reply: exportJob, conflict: errorSchema } },
  [applications + '/exports/{exportId}/cancel']: { post: { reply: exportJob, conflict: errorSchema } },
  [applications + '/exports/{exportId}/package']: { get: { download: ['application/zip'],
    description: 'Downloads the sealed package. Only sealed packages can be downloaded.' } },
  [applications + '/token-reissues']: { get: { reply: z.array(z.looseObject({})),
    description: 'API tokens of the source deployment are never restored with secrets; this lists the metadata an administrator must re-issue (decision 6).' } },
  [applications + '/token-reissues/{jobId}/mark']: { post: { body: importHttp2.markReissuedInput,
    reply: z.looseObject({}), conflict: errorSchema } },
  ['/imports']: { get: { reply: z.array(migrationJob) } },
  ['/imports/upload']: { post: { binaryBody: true, reply: migrationJob, conflict: errorSchema,
    description: 'Uploads a sealed migration package (zip bytes). Tenant administrators only. Re-importing the same package warns that a second copy will be created.' } },
  ['/imports/{jobId}']: { get: { reply: migrationJob.extend({
    suggestions: z.looseObject({}) }) } },
  ['/imports/{jobId}/error-report']: { get: { reply: z.looseObject({}),
    description: 'Object/row/field-level preflight error report for a failed validation.' } },
  ['/imports/{jobId}/audit']: { get: { reply: z.array(migrationAuditEntry) } },
  ['/imports/{jobId}/validate']: { post: { reply: migrationJob, conflict: errorSchema,
    description: 'Runs full preflight: package integrity, version compatibility, item-by-item reference integrity and field-structure checks.' } },
  ['/imports/{jobId}/resume']: { post: { reply: migrationJob, conflict: errorSchema } },
  ['/imports/{jobId}/mappings']: { put: { body: importHttp.mappingsInput, reply: migrationJob, conflict: errorSchema,
    description: 'User/group/organization mapping decisions. Targets must be existing directory entries; accounts are never created by an import (decision 4).' } },
  ['/imports/{jobId}/migration-token']: { post: { reply: z.object({ token: text, expiresAt: timestamp }),
    conflict: errorSchema,
    description: 'Issues the one-time migration token for this job and target application (decision 7). The plaintext is shown only here; expiry is the earlier of 24 hours or the job reaching a terminal state.' } },
  ['/imports/{jobId}/run']: { post: { reply: migrationJob, conflict: errorSchema,
    description: 'Migration channel (migration token required): executes the staged restore. Idempotent; produces zero notification/outbox side effects.' } },
  ['/imports/{jobId}/queue-run']: { post: { reply: migrationJob, conflict: errorSchema,
    description: 'Migration channel (migration token required): queues the staged restore on the worker.' } },
  ['/imports/{jobId}/resolve-assignees']: { post: { body: importHttp2.resolveAssigneesInput,
    reply: migrationJob, conflict: errorSchema,
    description: 'Migration channel: per-item assignee disposition for unmapped assignees (decision 5). userId null explicitly accepts no assignee.' } },
  ['/imports/{jobId}/resolve-dependencies']: { post: { body: importHttp3.dependencyDecisionsInput,
    reply: migrationJob, conflict: errorSchema,
    description: 'Migration channel: map a cross-application lookup/related field to an existing target application, or explicitly disable/skip it (decision 4).' } },
  ['/imports/{jobId}/activate']: { post: { reply: migrationJob, conflict: errorSchema,
    description: 'Activates the restored application. Requires the verification and difference report to exist and every pending item to be resolved; audit-logged.' } },
  ['/imports/{jobId}/cancel']: { post: { reply: migrationJob, conflict: errorSchema,
    description: 'Cancels the job and purges every staged object to zero.' } },
};

function schema(value: z.ZodType, io: 'input' | 'output' = 'output'): SchemaObject {
  const { $schema: _version, ...document } = z.toJSONSchema(value, { target: 'openapi-3.0', io, unrepresentable: 'any' });
  return document as SchemaObject;
}

function queryParameters(value: z.ZodType): ParameterObject[] {
  const object = schema(value, 'input');
  const variants = (object.anyOf ?? object.oneOf ?? [object]) as SchemaObject[];
  const properties = Object.assign({}, ...variants.map((entry) => entry.properties)) as NonNullable<SchemaObject['properties']>;
  return Object.entries(properties).map(([name, schema]) => ({
    name, in: 'query', schema, required: variants.every((entry) => entry.required?.includes(name)),
  }));
}

function jsonResponse(description: string, response: z.ZodType): ResponseObject {
  return { description, content: { 'application/json': { schema: schema(response) } } };
}

function apply(path: string, method: Method, operation: OperationObject) {
  const contract = contracts[path]?.[method];
  if (!contract) throw new Error('Missing OpenAPI contract for ' + method + ' ' + path);
  if (contract.description) operation.description = contract.description;
  const configured = operation.parameters ?? [];
  const queries = contract.query ? queryParameters(contract.query) : [];
  operation.parameters = [...configured.filter((parameter) => '$ref' in parameter || parameter.in !== 'query'), ...queries];
  for (const parameter of operation.parameters) {
    if (!('$ref' in parameter) && parameter.in === 'path') parameter.schema = parameter.name === 'version'
      ? { type: 'integer', minimum: 1, maximum: 2147483647 } : { type: 'string', format: 'uuid' };
  }
  const binary: SchemaObject = { type: 'string', format: 'binary' };
  if (contract.body || contract.binaryBody) {
    operation.requestBody = {
      required: !contract.optionalBody, content: contract.binaryBody
        ? { 'application/octet-stream': { schema: binary } }
        : { 'application/json': { schema: schema(contract.body!, 'input') } },
    };
  }
  const status = contract.status ?? (method === 'post' ? 201 : 200);
  const success: ResponseObject = contract.download ? {
    description: 'Download',
    headers: { 'Content-Disposition': { schema: { type: 'string' }, description: 'Attachment filename' } },
    content: Object.fromEntries(contract.download.map((media) => [
      media, { schema: media === 'application/json' ? schema(contract.reply!) : binary },
    ])),
  } : jsonResponse('Success', contract.reply!);
  operation.responses[String(status)] = success;
  if (contract.body || contract.binaryBody || contract.query || path.includes('{')) operation.responses['400'] = jsonResponse('Invalid input', errorSchema);
  if (operation.security?.length) {
    operation.responses['401'] = jsonResponse('Invalid or expired credentials', errorSchema);
    operation.responses['403'] = jsonResponse('Permission denied', errorSchema);
    if (path.includes('{')) operation.responses['404'] = jsonResponse('Resource unavailable', errorSchema);
  }
  if (path === '/auth/login') operation.responses['401'] = jsonResponse('Credentials or verification code rejected', errorSchema);
  if (path === '/health' || [records + '/search', records + '/aggregates', csv + '/export', applications + '/permissions/preview'].includes(path)) {
    operation.responses['503'] = jsonResponse('Unavailable or query timed out', errorSchema);
  }
  if (contract.conflict) operation.responses['409'] = jsonResponse('Conflict', contract.conflict);
}

export function completeOpenApi(document: OpenAPIObject) {
  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of methods) {
      const operation = item[method];
      if (operation) apply(path, method, operation);
    }
  }
  return document;
}
