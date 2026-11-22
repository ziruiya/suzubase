import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  emptyCounts, MINIMUM_PROGRAM_VERSION, PACKAGE_FORMAT_VERSION, SENSITIVE_DATA_NOTICE, sealPackage,
  type ObjectCounts,
} from './export-package';

export type CompatibilityStatus = 'EQUIVALENT' | 'DATA_ONLY' | 'UNRESOLVED' | 'UNSUPPORTED';

export interface SourceEvidence {
  source: 'kintone';
  appId: string;
  appName: string;
  extractedAt: string;
  settingVersion: string | null;
  recordIdRange: { min: string | null; max: string | null } | null;
  frozenWindow: boolean;
  unavailable: { item: string; reason: string; evidence: unknown }[];
}

export interface FieldCompatibility {
  sourceFieldCode: string;
  sourceType: string;
  targetType: string | null;
  status: CompatibilityStatus;
  reason: string;
  sourceConfig: unknown;
  sourceUnavailable: boolean;
  upgradeRequired: boolean;
  formula?: KintoneFormulaToken[] | null;
}

type KintoneFormulaToken = { kind: 'field'; fieldId: string } |
  { kind: 'number'; value: string } |
  { kind: 'operator'; operator: '+' | '-' | '*' | '/' };

function convertCalcExpression(expression: string, fields: any[]): KintoneFormulaToken[] | null {
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]/g);
  if (!tokens || tokens.join('') !== expression.replace(/\s+/g, '')) return null;
  const byCode = new Map(fields.map((field) => [field.code, field]));
  const output: KintoneFormulaToken[] = [];
  const operators: string[] = [];
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2 };
  let expectsValue = true;
  for (const token of tokens) {
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      if (!expectsValue) return null;
      output.push({ kind: 'number', value: token });
      expectsValue = false;
    } else if (/^[A-Za-z_]/.test(token)) {
      const field = byCode.get(token);
      if (!expectsValue || field?.type !== 'NUMBER') return null;
      output.push({ kind: 'field', fieldId: token });
      expectsValue = false;
    } else if (token === '(') {
      if (!expectsValue) return null;
      operators.push(token);
    } else if (token === ')') {
      if (expectsValue) return null;
      while (operators.length && operators.at(-1) !== '(') {
        output.push({ kind: 'operator', operator: operators.pop() as '+' | '-' | '*' | '/' });
      }
      if (operators.pop() !== '(') return null;
      expectsValue = false;
    } else {
      if (expectsValue) return null;
      while (operators.length && operators.at(-1) !== '(' &&
        (precedence[operators.at(-1)!] ?? 0) >= precedence[token]!) {
        output.push({ kind: 'operator', operator: operators.pop() as '+' | '-' | '*' | '/' });
      }
      operators.push(token);
      expectsValue = true;
    }
  }
  if (expectsValue) return null;
  while (operators.length) {
    const operator = operators.pop()!;
    if (operator === '(') return null;
    output.push({ kind: 'operator', operator: operator as '+' | '-' | '*' | '/' });
  }
  return output;
}

export interface KintoneSubtableRow {
  sourceRecordId: string;
  sourceTableCode: string;
  sourceRowId: string;
  targetRowId: string;
  rowOrder: number;
  data: Record<string, unknown>;
  attachments: { fileKey: string; sha256: string | null; bytes: number | null }[];
}

export interface KintoneSubtableState {
  sourceRecordId: string;
  sourceTableCode: string;
  valueState: 'NULL' | 'EMPTY' | 'ROWS';
  rowCount: number;
}

export interface KintoneExtractionCheckpoint {
  appId: string;
  lastRecordId: string | null;
  records: any[];
  comments: any[];
  attachments: KintoneExtractionResult['attachments'];
  subtableRows: KintoneSubtableRow[];
  subtableStates: KintoneSubtableState[];
  unavailable: SourceEvidence['unavailable'];
}

export interface KintoneAttachmentReference {
  recordId: string;
  fieldCode: string;
  fileKey: string;
  name?: string | null;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  const version = isIP(lower);
  if (version === 4) {
    const [a, b] = lower.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
      (a === 192 && b === 168);
  }
  if (version === 6) {
    const normalized = lower;
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') || normalized.startsWith('fea') ||
      normalized.startsWith('feb') || normalized.startsWith('ff')) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHostname(mapped[1]);
    const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateHostname(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  return false;
}

export function validateKintoneDomain(input: string, allowedHosts = process.env.KINTONE_ALLOWED_HOSTS) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Invalid kintone source domain'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
    url.search || url.hash || isPrivateHostname(url.hostname)) {
    throw new Error('kintone source must be an HTTPS public origin without credentials or a path');
  }
  const allowlist = (allowedHosts ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.length) throw new Error('KINTONE_ALLOWED_HOSTS is required');
  if (!allowlist.includes(url.hostname.toLowerCase())) throw new Error('kintone source host is not allowlisted');
  return url.origin;
}

export function mapKintoneField(source: any, options: {
  fields?: any[];
  acceptCalcDataOnly?: boolean;
} = {}): FieldCompatibility {
  const code = String(source.code ?? source.fieldCode ?? '');
  const type = String(source.type ?? 'UNKNOWN');
  const base = { sourceFieldCode: code, sourceType: type, sourceConfig: source };
  const direct: Record<string, string> = {
    SINGLE_LINE_TEXT: 'text', MULTI_LINE_TEXT: 'multiline', RICH_TEXT: 'richText',
    NUMBER: 'number', RADIO_BUTTON: 'radio', DROP_DOWN: 'select', CHECK_BOX: 'checkbox',
    MULTI_SELECT: 'multiselect', DATE: 'date', TIME: 'time', DATETIME: 'datetime',
    LINK: 'url', USER_SELECT: 'user', ORGANIZATION_SELECT: 'organization',
    GROUP_SELECT: 'group', FILE: 'attachment', SUBTABLE: 'table', REFERENCE_TABLE: 'related',
    RECORD_NUMBER: 'text', CREATOR: 'user', MODIFIER: 'user',
    CREATED_TIME: 'datetime', UPDATED_TIME: 'datetime', STATUS: 'text',
    STATUS_ASSIGNEE: 'user', CATEGORY: 'layout', GROUP: 'layout', LABEL: 'layout',
    SPACER: 'layout', HR: 'layout',
  };
  if (source.lookup) return {
    ...base, targetType: 'lookup', status: 'UNRESOLVED',
    reason: source.lookup.relatedApp?.app
      ? 'Lookup target application and key mapping require dependency resolution'
      : 'Lookup target application is missing; completion is pending',
    sourceUnavailable: false, upgradeRequired: false,
  };
  if (type === 'CALC') {
    const formula = source.format === 'NUMBER'
      ? convertCalcExpression(String(source.expression ?? ''), options.fields ?? [])
      : null;
    if (formula) return {
      ...base, targetType: 'calculation', status: 'EQUIVALENT',
      reason: 'Numeric formula converted to SuzuBase postfix calculation tokens',
      sourceUnavailable: false, upgradeRequired: false, formula,
    };
    if (options.acceptCalcDataOnly) return {
      ...base, targetType: 'number', status: 'DATA_ONLY',
      reason: 'Administrator accepted a value-only downgrade; source formula is retained in sourceConfig',
      sourceUnavailable: false, upgradeRequired: false, formula: null,
    };
    return {
      ...base, targetType: 'calculation', status: 'UNRESOLVED',
      reason: 'Formula is not directly convertible; explicit administrator DATA_ONLY acceptance is required',
      sourceUnavailable: false, upgradeRequired: false, formula: null,
    };
  }
  if (type === 'CATEGORY') return {
    ...base, targetType: null, status: 'UNSUPPORTED',
    reason: 'P2 category tree is not implemented; dropdown downgrade is not equivalent',
    sourceUnavailable: false, upgradeRequired: true,
  };
  if (type === 'UNKNOWN' || !direct[type]) return {
    ...base, targetType: null, status: 'UNSUPPORTED',
    reason: `Unknown kintone field type ${type} is not silently downgraded`,
    sourceUnavailable: false, upgradeRequired: true,
  };
  if (type === 'LINK') {
    const protocol = source.protocol;
    return { ...base, targetType: protocol === 'TEL' ? 'phone' : protocol === 'MAIL' ? 'email' : 'url',
      status: 'EQUIVALENT', reason: 'Link protocol preserves typed semantics',
      sourceUnavailable: false, upgradeRequired: false };
  }
  if (type === 'REFERENCE_TABLE') return {
    ...base, targetType: 'related', status: 'UNRESOLVED',
    reason: 'Cross-app reference requires target application mapping',
    sourceUnavailable: false, upgradeRequired: false,
  };
  if (['USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT', 'CREATOR', 'MODIFIER', 'STATUS_ASSIGNEE'].includes(type)) return {
    ...base, targetType: direct[type], status: 'UNRESOLVED',
    reason: 'Source identity and target directory membership require explicit mapping',
    sourceUnavailable: false, upgradeRequired: false,
  };
  return { ...base, targetType: direct[type], status: 'EQUIVALENT',
    reason: 'Target field preserves source value semantics', sourceUnavailable: false, upgradeRequired: false };
}

export function sha256Buffer(buffer: Uint8Array) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function stableSourceUuid(sourceKey: string) {
  const hex = createHash('sha256').update(sourceKey).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface KintoneExtractionResult {
  evidence: SourceEvidence;
  compatibility: FieldCompatibility[];
  records: any[];
  comments: any[];
  attachments: {
    recordId: string;
    fieldCode: string;
    fileKey: string;
    name: string | null;
    bytes: number | null;
    sha256: string | null;
    body?: Uint8Array;
  }[];
  subtableRows: KintoneSubtableRow[];
  subtableStates: KintoneSubtableState[];
  blocking: FieldCompatibility[];
  packageReady: boolean;
}

function kintoneValue(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object' && 'value' in value) return kintoneValue(value.value);
  return JSON.stringify(value);
}

export function buildM1CompatiblePackage(
  extraction: KintoneExtractionResult,
  options: { sourceInstanceId?: string; sourceTenantId?: string } = {},
) {
  if (!extraction.packageReady || !extraction.evidence.frozenWindow) {
    throw new Error('kintone package blocked: frozen snapshot and all source/field/dependency gates are required');
  }
  if (extraction.evidence.unavailable.length) {
    throw new Error('kintone package blocked: source unavailable items exist');
  }
  if (extraction.blocking.length || extraction.compatibility.some(({ status }) => status === 'UNRESOLVED')) {
    throw new Error('kintone package blocked: unsupported or unresolved mappings exist');
  }
  if (extraction.attachments.some((file) => !file.sha256 || !file.body)) {
    throw new Error('kintone package blocked: an attachment entity or SHA-256 is unavailable');
  }

  const sourceAppId = extraction.evidence.appId;
  const targetAppId = stableSourceUuid(`kintone-app:${extraction.evidence.appId}`);
  const targetTenantId = options.sourceTenantId ?? stableSourceUuid(`kintone-tenant:${extraction.evidence.appId}`);
  const fields = extraction.compatibility.map((item, index) => ({
    fieldId: stableSourceUuid(`kintone:${sourceAppId}:field:${item.sourceFieldCode}`),
    code: item.sourceFieldCode,
    name: item.sourceFieldCode,
    type: item.targetType,
    required: false,
    uniqueValue: false,
    searchMode: null,
    formula: item.formula ?? null,
    lookup: null,
    related: null,
    table: null,
    layoutElement: null,
    autoNumber: null,
    options: [],
    kintoneSource: {
      sourceType: item.sourceType,
      sourceConfig: item.sourceConfig,
      compatibility: item.status,
      reason: item.reason,
    },
  }));
  const records = extraction.records.map((record: any) => {
    const sourceId = String(record.$id?.value ?? '');
    const data: Record<string, string> = {};
    for (const item of extraction.compatibility) {
      const source = record[item.sourceFieldCode];
      if (source !== undefined) data[stableSourceUuid(`kintone:${sourceAppId}:field:${item.sourceFieldCode}`)] =
        kintoneValue(source);
    }
    return {
      id: stableSourceUuid(`kintone:${sourceAppId}:record:${sourceId}`),
      recordNo: kintoneValue(record.$id),
      data,
      archivedData: {},
      schemaVersion: 1,
      revision: 1,
      status: 'PUBLISHED',
      createdBy: stableSourceUuid(`kintone:${sourceAppId}:creator:unknown`),
      createdAt: extraction.evidence.extractedAt,
      updatedBy: stableSourceUuid(`kintone:${sourceAppId}:modifier:unknown`),
      updatedAt: extraction.evidence.extractedAt,
      deletedBy: null,
      deletedAt: null,
      workflow: null,
      kintoneSourceId: sourceId,
    };
  });
  const tableRows = extraction.subtableRows.map((row) => ({
    recordId: stableSourceUuid(`kintone:${sourceAppId}:record:${row.sourceRecordId}`),
    fieldId: stableSourceUuid(`kintone:${sourceAppId}:field:${row.sourceTableCode}`),
    rowId: row.targetRowId,
    rowOrder: row.rowOrder,
    data: Object.fromEntries(Object.entries(row.data).map(([key, value]) => [key, kintoneValue(value)])),
  }));
  const attachmentEntries = extraction.attachments.map((file) => ({
    fileId: stableSourceUuid(`kintone:${sourceAppId}:file:${file.fileKey}`),
    version: 1,
    sha256: file.sha256!,
    bytes: file.bytes ?? 0,
    state: 'READY',
    name: file.name ?? file.fileKey,
    contentType: 'application/octet-stream',
  }));
  const attachmentBodies = Object.fromEntries(extraction.attachments
    .filter((file) => file.body && file.sha256)
    .map((file) => [`attachments/${stableSourceUuid(`kintone:${sourceAppId}:file:${file.fileKey}`)}/v1/body`, Buffer.from(file.body!)]));

  const expected: ObjectCounts = emptyCounts();
  expected.apps = 1;
  expected.appVersions = 1;
  expected.fieldVersionSnapshots = 1;
  expected.fields = fields.length;
  expected.records = records.length;
  expected.tableRows = tableRows.length;
  expected.attachments = attachmentEntries.length;
  expected.attachmentVersions = attachmentEntries.length;
  expected.comments = extraction.comments.length;
  expected.workflowVersions = 0;
  expected.aclEntries = 0;

  const compatEvidence = {
    sourceEvidence: extraction.evidence,
    fields: extraction.compatibility,
    subtableRows: extraction.subtableRows,
    subtableStates: extraction.subtableStates,
    attachments: extraction.attachments.map(({ body: _body, ...file }) => file),
    comments: extraction.comments,
  };
  const files = {
    'data/app.json': JSON.stringify({
      app: {
        id: targetAppId, code: `kintone-${sourceAppId}`, name: extraction.evidence.appName,
        description: 'Imported from kintone via M3 source adapter', icon: null, themeColor: null,
        titleFieldId: null, duplicateHint: false, numericPrecision: 6,
        attachmentMaxBytes: 8 * 1024 * 1024, attachmentMaxCount: 100,
        attachmentTypes: [], localDrafts: true, commentsEnabled: true,
        workflowEnabled: false, adminMemo: 'kintone migration',
        publishedSchemaVersion: 1, draftSchemaVersion: null,
        createdBy: stableSourceUuid(`kintone:${sourceAppId}:creator:unknown`),
      },
      recordCounter: String(records.length),
      autoNumberCounters: [],
    }),
    'data/schema.json': JSON.stringify({
      versions: [{ version: 1, aclConfiguration: { app: [], record: [], field: [] },
        fieldEdits: {}, formLayout: [], notificationRules: [], viewConfiguration: { views: [] },
        migrationReport: compatEvidence, fields }],
      fields,
      rawFields: fields.map((field) => ({ ...field, introducedIn: 1 })),
      deletedFields: [], views: [], formLayout: [], viewConfiguration: { views: [] },
    }),
    'data/workflows.json': JSON.stringify({ definitions: [] }),
    'data/records.json': JSON.stringify({ records }),
    'data/table-rows.json': JSON.stringify({ rows: tableRows }),
    'data/references.json': JSON.stringify({ references: [] }),
    'data/attachments.json': JSON.stringify({ files: attachmentEntries }),
    'data/comments.json': JSON.stringify({ comments: extraction.comments.map((comment: any, index: number) => ({
      id: stableSourceUuid(`kintone:${sourceAppId}:comment:${String(comment.id ?? index)}`),
      recordId: stableSourceUuid(`kintone:${sourceAppId}:record:${String(comment.recordId ?? comment.$id?.value ?? '')}`),
      authorId: stableSourceUuid(`kintone:${sourceAppId}:user:${String(comment.creator?.code ?? comment.user?.code ?? 'unknown')}`),
      createdAt: comment.createdAt ?? extraction.evidence.extractedAt,
      deleted: false,
      deletedAt: null,
      body: kintoneValue(comment.content ?? comment.body ?? ''),
      mentions: (comment.mentions ?? []).map((mention: any) => ({ userId: String(mention.code ?? mention.userId ?? '') })),
    })) }),
    'data/history.json': JSON.stringify({ recordEvents: [], workflowEvents: [] }),
    'data/config.json': JSON.stringify({
      acl: { app: [], record: [], field: [] },
      notificationRules: [],
      relations: [],
      apiTokens: [],
      kintoneCompatibility: compatEvidence,
    }),
    'data/directory.json': JSON.stringify({ users: [], groups: [], organizations: [] }),
  };
  return sealPackage({
    manifestBase: {
      formatVersion: PACKAGE_FORMAT_VERSION,
      minimumProgramVersion: MINIMUM_PROGRAM_VERSION,
      exportId: stableSourceUuid(`kintone-export:${sourceAppId}:${extraction.evidence.extractedAt}`),
      sourceInstanceId: options.sourceInstanceId ?? stableSourceUuid(`kintone-instance:${extraction.evidence.appId}`),
      sourceTenantId: targetTenantId,
      sourceAppId: targetAppId,
      sourceAppCode: `kintone-${sourceAppId}`,
      exportedAt: extraction.evidence.extractedAt,
      snapshotCutoff: extraction.evidence.extractedAt,
      counts: { expected },
      excluded: { temporaryAttachments: 0, purgedAttachments: 0 },
      inclusion: {
        kintoneSourceEvidence: 'included',
        kintoneCompatibilityReport: 'included',
        kintoneSubtables: 'included',
        kintoneComments: 'included',
        kintoneAttachments: extraction.attachments.length ? 'included' : 'absent',
        kintoneWorkflow: extraction.compatibility.some((item) => ['STATUS', 'STATUS_ASSIGNEE'].includes(item.sourceType))
          ? 'unsupported' : 'absent',
      },
      attachments: attachmentEntries,
      sensitiveDataNotice: SENSITIVE_DATA_NOTICE,
    },
    files,
    attachmentBodies,
  });
}

export class KintoneSourceAdapter {
  private readonly origin: string;

  constructor(origin: string, private readonly apiToken: string,
    private readonly timeoutMs = 15000, private readonly maxRetries = 2,
    private readonly fetcher: typeof fetch = fetch) {
    this.origin = validateKintoneDomain(origin);
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(this.origin + path, {
          method,
          headers: { 'X-Cybozu-API-Token': this.apiToken, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt === this.maxRetries) throw new Error(`kintone request failed: ${error instanceof Error ? error.message : 'timeout'}`);
        await new Promise((done) => setTimeout(done, 250 * (attempt + 1)));
        continue;
      }
      if (response.status === 403) throw new Error(`kintone permission denied: ${path}`);
      if (response.status === 401) throw new Error('kintone authentication rejected');
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`kintone API ${response.status} for ${path}${text ? `: ${text.slice(0, 500)}` : ''}`);
      }
      return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.arrayBuffer();
    }
    throw new Error('kintone request retry limit exceeded');
  }

  async downloadAttachment(fileKey: string) {
    const downloaded = await this.request('GET', `/k/v1/file.json?fileKey=${encodeURIComponent(fileKey)}`);
    return downloaded instanceof ArrayBuffer ? new Uint8Array(downloaded) : null;
  }

  async retryAttachment(checkpoint: KintoneExtractionCheckpoint, reference: KintoneAttachmentReference) {
    const bytes = await this.downloadAttachment(reference.fileKey);
    if (!bytes) throw new Error('kintone attachment response did not contain a byte stream');
    const sha256 = sha256Buffer(bytes);
    const item = `attachment:${reference.recordId}:${reference.fieldCode}:${reference.fileKey}`;
    const attachments = checkpoint.attachments.filter((file) =>
      file.recordId !== reference.recordId || file.fieldCode !== reference.fieldCode ||
      file.fileKey !== reference.fileKey);
    attachments.push({
      recordId: reference.recordId, fieldCode: reference.fieldCode, fileKey: reference.fileKey,
      name: reference.name ?? null, bytes: bytes.byteLength, sha256, body: bytes,
    });
    const subtableRows = checkpoint.subtableRows.map((row) => row.sourceRecordId !== reference.recordId ||
      !reference.fieldCode.startsWith(`${row.sourceTableCode}.`) ? row : {
        ...row,
        attachments: row.attachments.map((file) => file.fileKey === reference.fileKey
          ? { fileKey: file.fileKey, bytes: bytes.byteLength, sha256 } : file),
      });
    return {
      ...checkpoint, attachments, subtableRows,
      unavailable: checkpoint.unavailable.filter((entry) => entry.item !== item),
    };
  }

  async preflight(appId: string) {
    const checks = [
      ['app', '/k/v1/app.json?app=' + encodeURIComponent(appId)],
      ['fields', '/k/v1/app/form/fields.json?app=' + encodeURIComponent(appId)],
      ['layout', '/k/v1/app/form/layout.json?app=' + encodeURIComponent(appId)],
      ['settings', '/k/v1/app/settings.json?app=' + encodeURIComponent(appId)],
      ['appAcl', '/k/v1/app/acl.json?app=' + encodeURIComponent(appId)],
      ['recordAcl', '/k/v1/record/acl.json?app=' + encodeURIComponent(appId)],
      ['fieldAcl', '/k/v1/field/acl.json?app=' + encodeURIComponent(appId)],
      ['processes', '/k/v1/app/status.json?app=' + encodeURIComponent(appId)],
      ['processDefinitions', '/k/v1/app/processes.json?app=' + encodeURIComponent(appId)],
      ['records', '/k/v1/records.json?app=' + encodeURIComponent(appId) + '&query=$id%20>%200&limit=1'],
    ];
    const available: Record<string, unknown> = {};
    const unavailable: SourceEvidence['unavailable'] = [];
    for (const [item, path] of checks) {
      try { available[item] = await this.request('GET', path); }
      catch (error) { unavailable.push({ item, reason: error instanceof Error ? error.message : 'unavailable', evidence: null }); }
    }
    return { available, unavailable };
  }

  async extract(appId: string, frozenWindow = false, options: {
    acceptCalcDataOnly?: boolean;
    checkpoint?: KintoneExtractionCheckpoint;
    onCheckpoint?: (checkpoint: KintoneExtractionCheckpoint) => void | Promise<void>;
  } = {}) {
    if (options.checkpoint && options.checkpoint.appId !== appId) {
      throw new Error('kintone checkpoint belongs to a different source application');
    }
    const preflight = await this.preflight(appId);
    if (!preflight.available.app) throw new Error('kintone app metadata unavailable; extraction blocked');
    const app = preflight.available.app as any;
    const fieldsPayload = preflight.available.fields as any;
    const fields = Object.entries(fieldsPayload?.properties ?? {}).map(([code, field]: [string, any]) => ({ ...field, code }));
    const compatibility = fields.map((field) => mapKintoneField(field, {
      fields, acceptCalcDataOnly: options.acceptCalcDataOnly,
    }));
    const checkpoint = options.checkpoint;
    const records: any[] = [...(checkpoint?.records ?? [])];
    const comments: any[] = [...(checkpoint?.comments ?? [])];
    const attachments: KintoneExtractionResult['attachments'] = [...(checkpoint?.attachments ?? [])];
    const subtableRows: KintoneSubtableRow[] = [...(checkpoint?.subtableRows ?? [])];
    const subtableStates: KintoneSubtableState[] = [...(checkpoint?.subtableStates ?? [])];
    preflight.unavailable.push(...(checkpoint?.unavailable ?? []).filter(({ item }) => item !== 'records'));
    let lastRecordId = checkpoint?.lastRecordId ?? null;
    const captureAttachment = async (recordId: string, fieldCode: string, file: any) => {
      if (!file.fileKey) return null;
      try {
        const bytes = await this.downloadAttachment(file.fileKey);
        if (!bytes) throw new Error('kintone attachment response did not contain a byte stream');
        attachments.push({
          recordId, fieldCode, fileKey: file.fileKey,
          name: file.name ?? null, bytes: bytes.byteLength, sha256: sha256Buffer(bytes), body: bytes,
        });
        return { fileKey: file.fileKey, sha256: sha256Buffer(bytes), bytes: bytes.byteLength };
      } catch (error) {
        preflight.unavailable.push({
          item: `attachment:${recordId}:${fieldCode}:${file.fileKey}`,
          reason: error instanceof Error ? error.message : 'attachment unavailable',
          evidence: null,
        });
        return { fileKey: file.fileKey, sha256: null, bytes: null };
      }
    };
    let cursorId: string | undefined;
    try {
      if (lastRecordId !== null && !/^\d+$/.test(lastRecordId)) {
        throw new Error('kintone checkpoint source record ID is not a numeric cursor boundary');
      }
      const cursor = await this.request('POST', '/k/v1/records/cursor.json', {
        app: appId,
        fields: ['$', '$id', '$revision', ...fields.map((field) => field.code)],
        size: 500,
        ...(lastRecordId === null ? { query: '$id > 0 order by $id asc' } :
          { query: `$id > ${lastRecordId} order by $id asc` }),
      }) as any;
      cursorId = cursor.id;
      while (cursorId) {
        const page = await this.request('POST', '/k/v1/records/cursor.json', { id: cursorId }) as any;
        if (!page.records || !Array.isArray(page.records)) {
          preflight.unavailable.push({ item: 'records', reason: 'cursor returned a non-record page', evidence: { next: page.next } });
          break;
        }
        records.push(...page.records);
        for (const record of page.records ?? []) {
          const recordId = String(record.$id?.value ?? '');
          for (const field of fields) {
            if (field.type === 'SUBTABLE') {
              const rawRows = record[field.code]?.value;
              const rows = Array.isArray(rawRows) ? rawRows : [];
              subtableStates.push({
                sourceRecordId: recordId, sourceTableCode: field.code,
                valueState: rawRows === null || rawRows === undefined ? 'NULL' : rows.length ? 'ROWS' : 'EMPTY',
                rowCount: rows.length,
              });
              for (const [rowOrder, row] of rows.entries()) {
                const sourceRowId = String(row.id ?? `${recordId}:${field.code}:${rowOrder}`);
                const rowAttachments = [];
                for (const [childCode, value] of Object.entries(row.value ?? {}) as [string, any][]) {
                  if (Array.isArray(value?.value)) {
                    for (const file of value.value.filter((item: any) => item?.fileKey)) {
                      const attachment = await captureAttachment(recordId, `${field.code}.${childCode}`, file);
                      if (attachment) rowAttachments.push(attachment);
                    }
                  }
                }
                subtableRows.push({
                  sourceRecordId: recordId,
                  sourceTableCode: field.code,
                  sourceRowId,
                  targetRowId: stableSourceUuid(
                    `kintone:${appId}:record:${recordId}:table:${field.code}:row:${sourceRowId}`,
                  ),
                  rowOrder,
                  data: row.value ?? {},
                  attachments: rowAttachments,
                });
              }
            }
            if (field.type === 'FILE') {
              for (const file of record[field.code]?.value ?? []) {
                await captureAttachment(recordId, field.code, file);
              }
            }
          }
          try {
            let offset = 0;
            while (true) {
              const pageComments = await this.request('GET',
                `/k/v1/record/comments.json?app=${encodeURIComponent(appId)}&record=${encodeURIComponent(recordId)}&offset=${offset}&limit=10`) as any;
              comments.push(...(pageComments.comments ?? []));
              if (!pageComments.comments?.length || pageComments.comments.length < 10) break;
              offset += 10;
              if (offset > 10000) {
                preflight.unavailable.push({ item: `comments:${recordId}`, reason: 'kintone comment offset limit reached', evidence: null });
                break;
              }
            }
          } catch (error) {
            preflight.unavailable.push({
              item: `comments:${recordId}`,
              reason: error instanceof Error ? error.message : 'comments unavailable',
              evidence: null,
            });
          }
        }
        if (page.records.length) {
          const pageIds = page.records.map((record: any) => String(record.$id?.value ?? ''));
          if (pageIds.some((id: string) => !/^\d+$/.test(id))) {
            preflight.unavailable.push({
              item: 'records', reason: 'source record IDs cannot form a safe resume cursor', evidence: pageIds,
            });
            break;
          }
          lastRecordId = pageIds.reduce((largest: string, id: string) =>
            BigInt(id) > BigInt(largest) ? id : largest, pageIds[0]);
          await options.onCheckpoint?.({
            appId, lastRecordId, records, comments, attachments, subtableRows, subtableStates,
            unavailable: preflight.unavailable,
          });
        }
        if (!page.next) break;
      }
      if (cursorId) await this.request('DELETE', '/k/v1/records/cursor.json', { id: cursorId }).catch(() => undefined);
    } catch (error) {
      preflight.unavailable.push({ item: 'records', reason: error instanceof Error ? error.message : 'unavailable', evidence: null });
    }
    const evidence: SourceEvidence = {
      source: 'kintone', appId, appName: String(app.name ?? ''),
      extractedAt: new Date().toISOString(), settingVersion: null,
      recordIdRange: records.length ? {
        min: records.map((record) => String(record.$id?.value ?? '')).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)[0],
        max: records.map((record) => String(record.$id?.value ?? '')).sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1).at(0)!,
      } : null,
      frozenWindow, unavailable: preflight.unavailable,
    };
    const blocking = compatibility.filter(({ status }) => status === 'UNSUPPORTED');
    return { evidence, compatibility, records, comments, attachments, subtableRows, subtableStates, blocking,
      packageReady: blocking.length === 0 &&
        preflight.unavailable.length === 0 &&
        Boolean(frozenWindow) &&
        !compatibility.some(({ status }) => status === 'UNRESOLVED') &&
        records.length >= 0 };
  }
}
