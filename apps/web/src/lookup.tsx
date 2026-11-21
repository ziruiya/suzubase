import { useEffect, useState } from 'react';
import { isRecordInput, type LookupConfiguration, type RecordResponse } from '@suzubase/shared-types';
import { api, appPath, json, message, type App, type AppSummary, type Field } from './api';

export function LookupSettings({ token, fields, initial }: { token: string; fields: Field[]; initial?: LookupConfiguration | null }) {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [source, setSource] = useState<Field[]>([]);
  const [appId, setAppId] = useState(initial?.appId ?? '');
  const [key, setKey] = useState(initial?.keyFieldId ?? '');
  const [localKey, setLocalKey] = useState(initial?.localKeyFieldId ?? '');
  const [copies, setCopies] = useState(initial?.copies ?? [{ sourceFieldId: '', targetFieldId: '' }]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<AppSummary[]>('/apps', token).then(setApps).catch((error) => setError(message(error)));
  }, [token]);
  useEffect(() => {
    let active = true;
    if (appId) void api<App>(appPath(appId), token).then(({ fields }) => {
      if (active) setSource(fields);
    }).catch((error) => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [appId, token]);
  const keyType = source.find(({ fieldId }) => fieldId === key)?.type;
  return <fieldset className="stack">
    <legend>Lookup</legend>
    <input name="lookup" type="hidden" value={JSON.stringify({ appId, keyFieldId: key, localKeyFieldId: localKey, copies })} />
    <label>Reference application <select required value={appId} onChange={(event) => {
      setAppId(event.target.value); setSource([]); setKey(''); setLocalKey('');
      setCopies([{ sourceFieldId: '', targetFieldId: '' }]); setError('');
    }}><option value="">Select application</option>{apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}</select></label>
    <label>Reference key <select required value={key} onChange={(event) => { setKey(event.target.value); setLocalKey(''); }}>
      <option value="">Select unique field</option>{source.map((field) =>
        <option key={field.fieldId} value={field.fieldId} disabled={!field.uniqueValue}>{field.name}{!field.uniqueValue && ' (requires uniqueness)'}</option>)}
    </select></label>
    <label>Local key <select required value={localKey} onChange={(event) => setLocalKey(event.target.value)}>
      <option value="">Select local field</option>{fields.filter(({ type }) => type === keyType)
        .map((field) => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
    </select></label>
    <p>Copy destinations become read-only snapshot fields.</p>
    {copies.map((copy, index) => {
      const sourceType = source.find(({ fieldId }) => fieldId === copy.sourceFieldId)?.type;
      return <div className="inline" key={index}>
        <label>Copy from <select required value={copy.sourceFieldId} onChange={(event) =>
          setCopies(copies.map((entry, position) => position === index ? { sourceFieldId: event.target.value, targetFieldId: '' } : entry))}>
          <option value="">Select source field</option>{source.filter(({ type }) => isRecordInput(type) && type !== 'attachment')
            .map((field) => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
        </select></label>
        <label>Copy to <select required value={copy.targetFieldId} onChange={(event) =>
          setCopies(copies.map((entry, position) => position === index ? { ...entry, targetFieldId: event.target.value } : entry))}>
          <option value="">Select destination field</option>{fields.filter((field) =>
            field.type === sourceType && field.fieldId !== localKey && !field.uniqueValue && !field.required)
            .map((field) => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
        </select></label>
        {copies.length > 1 && <button type="button" onClick={() => setCopies(copies.filter((_, position) => position !== index))}>Remove copy</button>}
      </div>;
    })}
    <button type="button" onClick={() => setCopies([...copies, { sourceFieldId: '', targetFieldId: '' }])}>Add copy</button>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

type Changes = { fieldId: string; name: string; current: string | null; incoming: string | null }[];
type Refresh = { changes: Changes; confirmation: string; revision: number };

export function LookupChanges({ changes, compare }: { changes: Changes; compare?: boolean }) {
  return <dl>{changes.map((change) => <div key={change.fieldId} className="value-row">
    <dt>{change.name}</dt>
    <dd>{compare && <>{change.current ?? '—'} → </>}{change.incoming ?? '—'}</dd>
  </div>)}</dl>;
}

export function LookupRefresh({ path, token, onSaved }: { path: string; token: string; onSaved: (record: RecordResponse) => void }) {
  const [preview, setPreview] = useState<Refresh>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    setError('');
    try {
      if (preview) {
        const record = await api<RecordResponse>(path, token, json('POST', {
          confirmation: preview.confirmation, revision: preview.revision,
        }));
        onSaved(record);
        setPreview(undefined);
      } else setPreview(await api<Refresh>(path, token));
    } catch (error) {
      setError(message(error));
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  return <div className="stack">
    {preview && <LookupChanges changes={preview.changes} compare />}
    <div className="inline">
      <button type="button" disabled={busy} onClick={() => void run()}>{preview ? 'Confirm snapshot refresh' : 'Preview snapshot refresh'}</button>
      {preview && <button type="button" disabled={busy} onClick={() => setPreview(undefined)}>Cancel</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function LookupPreview({ path, token, fieldId, value, recordId, disabled }: {
  path: string; token: string; fieldId: string; value: string; recordId?: string; disabled: boolean;
}) {
  const [preview, setPreview] = useState<{ value: string; changes: Changes }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="stack">
    <button type="button" disabled={disabled || busy || !value} onClick={() => {
      setBusy(true);
      setError('');
      void api<{ changes: Changes }>(path, token, json('POST', { fieldId, key: value, recordId }))
        .then(({ changes }) => setPreview({ value, changes })).catch((error) => { setPreview(undefined); setError(message(error)); })
        .finally(() => setBusy(false));
    }}>Get snapshot</button>
    {preview?.value === value && <LookupChanges changes={preview.changes} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}
