import { useState } from 'react';
import {
  fieldContract, optionFieldTypes, tableFieldTypes, tableRowLimit, type TableConfiguration, type TableField,
} from '@suzubase/shared-types';

const rowControls = [
  ['addRows', 'Allow adding rows'],
  ['deleteRows', 'Allow removing rows'],
  ['reorderRows', 'Allow reordering rows'],
] as const;

export function tableSettings(values: FormData) {
  const children = values.getAll('tableChildId').map(String);
  return {
    minRows: Number(values.get('tableMin')),
    maxRows: Number(values.get('tableMax')),
    ...Object.fromEntries(rowControls.map(([key]) => [key, values.has(key)])),
    fields: children.map((fieldId) => {
      const type = values.get(fieldId + '-type') as TableField['type'];
      return {
        fieldId, type,
        code: values.get(fieldId + '-code'),
        name: values.get(fieldId + '-name'),
        required: values.has(fieldId + '-required'),
        uniqueValue: values.has(fieldId + '-unique'),
        formula: type === 'calculation' ? JSON.parse(String(values.get(fieldId + '-formula'))) : null,
        options: optionFieldTypes.has(type) ? String(values.get(fieldId + '-options')).split('\n').filter(Boolean).map((line) => {
          const [value, ...label] = line.split('=');
          return { value, label: label.join('=') || value };
        }) : [],
      };
    }),
  };
}

export function TableSettings({ initial }: { initial?: TableConfiguration | null }) {
  const [children, setChildren] = useState<TableField[]>(initial?.fields ?? []);
  return <fieldset className="stack">
    <legend>Subtable</legend>
    <p className="muted">Subtable fields are excluded from search, filters, sorting and summaries.
      Attachments and lookups require future support for row-level references. Rich text, related records,
      nested tables, workflow fields and automatic numbers are unavailable in rows.</p>
    <label>Minimum rows <input name="tableMin" required type="number" min={0} max={tableRowLimit} defaultValue={initial?.minRows ?? 0} /></label>
    <label>Maximum rows <input name="tableMax" required type="number" min={1} max={tableRowLimit} defaultValue={initial?.maxRows ?? 20} /></label>
    {rowControls.map(([key, label]) => <label className="option" key={key}>
      <input type="checkbox" name={key} defaultChecked={initial?.[key] ?? true} /> {label}
    </label>)}
    {children.map((field, index) => {
      const id = field.fieldId;
      return <fieldset className="stack" key={id}>
        <legend>{field.name || 'Child field ' + (index + 1)}</legend>
        <input type="hidden" name="tableChildId" value={id} />
        <label>Name <input name={id + '-name'} required defaultValue={field.name} /></label>
        <label>Code <input name={id + '-code'} required pattern="[a-z][a-z0-9_-]{0,63}" defaultValue={field.code} /></label>
        <label>Type <select name={id + '-type'} value={field.type} onChange={(event) => {
          const type = event.target.value as TableField['type'];
          setChildren(children.map((child) => child.fieldId === id ? { ...child, type } : child));
        }}>{tableFieldTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
        {field.type !== 'calculation' && <label className="option">
          <input type="checkbox" name={id + '-required'} defaultChecked={field.required} /> Required
        </label>}
        {fieldContract[field.type].unique && <label className="option">
          <input type="checkbox" name={id + '-unique'} defaultChecked={field.uniqueValue} /> Unique within this record
        </label>}
        {optionFieldTypes.has(field.type) && <label>Options, one value=label per line <textarea
          name={id + '-options'} required defaultValue={field.options.map(({ value, label }) => value + '=' + label).join('\n')} /></label>}
        {field.type === 'calculation' && <>
          <label>Formula tokens <textarea name={id + '-formula'} required defaultValue={JSON.stringify(field.formula, null, 2)} /></label>
          {children.filter((child) => child.fieldId !== id && child.type !== 'calculation').map((child) =>
            <small key={child.fieldId}>{child.name || child.code || 'Child field ' + (children.indexOf(child) + 1)} · {child.fieldId}</small>)}
        </>}
        <button type="button" onClick={() => setChildren(children.filter(({ fieldId }) => fieldId !== id))}>Remove child field</button>
      </fieldset>;
    })}
    <button type="button" disabled={children.length >= 25} onClick={() => setChildren([...children, {
      fieldId: crypto.randomUUID(), name: '', code: '', type: 'text', required: false, uniqueValue: false, formula: null, options: [],
    }])}>Add child field</button>
  </fieldset>;
}
