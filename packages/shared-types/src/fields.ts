const scalar = {
  filter: true, sort: true, aggregate: false, index: true, unique: true,
  csv: 'scalar', storage: 'string',
} as const;
const multiline = { ...scalar, sort: false, index: false, unique: false } as const;
const multiple = { ...scalar, sort: false, index: false, unique: false, csv: 'JSON array', storage: 'JSON string array' } as const;

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
  user: { ...scalar, unique: false, storage: 'tenant user UUID' },
  organization: { ...scalar, unique: false, storage: 'tenant organization UUID' },
  group: { ...scalar, unique: false, storage: 'tenant group UUID' },
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
