import { Temporal } from '@js-temporal/polyfill';
import { multiOptionFieldTypes, optionFieldTypes, type FormLayout, type RecordData, type RecordResponse } from '@suzubase/shared-types';
import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { api, ApiError, appPath, download, json, message, type App, type Field, type Session } from './api';
import { FormGrid } from './form-layout';
import { RichTextEditor, RichTextValue, richTextSummary } from './rich-text';
import { draftKey, recoverDraft, removeDrafts, writeDraft, type Draft, type DraftScope } from './drafts';

type SaveState = 'editing' | 'local draft saved' | 'submitting' | 'success' | 'failed-retryable' | 'version conflict';
const statusText: Record<SaveState, string> = {
  editing: 'Editing', 'local draft saved': 'Draft saved on this device', submitting: 'Submitting',
  success: 'Saved to the server', 'failed-retryable': 'Save failed. Your edits are still here.', 'version conflict': 'Version conflict',
};

function parseArray(value: string) {
  try {
    const result: unknown = JSON.parse(value || '[]');
    return z.array(z.string()).parse(result);
  } catch {
    return [];
  }
}

function normalizeInForm(field: Field, value: string, timeZone: string) {
  if (field.required && (!value || (field.type === 'richText' && !richTextSummary(value)) || value === '[]' && (multiOptionFieldTypes.has(field.type) || field.type === 'attachment'))) {
    throw new Error('Required');
  }
  if (field.type === 'datetime' && value && !value.endsWith('Z')) {
    return Temporal.PlainDateTime.from(value).toZonedDateTime(timeZone, { disambiguation: 'reject' }).toInstant().toString();
  }
  return value;
}

function inputValue(field: Field, value: string, timeZone: string) {
  if (field.type === 'datetime' && value.endsWith('Z')) {
    return Temporal.Instant.from(value).toZonedDateTimeISO(timeZone).toPlainDateTime().toString({ smallestUnit: 'second' });
  }
  return value;
}

export function displayValue(field: Field, value: string, timeZone: string) {
  if (field.type === 'richText') return richTextSummary(value);
  if (optionFieldTypes.has(field.type)) {
    const values = multiOptionFieldTypes.has(field.type) ? parseArray(value) : [value];
    return values.map((id) => {
      const option = field.options.find(({ value }) => value === id);
      return option?.disabled || !option ? (option?.label ?? id) + '（已失效选项）' : option.label;
    }).join(', ');
  }
  if (field.type === 'datetime') return inputValue(field, value, timeZone).replace('T', ' ');
  if (field.type === 'attachment') return parseArray(value).length ? parseArray(value).length + ' attached' : '';
  return value;
}

function RuntimeField({
  field, value, onChange, session, app, onPending, disabled,
}: {
  field: Field; value: string; onChange: (value: string) => void; session: Session; app: App;
  onPending: (names: string[]) => void; disabled: boolean;
}) {
  const [pending, setPending] = useState<{ file: File; error?: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const values = parseArray(value);
  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    onPending(files.map(({ name }) => name));
    const next: typeof pending = [];
    const uploaded = [...values];
    for (const file of files) {
      try {
        const path = appPath(app.id) + '/files?' + new URLSearchParams({ name: file.name, type: file.type });
        const { id } = await api<{ id: string }>(path, session.token, {
          method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' },
        });
        uploaded.push(id);
      } catch (error) {
        next.push({ file, error: message(error) });
      }
    }
    onChange(JSON.stringify(uploaded));
    setPending(next);
    setUploading(false);
    onPending(next.map(({ file }) => file.name));
  }
  const id = 'field-' + field.fieldId;
  if (!field.editable) return <output id={id}>{value ? displayValue(field, value, session.profile.timeZone) : '—'}</output>;
  if (field.type === 'richText') return <RichTextEditor id={id} html={value} disabled={disabled} onChange={onChange} />;
  if (field.type === 'multiline') return <textarea id={id} rows={5} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} />;
  if (multiOptionFieldTypes.has(field.type)) {
    return <div id={id} role="group" aria-labelledby={id + '-label'}>{field.options.map((option) =>
      <label className="option" key={option.value}>
        <input type="checkbox" checked={values.includes(option.value)} disabled={disabled || option.disabled}
          onChange={(event) => onChange(JSON.stringify(event.target.checked
            ? [...values, option.value] : values.filter((id) => id !== option.value)))} /> {option.label}
        {option.disabled ? '（已失效选项）' : ''}
      </label>)}</div>;
  }
  if (field.type === 'radio') {
    return <div id={id} role="group" aria-labelledby={id + '-label'}>{field.options.map((option) =>
      <label className="option" key={option.value}>
        <input type="radio" name={id} checked={value === option.value} disabled={disabled || option.disabled}
          onChange={() => onChange(option.value)} /> {option.label}{option.disabled ? '（已失效选项）' : ''}
      </label>)}</div>;
  }
  if (field.type === 'select') {
    return <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
      <option value="">Select…</option>
      {field.options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>
        {option.label}{option.disabled ? '（已失效选项）' : ''}
      </option>)}
    </select>;
  }
  if (field.type === 'attachment') {
    return <div className="attachment">
      <input id={id} type="file" multiple accept="image/png,image/jpeg,application/pdf" disabled={uploading || disabled}
        onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <label htmlFor={id + '-camera'}>Take a photo</label>
      <input id={id + '-camera'} type="file" accept="image/*" capture="environment" disabled={uploading || disabled}
        onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      {values.map((fileId, index) => <div key={fileId} className="inline">
        <span>Attachment {index + 1}</span>
        <button type="button" disabled={uploading || disabled}
          onClick={() => onChange(JSON.stringify(values.filter((id) => id !== fileId)))}>Remove</button>
      </div>)}
      {uploading && <p role="status">Uploading…</p>}
      {pending.map(({ file, error }, index) => <p key={index} role="alert">{file.name} · {error}</p>)}
      {pending.length > 0 && <div className="inline">
        <button type="button" disabled={uploading || disabled} onClick={() => void upload(pending.map(({ file }) => file))}>Retry upload</button>
        <button type="button" disabled={uploading || disabled} onClick={() => { setPending([]); onPending([]); }}>Discard failed uploads</button>
      </div>}
    </div>;
  }
  const type = ({
    date: 'date', time: 'time', datetime: 'datetime-local', email: 'email', url: 'url', phone: 'tel',
  } as Record<string, string>)[field.type] ?? 'text';
  return <input id={id} type={type} value={inputValue(field, value, session.profile.timeZone)} disabled={disabled}
    step={type === 'time' || type === 'datetime-local' ? 1 : undefined}
    inputMode={field.type === 'number' ? 'decimal' : undefined}
    onChange={(event) => onChange(event.target.value)} />;
}

export function RecordValues({ fields, layout, record, session, app }: { fields: Field[]; layout: FormLayout; record: RecordResponse; session: Session; app: App }) {
  const [error, setError] = useState('');
  return <div className="record-values">
    <FormGrid fields={fields} layout={layout} render={(field) => <dl className="value-row">
      <dt>{field.name}</dt>
      <dd>{field.type === 'attachment'
        ? parseArray(record.data[field.fieldId]).map((id, index) => <button key={id} type="button"
          onClick={() => void download(appPath(app.id) + '/files/' + id, session.token, 'attachment-' + (index + 1))
            .catch((error) => setError(message(error)))}>Download attachment {index + 1}</button>)
        : field.type === 'richText' && record.data[field.fieldId]
          ? <RichTextValue html={record.data[field.fieldId]} />
          : (record.data[field.fieldId] ? displayValue(field, record.data[field.fieldId], session.profile.timeZone) : '—')}</dd>
    </dl>} />
    {error && <div role="alert">{error}</div>}
  </div>;
}

export function RecordEditor({
  session, app, fields, layout, record, onSaved, onCancel,
}: {
  session: Session; app: App; fields: Field[]; layout: FormLayout; record?: RecordResponse;
  onSaved: (record: RecordResponse) => void; onCancel: () => void;
}) {
  const newId = useRef('new:' + crypto.randomUUID());
  const replayKey = useRef(crypto.randomUUID());
  const pending = useRef(new Map<string, string[]>());
  const activeDraft = useRef<Draft | undefined>(undefined);
  const [baseline, setBaseline] = useState(record);
  const [latest, setLatest] = useState<RecordResponse>();
  const [recovery, setRecovery] = useState<Draft>();
  const [reselect, setReselect] = useState<string[]>([]);
  const [state, setState] = useState<SaveState>('editing');
  const [error, setError] = useState('');
  const { profile, token } = session;
  const allowDraft = profile.localDrafts && app.localDrafts;
  const scope: DraftScope = [profile.tenantId, profile.userId, app.id, record?.id ?? newId.current, app.schemaVersion];
  const form = useForm<RecordData>({ defaultValues: record?.data ?? {} });
  const [focusInset, setFocusInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => setFocusInset(viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
    };
  }, []);

  useEffect(() => {
    if (!allowDraft) return;
    void recoverDraft(scope).then(setRecovery).catch(() => undefined);
  }, [allowDraft, app.id, app.schemaVersion, record?.id, profile.tenantId, profile.userId]);

  function editableValues(values: RecordData): RecordData {
    return Object.fromEntries(fields.filter(({ editable, fieldId }) => editable && Object.hasOwn(values, fieldId))
      .map(({ fieldId }) => [fieldId, values[fieldId]]));
  }

  function ownDraft(draft: Draft) {
    return draft.scope[0] === scope[0] && draft.scope[1] === scope[1] && draft.scope[2] === scope[2] &&
      (draft.scope[3] === scope[3] || draft.key === activeDraft.current?.key);
  }

  async function saveDraft() {
    setError('');
    const savedAt = Date.now();
    const values = editableValues(form.getValues());
    const draft = {
      key: draftKey(scope), scope, revision: baseline?.revision ?? null, values,
      changedFields: Object.keys(values).filter((id) => values[id] !== (baseline?.data[id] ?? '')),
      pendingFiles: [...pending.current].flatMap(([fieldId, names]) => names.map((name) => ({ fieldId, name }))),
      savedAt, expiresAt: savedAt + profile.draftExpiryHours * 3600000,
    };
    try {
      const previous = activeDraft.current;
      await writeDraft(draft, () => session.draftAllowed.current && allowDraft);
      if (previous && previous.key !== draft.key) await removeDrafts((entry) => entry.key === previous.key);
      activeDraft.current = draft;
      setState('local draft saved');
    } catch (error) {
      setError(message(error));
    }
  }

  async function submit(values: RecordData) {
    setError('');
    form.clearErrors();
    if ([...pending.current.values()].some((names) => names.length) || reselect.length) {
      setError('Retry or discard pending attachments before saving.');
      return;
    }
    const data: RecordData = {};
    let invalid = false;
    for (const field of fields.filter(({ editable }) => editable)) {
      try {
        const normalized = normalizeInForm(field, values[field.fieldId] ?? '', profile.timeZone);
        if (normalized) data[field.fieldId] = normalized;
      } catch (error) {
        form.setError(field.fieldId, { message: message(error) });
        invalid = true;
      }
    }
    if (invalid) return;
    setState('submitting');
    const path = appPath(app.id) + '/records';
    try {
      const saved = baseline
        ? await api<RecordResponse>(path + '/' + baseline.id, token, json('PUT', { revision: baseline.revision, data }))
        : await api<RecordResponse>(path, token, { ...json('POST', { data }), headers: { 'Idempotency-Key': replayKey.current } });
      setState('success');
      if (allowDraft) await removeDrafts(ownDraft).catch(() => undefined);
      onSaved(saved);
    } catch (error) {
      if (error instanceof ApiError && error.body.code === 'REVISION_CONFLICT') {
        setLatest(error.body.current as RecordResponse);
        setState('version conflict');
        return;
      }
      if (error instanceof ApiError && Array.isArray(error.body.message)) {
        for (const item of error.body.message) {
          if (fields.some(({ fieldId }) => fieldId === item?.field)) form.setError(item.field, { message: item.message });
        }
      }
      setError(message(error));
      setState('failed-retryable');
    }
  }
  const busy = state === 'submitting';
  return <form className="editor stack" onSubmit={form.handleSubmit(submit)} noValidate>
    <div className="inline spread"><h2>{record ? 'Edit record ' + record.recordNo : 'New record'}</h2>
      <button type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
    <p role="status">{statusText[state]}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {recovery && <section className="notice" aria-label="Recover local draft">
      <p>{recovery.scope[4] === scope[4] ? 'A local draft is available.' :
        'Form version changed. Recover the matching fields and check the current form before submitting.'}</p>
      <div className="inline">
        <button type="button" onClick={() => {
          const changedOnServer = baseline && recovery.revision !== baseline.revision;
          for (const [id, value] of Object.entries(editableValues(recovery.values))) {
            if (!changedOnServer || recovery.changedFields?.includes(id)) form.setValue(id, value);
          }
          if (changedOnServer) {
            setLatest(baseline);
            setState('version conflict');
          }
          setReselect(recovery.pendingFiles.map(({ name }) => name));
          activeDraft.current = recovery;
          setRecovery(undefined);
        }}>Recover draft</button>
        <button type="button" onClick={() => {
          void removeDrafts((draft) => draft.key === recovery.key).catch(() => undefined);
          setRecovery(undefined);
        }}>Discard draft</button>
      </div>
    </section>}
    {reselect.length > 0 && <div className="notice">
      <p>Choose these files again if needed. The draft saved filenames only: {reselect.join(', ')}</p>
      <button type="button" onClick={() => setReselect([])}>Acknowledge and choose files</button>
    </div>}
    {latest && <section className="notice" aria-label="Record version conflict">
      <h3>Server revision {latest.revision}</h3>
      <dl className="conflict">
        {fields.filter(({ fieldId }) => (latest.data[fieldId] ?? '') !== (form.getValues(fieldId) ?? '')).map((field) =>
          <div key={field.fieldId}><dt>{field.name}</dt><dd>Server · {latest.data[field.fieldId] || '—'}</dd>
            <dd>Your edit · {form.getValues(field.fieldId) || '—'}</dd></div>)}
      </dl>
      <button type="button" onClick={() => {
        const values = editableValues(form.getValues());
        const changed = Object.fromEntries(Object.entries(values).filter(([id, value]) => (baseline?.data[id] ?? '') !== value));
        form.reset({ ...latest.data, ...changed });
        setBaseline(latest);
        setLatest(undefined);
        setState('editing');
      }}>Copy my changes onto the latest version</button>
    </section>}
    <FormGrid fields={fields} layout={layout} render={(field) => <div className="form-field">
      <label htmlFor={'field-' + field.fieldId} id={'field-' + field.fieldId + '-label'}>{field.name}{field.required ? ' *' : ''}</label>
      <Controller name={field.fieldId} control={form.control} defaultValue="" render={({ field: input, fieldState }) => <>
        <RuntimeField field={field} value={input.value ?? ''} session={session} app={app} disabled={busy}
          onChange={(value) => { input.onChange(value); if (!latest) setState('editing'); }}
          onPending={(names) => pending.current.set(field.fieldId, names)} />
        {fieldState.error && <p role="alert" className="error">{fieldState.error.message}</p>}
      </>} />
    </div>} />
    <p className="muted">Date and time use {profile.timeZone}.</p>
    {allowDraft ? <details><summary>About local drafts</summary>
      <p>Drafts stay in this browser and expire after {profile.draftExpiryHours / 24} days. Signing out clears your drafts.
        This storage is accessible to other people with access to this browser. Keep passwords and tokens out of record fields.
        Private browsing or clearing site data can remove drafts. File entries keep uploaded IDs or filenames.
        Choose unuploaded files again when recovering a draft.</p>
    </details> : <p className="muted">Local drafts are disabled in settings.</p>}
    <div className="save-bar inline" style={{ bottom: focusInset }}>
      {allowDraft && <button type="button" disabled={busy} onClick={() => void saveDraft()}>Save local draft</button>}
      <button className="primary" disabled={busy || Boolean(latest)} type="submit">Save to server</button>
    </div>
  </form>;
}
