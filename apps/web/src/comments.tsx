import { useEffect, useState } from 'react';
import { api, appPath, json, message, type Session } from './api';

type Part = { kind: 'text'; text: string } | { kind: 'mention'; userId: string; name: string };
type Comment = { id: string; author: string; createdAt: string; deleted: boolean; canDelete: boolean; parts: Part[] };
type Page = { items: Comment[]; next: string | null };

function CommentParts({ parts }: { parts: Part[] }) {
  return <>{parts.map((part, index) => part.kind === 'text'
    ? <span key={index}>{part.text}</span> : <mark key={index}>@{part.name}</mark>)}</>;
}

export function Comments({ appId, recordId, session, archived, refresh }: {
  appId: string; recordId: string; session: Session; archived: boolean; refresh: () => void;
}) {
  const path = appPath(appId) + '/records/' + recordId + '/comments';
  const { token } = session;
  const [page, setPage] = useState<Page>();
  const [after, setAfter] = useState<string>();
  const [parts, setParts] = useState<Part[]>([]);
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<{ id: string; name: string }[]>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string>();

  useEffect(() => {
    const abort = new AbortController();
    void api<Page>(path + (after ? '?after=' + after : ''), token, { signal: abort.signal })
      .then((result) => { if (!abort.signal.aborted) setPage(result); })
      .catch((error) => { if (!abort.signal.aborted) setError(message(error)); });
    return () => abort.abort();
  }, [path, token, after]);

  async function mutate(suffix: string, method: 'POST' | 'DELETE', body?: unknown) {
    setBusy(true);
    setError('');
    try {
      await api(path + suffix, token, json(method, body));
      setDeleting(undefined);
      setParts([]);
      setText('');
      setMentions(undefined);
      setSelected('');
      if (after) setAfter(undefined);
      else setPage(await api<Page>(path, token));
      refresh();
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="stack" aria-label="Comments">
    <h2>Comments</h2>
    {error && <p role="alert">{error}</p>}
    {!archived && <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      const payload = [...parts, ...(text ? [{ kind: 'text' as const, text }] : [])].map((part) =>
        part.kind === 'text' ? part : { kind: 'mention', userId: part.userId });
      void mutate('', 'POST', { parts: payload });
    }}>
      {parts.length > 0 && <div className="stack">
        <p className="comment-body"><CommentParts parts={parts} /></p>
        <button type="button" onClick={() => {
          setText(parts.map((part) => part.kind === 'text' ? part.text : '@' + part.name).join('') + text);
          setParts([]);
        }}>Convert mentions to text</button>
      </div>}
      <label>Comment <textarea value={text} maxLength={4000} rows={3} onChange={(event) => setText(event.target.value)} /></label>
      {mentions ? <div className="inline">
        <label>Mention member <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          <option value="">Choose a member</option>{mentions.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <button type="button" disabled={!selected || busy} onClick={() => {
          const member = mentions.find(({ id }) => id === selected);
          if (!member) return;
          setParts([...parts, ...(text ? [{ kind: 'text' as const, text }] : []), { kind: 'mention', userId: member.id, name: member.name }]);
          setText('');
          setSelected('');
          setMentions(undefined);
        }}>Insert mention</button>
        <button type="button" onClick={() => setMentions(undefined)}>Cancel mention</button>
      </div> : <button type="button" disabled={busy} onClick={() => void api<{ id: string; name: string }[]>(path + '/mention-options', token)
        .then(setMentions).catch((error) => setError(message(error)))}>Mention a member</button>}
      <button type="submit" className="primary" disabled={busy || !(parts.length || text.trim())}>Post comment</button>
    </form>}
    {page && <>
      {!page.items.length && <p>No comments</p>}
      <ol className="plain stack">{page.items.map((item) => <li key={item.id} className="panel">
        <strong>{item.author}</strong> · <time>{new Date(item.createdAt).toLocaleString(undefined, { timeZone: session.profile.timeZone })}</time>
        <p className="comment-body">{item.deleted ? 'Comment deleted' : <CommentParts parts={item.parts} />}</p>
        {item.canDelete && (deleting === item.id ? <div className="inline">
          <button className="danger" type="button" disabled={busy} onClick={() => void mutate('/' + item.id, 'DELETE')}>Confirm delete comment</button>
          <button type="button" onClick={() => setDeleting(undefined)}>Cancel</button>
        </div> : <button type="button" onClick={() => setDeleting(item.id)}>Delete comment</button>)}
      </li>)}</ol>
      <div className="inline">
        {after && <button type="button" onClick={() => setAfter(undefined)}>Latest comments</button>}
        {page.next && <button type="button" onClick={() => setAfter(page.next!)}>Older comments</button>}
      </div>
    </>}
  </section>;
}
