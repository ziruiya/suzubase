import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { DndContext, closestCenter, pointerWithin, useDraggable, useDroppable, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import { layoutWidths, type FormLayout, type LayoutCell } from '@suzubase/shared-types';
import type { Field } from './api';

export function LayoutField({ field }: { field: Field }) {
  const element = field.layoutElement;
  if (!element) return null;
  switch (element.kind) {
    case 'label': return <p>{element.text || field.name}</p>;
    case 'separator': return <hr />;
    case 'blank': return <div className="layout-blank" aria-hidden="true" />;
    case 'group': return <h3>{element.text || field.name}</h3>;
  }
}

function completeLayout(fields: Field[], layout: FormLayout): FormLayout {
  const assigned = new Set(layout.flatMap(({ cells, groupFieldId }) => [
    ...cells.map(({ fieldId }) => fieldId), ...(groupFieldId ? [groupFieldId] : []),
  ]));
  return [...layout, ...fields.filter(({ fieldId }) => !assigned.has(fieldId)).map(({ fieldId }) =>
    ({ id: fieldId, cells: [{ fieldId, width: 12 as const }] }))];
}

export function FormGrid({ fields, layout, render }: {
  fields: Field[]; layout: FormLayout; render: (field: Field) => ReactNode;
}) {
  const byId = new Map(fields.map((field) => [field.fieldId, field]));
  const shownGroups = new Set<string>();
  return <div className="layout-grid stack">{completeLayout(fields, layout).map(({ id, cells, groupFieldId }) => {
    const group = groupFieldId && !shownGroups.has(groupFieldId) ? byId.get(groupFieldId) : undefined;
    if (groupFieldId) shownGroups.add(groupFieldId);
    return <Fragment key={id}>
      {group && <LayoutField field={group} />}
      <div className="layout-row">{cells.map(({ fieldId, width }) => {
        const field = byId.get(fieldId);
        return field && <div key={fieldId} className="layout-cell" style={{ '--field-width': width } as CSSProperties}>
          {field.type === 'layout' ? <LayoutField field={field} /> : render(field)}
        </div>;
      })}</div>
    </Fragment>;
  })}</div>;
}

function DropTarget({ row, before, children }: { row: string; before?: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: before ? 'before:' + before : 'row:' + row, data: { row, before } });
  return <div ref={setNodeRef} className={isOver ? 'layout-drop over' : 'layout-drop'}>{children}</div>;
}

function LayoutCard({ field, cell, changeWidth, moveToRow, rows }: {
  field: Field; cell: LayoutCell; changeWidth: (width: LayoutCell['width']) => void;
  moveToRow: (row: string) => void; rows: FormLayout;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: field.fieldId });
  return <div ref={setNodeRef} className="layout-card stack"
    style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, position: 'relative', zIndex: 1 } : undefined}>
    <button type="button" className="drag-handle" {...attributes} {...listeners} aria-label={'Drag ' + field.name}>{field.name}</button>
    <label>Width <select value={cell.width} onChange={(event) => changeWidth(Number(event.target.value) as LayoutCell['width'])}>
      {layoutWidths.map((width) => <option key={width} value={width}>{width} / 12</option>)}
    </select></label>
    <label>Move to <select value="" onChange={(event) => { if (event.target.value) moveToRow(event.target.value); }}>
      <option value="">Choose row</option>
      {rows.map(({ id }, index) => <option key={id} value={id}>Row {index + 1}</option>)}
      <option value="new">New row</option>
    </select></label>
  </div>;
}

const layoutCollision: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

export function LayoutDesigner({ fields, saved, save }: {
  fields: Field[]; saved: FormLayout; save: (layout: FormLayout) => Promise<void>;
}) {
  const [changes, setChanges] = useState<FormLayout[]>([]);
  const [preview, setPreview] = useState<'desktop' | 'mobile'>();
  const [error, setError] = useState('');
  const current = changes.at(-1) ?? completeLayout(fields, saved);
  const byId = new Map(fields.map((field) => [field.fieldId, field]));
  const groups = fields.filter((field) => field.layoutElement?.kind === 'group');

  function change(rows: FormLayout) {
    if (rows.some(({ cells }) => cells.reduce((sum, { width }) => sum + width, 0) > 12)) {
      setError('A row can hold up to twelve columns. Reduce a field width to make space.');
      return;
    }
    setError('');
    setChanges((previous) => [...previous, rows]);
  }

  function move(fieldId: string, to: string, before?: string) {
    if (before === fieldId) return;
    const entry = current.flatMap(({ cells }) => cells).find((cell) => cell.fieldId === fieldId);
    if (!entry) return;
    const next = current.map((row) => ({ ...row, cells: row.cells.filter((cell) => cell.fieldId !== fieldId) }));
    const target = next.find(({ id }) => id === to);
    if (!target) next.push({ id: crypto.randomUUID(), cells: [entry] });
    else {
      const index = before ? target.cells.findIndex(({ fieldId }) => fieldId === before) : -1;
      target.cells.splice(index < 0 ? target.cells.length : index, 0, entry);
    }
    change(next.filter(({ cells }) => cells.length));
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (over?.data.current) move(String(active.id), over.data.current.row, over.data.current.before);
  }

  return <section className="stack">
    <h3>Form layout</h3>
    <p>Drag fields into rows or choose a destination. Set column widths before combining fields.</p>
    <div className="inline">
      <button type="button" onClick={() => setPreview(preview === 'desktop' ? undefined : 'desktop')}>Desktop preview</button>
      <button type="button" onClick={() => setPreview(preview === 'mobile' ? undefined : 'mobile')}>Mobile preview</button>
      <button type="button" disabled={!changes.length} onClick={() => { setError(''); setChanges((previous) => previous.slice(0, -1)); }}>Undo layout change</button>
      <button type="button" disabled={!changes.length} onClick={() => void save(current).then(() => setChanges([]))
        .catch((error: Error) => setError(error.message))}>Save layout to draft</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {preview ? <div className={preview === 'mobile' ? 'layout-preview phone' : 'layout-preview'} aria-label={preview + ' form preview'}>
      <FormGrid fields={fields} layout={current} render={(field) => <label>{field.name}<input disabled /></label>} />
    </div> : <DndContext collisionDetection={layoutCollision} onDragEnd={onDragEnd}>
      {current.map((row, index) => <section className="layout-designer-row stack" key={row.id} aria-label={'Row ' + (index + 1)}>
        <div className="inline">
          <label>Group <select value={row.groupFieldId ?? ''} onChange={(event) => {
            const selected = event.target.value || undefined;
            const next = current.map((item) => ({ ...item, cells: item.cells.filter(({ fieldId }) => fieldId !== selected) }))
              .map((item) => item.id === row.id ? { ...item, groupFieldId: selected } : item)
              .filter(({ cells }) => cells.length);
            if (row.groupFieldId && row.groupFieldId !== selected && !next.some(({ groupFieldId }) => groupFieldId === row.groupFieldId)) {
              next.push({ id: crypto.randomUUID(), cells: [{ fieldId: row.groupFieldId, width: 12 }] });
            }
            change(next);
          }}>
            <option value="">None</option>
            {groups.map((field) => <option key={field.fieldId} value={field.fieldId}>{field.name}</option>)}
          </select></label>
          <button type="button" disabled={!index} onClick={() => {
            const next = [...current];
            [next[index - 1], next[index]] = [next[index], next[index - 1]];
            change(next);
          }}>Move row up</button>
        </div>
        <div className="inline">
          {row.cells.map((cell) => <DropTarget key={cell.fieldId} row={row.id} before={cell.fieldId}>
            <LayoutCard field={byId.get(cell.fieldId)!} cell={cell} rows={current}
              moveToRow={(target) => move(cell.fieldId, target)}
              changeWidth={(width) => change(current.map((item) => item.id !== row.id ? item :
                { ...item, cells: item.cells.map((entry) => entry.fieldId !== cell.fieldId ? entry : { ...entry, width }) }))} />
          </DropTarget>)}
          <DropTarget row={row.id}><span className="muted">Drop at end of row</span></DropTarget>
        </div>
      </section>)}
      <DropTarget row="new"><span className="muted">Drop into a new row</span></DropTarget>
    </DndContext>}
  </section>;
}
