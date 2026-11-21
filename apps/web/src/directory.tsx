import { useEffect, useState, type FormEvent } from 'react';
import { api, appPath, ApiError, json, message, type Session } from './api';

interface DirectoryMember {
  id: string;
  email: string;
  loginName: string | null;
  displayName: string | null;
  label: string;
  organizationId: string | null;
  disabledAt: string | null;
  isAdmin: boolean;
  canManageRecycleBin: boolean;
  canReadArchivedFields: boolean;
}

export interface DirectoryData {
  settings: { timeZone: string; localDrafts: boolean; allowAppCreation: boolean; passwordMinimum: number; passwordComplexity: boolean };
  members: DirectoryMember[];
  organizations: { id: string; name: string; parentId: string | null }[];
  groups: { id: string; name: string }[];
  groupMembers: { groupId: string; userId: string }[];
}

type Run = (operation: () => Promise<unknown>) => Promise<void>;

function Form({ onSubmit, children, reset = false }: {
  onSubmit: (data: FormData) => Promise<void>; children: React.ReactNode; reset?: boolean;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    void onSubmit(new FormData(form)).then(() => { if (reset) form.reset(); }).catch(() => undefined);
  }
  return <form className="stack" onSubmit={submit}>{children}</form>;
}

type DisablePlan = {
  records: { id: string; appId: string; recordNo: string }[];
  assignments: { id: string; appId: string; appName: string; recordNo: string; revision: number; state: string }[];
};

function MemberEditor({ member, members, organizations, token, run, current }: {
  member: DirectoryMember; members: DirectoryMember[]; organizations: DirectoryData['organizations']; token: string; run: Run; current: string;
}) {
  const [plan, setPlan] = useState<DisablePlan>();
  const [error, setError] = useState('');
  const path = '/tenant/users/' + member.id;
  async function preview() {
    setError('');
    try { setPlan(await api<DisablePlan>(path + '/disable', token)); }
    catch (error) { setError(message(error)); }
  }
  return <details className="panel">
    <summary>{member.label}{member.isAdmin ? ' · Administrator' : ''}</summary>
    <div className="stack">
      <p>{member.email}{member.loginName && ' · ' + member.loginName}</p>
      <Form onSubmit={(values) => run(() => api(path, token, json('PATCH', {
        ...(String(values.get('name')).trim() && { displayName: values.get('name') }),
        organizationId: values.get('organization') || null,
        canManageRecycleBin: values.has('recycle'), canReadArchivedFields: values.has('archive'),
      })))}>
        <label>Display name <input name="name" defaultValue={member.displayName ?? ''} /></label>
        <label>Organization <select name="organization" defaultValue={member.organizationId ?? ''}>
          <option value="">None</option>{organizations.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label className="option"><input name="recycle" type="checkbox" defaultChecked={member.canManageRecycleBin} /> Manage recycle bins</label>
        <label className="option"><input name="archive" type="checkbox" defaultChecked={member.canReadArchivedFields} /> Read archived field values</label>
        <button>Save member</button>
      </Form>
      {!member.disabledAt && member.id !== current && <>
        <Form reset onSubmit={(data) => run(() => api(path + '/password', token, json('PUT', { password: data.get('password') })))}>
          <label>New password <input type="password" name="password" required autoComplete="new-password" /></label>
          <button>Reset password</button>
        </Form>
        {error && <p role="alert">{error}</p>}
        {plan ? <section aria-label="Disable member" className="stack">
          {plan.records.length > 0 && <div>
            <p>Created records requiring handoff</p>
            <ul>{plan.records.map((record) => <li key={record.id}>Record {record.recordNo} · application {record.appId}</li>)}</ul>
          </div>}
          {plan.assignments.map((record) => <Form key={record.id} onSubmit={(data) => run(async () => {
            await api(appPath(record.appId) + '/records/' + record.id + '/workflow/handoff', token, json('POST', {
              revision: record.revision, fromUserId: member.id, toUserId: data.get('recipient'),
            }));
            await preview();
          })}>
            <p>{record.appName} · Record {record.recordNo} · {record.state}</p>
            <label>Transfer to <select name="recipient" required>
              <option value="">Choose a member</option>
              {members.filter(({ id, disabledAt }) => id !== member.id && !disabledAt).map(({ id, label }) =>
                <option key={id} value={id}>{label}</option>)}
            </select></label>
            <button type="submit">Transfer assignment</button>
          </Form>)}
          <div className="inline">
            <button disabled={!!(plan.records.length || plan.assignments.length)}
              onClick={() => void run(() => api(path + '/disable', token, json('POST'))).catch(() => undefined)}>
              Confirm disable {member.label}
            </button>
            <button onClick={() => setPlan(undefined)}>Cancel</button>
          </div>
        </section> : <button onClick={() => void preview()}>Disable {member.label}</button>}
      </>}
    </div>
  </details>;
}

export function Directory({ session, back }: { session: Session; back: () => void }) {
  const [directory, setDirectory] = useState<DirectoryData>();
  const [tab, setTab] = useState<'Members' | 'Organizations' | 'Groups' | 'Tenant settings'>('Members');
  const [error, setError] = useState('');
  const [problem, setProblem] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const { token } = session;
  async function refresh() { setDirectory(await api<DirectoryData>('/tenant/directory', token)); }
  useEffect(() => { void refresh().catch((error) => setError(message(error))); }, [token]);
  async function run(operation: () => Promise<unknown>) {
    setBusy(true); setError(''); setNotice(''); setProblem(undefined);
    try {
      await operation();
      await refresh();
      setNotice('Directory saved.');
    } catch (error) {
      setError(message(error));
      if (error instanceof ApiError && (error.status === 409 || Array.isArray(error.body.message))) setProblem(error.body);
      throw error;
    } finally { setBusy(false); }
  }
  const mutate = (path: string, method: string, body?: unknown) => run(() => api('/tenant/' + path, token, json(method, body)));
  const organizations = directory?.organizations ?? [];
  const tree = (parentId: string | null) => organizations.filter((item) => item.parentId === parentId);
  const ordered: { id: string; label: string }[] = [];
  function visit(parent: string | null, depth = 0) {
    for (const item of tree(parent)) {
      ordered.push({ id: item.id, label: '· '.repeat(depth) + item.name });
      visit(item.id, depth + 1);
    }
  }
  visit(null);
  return <section className="panel stack">
    <div className="inline spread"><h1>Tenant directory</h1><button onClick={back}>Back to applications</button></div>
    <nav className="tabs" aria-label="Directory settings">{(['Members', 'Organizations', 'Groups', 'Tenant settings'] as const)
      .map((item) => <button key={item} aria-current={item === tab ? 'page' : undefined} onClick={() => setTab(item)}>{item}</button>)}</nav>
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {problem !== undefined && <pre>{JSON.stringify(problem, null, 2)}</pre>}
    {directory && <fieldset disabled={busy} className="stack">
      {tab === 'Members' && <>
        <details><summary>Add member</summary>
          <Form reset onSubmit={(data) => mutate('users', 'POST', {
            displayName: data.get('displayName'), loginName: data.get('loginName'), email: data.get('email'), password: data.get('password'),
          })}>
            <label>Display name <input name="displayName" required /></label>
            <label>Login name <input name="loginName" required /></label>
            <label>Email <input name="email" type="email" required /></label>
            <label>Password <input name="password" type="password" required autoComplete="new-password" /></label>
            <button>Create member</button>
          </Form>
        </details>
        {directory.members.map((member) => <MemberEditor key={member.id} member={member} members={directory.members} organizations={organizations}
          token={token} run={run} current={session.profile.userId} />)}
      </>}
      {tab === 'Organizations' && <>
        <Form reset onSubmit={(data) => mutate('organizations', 'POST', { name: data.get('name'), parentId: data.get('parent') || null })}>
          <label>New organization <input name="name" required /></label>
          <label>Parent <select name="parent"><option value="">No parent</option>
            {ordered.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
          <button>Create organization</button>
        </Form>
        {ordered.map(({ id, label }) => {
          const item = organizations.find((row) => row.id === id)!;
          return <details className="panel" key={id}><summary>{label}</summary>
            <Form onSubmit={(data) => mutate('organizations/' + id, 'PUT', { name: data.get('name'), parentId: data.get('parent') || null })}>
              <label>Name <input name="name" required defaultValue={item.name} /></label>
              <label>Parent <select name="parent" defaultValue={item.parentId ?? ''}><option value="">No parent</option>
                {ordered.filter((entry) => entry.id !== id).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select></label>
              <button>Save organization</button>
            </Form>
            <button onClick={() => {
              if (window.confirm('Delete organization ' + item.name + '?')) void mutate('organizations/' + id, 'DELETE').catch(() => undefined);
            }}>Delete organization</button>
          </details>;
        })}
      </>}
      {tab === 'Groups' && <>
        <Form reset onSubmit={(data) => mutate('groups', 'POST', { name: data.get('name') })}>
          <label>New group <input name="name" required /></label><button>Create group</button>
        </Form>
        {directory.groups.map((group) => <details className="panel" key={group.id}><summary>{group.name}</summary>
          <Form onSubmit={(data) => mutate('groups/' + group.id, 'PATCH', { name: data.get('name') })}>
            <label>Group name <input name="name" required defaultValue={group.name} /></label><button>Save group</button>
          </Form>
          <fieldset><legend>Members</legend>
            {directory.members.map((member) => <label key={member.id} className="option">
              <input type="checkbox" checked={directory.groupMembers.some(({ groupId, userId }) => groupId === group.id && userId === member.id)}
                onChange={(event) => void mutate('groups/' + group.id + '/members/' + member.id, 'PUT',
                  { included: event.target.checked }).catch(() => undefined)} /> {member.label}
            </label>)}
          </fieldset>
          <button onClick={() => {
            if (window.confirm('Delete group ' + group.name + '?')) void mutate('groups/' + group.id, 'DELETE').catch(() => undefined);
          }}>Delete group</button>
        </details>)}
      </>}
      {tab === 'Tenant settings' && <Form onSubmit={(data) => mutate('settings', 'PUT', {
        timeZone: data.get('timeZone'), localDrafts: data.has('localDrafts'), allowAppCreation: data.has('allowAppCreation'),
        passwordMinimum: Number(data.get('passwordMinimum')), passwordComplexity: data.has('passwordComplexity'),
      })}>
        <label>Time zone <input name="timeZone" defaultValue={directory.settings.timeZone} required /></label>
        <label>Minimum password length <input name="passwordMinimum" type="number" min={8} max={128} required defaultValue={directory.settings.passwordMinimum} /></label>
        <label className="option"><input name="passwordComplexity" type="checkbox" defaultChecked={directory.settings.passwordComplexity} /> Require mixed character classes</label>
        <label className="option"><input name="localDrafts" type="checkbox" defaultChecked={directory.settings.localDrafts} /> Allow local record drafts</label>
        <label className="option"><input name="allowAppCreation" type="checkbox" defaultChecked={directory.settings.allowAppCreation} /> Allow members to create applications</label>
        <button>Save tenant settings</button>
      </Form>}
    </fieldset>}
  </section>;
}
