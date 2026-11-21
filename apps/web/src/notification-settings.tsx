import { useEffect, useState } from 'react';
import type { NotificationRecipient, NotificationRule, NotificationTrigger } from '@suzubase/shared-types';
import { api, appPath, json, message, type Field } from './api';
import { Conditions } from './conditions';
import { directoryType, type SelectorOptions } from './selector-options';

const triggers: [NotificationTrigger, string][] = [
  ['created', 'Record created'], ['updated', 'Record edited'], ['workflow-action', 'Workflow action'],
  ['workflow-state', 'Workflow reached a state'], ['comment-created', 'Comment posted'], ['mention', 'Mentioned in a comment'],
];
type Settings = {
  published: NotificationRule[]; draft: NotificationRule[] | null; directory: SelectorOptions;
  actions: { id: string; name: string }[]; states: { code: string; name: string }[];
};
const recipientKinds: [NotificationRecipient['kind'], string][] = [
  ['user', 'User'], ['organization', 'Organization'], ['group', 'Group'], ['user-field', 'User field'],
  ['creator', 'Record creator'], ['assignees', 'Current assignees'], ['comment-author', 'Comment author'],
];

export function NotificationSettings({ appId, token, fields, onSaved }: {
  appId: string; token: string; fields: Field[]; onSaved: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const path = appPath(appId) + '/notification-rules';

  useEffect(() => {
    const abort = new AbortController();
    void api<Settings>(path, token, { signal: abort.signal }).then((value) => {
      if (!abort.signal.aborted) {
        setSettings(value);
        setRules(value.draft ?? value.published);
      }
    }).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [path, token]);

  function update(next: NotificationRule) {
    setRules(rules.map((rule) => rule.id === next.id ? next : rule));
    setNotice('');
  }

  async function save() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api<{ rules: NotificationRule[] }>(path, token, json('PUT', { rules }));
      setRules(saved.rules);
      await onSaved();
      setNotice('Notification rules saved to the draft. Publish to activate them.');
    } catch (error) {
      setError(message(error));
    } finally { setBusy(false); }
  }

  return <section className="stack" aria-label="Notification rules">
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {settings && <form className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {rules.map((rule) => <fieldset key={rule.id} className="stack">
        <legend>{rule.title || 'Notification rule'}</legend>
        <label className="option"><input type="checkbox" checked={rule.enabled} onChange={(event) =>
          update({ ...rule, enabled: event.target.checked })} /> Enabled</label>
        <label>Trigger <select value={rule.trigger} onChange={(event) => update({
          ...rule, trigger: event.target.value as NotificationTrigger, actionId: undefined, stateCode: undefined,
        })}>{triggers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        {rule.trigger === 'workflow-action' && <label>Action <select value={rule.actionId ?? ''} onChange={(event) =>
          update({ ...rule, actionId: event.target.value || undefined })}>
          <option value="">Any action</option>
          {settings.actions.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select></label>}
        {rule.trigger === 'workflow-state' && <label>State <select value={rule.stateCode ?? ''} required onChange={(event) =>
          update({ ...rule, stateCode: event.target.value })}>
          <option value="">Select a state</option>
          {settings.states.map(({ code, name }) => <option key={code} value={code}>{name}</option>)}
        </select></label>}
        <Conditions fields={fields} conditions={rule.conditions} onChange={(conditions) => update({ ...rule, conditions })} />
        <fieldset className="stack">
          <legend>Recipients</legend>
          {rule.recipients.map((entry, index) => {
            const replace = (value: NotificationRecipient) => update({ ...rule,
              recipients: rule.recipients.map((item, i) => i === index ? value : item) });
            const choices = directoryType(entry.kind) ? settings.directory[entry.kind].filter(({ disabled }) => !disabled) :
              entry.kind === 'user-field' ? fields.filter(({ type }) => type === 'user').map(({ fieldId, name }) => ({ id: fieldId, name })) : [];
            return <div className="inline" key={index}>
              <label>Recipient source <select value={entry.kind} onChange={(event) => {
                const kind = event.target.value as NotificationRecipient['kind'];
                replace(kind === 'creator' || kind === 'assignees' || kind === 'comment-author' ? { kind } : { kind, id: '' });
              }}>{recipientKinds.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
              {'id' in entry && <label>Recipient <select value={entry.id} required onChange={(event) =>
                replace({ ...entry, id: event.target.value })}>
                <option value="">Select a recipient</option>
                {choices.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </select></label>}
              <button type="button" onClick={() => update({ ...rule, recipients: rule.recipients.filter((_, i) => i !== index) })}>Remove recipient</button>
            </div>;
          })}
          <button type="button" onClick={() => update({ ...rule, recipients: [...rule.recipients, { kind: 'creator' }] })}>Add recipient</button>
        </fieldset>
        {(['title', 'body'] as const).map((key) => <div key={key} className="stack">
          <label>{key === 'title' ? 'Title' : 'Body'} <textarea value={rule[key]} required={key === 'title'}
            maxLength={key === 'title' ? 200 : 4000} onChange={(event) => update({ ...rule, [key]: event.target.value })} /></label>
          {fields.length > 0 && <label>Insert field in {key} <select value="" onChange={(event) => {
            if (event.target.value) update({ ...rule, [key]: rule[key] + '{{' + event.target.value + '}}' });
          }}><option value="">Select a field</option>
            {fields.filter(({ type }) => !['layout', 'table', 'related', 'lookup'].includes(type))
              .map(({ fieldId, name }) => <option value={fieldId} key={fieldId}>{name}</option>)}
          </select></label>}
        </div>)}
        <button type="button" onClick={() => setRules(rules.filter(({ id }) => id !== rule.id))}>Remove rule</button>
      </fieldset>)}
      <button type="button" disabled={busy} onClick={() => setRules([...rules, {
        id: crypto.randomUUID(), enabled: true, trigger: 'created', conditions: [], recipients: [{ kind: 'creator' }], title: '', body: '',
      }])}>Add rule</button>
      <button type="submit" className="primary" disabled={busy || rules.some(({ recipients }) => !recipients.length)}>Save notification draft</button>
    </form>}
  </section>;
}
