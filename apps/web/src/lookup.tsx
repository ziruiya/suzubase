import { useEffect, useRef, useState } from 'react';
import { fieldContract, isRecordInput, type LookupConfiguration, type RecordData, type RecordResponse, type ReferencePresentation } from '@suzubase/shared-types';
import { Conditions } from './conditions';
import { api, appPath, json, message, type App, type AppSummary, type Field } from './api';

export function LookupSettings({ token, fields, initial }: { token: string; fields: Field[]; initial?: LookupConfiguration | null }) {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [source, setSource] = useState<Field[]>([]);
  const [appId, setAppId] = useState(initial?.appId ?? '');
  const [key, setKey] = useState(initial?.keyFieldId ?? '');
  const [localKey, setLocalKey] = useState(initial?.localKeyFieldId ?? '');
  const [copies, setCopies] = useState(initial?.copies ?? [{ sourceFieldId: '', targetFieldId: '' }]);
  const [presentation, setPresentation] = useState<ReferencePresentation>(initial ?? {});
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
    <input name="lookup" type="hidden" value={JSON.stringify({ ...presentation, appId, keyFieldId: key, localKeyFieldId: localKey, copies })} />
    <label>Reference application <select required value={appId} onChange={(event) => {
      setAppId(event.target.value); setPresentation({}); setSource([]); setKey(''); setLocalKey('');
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
    {source.length > 0 && <ReferenceSettings fields={source} value={presentation} onChange={setPresentation} />}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

export function ReferenceSettings({ fields, value, onChange }: {
  fields: Field[]; value: ReferencePresentation; onChange: (value: ReferencePresentation) => void;
}) {
  return <fieldset className="stack">
    <legend>Reference results</legend>
    <label>Display fields <select multiple value={value.displayFieldIds ?? []} onChange={(event) =>
      onChange({ ...value, displayFieldIds: Array.from(event.target.selectedOptions, (option) => option.value) })}>
      {fields.filter(({ type }) => !['layout', 'attachment', 'lookup', 'related'].includes(type)).map((field) =>
        <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
    </select></label>
    <div className="inline">
      <label>Sort by <select value={value.sort?.fieldId ?? ''} onChange={(event) => onChange({
        ...value, sort: event.target.value ? { fieldId: event.target.value, direction: 'asc' } : undefined,
      })}>
        <option value="">Record number</option>{fields.filter(({ type }) => fieldContract[type].sort).map((field) =>
          <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
      </select></label>
      {value.sort && <label>Order <select value={value.sort.direction} onChange={(event) => onChange({
        ...value, sort: { fieldId: value.sort!.fieldId, direction: event.target.value === 'desc' ? 'desc' : 'asc' },
      })}><option value="asc">Ascending</option><option value="desc">Descending</option></select></label>}
    </div>
    <Conditions conditions={value.conditions ?? []} fields={fields} onChange={(conditions) => onChange({ ...value, conditions })} />
  </fieldset>;
}

type ReferencePage = { columns: { fieldId: string; name: string }[]; items: RecordData[]; next: string | null };

export function ReferenceSelector({ path, token, fieldId, keyFieldId, recordId, select, close }: {
  path: string; token: string; fieldId: string; keyFieldId: string; recordId?: string;
  select: (value: string) => void; close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState({ query: '', after: undefined as string | undefined });
  const [page, setPage] = useState<ReferencePage>();
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams({ fieldId, query: search.query });
    if (recordId) params.set('recordId', recordId);
    if (search.after) params.set('after', search.after);
    void api<ReferencePage>(path + '?' + params, token, { signal: abort.signal })
      .then(setPage).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [path, token, fieldId, recordId, search]);
  function submit(after?: string) {
    setPage(undefined); setError(''); setSearch({ query: after ? search.query : query, after });
  }
  return <dialog ref={dialog} className="reference-selector" aria-label="Select reference record" onCancel={close}>
    <div className="stack">
      <div className="inline spread"><h2>Select reference record</h2><button type="button" onClick={close}>Cancel</button></div>
      <div className="inline">
        <label>Search by reference key <input value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} /></label>
        <button type="button" onClick={() => submit()}>Search</button>
      </div>
      {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading…</p> : <>
        {page.items.length === 0 && <p>No records found</p>}
        <ul className="plain stack">{page.items.map((item) => <li key={item[keyFieldId]} className="panel stack">
          <dl>{page.columns.map(({ fieldId, name }) => <div key={fieldId} className="value-row">
            <dt>{name}</dt><dd>{item[fieldId] ?? '—'}</dd>
          </div>)}</dl>
          <button type="button" onClick={() => select(item[keyFieldId])}>Select {item[keyFieldId]}</button>
        </li>)}</ul>
        {page.next && <button type="button" onClick={() => submit(page.next!)}>Next page</button>}
      </>}
    </div>
  </dialog>;
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
