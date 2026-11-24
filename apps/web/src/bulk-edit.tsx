import { useRef, useState, type FormEvent } from 'react';
import { api, json, message, type App, type Session } from './api';
import type { SelectorOptions } from './selector-options';
import { normalizeInForm, RuntimeField } from './forms';
import { Turnstile, useSampleSiteKey } from './turnstile';

type Row = { id: string; revision: number; recordNo: string };
type Outcome = { id: string; status: number; error?: unknown };

function resultMessage(outcome: Outcome) {
  if (outcome.status === 200) return 'Saved';
  if (outcome.status === 409) return 'Conflict. Reload the record before retrying.';
  if (outcome.status === 403 || outcome.status === 404) return '无权限';
  const error = outcome.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return 'Validation failed';
}

export function BulkEdit({ app, path, rows, session, done, close, directory }: {
  app: App; directory?: SelectorOptions; path: string; rows: Row[]; session: Session; done: () => Promise<void>; close: () => void;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [value, setValue] = useState('');
  const [clear, setClear] = useState(false);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<(Outcome & { recordNo: string })[]>([]);
  const fields = app.fields.filter(({ editable }) => editable);
  const field = fields.find((field) => field.fieldId === fieldId);
  const guest = session.profile.sampleGuest === true;
  const siteKey = useSampleSiteKey(guest);
  const turnstileToken = useRef<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!field || !selection.length) return;
    if (guest && !turnstileToken.current) { setError('先に本人確認（Turnstile）を完了してください'); return; }
    setBusy(true); setError(''); setResults([]);
    try {
      const selected = selection.flatMap((id) => {
        const row = rows.find((row) => row.id === id);
        return row ? [row] : [];
      });
      const { results } = await api<{ results: Outcome[] }>(path + '/batch', session.token, {
        ...json('PATCH', {
          fieldId, value: clear ? null : normalizeInForm(field, value, session.profile.timeZone), items: selected.map(({ id, revision }) => ({ id, revision })),
        }),
        ...(guest ? { headers: { 'x-turnstile-token': turnstileToken.current! } } : {}),
      });
      if (guest) { turnstileToken.current = null; setTurnstileReset((n) => n + 1); }
      setResults(results.map((outcome) => ({ ...outcome, recordNo: selected.find(({ id }) => id === outcome.id)!.recordNo })));
      setSelection([]);
      await done();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel stack" aria-label="Batch edit">
    <div className="inline spread"><h2>Batch edit</h2><button onClick={close}>Close batch edit</button></div>
    <form className="stack" onSubmit={(event) => void submit(event)}>
      <fieldset className="stack" disabled={busy}><legend>Displayed records</legend>
        {rows.slice(0, 100).map(({ id, recordNo }) => <label key={id} className="option">
          <input type="checkbox" checked={selection.includes(id)} onChange={(event) =>
            setSelection((current) => event.target.checked ? [...current, id] : current.filter((value) => value !== id))} /> Record {recordNo}
        </label>)}
      </fieldset>
      <label>Field to edit <select value={fieldId} required onChange={(event) => {
        setFieldId(event.target.value); setValue(''); setPending(false);
      }}>
        <option value="">Choose field</option>
        {fields.map(({ fieldId, name }) => <option key={fieldId} value={fieldId}>{name}</option>)}
      </select></label>
      {field && <div className="stack">
        <label className="option"><input type="checkbox" checked={clear} onChange={(event) => setClear(event.target.checked)} /> Clear this field</label>
        {!clear && <>
          <label htmlFor={'field-' + field.fieldId} id={'field-' + field.fieldId + '-label'}>New value for {field.name}</label>
          <RuntimeField key={field.fieldId} field={field} value={value} onChange={setValue} onPending={(names) => setPending(names.length > 0)}
            session={session} app={app} disabled={busy} directory={directory} />
        </>}
      </div>}
      {guest && siteKey && <Turnstile siteKey={siteKey} resetSignal={turnstileReset}
        onToken={(token) => { turnstileToken.current = token; }} />}
      <button type="submit" disabled={!field || !selection.length || busy || pending && !clear}>Update selected records</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {results.length > 0 && <ul aria-label="Batch results">{results.map((outcome) =>
      <li key={outcome.id}>Record {outcome.recordNo} · {resultMessage(outcome)}</li>)}</ul>}
  </section>;
}
