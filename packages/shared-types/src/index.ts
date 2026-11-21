export * from './fields';

export type RecordData = Record<string, string>;

export interface RecordResponse {
  id: string;
  appId: string;
  recordNo: string;
  data: RecordData;
  schemaVersion: number;
  revision: number;
  status: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface FieldChange {
  fieldId: string;
  oldValue: string | null;
  newValue: string | null;
}
export * from './views';
