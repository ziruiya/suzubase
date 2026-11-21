import { appActions, fieldActions, recordActions, type AclConfiguration, type RecordSubject,
  type DirectorySubject, type ViewCondition } from '@suzubase/shared-types';
import { useEffect, useState, type FormEvent } from 'react';
import { api, appPath, json, message, type App, type Field, type Session } from './api';
import type { DirectoryData } from './directory';
import { Conditions } from './conditions';

type Layer = keyof AclConfiguration;
type Rule<L extends Layer> = Omit<AclConfiguration[L][number], 'id'>;
type DraftAcl = { [L in Layer]: Rule<L>[] };
type Decision = { allowed: boolean; matched: string[]; allowedRecords?: string };
type Preview = {
  app: Record<string, Decision>; record: Record<string, Decision>;
  fields: Record<string, Record<string, Decision>>; matchedRecords?: string;
};
const empty: DraftAcl = { app: [], record: [], field: [] };
const subjects = ['user', 'organization', 'group'] as const;

function Subject({ subject, fields, directory, allowField, onChange }: {
  subject: RecordSubject; fields: Field[]; directory?: DirectoryData; allowField: boolean;
  onChange: (subject: RecordSubject) => void;
}) {
  const choices = [...subjects, ...(allowField ? ['user-field', 'organization-field', 'group-field'] as const : [])];
  const directoryOptions = subject.kind === 'user' ? directory?.members.map(({ id, label }) => ({ id, name: label }))
    : subject.kind === 'organization' ? directory?.organizations : subject.kind === 'group' ? directory?.groups
      : fields.filter(({ type }) => type === subject.kind.replace('-field', '')).map(({ fieldId, name }) => ({ id: fieldId, name }));
  return <>
    <label>Subject type <select value={subject.kind} onChange={(event) =>
      onChange({ kind: event.target.value as RecordSubject['kind'], id: '' } as RecordSubject)}>
      {choices.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
    </select></label>
    {directoryOptions ? <label>Subject <select aria-label="Subject" value={subject.id} required onChange={(event) => onChange({ ...subject, id: event.target.value })}>
      <option value="">Select subject</option>
      {subject.id && !directoryOptions.some(({ id }) => id === subject.id) && <option value={subject.id}>{subject.id}</option>}
      {directoryOptions.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
    </select></label> : <label>Subject ID <input value={subject.id} required onChange={(event) => onChange({ ...subject, id: event.target.value })} /></label>}
  </>;
}

function Actions<T extends string>({ actions, value, onChange }: { actions: readonly T[]; value: T; onChange: (value: T) => void }) {
  return <label>Action <select value={value} onChange={(event) => onChange(event.target.value as T)}>
    {actions.map((action) => <option key={action} value={action}>{action}</option>)}
  </select></label>;
}

export function PermissionsSettings({ app, fields, session, refresh }: {
  app: App; fields: Field[]; session: Session; refresh: () => Promise<void>;
}) {
  const root = appPath(app.id);
  const [acl, setAcl] = useState<DraftAcl>();
  const [directory, setDirectory] = useState<DirectoryData>();
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [mode, setMode] = useState<'app' | 'record' | 'conditions'>('record');
  const [conditions, setConditions] = useState<ViewCondition[]>([]);

  useEffect(() => {
    void api<AclConfiguration>(root + '/draft/acl', session.token).then((result) => {
      setAcl({
        app: result.app.map(({ id: _id, ...rule }) => rule),
        record: result.record.map(({ id: _id, ...rule }) => rule),
        field: result.field.map(({ id: _id, ...rule }) => rule),
      });
    }).catch((error) => setError(message(error)));
    if (session.profile.isAdmin) void api<DirectoryData>('/tenant/directory', session.token).then(setDirectory).catch(() => undefined);
  }, [root, session.token]);

  function change<L extends Layer>(layer: L, index: number, rule: Rule<L> | null) {
    const base = acl ?? empty;
    const rows = [...base[layer]];
    if (rule) rows[index] = rule;
    else rows.splice(index, 1);
    setAcl({ ...base, [layer]: rows });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setStatus('');
    try { await action(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }

  function evaluate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(async () => {
      setPreview(await api<Preview>(root + '/permissions/preview', session.token, json('POST', {
        userId: values.get('user'),
        ...(mode === 'record' && { recordId: values.get('record') }),
        ...(mode === 'conditions' && { conditions }),
      })));
    });
  }

  return <section className="stack">
    {error && <p className="error" role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    {acl && <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        await api(root + '/draft/acl', session.token, json('PUT', acl));
        await refresh();
        setStatus('Permissions saved to the draft.');
      });
    }}>
      <fieldset className="stack"><legend>Application permissions</legend>
        {acl.app.map((rule, i) => <div className="inline" key={i}>
          <Actions actions={appActions} value={rule.action} onChange={(action) => change('app', i, { ...rule, action })} />
          <Subject subject={rule.subject} fields={fields} directory={directory} allowField={false}
            onChange={(subject) => change('app', i, { ...rule, subject: subject as DirectorySubject })} />
          <button type="button" onClick={() => change('app', i, null)}>Remove application rule</button>
        </div>)}
        <button type="button" onClick={() => change('app', acl.app.length, { action: 'view', subject: { kind: 'user', id: '' } })}>Add application rule</button>
      </fieldset>
      <fieldset className="stack"><legend>Record permissions</legend>
        {acl.record.map((rule, i) => <div className="panel stack" key={i}>
          <div className="inline">
            <Actions actions={recordActions} value={rule.action} onChange={(action) => change('record', i, { ...rule, action })} />
            <Subject subject={rule.subject} fields={fields} directory={directory} allowField
              onChange={(subject) => change('record', i, { ...rule, subject })} />
          </div>
          <Conditions conditions={rule.conditions} fields={fields}
            onChange={(conditions) => change('record', i, { ...rule, conditions })} />
          <button type="button" onClick={() => change('record', i, null)}>Remove record rule</button>
        </div>)}
        <button type="button" onClick={() => change('record', acl.record.length, {
          action: 'view', subject: { kind: 'user', id: '' }, conditions: [],
        })}>Add record rule</button>
      </fieldset>
      <fieldset className="stack"><legend>Field permissions</legend>
        {acl.field.map((rule, i) => <div className="inline" key={i}>
          <label>Field <select value={rule.fieldId} required onChange={(event) => change('field', i, { ...rule, fieldId: event.target.value })}>
            <option value="">Choose field</option>
            {fields.map(({ fieldId, name }) => <option key={fieldId} value={fieldId}>{name}</option>)}
          </select></label>
          <Actions actions={fieldActions} value={rule.action} onChange={(action) => change('field', i, { ...rule, action })} />
          <Subject subject={rule.subject} fields={fields} directory={directory} allowField={false}
            onChange={(subject) => change('field', i, { ...rule, subject: subject as DirectorySubject })} />
          <button type="button" onClick={() => change('field', i, null)}>Remove field rule</button>
        </div>)}
        <button type="button" disabled={!fields.length} onClick={() => change('field', acl.field.length, {
          fieldId: '', action: 'view', subject: { kind: 'user', id: '' },
        })}>Add field rule</button>
      </fieldset>
      <button type="submit" disabled={busy}>Save permissions to draft</button>
    </form>}
    <form className="stack" onSubmit={evaluate}>
      <h3>Preview published permissions</h3>
      {directory ? <label>Target user <select name="user" required><option value="">Select user</option>
        {directory.members.filter(({ disabledAt }) => !disabledAt).map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </select></label> : <label>Target user ID <input name="user" required /></label>}
      <label>Preview scope <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="record">Record ID</option><option value="conditions">Matching records</option><option value="app">Application</option>
      </select></label>
      {mode === 'record' && <label>Record ID <input name="record" required /></label>}
      {mode === 'conditions' && <Conditions fields={app.fields} conditions={conditions} onChange={setConditions} />}
      <button disabled={busy || (mode === 'conditions' && !conditions.length)}>Evaluate permissions</button>
    </form>
    {preview && <section className="stack" aria-label="Permission preview result">
      {preview.matchedRecords !== undefined && <p>{preview.matchedRecords} records matched the conditions.</p>}
      <Decisions title="Application" decisions={preview.app} />
      <Decisions title="Records" decisions={preview.record} />
      {Object.entries(preview.fields).map(([id, decisions]) =>
        <Decisions key={id} title={fields.find(({ fieldId }) => fieldId === id)?.name ?? id} decisions={decisions} />)}
    </section>}
  </section>;
}

function Decisions({ title, decisions }: { title: string; decisions: Record<string, Decision> }) {
  return <details open>
    <summary>{title}</summary>
    <dl>{Object.entries(decisions).map(([action, { allowed, matched, allowedRecords }]) => <div key={action}>
      <dt>{action}</dt><dd>{allowed ? 'Allowed' : 'Denied'}{allowedRecords !== undefined && ' · ' + allowedRecords + ' records'}
        {matched.length > 0 && <ul>{matched.map((rule) => <li key={rule}>{rule}</li>)}</ul>}</dd>
    </div>)}</dl>
  </details>;
}
