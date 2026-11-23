import type { CategoryConfiguration, CategoryNode } from '@suzubase/shared-types';
import { useEffect, useState } from 'react';
import { api, appPath, json, message, type App } from './api';

/**
 * P4-T1 category tree editor. Edits the schema DRAFT through
 * GET/PUT /apps/:appId/draft/categories; the tree takes effect when the
 * app is published (same publish button as the other settings tabs).
 * Deleting a node that still has records is refused by the API.
 */
export function CategorySettings({ app, token }: { app: App; token: string }) {
  const path = appPath(app.id) + '/draft/categories';
  const [configuration, setConfiguration] = useState<CategoryConfiguration>();
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<CategoryConfiguration>(path, token).then(setConfiguration)
      .catch((error) => setError(message(error)));
  }, [app.id]);

  if (!configuration) return <p className="muted">{error || 'Loading categories…'}</p>;
  const nodes = configuration.nodes;
  const childrenOf = (parentId: string | null) => nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  function replace(next: CategoryNode[]) {
    setConfiguration({ ...configuration!, nodes: next });
    setNotice('');
  }
  function rename(id: string, name: string) {
    replace(nodes.map((node) => node.id === id ? { ...node, name } : node));
  }
  function move(id: string, offset: number) {
    const node = nodes.find((entry) => entry.id === id)!;
    const siblings = childrenOf(node.parentId);
    const index = siblings.findIndex((entry) => entry.id === id);
    const target = siblings[index + offset];
    if (!target) return;
    const orders = new Map(siblings.map((entry) => [entry.id, entry.sortOrder]));
    replace(nodes.map((entry) => entry.id === id ? { ...entry, sortOrder: target.sortOrder }
      : entry.id === target.id ? { ...entry, sortOrder: orders.get(id)! } : entry));
  }
  function add(parentId: string | null, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const siblings = childrenOf(parentId);
    replace([...nodes, {
      id: crypto.randomUUID(), parentId, name: trimmed,
      sortOrder: siblings.length ? Math.max(...siblings.map(({ sortOrder }) => sortOrder)) + 1 : 0,
    }]);
  }
  function remove(id: string) {
    const subtree = new Set<string>([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const node of nodes) {
        if (node.parentId && subtree.has(node.parentId) && !subtree.has(node.id)) {
          subtree.add(node.id); changed = true;
        }
      }
    }
    replace(nodes.filter((node) => !subtree.has(node.id)));
  }
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api<CategoryConfiguration>(path, token, json('PUT', configuration));
      setConfiguration(saved);
      setNotice('Category draft saved. Publish the app to apply it.');
    } catch (error) { setError(message(error)); } finally { setBusy(false); }
  }

  const renderNode = (node: CategoryNode, depth: number): React.ReactNode => <li key={node.id} className="stack">
    <div className="inline" style={{ marginLeft: depth * 24 }}>
      <input aria-label={'Category name ' + node.name} value={node.name} maxLength={64}
        onChange={(event) => rename(node.id, event.target.value)} />
      <button type="button" disabled={busy} onClick={() => move(node.id, -1)}>Move up</button>
      <button type="button" disabled={busy} onClick={() => move(node.id, 1)}>Move down</button>
      <button type="button" disabled={busy} onClick={() => {
        const name = window.prompt('New subcategory name');
        if (name) add(node.id, name);
      }}>Add subcategory</button>
      <button type="button" disabled={busy} onClick={() => remove(node.id)}>Delete</button>
    </div>
    <ul className="plain">{childrenOf(node.id).map((child) => renderNode(child, depth + 1))}</ul>
  </li>;

  return <div className="stack">
    <p className="muted">Categories classify records (multiple per record). Filtering by a
      category includes its subcategories. Disabling hides the tree from record forms and
      filters without deleting it or any record assignments.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <label className="option"><input type="checkbox" checked={configuration.enabled}
      onChange={(event) => setConfiguration({ ...configuration, enabled: event.target.checked })} /> Categories enabled</label>
    <ul className="plain">{childrenOf(null).map((node) => renderNode(node, 0))}</ul>
    <form className="inline" onSubmit={(event) => { event.preventDefault(); add(null, newName); setNewName(''); }}>
      <label>New top-level category <input value={newName} maxLength={64}
        onChange={(event) => setNewName(event.target.value)} /></label>
      <button type="submit" disabled={busy || !newName.trim()}>Add category</button>
    </form>
    <div><button className="primary" disabled={busy} onClick={() => void save()}>Save category draft</button></div>
  </div>;
}
