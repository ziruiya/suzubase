import { boundedSortTypes, fieldContract, indexPurposes, type IndexPurpose } from '@suzubase/shared-types';
import { useEffect, useState, type FormEvent } from 'react';
import { api, appPath, json, message, type App, type Session } from './api';

type Job = {
  id: string; name: string; fieldName: string; reason: string; purpose: IndexPurpose;
  state: 'building' | 'available' | 'failed'; failureReason: string | null; lastUsedAt: string | null;
  retiredAt: string | null; retireRequested: string | null; retireReason: string | null;
  problems: { recordNo: string; value: string | null; reason: string }[];
};

export function IndexSettings({ app, session }: { app: App; session: Session }) {
  const path = appPath(app.id) + '/indexes';
  const [jobs, setJobs] = useState<Job[]>([]);
  const [purpose, setPurpose] = useState<IndexPurpose>('filter');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setJobs(await api<Job[]>(path, session.token));
  }

  useEffect(() => {
    const load = () => void refresh().catch((error) => setError(message(error)));
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [path, session.token]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await action(); await refresh(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  const eligible = app.fields.filter(({ type, searchMode }) => purpose === 'search'
    ? Boolean(searchMode) || type === 'phone' || type === 'email'
    : fieldContract[type].index && (purpose !== 'sort' || boundedSortTypes.has(type)));

  function declare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void run(async () => {
      await api(path, session.token, json('POST', { fieldId: data.get('field'), purpose, reason: data.get('reason') }));
      form.reset();
    });
  }

  return <section className="stack">
    <h3>Runtime indexes</h3>
    <form className="stack" onSubmit={declare}>
      <label>Query use <select value={purpose} onChange={(event) => setPurpose(event.target.value as IndexPurpose)}>
        {indexPurposes.map((use) => <option key={use} value={use}>{use}</option>)}
      </select></label>
      <label>Published field <select name="field" key={purpose} required>
        <option value="">Choose a field</option>
        {eligible.map(({ fieldId, name }) => <option value={fieldId} key={fieldId}>{name}</option>)}
      </select></label>
      <label>Build reason <input name="reason" required maxLength={250} /></label>
      <button type="submit" disabled={busy || !eligible.length}>Queue index build</button>
    </form>
    <div className="inline"><button type="button" disabled={busy} onClick={() => void run(refresh)}>Refresh index states</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {jobs.map((job) => <article key={job.id} className="panel stack">
      <h4>{job.fieldName} · {job.purpose}</h4>
      <p role="status">{job.retiredAt ? 'Retired' : job.retireRequested ? 'Retirement queued' : job.state}</p>
      <dl><dt>Reason</dt><dd>{job.reason}</dd><dt>Last used</dt>
        <dd>{job.lastUsedAt ? new Date(job.lastUsedAt).toLocaleString() : 'No recorded use'}</dd></dl>
      {job.retireReason && <p>{job.retireReason}</p>}
      {job.failureReason && <p className="error">{job.failureReason}</p>}
      {job.problems.length > 0 && <ul>{job.problems.map(({ recordNo, value, reason }) =>
        <li key={recordNo}>Record {recordNo} · {reason}{value !== null && <> · <code>{value}</code></>}</li>)}</ul>}
      {!job.retiredAt && !job.retireRequested && <div className="inline">
        {job.state === 'failed' && <button type="button" disabled={busy}
          onClick={() => void run(() => api(path + '/' + job.id + '/retry', session.token, json('POST')))}>Retry build</button>}
        <button type="button" disabled={busy}
          onClick={() => void run(() => api(path + '/' + job.id, session.token, json('DELETE')))}>Retire index</button>
      </div>}
    </article>)}
  </section>;
}
