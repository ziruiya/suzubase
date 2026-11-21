import { autoNumberHelp, fieldContract, fieldTypes, isRecordInput, layoutKinds, optionFieldTypes, type FieldType, type FormLayout, type ViewConfiguration } from '@suzubase/shared-types';
import { useEffect, useState, type FormEvent } from 'react';
import { LookupSettings } from './lookup';
import { RelatedSettings } from './related';
import { TableSettings, tableSettings } from './table-settings';
import { PermissionsSettings } from './permissions-settings';
import { ViewSettings } from './view-settings';
import { IndexSettings } from './index-settings';
import { LayoutDesigner } from './form-layout';
import { api, ApiError, appPath, download, json, message, type App, type Field, type Session } from './api';

type Draft = ViewConfiguration & { version: number | null; status: string | null; fields: Field[]; publishedFields: Field[]; formLayout: FormLayout };
const tabs = ['Form', 'Views', 'Workflow', 'Notifications', 'Permissions', 'General', 'Import / export', 'Indexes'] as const;

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
  const [preflight, setPreflight] = useState<unknown>();
  const [migration, setMigration] = useState('');
  const [editing, setEditing] = useState<Field>();
  const definitions = draft?.version ? draft.fields : draft?.publishedFields ?? app.fields;
  const layout = draft?.formLayout ?? app.formLayout;
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
        ...(type === 'table' && { table: tableSettings(input) }),
        ...(type === 'related' && { related: JSON.parse(String(input.get('related'))) }),
        ...(type === 'lookup' && { lookup: JSON.parse(String(input.get('lookup'))) }),
        ...(type === 'calculation' && { formula: JSON.parse(String(input.get('formula'))) }),
        ...(type === 'layout' && { layoutElement: {
          kind: input.get('layoutKind'), text: String(input.get('layoutText')).trim() || undefined,
        } }),
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
      <ul className="plain">{definitions.map((field) =>
        <li className="inline" key={field.fieldId}>{field.name} <span className="muted">· {field.type}</span>
          {!narrow && <button type="button" disabled={busy} onClick={() => setEditing(field)}>Edit {field.name}</button>}
        </li>)}</ul>
      {editing && !narrow && <FieldEditor key={editing.fieldId} field={editing} token={token} fields={definitions} busy={busy} close={() => setEditing(undefined)}
        save={(patch) => void run(async () => {
          await api(path + '/draft/fields/' + editing.fieldId, token, patch ? json('PATCH', patch) : json('DELETE'));
          setEditing(undefined); await refreshDraft();
        })} />}
      {!narrow && <LayoutDesigner key={definitions.map(({ fieldId }) => fieldId).join(':')} fields={definitions} saved={layout}
        save={async (value) => {
          await api(path + '/draft/layout', token, json('PUT', value));
          await refreshDraft(); setNotice('Layout saved to the schema draft.');
        }} />}
      {!narrow && !draft?.version && app.schemaVersion > 1 && <button disabled={busy} type="button" onClick={() => void run(async () => {
        await api(path + '/rollback-display', token, json('POST'));
        await reload(); await refreshDraft(); setNotice('Previous layout and views restored.');
      })}>Restore previous layout and views</button>}
      <form className="stack" onSubmit={add}>
        <label>Field name <input name="name" required maxLength={120} /></label>
        <label>Field code <input name="code" required pattern="[a-z][a-z0-9_\-]{0,63}" /></label>
        <label>Field type <select value={type} onChange={(event) => setType(event.target.value as FieldType)}>
          {fieldTypes.map((type) => <option key={type}>{type}</option>)}
        </select></label>
        {isRecordInput(type) && type !== 'table' && <label className="option"><input type="checkbox" name="required" /> Required</label>}
        {type === 'lookup' && <LookupSettings token={token} fields={definitions} />}
        {type === 'related' && <RelatedSettings token={token} fields={definitions} />}
        {type === 'table' && <TableSettings />}
        {optionFieldTypes.has(type) && <label>Options, one value=label per line <textarea name="options" required /></label>}
        {type === 'text' && <label>Search use <select name="search"><option value="">None</option>
          <option value="name">Name</option><option value="kana">Name kana</option><option value="customer-id">Customer ID</option>
        </select></label>}
        {type === 'calculation' && <>
          <label>Formula tokens <textarea name="formula" required aria-describedby="formula-help" /></label>
          <p id="formula-help">Enter a JSON list with operands before the operator. Example for 2 + 3</p>
          <pre>{JSON.stringify([{ kind: 'number', value: '2' }, { kind: 'number', value: '3' }, { kind: 'operator', operator: '+' }])}</pre>
          <p>Use a token with kind "field" and one of these field IDs. Use &amp; to join text.</p>
          <ul>{definitions
            .filter(({ type }) => !['layout', 'calculation', 'attachment', 'richText'].includes(type))
            .map((field) => <li key={field.fieldId}>{field.name} <code>{field.fieldId}</code></li>)}</ul>
        </>}
        {type === 'layout' && <>
          <label>Element <select name="layoutKind">{layoutKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label>Display text <input name="layoutText" maxLength={120} /></label>
        </>}
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
    {active === 'Views' && <ViewSettings configuration={draft ?? app} fields={definitions} path={path}
      session={session} refresh={refreshDraft} />}
    {active === 'Workflow' && <p>Workflow is not yet enabled.</p>}
    {active === 'Notifications' && <p>Notifications are not yet enabled.</p>}
    {active === 'Permissions' && <PermissionsSettings app={app} fields={definitions} session={session} refresh={refreshDraft} />}
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
    {active === 'Indexes' && <IndexSettings app={app} session={session} />}
    {active === 'Import / export' && <CsvSettings app={app} session={session} />}
    {(active === 'Form' || active === 'Views' || active === 'Permissions') && draft?.version && <div className="inline">
      <button className="primary" disabled={busy} onClick={() => void run(async () => {
        setPreflight(undefined);
        try {
          const result = await api<{ migrationReport?: unknown }>(path + '/publish', token,
            json('POST', migration ? { migration: { incompatible: migration } } : undefined));
          setPreflight(result.migrationReport);
          setMigration('');
          await refreshDraft(); await reload(); setNotice('Draft preflight passed and the schema was published.');
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) {
            setPreflight(error.body);
            await refreshDraft();
          }
          throw error;
        }
      })}>Preflight and publish</button>
      {!narrow && <label>Data migration <select value={migration} onChange={(event) => setMigration(event.target.value)}>
        <option value="">None selected</option>
        <option value="reject">Migrate compatible values</option>
        <option value="clear-optional">Clear incompatible optional values and save a report</option>
      </select></label>}
    </div>}
    {preflight !== undefined && <details open><summary>Publication report</summary><pre>{JSON.stringify(preflight, null, 2)}</pre></details>}
  </section>;
}

function FieldEditor({ field, fields, token, busy, close, save }: {
  field: Field; fields: Field[]; token: string; busy: boolean; close: () => void; save: (patch: Record<string, unknown> | null) => void;
}) {
  const [type, setType] = useState(field.type);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  return <form className="stack" onSubmit={(event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      const options = field.type === type ? field.options.map((option) => ({
        ...option, label: values.get('label:' + option.value), disabled: values.has('disabled:' + option.value) || option.disabled,
      })) : [];
      if (optionFieldTypes.has(type)) {
        for (const entry of String(values.get('newOptions')).split('\n').filter(Boolean)) {
          const separator = entry.indexOf('=');
          options.push({ value: separator < 0 ? entry : entry.slice(0, separator),
            label: separator < 0 ? entry : entry.slice(separator + 1), disabled: false });
        }
      }
      save({ name: values.get('name'), code: values.get('code'), type, required: values.has('required'), options,
        uniqueValue: values.has('unique'),
        ...(type === 'table' && { table: tableSettings(values) }),
        ...(type === 'related' && { related: JSON.parse(String(values.get('related'))) }),
        ...(type === 'lookup' && { lookup: JSON.parse(String(values.get('lookup'))) }),
        ...(type === 'calculation' && { formula: JSON.parse(String(values.get('formula'))) }),
        ...(type === 'layout' && { layoutElement: { kind: values.get('kind'), ...(values.get('layoutText') && { text: values.get('layoutText') }) } }),
      });
    } catch (error) {
      setError(message(error));
    }
  }}>
    <h3>Edit {field.name}</h3>
    <label>Name <input name="name" defaultValue={field.name} required /></label>
    <label>Code <input name="code" defaultValue={field.code} required /></label>
    <label>Type <select value={type} onChange={(event) => setType(event.target.value as FieldType)}>
      {fieldTypes.filter((type) => type === field.type || (isRecordInput(type) && type !== 'attachment' && type !== 'table' &&
        !['attachment', 'autoNumber', 'table'].includes(field.type))).map((type) => <option key={type}>{type}</option>)}
    </select></label>
    {isRecordInput(type) && type !== 'table' && <label className="option"><input type="checkbox" name="required" defaultChecked={field.required} /> Required</label>}
    {fieldContract[type].unique && <label className="option"><input type="checkbox" name="unique" defaultChecked={field.uniqueValue} /> Unique</label>}
    {type === 'lookup' && <LookupSettings token={token} fields={fields} initial={field.lookup} />}
    {type === 'related' && <RelatedSettings token={token} fields={fields} initial={field.related} />}
    {type === 'table' && <TableSettings initial={field.table} />}
    {type === 'calculation' && <label>Formula tokens <textarea name="formula" defaultValue={JSON.stringify(field.formula, null, 2)} required /></label>}
    {type === 'layout' && field.layoutElement && <>
      <label>Element <select name="kind" defaultValue={field.layoutElement.kind}>
        {layoutKinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label>
      <label>Display text <input name="layoutText" defaultValue={field.layoutElement.text} /></label>
    </>}
    {optionFieldTypes.has(type) && <>
      {type === field.type && field.options.map((option) => <fieldset key={option.value}>
        <legend>{option.value}</legend>
        <label>Label <input name={'label:' + option.value} defaultValue={option.label} required /></label>
        <label className="option"><input type="checkbox" name={'disabled:' + option.value}
          defaultChecked={option.disabled} disabled={option.disabled} /> Deactivate</label>
      </fieldset>)}
      <label>Add options, one value=label per line <textarea name="newOptions" /></label>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="inline">
      <button type="submit" disabled={busy}>Save field to draft</button>
      <button type="button" onClick={close}>Cancel</button>
      {confirm ? <button type="button" disabled={busy} onClick={() => save(null)}>Confirm deletion of {field.name}</button>
        : <button type="button" disabled={busy} onClick={() => setConfirm(true)}>Delete field</button>}
    </div>
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
