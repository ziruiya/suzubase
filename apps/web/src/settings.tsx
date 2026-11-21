import { autoNumberHelp, fieldTypes, optionFieldTypes, type FieldType } from '@suzubase/shared-types';
import { useEffect, useState, type FormEvent } from 'react';
import { api, appPath, download, json, message, type App, type Field, type Session } from './api';

type Draft = { version: number | null; status: string | null; fields: Field[] };
const tabs = ['Form', 'Views', 'Workflow', 'Notifications', 'Permissions', 'General', 'Import / export'] as const;

export function Settings({ app, session, narrow, onClose, reload }: {
  app: App; session: Session; narrow: boolean; onClose: () => void; reload: () => Promise<void>;
}) {
  const { token } = session;
  const path = appPath(app.id);
  const [tab, setTab] = useState<(typeof tabs)[number]>('Form');
  const [draft, setDraft] = useState<Draft>();
  const [type, setType] = useState<FieldType>('text');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refreshDraft() {
    setDraft(await api<Draft>(path + '/draft', token));
  }
  useEffect(() => { void refreshDraft().catch((error) => setError(message(error))); }, [app.id]);

  async function run(action: () => Promise<void>) {
    setError('');
    setNotice('');
    setBusy(true);
    try { await action(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    void run(async () => {
      const options = optionFieldTypes.has(type) ? String(input.get('options')).split('\n').filter(Boolean).map((entry) => {
        const separator = entry.indexOf('=');
        return separator < 0 ? { value: entry, label: entry } : { value: entry.slice(0, separator), label: entry.slice(separator + 1) };
      }) : [];
      await api(path + '/fields', token, json('POST', {
        name: input.get('name'), code: input.get('code'), type, required: input.has('required'), options,
        ...(type === 'autoNumber' && { autoNumber: {
          prefix: input.get('prefix'), scopeFieldId: input.get('scope') || null, nextValue: input.get('next'),
          padding: Number(input.get('padding')), enabled: input.has('enabled'),
        } }),
        ...(type === 'text' && input.get('search') && { searchMode: input.get('search') }),
      }));
      form.reset();
      setType('text');
      await refreshDraft();
      setNotice('Field added to the schema draft.');
    });
  }

  const active = narrow ? 'Form' : tab;
  return <section className="panel stack">
    <div className="inline spread"><h2>{narrow ? 'Form settings' : 'App settings'}</h2>
      <button type="button" onClick={onClose}>Back to records</button></div>
    {!narrow && <nav className="tabs" aria-label="App settings">{tabs.map((item) =>
      <button key={item} aria-current={active === item ? 'page' : undefined} onClick={() => setTab(item)}>{item}</button>)}</nav>}
    {notice && <p role="status">{notice}</p>}{error && <p className="error" role="alert">{error}</p>}
    {active === 'Form' && <>
      <p className="muted">Draft status · {draft?.status ?? 'No draft'}</p>
      <ul className="plain">{(draft?.version ? draft.fields : app.fields).map((field) =>
        <li key={field.fieldId}>{field.name} <span className="muted">· {field.type}</span></li>)}</ul>
      <form className="stack" onSubmit={add}>
        <label>Field name <input name="name" required maxLength={120} /></label>
        <label>Field code <input name="code" required pattern="[a-z][a-z0-9_\-]{0,63}" /></label>
        <label>Field type <select value={type} onChange={(event) => setType(event.target.value as FieldType)}>
          {fieldTypes.map((type) => <option key={type}>{type}</option>)}
        </select></label>
        {type !== 'autoNumber' && <label className="option"><input type="checkbox" name="required" /> Required</label>}
        {optionFieldTypes.has(type) && <label>Options, one value=label per line <textarea name="options" required /></label>}
        {type === 'text' && <label>Search use <select name="search"><option value="">None</option>
          <option value="name">Name</option><option value="kana">Name kana</option><option value="customer-id">Customer ID</option>
        </select></label>}
        {type === 'autoNumber' && <>
          <p>{autoNumberHelp}</p>
          <label>Prefix <input name="prefix" /></label>
          <label>Next value <input name="next" defaultValue="1" required /></label>
          <label>Padding <input name="padding" type="number" min={0} max={32} defaultValue={4} required /></label>
          <label>Scope <select name="scope"><option value="">Application</option>{(draft?.fields.length ? draft.fields : app.fields)
            .filter(({ type }) => type === 'text' || type === 'number').map((field) =>
              <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select></label>
          <label className="option"><input type="checkbox" name="enabled" defaultChecked /> Enabled</label>
        </>}
        <button type="submit" disabled={busy}>Add field to draft</button>
      </form>
      <details><summary>Field help</summary><p>Dropdowns do not replace categories. They have no parent-child hierarchy,
        cannot classify a record under multiple nodes, and cannot filter by hierarchy.</p></details>
    </>}
    {active === 'Views' && <>
      <p>Published views</p>
      <ul className="plain">{app.views.map((view) => <li key={view.id}>{view.name}{view.id === app.defaultId && ' · default'}</li>)}</ul>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault(); const data = new FormData(event.currentTarget);
        void run(async () => {
          await api(path + '/draft/views', token, json('POST', {
            name: data.get('name'), conditions: [], columns: [...data.getAll('columns')].map((fieldId) => ({ fieldId, width: 160 })),
          }));
          await refreshDraft(); setNotice('View added to the draft.');
        });
      }}>
        <label>View name <input name="name" required /></label>
        <label>Columns <select name="columns" multiple>{app.fields.map((field) =>
          <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select></label>
        <button type="submit" disabled={busy}>Add view to draft</button>
      </form>
    </>}
    {active === 'Workflow' && <p>Workflow is not yet enabled.</p>}
    {active === 'Notifications' && <p>Notifications are not yet enabled.</p>}
    {active === 'Permissions' && <AclSettings app={app} session={session} refresh={refreshDraft} />}
    {active === 'General' && <form className="stack" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      void run(async () => {
        await api(path + '/settings', token, json('PATCH', {
          name: data.get('name'), description: data.get('description'), localDrafts: data.has('drafts'),
        }));
        await reload(); setNotice('Settings saved.');
      });
    }}>
      <p>App code · <code>{app.code}</code></p>
      <label>Name <input name="name" defaultValue={app.name} required /></label>
      <label>Description <textarea name="description" defaultValue={app.description} /></label>
      <label className="option"><input type="checkbox" name="drafts" defaultChecked={app.localDrafts} /> Enable local record drafts</label>
      <button className="primary" disabled={busy}>Save settings</button>
    </form>}
    {active === 'Import / export' && <CsvSettings app={app} session={session} />}
    {(active === 'Form' || active === 'Views' || active === 'Permissions') && draft?.version && <div className="inline">
      <button className="primary" disabled={busy} onClick={() => void run(async () => {
        await api(path + '/publish', token, json('POST'));
        await refreshDraft(); await reload(); setNotice('Draft preflight passed and the schema was published.');
      })}>Preflight and publish</button>
    </div>}
  </section>;
}

function AclSettings({ app, session, refresh }: { app: App; session: Session; refresh: () => Promise<void> }) {
  const path = appPath(app.id) + '/draft/acl';
  const [value, setValue] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    void api<{ app: { id: string }[]; field: { id: string }[]; record: { id: string }[] }>(path, session.token).then((acl) => {
      setValue(JSON.stringify(Object.fromEntries(Object.entries(acl).map(([key, rules]) => [
        key, rules.map(({ id: _id, ...rule }) => rule),
      ])), null, 2));
    }).catch((error) => setStatus(message(error)));
  }, [path]);
  return <form className="stack" onSubmit={(event) => {
    event.preventDefault();
    void Promise.resolve().then(() => api(path, session.token, json('PUT', JSON.parse(value)))).then(async () => {
      await refresh(); setStatus('Permissions saved to the draft.');
    }).catch((error) => setStatus(message(error)));
  }}>
    <label>Permission rules (JSON) <textarea value={value} rows={10} onChange={(event) => setValue(event.target.value)} required /></label>
    <button type="submit">Save permissions to draft</button>
    {status && <p role="status">{status}</p>}
  </form>;
}

function CsvSettings({ app, session }: { app: App; session: Session }) {
  const path = appPath(app.id) + '/csv';
  const [job, setJob] = useState<{ id: string; imported: number; remaining: number; failed: number }>();
  const [error, setError] = useState('');
  async function preflight(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      setJob(await api(path + '/preflight', session.token, json('POST', {
        csv: data.get('csv'),
        mapping: JSON.parse(String(data.get('mapping'))),
      })));
    } catch (error) {
      setError(message(error));
    }
  }
  return <div className="stack">
    <div className="inline">
      <button type="button" onClick={() => void download(path + '/export', session.token, 'records.csv')
        .catch((error) => setError(message(error)))}>Export CSV</button>
      <button type="button" onClick={() => void download(path + '/export?attachments=true', session.token, 'records.zip')
        .catch((error) => setError(message(error)))}>Export with attachments</button>
    </div>
    <form className="stack" onSubmit={(event) => void preflight(event)}>
      <label>CSV text <textarea name="csv" rows={4} required /></label>
      <label>Column mapping (JSON) <textarea name="mapping" rows={5} required defaultValue={JSON.stringify(
        Object.fromEntries(app.fields.map(({ code, fieldId }) => [code, fieldId])), null, 2,
      )} /></label>
      <button className="primary" type="submit">Run CSV preflight</button>
    </form>
    {job && <div className="stack" role="status">
      <p>{job.imported} imported · {job.remaining} ready · {job.failed} failed</p>
      <div className="inline">
        {!!job.failed && <button onClick={() => void download(path + '/' + job.id + '/errors', session.token, 'import-errors.csv')
          .catch((error) => setError(message(error)))}>Download error rows</button>}
        {!!job.remaining && <button onClick={() => void api<typeof job>(path + '/' + job.id + '/apply', session.token, json('POST', {
          offset: job.imported,
        })).then(setJob).catch((error) => setError(message(error)))}>Import next batch</button>}
      </div>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
