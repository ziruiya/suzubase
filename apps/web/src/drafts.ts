import type { RecordData } from '@suzubase/shared-types';

export type DraftScope = readonly [tenant: string, user: string, app: string, record: string, version: number];

export interface Draft {
  key: string;
  scope: DraftScope;
  revision: number | null;
  values: RecordData;
  changedFields: string[];
  pendingFiles: { fieldId: string; name: string }[];
  savedAt: number;
  expiresAt: number;
}

export function draftKey(scope: DraftScope) {
  return JSON.stringify(scope);
}

async function openDrafts() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('suzubase-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useStore<T>(operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await openDrafts();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite');
      const request = operation(transaction.objectStore('drafts'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Draft transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function writeDraft(draft: Draft, allowed: () => boolean) {
  return useStore((store) => {
    if (!allowed()) throw new Error('Local drafts are disabled');
    return store.put(draft);
  });
}

export async function removeDrafts(predicate: (draft: Draft) => boolean) {
  const drafts: Draft[] = await useStore((store) => store.getAll());
  for (const draft of drafts) if (predicate(draft)) await useStore((store) => store.delete(draft.key));
}

export async function recoverDraft(scope: DraftScope) {
  const drafts: Draft[] = await useStore((store) => store.getAll());
  const now = Date.now();
  await removeDrafts((draft) => draft.expiresAt <= now);
  const [tenant, user, app, record] = scope;
  return drafts.filter((draft) => {
    const [draftTenant, draftUser, draftApp, draftRecord] = draft.scope;
    return draftTenant === tenant && draftUser === user && draftApp === app &&
      (draftRecord === record || (record.startsWith('new:') && draftRecord.startsWith('new:'))) && draft.expiresAt > now;
  }).sort((a, b) => b.savedAt - a.savedAt)[0];
}
