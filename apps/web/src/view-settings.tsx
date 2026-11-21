import { fieldContract, type SavedView, type ViewConfiguration } from '@suzubase/shared-types';
import { useState, type FormEvent } from 'react';
import { api, json, message, type Field, type Session } from './api';
import { Conditions } from './conditions';

const blank: Omit<SavedView, 'id'> = { name: '', columns: [], conditions: [] };

export function ViewSettings({ configuration, fields, path, session, refresh }: {
  configuration: ViewConfiguration; fields: Field[]; path: string; session: Session; refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [view, setView] = useState(blank);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState(false);
  const route = path + '/draft/views';

  function select(id: string, views = configuration.views) {
    const saved = views.find((entry) => entry.id === id);
    setSelected(id);
    setRemove(false);
    setView(saved ? { name: saved.name, columns: saved.columns, sort: saved.sort, conditions: saved.conditions, aggregateFields: saved.aggregateFields } : blank);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); await refresh(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const result = await api<ViewConfiguration>(route + (selected ? '/' + selected : ''), session.token,
        json(selected ? 'PUT' : 'POST', view));
      const id = selected || result.views.at(-1)!.id;
      select(id, result.views);
      setNotice('View saved to the draft.');
    });
  }
  return <section className="stack">
    <h3>Saved views</h3>
    <label>Draft view <select value={selected} onChange={(event) => select(event.target.value)}>
      <option value="">Create a view</option>
      {configuration.views.map(({ id, name }) => <option key={id} value={id}>{name}{id === configuration.defaultId ? ' · default' : ''}</option>)}
    </select></label>
    <form className="stack" onSubmit={submit}>
      <label>View name <input value={view.name} onChange={(event) => setView({ ...view, name: event.target.value })} maxLength={120} required /></label>
      <Conditions fields={fields} conditions={view.conditions} onChange={(conditions) => setView({ ...view, conditions })} />
      <div className="inline">
        <label>Sort field <select value={view.sort?.fieldId ?? ''} onChange={(event) => setView({ ...view,
          sort: event.target.value ? { fieldId: event.target.value, direction: view.sort?.direction ?? 'asc' } : undefined })}>
          <option value="">Record number</option>
          {fields.filter(({ type }) => fieldContract[type].sort).map(({ fieldId, name }) =>
            <option key={fieldId} value={fieldId}>{name}</option>)}
        </select></label>
        {view.sort && <label>Sort direction <select value={view.sort.direction} onChange={(event) =>
          setView({ ...view, sort: { fieldId: view.sort!.fieldId, direction: event.target.value as 'asc' | 'desc' } })}>
          <option value="asc">Ascending</option><option value="desc">Descending</option>
        </select></label>}
      </div>
      <fieldset className="stack">
        <legend>Numeric summaries</legend>
        <label className="option"><input type="checkbox" checked={view.aggregateFields !== undefined} onChange={(event) =>
          setView({ ...view, aggregateFields: event.target.checked ? [] : undefined })} /> Choose summary fields for this view</label>
        {view.aggregateFields && fields.filter(({ type }) => fieldContract[type].aggregate).map(({ fieldId, name }) =>
          <label className="option" key={fieldId}><input type="checkbox" checked={view.aggregateFields!.includes(fieldId)}
            disabled={view.aggregateFields!.length >= 10 && !view.aggregateFields!.includes(fieldId)} onChange={(event) => {
              const current = view.aggregateFields!;
              setView({ ...view, aggregateFields: event.target.checked ? [...current, fieldId] : current.filter((id) => id !== fieldId) });
            }} /> {name}</label>)}
      </fieldset>
      <fieldset className="stack">
        <legend>Columns</legend>
        {!view.columns.length && <p>All visible record fields will be shown.</p>}
        {view.columns.map((column, index) => <div key={column.fieldId} className="inline">
          <strong>{fields.find(({ fieldId }) => fieldId === column.fieldId)?.name ?? 'Missing field'}</strong>
          <label>Width <input type="number" min={80} max={800} required value={column.width} onChange={(event) =>
            setView({ ...view, columns: view.columns.map((entry) =>
              entry.fieldId === column.fieldId ? { ...entry, width: event.target.valueAsNumber } : entry) })} /></label>
          <button type="button" disabled={index === 0} onClick={() => {
            const columns = [...view.columns];
            [columns[index - 1], columns[index]] = [columns[index], columns[index - 1]];
            setView({ ...view, columns });
          }}>Move column up</button>
          <button type="button" onClick={() => setView({ ...view, columns: view.columns.filter((entry) =>
            entry.fieldId !== column.fieldId) })}>Remove column</button>
        </div>)}
        <label>Add column <select value="" onChange={(event) => {
          if (event.target.value) setView({ ...view, columns: [...view.columns, { fieldId: event.target.value, width: 160 }] });
        }}>
          <option value="">Choose a field</option>
          {fields.filter(({ fieldId, type }) => type !== 'layout' && !view.columns.some((entry) => entry.fieldId === fieldId))
            .map(({ fieldId, name }) => <option key={fieldId} value={fieldId}>{name}</option>)}
        </select></label>
      </fieldset>
      <button type="submit" disabled={busy}>Save view to draft</button>
    </form>
    {selected && <div className="inline">
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await api(route + '/default', session.token, json('PUT', { viewId: selected === configuration.defaultId ? null : selected }));
        setNotice('Default view updated in the draft.');
      })}>{selected === configuration.defaultId ? 'Clear default view' : 'Set as default view'}</button>
      <button type="button" disabled={busy} onClick={() => {
        if (!remove) { setRemove(true); return; }
        void run(async () => { await api(route + '/' + selected, session.token, json('DELETE')); select(''); });
      }}>{remove ? 'Confirm view deletion' : 'Delete view'}</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
