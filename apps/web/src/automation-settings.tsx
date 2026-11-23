import { useEffect, useState, type FormEvent } from 'react';
import { api, appPath, json, message, type App } from './api';

type SummaryRule = {
  ruleId: string; name: string; enabled: boolean;
  succeeded: number; failed: number; skipped: number;
  lastStatus: string | null; lastRunAt: string | null; lastError: string | null;
};
type Summary = { rules: SummaryRule[]; backlog: number; unprocessedEvents: number };
type Run = {
  id: string; ruleId: string; ruleVersion: number; recordId: string; eventId: string | null;
  triggerIdentity: string; status: string; lastError: string | null; attemptCount: number;
  startedAt: string; completedAt: string | null;
};
type RunAction = {
  actionId: string; position: number; status: string; errorCode: string | null;
  resultRef: string | null; attemptCount: number; completedAt: string | null;
};
type RunDetail = { run: Run; actions: RunAction[] };
type ManualResult = { run: Run; actions: RunAction[]; deduplicated: boolean };
type ProblemChain = {
  rootCausationId: string; reason: string; lastRunId: string | null; pausedAt: string | null;
};
type WebhookEndpoint = {
  id: string; name: string; url: string; policy: string; keyVersion: number;
  previousKeyVersion: number | null; rotatedAt: string | null; secretSet: boolean;
  validated: boolean; validatedAt: string | null;
};
type WebhookDelivery = {
  id: string; deliveryId: string; runId: string; actionId: string;
  endpointId: string | null; endpointUrl: string | null; policy: string | null;
  status: string; attempts: number; nextAttemptAt: string | null;
  responseStatus: number | null; errorType: string | null; keyVersion: number | null;
  createdAt: string; updatedAt: string;
};
type WebhookAttempt = {
  id: string; deliveryRowId: string; attemptNumber: number; keyVersion: number | null;
  outcome: string; httpStatus: number | null; errorType: string | null; startedAt: string;
};

const AUTO_POLICY_RISK = 'AUTO_RETRY_AT_LEAST_ONCE: delivery is retried automatically (up to 6 attempts in total). ' +
  'This can deliver the same event more than once — 可能重复投递、接收方应按投递 ID 去重。';
const MANUAL_POLICY_RISK = 'MANUAL_ON_UNCERTAIN: nothing is retried automatically. ' +
  '外部系统可能已经处理本次请求，重新发送可能造成重复业务操作。';

// P3-C C-2: only statuses a run can actually carry. RATE_LIMITED and
// BACKLOG_LIMITED are audit signals, never run statuses; the legacy P3-A
// ACTIONS_NOT_IMPLEMENTED state was removed by migration 0044.
const runStatuses = [
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED_CONDITION', 'SKIPPED_STALE',
  'SKIPPED_UNAUTHORIZED', 'BLOCKED_CYCLE', 'CHAIN_DEPTH_EXCEEDED', 'CHAIN_PAUSED',
] as const;

const formatTime = (value: string | null) => value ?? '—';

export function AutomationSettings({ app, token }: { app: App; token: string }) {
  const path = appPath(app.id) + '/automation';
  const [summary, setSummary] = useState<Summary>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [ruleFilter, setRuleFilter] = useState('');
  const [detail, setDetail] = useState<RunDetail>();
  const [chains, setChains] = useState<ProblemChain[]>([]);
  const [manualRuleId, setManualRuleId] = useState('');
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [attempts, setAttempts] = useState<WebhookAttempt[]>([]);
  const [rotateSecret, setRotateSecret] = useState('');
  const [manualResult, setManualResult] = useState<ManualResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadSummary() {
    setSummary(await api<Summary>(path + '/summary', token));
  }
  async function loadRuns(status = statusFilter, ruleId = ruleFilter) {
    const query = new URLSearchParams({ limit: '50' });
    if (status) query.set('status', status);
    if (ruleId) query.set('ruleId', ruleId);
    const result = await api<{ items: Run[]; total: number }>(path + '/runs?' + query.toString(), token);
    setRuns(result.items);
    setTotal(result.total);
  }
  async function loadChains() {
    setChains(await api<ProblemChain[]>(path + '/problem-chains', token));
  }
  async function loadEndpoints() {
    setEndpoints(await api<WebhookEndpoint[]>(path + '/webhook-endpoints', token));
  }
  async function loadDeliveries() {
    const result = await api<{ items: WebhookDelivery[]; attempts: WebhookAttempt[]; total: number }>(
      path + '/webhook-deliveries?limit=50', token);
    setDeliveries(result.items);
    setAttempts(result.attempts);
  }
  async function loadDetail(runId: string) {
    setDetail(await api<RunDetail>(path + '/runs/' + runId, token));
  }

  useEffect(() => {
    const abort = new AbortController();
    const request = { signal: abort.signal };
    void api<Summary>(path + '/summary', token, request).then(setSummary)
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    void api<{ items: Run[]; total: number }>(path + '/runs?limit=50', token, request).then((result) => {
      setRuns(result.items); setTotal(result.total);
    }).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    void api<ProblemChain[]>(path + '/problem-chains', token, request).then(setChains)
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    void api<WebhookEndpoint[]>(path + '/webhook-endpoints', token, request).then(setEndpoints)
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    void api<{ items: WebhookDelivery[]; attempts: WebhookAttempt[]; total: number }>(
      path + '/webhook-deliveries?limit=50', token, request).then((result) => {
      setDeliveries(result.items); setAttempts(result.attempts);
    }).catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [path, token]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await operation(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }

  function changeStatus(status: string) {
    setStatusFilter(status);
    void run(async () => { await loadRuns(status, ruleFilter); });
  }
  function changeRule(ruleId: string) {
    setRuleFilter(ruleId);
    void run(async () => { await loadRuns(statusFilter, ruleId); });
  }

  function retry(runId: string) {
    void run(async () => {
      await api(path + '/runs/' + runId + '/retry', token, json('POST'));
      await loadDetail(runId);
      await loadRuns();
      await loadSummary();
      setNotice('Failed actions retried.');
    });
  }

  function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ruleId = String(data.get('ruleId') ?? '');
    const recordId = String(data.get('recordId') ?? '').trim();
    const idempotencyKey = String(data.get('idempotencyKey') ?? '').trim();
    setManualResult(undefined);
    void run(async () => {
      const result = await api<ManualResult>(path + '/rules/' + ruleId + '/manual-runs', token, json('POST', {
        recordId, ...(idempotencyKey && { idempotencyKey }),
      }));
      setManualResult(result);
      setDetail({ run: result.run, actions: result.actions });
      await loadRuns();
      await loadSummary();
      setNotice(result.deduplicated && result.run.status === 'FAILED'
        ? 'An existing run was returned for this idempotency key, and that run FAILED. It was not executed again — use “Retry failed actions” on the run to retry it.'
        : result.deduplicated
          ? 'An existing run was returned for this idempotency key; no new run was started.'
          : 'Manual run finished with status ' + result.run.status + '.');
    });
  }

  function createEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void run(async () => {
      await api(path + '/webhook-endpoints', token, json('POST', {
        name: String(data.get('name') ?? ''), url: String(data.get('url') ?? ''),
        policy: String(data.get('policy') ?? 'AUTO_RETRY_AT_LEAST_ONCE'),
        secret: String(data.get('secret') ?? ''),
      }));
      await loadEndpoints();
      setNotice('Webhook endpoint saved and validated.');
    });
  }

  function validateEndpoint(endpoint: WebhookEndpoint) {
    void run(async () => {
      await api(path + '/webhook-endpoints/' + endpoint.id + '/validate', token, json('POST'));
      await loadEndpoints();
      setNotice('Endpoint re-validated: ' + endpoint.url);
    });
  }

  function rotateEndpoint(endpoint: WebhookEndpoint) {
    if (!rotateSecret) { setError('Enter the new signing secret before rotating.'); return; }
    void run(async () => {
      await api(path + '/webhook-endpoints/' + endpoint.id + '/rotate-secret', token,
        json('POST', { secret: String(data.get('secret') ?? ''), }));
      setRotateSecret('');
      await loadEndpoints();
      setNotice('Signing secret rotated. New attempts sign with the new key version; ' +
        'the previous key stays available to receivers for in-flight deliveries.');
    });
  }

  function resendDelivery(delivery: WebhookDelivery) {
    const confirmed = window.confirm(
      '外部系统可能已经处理本次请求，重新发送可能造成重复业务操作。\n\nResend delivery ' +
      delivery.deliveryId + ' as a new attempt on the same delivery?');
    if (!confirmed) return;
    void run(async () => {
      await api(path + '/webhook-deliveries/' + delivery.id + '/resend', token, json('POST'));
      await loadDeliveries();
      setNotice('Delivery queued for resend under the same delivery ID.');
    });
  }

  function resume(chain: ProblemChain) {
    void run(async () => {
      await api(path + '/problem-chains/' + chain.rootCausationId + '/resume', token, json('POST'));
      await loadChains();
      setNotice('Problem chain resumed.');
    });
  }

  const ruleName = (ruleId: string) => summary?.rules.find((rule) => rule.ruleId === ruleId)?.name ?? ruleId;

  return <section className="stack" aria-label="Automation settings">
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <p>Actions run in order. If an action fails, the actions before it are not rolled back — retrying a failed run re-runs only the actions that did not succeed.</p>

    <h3>Overview</h3>
    {summary && <>
      <p className="muted">Backlog · {summary.backlog} · Unprocessed events · {summary.unprocessedEvents}</p>
      <div className="automation-scroll"><table>
        <thead><tr><th>Rule</th><th>Enabled</th><th>Succeeded</th><th>Failed</th><th>Skipped</th>
          <th>Last status</th><th>Last run</th><th>Last error</th></tr></thead>
        <tbody>{summary.rules.map((rule) => <tr key={rule.ruleId}>
          <td>{rule.name}</td><td>{rule.enabled ? 'Yes' : 'No'}</td><td>{rule.succeeded}</td>
          <td>{rule.failed}</td><td>{rule.skipped}</td><td>{rule.lastStatus ?? '—'}</td>
          <td>{formatTime(rule.lastRunAt)}</td><td>{rule.lastError ?? '—'}</td>
        </tr>)}</tbody>
      </table></div>
      {!summary.rules.length && <p className="muted">No automation rules yet.</p>}
    </>}

    <h3>Run history</h3>
    <div className="inline">
      <label>Status <select value={statusFilter} onChange={(event) => changeStatus(event.target.value)}>
        <option value="">All statuses</option>
        {runStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
      </select></label>
      <label>Rule <select value={ruleFilter} onChange={(event) => changeRule(event.target.value)}>
        <option value="">All rules</option>
        {(summary?.rules ?? []).map((rule) => <option key={rule.ruleId} value={rule.ruleId}>{rule.name}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => void run(async () => { await loadRuns(); })}>Refresh runs</button>
    </div>
    <p className="muted">{total} run{total === 1 ? '' : 's'} in total · showing {runs.length}</p>
    <div className="automation-scroll"><table>
      <thead><tr><th>Started</th><th>Rule</th><th>Version</th><th>Record</th><th>Event</th><th>Trigger</th>
        <th>Status</th><th>Attempts</th><th>Completed</th><th>Last error</th><th></th></tr></thead>
      <tbody>{runs.map((item) => <tr key={item.id}>
        <td>{formatTime(item.startedAt)}</td><td>{ruleName(item.ruleId)}</td><td>{item.ruleVersion}</td>
        <td>{item.recordId}</td><td>{item.eventId ?? '—'}</td><td>{item.triggerIdentity}</td>
        <td>{item.status}</td><td>{item.attemptCount}</td><td>{formatTime(item.completedAt)}</td>
        <td>{item.lastError ?? '—'}</td>
        <td><button type="button" disabled={busy} onClick={() => void run(async () => { await loadDetail(item.id); })}>View run</button></td>
      </tr>)}</tbody>
    </table></div>
    {!runs.length && <p className="muted">No runs match these filters.</p>}

    {detail && <div className="stack">
      <h4>Run {detail.run.id}</h4>
      <p className="muted">{ruleName(detail.run.ruleId)} · version {detail.run.ruleVersion} · {detail.run.status}
        {detail.run.lastError && <> · {detail.run.lastError}</>}</p>
      {detail.run.status === 'FAILED' && <div className="inline">
        <button type="button" disabled={busy} onClick={() => retry(detail.run.id)}>Retry failed actions</button>
      </div>}
      <div className="automation-scroll"><table>
        <thead><tr><th>#</th><th>Action</th><th>Status</th><th>Error code</th><th>Result reference</th>
          <th>Attempts</th><th>Completed</th></tr></thead>
        <tbody>{detail.actions.map((action) => <tr key={action.actionId}>
          <td>{action.position + 1}</td><td>{action.actionId}</td><td>{action.status}</td>
          <td>{action.errorCode ?? '—'}</td><td>{action.resultRef ?? '—'}</td>
          <td>{action.attemptCount}</td><td>{formatTime(action.completedAt)}</td>
        </tr>)}</tbody>
      </table></div>
      {!detail.actions.length && <p className="muted">This run has no recorded actions.</p>}
      <div className="inline"><button type="button" onClick={() => setDetail(undefined)}>Close run</button></div>
    </div>}

    <h3>Manual run</h3>
    <p className="muted">Manual runs are only accepted when the rule’s trigger allows them.</p>
    <form className="stack" onSubmit={manual}>
      <label>Rule <select name="ruleId" required value={manualRuleId} onChange={(event) => setManualRuleId(event.target.value)}>
        <option value="">Select a rule</option>
        {(summary?.rules ?? []).map((rule) => <option key={rule.ruleId} value={rule.ruleId}>{rule.name}</option>)}
      </select></label>
      <label>Record ID <input name="recordId" required /></label>
      <label>Idempotency key (optional) <input name="idempotencyKey" maxLength={120} /></label>
      <div className="inline"><button type="submit" className="primary" disabled={busy || !manualRuleId}>Start manual run</button></div>
    </form>
    {manualResult && <p role="status">Run status · {manualResult.run.status}
      {manualResult.deduplicated ? ' · Deduplicated: an existing run was returned.' : ' · New run.'}</p>}
    {manualResult?.deduplicated && manualResult.run.status === 'FAILED' && <div className="stack">
      <p role="alert">This existing run failed and was not executed again. Retry it instead of triggering a new manual run.</p>
      <div className="inline"><button type="button" disabled={busy}
        onClick={() => retry(manualResult.run.id)}>Retry failed actions</button></div>
    </div>}

    <h3>Webhook endpoints</h3>
    <p className="muted">{AUTO_POLICY_RISK}</p>
    <p className="muted">{MANUAL_POLICY_RISK}</p>
    <form className="stack" onSubmit={createEndpoint}>
      <label>Name <input name="name" required maxLength={120} /></label>
      <label>URL (HTTPS only) <input name="url" required maxLength={2000} placeholder="https://example.com/webhook" /></label>
      <label>Retry policy <select name="policy" defaultValue="AUTO_RETRY_AT_LEAST_ONCE">
        <option value="AUTO_RETRY_AT_LEAST_ONCE">AUTO_RETRY_AT_LEAST_ONCE — automatic retries, at-least-once</option>
        <option value="MANUAL_ON_UNCERTAIN">MANUAL_ON_UNCERTAIN — no automatic retry, manual resend only</option>
      </select></label>
      <label>Signing secret <input name="secret" required minLength={8} maxLength={500} type="password" autoComplete="new-password" /></label>
      <div className="inline"><button type="submit" className="primary" disabled={busy}>Save endpoint</button></div>
    </form>
    <div className="automation-scroll"><table>
      <thead><tr><th>Name</th><th>URL</th><th>Policy</th><th>Key version</th><th>Validated</th><th></th></tr></thead>
      <tbody>{endpoints.map((endpoint) => <tr key={endpoint.id}>
        <td>{endpoint.name}</td><td>{endpoint.url}</td><td>{endpoint.policy}</td>
        <td>{endpoint.keyVersion}{endpoint.previousKeyVersion ? ' (previous ' + endpoint.previousKeyVersion + ')' : ''}</td>
        <td>{endpoint.validated ? 'Yes' : 'No — re-validation required before delivery'}</td>
        <td><div className="inline">
          <button type="button" disabled={busy} onClick={() => validateEndpoint(endpoint)}>Validate</button>
          <button type="button" disabled={busy} onClick={() => rotateEndpoint(endpoint)}>Rotate secret</button>
        </div></td>
      </tr>)}</tbody>
    </table></div>
    {!endpoints.length && <p className="muted">No webhook endpoints yet.</p>}
    <label>New secret for rotation <input type="password" autoComplete="new-password" minLength={8} maxLength={500}
      value={rotateSecret} onChange={(event) => setRotateSecret(event.target.value)} /></label>
    <p className="muted">Changing an endpoint URL in the API clears its validation; deliveries pause until you validate it again.</p>

    <h3>Webhook deliveries</h3>
    <div className="inline">
      <button type="button" disabled={busy} onClick={() => void run(loadDeliveries)}>Refresh deliveries</button>
    </div>
    <div className="automation-scroll"><table>
      <thead><tr><th>Created</th><th>Delivery ID</th><th>Endpoint</th><th>Policy</th><th>Status</th>
        <th>Attempts</th><th>HTTP</th><th>Last error</th><th>Next attempt</th><th></th></tr></thead>
      <tbody>{deliveries.map((delivery) => <tr key={delivery.id}>
        <td>{formatTime(delivery.createdAt)}</td><td>{delivery.deliveryId}</td>
        <td>{delivery.endpointUrl ?? '—'}</td><td>{delivery.policy ?? '—'}</td><td>{delivery.status}</td>
        <td>{delivery.attempts}</td><td>{delivery.responseStatus ?? '—'}</td>
        <td>{delivery.errorType ?? '—'}</td><td>{formatTime(delivery.nextAttemptAt)}</td>
        <td>{delivery.status === 'MANUAL_REVIEW_REQUIRED' &&
          <button type="button" disabled={busy} onClick={() => resendDelivery(delivery)}>Resend manually</button>}</td>
      </tr>)}</tbody>
    </table></div>
    {!deliveries.length && <p className="muted">No webhook deliveries yet.</p>}
    {attempts.length > 0 && <div className="automation-scroll"><table>
      <thead><tr><th>Delivery</th><th>Attempt</th><th>Key version</th><th>Outcome</th><th>HTTP</th><th>Error</th><th>Started</th></tr></thead>
      <tbody>{attempts.map((attempt) => <tr key={attempt.id}>
        <td>{deliveries.find((d) => d.id === attempt.deliveryRowId)?.deliveryId ?? attempt.deliveryRowId}</td>
        <td>{attempt.attemptNumber}</td><td>{attempt.keyVersion ?? '—'}</td><td>{attempt.outcome}</td>
        <td>{attempt.httpStatus ?? '—'}</td><td>{attempt.errorType ?? '—'}</td><td>{formatTime(attempt.startedAt)}</td>
      </tr>)}</tbody>
    </table></div>}

    <h3>Problem chains</h3>
    <p className="muted">Resuming a chain does not replay anything: events that arrived while the chain was paused were discarded and will not be re-run.</p>
    {!chains.length && <p className="muted">No paused problem chains.</p>}
    <ul className="plain">{chains.map((chain) => <li className="inline" key={chain.rootCausationId}>
      <span>{chain.reason} <span className="muted">· root {chain.rootCausationId}
        {chain.lastRunId && <> · last run {chain.lastRunId}</>}
        {chain.pausedAt && <> · paused {chain.pausedAt}</>}</span></span>
      <button type="button" disabled={busy} onClick={() => resume(chain)}>Resume</button>
    </li>)}</ul>
  </section>;
}
