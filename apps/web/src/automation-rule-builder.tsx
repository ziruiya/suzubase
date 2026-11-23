import { useEffect, useState, type FormEvent } from 'react';
import { api, appPath, json, message, type App, type AppSummary } from './api';

// P3-D wave3 (brief section 6): the automation management surface must let
// a business administrator complete the whole lifecycle without code --
// build a rule from trigger / condition / action forms, confirm the
// generated permission grant, dry-run against a real record, publish,
// enable, inspect runs and recover failures. Before this component the
// settings page only exposed run monitoring; rule creation was API-only.

type RuleRow = {
  id: string; name: string; enabled: boolean;
  currentVersion: number | null; archivedAt: string | null;
};
type Finding = { code: string; severity: string; message?: string };
type Preflight = { publishable: boolean; findings: Finding[] };
type WorkflowGraphShape = {
  states: { id: string; name: string }[];
  actions: { id: string; name: string; automationAllowed?: boolean }[];
};
type WorkflowSettingsShape = { published?: WorkflowGraphShape | null; draft?: WorkflowGraphShape | null };

const emptyGroup = { operator: 'and' as const, groups: [] as never[] };
const operators = ['eq', 'ne', 'gt', 'lt', 'gte', 'lte', 'contains', 'not_contains', 'empty', 'nonempty', 'in', 'contains_any', 'contains_all', 'changed_to'];
const actionTypes = ['NOTIFY', 'UPDATE_FIELDS', 'CREATE_RECORD', 'ADVANCE_WORKFLOW', 'WEBHOOK'] as const;
type ActionType = typeof actionTypes[number];

type ActionDraft = {
  key: number; type: ActionType;
  recipientFieldId: string; recipientUserIds: string; title: string; body: string;
  updateFieldId: string; updateMode: string; updateValue: string; updateSourceFieldId: string;
  targetAppId: string; mapTargetFieldId: string; mapMode: string; mapValue: string; mapSourceFieldId: string;
  workflowActionId: string; endpointId: string;
};
const newAction = (key: number): ActionDraft => ({
  key, type: 'NOTIFY',
  recipientFieldId: '', recipientUserIds: '', title: '', body: '',
  updateFieldId: '', updateMode: 'set', updateValue: '', updateSourceFieldId: '',
  targetAppId: '', mapTargetFieldId: '', mapMode: 'source', mapValue: '', mapSourceFieldId: '',
  workflowActionId: '', endpointId: '',
});

let actionKey = 1;

export function AutomationRuleBuilder({ app, token }: { app: App; token: string }) {
  const path = appPath(app.id) + '/automation';
  const fields = app.fields ?? [];
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [targetFields, setTargetFields] = useState<Record<string, App['fields']>>({});
  const [workflow, setWorkflow] = useState<WorkflowGraphShape>();
  const [endpoints, setEndpoints] = useState<{ id: string; name: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Builder form state.
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState('record.created');
  const [triggerFieldId, setTriggerFieldId] = useState('');
  const [triggerNewValue, setTriggerNewValue] = useState('');
  const [toStateId, setToStateId] = useState('');
  const [allowManual, setAllowManual] = useState(false);
  const [cadence, setCadence] = useState('weekly');
  const [weekday, setWeekday] = useState('1');
  const [monthDay, setMonthDay] = useState('1');
  const [localTime, setLocalTime] = useState('09:00');
  const [timezone, setTimezone] = useState('Asia/Tokyo');
  const [offsetDays, setOffsetDays] = useState('-3');
  const [missedRunPolicy, setMissedRunPolicy] = useState('');
  const [condFieldId, setCondFieldId] = useState('');
  const [condOperator, setCondOperator] = useState('eq');
  const [condValue, setCondValue] = useState('');
  const [actions, setActions] = useState<ActionDraft[]>([newAction(actionKey++)]);

  // Lifecycle state (per selected rule).
  const [selectedRuleId, setSelectedRuleId] = useState('');
  const [selectedVersion, setSelectedVersion] = useState('1');
  const [readable, setReadable] = useState<string[]>([]);
  const [writable, setWritable] = useState<string[]>([]);
  const [grantTargets, setGrantTargets] = useState<string[]>([]);
  const [grantOps, setGrantOps] = useState<string[]>([]);
  const [preflight, setPreflight] = useState<Preflight>();
  const [dryRunRecordId, setDryRunRecordId] = useState('');
  const [dryRunResult, setDryRunResult] = useState<unknown>();

  async function loadRules() {
    setRules(await api<RuleRow[]>(path + '/rules', token));
  }
  useEffect(() => {
    const abort = new AbortController();
    const request = { signal: abort.signal };
    void api<RuleRow[]>(path + '/rules', token, request).then(setRules).catch(() => undefined);
    void api<AppSummary[]>('/apps', token, request).then(setApps).catch(() => undefined);
    void api<{ id: string; name: string; url: string }[]>(path + '/webhook-endpoints', token, request)
      .then(setEndpoints).catch(() => undefined);
    void api<WorkflowSettingsShape>(appPath(app.id) + '/workflow', token, request)
      .then((result) => setWorkflow(result.published ?? result.draft ?? undefined)).catch(() => undefined);
    return () => abort.abort();
  }, [path, token, app.id]);

  async function run(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  async function loadTargetFields(appId: string) {
    if (!appId || targetFields[appId]) return;
    const full = await api<App>('/apps/' + appId, token);
    setTargetFields((prev) => ({ ...prev, [appId]: full.fields ?? [] }));
  }

  function buildConfig() {
    const trigger: Record<string, unknown> = { eventType: triggerType };
    if (triggerType === 'record.updated') {
      if (triggerFieldId) trigger.fieldId = triggerFieldId;
      if (triggerFieldId && triggerNewValue) trigger.newValue = triggerNewValue;
    }
    if (triggerType.startsWith('workflow.')) trigger.toStateId = toStateId;
    if (allowManual) trigger.allowManual = true;
    if (triggerType === 'schedule.fixed') {
      const schedule: Record<string, unknown> = { cadence, localTime, timezone };
      if (cadence === 'weekly') schedule.weekdays = [Number(weekday)];
      if (cadence === 'monthly') schedule.monthDay = Number(monthDay);
      if (missedRunPolicy) schedule.missedRunPolicy = missedRunPolicy;
      trigger.schedule = schedule;
    }
    if (triggerType === 'schedule.dateRelative') {
      trigger.dateRelative = {
        source: 'field', fieldId: triggerFieldId, offsetDays: Number(offsetDays), localTime, timezone,
      };
    }
    const conditionGroup = condFieldId
      ? { operator: 'and', groups: [{ conditions: [{ fieldId: condFieldId, operator: condOperator, ...(condOperator !== 'empty' && condOperator !== 'nonempty' && { value: condValue }) }] }] }
      : emptyGroup;
    return {
      schemaVersion: 1,
      trigger,
      conditions: { eventSnapshot: conditionGroup, currentState: conditionGroup },
      actions: actions.map((draft) => {
        const actionId = crypto.randomUUID();
        if (draft.type === 'NOTIFY') return {
          actionId, type: draft.type, notify: {
            ...(draft.recipientFieldId ? { recipientFieldId: draft.recipientFieldId } : {}),
            ...(draft.recipientUserIds.trim() ? { recipientUserIds: draft.recipientUserIds.split(',').map((v) => v.trim()).filter(Boolean) } : {}),
            ...(draft.title ? { title: draft.title } : {}),
            ...(draft.body ? { body: draft.body } : {}),
          },
        };
        if (draft.type === 'UPDATE_FIELDS') return {
          actionId, type: draft.type, updates: [{
            fieldId: draft.updateFieldId, mode: draft.updateMode,
            ...(draft.updateMode === 'copy' ? { sourceFieldId: draft.updateSourceFieldId } : {}),
            ...(draft.updateMode === 'set' || draft.updateMode === 'increment' || draft.updateMode === 'decrement' ? { value: draft.updateValue } : {}),
          }],
        };
        if (draft.type === 'CREATE_RECORD') return {
          actionId, type: draft.type, targetAppId: draft.targetAppId, mappings: [{
            targetFieldId: draft.mapTargetFieldId, mode: draft.mapMode,
            ...(draft.mapMode === 'source' ? { sourceFieldId: draft.mapSourceFieldId } : { value: draft.mapValue }),
          }],
        };
        if (draft.type === 'ADVANCE_WORKFLOW') return { actionId, type: draft.type, workflowActionId: draft.workflowActionId };
        return { actionId, type: draft.type, webhook: { endpointId: draft.endpointId } };
      }),
    };
  }

  function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const saved = await api<{ rule: RuleRow; version: { version: number } }>(path + '/rules', token,
        json('POST', { name, config: buildConfig() }));
      setSelectedRuleId(saved.rule.id);
      setSelectedVersion(String(saved.version.version));
      // Pre-fill the grant form from the actions just configured: the
      // administrator confirms this generated summary instead of writing
      // any permission configuration by hand.
      const config = buildConfig();
      const readableIds = new Set<string>();
      if (triggerFieldId) readableIds.add(triggerFieldId);
      if (condFieldId) readableIds.add(condFieldId);
      for (const a of actions) {
        if (a.type === 'NOTIFY' && a.recipientFieldId) readableIds.add(a.recipientFieldId);
        if (a.type === 'UPDATE_FIELDS' && a.updateSourceFieldId) readableIds.add(a.updateSourceFieldId);
        if (a.type === 'CREATE_RECORD' && a.mapSourceFieldId) readableIds.add(a.mapSourceFieldId);
      }
      setReadable([...readableIds]);
      setWritable(actions.filter((a) => a.type === 'UPDATE_FIELDS').map((a) => a.updateFieldId).filter(Boolean));
      setGrantTargets(actions.filter((a) => a.type === 'CREATE_RECORD').map((a) => a.targetAppId).filter(Boolean));
      setGrantOps([...new Set(config.actions.map((a) => a.type))]);
      await loadRules();
      setNotice(`Draft rule "${name}" saved as version ${saved.version.version}. Confirm the permission summary below, then preflight, dry-run and publish.`);
    });
  }

  const selectedRule = rules.find((rule) => rule.id === selectedRuleId);
  const grantSummary = selectedRule
    ? `This rule may read ${readable.length} field(s) of this app, write ${writable.length} field(s)` +
      `${grantTargets.length ? `, create records in ${grantTargets.length} linked app(s)` : ''}, ` +
      `using operations: ${grantOps.join(', ') || 'none'}. It can never change permissions, users or keys, and it cannot approve anything in place of a person.`
    : '';

  function approveGrant() {
    void run(async () => {
      await api(path + `/rules/${selectedRuleId}/grants`, token, json('POST', {
        version: Number(selectedVersion), sourceAppId: app.id,
        readableFieldIds: readable, targetAppIds: grantTargets, writableFieldIds: writable,
        allowedOperations: grantOps,
      }));
      setNotice('Permission grant approved for version ' + selectedVersion + '. Run preflight next.');
    });
  }
  function doPreflight() {
    void run(async () => {
      const result = await api<Preflight>(path + `/rules/${selectedRuleId}/preflight`, token,
        json('POST', { version: Number(selectedVersion) }));
      setPreflight(result);
      setNotice(result.publishable ? 'Preflight passed: the rule can be published.' : 'Preflight found blocking problems — see the findings below.');
    });
  }
  function doDryRun() {
    void run(async () => {
      const result = await api<unknown>(path + `/rules/${selectedRuleId}/dry-run`, token,
        json('POST', { version: Number(selectedVersion), recordId: dryRunRecordId.trim() }));
      setDryRunResult(result);
      setNotice('Dry run finished. Nothing was written, notified or sent.');
    });
  }
  function doPublish() {
    void run(async () => {
      await api(path + `/rules/${selectedRuleId}/publish`, token, json('POST', { version: Number(selectedVersion) }));
      await loadRules();
      setNotice('Version ' + selectedVersion + ' published. Enable the rule to start it.');
    });
  }
  function doEnable(enabled: boolean) {
    void run(async () => {
      await api(path + `/rules/${selectedRuleId}/enable`, token, json('POST', { enabled }));
      await loadRules();
      setNotice(enabled ? 'Rule enabled.' : 'Rule disabled.');
    });
  }

  const fieldOptions = (list: { fieldId: string; name: string }[]) =>
    list.map((f) => <option key={f.fieldId} value={f.fieldId}>{f.name}</option>);
  const toggle = (list: string[], set: (v: string[]) => void, value: string, checked: boolean) =>
    set(checked ? [...list, value] : list.filter((v) => v !== value));

  return <section className="stack" aria-label="Automation rule management">
    <h3>Rule management</h3>
    <p className="muted">Build a rule with forms only — no code, JSON or SQL. In-app notifications are not email, SMS or push notifications.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}

    <form className="stack" onSubmit={createRule}>
      <h4>1. New rule — trigger → condition → actions</h4>
      <label>Name <input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Trigger <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)}>
        <option value="record.created">Record created</option>
        <option value="record.updated">Record updated (field changes)</option>
        <option value="record.deleted">Record deleted</option>
        <option value="workflow.transitioned">Workflow moves to a state</option>
        <option value="workflow.rejected">Workflow is sent back</option>
        <option value="schedule.fixed">Fixed schedule</option>
        <option value="schedule.dateRelative">Days before/after a date field</option>
      </select></label>
      {(triggerType === 'record.updated' || triggerType === 'schedule.dateRelative') &&
        <label>Field <select value={triggerFieldId} onChange={(e) => setTriggerFieldId(e.target.value)} required>
          <option value="">Select a field</option>{fieldOptions(fields)}
        </select></label>}
      {triggerType === 'record.updated' &&
        <label>New value <input value={triggerNewValue} onChange={(e) => setTriggerNewValue(e.target.value)} /></label>}
      {triggerType.startsWith('workflow.') &&
        <label>Target state <select value={toStateId} onChange={(e) => setToStateId(e.target.value)} required>
          <option value="">Select a state</option>
          {(workflow?.states ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>}
      {triggerType === 'schedule.fixed' && <>
        <label>Cadence <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option>
        </select></label>
        {cadence === 'weekly' && <label>Weekday <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d]}</option>)}
        </select></label>}
        {cadence === 'monthly' && <label>Day of month <input type="number" min="1" max="31" value={monthDay} onChange={(e) => setMonthDay(e.target.value)} /></label>}
        <label>Missed runs <select value={missedRunPolicy} onChange={(e) => setMissedRunPolicy(e.target.value)}>
          <option value="">Skip missed periods (default)</option>
          <option value="catch_up_latest">Run the latest missed period once</option>
        </select></label>
      </>}
      {triggerType === 'schedule.dateRelative' &&
        <label>Offset days (negative = before) <input type="number" value={offsetDays} onChange={(e) => setOffsetDays(e.target.value)} /></label>}
      {(triggerType === 'schedule.fixed' || triggerType === 'schedule.dateRelative') && <>
        <label>Local time <input type="time" value={localTime} onChange={(e) => setLocalTime(e.target.value)} /></label>
        <label>Timezone <input value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label>
      </>}
      <label className="option"><input type="checkbox" checked={allowManual} onChange={(e) => setAllowManual(e.target.checked)} /> Allow manual runs</label>

      <fieldset className="stack"><legend>Condition (optional)</legend>
        <label>Field <select value={condFieldId} onChange={(e) => setCondFieldId(e.target.value)}>
          <option value="">No condition</option>{fieldOptions(fields)}
        </select></label>
        {condFieldId && <>
          <label>Operator <select value={condOperator} onChange={(e) => setCondOperator(e.target.value)}>
            {operators.map((op) => <option key={op} value={op}>{op}</option>)}
          </select></label>
          <label>Value <input value={condValue} onChange={(e) => setCondValue(e.target.value)} /></label>
        </>}
      </fieldset>

      <fieldset className="stack"><legend>Actions (run in order)</legend>
        {actions.map((draft, index) => <div key={draft.key} className="stack">
          <label>Action {index + 1} <select value={draft.type} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, type: e.target.value as ActionType } : a))}>
            {actionTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
          {draft.type === 'NOTIFY' && <>
            <label>Recipient user field <select value={draft.recipientFieldId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, recipientFieldId: e.target.value } : a))}>
              <option value="">— or type user IDs below —</option>{fieldOptions(fields.filter((f) => f.type === 'user'))}
            </select></label>
            <label>Recipient user IDs (comma separated) <input value={draft.recipientUserIds} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, recipientUserIds: e.target.value } : a))} /></label>
            <label>Title <input value={draft.title} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, title: e.target.value } : a))} /></label>
            <label>Body <input value={draft.body} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, body: e.target.value } : a))} /></label>
          </>}
          {draft.type === 'UPDATE_FIELDS' && <>
            <label>Field <select value={draft.updateFieldId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, updateFieldId: e.target.value } : a))}>
              <option value="">Select a field</option>{fieldOptions(fields)}
            </select></label>
            <label>Mode <select value={draft.updateMode} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, updateMode: e.target.value } : a))}>
              <option value="set">Set value</option><option value="increment">Add number</option>
              <option value="decrement">Subtract number</option><option value="clear">Clear</option><option value="copy">Copy from field</option>
            </select></label>
            {draft.updateMode === 'copy'
              ? <label>Source field <select value={draft.updateSourceFieldId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, updateSourceFieldId: e.target.value } : a))}>
                  <option value="">Select a field</option>{fieldOptions(fields)}
                </select></label>
              : draft.updateMode !== 'clear' && <label>Value <input value={draft.updateValue} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, updateValue: e.target.value } : a))} /></label>}
          </>}
          {draft.type === 'CREATE_RECORD' && <>
            <label>Target app <select value={draft.targetAppId} onChange={(e) => { const v = e.target.value; setActions(actions.map((a) => a.key === draft.key ? { ...a, targetAppId: v } : a)); void loadTargetFields(v); }}>
              <option value="">Select an app</option>{apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
            <label>Target field <select value={draft.mapTargetFieldId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, mapTargetFieldId: e.target.value } : a))}>
              <option value="">Select a field</option>{fieldOptions(targetFields[draft.targetAppId] ?? [])}
            </select></label>
            <label>Value from <select value={draft.mapMode} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, mapMode: e.target.value } : a))}>
              <option value="source">Source record field</option><option value="constant">Fixed value</option>
            </select></label>
            {draft.mapMode === 'source'
              ? <label>Source field <select value={draft.mapSourceFieldId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, mapSourceFieldId: e.target.value } : a))}>
                  <option value="">Select a field</option>{fieldOptions(fields)}
                </select></label>
              : <label>Fixed value <input value={draft.mapValue} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, mapValue: e.target.value } : a))} /></label>}
          </>}
          {draft.type === 'ADVANCE_WORKFLOW' &&
            <label>Workflow action <select value={draft.workflowActionId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, workflowActionId: e.target.value } : a))}>
              <option value="">Select an action</option>
              {(workflow?.actions ?? []).map((a) => <option key={a.id} value={a.id} disabled={!a.automationAllowed}>{a.name}{a.automationAllowed ? '' : ' (not allowed for automation)'}</option>)}
            </select></label>}
          {draft.type === 'WEBHOOK' &&
            <label>Endpoint <select value={draft.endpointId} onChange={(e) => setActions(actions.map((a) => a.key === draft.key ? { ...a, endpointId: e.target.value } : a))}>
              <option value="">Select an endpoint</option>{endpoints.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.url}</option>)}
            </select></label>}
          {actions.length > 1 && <button type="button" disabled={busy} onClick={() => setActions(actions.filter((a) => a.key !== draft.key))}>Remove action</button>}
        </div>)}
        <button type="button" disabled={busy} onClick={() => setActions([...actions, newAction(actionKey++)])}>Add action</button>
      </fieldset>
      <div className="inline"><button type="submit" className="primary" disabled={busy || !name}>Save draft rule</button></div>
    </form>

    <h4>2. Authorize → preflight → dry-run → publish → enable</h4>
    <label>Rule <select value={selectedRuleId} onChange={(e) => { setSelectedRuleId(e.target.value); const r = rules.find((x) => x.id === e.target.value); if (r?.currentVersion) setSelectedVersion(String(r.currentVersion)); }}>
      <option value="">Select a rule</option>
      {rules.filter((r) => !r.archivedAt).map((r) => <option key={r.id} value={r.id}>{r.name} (v{r.currentVersion ?? '—'}, {r.enabled ? 'enabled' : 'disabled'})</option>)}
    </select></label>
    <label>Version <input type="number" min="1" value={selectedVersion} onChange={(e) => setSelectedVersion(e.target.value)} /></label>
    {selectedRule && <>
      <fieldset className="stack"><legend>Permission summary — confirm to approve</legend>
        <p>{grantSummary}</p>
        <p className="muted">Readable fields</p>
        {fields.map((f) => <label key={f.fieldId} className="option"><input type="checkbox" checked={readable.includes(f.fieldId)} onChange={(e) => toggle(readable, setReadable, f.fieldId, e.target.checked)} /> {f.name}</label>)}
        <p className="muted">Writable fields (this app)</p>
        {fields.map((f) => <label key={f.fieldId} className="option"><input type="checkbox" checked={writable.includes(f.fieldId)} onChange={(e) => toggle(writable, setWritable, f.fieldId, e.target.checked)} /> {f.name}</label>)}
        <p className="muted">Linked apps it may create records in</p>
        {apps.filter((a) => a.id !== app.id).map((a) => <label key={a.id} className="option"><input type="checkbox" checked={grantTargets.includes(a.id)} onChange={(e) => toggle(grantTargets, setGrantTargets, a.id, e.target.checked)} /> {a.name}</label>)}
        <p className="muted">Allowed operations</p>
        {actionTypes.map((t) => <label key={t} className="option"><input type="checkbox" checked={grantOps.includes(t)} onChange={(e) => toggle(grantOps, setGrantOps, t, e.target.checked)} /> {t}</label>)}
        <div className="inline"><button type="button" className="primary" disabled={busy} onClick={approveGrant}>Approve this permission grant</button></div>
      </fieldset>
      <div className="inline">
        <button type="button" disabled={busy} onClick={doPreflight}>Run preflight</button>
        <button type="button" disabled={busy} onClick={doPublish}>Publish version</button>
        <button type="button" disabled={busy} onClick={() => doEnable(!selectedRule.enabled)}>{selectedRule.enabled ? 'Disable rule' : 'Enable rule'}</button>
      </div>
      {preflight && <div>
        <p>{preflight.publishable ? 'Publishable.' : 'Not publishable yet.'}</p>
        <ul>{preflight.findings.map((f, i) => <li key={i}>{f.severity}: {f.code}{f.message ? ' — ' + f.message : ''}</li>)}</ul>
      </div>}
      <div className="inline">
        <label>Record ID for dry run <input value={dryRunRecordId} onChange={(e) => setDryRunRecordId(e.target.value)} /></label>
        <button type="button" disabled={busy || !dryRunRecordId.trim()} onClick={doDryRun}>Dry run (writes nothing)</button>
      </div>
      {dryRunResult !== undefined && <details open><summary>Dry-run result</summary><pre>{JSON.stringify(dryRunResult, null, 2)}</pre></details>}
      <p className="muted">Run results, failure reasons and the allowed recovery (retry failed actions) are in the run history below.</p>
    </>}
  </section>;
}
