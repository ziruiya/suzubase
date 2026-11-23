import { useEffect, useState } from 'react';
import { api, appPath, download, json, message, response, type App, type Session } from './api';

// Gate 3 import wizard (G3-08) + migration-package export panel and the
// pending API-token re-issuance list (decision 6). The wizard administers
// import jobs over the session channel; every system-field write goes through
// the migration channel with the one-time migration token (decision 7).

type Counts = Record<string, number>;
type ManualAction = {
  kind: string; name?: string; url?: string; action?: string; note?: string;
  sourceRuleId?: string; version?: number | string;
};
type MigrationJob = {
  id: string; status: string; stage: string; completion: 'complete' | 'pending' | null;
  sourceAppCode: string | null; sourceExportId: string | null; targetAppId: string | null;
  duplicateOf: string | null; duplicateConfirmed: boolean;
  userMapping: Record<string, string>; groupMapping: Record<string, string>;
  organizationMapping: Record<string, string>;
  pending: {
    assignees?: { recordId: string; sourceUserId: string; sourceRecordNo: string | null }[];
    dependencies?: { sourceFieldId: string; kind: string; sourceAppCode: string | null;
      foreignFieldIds?: string[] }[];
    references?: { recordId: string; sourceFieldId: string }[];
    unmappedUsers?: { id: string; name: string | null; email: string | null }[];
    unmappedGroups?: { id: string; name: string | null }[];
    droppedAcl?: { layer: string; action: string; subjectKind: string; sourceSubjectId: string }[];
    automation?: {
      manualActions?: ManualAction[];
      credentialsPending?: unknown[];
      grantRequirements?: unknown[];
      unresolved?: unknown[];
    } | null;
    cleanup?: unknown;
  };
  report: {
    counts: { source: Counts; target: Counts; matches: Record<string, boolean> };
    dependencies: { relations: unknown[]; userMapping: { mapped: number; unmapped: string[] };
      groupMapping: { mapped: number; unmapped: string[] } };
    verification: { recordsMatch: boolean; tableRowsMatch: boolean;
      attachments: { checked: number; failed: string[] };
      references: { checked: number; missing: string[] };
      acl: { samples: number; consistent: boolean; mismatches: string[] };
      outboxEventsProduced: number };
    difference: { inherited: string[]; notInherited: { item: string; reason: string }[];
      pendingTokenReissues: { name: string; scope: string; reissuedAt: string | null }[];
      externalSystemsToNotify: string[]; sensitiveDataNotice: string; hashNote: string };
  } | null;
  errorReport: { errors: { object: string; message: string; referrer?: string; missingTarget?: string }[] } | null;
  error: string | null; createdAt: string; sensitiveDataNotice: string;
};
type Suggestion = { sourceId: string; label: string; candidates: { id: string; label: string }[] };
type JobDetail = MigrationJob & {
  suggestions: { users: Suggestion[]; groups: Suggestion[]; organizations: Suggestion[] };
};
type Directory = { members: { id: string; email: string; displayName: string | null; loginName: string }[];
  groups: { id: string; name: string }[]; organizations: { id: string; name: string }[] };
type AppSummary = { id: string; name: string; code: string };

const jobPath = (id: string) => '/imports/' + id;

export function ImportWizard({ session }: { session: Session }) {
  const { token } = session;
  const [jobs, setJobs] = useState<MigrationJob[]>([]);
  const [detail, setDetail] = useState<JobDetail>();
  const [directory, setDirectory] = useState<Directory>();
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [migrationToken, setMigrationToken] = useState('');
  const [issuedToken, setIssuedToken] = useState<{ token: string; expiresAt: string }>();
  const [audit, setAudit] = useState<{ id: string; action: string; objectType: string; createdAt: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setJobs(await api<MigrationJob[]>('/imports', token));
  }
  useEffect(() => {
    void refresh().catch((error) => setError(message(error)));
    void api<Directory>('/tenant/directory', token).then(setDirectory).catch(() => undefined);
    void api<AppSummary[]>('/apps', token).then(setApps).catch(() => undefined);
  }, []);
  async function run(operation: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await operation(); await refresh(); if (detail) await open(detail.id); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    const [job, trail] = await Promise.all([
      api<JobDetail>(jobPath(id), token),
      api<typeof audit>(jobPath(id) + '/audit', token).catch(() => []),
    ]);
    setDetail(job); setAudit(trail); setIssuedToken(undefined);
  }
  async function upload(file: File) {
    const result = await response('/imports/upload', token, {
      method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
    });
    const job = await result.json() as MigrationJob;
    await refresh(); await open(job.id);
  }
  async function channel(jobId: string, suffix: string, body?: unknown) {
    if (!migrationToken) throw new Error('Issue or paste a migration token first.');
    return api<MigrationJob>(jobPath(jobId) + suffix, migrationToken, json('POST', body));
  }

  return <div className="stack">
    <div className="inline spread"><h2>Import migration package</h2></div>
    <p className="muted">Restore an application from a sealed migration package exported by another
      deployment. The package contains complete business data and must be handled as sensitive data.
      Imports always create a new application; nothing is overwritten.</p>
    <p className="muted">Boundary: this migration package is not a disaster backup, and a deployment
      backup is not a migration tool. Use deployment backups for disaster recovery of a whole
      deployment; use this package only to move one application.</p>
    <label>Package file (.zip)
      <input type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void run(() => upload(file));
        event.target.value = '';
      }} /></label>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="stack">
      {jobs.map((job) => <div key={job.id} className="panel inline spread">
        <span><strong>{job.sourceAppCode ?? job.id}</strong> · {job.status} / {job.stage}
          {job.completion && ' · ' + job.completion}</span>
        <button type="button" disabled={busy} onClick={() => void run(() => open(job.id))}>
          {detail?.id === job.id ? 'Refresh' : 'Open'}</button>
      </div>)}
      {!jobs.length && <p className="muted">No import jobs yet.</p>}
    </div>
    {detail && <JobPanel key={detail.id + detail.status + detail.stage} job={detail} apps={apps}
      directory={directory} busy={busy} run={run} open={open} token={token}
      migrationToken={migrationToken} setMigrationToken={setMigrationToken}
      issuedToken={issuedToken} setIssuedToken={setIssuedToken} channel={channel} audit={audit} />}
  </div>;
}

function MappingRows({ title, suggestions, current, members, onChange }: {
  title: string; suggestions: Suggestion[]; current: Record<string, string>;
  members: { id: string; label: string }[];
  onChange: (sourceId: string, targetId: string) => void;
}) {
  if (!suggestions.length) return null;
  return <fieldset className="stack"><legend>{title}</legend>
    {suggestions.map((entry) => <label key={entry.sourceId} className="inline spread">
      <span>{entry.label}</span>
      <select value={current[entry.sourceId] ?? ''} onChange={(event) => onChange(entry.sourceId, event.target.value)}>
        <option value="">Not mapped</option>
        {[...entry.candidates, ...members.filter((member) =>
          !entry.candidates.some((candidate) => candidate.id === member.id))]
          .map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select></label>)}
  </fieldset>;
}

function JobPanel({ job, apps, directory, busy, run, open, token, migrationToken, setMigrationToken,
  issuedToken, setIssuedToken, channel, audit }: {
  job: JobDetail; apps: AppSummary[]; directory?: Directory; busy: boolean;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  open: (id: string) => Promise<void>; token: string;
  migrationToken: string; setMigrationToken: (value: string) => void;
  issuedToken?: { token: string; expiresAt: string };
  setIssuedToken: (value?: { token: string; expiresAt: string }) => void;
  channel: (jobId: string, suffix: string, body?: unknown) => Promise<MigrationJob>;
  audit: { id: string; action: string; objectType: string; createdAt: string }[];
}) {
  const [users, setUsers] = useState(job.userMapping);
  const [groups, setGroups] = useState(job.groupMapping);
  const [organizations, setOrganizations] = useState(job.organizationMapping);
  const members = (directory?.members ?? []).map((member) => ({
    id: member.id, label: (member.displayName || member.loginName || member.email) + ' (' + member.email + ')',
  }));
  const report = job.report;
  const pending = job.pending ?? {};
  return <div className="panel stack">
    <h3>{job.sourceAppCode ?? job.id}</h3>
    <p>Status: {job.status} · Stage: {job.stage} · Completion: {job.completion ?? '—'}</p>
    {job.error && <p role="alert" className="error">{job.error}</p>}
    {job.duplicateOf && !job.duplicateConfirmed && <div className="stack" role="alert">
      <p>This package was already imported by job {job.duplicateOf}. Importing it again creates a
        second copy of the application. This is never done silently.</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        await api(jobPath(job.id) + '/mappings', token, json('PUT', { confirmDuplicate: true }));
      })}>Confirm creating a second copy</button>
    </div>}
    {job.status === 'uploaded' && <button type="button" className="primary" disabled={busy}
      onClick={() => void run(() => api(jobPath(job.id) + '/validate', token, json('POST')))}>
      Run preflight validation</button>}
    {job.errorReport && <div className="stack"><h4>Preflight error report</h4>
      <ul>{job.errorReport.errors.map((entry, index) => <li key={index}>
        {entry.object}: {entry.message}
        {entry.referrer && ' · referrer ' + entry.referrer}
        {entry.missingTarget && ' · missing ' + entry.missingTarget}</li>)}</ul>
      <button type="button" onClick={() => void download(jobPath(job.id) + '/error-report', token,
        'import-error-report.json')}>Download error report</button></div>}
    {(job.status === 'staging' || job.status === 'ready') && <>
      <MappingRows title="User mapping (existing target users only; accounts are never created)"
        suggestions={job.suggestions.users} current={users} members={members}
        onChange={(sourceId, targetId) => setUsers({ ...users, [sourceId]: targetId })} />
      <MappingRows title="Group mapping" suggestions={job.suggestions.groups}
        current={groups} members={(directory?.groups ?? []).map((group) => ({ id: group.id, label: group.name }))}
        onChange={(sourceId, targetId) => setGroups({ ...groups, [sourceId]: targetId })} />
      <MappingRows title="Organization mapping" suggestions={job.suggestions.organizations}
        current={organizations}
        members={(directory?.organizations ?? []).map((org) => ({ id: org.id, label: org.name }))}
        onChange={(sourceId, targetId) => setOrganizations({ ...organizations, [sourceId]: targetId })} />
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        const prune = (map: Record<string, string>) =>
          Object.fromEntries(Object.entries(map).filter(([, value]) => value));
        await api(jobPath(job.id) + '/mappings', token, json('PUT', {
          users: prune(users), groups: prune(groups), organizations: prune(organizations),
        }));
      })}>Save mappings</button>
      <fieldset className="stack"><legend>Migration channel (decision 7)</legend>
        <p className="muted">Restore writes run only over this channel, with a token bound to this
          job and application. It expires at the earlier of 24 hours or the job ending.</p>
        <div className="inline">
          <button type="button" disabled={busy} onClick={() => void run(async () => {
            const issued = await api<{ token: string; expiresAt: string }>(
              jobPath(job.id) + '/migration-token', token, json('POST'));
            setIssuedToken(issued); setMigrationToken(issued.token);
          })}>Issue migration token</button>
          <input aria-label="Migration token" value={migrationToken}
            onChange={(event) => setMigrationToken(event.target.value)} placeholder="sbm1_…" />
        </div>
        {issuedToken && <p role="status">Token (shown once): <code>{issuedToken.token}</code>
          · expires {new Date(issuedToken.expiresAt).toLocaleString()}</p>}
        <div className="inline">
          <button type="button" disabled={busy || !migrationToken}
            onClick={() => void run(() => channel(job.id, '/run'))}>Run restore now</button>
          <button type="button" disabled={busy || !migrationToken}
            onClick={() => void run(() => channel(job.id, '/queue-run'))}>Queue restore on worker</button>
          {job.stage === 'writing' && <button type="button" disabled={busy}
            onClick={() => void run(() => api(jobPath(job.id) + '/resume', token, json('POST')))}>
            Resume after interruption</button>}
        </div>
      </fieldset>
    </>}
    {!!pending.assignees?.length && <fieldset className="stack">
      <legend>Assignees to resolve (never defaulted to the operator)</legend>
      {pending.assignees.map((entry) => <div key={entry.recordId} className="inline spread">
        <span>Record {entry.sourceRecordNo ?? entry.recordId} · source user {entry.sourceUserId}</span>
        <span className="inline">
          <select id={'assignee-' + entry.recordId}>
            {members.map((member) => <option key={member.id} value={member.id}>{member.label}</option>)}
          </select>
          <button type="button" disabled={busy || !migrationToken} onClick={() => void run(() =>
            channel(job.id, '/resolve-assignees', { items: [{
              recordId: entry.recordId, sourceUserId: entry.sourceUserId,
              userId: (document.getElementById('assignee-' + entry.recordId) as HTMLSelectElement).value,
            }] }))}>Reassign</button>
          <button type="button" disabled={busy || !migrationToken} onClick={() => void run(() =>
            channel(job.id, '/resolve-assignees', { items: [{
              recordId: entry.recordId, sourceUserId: entry.sourceUserId, userId: null,
            }] }))}>Accept no assignee</button>
        </span></div>)}
    </fieldset>}
    {!!pending.dependencies?.length && <fieldset className="stack">
      <legend>Cross-application dependencies</legend>
      {pending.dependencies.map((entry) => <DependencyResolver key={entry.sourceFieldId}
        entry={entry} apps={apps} token={token} busy={busy} migrationToken={migrationToken}
        channel={channel} jobId={job.id} run={run} />)}
    </fieldset>}
    {!!pending.droppedAcl?.length && <div className="stack"><h4>Permissions not restored (default-deny)</h4>
      <ul>{pending.droppedAcl.map((entry, index) => <li key={index}>
        {entry.layer} · {entry.action} · {entry.subjectKind} {entry.sourceSubjectId} (unmapped)</li>)}</ul></div>}
    {!!pending.automation?.manualActions?.length && <div className="stack" role="alert">
      <h4>Manual actions required after import ({pending.automation.manualActions.length} outstanding)</h4>
      <p className="error">These manual actions are still outstanding. Imported automation rules stay
        disabled drafts and webhook endpoints cannot deliver until an administrator completes every
        item below in the target environment. Nothing on this list is done automatically.</p>
      <ul>{pending.automation.manualActions.map((entry, index) => <li key={index}>
        {entry.kind === 'webhook-credential'
          ? <>Webhook credential to supply: endpoint &quot;{entry.name}&quot; ({entry.url})
              — supply a signing secret for this endpoint before it can deliver.</>
          : entry.kind === 'grant-reauthorization'
            ? <>Automation grant to re-approve: rule {entry.sourceRuleId} v{entry.version}
                — re-run preflight and re-approve the grant in the target; imported grants never take effect.</>
            : <>{entry.kind}: {entry.name ?? entry.sourceRuleId ?? ''}{entry.note ? ' — ' + entry.note : ''}</>}
      </li>)}</ul>
    </div>}
    {report && <div className="stack"><h4>Restore verification &amp; difference report</h4>
      <table><thead><tr><th>Object</th><th>Source</th><th>Target</th><th>Match</th></tr></thead>
        <tbody>{Object.keys(report.counts.source).map((key) => <tr key={key}>
          <td>{key}</td><td>{report.counts.source[key]}</td><td>{report.counts.target[key] ?? '—'}</td>
          <td>{report.counts.matches[key] ? 'yes' : 'no'}</td></tr>)}</tbody></table>
      <p>Attachments verified: {report.verification.attachments.checked}
        · failed: {report.verification.attachments.failed.length}
        · References checked: {report.verification.references.checked}
        · missing: {report.verification.references.missing.length}
        · ACL samples consistent: {report.verification.acl.consistent ? 'yes' : 'no'}
        · Notification/outbox events produced: {report.verification.outboxEventsProduced}</p>
      <p>{report.difference.hashNote}</p>
      {!!report.difference.notInherited.length && <><h5>Not inherited</h5>
        <ul>{report.difference.notInherited.map((entry, index) => <li key={index}>
          {entry.item}: {entry.reason}</li>)}</ul></>}
      {!!report.difference.pendingTokenReissues.length && <><h5>API tokens to re-issue</h5>
        <ul>{report.difference.pendingTokenReissues.map((entry, index) => <li key={index}>
          {entry.name} ({entry.scope}){entry.reissuedAt ? ' · re-issued' : ''}</li>)}</ul></>}
      {!!report.difference.externalSystemsToNotify.length && <p>
        External systems to notify: {report.difference.externalSystemsToNotify.join(', ')}</p>}
    </div>}
    <div className="inline">
      {(job.status === 'uploaded' || job.status === 'staging' || job.status === 'ready') &&
        <button type="button" className="danger" disabled={busy} onClick={() => void run(() =>
          api(jobPath(job.id) + '/cancel', token, json('POST')))}>Cancel import &amp; purge</button>}
      {job.status === 'ready' && report && (job.completion === 'complete'
        ? <button type="button" className="primary" disabled={busy} onClick={() => void run(() =>
            api(jobPath(job.id) + '/activate', token, json('POST')))}>Activate application</button>
        : <button type="button" className="primary" disabled title="Resolve every pending item first">
            Activate application</button>)}
      {job.status === 'ready' && !report && <p className="muted">
        Activation unlocks only after the verification &amp; difference report exists.</p>}
    </div>
    {!!audit.length && <details><summary>Migration channel audit trail</summary>
      <ul>{audit.map((entry) => <li key={entry.id}>{entry.action} · {entry.objectType} ·{' '}
        {new Date(entry.createdAt).toLocaleString()}</li>)}</ul></details>}
  </div>;
}

function DependencyResolver({ entry, apps, token, busy, migrationToken, channel, jobId, run }: {
  entry: { sourceFieldId: string; kind: string; sourceAppCode: string | null; foreignFieldIds?: string[] };
  apps: AppSummary[]; token: string; busy: boolean; migrationToken: string;
  channel: (jobId: string, suffix: string, body?: unknown) => Promise<MigrationJob>;
  jobId: string; run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [targetAppId, setTargetAppId] = useState('');
  const [fields, setFields] = useState<{ fieldId: string; code: string; name: string }[]>([]);
  useEffect(() => {
    if (!targetAppId) { setFields([]); return; }
    void api<{ fields: { fieldId: string; code: string; name: string }[] }>(appPath(targetAppId), token)
      .then((app) => setFields(app.fields)).catch(() => setFields([]));
  }, [targetAppId]);
  const foreign = entry.foreignFieldIds ?? [];
  return <div className="stack panel">
    <span>{entry.kind} field · source target application {entry.sourceAppCode ?? '—'}</span>
    <label>Restore against application
      <select value={targetAppId} onChange={(event) => setTargetAppId(event.target.value)}>
        <option value="">Choose…</option>
        {apps.map((app) => <option key={app.id} value={app.id}>{app.name} ({app.code})</option>)}
      </select></label>
    {foreign.map((foreignId) => <label key={foreignId} className="inline spread">
      <span>Source field {foreignId}</span>
      <select id={'depfield-' + entry.sourceFieldId + '-' + foreignId}>
        {fields.map((field) => <option key={field.fieldId} value={field.fieldId}>
          {field.name} ({field.code})</option>)}
      </select></label>)}
    <span className="inline">
      <button type="button" disabled={busy || !migrationToken || !targetAppId || !fields.length}
        onClick={() => void run(() => channel(jobId, '/resolve-dependencies', { decisions: {
          [entry.sourceFieldId]: { action: 'map', targetAppId,
            fieldMappings: Object.fromEntries(foreign.map((foreignId) => [foreignId,
              (document.getElementById('depfield-' + entry.sourceFieldId + '-' + foreignId) as HTMLSelectElement).value])),
          } } }))}>Map dependency</button>
      <button type="button" disabled={busy || !migrationToken}
        onClick={() => void run(() => channel(jobId, '/resolve-dependencies', { decisions: {
          [entry.sourceFieldId]: { action: 'disable' } } }))}>Disable this reference</button>
    </span>
  </div>;
}

type ExportJob = { id: string; status: string; stage: string; error: string | null;
  packageBytes: number | null; createdAt: string; sensitiveDataNotice: string };
type Reissue = { jobId: string; name: string; scope: string; sourceTokenId: string;
  reissuedAt: string | null };

// Migration-package export (Wave A endpoints) plus the decision-6 list of
// source API tokens that still have to be re-issued on this deployment.
export function ExportPanel({ app, session }: { app: App; session: Session }) {
  const { token } = session;
  const base = appPath(app.id);
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [reissues, setReissues] = useState<Reissue[]>([]);
  const [issued, setIssued] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setJobs(await api<ExportJob[]>(base + '/exports', token));
    setReissues(await api<Reissue[]>(base + '/token-reissues', token).catch(() => []));
  }
  useEffect(() => { void refresh().catch((error) => setError(message(error))); }, []);
  async function run(operation: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await operation(); await refresh(); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="stack">
    <h3>Migration package</h3>
    <p className="muted">A sealed package carries the complete application — schema, records,
      subtables, attachments, comments, history, workflows and configuration — for restore on
      another deployment. It contains sensitive business data.</p>
    <p className="muted">Boundary: this migration package is not a disaster backup, and a deployment
      backup is not a migration tool. Disaster recovery of a whole deployment uses deployment
      backups, never this package.</p>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="inline">
      <button type="button" className="primary" disabled={busy} onClick={() => void run(() =>
        api(base + '/exports', token, json('POST')))}>Create export job</button>
    </div>
    {jobs.map((job) => <div key={job.id} className="panel inline spread">
      <span>{new Date(job.createdAt).toLocaleString()} · {job.status} / {job.stage}
        {job.packageBytes ? ' · ' + job.packageBytes + ' bytes' : ''}{job.error ? ' · ' + job.error : ''}</span>
      <span className="inline">
        {(job.status === 'queued') && <button type="button" disabled={busy} onClick={() => void run(() =>
          api(base + '/exports/' + job.id + '/run', token, json('POST')))}>Run</button>}
        {job.status === 'sealed' && <button type="button" onClick={() => void download(
          base + '/exports/' + job.id + '/package', token, 'migration-package.zip')
          .catch((error) => setError(message(error)))}>Download package</button>}
      </span>
    </div>)}
    {!!reissues.length && <div className="stack">
      <h4>API tokens to re-issue (decision 6)</h4>
      <p className="muted">Tokens from the source deployment were not restored — secrets never
        travel. Re-issue each integration token here, then mark it done.</p>
      {issued && <p role="status">New token (shown once): <code>{issued}</code></p>}
      {reissues.map((entry) => <div key={entry.jobId + entry.name} className="panel inline spread">
        <span>{entry.name} · scope {entry.scope}
          {entry.reissuedAt ? ' · re-issued ' + new Date(entry.reissuedAt).toLocaleString() : ' · pending'}</span>
        {!entry.reissuedAt && <button type="button" disabled={busy} onClick={() => void run(async () => {
          const created = await api<{ token: string }>(base + '/tokens', token, json('POST', {
            label: entry.name,
            actions: entry.scope.split(',').map((part) => part.trim()).filter(Boolean),
          }));
          setIssued(created.token);
          await api(base + '/token-reissues/' + entry.jobId + '/mark', token,
            json('POST', { name: entry.name }));
        })}>Re-issue &amp; mark</button>}
      </div>)}
    </div>}
  </div>;
}
