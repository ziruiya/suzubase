import { useEffect, useState } from 'react';
import { fieldContract, relatedCountHelp, type RecordData, type RelatedConfiguration } from '@suzubase/shared-types';
import { api, appPath, message, type App, type AppSummary, type Field } from './api';
import { ReferenceSettings } from './lookup';

export function RelatedSettings({ token, fields, initial }: { token: string; fields: Field[]; initial?: RelatedConfiguration | null }) {
  const [config, setConfig] = useState<RelatedConfiguration>(initial ?? {
    appId: '', localFieldId: '', matchFieldId: '', pageSize: 20,
  });
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [target, setTarget] = useState<Field[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<AppSummary[]>('/apps', token).then(setApps).catch((error) => setError(message(error)));
  }, [token]);
  useEffect(() => {
    if (!config.appId) return;
    const abort = new AbortController();
    void api<App>(appPath(config.appId), token, { signal: abort.signal }).then((app) => setTarget(app.fields))
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [config.appId, token]);
  const local = fields.find(({ fieldId }) => fieldId === config.localFieldId);
  return <fieldset className="stack">
    <legend>Related records</legend>
    <input type="hidden" name="related" value={JSON.stringify(config)} />
    <label>Local matching field <select required value={config.localFieldId} onChange={(event) =>
      setConfig({ ...config, localFieldId: event.target.value, matchFieldId: '' })}>
      <option value="">Select field</option>
      {fields.filter(({ type }) => fieldContract[type].sort).map((field) =>
        <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
    </select></label>
    <label>Reference application <select required value={config.appId} onChange={(event) => {
      setTarget([]);
      setError('');
      setConfig({ appId: event.target.value, localFieldId: config.localFieldId, matchFieldId: '', pageSize: config.pageSize });
    }}>
      <option value="">Select application</option>
      {apps.map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
    </select></label>
    <label>Reference matching field <select required value={config.matchFieldId} onChange={(event) =>
      setConfig({ ...config, matchFieldId: event.target.value })}>
      <option value="">Select field</option>
      {target.filter(({ type }) => type === local?.type).map((field) =>
        <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
    </select></label>
    <label>Records per page <input required type="number" min={1} max={100} value={config.pageSize || ''} onChange={(event) =>
      setConfig({ ...config, pageSize: Number(event.target.value) })} /></label>
    {target.length > 0 && <ReferenceSettings fields={target} value={config} onChange={(presentation) =>
      setConfig({ ...config, ...presentation })} />}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

type RelatedPage = { columns: { fieldId: string; name: string }[]; items: RecordData[]; next: string | null; count: string };

export function RelatedRecords({ token, appId, recordId, fieldId }: { token: string; appId: string; recordId: string; fieldId: string }) {
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<RelatedPage>();
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    const path = appPath(appId) + '/records/' + recordId + '/related/' + fieldId;
    void api<RelatedPage>(path + (cursor ? '?after=' + cursor : ''), token, { signal: abort.signal })
      .then(setPage).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [token, appId, recordId, fieldId, cursor]);
  function navigate(after?: string) {
    setPage(undefined);
    setError('');
    setCursor(after);
  }
  return <div className="stack">
    <p className="muted">{relatedCountHelp}</p>
    {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading…</p> : <>
      <p>{page.count} related records</p>
      {page.columns.length > 0 && <ul className="plain stack">{page.items.map((item, index) =>
        <li key={index} className="panel"><dl>{page.columns.map(({ fieldId, name }) =>
          <div className="value-row" key={fieldId}><dt>{name}</dt><dd>{item[fieldId] ?? '—'}</dd></div>)}</dl></li>)}</ul>}
      <div className="inline">
        {cursor && <button type="button" onClick={() => navigate()}>First page</button>}
        {page.next && <button type="button" onClick={() => navigate(page.next!)}>Next page</button>}
      </div>
    </>}
  </div>;
}
