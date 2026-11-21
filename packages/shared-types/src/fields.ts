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

export function isRecordInput(type: FieldType) {
  return type !== 'autoNumber' && type !== 'calculation' && type !== 'layout';
}
