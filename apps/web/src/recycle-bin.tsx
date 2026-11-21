import { useEffect, useState } from 'react';
import { api, json, message, type Session } from './api';

interface RecycledRecord {
  id: string;
  recordNo: string;
  revision: number;
  deletedAt: string;
}

export function RecycleBin({ path, session, back }: { path: string; session: Session; back: () => void }) {
  const [items, setItems] = useState<RecycledRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);
  async function load(after?: string) {
    const result = await api<{ items: RecycledRecord[]; nextCursor: string | null }>(
      path + '/recycle' + (after ? '?after=' + after : ''), session.token,
    );
    setItems((current) => after ? [...current, ...result.items] : result.items);
    setCursor(result.nextCursor);
  }
  async function run(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }
  useEffect(() => { void run(load); }, [path]);
  return <section className="panel stack">
    <div className="inline spread"><h2>Record recycle bin</h2><button onClick={back}>Back to records</button></div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!busy && !items.length && <p>The recycle bin is empty.</p>}
    <ul className="plain stack">{items.map((item) => <li className="inline" key={item.id}>
      <strong>Record {item.recordNo}</strong>
      <time>{new Date(item.deletedAt).toLocaleString(undefined, { timeZone: session.profile.timeZone })}</time>
      {confirm === item.id ? <>
        <button disabled={busy} onClick={() => void run(async () => {
          await api(path + '/' + item.id + '/restore', session.token, json('POST', { revision: item.revision }));
          setNotice('Record ' + item.recordNo + ' was restored.');
          setConfirm(undefined);
          await load();
        })}>Confirm restore of record {item.recordNo}</button><button onClick={() => setConfirm(undefined)}>Cancel</button>
      </> : <button onClick={() => setConfirm(item.id)}>Restore record {item.recordNo}</button>}
    </li>)}</ul>
    {cursor && <button disabled={busy} onClick={() => void run(() => load(cursor))}>Load more deleted records</button>}
  </section>;
}
