import type { SavedView, ViewCondition } from './views';

const scalar = {
  filter: true, sort: true, aggregate: false, index: true, unique: true,
  csv: 'scalar', storage: 'string',
} as const;
const multiline = { ...scalar, sort: false, index: false, unique: false } as const;
const multiple = { ...scalar, sort: false, index: false, unique: false, csv: 'JSON array', storage: 'JSON string array' } as const;

const displayOnly = { filter: false, sort: false, aggregate: false, index: false, unique: false } as const;

export const fieldContract = {
  text: { ...scalar, storage: 'single-line string' },
  multiline: { ...multiline, storage: 'multiline string' },
  number: { ...scalar, aggregate: true, storage: 'canonical decimal string' },
  radio: { ...scalar, storage: 'stable option value' },
  checkbox: multiple,
  select: { ...scalar, storage: 'stable option value' },
  multiselect: multiple,
  date: { ...scalar, storage: 'ISO local date' },
  time: { ...scalar, storage: 'ISO local time with seconds' },
  datetime: { ...scalar, storage: 'UTC ISO datetime from explicit offset' },
  url: { ...scalar, storage: 'HTTP or HTTPS URL' },
  phone: { ...scalar, storage: 'phone display string' },
  email: { ...scalar, storage: 'email display string' },
  autoNumber: { ...scalar, unique: false, storage: 'fixed prefix plus scoped sequence digits' },
  attachment: { ...multiple, filter: false, storage: 'JSON array of file UUIDs', csv: 'attachment manifest' },
  user: { ...scalar, unique: false, storage: 'tenant user UUID' },
  organization: { ...scalar, unique: false, storage: 'tenant organization UUID' },
  group: { ...scalar, unique: false, storage: 'tenant group UUID' },
  richText: { ...displayOnly, storage: 'sanitized HTML fragment', csv: 'plain text' },
  calculation: { ...displayOnly, storage: 'computed decimal or string snapshot', csv: 'computed result, export only' },
  lookup: { ...displayOnly, storage: 'typed snapshots in mapped fields plus record_references', csv: 'local key input, typed snapshots export only' },
  table: { ...displayOnly, storage: 'ordered record_table_rows', csv: 'one row per child row' },
  related: { ...displayOnly, storage: 'no stored value', csv: 'live display fields as read-only text' },
  layout: { ...displayOnly, storage: 'schema only', csv: 'omitted' },
} as const;

export type FieldType = keyof typeof fieldContract;
export const fieldTypes = Object.keys(fieldContract) as [FieldType, ...FieldType[]];

export interface FieldOption {
  value: string;
  label: string;
  disabled: boolean;
}

export const optionFieldTypes: ReadonlySet<FieldType> = new Set(['radio', 'checkbox', 'select', 'multiselect']);
export const multiOptionFieldTypes: ReadonlySet<FieldType> = new Set(['checkbox', 'multiselect']);

export interface AutoNumberConfiguration {
  prefix: string;
  scopeFieldId: string | null;
  nextValue: string;
  padding: number;
  enabled: boolean;
}

export const autoNumberHelp = '自動採番は同じ採番範囲で重複しません。欠番のない連番は保証しません。';

export const textSearchModes = ['name', 'kana', 'customer-id'] as const;
export type TextSearchMode = (typeof textSearchModes)[number];

export const formulaOperators = ['+', '-', '*', '/', '&'] as const;
export type FormulaToken =
  | { kind: 'field'; fieldId: string }
  | { kind: 'number' | 'text'; value: string }
  | { kind: 'operator'; operator: (typeof formulaOperators)[number] };
export type Formula = FormulaToken[];

export const layoutKinds = ['label', 'separator', 'blank', 'group'] as const;
export interface LayoutElement {
  kind: (typeof layoutKinds)[number];
  text: string;
}

export function isRecordInput(type: FieldType | undefined) {
  return type !== undefined && type !== 'autoNumber' && type !== 'calculation' && type !== 'layout' && type !== 'lookup' && type !== 'related';
}

export interface ReferencePresentation {
  displayFieldIds?: string[];
  conditions?: ViewCondition[];
  sort?: SavedView['sort'];
}

export interface RelatedConfiguration extends ReferencePresentation {
  appId: string;
  localFieldId: string;
  matchFieldId: string;
  pageSize: number;
}

export const relatedCountHelp = 'Counts only records you can view.';

export interface LookupConfiguration extends ReferencePresentation {
  appId: string;
  keyFieldId: string;
  localKeyFieldId: string;
  copies: { sourceFieldId: string; targetFieldId: string }[];
}

export function lookupTargets(fields: FieldDefinition[]) {
  return new Set(fields.flatMap((field) => field.lookup?.copies.map(({ targetFieldId }) => targetFieldId) ?? []));
}

export const tableRowLimit = 100;
export const tableFieldTypes = ['text', 'multiline', 'number', 'calculation', 'radio', 'checkbox', 'select',
  'multiselect', 'date', 'time', 'datetime', 'url', 'user', 'organization', 'group'] as const;
export type TableField = Pick<FieldDefinition, 'fieldId' | 'code' | 'name' | 'required' | 'uniqueValue' | 'options' | 'formula'> &
  { type: (typeof tableFieldTypes)[number] };
export interface TableConfiguration {
  fields: TableField[];
  minRows: number;
  maxRows: number;
  addRows: boolean;
  deleteRows: boolean;
  reorderRows: boolean;
}

export interface FieldDefinition {
  table?: TableConfiguration | null;
  lookup?: LookupConfiguration | null;
  related?: RelatedConfiguration | null;
  fieldId: string;
  code: string;
  name: string;
  type: FieldType;
  required: boolean;
  uniqueValue: boolean;
  options: FieldOption[];
  autoNumber: AutoNumberConfiguration | null;
  searchMode: TextSearchMode | null;
  formula: Formula | null;
  layoutElement: LayoutElement | null;
}

export const layoutWidths = [3, 4, 6, 8, 9, 12] as const;
export type LayoutCell = { fieldId: string; width: (typeof layoutWidths)[number] };
export type FormLayout = { id: string; groupFieldId?: string; cells: LayoutCell[] }[];

/**
 * P4-T1 categories (kintone カテゴリ mirror): an app-level tree, NOT a field.
 * Nodes carry an immutable internal id and a stable parent id; names may
 * repeat under the same parent (kintone allows same-level duplicates), so
 * identity is the id alone and a path is display/source-reconciliation only.
 * Renaming a node never changes record assignment (assignments store ids).
 */
export interface CategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
}

export interface CategoryConfiguration {
  enabled: boolean;
  nodes: CategoryNode[];
}

export const emptyCategoryConfiguration: CategoryConfiguration = { enabled: false, nodes: [] };
export const categoryNodeLimit = 1000;
export const categoryDepthLimit = 5;

/** The node itself plus every descendant id (parent filtering is descendant-inclusive). */
export function categorySubtreeIds(configuration: CategoryConfiguration, nodeId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const node of configuration.nodes) {
    if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  }
  const result = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    for (const child of children.get(queue.pop()!) ?? []) {
      if (!result.has(child)) { result.add(child); queue.push(child); }
    }
  }
  return result;
}

/** Display path of a node, root first, e.g. ['関東', '東京']. Display only, never an identity key. */
export function categoryPath(configuration: CategoryConfiguration, nodeId: string): string[] {
  const byId = new Map(configuration.nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  let current = byId.get(nodeId);
  while (current) {
    path.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export const indexPurposes = ['filter', 'sort', 'search'] as const;
export type IndexPurpose = (typeof indexPurposes)[number];
export const boundedSortTypes: ReadonlySet<FieldType> = new Set([
  'number', 'radio', 'select', 'date', 'time', 'datetime', 'email', 'user', 'organization', 'group', 'autoNumber',
]);
