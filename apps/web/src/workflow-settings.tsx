import { useEffect, useState } from 'react';
import {
  fieldContract, workflowComparisonOperators, type AssigneeSource, type WorkflowAction, type WorkflowCondition,
  type WorkflowDefinition, type WorkflowGraph, type WorkflowState,
} from '@suzubase/shared-types';
import { api, appPath, json, message, type App, type Field } from './api';
import { directoryType, type SelectorOptions } from './selector-options';

type Settings = { enabled: boolean; versions: Pick<WorkflowDefinition, 'version' | 'status'>[]; draft: WorkflowDefinition | null };
type RuleProps = { fields: Field[]; directory?: SelectorOptions };

function Rules({ rules, change, fields, directory }: RuleProps & {
  rules: AssigneeSource[]; change: (rules: AssigneeSource[]) => void;
}) {
  return <fieldset className="stack">
    <legend>Assignees</legend>
    {rules.map((rule, index) => {
      const update = (next: AssigneeSource) => change(rules.map((entry, i) => i === index ? next : entry));
      const choices = directoryType(rule.kind) ? directory?.[rule.kind].filter(({ disabled }) => !disabled) :
        rule.kind === 'user-field' ? fields.filter(({ type }) => type === 'user').map(({ fieldId, name }) => ({ id: fieldId, name })) : undefined;
      return <div className="inline" key={index}>
        <label>Source <select value={rule.kind} onChange={(event) => {
          const kind = event.target.value as AssigneeSource['kind'];
          update(kind === 'creator' || kind === 'previous' ? { kind } : { kind, id: '' });
        }}>
          <option value="creator">Creator</option><option value="previous">Previous assignees</option>
          <option value="user">User</option><option value="organization">Organization</option><option value="group">Group</option>
          <option value="user-field">User field</option>
        </select></label>
        {'id' in rule && <label>Assignee source <select required value={rule.id} onChange={(event) => update({ ...rule, id: event.target.value })}>
          <option value="">Select a source</option>
          {rule.id && !choices?.some(({ id }) => id === rule.id) && <option value={rule.id}>{rule.id}</option>}
          {choices?.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select></label>}
        <button type="button" onClick={() => change(rules.filter((_, i) => i !== index))}>Remove source</button>
      </div>;
    })}
    <button type="button" onClick={() => change([...rules, { kind: 'creator' }])}>Add assignee source</button>
  </fieldset>;
}

const operators = [
  ['eq', 'Equals'], ['ne', 'Does not equal'], ['empty', 'Is empty'], ['nonempty', 'Is filled'],
  ['current-user', 'Current user'], ['current-user-group', 'Current user’s group'],
  ['lt', 'Less than'], ['lte', 'At most'], ['gt', 'Greater than'], ['gte', 'At least'],
] as const;

function ActionConditions({ conditions, fields, change }: {
  conditions: WorkflowCondition[]; fields: Field[]; change: (conditions: WorkflowCondition[]) => void;
}) {
  const supported = fields.filter(({ type }) => fieldContract[type].filter);
  return <fieldset className="stack">
    <legend>Conditions (all must match)</legend>
    {conditions.map((condition, index) => {
      const update = (next: WorkflowCondition) => change(conditions.map((entry, i) => i === index ? next : entry));
      const field = fields.find(({ fieldId }) => fieldId === condition.fieldId);
      return <div className="inline" key={index}>
        <label>Field <select required value={condition.fieldId} onChange={(event) => update({
          fieldId: event.target.value, operator: 'eq', value: '',
        })}><option value="">Select a field</option>{supported.map(({ fieldId, name }) => <option key={fieldId} value={fieldId}>{name}</option>)}</select></label>
        <label>Operator <select value={condition.operator} onChange={(event) => {
          const operator = event.target.value as WorkflowCondition['operator'];
          const fieldId = condition.fieldId;
          update(operator === 'empty' || operator === 'nonempty' || operator === 'current-user' || operator === 'current-user-group'
            ? { fieldId, operator } : { fieldId, operator, value: 'value' in condition ? condition.value : '' });
        }}>{operators.filter(([operator]) => {
          if (operator === 'current-user') return field?.type === 'user';
          if (operator === 'current-user-group') return field?.type === 'group';
          return field?.type === 'number' || !workflowComparisonOperators.some((item) => item === operator);
        }).map(([operator, label]) => <option value={operator} key={operator}>{label}</option>)}</select></label>
        {'value' in condition && <label>Value <input value={condition.value} onChange={(event) => update({ ...condition, value: event.target.value })} /></label>}
        <button type="button" onClick={() => change(conditions.filter((_, i) => i !== index))}>Remove condition</button>
      </div>;
    })}
    {!!supported.length && <button type="button" onClick={() => change([...conditions, { fieldId: '', operator: 'eq', value: '' }])}>Add condition</button>}
  </fieldset>;
}

const emptyGraph: WorkflowGraph = { states: [], actions: [] };

export function WorkflowSettings({ app, token, fields }: { app: App; token: string; fields: Field[] }) {
  const path = appPath(app.id) + '/workflow';
  const [settings, setSettings] = useState<Settings>();
  const [graph, setGraph] = useState<WorkflowGraph>(emptyGraph);
  const [selected, setSelected] = useState<WorkflowDefinition>();
  const [directory, setDirectory] = useState<SelectorOptions>();
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    const request = { signal: abort.signal };
    void api<Settings>(path, token, request).then((result) => {
      setSettings(result);
      setGraph(result.draft ?? emptyGraph);
    }).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    void api<SelectorOptions>(path + '/directory', token, request).then(setDirectory)
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [path, app.id, token]);

  function change(next: WorkflowGraph) {
    setGraph(next);
    setDirty(true);
    setNotice('');
  }
  function updateState(next: WorkflowState) {
    change({ ...graph, states: graph.states.map((state) => state.id === next.id ? next :
      next.initial ? { ...state, initial: false } : state) });
  }
  function updateAction(next: WorkflowAction) {
    change({ ...graph, actions: graph.actions.map((action) => action.id === next.id ? next : action) });
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await operation(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  async function refresh(nextNotice: string) {
    const result = await api<Settings>(path, token);
    setSettings(result);
    setGraph(result.draft ?? emptyGraph);
    setDirty(false);
    setNotice(nextNotice);
  }

  return <section className="stack" aria-label="Workflow settings">
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {settings && <>
      <label className="option"><input type="checkbox" checked={settings.enabled}
        disabled={busy || !settings.versions.some(({ status }) => status === 'published')} onChange={(event) => {
          const enabled = event.target.checked;
          void run(async () => {
            await api(path + '/enabled', token, json('PATCH', { enabled }));
            setSettings({ ...settings, enabled });
          });
        }} /> Enable workflow for new records</label>
      {settings.versions.filter(({ status }) => status === 'published').map(({ version }) =>
        <button type="button" key={version} disabled={busy} onClick={() => void run(async () =>
          setSelected(await api<WorkflowDefinition>(path + '/versions/' + version, token)))}>View published version {version}</button>)}
      {selected && <details open>
        <summary>Published version {selected.version}</summary>
        <ul>{selected.states.map((state) => <li key={state.id}>{state.name}{state.initial && ' · initial'}{state.terminal && ' · terminal'}</li>)}</ul>
        <ul>{selected.actions.map((action) => <li key={action.id}>{action.name} · {
          selected.states.find(({ id }) => id === action.fromStateId)?.name} → {
          selected.states.find(({ id }) => id === action.toStateId)?.name}</li>)}</ul>
        <button type="button" disabled={busy || dirty || !!settings.draft} onClick={() =>
          change({ states: selected.states, actions: selected.actions })}>Use as new draft</button>
        <button type="button" onClick={() => setSelected(undefined)}>Close version</button>
      </details>}
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          await api(path + '/draft', token, json('PUT', { states: graph.states, actions: graph.actions }));
          await refresh('Workflow draft saved');
        });
      }}>
        <h3>{settings.draft ? 'Draft version ' + settings.draft.version : 'New workflow draft'}</h3>
        {graph.states.map((state) => <fieldset key={state.id} className="stack">
          <legend>{state.name || 'State'}</legend>
          <label>Name <input required value={state.name} onChange={(event) => updateState({ ...state, name: event.target.value })} /></label>
          <label>Code <input required pattern="[a-z][a-z0-9_\-]{0,63}" value={state.code} onChange={(event) =>
            updateState({ ...state, code: event.target.value })} /></label>
          <label className="option"><input type="checkbox" checked={state.initial} onChange={(event) =>
            updateState({ ...state, initial: event.target.checked })} /> Initial state</label>
          <label className="option"><input type="checkbox" checked={state.terminal} onChange={(event) =>
            updateState({ ...state, terminal: event.target.checked })} /> Terminal state</label>
          <Rules rules={state.assignees} fields={fields} directory={directory} change={(assignees) => updateState({ ...state, assignees })} />
          <button type="button" onClick={() => change({
            states: graph.states.filter(({ id }) => id !== state.id),
            actions: graph.actions.filter(({ fromStateId, toStateId }) => fromStateId !== state.id && toStateId !== state.id),
          })}>Remove state</button>
        </fieldset>)}
        <button type="button" onClick={() => change({ ...graph, states: [...graph.states, {
          id: crypto.randomUUID(), name: '', code: '', initial: !graph.states.length, terminal: false, assignees: [],
        }] })}>Add state</button>
        {graph.actions.map((action) => <fieldset className="stack" key={action.id}>
          <legend>{action.name || 'Action'}</legend>
          <label>Name <input required value={action.name} onChange={(event) => updateAction({ ...action, name: event.target.value })} /></label>
          {(['fromStateId', 'toStateId'] as const).map((key) => <label key={key}>{key === 'fromStateId' ? 'From' : 'To'}
            <select required value={action[key]} onChange={(event) => updateAction({ ...action, [key]: event.target.value })}>
              <option value="">Select a state</option>
              {graph.states.filter((state) => key === 'toStateId' || !state.terminal).map(({ id, name }) =>
                <option key={id} value={id}>{name}</option>)}
            </select>
          </label>)}
          <ActionConditions conditions={action.conditions} fields={fields} change={(conditions) => updateAction({ ...action, conditions })} />
          <Rules rules={action.assignees} fields={fields} directory={directory} change={(assignees) => updateAction({ ...action, assignees })} />
          <button type="button" onClick={() => change({ ...graph, actions: graph.actions.filter(({ id }) => id !== action.id) })}>Remove action</button>
        </fieldset>)}
        <button type="button" disabled={!graph.states.length} onClick={() => change({ ...graph, actions: [...graph.actions, {
          id: crypto.randomUUID(), name: '', fromStateId: '', toStateId: '', conditions: [], assignees: [],
        }] })}>Add action</button>
        <div className="inline">
          <button type="submit" disabled={busy || !dirty}>Save workflow draft</button>
          <button type="button" disabled={busy || dirty || !settings.draft} onClick={() => void run(async () => {
            await api(path + '/publish', token, json('POST'));
            await refresh('Workflow published');
          })}>Publish workflow</button>
        </div>
      </form>
    </>}
  </section>;
}
