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
  /** P4-T1: category node ids assigned to this record.
   * P4 fix batch (C2) semantic lock: this is an OPTIONAL compatibility
   * property. It is present when the app's categories are enabled or the
   * record carries assignments; it is omitted for apps that never used
   * categories. Absence therefore means "this response did not provide
   * the property" — it is NOT proof that the record has no category
   * assignments. An empty array is the explicit empty assignment set.
   * Never use the presence or absence of this property for
   * authorization decisions. */
  categoryIds?: string[];
  /** Present only for migration-restored records (contracts 4 SS4.5.3). */
  migration?: {
    importJobId: string;
    sourceActorId: string | null;
    sourceActorName: string | null;
    sourceTimestamp: string | null;
    sourceRecordNo: string | null;
  };
}

export interface TableRow {
  rowId: string;
  data: RecordData;
}

export interface FieldChange {
  rowId?: string;
  rowChange?: 'added' | 'removed' | 'moved';
  childFieldId?: string;
  fieldId: string;
  oldValue: string | null;
  newValue: string | null;
  oldPresent?: boolean;
  newPresent?: boolean;
}
export * from './views';
export * from './acl';

export * from './workflow';
export * from './notifications';
