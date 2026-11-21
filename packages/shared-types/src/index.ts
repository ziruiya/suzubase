export const fieldTypes = ['text', 'number'] as const;
export type FieldType = (typeof fieldTypes)[number];
