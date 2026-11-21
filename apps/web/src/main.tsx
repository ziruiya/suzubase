import { fieldContract, type FormLayout, type RecordResponse } from '@suzubase/shared-types';
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, appPath, download, json, message, type App, type AppSummary, type Field, type Profile, type Session } from './api';
import { removeDrafts } from './drafts';
import { displayValue, RecordEditor, RecordValues } from './forms';
import { BulkEdit } from './bulk-edit';
import { RecycleBin } from './recycle-bin';
import { Settings } from './settings';
import { Directory } from './directory';
import { AccountSecurity } from './account-security';
import './style.css';

type Item = Pick<RecordResponse, 'id' | 'recordNo' | 'data' | 'revision' | 'schemaVersion'>;
type RecordForm = { record: RecordResponse; fields: Field[]; formLayout: FormLayout; can: { edit: boolean; delete: boolean } };
type Search = { field: string; mode: string; query: string };
type Archive = { data: Record<string, string>; definitions: Record<string, Field> };
type History = {
  events: { eventId: string; actorLabel: string; kind: string; occurredAt: string; schemaVersion: number;
    changes: { fieldId: string; oldValue: string | null; newValue: string | null }[] }[];
  schemas: Record<number, Field[]>;
};

function useNarrow() {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

function Login({ onLogin, notice }: { onLogin: (session: Session) => void; notice: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError('');
    const values = new FormData(event.currentTarget);
    const account = String(values.get('account')).trim();
    try {
      const result = await api<{ accessToken: string } | { secondFactorRequired: true }>('/auth/login', undefined, json('POST', {
        [account.includes('@') ? 'email' : 'loginName']: account,
        password: values.get('password'),
        ...(challenge && { factor: values.get('factor') }),
      }));
      if ('secondFactorRequired' in result) {
        setChallenge(true);
        return;
      }
      const { accessToken } = result;
      const profile = await api<Profile>('/auth/profile', accessToken);
      onLogin({ token: accessToken, profile, draftAllowed: { current: true } });
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return <main className="login">
    <section className="panel stack">
      <div className="brand"><span aria-hidden="true">S</span> SuzuBase</div>
      <h1>Sign in</h1>
      {notice && <p role="status">{notice}</p>}
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label>Email or login name <input name="account" required autoComplete="username" /></label>
        <label>Password <input type="password" name="password" required autoComplete="current-password" /></label>
        {challenge && <label>Authenticator or recovery code
          <input name="factor" required autoComplete="one-time-code" autoFocus />
        </label>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </main>;
}

function Portal({ session, navigate, narrow }: { session: Session; navigate: (id: string) => void; narrow: boolean }) {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const { profile, token } = session;
  useEffect(() => { void api<AppSummary[]>('/apps', token).then(setApps).catch((error) => setError(message(error))); }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const app = await api<AppSummary>('/apps', token, json('POST', {
        code: data.get('code'), name: data.get('name'), ...(data.get('template') && { template: data.get('template') }),
      }));
      navigate(app.id);
    } catch (error) {
      setError(message(error));
    }
  }
  return <div className="stack">
    <div className="inline spread"><h1>Applications</h1>
      {!narrow && (profile.isAdmin || profile.canCreateApps || profile.allowAppCreation) &&
        <button className="primary" onClick={() => setCreating(!creating)}>{creating ? 'Cancel' : 'New application'}</button>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {creating && <form className="panel stack" onSubmit={(event) => void create(event)}>
      <label>Name <input name="name" required /></label>
      <label>App code <input name="code" required pattern="[a-z][a-z0-9_\-]{0,63}" /></label>
      <label>Template <select name="template"><option value="">Blank application</option><option value="customers">Customers</option></select></label>
      <button className="primary">Create application</button>
    </form>}
    <div className="app-grid">{apps.map((app) =>
      <button className="app-card" key={app.id} onClick={() => navigate(app.id)}>
        <span className="app-icon" aria-hidden="true">{app.name.slice(0, 1)}</span>
        <span><strong>{app.name}</strong><small>{app.description || app.code}</small>{app.archivedAt && <small>Archived</small>}</span>
      </button>)}</div>
    {!apps.length && !error && <p className="muted">No applications are available.</p>}
  </div>;
}

function Records({ appId, session, narrow, leave }: { appId: string; session: Session; narrow: boolean; leave: () => void }) {
  const [app, setApp] = useState<App>();
  const [view, setView] = useState<string>();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<string>();
  const [summary, setSummary] = useState<{ fieldId: string; sum: string | null; average: string | null }[]>([]);
  const [form, setForm] = useState<RecordForm>();
  const [history, setHistory] = useState<History>();
  const [archive, setArchive] = useState<Archive>();
  const [screen, setScreen] = useState<'list' | 'detail' | 'edit' | 'new' | 'settings' | 'recycle'>('list');
  const [search, setSearch] = useState<Search>();
  const [searchField, setSearchField] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [bulkEdit, setBulkEdit] = useState(false);
  const token = session.token;
  const base = appPath(appId);
  const root = base + '/records';

  const reload = async () => { setApp(await api<App>(base, token)); };
  useEffect(() => { void reload().catch((error) => { setError(message(error)); setBusy(false); }); }, [appId]);

  async function load(after?: string) {
    if (!app) return;
    setBusy(true); setError('');
    const params = new URLSearchParams(view ? { view } : {});
    try {
      if (search) {
        const output = await api<{ items: Item[]; count: string }>(root + '/search?' + new URLSearchParams({
          ...search, ...(view && { view }),
        }), token);
        setItems(output.items); setTotal(output.count); setSummary([]); setCursor(null);
        return;
      }
      const all = new URLSearchParams(params);
      const numbers = app.fields.filter(({ type }) => fieldContract[type].aggregate).slice(0, 3).map(({ fieldId }) => fieldId);
      if (numbers.length) all.set('fields', numbers.join(','));
      if (after) params.set('after', after);
      const result = await api<{ items: Item[]; nextCursor: string | null }>(root + '?' + params, token);
      setItems((previous) => after ? [...previous, ...result.items] : result.items);
      setCursor(result.nextCursor);
      if (!after) {
        setTotal(undefined);
        setSummary([]);
        const aggregate = await api<{ count: string; fields: typeof summary }>(root + '/aggregates?' + all, token);
        setTotal(aggregate.count); setSummary(aggregate.fields);
      }
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (screen === 'list' && app) void load(); }, [app, screen, view, search]);

  async function open(id: string, where: 'detail' | 'edit' = 'detail') {
    setError(''); setHistory(undefined); setArchive(undefined);
    try {
      setForm(await api<RecordForm>(root + '/' + id + '/form', token));
      setScreen(where);
    } catch (error) {
      setError(message(error));
    }
  }
  function back() {
    setScreen('list'); setError(''); setForm(undefined); setConfirm(false);
  }

  if (!app) return <div className="stack"><button onClick={leave}>Applications</button>
    {error ? <p role="alert" className="error">{error}</p> : <p role="status">Loading…</p>}</div>;

  const canCreate = app.can.create && !app.archivedAt;
  const selectedView = app.views.find(({ id }) => id === (view ?? app.defaultId));
  const columns = selectedView?.columns.length
    ? selectedView.columns.map(({ fieldId }) => app.fields.find((field) => field.fieldId === fieldId)!).filter(Boolean)
    : app.fields.filter(({ type }) => type !== 'layout');
  const searchable = app.fields.filter(({ searchMode, type }) => searchMode || ['phone', 'email'].includes(type));
  const currentSearchField = searchable.find(({ fieldId }) => fieldId === searchField) ?? searchable[0];

  return <div className="stack">
    <nav aria-label="Page location" className="inline breadcrumb"><button onClick={leave}>Applications</button>
      {screen !== 'list' && <button onClick={back}>{app.name}</button>}</nav>
    {feedback && <p className="banner" role="status">{feedback}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {screen === 'recycle' && <RecycleBin path={root} session={session} back={back} />}
    {screen === 'settings' && app.can.manage && (!narrow || session.profile.isAdmin) &&
      <Settings app={app} session={session} narrow={narrow} onClose={back} reload={reload} />}
    {(screen === 'new' || screen === 'edit') && <RecordEditor key={form?.record.id ?? 'new'}
      session={session} app={app} fields={screen === 'edit' ? form!.fields : app.fields} layout={screen === 'edit' ? form!.formLayout : app.formLayout}
      record={screen === 'edit' ? form!.record : undefined}
      onCancel={() => screen === 'edit' ? setScreen('detail') : back()}
      onSaved={(saved) => { setFeedback('Saved to the server'); void open(saved.id); }} />}
    {screen === 'detail' && form && <section className="panel stack">
      <div className="inline spread">
        <h1>Record {form.record.recordNo}</h1>
        <div className="inline">
          {!app.archivedAt && app.can.edit && form.can.edit && <button className="primary" onClick={() => { setFeedback(''); setScreen('edit'); }}>Edit</button>}
          {!app.archivedAt && app.can.delete && form.can.delete && <button onClick={() => setConfirm(true)}>Move to recycle bin</button>}
        </div>
      </div>
      {confirm && <section className="notice" aria-label="Confirm record deletion">
        <p>Move record {form.record.recordNo} from Active to Recycle bin?</p>
        <div className="inline"><button onClick={() => setConfirm(false)}>Cancel</button>
          <button className="danger" onClick={() => { void api(root + '/' + form.record.id, token,
            json('DELETE', { revision: form.record.revision })).then(() => { back(); setFeedback('Record moved to the recycle bin'); })
            .catch((error) => setError(message(error))); }}>Confirm move</button></div>
      </section>}
      <RecordValues fields={form.fields} layout={form.formLayout} record={form.record} session={session} app={app} />
      <div className="inline">
        <button onClick={() => void api<History>(root + '/' + form.record.id + '/history', token)
          .then(setHistory).catch((error) => setError(message(error)))}>Show history</button>
        {app.can.export && <button onClick={() => void download(root + '/' + form.record.id + '/history/export', token, 'history.json')
          .catch((error) => setError(message(error)))}>Export history</button>}
        {session.profile.canReadArchivedFields && <>
          <button onClick={() => void api<Archive>(root + '/' + form.record.id + '/archived-fields', token)
            .then(setArchive).catch((error) => setError(message(error)))}>Show archived fields</button>
          {app.can.export && <button onClick={() => void download(root + '/' + form.record.id + '/history/export?includeArchived=true',
            token, 'history-with-archived-fields.json').catch((error) => setError(message(error)))}>Export history with archived fields</button>}
        </>}
      </div>
      {history && <section aria-label="Record history"><h2>History</h2><ol className="history">{history.events.map((event) =>
        <li key={event.eventId}><strong>{event.kind}</strong> · {event.actorLabel}
          <time>{new Date(event.occurredAt).toLocaleString(undefined, { timeZone: session.profile.timeZone })}</time>
          {event.changes.map((change) => {
            const field = history.schemas[event.schemaVersion]?.find(({ fieldId }) => fieldId === change.fieldId);
            const format = (value: string | null) => value === null ? '—' : field ? displayValue(field, value, session.profile.timeZone) : value;
            return <div key={change.fieldId}>{field?.name ?? change.fieldId} · {format(change.oldValue)} → {format(change.newValue)}</div>;
          })}
        </li>)}</ol></section>}
      {archive && <section aria-label="Archived fields"><h2>Archived fields</h2>
        {Object.keys(archive.data).length ? <dl>{Object.entries(archive.data).map(([id, value]) => <div key={id}>
          <dt>{archive.definitions[id]?.name ?? id}</dt>
          <dd>{archive.definitions[id] ? displayValue(archive.definitions[id], value, session.profile.timeZone) : value}</dd>
        </div>)}</dl> : <p>This record has no archived field values.</p>}
      </section>}
    </section>}
    {screen === 'list' && <>
      <div className="heading inline spread">
        <div><h1>{app.name}</h1>{app.description && <p className="muted">{app.description}</p>}</div>
        <div className="inline">
          {app.can.manage && (!narrow || session.profile.isAdmin) && <button onClick={() => setScreen('settings')}>Settings</button>}
          {app.can.edit && !app.archivedAt && items.length > 0 && <button onClick={() => setBulkEdit(!bulkEdit)}>Batch edit</button>}
          {session.profile.canManageRecycleBin && app.can.delete && <button onClick={() => setScreen('recycle')}>Record recycle bin</button>}
          {canCreate && <button className="primary" onClick={() => { setForm(undefined); setScreen('new'); setFeedback(''); }}>New record</button>}
        </div>
      </div>
      {bulkEdit && app.can.edit && <BulkEdit app={app} path={root} rows={items} session={session} done={() => load()}
        close={() => setBulkEdit(false)} />}
      {app.archivedAt && <p className="notice">This application is archived.</p>}
      <div className="toolbar">
        {app.views.length > 0 && <label>View <select value={view ?? app.defaultId ?? ''}
          onChange={(event) => setView(event.target.value || undefined)}>
          {!app.defaultId && <option value="">All records</option>}
          {app.views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select></label>}
        {currentSearchField && <form className="search-form" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setSearch({ field: currentSearchField.fieldId, query: String(form.get('query')), mode: String(form.get('mode')) });
        }}>
          <label>Search field <select value={currentSearchField.fieldId} onChange={(event) => setSearchField(event.target.value)}>
            {searchable.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}</select></label>
          <label>Match <select name="mode" key={currentSearchField.fieldId}>
            <option value="exact">Exact</option>{currentSearchField.type === 'phone' && <option value="tail">Phone suffix</option>}
            {currentSearchField.searchMode === 'customer-id' && <option value="prefix">Prefix</option>}</select></label>
          <label>Search value <input name="query" type="search" required /></label>
          <button type="submit">Search</button>
        </form>}
      </div>
      <div className="inline spread">
        <p role="status">{busy ? 'Loading records…' : total === undefined ? '' : total + ' records'}</p>
        {app.can.export && !search && <button onClick={() => void download(base + '/csv/export' + (view ? '?view=' + view : ''),
          token, 'records.csv').catch((error) => setError(message(error)))}>Export CSV</button>}
      </div>
      {summary.length > 0 && <div className="inline summaries">{summary.map((entry) =>
        <span key={entry.fieldId}><strong>{app.fields.find(({ fieldId }) => fieldId === entry.fieldId)?.name}</strong> ·
          {' Sum '}{entry.sum ?? '—'} · Average {entry.average === null ? '—' : entry.average.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')}</span>)}</div>}
      {items.length > 0 ? <section aria-label="Records" className="record-grid">{items.map((record) =>
        <article className="record-card" key={record.id}>
          <button className="record-link" onClick={() => { setFeedback(''); void open(record.id); }}>Record {record.recordNo}</button>
          <dl className={selectedView?.columns.length ? 'view-columns' : undefined}>{columns.map((field) => <div key={field.fieldId}
            style={selectedView?.columns.length ? { flexBasis: selectedView.columns.find(({ fieldId }) => fieldId === field.fieldId)?.width } : undefined}>
            <dt>{field.name}</dt>
            <dd>{record.data[field.fieldId]
              ? displayValue(field, record.data[field.fieldId], session.profile.timeZone) : '—'}</dd>
          </div>)}</dl>
        </article>)}</section> : !busy && <section className="panel stack">
          <h2>No records found</h2>
          <div className="inline">
            {search && <button onClick={() => setSearch(undefined)}>Clear filters</button>}
            {canCreate && <button className="primary" onClick={() => { setForm(undefined); setScreen('new'); }}>New record</button>}
          </div>
        </section>}
      {search && items.length > 0 && <div><button onClick={() => setSearch(undefined)}>Clear filters</button></div>}
      {cursor && <div><button onClick={() => void load(cursor!)} disabled={busy}>Load more records</button></div>}
    </>}
  </div>;
}

function Root() {
  const [session, setSession] = useState<Session>();
  const [current, setCurrent] = useState<string>();
  const [security, setSecurity] = useState(false);
  const [directory, setDirectory] = useState(false);
  const [notice, setNotice] = useState('');
  const narrow = useNarrow();
  async function logout() {
    if (!session) return;
    session.draftAllowed.current = false;
    const { tenantId, userId } = session.profile;
    setSession(undefined); setCurrent(undefined); setSecurity(false); setDirectory(false);
    await removeDrafts((draft) => draft.scope[0] === tenantId && draft.scope[1] === userId).catch(() => undefined);
  }
  return session ? <>
    <header className="top"><div className="top-inner inline spread">
      <button className="brand" onClick={() => { setCurrent(undefined); setSecurity(false); setDirectory(false); }}><span aria-hidden="true">S</span> SuzuBase</button>
      <div className="inline account"><span>{session.profile.displayName ?? session.profile.email}</span>
        {session.profile.isAdmin && <>
          <button onClick={() => { setDirectory(true); setSecurity(false); }}>Directory</button>
          <button onClick={() => { setSecurity(true); setDirectory(false); }}>Account security</button>
        </>}
        <button onClick={() => { setNotice(''); void logout(); }}>Sign out</button></div>
    </div></header>
    <main className="workspace">
      {directory ? <Directory session={session} back={() => setDirectory(false)} /> : security ? <AccountSecurity token={session.token} close={() => setSecurity(false)} signInAgain={() => {
        setNotice('Two-factor settings changed. Sign in again to continue.');
        void logout();
      }} /> : current ? <Records key={current} appId={current} session={session} narrow={narrow} leave={() => setCurrent(undefined)} />
        : <Portal session={session} narrow={narrow} navigate={setCurrent} />}
    </main>
  </> : <Login notice={notice} onLogin={(value) => { setSession(value); setNotice(''); }} />;
}

createRoot(document.getElementById('root')!).render(<Root />);
