import { categoryPath, fieldContract, type FormLayout, type RecordResponse } from '@suzubase/shared-types';
import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { api, appPath, download, json, message, type App, type AppSummary, type Field, type Profile, type Session } from './api';
import { removeDrafts } from './drafts';
import { displayValue, RecordEditor, RecordValues } from './forms';
import { BulkEdit } from './bulk-edit';
import { useSelectorOptions } from './selector-options';
import { RecycleBin } from './recycle-bin';
import { Settings } from './settings';
import { ImportWizard } from './import-export';
import { Directory } from './directory';
import { NotificationCenter, useUnread } from './notification-center';
import { Comments } from './comments';
import { Tasks, WorkflowDetail } from './workflow-runtime';
import { AccountSecurity } from './account-security';
import { Turnstile, sampleInfo, type SampleInfo } from './turnstile';
import { SampleWatermark } from './watermark';
import './style.css';

type Item = Pick<RecordResponse, 'id' | 'recordNo' | 'data' | 'revision' | 'schemaVersion'> & { status?: string };
type RecordForm = { record: RecordResponse; fields: Field[]; formLayout: FormLayout; can: { edit: boolean; delete: boolean } };
type Search = { field: string; mode: string; query: string };
type Archive = { data: Record<string, string>; definitions: Record<string, Field> };
type History = {
  events: { eventId: string; actorLabel: string; kind: string; occurredAt: string; schemaVersion: number;
    workflow?: { action: string | null; from: string | null; to: string | null; reason: string | null; assigneeIds: string[] };
    source?: string; migration?: { importJobId: string; sourceActorId: string | null; sourceTimestamp: string | null };
    changes: { fieldId: string; rowId?: string; childFieldId?: string; rowChange?: string; oldValue: string | null; newValue: string | null }[] }[];
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

function SampleLanding({ info, onLogin, onAdmin }: {
  info: SampleInfo; onLogin: (session: Session) => void; onAdmin: () => void;
}) {
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function enter() {
    if (!turnstileToken) return;
    setBusy(true); setError('');
    try {
      const { accessToken } = await api<{ accessToken: string }>('/auth/sample-session', undefined,
        json('POST', { turnstileToken }));
      const profile = await api<Profile>('/auth/profile', accessToken);
      onLogin({ token: accessToken, profile, draftAllowed: { current: true } });
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return <main className="login">
    <SampleWatermark />
    <section className="panel stack">
      <div className="brand"><span aria-hidden="true">S</span> SuzuBase</div>
      <h1>公開サンプル</h1>
      <p>SuzuBase の公開サンプルです。架空の不動産会社「ひだまり不動産株式会社」の業務システム（顧客管理、物件管理、商談・案内管理、契約管理、売上・入金管理）を公開しています。データはすべて架空のデモ用で、実在の企業・個人の情報は含まれていません。</p>
      <p>ログインなしで入って閲覧できます。レコードの追加・変更もできますが、使えるのはプルダウン・数値・日付などの構造化項目のみで、テキスト項目は読み取り専用です。サンプルのデータは毎朝 4 時に自動でリセットされ、初期状態に戻ります。</p>
      {info.siteKey && <Turnstile siteKey={info.siteKey} onToken={setTurnstileToken} />}
      <button className="primary" disabled={busy || !turnstileToken} onClick={() => void enter()}>
        {busy ? '入っています…' : 'サンプルに入る'}</button>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" onClick={onAdmin}>管理者ログイン</button>
    </section>
  </main>;
}

function Portal({ session, navigate, narrow }: { session: Session; navigate: (id: string, recordId?: string) => void; narrow: boolean }) {
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [tasks, setTasks] = useState(false);
  const [imports, setImports] = useState(false);
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
    <button type="button" aria-expanded={tasks} onClick={() => setTasks(!tasks)}>My tasks</button>
    {tasks && <Tasks token={token} apps={apps} open={navigate} />}
    {profile.isAdmin && <button type="button" aria-expanded={imports} onClick={() => setImports(!imports)}>Import migration package</button>}
    {imports && profile.isAdmin && <ImportWizard session={session} />}
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

function Records({ appId, initialRecord, session, narrow, leave, refreshUnread }: { appId: string; initialRecord?: string; refreshUnread: () => void; session: Session; narrow: boolean; leave: () => void }) {
  const [app, setApp] = useState<App>();
  const selectors = useSelectorOptions(app, session);
  const [view, setView] = useState<string>();
  const [category, setCategory] = useState<string>();
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<string>();
  const [summary, setSummary] = useState<{ fieldId: string; sum: string | null; average: string | null }[]>([]);
  const [form, setForm] = useState<RecordForm>();
  const [history, setHistory] = useState<History>();
  const [historyFilter, setHistoryFilter] = useState({ kind: '', fieldId: '' });
  const loadHistory = (filter = historyFilter) => {
    if (!form) return;
    const query = new URLSearchParams();
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.fieldId) query.set('fieldId', filter.fieldId);
    const suffix = query.toString() ? '?' + query.toString() : '';
    void api<History>(root + '/' + form.record.id + '/history' + suffix, token)
      .then(setHistory).catch((error) => setError(message(error)));
  };
  const applyHistoryFilter = (filter: { kind: string; fieldId: string }) => {
    setHistoryFilter(filter);
    loadHistory(filter);
  };
  const [archive, setArchive] = useState<Archive>();
  const [screen, setScreen] = useState<'list' | 'detail' | 'edit' | 'new' | 'settings' | 'recycle' | 'tasks' | 'unassigned' | 'notifications'>('list');
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
    if (category) params.set('category', category);
    try {
      if (search) {
        const output = await api<{ items: Item[]; count: string }>(root + '/search?' + new URLSearchParams({
          ...search, ...(view && { view }),
        }), token);
        setItems(output.items); setTotal(output.count); setSummary([]); setCursor(null);
        return;
      }
      const all = new URLSearchParams(params);
      const target = app.views.find(({ id }) => id === (view ?? app.defaultId));
      const numbers = target?.aggregateFields ?? app.fields.filter(({ type }) => fieldContract[type].aggregate).slice(0, 3).map(({ fieldId }) => fieldId);
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

  useEffect(() => { if (screen === 'list' && app) void load(); }, [app, screen, view, search, category]);

  async function open(id: string, where: 'detail' | 'edit' = 'detail') {
    setError(''); setHistory(undefined); setArchive(undefined);
    try {
      setForm(await api<RecordForm>(root + '/' + id + '/form', token));
      setScreen(where);
    } catch (error) {
      setError(message(error));
    }
  }
  useEffect(() => { if (initialRecord) void open(initialRecord); }, [initialRecord]);

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
    {screen === 'notifications' && <NotificationCenter session={session} appId={appId}
      onOpen={(_, recordId) => void open(recordId)} onRead={refreshUnread} />}
    {(screen === 'tasks' || screen === 'unassigned') && <Tasks token={token} appId={app.id} unassigned={screen === 'unassigned'}
      open={(_, recordId) => void open(recordId)} />}
    {screen === 'recycle' && <RecycleBin path={root} session={session} back={back} />}
    {screen === 'settings' && app.can.manage && (!narrow || session.profile.isAdmin) &&
      <Settings app={app} session={session} narrow={narrow} onClose={back} reload={reload} />}
    {(screen === 'new' || screen === 'edit') && selectors.error && <p role="alert">Could not load directory options. {selectors.error}</p>}
    {(screen === 'new' || screen === 'edit') && <RecordEditor key={form?.record.id ?? 'new'}
      session={session} app={app} directory={selectors.options} fields={screen === 'edit' ? form!.fields : app.fields} layout={screen === 'edit' ? form!.formLayout : app.formLayout}
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
      {form.record.migration && <p className="notice">Migrated record · source record no. {form.record.migration.sourceRecordNo ?? '—'} · original author {form.record.migration.sourceActorName ?? form.record.migration.sourceActorId ?? 'unknown'}</p>}
      {confirm && <section className="notice" aria-label="Confirm record deletion">
        <p>Move record {form.record.recordNo} from Active to Recycle bin?</p>
        <div className="inline"><button onClick={() => setConfirm(false)}>Cancel</button>
          <button className="danger" onClick={() => { void api(root + '/' + form.record.id, token,
            json('DELETE', { revision: form.record.revision })).then(() => { back(); setFeedback('Record moved to the recycle bin'); })
            .catch((error) => setError(message(error))); }}>Confirm move</button></div>
      </section>}
      {app.workflowStates.length > 0 && <WorkflowDetail key={form.record.id + ':' + form.record.revision}
        record={form.record} session={session} refresh={() => void open(form.record.id)} />}
      <RecordValues fields={form.fields} layout={form.formLayout} record={form.record} session={session} app={app} directory={selectors.options}
        onRefresh={!app.archivedAt && app.can.edit && form.can.edit ? (record) => void open(record.id) : undefined} />
      {app.commentsEnabled && <Comments key={form.record.id} appId={app.id} recordId={form.record.id} session={session}
        archived={!!app.archivedAt} refresh={() => void open(form.record.id)} />}
      <div className="inline">
        <button onClick={() => loadHistory()}>Show history</button>
        {app.can.export && <button onClick={() => void download(root + '/' + form.record.id + '/history/export', token, 'history.json')
          .catch((error) => setError(message(error)))}>Export history</button>}
        {session.profile.canReadArchivedFields && <>
          <button onClick={() => void api<Archive>(root + '/' + form.record.id + '/archived-fields', token)
            .then(setArchive).catch((error) => setError(message(error)))}>Show archived fields</button>
          {app.can.export && <button onClick={() => void download(root + '/' + form.record.id + '/history/export?includeArchived=true',
            token, 'history-with-archived-fields.json').catch((error) => setError(message(error)))}>Export history with archived fields</button>}
        </>}
      </div>
      {history && <section aria-label="Record history"><h2>History</h2>
        <div className="inline">
          <label>Event type <select aria-label="History event type" value={historyFilter.kind}
            onChange={(event) => applyHistoryFilter({ ...historyFilter, kind: event.target.value })}>
            <option value="">All</option>
            {[...new Set(history.events.map(({ kind }) => kind))].map((kind) =>
              <option key={kind} value={kind}>{kind}</option>)}
          </select></label>
          <label>Field <select aria-label="History field" value={historyFilter.fieldId}
            onChange={(event) => applyHistoryFilter({ ...historyFilter, fieldId: event.target.value })}>
            <option value="">All</option>
            {[...new Map(Object.values(history.schemas).flat().map((field) => [field.fieldId, field])).values()]
              .map((field) => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
          </select></label>
        </div>
        <ol className="history">{history.events.map((event) =>
        <li key={event.eventId}><strong>{event.kind === 'WORKFLOW_REPAIR' ? 'Workflow repair' : event.kind}</strong> · {event.actorLabel}
          {event.migration && <span > · Migrated · original actor {event.migration.sourceActorId ?? 'unknown'}</span>}
          <time>{new Date(event.occurredAt).toLocaleString(undefined, { timeZone: session.profile.timeZone })}</time>
          {event.workflow && <div>{event.workflow.action ?? event.kind} · {event.workflow.from ?? '—'} → {event.workflow.to ?? '—'}
            {event.workflow.reason && ' · ' + event.workflow.reason}
            {event.workflow.assigneeIds.length > 0 && ' · Assignees: ' + event.workflow.assigneeIds.length}</div>}
          {event.changes.map((change) => {
            const field = history.schemas[event.schemaVersion]?.find(({ fieldId }) => fieldId === change.fieldId);
            const format = (value: string | null) => value === null ? '—' : field ? displayValue(field, value, session.profile.timeZone) : value;
            const child = field?.table?.fields.find(({ fieldId }) => fieldId === change.childFieldId);
            return <div key={[change.fieldId, change.rowId, change.childFieldId, change.rowChange].join('/')}>
              {field?.name ?? change.fieldId}{child && ' · ' + child.name}{change.rowId && ' · Row ' + change.rowId}
              {change.rowChange && ' · ' + change.rowChange} · {format(change.oldValue)} → {format(change.newValue)}
            </div>;
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
      <button type="button" onClick={() => setScreen('notifications')}>App notifications</button>
      {app.workflowStates.length > 0 && <div className="inline">
        <button type="button" onClick={() => setScreen('tasks')}>My tasks</button>
        {app.can.manage && <button type="button" onClick={() => setScreen('unassigned')}>Records without active assignees</button>}
      </div>}
      <div className="heading inline spread">
        <div><h1>{app.name}</h1>{app.description && <p className="muted">{app.description}</p>}</div>
        <div className="inline">
          {app.can.manage && (!narrow || session.profile.isAdmin) && <button onClick={() => setScreen('settings')}>Settings</button>}
          {app.can.edit && !app.archivedAt && items.length > 0 && <button onClick={() => setBulkEdit(!bulkEdit)}>Batch edit</button>}
          {session.profile.canManageRecycleBin && app.can.delete && <button onClick={() => setScreen('recycle')}>Record recycle bin</button>}
          {canCreate && <button className="primary" onClick={() => { setForm(undefined); setScreen('new'); setFeedback(''); }}>New record</button>}
        </div>
      </div>
      {bulkEdit && app.can.edit && <BulkEdit app={app} directory={selectors.options} path={root} rows={items} session={session} done={() => load()}
        close={() => setBulkEdit(false)} />}
      {app.archivedAt && <p className="notice">This application is archived.</p>}
      <div className="toolbar">
        {app.views.length > 0 && <label>View <select value={view ?? app.defaultId ?? ''}
          onChange={(event) => setView(event.target.value || undefined)}>
          {!app.defaultId && <option value="">All records</option>}
          {app.views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select></label>}
        {app.categories?.enabled && app.categories.nodes.length > 0 && <label>Category <select value={category ?? ''}
          onChange={(event) => setCategory(event.target.value || undefined)}>
          <option value="">All categories</option>
          {app.categories.nodes.map((node) => <option key={node.id} value={node.id}>
            {categoryPath(app.categories, node.id).join(' / ') || node.name}</option>)}
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
        {app.can.export && <div className="inline">{[false, true].map((bundle) => <button key={String(bundle)} onClick={() => {
          const query = new URLSearchParams({
            ...(view && { view }), ...(search && { field: search.field, query: search.query, mode: search.mode }),
            ...(bundle && { attachments: 'true' }),
          });
          void download(base + '/csv/export?' + query, token, bundle ? 'records-with-attachments.zip' : 'records.csv')
            .catch((error) => setError(message(error)));
        }}>{bundle ? 'Export CSV and attachments' : search ? 'Export search results' : 'Export CSV'}</button>)}</div>}
      </div>
      {summary.length > 0 && <div className="inline summaries">{summary.map((entry) =>
        <span key={entry.fieldId}><strong>{app.fields.find(({ fieldId }) => fieldId === entry.fieldId)?.name}</strong> ·
          {' Sum '}{entry.sum ?? '—'} · Average {entry.average === null ? '—' : entry.average.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1')}</span>)}</div>}
      {items.length > 0 ? <section aria-label="Records" className="record-grid">{items.map((record) =>
        <article className="record-card" key={record.id}>
          <button className="record-link" onClick={() => { setFeedback(''); void open(record.id); }}>Record {record.recordNo}</button>
          {record.status && app.workflowStates.some(({ code }) => code === record.status) &&
            <p>State · {app.workflowStates.find(({ code }) => code === record.status)?.name}</p>}
          <dl className={selectedView?.columns.length ? 'view-columns' : undefined}>{columns.map((field) => <div key={field.fieldId}
            style={selectedView?.columns.length ? { flexBasis: selectedView.columns.find(({ fieldId }) => fieldId === field.fieldId)?.width } : undefined}>
            <dt>{field.name}</dt>
            <dd>{field.table ? record.data[field.fieldId] ? record.data[field.fieldId] + ' rows' : '—' : record.data[field.fieldId]
              ? displayValue(field, record.data[field.fieldId], session.profile.timeZone, selectors.options)
              : field.lookup ? record.data[field.lookup.localKeyFieldId] ?? '—' : '—'}</dd>
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
  const [sample, setSample] = useState<SampleInfo>();
  const [adminLogin, setAdminLogin] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [current, setCurrent] = useState<{ appId: string; recordId?: string }>();
  const [security, setSecurity] = useState(false);
  const [directory, setDirectory] = useState(false);
  const [notice, setNotice] = useState('');
  const narrow = useNarrow();
  const unread = useUnread(session?.token);
  useEffect(() => {
    if (!session) void sampleInfo().then(setSample).catch(() => undefined);
  }, [session]);
  async function logout() {
    if (!session) return;
    session.draftAllowed.current = false;
    const { tenantId, userId } = session.profile;
    setSession(undefined); setNotificationOpen(false); setCurrent(undefined); setSecurity(false); setDirectory(false);
    await removeDrafts((draft) => draft.scope[0] === tenantId && draft.scope[1] === userId).catch(() => undefined);
  }
  return session ? <>
    {session.profile.sampleGuest && <SampleWatermark />}
    <header className="top"><div className="top-inner inline spread">
      <button className="brand" onClick={() => { setCurrent(undefined); setNotificationOpen(false); setSecurity(false); setDirectory(false); }}><span aria-hidden="true">S</span> SuzuBase</button>
      <div className="inline account"><span>{session.profile.displayName ?? session.profile.email}</span>
        <button type="button" aria-label={'Notifications, ' + unread.count + ' unread'} aria-expanded={notificationOpen}
          onClick={() => { setNotificationOpen(!notificationOpen); setSecurity(false); setDirectory(false); }}>
          <span aria-hidden="true">🔔</span> {unread.count}
        </button>
        {session.profile.isAdmin && <>
          <button onClick={() => { setDirectory(true); setSecurity(false); setNotificationOpen(false); }}>Directory</button>
          <button onClick={() => { setSecurity(true); setDirectory(false); setNotificationOpen(false); }}>Account security</button>
        </>}
        <button onClick={() => { setNotice(''); void logout(); }}>Sign out</button></div>
    </div></header>
    {session.profile.sampleGuest && <div className="sample-banner" role="note">
      公開サンプル環境です · ひだまり不動産株式会社（架空）の業務システム デモ · テキスト項目は読み取り専用 · データは毎日 04:00 に自動リセット</div>}
    <main className="workspace">
      {notificationOpen ? <NotificationCenter session={session} onRead={unread.reload} onOpen={(appId, recordId) => {
        setCurrent({ appId, recordId });
        setNotificationOpen(false);
      }} /> : directory ? <Directory session={session} back={() => setDirectory(false)} /> : security ? <AccountSecurity token={session.token} close={() => setSecurity(false)} signInAgain={() => {
        setNotice('Two-factor settings changed. Sign in again to continue.');
        void logout();
      }} /> : current ? <Records key={current.appId + (current.recordId ?? '')} appId={current.appId} initialRecord={current.recordId} refreshUnread={unread.reload} session={session} narrow={narrow} leave={() => setCurrent(undefined)} />
        : <Portal session={session} narrow={narrow} navigate={(appId, recordId) => setCurrent({ appId, recordId })} />}
    </main>
  </> : sample?.enabled && !adminLogin
    ? <SampleLanding info={sample} onAdmin={() => setAdminLogin(true)}
      onLogin={(value) => { setSession(value); setNotice(''); }} />
    : <>
      {sample?.enabled && <SampleWatermark />}
      {sample?.enabled && <p className="login-back">
        <button type="button" onClick={() => setAdminLogin(false)}>← サンプルの入口に戻る</button></p>}
      <Login notice={notice} onLogin={(value) => { setSession(value); setNotice(''); }} />
    </>;
}

createRoot(document.getElementById('root')!).render(<Root />);
