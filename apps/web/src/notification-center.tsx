import { useCallback, useEffect, useState } from 'react';
import { api, json, message, type AppSummary, type Session } from './api';

type Notice = { id: string; appName: string; title: string; body: string; createdAt: string; readAt: string | null };
type Page = { items: Notice[]; next: string | null };

export function useUnread(token: string | undefined) {
  const [count, setCount] = useState('0');
  const reload = useCallback((signal?: AbortSignal) => {
    if (!token || document.hidden) return;
    void api<{ count: string }>('/notifications/unread', token, { signal })
      .then((result) => { if (!signal?.aborted) setCount(result.count); }).catch(() => undefined);
  }, [token]);
  useEffect(() => {
    if (!token) { setCount('0'); return; }
    let interval: ReturnType<typeof setInterval> | undefined;
    let active: AbortController | undefined;
    function poll() {
      active?.abort();
      active = new AbortController();
      reload(active.signal);
    }
    function visibility() {
      clearInterval(interval);
      active?.abort();
      if (!document.hidden) {
        poll();
        interval = setInterval(poll, 30_000);
      }
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', poll);
    visibility();
    return () => {
      clearInterval(interval);
      active?.abort();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', poll);
    };
  }, [token, reload]);
  return { count, reload };
}

export function NotificationCenter({ session, appId, onOpen, onRead }: {
  session: Session; appId?: string; onOpen: (appId: string, recordId: string) => void; onRead: () => void;
}) {
  const { token } = session;
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [application, setApplication] = useState('');
  const [read, setRead] = useState('');
  const [after, setAfter] = useState<string>();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedApp = appId ?? application;
  const path = '/notifications';
  const list = useCallback((signal?: AbortSignal) => {
    const parameters = new URLSearchParams();
    if (selectedApp) parameters.set('appId', selectedApp);
    if (read) parameters.set('read', read);
    if (after) parameters.set('after', after);
    return api<Page>(path + '?' + parameters, token, { signal });
  }, [selectedApp, read, after, token]);

  useEffect(() => {
    const abort = new AbortController();
    setPage(undefined);
    setError('');
    void list(abort.signal).then((value) => { if (!abort.signal.aborted) setPage(value); })
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [list]);
  useEffect(() => {
    if (appId) return;
    const abort = new AbortController();
    void api<AppSummary[]>('/apps', token, { signal: abort.signal }).then(setApps)
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [appId, token]);

  async function mark(id?: string) {
    const suffix = id ? '/' + id + '/read' : '/read-all' + (selectedApp ? '?appId=' + selectedApp : '');
    await mutate(async () => {
      await api(path + suffix, token, json('POST'));
      onRead();
      if (after) setAfter(undefined);
      else setPage(await list());
    });
  }

  async function mutate(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await operation(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }

  return <section className="stack" aria-label="Notifications">
    <h2>Notifications</h2>
    <div className="inline">
      {!appId && <label>Application <select value={application} onChange={(event) => {
        setAfter(undefined);
        setApplication(event.target.value);
      }}><option value="">All applications</option>{apps.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}</select></label>}
      <label>Read status <select value={read} onChange={(event) => { setAfter(undefined); setRead(event.target.value); }}>
        <option value="">All</option><option value="unread">Unread</option><option value="read">Read</option>
      </select></label>
      <button type="button" disabled={busy} onClick={() => void mark()}>Mark all read</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {page && <>
      {!page.items.length && <p>No notifications</p>}
      <ul className="plain stack">{page.items.map((item) => <li className="panel stack" key={item.id}>
        <div className="inline"><strong>{item.title}</strong>{!item.readAt && <small>Unread</small>}</div>
        {item.appName && <small>{item.appName} · {new Date(item.createdAt).toLocaleString(undefined, { timeZone: session.profile.timeZone })}</small>}
        {item.body && <p className="comment-body">{item.body}</p>}
        <div className="inline">
          <button type="button" disabled={busy} onClick={() => void mutate(async () => {
            const target = await api<{ appId: string; recordId: string }>(path + '/' + item.id + '/open', token, json('POST'));
            onRead();
            onOpen(target.appId, target.recordId);
          })}>Open record</button>
          {!item.readAt && <button type="button" disabled={busy} onClick={() => void mark(item.id)}>Mark read</button>}
        </div>
      </li>)}</ul>
      {after && <button type="button" onClick={() => setAfter(undefined)}>First page</button>}
      {page.next && <button type="button" onClick={() => setAfter(page.next!)}>Next page</button>}
    </>}
  </section>;
}
