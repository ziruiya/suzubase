import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
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
  tableFields?: FieldCompatibility[];
  /** P4-T3a: ordered target options after value translation (choice fields
   * whose source values are not safe target identifiers). */
  resolvedOptions?: { value: string; label: string; disabled: boolean }[];
  /** P4-T3a: source choice value -> target option identifier. */
  optionValueMap?: Record<string, string>;
  /** P4 fix batch (task 5): set to 'IDENTIFIER_TRANSLATED' when the
   * field's option identifiers were re-issued (optionValueMap present).
   * Marks, in the compatibility report, that the field is EQUIVALENT
   * under an identifier translation: labels and selection meaning are
   * preserved, but external API raw values are not byte-faithful. */
  translation?: 'IDENTIFIER_TRANSLATED';
  /** P4 fix batch (task 5): the source field default translated through
   * the same option map (identity when no translation was needed). The
   * target field model has no default-value mechanism, so the translated
   * default is carried as package/report evidence, never dropped. */
  resolvedDefaultValue?: string | string[];
  /** P4-T3a: verified lookup structure (six-item check) for packaging. */
  lookupResolution?: KintoneLookupResolution;
  /** P4-T3a: category disposition decided at extraction time. */
  categoryResolution?: KintoneCategoryResolution;
}

export interface KintoneLookupResolution {
  relatedAppId: string;
  relatedKeyField: string;
  copies: { field: string; relatedField: string }[];
  pickerFields: string[];
  filterCond: string;
  sort: { field: string; direction: 'asc' | 'desc' } | null;
}

export interface KintoneCategoryNode {
  id: string; parentId: string | null; name: string; sortOrder: number;
}

export interface KintoneCategoryResolution {
  mode: 'disabled' | 'tree';
  nodes?: KintoneCategoryNode[];
  /** source record id -> source node ids (tree mode only). */
  assignments?: Record<string, string[]>;
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
      normalized.startsWith('fd') || ['fe8', 'fe9', 'fea', 'feb', 'fec', 'fed', 'fee', 'fef']
        .some((prefix) => normalized.startsWith(prefix)) || normalized.startsWith('ff')) return true;
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

function targetOptions(source: any): { value: string; label: string; disabled: boolean }[] {
  const entries: [string, any][] = Array.isArray(source)
    ? source.map((option: any) => [String(option.value), option])
    : Object.entries(source ?? {});
  return entries.map(([rawValue, rawOption]) => ({
    value: String(rawValue),
    label: String(rawOption?.label ?? rawValue),
    disabled: false,
  }));
}

/**
 * P4-T1 category resolution (frozen spec): kintone record values carry
 * category NAMES only; the tree itself is not readable through the REST
 * API. Given an out-of-band captured tree (nodes keyed by stable id), a
 * name resolves only when exactly ONE node in the whole tree carries it.
 * Zero matches (unknown name) or multiple matches (duplicate names
 * anywhere, including under different parents) are identity ambiguity:
 * the value is reported as UNRESOLVED_CATEGORY_IDENTITY, never guessed by
 * position or merged, and the caller must block activation for the app.
 */
export function resolveKintoneCategories(
  nodes: { id: string; parentId: string | null; name: string }[],
  recordValues: { recordId: string; names: string[] }[],
): { resolved: Record<string, string[]>; unresolved: { recordId: string; name: string; code: 'UNRESOLVED_CATEGORY_IDENTITY' }[] } {
  const idsByName = new Map<string, string[]>();
  for (const node of nodes) idsByName.set(node.name, [...(idsByName.get(node.name) ?? []), node.id]);
  const resolved: Record<string, string[]> = {};
  const unresolved: { recordId: string; name: string; code: 'UNRESOLVED_CATEGORY_IDENTITY' }[] = [];
  for (const { recordId, names } of recordValues) {
    const ids: string[] = [];
    for (const name of names) {
      const candidates = idsByName.get(name) ?? [];
      if (candidates.length === 1) ids.push(candidates[0]);
      else unresolved.push({ recordId, name, code: 'UNRESOLVED_CATEGORY_IDENTITY' });
    }
    resolved[recordId] = ids;
  }
  return { resolved, unresolved };
}

const SAFE_OPTION_VALUE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;
export const KINTONE_CHOICE_TYPES = ['RADIO_BUTTON', 'DROP_DOWN', 'CHECK_BOX', 'MULTI_SELECT'];
export const KINTONE_IDENTITY_TYPES = [
  'USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT', 'CREATOR', 'MODIFIER', 'STATUS_ASSIGNEE',
];

/**
 * P4-T3a choice resolution: kintone option values are free-form labels
 * (frequently Japanese) that the target cannot use as option identifiers.
 * When every value is already a safe identifier the field needs no
 * translation; otherwise ALL values are deterministically re-issued as
 * `opt_<kintone index>` while labels keep the original text and index
 * order. Record values are translated through the same map at package
 * build time, and the source field default is translated through the
 * same map at resolution time, so every supported reference point
 * (record values, subtable row values, field default) follows the one
 * map recorded on the compatibility item.
 *
 * P4 fix batch (GPT T3a review, task 5) — identifier uniqueness
 * hardening. The pre-hardening code defaulted a missing object-form
 * index to 0 and never validated the issued identifiers, so two options
 * could silently receive the same `opt_<index>` (and a duplicate source
 * value silently overwrote its map entry). Resolution now FAILS CLOSED
 * (a `{ problem }` result: the caller keeps the field UNRESOLVED and
 * records a gate problem, which blocks packaging) when:
 * - an object-form option is missing its index, or any explicit index
 *   is not a non-negative integer (kintone serializes indices as
 *   numeric strings; an empty string is missing, not zero);
 * - two options resolve to the same index (array-form options without
 *   an explicit index take their array position, which the uniqueness
 *   check then covers like any other index);
 * - a source option value appears twice, or the issued target
 *   identifiers are not unique within the field;
 * - the field default references a value outside the option set.
 * The full source -> target map is returned for every translated field
 * and lands in the package compatibility report via the item's
 * `optionValueMap`; the item is additionally marked
 * `translation: 'IDENTIFIER_TRANSLATED'` because external API raw
 * values are NOT byte-faithful after translation (labels are).
 */
export type ChoiceOptionsResolution = {
  resolvedOptions: { value: string; label: string; disabled: boolean }[];
  optionValueMap?: Record<string, string>;
  resolvedDefaultValue?: string | string[];
} | { problem: string };

function parseOptionIndex(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

export function resolveChoiceOptions(source: any): ChoiceOptionsResolution | null {
  const raw = source?.options;
  if (!raw || typeof raw !== 'object') return null;
  const fail = (problem: string): ChoiceOptionsResolution => ({ problem });
  const entries: { value: string; label: string; index: number }[] = [];
  if (Array.isArray(raw)) {
    for (const [position, option] of raw.entries()) {
      const value = String((option as any)?.value);
      if ((option as any)?.index === undefined || (option as any)?.index === null) {
        entries.push({ value, label: String((option as any)?.label ?? value), index: position });
        continue;
      }
      const index = parseOptionIndex((option as any).index);
      if (index === null) {
        return fail(`option "${value}" carries an invalid index ${JSON.stringify((option as any).index)}; ` +
          'option indices must be non-negative integers');
      }
      entries.push({ value, label: String((option as any)?.label ?? value), index });
    }
  } else {
    for (const [value, option] of Object.entries(raw) as [string, any][]) {
      if (option?.index === undefined || option?.index === null) {
        return fail(`option "${value}" is missing its kintone index; ` +
          'an index is required to issue a unique target option identifier');
      }
      const index = parseOptionIndex(option.index);
      if (index === null) {
        return fail(`option "${value}" carries an invalid index ${JSON.stringify(option.index)}; ` +
          'option indices must be non-negative integers');
      }
      entries.push({ value, label: String(option?.label ?? value), index });
    }
  }
  if (!entries.length) return null;
  const seenValues = new Set<string>();
  for (const { value } of entries) {
    if (seenValues.has(value)) {
      return fail(`source option value "${value}" appears more than once; ` +
        'option values must be unique within a field to map losslessly');
    }
    seenValues.add(value);
  }
  const seenIndices = new Set<number>();
  for (const { index } of entries) {
    if (seenIndices.has(index)) {
      return fail(`kintone option index ${index} is assigned to more than one option; ` +
        'indices must be unique within a field to issue unique target identifiers');
    }
    seenIndices.add(index);
  }
  entries.sort((a, b) => a.index - b.index);
  const needsTranslation = !entries.every(({ value }) => SAFE_OPTION_VALUE.test(value));
  const optionValueMap: Record<string, string> = {};
  const resolvedOptions = entries.map(({ value, label, index }) => {
    const mapped = needsTranslation ? `opt_${index}` : value;
    if (needsTranslation) optionValueMap[value] = mapped;
    return { value: mapped, label, disabled: false };
  });
  const targetValues = resolvedOptions.map(({ value }) => value);
  if (new Set(targetValues).size !== targetValues.length) {
    return fail('issued target option identifiers are not unique within the field');
  }
  if (needsTranslation && Object.keys(optionValueMap).length !== entries.length) {
    return fail('source -> target option map does not cover every option');
  }
  // The field default is a reference point of the same identifiers: it
  // must name a member of the option set and is translated through the
  // same map. The target field model has no default-value mechanism, so
  // the translated default is carried on the compatibility item (and
  // into the package report) as evidence instead of being dropped.
  const rawDefault = source?.defaultValue;
  let resolvedDefaultValue: string | string[] | undefined;
  if (rawDefault !== undefined && rawDefault !== null && rawDefault !== '') {
    const defaults = (Array.isArray(rawDefault) ? rawDefault : [rawDefault]).map(String);
    for (const value of defaults) {
      if (!seenValues.has(value)) {
        return fail(`field default "${value}" is not a member of the option set; ` +
          'a default outside the option set cannot be translated faithfully');
      }
    }
    const translated = defaults.map((value) => (needsTranslation ? optionValueMap[value] : value));
    resolvedDefaultValue = Array.isArray(rawDefault) ? translated : translated[0];
  }
  return {
    resolvedOptions,
    ...(needsTranslation ? { optionValueMap } : {}),
    ...(resolvedDefaultValue !== undefined ? { resolvedDefaultValue } : {}),
  };
}

function identityEntriesOf(value: unknown): { code: string; name: string | null }[] | null {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const entries: { code: string; name: string | null }[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof (entry as any).code !== 'string' ||
      !(entry as any).code) return null;
    entries.push({
      code: String((entry as any).code),
      name: typeof (entry as any).name === 'string' ? String((entry as any).name) : null,
    });
  }
  return entries;
}

/**
 * P4-T3a extraction-time resolution pass. mapKintoneField is deliberately
 * conservative without context; once the full record set (and, where
 * relevant, the related application's fields or an out-of-band category
 * tree capture) is available, the UNRESOLVED verdicts that have a designed
 * platform mechanism are resolved with evidence:
 * - choice fields: deterministic option-identifier translation (labels kept);
 * - identity fields: every value is enumerable into package directory
 *   entries with deterministic source ids; the import administrator maps
 *   them explicitly to target users/groups/organizations (job mappings);
 * - CATEGORY: disabled-in-source with zero values, or an out-of-band tree
 *   capture whose names resolve unambiguously per record;
 * - lookup fields: the six-item structure (relatedApp, relatedKeyField,
 *   fieldMappings, pickerFields, filterCond, sort) verified item by item
 *   against the related application's extracted fields.
 * Anything that cannot be verified stays UNRESOLVED and blocks packaging.
 */
export function resolveExtractionCompatibility(
  compatibility: FieldCompatibility[],
  context: {
    records: any[];
    subtableRows?: KintoneSubtableRow[];
    relatedApps?: Record<string, { fields: any[] }>;
    categoryTree?: { nodes: KintoneCategoryNode[] };
    gateProblems: string[];
  },
): void {
  const localCodes = new Set(compatibility.map((item) => item.sourceFieldCode));
  const resolveChoice = (item: FieldCompatibility, values: unknown[]): boolean => {
    if (item.status !== 'UNRESOLVED') return item.status === 'EQUIVALENT';
    const resolved = resolveChoiceOptions(item.sourceConfig);
    if (!resolved) return false;
    if ('problem' in resolved) {
      // Fail closed: the field stays UNRESOLVED (which alone blocks
      // packaging) and the specific defect is recorded as a gate
      // problem so the block is explicit in the extraction report.
      item.reason = `Choice option identifiers cannot be issued safely: ${resolved.problem}`;
      context.gateProblems.push(
        `CHOICE_OPTION_IDENTITY: field ${item.sourceFieldCode}: ${resolved.problem}`);
      return false;
    }
    item.status = 'EQUIVALENT';
    item.resolvedOptions = resolved.resolvedOptions;
    if (resolved.optionValueMap) {
      item.optionValueMap = resolved.optionValueMap;
      item.translation = 'IDENTIFIER_TRANSLATED';
    }
    if (resolved.resolvedDefaultValue !== undefined) {
      item.resolvedDefaultValue = resolved.resolvedDefaultValue;
    }
    item.reason = resolved.optionValueMap
      ? 'Choice values are carried with deterministic target option identifiers ' +
        '(IDENTIFIER_TRANSLATED); original labels and index order are preserved, the full ' +
        'source -> target map is recorded on this item, and record values plus the field ' +
        'default are translated through the same map. External API raw values are not ' +
        'byte-faithful after translation; labels are preserved verbatim'
      : 'Choice values are already safe target option identifiers and are carried verbatim; ' +
        'the field default was verified against the option set';
    void values;
    return true;
  };
  const resolveIdentity = (item: FieldCompatibility, values: unknown[]): boolean => {
    if (item.status !== 'UNRESOLVED') return item.status === 'EQUIVALENT';
    for (const value of values) {
      if (identityEntriesOf(value) === null) return false;
    }
    item.status = 'EQUIVALENT';
    item.reason = 'Source identities are enumerable into package directory entries with deterministic ' +
      'source ids; the import administrator maps them explicitly to target directory members (job mappings)';
    return true;
  };
  for (const item of compatibility) {
    if (item.sourceType === 'SUBTABLE' && item.tableFields) {
      const rows = (context.subtableRows ?? []).filter((row) => row.sourceTableCode === item.sourceFieldCode);
      let allResolved = true;
      for (const child of item.tableFields) {
        if (child.status === 'EQUIVALENT') continue;
        const values = rows.map((row) => (row.data?.[child.sourceFieldCode] as any)?.value);
        if (KINTONE_CHOICE_TYPES.includes(child.sourceType)) {
          if (!resolveChoice(child, values)) allResolved = false;
        } else if (KINTONE_IDENTITY_TYPES.includes(child.sourceType)) {
          if (!resolveIdentity(child, values)) allResolved = false;
        } else allResolved = false;
      }
      if (allResolved && item.tableFields.every((child) => child.status === 'EQUIVALENT')) {
        item.status = 'EQUIVALENT';
        item.reason = 'Subtable row schema maps to supported SuzuBase table fields';
      }
      continue;
    }
    if (item.status !== 'UNRESOLVED') continue;
    if (KINTONE_CHOICE_TYPES.includes(item.sourceType)) {
      resolveChoice(item, context.records.map((record) => record[item.sourceFieldCode]?.value));
      continue;
    }
    if (KINTONE_IDENTITY_TYPES.includes(item.sourceType)) {
      resolveIdentity(item, context.records.map((record) => record[item.sourceFieldCode]?.value));
      continue;
    }
    if (item.sourceType === 'CATEGORY') {
      const config = item.sourceConfig as any;
      const recordValues = context.records.map((record) => ({
        recordId: String(record.$id?.value ?? ''),
        names: Array.isArray(record[item.sourceFieldCode]?.value)
          ? record[item.sourceFieldCode].value.map(String) : [],
      }));
      if (config?.enabled === false && recordValues.every(({ names }) => names.length === 0)) {
        item.status = 'EQUIVALENT';
        item.targetType = null;
        item.categoryResolution = { mode: 'disabled' };
        item.reason = 'Category feature is disabled in the source application and no record carries ' +
          'category values; the target application keeps categories disabled with an empty tree';
      } else if (context.categoryTree) {
        const { resolved, unresolved } = resolveKintoneCategories(
          context.categoryTree.nodes, recordValues);
        if (unresolved.length) {
          for (const entry of unresolved) {
            context.gateProblems.push(
              `UNRESOLVED_CATEGORY_IDENTITY: record ${entry.recordId} category "${entry.name}" ` +
              'does not resolve to exactly one captured source node');
          }
        } else {
          item.status = 'EQUIVALENT';
          item.targetType = null;
          item.categoryResolution = {
            mode: 'tree', nodes: context.categoryTree.nodes, assignments: resolved,
          };
          item.reason = 'Category tree captured out of band; every record category name resolves to ' +
            'exactly one source node and assignments are carried by node id';
        }
      }
      continue;
    }
    if ((item.sourceConfig as any)?.lookup) {
      const lookup = (item.sourceConfig as any).lookup;
      const relatedAppId = String(lookup.relatedApp?.app ?? '');
      const relatedFields = context.relatedApps?.[relatedAppId]?.fields;
      if (!relatedFields) continue;
      const relatedCodes = new Set(relatedFields.map((field: any) => String(field.code ?? '')));
      const localFieldExists = (code: string) => localCodes.has(code);
      const sortText = String(lookup.sort ?? '').trim();
      let sort: KintoneLookupResolution['sort'] = null;
      let sortValid = true;
      if (sortText) {
        const match = sortText.match(/^(.+?)\s+(asc|desc)$/i);
        if (!match || !relatedCodes.has(match[1])) sortValid = false;
        else sort = { field: match[1], direction: match[2].toLowerCase() as 'asc' | 'desc' };
      }
      const mappings = Array.isArray(lookup.fieldMappings) ? lookup.fieldMappings : [];
      const pickerFields = Array.isArray(lookup.lookupPickerFields)
        ? lookup.lookupPickerFields.map(String) : [];
      const verified = Boolean(relatedAppId) &&
        relatedCodes.has(String(lookup.relatedKeyField ?? '')) &&
        mappings.every((mapping: any) => localFieldExists(String(mapping.field ?? '')) &&
          relatedCodes.has(String(mapping.relatedField ?? ''))) &&
        pickerFields.every((code: string) => relatedCodes.has(code)) &&
        String(lookup.filterCond ?? '') === '' && sortValid;
      if (verified) {
        item.status = 'EQUIVALENT';
        item.targetType = 'lookup';
        item.lookupResolution = {
          relatedAppId,
          relatedKeyField: String(lookup.relatedKeyField),
          copies: mappings.map((mapping: any) => ({
            field: String(mapping.field), relatedField: String(mapping.relatedField),
          })),
          pickerFields,
          filterCond: '',
          sort,
        };
        item.reason = 'Lookup structure verified item by item against the related application: ' +
          'relatedApp, relatedKeyField, fieldMappings, pickerFields, filterCond (empty) and sort all resolve';
      } else if (String(lookup.filterCond ?? '') !== '') {
        item.reason = 'Lookup filterCond is not empty and cannot be translated mechanically; ' +
          'completion is pending';
      }
      continue;
    }
  }
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
    // P4-T1: the platform now implements category trees, but the kintone
    // REST API cannot read the source tree (only in-page JS exposes names)
    // and record values carry names only. Extraction must capture the
    // tree out of band and resolve every value through
    // resolveKintoneCategories; anything ambiguous stays UNRESOLVED and
    // blocks activation (UNRESOLVED_CATEGORY_IDENTITY).
    ...base, targetType: null, status: 'UNRESOLVED',
    reason: 'Category tree requires out-of-band capture; record values are names only and must resolve unambiguously (UNRESOLVED_CATEGORY_IDENTITY otherwise)',
    sourceUnavailable: false, upgradeRequired: false,
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
  if (type === 'SUBTABLE') {
    const tableFields = Object.entries(source.fields ?? {}).map(([childCode, child]: [string, any]) =>
      mapKintoneField({ ...child, code: childCode }, { fields: Object.entries(source.fields ?? {})
        .map(([code, value]: [string, any]) => ({ ...value, code })) }));
    const invalidChild = tableFields.find(({ status, targetType }) =>
      status !== 'EQUIVALENT' || !['text', 'multiline', 'number', 'calculation', 'radio', 'checkbox',
        'select', 'multiselect', 'date', 'time', 'datetime', 'url', 'user', 'organization', 'group', 'attachment']
        .includes(String(targetType)));
    if (!tableFields.length) return {
      ...base, targetType: 'table', status: 'UNRESOLVED',
      reason: 'Subtable has no target-supported child-field definition',
      sourceUnavailable: false, upgradeRequired: false, tableFields,
    };
    if (invalidChild) return {
      ...base, targetType: 'table', status: invalidChild.status === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNRESOLVED',
      reason: `Subtable child ${invalidChild.sourceFieldCode} is not target-compatible: ${invalidChild.reason}`,
      sourceUnavailable: false, upgradeRequired: invalidChild.upgradeRequired, tableFields,
    };
    return {
      ...base, targetType: 'table', status: 'EQUIVALENT',
      reason: 'Subtable row schema maps to supported SuzuBase table fields',
      sourceUnavailable: false, upgradeRequired: false, tableFields,
    };
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
  if (['RADIO_BUTTON', 'DROP_DOWN', 'CHECK_BOX', 'MULTI_SELECT'].includes(type)) {
    const mappedOptions = targetOptions(source.options);
    if (!mappedOptions.length || mappedOptions.some(({ value }) => !/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value))) return {
      ...base, targetType: direct[type], status: 'UNRESOLVED',
      reason: 'Source choice values cannot be represented safely by target option identifiers',
      sourceUnavailable: false, upgradeRequired: false,
    };
  }
  return { ...base, targetType: direct[type], status: 'EQUIVALENT',
    reason: 'Target field preserves source value semantics', sourceUnavailable: false, upgradeRequired: false };
}

export function sha256Buffer(buffer: Uint8Array) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function stableSourceUuid(sourceKey: string) {
  const hex = createHash('sha256').update(sourceKey).digest('hex');
  // P4-T3a: the derived identifiers cross API boundaries whose schemas
  // validate RFC 4122 UUIDs (z.uuid()), so the version (4) and variant
  // (10xx) nibbles are set explicitly. The derivation stays deterministic;
  // identifiers minted before this change differ and must not be mixed
  // into a new package (extractions are always rebuilt fresh).
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
  /** P4-T3a: source items that remain unavailable but are explicitly
   * tolerated by the caller (e.g. the workflow-definitions endpoint, which
   * answers 404 for API tokens and is recorded as SOURCE_UNAVAILABLE in the
   * evidence and the migration report). They never disappear from the
   * evidence; only the package gate ignores exactly these items. */
  toleratedUnavailable?: string[];
  sourceMetadata?: {
    layout: unknown;
    settings: unknown;
    acl: { app: unknown; record: unknown; field: unknown };
    workflow: { status: unknown; definitions: unknown };
  };
  gateProblems?: string[];
  downgrades?: { item: string; reason: string; sourceCount: number }[];
}

function kintoneValue(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object' && 'value' in value) return kintoneValue(value.value);
  return JSON.stringify(value);
}

function sourceUserId(appId: string, user: any) {
  const code = String(user?.code ?? user?.userId ?? '');
  return code ? stableSourceUuid(`kintone:${appId}:user:${code}`) : null;
}

function sourceDirectoryUsers(appId: string, comments: any[]) {
  const users = new Map<string, { id: string; email: string; loginName: string | null;
    displayName: string | null; disabled: boolean }>();
  const add = (identity: any) => {
    const id = sourceUserId(appId, identity);
    if (!id) return;
    const code = String(identity.code ?? identity.userId);
    users.set(id, {
      id, email: '', loginName: code,
      displayName: String(identity.name ?? identity.displayName ?? code), disabled: false,
    });
  };
  for (const comment of comments) {
    add(comment.creator ?? comment.user);
    for (const mention of comment.mentions ?? []) add(mention.user ?? mention);
  }
  return [...users.values()];
}

export function kintoneCommentText(comment: any): string {
  // Real kintone comments carry their text in `text`; earlier adapter code
  // read `content`/`body` (the synthetic fixture shape), which silently
  // sealed empty comment bodies for every real extraction.
  return kintoneValue(comment.text ?? comment.content ?? comment.body ?? '');
}

function mappedCommentMentions(appId: string, comment: any, displayNames?: Map<string, string>) {
  const body = kintoneCommentText(comment);
  return (comment.mentions ?? []).flatMap((mention: any) => {
    const userId = sourceUserId(appId, mention.user ?? mention);
    if (!userId) return [];
    const code = String(mention.code ?? mention.user?.code ?? '');
    const name = String(mention.name ?? mention.user?.name ?? mention.displayName ??
      (code ? displayNames?.get(code) : undefined) ?? code ?? '');
    let offset = Number.isInteger(mention.offset) ? mention.offset : -1;
    let length = Number.isInteger(mention.length) ? mention.length : 0;
    if (offset < 0 && name) {
      // Kintone renders a mention as the user's display name in the text
      // (no '@'); try the '@name' form first, then the bare display name.
      for (const matched of [`@${name}`, name]) {
        const foundAt = body.indexOf(matched);
        if (foundAt >= 0 && body.indexOf(matched, foundAt + matched.length) < 0) {
          offset = foundAt;
          length = matched.length;
          break;
        }
      }
    }
    if (offset < 0 || length <= 0 || offset + length > body.length) return [];
    return [{ userId, offset, length }];
  });
}

function sourceEntryCount(value: any): number {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  for (const key of ['rights', 'states', 'actions']) {
    if (Array.isArray(value[key])) count += value[key].length;
    else if (value[key] && typeof value[key] === 'object') count += Object.keys(value[key]).length;
  }
  if (count) return count;
  if (value.processes && typeof value.processes === 'object') return Object.keys(value.processes).length;
  return 0;
}

export function buildM1CompatiblePackage(
  extraction: KintoneExtractionResult,
  options: {
    sourceInstanceId?: string; sourceTenantId?: string;
    /** P4-T3a: cross-application lookup targets, keyed by SOURCE (kintone)
     * application id. recordsByKey maps a related record's key-field value
     * to that record's package id in the related application's package, so
     * record references can be sealed into this package. */
    relatedApps?: Record<string, { recordsByKey: Record<string, string> }>;
  } = {},
) {
  if (!extraction.packageReady || !extraction.evidence.frozenWindow) {
    throw new Error('kintone package blocked: frozen snapshot and all source/field/dependency gates are required');
  }
  const toleratedUnavailable = new Set(extraction.toleratedUnavailable ?? []);
  const blockingUnavailable = extraction.evidence.unavailable
    .filter(({ item }) => !toleratedUnavailable.has(item));
  if (blockingUnavailable.length) {
    throw new Error('kintone package blocked: source unavailable items exist');
  }
  if (extraction.blocking.length || extraction.compatibility.some(({ status }) => status === 'UNRESOLVED')) {
    throw new Error('kintone package blocked: unsupported or unresolved mappings exist');
  }
  if (extraction.gateProblems?.length) {
    throw new Error(`kintone package blocked: ${extraction.gateProblems.join('; ')}`);
  }
  if (extraction.attachments.some((file) => !file.sha256 || !file.body)) {
    throw new Error('kintone package blocked: an attachment entity or SHA-256 is unavailable');
  }

  const sourceAppId = extraction.evidence.appId;
  const targetAppId = stableSourceUuid(`kintone-app:${extraction.evidence.appId}`);
  const targetTenantId = options.sourceTenantId ?? stableSourceUuid(`kintone-tenant:${extraction.evidence.appId}`);
  const fieldId = (code: string) => stableSourceUuid(`kintone:${sourceAppId}:field:${code}`);
  const targetFormula = (formula: KintoneFormulaToken[] | null | undefined, tableCode?: string) =>
    formula?.map((token) => token.kind === 'field'
      ? { ...token, fieldId: fieldId(tableCode ? `${tableCode}:${token.fieldId}` : token.fieldId) }
      : token) ?? null;
  // P4-T3a: directory entries are collected from record identity values as
  // well as from comments, so every identity a record references is present
  // in the package directory (deterministic source ids; the import
  // administrator maps them explicitly to target members).
  const recordDirectoryUsers = new Map<string, any>();
  const recordDirectoryOrganizations = new Map<string, any>();
  const recordDirectoryGroups = new Map<string, any>();
  const directoryIdFor = (sourceType: string, code: string) => sourceType === 'ORGANIZATION_SELECT'
    ? stableSourceUuid(`kintone:${sourceAppId}:organization:${code}`)
    : sourceType === 'GROUP_SELECT'
      ? stableSourceUuid(`kintone:${sourceAppId}:group:${code}`)
      : stableSourceUuid(`kintone:${sourceAppId}:user:${code}`);
  const collectIdentity = (sourceType: string, value: unknown) => {
    for (const entry of identityEntriesOf(value) ?? []) {
      const id = directoryIdFor(sourceType, entry.code);
      if (sourceType === 'ORGANIZATION_SELECT') {
        if (!recordDirectoryOrganizations.has(id)) {
          recordDirectoryOrganizations.set(id, { id, name: entry.name ?? entry.code, parentId: null });
        }
      } else if (sourceType === 'GROUP_SELECT') {
        if (!recordDirectoryGroups.has(id)) {
          recordDirectoryGroups.set(id, { id, name: entry.name ?? entry.code, memberUserIds: [] });
        }
      } else if (!recordDirectoryUsers.has(id)) {
        recordDirectoryUsers.set(id, {
          id, email: '', loginName: entry.code, displayName: entry.name ?? entry.code, disabled: false,
        });
      }
    }
  };
  for (const item of extraction.compatibility) {
    if (KINTONE_IDENTITY_TYPES.includes(item.sourceType)) {
      for (const record of extraction.records as any[]) {
        collectIdentity(item.sourceType, record[item.sourceFieldCode]?.value);
      }
    }
    if (item.sourceType === 'SUBTABLE' && item.tableFields) {
      for (const child of item.tableFields) {
        if (!KINTONE_IDENTITY_TYPES.includes(child.sourceType)) continue;
        for (const row of extraction.subtableRows) {
          if (row.sourceTableCode === item.sourceFieldCode) {
            collectIdentity(child.sourceType, (row.data?.[child.sourceFieldCode] as any)?.value);
          }
        }
      }
    }
  }
  const translateIdentityValue = (sourceType: string, value: unknown, where: string): string | null => {
    const entries = identityEntriesOf(value);
    if (entries === null) {
      throw new Error(`kintone package blocked: identity value at ${where} is not enumerable`);
    }
    if (!entries.length) return null;
    if (entries.length > 1) {
      throw new Error(`kintone package blocked: multi-entry identity value at ${where} ` +
        'cannot be represented in a single-value target field');
    }
    return directoryIdFor(sourceType, entries[0].code);
  };
  const translateChoiceValue = (item: FieldCompatibility, raw: unknown): string => {
    const map = item.optionValueMap;
    if (Array.isArray(raw)) {
      return JSON.stringify(raw.map((value) => (map?.[String(value)] ?? String(value))));
    }
    const text = raw === null || raw === undefined ? '' : String(raw);
    return map?.[text] ?? text;
  };
  const relatedFieldId = (relatedAppId: string, code: string) =>
    stableSourceUuid(`kintone:${relatedAppId}:field:${code}`);
  const fields: any[] = [];
  const relations: any[] = [];
  let packageCategories: { enabled: boolean; nodes: any[] } | undefined;
  for (const item of extraction.compatibility) {
    const config = item.sourceConfig as any;
    if (item.sourceType === 'CATEGORY') {
      // Categories are application configuration in SuzuBase, not a field.
      const resolution = item.categoryResolution;
      if (!resolution) {
        throw new Error('kintone package blocked: category field has no extraction resolution');
      }
      packageCategories = resolution.mode === 'disabled'
        ? { enabled: false, nodes: [] }
        : {
          enabled: true,
          nodes: (resolution.nodes ?? []).map((node) => ({
            id: stableSourceUuid(`kintone:${sourceAppId}:category:${node.id}`),
            parentId: node.parentId
              ? stableSourceUuid(`kintone:${sourceAppId}:category:${node.parentId}`) : null,
            name: node.name, sortOrder: node.sortOrder,
          })),
        };
      continue;
    }
    const tableFields = item.tableFields?.map((child) => {
      const childConfig = child.sourceConfig as any;
      return {
        fieldId: fieldId(`${item.sourceFieldCode}:${child.sourceFieldCode}`),
        code: child.sourceFieldCode,
        name: String(childConfig.label ?? child.sourceFieldCode),
        type: child.targetType,
        required: Boolean(childConfig.required),
        uniqueValue: Boolean(childConfig.unique),
        options: child.resolvedOptions ?? targetOptions(childConfig.options),
        formula: targetFormula(child.formula, item.sourceFieldCode),
      };
    });
    const layoutKind: Record<string, string> = {
      GROUP: 'group', LABEL: 'label', SPACER: 'blank', HR: 'separator',
    };
    const baseField = {
      required: Boolean(config.required),
      uniqueValue: Boolean(config.unique),
      searchMode: null,
      formula: targetFormula(item.formula),
      related: null,
      table: tableFields?.length ? {
        fields: tableFields, minRows: 0, maxRows: 100,
        addRows: true, deleteRows: true, reorderRows: true,
      } : null,
      layoutElement: layoutKind[item.sourceType]
        ? { kind: layoutKind[item.sourceType], text: String(config.label ?? item.sourceFieldCode) } : null,
      autoNumber: null,
      options: item.resolvedOptions ?? targetOptions(config.options),
      kintoneSource: {
        sourceType: item.sourceType,
        sourceConfig: item.sourceConfig,
        compatibility: item.status,
        reason: item.reason,
      },
    };
    if (item.lookupResolution) {
      // A kintone lookup field stores the key value on the record. The
      // target lookup field needs an independent local key field, so the
      // source field becomes a lookup field plus a synthetic `<code>__key`
      // text field that carries the stored key value verbatim.
      const resolution = item.lookupResolution;
      const relatedAppId = stableSourceUuid(`kintone-app:${resolution.relatedAppId}`);
      const baseType = mapKintoneField({ ...config, lookup: undefined }).targetType;
      fields.push({
        ...baseField,
        fieldId: fieldId(`${item.sourceFieldCode}__key`),
        code: `${item.sourceFieldCode}__key`,
        name: `${String(config.label ?? item.sourceFieldCode)} (lookup key)`,
        type: baseType, required: false, uniqueValue: false,
        formula: null, table: null, layoutElement: null, options: [],
        lookup: null,
        kintoneSource: {
          sourceType: item.sourceType, sourceConfig: item.sourceConfig,
          compatibility: item.status,
          reason: 'Synthetic local key field carrying the kintone lookup key value verbatim',
        },
      });
      const lookupConfig = {
        appId: relatedAppId,
        keyFieldId: relatedFieldId(resolution.relatedAppId, resolution.relatedKeyField),
        localKeyFieldId: fieldId(`${item.sourceFieldCode}__key`),
        copies: resolution.copies.map((copy) => ({
          sourceFieldId: relatedFieldId(resolution.relatedAppId, copy.relatedField),
          targetFieldId: fieldId(copy.field),
        })),
        ...(resolution.pickerFields.length
          ? { displayFieldIds: resolution.pickerFields.map((code) =>
            relatedFieldId(resolution.relatedAppId, code)) }
          : {}),
        ...(resolution.sort
          ? { sort: {
            fieldId: relatedFieldId(resolution.relatedAppId, resolution.sort.field),
            direction: resolution.sort.direction,
          } }
          : {}),
      };
      fields.push({
        ...baseField,
        fieldId: fieldId(item.sourceFieldCode),
        code: item.sourceFieldCode,
        name: String(config.label ?? item.sourceFieldCode),
        type: 'lookup', required: false, uniqueValue: false,
        formula: null, table: null, layoutElement: null, options: [],
        lookup: lookupConfig,
      });
      relations.push({
        fieldId: fieldId(item.sourceFieldCode), kind: 'lookup', config: lookupConfig,
        target: { appId: relatedAppId, appCode: `kintone-${resolution.relatedAppId}` },
      });
      continue;
    }
    fields.push({
      ...baseField,
      fieldId: fieldId(item.sourceFieldCode),
      code: item.sourceFieldCode,
      name: String(config.label ?? item.sourceFieldCode),
      type: item.targetType,
      lookup: null,
    });
  }
  const categoryItem = extraction.compatibility.find((item) => item.sourceType === 'CATEGORY');
  const references: {
    recordId: string; fieldId: string; targetAppId: string;
    targetAppCode: string; targetRecordId: string;
  }[] = [];
  for (const item of extraction.compatibility) {
    if (!item.lookupResolution) continue;
    const related = options.relatedApps?.[item.lookupResolution.relatedAppId];
    if (!related) {
      throw new Error(`kintone package blocked: lookup ${item.sourceFieldCode} requires the related ` +
        'application\'s records to seal record references');
    }
    for (const record of extraction.records as any[]) {
      const key = kintoneValue(record[item.sourceFieldCode]);
      if (!key) continue;
      const targetRecordId = related.recordsByKey[key];
      if (!targetRecordId) {
        throw new Error(`kintone package blocked: lookup key "${key}" in ${item.sourceFieldCode} ` +
          'has no record in the related application package');
      }
      references.push({
        recordId: stableSourceUuid(`kintone:${sourceAppId}:record:${String(record.$id?.value ?? '')}`),
        fieldId: fieldId(item.sourceFieldCode),
        targetAppId: stableSourceUuid(`kintone-app:${item.lookupResolution.relatedAppId}`),
        targetAppCode: `kintone-${item.lookupResolution.relatedAppId}`,
        targetRecordId,
      });
    }
  }
  const records = extraction.records.map((record: any) => {
    const sourceId = String(record.$id?.value ?? '');
    const data: Record<string, string> = {};
    for (const item of extraction.compatibility) {
      const source = record[item.sourceFieldCode];
      if (item.sourceType === 'SUBTABLE' || item.sourceType === 'CATEGORY') continue;
      if (item.lookupResolution) {
        // The key value is carried by the synthetic local key field; the
        // lookup field itself holds no stored value.
        if (source !== undefined) {
          data[fieldId(`${item.sourceFieldCode}__key`)] = kintoneValue(source);
        }
        continue;
      }
      if (source === undefined) continue;
      if (item.sourceType === 'FILE') {
        data[fieldId(item.sourceFieldCode)] = JSON.stringify((source.value ?? []).map((file: any) =>
          stableSourceUuid(`kintone:${sourceAppId}:file:${file.fileKey}`)));
      } else if (KINTONE_IDENTITY_TYPES.includes(item.sourceType)) {
        const translated = translateIdentityValue(item.sourceType, source.value,
          `record ${sourceId} field ${item.sourceFieldCode}`);
        if (translated !== null) data[fieldId(item.sourceFieldCode)] = translated;
      } else if (KINTONE_CHOICE_TYPES.includes(item.sourceType)) {
        data[fieldId(item.sourceFieldCode)] = translateChoiceValue(item, source.value);
      } else {
        data[fieldId(item.sourceFieldCode)] = kintoneValue(source);
      }
    }
    const creatorItem = extraction.compatibility.find((item) => item.sourceType === 'CREATOR');
    const modifierItem = extraction.compatibility.find((item) => item.sourceType === 'MODIFIER');
    const createdTimeItem = extraction.compatibility.find((item) => item.sourceType === 'CREATED_TIME');
    const updatedTimeItem = extraction.compatibility.find((item) => item.sourceType === 'UPDATED_TIME');
    const createdBy = creatorItem
      ? translateIdentityValue('CREATOR', record[creatorItem.sourceFieldCode]?.value,
        `record ${sourceId} creator`)
      : null;
    const updatedBy = modifierItem
      ? translateIdentityValue('MODIFIER', record[modifierItem.sourceFieldCode]?.value,
        `record ${sourceId} modifier`)
      : null;
    const categoryIds = categoryItem?.categoryResolution?.mode === 'tree'
      ? (categoryItem.categoryResolution.assignments?.[sourceId] ?? []).map((nodeId) =>
        stableSourceUuid(`kintone:${sourceAppId}:category:${nodeId}`))
      : [];
    return {
      id: stableSourceUuid(`kintone:${sourceAppId}:record:${sourceId}`),
      recordNo: kintoneValue(record.$id),
      data,
      categoryIds,
      archivedData: {},
      schemaVersion: 1,
      revision: 1,
      status: 'PUBLISHED',
      createdBy: createdBy ?? stableSourceUuid(`kintone:${sourceAppId}:creator:unknown`),
      createdAt: createdTimeItem
        ? (kintoneValue(record[createdTimeItem.sourceFieldCode]) || extraction.evidence.extractedAt)
        : extraction.evidence.extractedAt,
      updatedBy: updatedBy ?? stableSourceUuid(`kintone:${sourceAppId}:modifier:unknown`),
      updatedAt: updatedTimeItem
        ? (kintoneValue(record[updatedTimeItem.sourceFieldCode]) || extraction.evidence.extractedAt)
        : extraction.evidence.extractedAt,
      deletedBy: null,
      deletedAt: null,
      workflow: null,
      kintoneSourceId: sourceId,
    };
  });
  const tableRows = extraction.subtableRows.map((row) => {
    const table = extraction.compatibility.find((item) => item.sourceFieldCode === row.sourceTableCode);
    if (!table || table.status !== 'EQUIVALENT' || !table.tableFields) {
      throw new Error(`kintone package blocked: table ${row.sourceTableCode} has no verified child schema`);
    }
    const data: Record<string, string> = {};
    for (const [sourceCode, value] of Object.entries(row.data)) {
      const child = table.tableFields.find((item) => item.sourceFieldCode === sourceCode);
      if (!child) throw new Error(`kintone package blocked: unknown child field ${row.sourceTableCode}.${sourceCode}`);
      const targetFieldId = fieldId(`${row.sourceTableCode}:${sourceCode}`);
      if (child.sourceType === 'FILE') {
        // Subtable attachment cells carry the same target file ids as
        // top-level file fields, so the import can reconcile them.
        data[targetFieldId] = JSON.stringify(((value as any)?.value ?? []).map((file: any) =>
          stableSourceUuid(`kintone:${sourceAppId}:file:${file.fileKey}`)));
      } else if (KINTONE_IDENTITY_TYPES.includes(child.sourceType)) {
        const translated = translateIdentityValue(child.sourceType, (value as any)?.value,
          `subtable ${row.sourceTableCode} row ${row.sourceRowId} field ${sourceCode}`);
        if (translated !== null) data[targetFieldId] = translated;
      } else if (KINTONE_CHOICE_TYPES.includes(child.sourceType)) {
        data[targetFieldId] = translateChoiceValue(child, (value as any)?.value);
      } else {
        data[targetFieldId] = kintoneValue(value);
      }
    }
    return {
      recordId: stableSourceUuid(`kintone:${sourceAppId}:record:${row.sourceRecordId}`),
      fieldId: fieldId(row.sourceTableCode),
      rowId: row.targetRowId,
      rowOrder: row.rowOrder,
      data,
    };
  });
  const attachmentEntries = extraction.attachments.map((file) => ({
    fileId: stableSourceUuid(`kintone:${sourceAppId}:file:${file.fileKey}`),
    version: 1,
    sha256: file.sha256!,
    bytes: file.bytes ?? 0,
    state: 'READY',
    name: file.name ?? file.fileKey,
    contentType: 'application/octet-stream',
  }));
  const attachmentMetadata = extraction.attachments.map((file, index) => ({
    id: attachmentEntries[index].fileId,
    uploadedBy: stableSourceUuid(`kintone:${sourceAppId}:user:unknown`),
    name: file.name ?? file.fileKey,
    contentType: 'application/octet-stream',
    bytes: file.bytes ?? 0,
    sha256: file.sha256,
    state: 'READY',
    version: 1,
    referenceCount: 0,
    createdAt: extraction.evidence.extractedAt,
    deletedAt: null,
  }));
  const attachmentBodies = Object.fromEntries(extraction.attachments
    .filter((file) => file.body && file.sha256)
    .map((file) => [`attachments/${stableSourceUuid(`kintone:${sourceAppId}:file:${file.fileKey}`)}/v1/body`, Buffer.from(file.body!)]));

  const expected: ObjectCounts = emptyCounts();
  const commentDirectoryUsers = sourceDirectoryUsers(sourceAppId, extraction.comments);
  const directoryUsers = [...commentDirectoryUsers];
  for (const user of recordDirectoryUsers.values()) {
    const existing = directoryUsers.find((entry) => entry.id === user.id);
    if (!existing) {
      directoryUsers.push(user);
    } else if (existing.displayName === existing.loginName &&
      user.displayName && user.displayName !== user.loginName) {
      // A comment mention carries only the login code, so the comment-derived
      // entry falls back to the code as its display name; a record identity
      // value carries the real display name — prefer it.
      existing.displayName = user.displayName;
    }
  }
  const commentDisplayNames = new Map<string, string>();
  for (const user of directoryUsers) {
    if (user.loginName && user.displayName) commentDisplayNames.set(user.loginName, user.displayName);
  }
  const directoryOrganizations = [...recordDirectoryOrganizations.values()];
  const directoryGroups = [...recordDirectoryGroups.values()];
  expected.apps = 1;
  expected.appVersions = 1;
  expected.fieldVersionSnapshots = 1;
  expected.fields = fields.length;
  expected.records = records.length;
  expected.tableRows = tableRows.length;
  expected.references = references.length;
  expected.attachments = attachmentEntries.length;
  expected.attachmentVersions = attachmentEntries.length;
  expected.comments = extraction.comments.length;
  expected.userReferences = directoryUsers.length;
  expected.workflowVersions = 0;
  expected.aclEntries = 0;

  const compatEvidence = {
    sourceEvidence: extraction.evidence,
    fields: extraction.compatibility,
    subtableRows: extraction.subtableRows,
    subtableStates: extraction.subtableStates,
    attachments: extraction.attachments.map(({ body: _body, ...file }) => file),
    comments: extraction.comments,
    sourceMetadata: extraction.sourceMetadata ?? null,
    downgrades: extraction.downgrades ?? [],
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
        ...(packageCategories ? { categories: packageCategories } : {}),
        migrationReport: compatEvidence, fields }],
      fields,
      rawFields: fields.map((field) => ({ ...field, introducedIn: 1 })),
      deletedFields: [], views: [], formLayout: [], viewConfiguration: { views: [] },
    }),
    'data/workflows.json': JSON.stringify({ definitions: [] }),
    'data/records.json': JSON.stringify({ records }),
    'data/table-rows.json': JSON.stringify({ rows: tableRows }),
    'data/references.json': JSON.stringify({ references }),
    'data/attachments.json': JSON.stringify({ files: attachmentMetadata }),
    'data/comments.json': JSON.stringify({ comments: extraction.comments.map((comment: any, index: number) => ({
      // Kintone comment ids are unique only within their record (every
      // record's first comment is id "1"), so the stable key must include
      // the source record id; keyed by comment id alone, distinct records'
      // comments collide into a single package comment.
      id: stableSourceUuid(`kintone:${sourceAppId}:comment:${String(comment.recordId ?? comment.$id?.value ?? '')}:${String(comment.id ?? index)}`),
      recordId: stableSourceUuid(`kintone:${sourceAppId}:record:${String(comment.recordId ?? comment.$id?.value ?? '')}`),
      authorId: stableSourceUuid(`kintone:${sourceAppId}:user:${String(comment.creator?.code ?? comment.user?.code ?? 'unknown')}`),
      createdAt: comment.createdAt ?? extraction.evidence.extractedAt,
      deleted: false,
      deletedAt: null,
      body: kintoneCommentText(comment),
      mentions: mappedCommentMentions(sourceAppId, comment, commentDisplayNames),
    })) }),
    'data/history.json': JSON.stringify({ recordEvents: [], workflowEvents: [] }),
    'data/config.json': JSON.stringify({
      acl: { app: [], record: [], field: [] },
      notificationRules: [],
      relations,
      apiTokens: [],
      kintoneCompatibility: compatEvidence,
    }),
    'data/directory.json': JSON.stringify({
      users: directoryUsers, groups: directoryGroups, organizations: directoryOrganizations,
    }),
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
        kintoneWorkflow: extraction.downgrades?.some(({ item }) => item === 'workflow')
          ? 'unsupported' : 'absent',
        kintonePermissions: extraction.downgrades?.some(({ item }) => item === 'permissions')
          ? 'unsupported' : 'absent',
        kintoneLayout: extraction.downgrades?.some(({ item }) => item === 'layout')
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
  private readonly checkResolvedAddresses: boolean;

  constructor(origin: string, private readonly apiToken: string,
    private readonly timeoutMs = 15000, private readonly maxRetries = 2,
    private readonly fetcher: typeof fetch = fetch) {
    this.origin = validateKintoneDomain(origin);
    this.checkResolvedAddresses = fetcher === fetch;
  }

  private async ensurePublicDestination() {
    if (!this.checkResolvedAddresses) return;
    const hostname = new URL(this.origin).hostname;
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateHostname(address))) {
      throw new Error('kintone source resolves to an internal or non-public IP address');
    }
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        await this.ensurePublicDestination();
        response = await this.fetcher(this.origin + path, {
          method,
          redirect: 'error',
          headers: {
            'X-Cybozu-API-Token': this.apiToken,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
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
      ['app', '/k/v1/app.json?id=' + encodeURIComponent(appId)],
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
    acceptLayoutDowngrade?: boolean;
    acceptWorkflowDowngrade?: boolean;
    acceptPermissionDowngrade?: boolean;
    checkpoint?: KintoneExtractionCheckpoint;
    onCheckpoint?: (checkpoint: KintoneExtractionCheckpoint) => void | Promise<void>;
    /** P4-T3a: field metadata of related applications (keyed by kintone
     * app id) used to verify lookup structures item by item. */
    relatedApps?: Record<string, { fields: any[] }>;
    /** P4-T3a: out-of-band category tree capture for this application. */
    categoryTree?: { nodes: KintoneCategoryNode[] };
    /** P4-T3a: source items that may remain unavailable without blocking
     * packaging; they stay in the evidence and must be reported by the
     * caller (see KintoneExtractionResult.toleratedUnavailable). */
    tolerateUnavailable?: string[];
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
    const sourceMetadata = {
        layout: preflight.available.layout,
        settings: preflight.available.settings,
      acl: {
          app: preflight.available.appAcl,
          record: preflight.available.recordAcl,
          field: preflight.available.fieldAcl,
      },
      workflow: {
          status: preflight.available.processes,
          definitions: preflight.available.processDefinitions,
      },
    };
    const permissionCount = ['appAcl', 'recordAcl', 'fieldAcl']
      .reduce((total, item) => total + sourceEntryCount(preflight.available[item]), 0);
    const workflowCount = sourceEntryCount(preflight.available.processes) +
      sourceEntryCount(preflight.available.processDefinitions);
    const sourceLayout = preflight.available.layout as any;
    const layoutItems = Array.isArray(sourceLayout) ? sourceLayout :
      Array.isArray(sourceLayout?.layout) ? sourceLayout.layout :
      sourceLayout?.layout && typeof sourceLayout.layout === 'object'
        ? Object.keys(sourceLayout.layout) : [];
    const layoutCount = layoutItems.length;
    const gateProblems: string[] = [];
    const downgrades: NonNullable<KintoneExtractionResult['downgrades']> = [];
    if (permissionCount && options.acceptPermissionDowngrade) {
      downgrades.push({
        item: 'permissions', sourceCount: permissionCount,
        reason: 'Administrator accepted least-privilege default ACL; source ACL evidence is preserved in the package report',
      });
    } else if (permissionCount) {
      gateProblems.push('source permissions require explicit administrator downgrade acceptance');
    }
    if (workflowCount && options.acceptWorkflowDowngrade) {
      downgrades.push({
        item: 'workflow', sourceCount: workflowCount,
        reason: 'Administrator accepted workflow-history downgrade; source workflow evidence is preserved in the package report',
      });
    } else if (workflowCount) {
      gateProblems.push('source workflow requires explicit administrator downgrade acceptance');
    }
    if (layoutCount && options.acceptLayoutDowngrade) {
      downgrades.push({
        item: 'layout', sourceCount: layoutCount,
        reason: 'Administrator accepted form-layout downgrade; source layout evidence is preserved in the package report',
      });
    } else if (layoutCount) {
      gateProblems.push('source form layout requires explicit administrator downgrade acceptance');
    }
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
      if (!cursorId) throw new Error('kintone cursor creation returned no cursor ID');
      while (cursorId) {
        const page = await this.request(
          'GET', `/k/v1/records/cursor.json?id=${encodeURIComponent(cursorId)}`,
        ) as any;
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
              comments.push(...(pageComments.comments ?? []).map((comment: any) => ({
                ...comment, recordId: String(comment.recordId ?? recordId),
              })));
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
      if (cursorId) await this.request(
        'DELETE', `/k/v1/records/cursor.json?id=${encodeURIComponent(cursorId)}`,
      ).catch(() => undefined);
    } catch (error) {
      preflight.unavailable.push({ item: 'records', reason: error instanceof Error ? error.message : 'unavailable', evidence: null });
    }
    // P4-T3a: with the full record set available, resolve the conservative
    // context-free verdicts that have a designed platform mechanism
    // (choice identifiers, directory identities, categories, lookups).
    resolveExtractionCompatibility(compatibility, {
      records, subtableRows,
      relatedApps: options.relatedApps,
      categoryTree: options.categoryTree,
      gateProblems,
    });
    const toleratedUnavailable = [...new Set(options.tolerateUnavailable ?? [])];
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
      sourceMetadata, gateProblems, downgrades, toleratedUnavailable,
      packageReady: blocking.length === 0 &&
        preflight.unavailable.every(({ item }) => toleratedUnavailable.includes(item)) &&
        gateProblems.length === 0 &&
        Boolean(frozenWindow) &&
        !compatibility.some(({ status }) => status === 'UNRESOLVED') };
  }
}
