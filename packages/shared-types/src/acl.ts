import type { ViewCondition } from './views';

export const appActions = ['view', 'create', 'edit', 'delete', 'import', 'export', 'manage'] as const;
export const recordActions = ['view', 'edit', 'delete'] as const;
export const fieldActions = ['view', 'edit'] as const;

export type AppAction = (typeof appActions)[number];
export type RecordAction = (typeof recordActions)[number];
export type FieldAction = (typeof fieldActions)[number];

export interface DirectorySubject {
  kind: 'user' | 'group' | 'organization';
  id: string;
}
export type RecordSubject = DirectorySubject | { kind: 'user-field' | 'group-field' | 'organization-field'; id: string };

export interface AclConfiguration {
  app: { id: string; action: AppAction; subject: DirectorySubject }[];
  record: { id: string; action: RecordAction; subject: RecordSubject; conditions: ViewCondition[] }[];
  field: { id: string; action: FieldAction; subject: DirectorySubject; fieldId: string }[];
}
