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
  /** P4-T1: category node ids assigned to this record (empty when none). */
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
