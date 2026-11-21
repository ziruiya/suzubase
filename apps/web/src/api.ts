import type { AutoNumberConfiguration, FieldOption, FieldType, FormLayout, Formula, LayoutElement, LookupConfiguration, RelatedConfiguration, TextSearchMode, ViewConfiguration } from '@suzubase/shared-types';

export interface Profile {
  tenantId: string;
  userId: string;
  displayName: string | null;
  email: string;
  isAdmin: boolean;
  canManageRecycleBin: boolean;
  canReadArchivedFields: boolean;
  canCreateApps: boolean;
  allowAppCreation: boolean;
  localDrafts: boolean;
  timeZone: string;
  draftExpiryHours: number;
}

export interface AppSummary {
  id: string;
  name: string;
  description: string;
  code: string;
  archivedAt: string | null;
}

export interface Field {
  fieldId: string;
  name: string;
  code: string;
  type: FieldType;
  required: boolean;
  uniqueValue: boolean;
  formula: Formula | null;
  layoutElement: LayoutElement | null;
  options: FieldOption[];
  autoNumber: AutoNumberConfiguration | null;
  searchMode: TextSearchMode | null;
  editable: boolean;
  lookup?: LookupConfiguration | null;
  related?: RelatedConfiguration | null;
}

export interface App extends AppSummary, ViewConfiguration {
  schemaVersion: number;
  localDrafts: boolean;
  fields: Field[];
  formLayout: FormLayout;
  can: { create: boolean; edit: boolean; delete: boolean; manage: boolean; export: boolean };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super([403, 404].includes(status) ? '无权限' : typeof body.message === 'string' ? body.message : 'Some values need attention.');
  }
}

export async function response(path: string, token?: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (typeof options.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const result = await fetch('/api' + path, { ...options, headers });
  if (!result.ok) {
    const body = await result.json().catch(() => ({}));
    throw new ApiError(result.status, body);
  }
  return result;
}

export async function api<T>(path: string, token?: string, options?: RequestInit): Promise<T> {
  return (await response(path, token, options)).json();
}

export function json(method: string, value?: unknown): RequestInit {
  return { method, ...(value !== undefined && { body: JSON.stringify(value) }) };
}

export const appPath = (id: string) => '/apps/' + id;

export type Session = {
  token: string;
  profile: Profile;
  draftAllowed: { current: boolean };
};

export async function download(path: string, token: string, filename: string) {
  const result = await response(path, token);
  const url = URL.createObjectURL(await result.blob());
  const link = document.createElement('a');
  link.href = url;
  const disposition = result.headers.get('Content-Disposition');
  link.download = /^attachment; filename="([^"\/]+)"$/.exec(disposition ?? '')?.[1] ?? filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const message = (error: unknown) => error instanceof Error ? error.message : 'The request failed.';
