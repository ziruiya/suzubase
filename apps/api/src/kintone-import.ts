import { createHash } from 'node:crypto';

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

function isPrivateHostname(hostname: string) {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || lower.startsWith('127.') ||
    lower.startsWith('10.') || lower.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(lower) ||
    lower.includes(':');
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

export function mapKintoneField(source: any): FieldCompatibility {
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
  if (type === 'CALC') return {
    ...base, targetType: 'calculation', status: 'UNRESOLVED',
    reason: 'Formula requires equivalence analysis or explicit administrator snapshot downgrade',
    sourceUnavailable: false, upgradeRequired: false,
  };
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
  if (type === 'SINGLE_LINE_TEXT' && (source.lookup || source.expression)) return {
    ...base, targetType: 'lookup', status: 'UNRESOLVED',
    reason: 'Lookup or automatic expression configuration requires dependency analysis',
    sourceUnavailable: false, upgradeRequired: false,
  };
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

export class KintoneSourceAdapter {
  constructor(private readonly origin: string, private readonly apiToken: string,
    private readonly timeoutMs = 15000, private readonly maxRetries = 2) {}

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetch(this.origin + path, {
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

  async extract(appId: string, frozenWindow = false) {
    const preflight = await this.preflight(appId);
    if (!preflight.available.app) throw new Error('kintone app metadata unavailable; extraction blocked');
    const app = preflight.available.app as any;
    const fieldsPayload = preflight.available.fields as any;
    const fields = Object.entries(fieldsPayload?.properties ?? {}).map(([code, field]: [string, any]) => ({ ...field, code }));
    const compatibility = fields.map(mapKintoneField);
    const records: any[] = [];
    const comments: any[] = [];
    const attachments: any[] = [];
    const subtableRows: KintoneSubtableRow[] = [];
    let cursorId: string | undefined;
    try {
      const cursor = await this.request('POST', '/k/v1/records/cursor.json', {
        app: appId,
        fields: ['$', '$id', '$revision', ...fields.map((field) => field.code)],
        size: 500,
      }) as any;
      cursorId = cursor.id;
      while (cursorId) {
        const page = await this.request('POST', '/k/v1/records/cursor.json', { id: cursorId }) as any;
        records.push(...(page.records ?? []));
        if (!page.records || !Array.isArray(page.records)) {
          preflight.unavailable.push({ item: 'records', reason: 'cursor returned a non-record page', evidence: { next: page.next } });
          break;
        }
        for (const record of page.records ?? []) {
          const recordId = String(record.$id?.value ?? '');
          for (const field of fields) {
            if (field.type === 'SUBTABLE') {
              const rows = record[field.code]?.value ?? [];
              rows.forEach((row: any, rowOrder: number) => {
                subtableRows.push({
                  sourceRecordId: recordId,
                  sourceTableCode: field.code,
                  sourceRowId: String(row.id ?? `${recordId}:${field.code}:${rowOrder}`),
                  targetRowId: stableSourceUuid(`${appId}:${recordId}:${field.code}:${String(row.id ?? `${recordId}:${field.code}:${rowOrder}`)}`),
                  rowOrder,
                  data: row.value ?? {},
                  attachments: Object.values(row.value ?? {}).flatMap((value: any) =>
                    Array.isArray(value?.value) && value?.value?.every?.((item: any) => item.fileKey)
                      ? value.value.map((item: any) => ({ fileKey: item.fileKey, sha256: null, bytes: null }))
                      : []),
                });
              });
            }
            if (field.type === 'FILE') {
              for (const file of record[field.code]?.value ?? []) {
                if (!file.fileKey) continue;
                try {
                  const downloaded = await this.request('GET', `/k/v1/file.json?fileKey=${encodeURIComponent(file.fileKey)}`);
                  const bytes = downloaded instanceof ArrayBuffer ? new Uint8Array(downloaded) : null;
                  attachments.push({
                    recordId, fieldCode: field.code, fileKey: file.fileKey,
                    name: file.name ?? null, bytes: bytes?.byteLength ?? null,
                    sha256: bytes ? sha256Buffer(bytes) : null,
                  });
                } catch (error) {
                  preflight.unavailable.push({
                    item: `attachment:${recordId}:${field.code}:${file.fileKey}`,
                    reason: error instanceof Error ? error.message : 'attachment unavailable',
                    evidence: null,
                  });
                }
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
        if (!page.next) break;
      }
      if (cursorId) await this.request('DELETE', '/k/v1/records/cursor.json', { id: cursorId }).catch(() => undefined);
    } catch (error) {
      preflight.unavailable.push({ item: 'records', reason: error instanceof Error ? error.message : 'unavailable', evidence: null });
    }
    const evidence: SourceEvidence = {
      source: 'kintone', appId, appName: String(app.name ?? ''),
      extractedAt: new Date().toISOString(), settingVersion: null,
      recordIdRange: records.length ? { min: String(records[0].$id?.value ?? ''), max: String(records.at(-1)?.$id?.value ?? '') } : null,
      frozenWindow, unavailable: preflight.unavailable,
    };
    const blocking = compatibility.filter(({ status }) => status === 'UNSUPPORTED');
    return { evidence, compatibility, records, comments, attachments, subtableRows, blocking,
      packageReady: blocking.length === 0 &&
        preflight.unavailable.length === 0 &&
        Boolean(frozenWindow) &&
        !compatibility.some(({ status }) => status === 'UNRESOLVED') &&
        records.length >= 0 };
  }
}
