import { useEffect, useState } from 'react';
import { api, appPath, message, type App, type Session } from './api';

export type DirectoryType = 'user' | 'organization' | 'group';
export type SelectorOptions = Record<DirectoryType, { id: string; name: string; disabled?: boolean }[]>;

export function directoryType(type: string): type is DirectoryType {
  return type === 'user' || type === 'organization' || type === 'group';
}

export function useSelectorOptions(app: App | undefined, session: Session) {
  const [options, setOptions] = useState<SelectorOptions>();
  const [error, setError] = useState('');
  const id = app?.id;
  const version = app?.schemaVersion;
  const needsOptions = app?.fields.some(({ type }) => directoryType(type));
  useEffect(() => {
    setOptions(undefined); setError('');
    if (!id || !needsOptions) return;
    let active = true;
    void api<SelectorOptions>(appPath(id) + '/selector-options', session.token).then((result) => {
      if (active) setOptions(result);
    }).catch((error) => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [id, version, needsOptions, session.token]);
  return { options, error };
}
