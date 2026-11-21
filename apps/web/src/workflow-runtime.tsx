import { useEffect, useRef, useState } from 'react';
import type { RecordResponse } from '@suzubase/shared-types';
import { api, appPath, json, message, type AppSummary, type Session } from './api';
import type { SelectorOptions } from './selector-options';

type State = { id: string; code: string; name: string; terminal: boolean };
type Choice = { id: string; name: string; target: State; reason: string | null };
type Runtime = {
  version: number; state: State; actions: Choice[]; canReassign: boolean;
  assignees: { id: string; name: string; disabled: boolean }[];
};
type Task = { appId: string; appName: string; recordId: string; recordNo: string; state: string; stateName: string };
type TaskPage = { items: Task[]; next: string | null };

export function WorkflowDetail({ record, session, refresh }: { record: RecordResponse; session: Session; refresh: () => void }) {
  const [workflow, setWorkflow] = useState<Runtime>();
  const [choice, setChoice] = useState<Choice>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [directory, setDirectory] = useState<SelectorOptions>();
  const [assignees, setAssignees] = useState<string[]>();
  const dialog = useRef<HTMLDialogElement>(null);
  const { token } = session;
  const path = appPath(record.appId) + '/records/' + record.id + '/workflow';

  useEffect(() => {
    const abort = new AbortController();
    void api<{ workflow: Runtime | null }>(path, token, { signal: abort.signal }).then(({ workflow }) => {
      if (!abort.signal.aborted) setWorkflow(workflow ?? undefined);
    }).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [path, token, record.revision]);
  useEffect(() => { if (choice) dialog.current?.showModal(); }, [choice]);

  async function submit(suffix: string, data: Record<string, unknown>) {
    setError('');
    setBusy(true);
    try {
      await api(path + suffix, token, json('POST', { revision: record.revision, ...data }));
      setChoice(undefined);
      setAssignees(undefined);
      refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  if (!workflow) return error ? <p role="alert">{error}</p> : null;
  return <section className="stack" aria-label="Workflow">
    <h2>{workflow.state.name}</h2>
    <p>Assignees · {workflow.assignees.map(({ name, disabled }) => name + (disabled ? ' (disabled)' : '')).join(', ') || 'None'}</p>
    {error && !choice && <p role="alert">{error}</p>}
    {workflow.actions.length > 0 && <div className="workflow-actions inline">
      {workflow.actions.map((action) => <div key={action.id} className="stack">
        <button className="primary" type="button" disabled={!!action.reason || busy} onClick={() => {
          setError('');
          setChoice(action);
        }}>{action.name}</button>
        {action.reason && <small>{action.reason}</small>}
      </div>)}
    </div>}
    {workflow.canReassign && assignees === undefined && <button type="button" disabled={busy} onClick={() => {
      setError('');
      void api<SelectorOptions>(appPath(record.appId) + '/workflow/directory', token).then((options) => {
        setDirectory(options);
        setAssignees(workflow.assignees.filter(({ disabled }) => !disabled).map(({ id }) => id));
      }).catch((error) => setError(message(error)));
    }}>Reassign</button>}
    {assignees && <fieldset className="stack">
      <legend>Reassign record {record.recordNo}</legend>
      <label>Assignees <select multiple value={assignees} onChange={(event) =>
        setAssignees(Array.from(event.target.selectedOptions, ({ value }) => value))}>
        {directory?.user.filter(({ disabled }) => !disabled).map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <div className="inline">
        <button type="button" disabled={busy || !assignees.length} onClick={() => void submit('/reassign', { userIds: assignees })}>Save assignees</button>
        <button type="button" disabled={busy} onClick={() => setAssignees(undefined)}>Cancel</button>
      </div>
    </fieldset>}
    {choice && <dialog className="workflow-confirm" aria-label="Confirm workflow action" ref={dialog} onCancel={(event) => {
      event.preventDefault();
      if (!busy) setChoice(undefined);
    }}>
      <div className="stack">
        <h2>{choice.name}</h2>
        <p>Record {record.recordNo} · {workflow.state.name} → {choice.target.name}</p>
        {error && <p role="alert">{error}</p>}
        <div className="inline">
          <button type="button" disabled={busy} onClick={() => setChoice(undefined)}>Cancel</button>
          <button type="button" className="primary" disabled={busy} onClick={() =>
            void submit('/actions', { action_id: choice.id })}>Confirm {choice.name}</button>
        </div>
      </div>
    </dialog>}
  </section>;
}

export function Tasks({ token, apps, appId, unassigned, open }: {
  token: string; apps?: AppSummary[]; appId?: string; unassigned?: boolean; open: (appId: string, recordId: string) => void;
}) {
  const [filterApp, setFilterApp] = useState('');
  const [state, setState] = useState('');
  const [after, setAfter] = useState<string>();
  const [page, setPage] = useState<TaskPage>();
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams();
    if (filterApp || appId) params.set('appId', filterApp || appId!);
    if (state) params.set('state', state);
    if (after) params.set('after', after);
    const route = unassigned ? 'unassigned' : 'tasks';
    setError('');
    setPage(undefined);
    void api<TaskPage>('/workflow/' + route + '?' + params, token, { signal: abort.signal })
      .then((result) => { if (!abort.signal.aborted) setPage(result); })
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [token, appId, unassigned, filterApp, state, after]);
  return <section className="stack" aria-label={unassigned ? 'Records without active assignees' : 'My tasks'}>
    <h2>{unassigned ? 'Records without active assignees' : 'My tasks'}</h2>
    <div className="inline">
      {apps && <label>Application <select value={filterApp} onChange={(event) => {
        setAfter(undefined);
        setFilterApp(event.target.value);
      }}><option value="">All applications</option>{apps.map(({ id, name }) =>
        <option value={id} key={id}>{name}</option>)}</select></label>}
      <form className="inline" onSubmit={(event) => {
        event.preventDefault();
        setAfter(undefined);
        setState(String(new FormData(event.currentTarget).get('state')));
      }}>
        <label>State code <input name="state" pattern="[a-z][a-z0-9_\-]{0,63}" maxLength={64} /></label>
        <button type="submit">Filter</button>
      </form>
    </div>
    {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading…</p> : <>
      {!page.items.length && <p>No records</p>}
      <ul className="plain stack">{page.items.map((item) => <li key={item.recordId}>
        <button type="button" onClick={() => open(item.appId, item.recordId)}>
          {appId ? '' : item.appName + ' · '}Record {item.recordNo} · {item.stateName}
        </button>
      </li>)}</ul>
      {after && <button type="button" onClick={() => setAfter(undefined)}>First page</button>}
      {page.next && <button type="button" onClick={() => setAfter(page.next!)}>Next page</button>}
    </>}
  </section>;
}
