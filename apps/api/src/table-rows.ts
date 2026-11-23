import { BadRequestException } from '@nestjs/common';
import { and, eq, recordTableRows, type TenantTransaction } from '@suzubase/db';
import {
  multiOptionFieldTypes, tableRowLimit, type FieldChange, type FieldDefinition, type RecordData,
  type TableConfiguration, type TableRow,
} from '@suzubase/shared-types';
import { z } from 'zod';
import { normalizeValue } from './field-values';
import { fileIds } from './files';
import { calculateFields } from './formula';
import { uniqueKey } from './schema-preflight';
import { identifier } from './validation';

type Scope = { tenantId: string; appId: string; recordId: string };
const rowInput = z.array(z.strictObject({ rowId: identifier, data: z.record(identifier, z.string()) })).max(tableRowLimit)
  .refine((rows) => new Set(rows.map(({ rowId }) => rowId)).size === rows.length);

export function tableRowScope(scope: Scope) {
  return and(eq(recordTableRows.tenantId, scope.tenantId), eq(recordTableRows.appId, scope.appId),
    eq(recordTableRows.recordId, scope.recordId));
}

function error(field: string, message: string): never {
  throw new BadRequestException([{ field, message }]);
}

export async function prepareTableRows(
  definitions: FieldDefinition[], data: RecordData, before: Map<string, TableRow[]>, creating: boolean,
  directory: (type: string, value: string) => Promise<boolean>,
) {
  const replacements = new Map<string, TableRow[]>();
  const changes: FieldChange[] = [];
  for (const { fieldId, table } of definitions) {
    if (!table) continue;
    if (!creating && !Object.hasOwn(data, fieldId)) continue;
    let rows: TableRow[];
    try {
      rows = rowInput.parse(JSON.parse(data[fieldId] ?? '[]'));
    } catch {
      error(fieldId, 'Invalid subtable rows');
    }
    delete data[fieldId];
    const old = before.get(fieldId) ?? [];
    if (rows.length < table.minRows || rows.length > table.maxRows) {
      error(fieldId, 'Expected ' + table.minRows + ' to ' + table.maxRows + ' rows');
    }
    verifyRowChanges(fieldId, table, old, rows, creating);
    const previous = new Map(old.map((row) => [row.rowId, row]));
    const seen = new Map(table.fields.filter(({ uniqueValue }) => uniqueValue).map((field) => [field.fieldId, new Set<string>()]));
    const allowed = new Set(table.fields.filter(({ type }) => type !== 'calculation').map((field) => field.fieldId));
    for (const [index, row] of rows.entries()) {
      const previousData = previous.get(row.rowId)?.data ?? {};
      if (Object.keys(row.data).some((id) => !allowed.has(id))) error(fieldId, 'Unknown or read-only child field in row ' + (index + 1));
      const normalized: RecordData = {};
      for (const field of table.fields) {
        if (field.type === 'calculation') continue;
        const value = row.data[field.fieldId] ?? '';
        const oldValue = previousData[field.fieldId];
        const priorChoices: string[] = oldValue && multiOptionFieldTypes.has(field.type) ? JSON.parse(oldValue) : oldValue ? [oldValue] : [];
        const options = field.options.map((option) => ({ ...option, disabled: option.disabled && !priorChoices.includes(option.value) }));
        // P4-T2: attachment children store the same canonical form as
        // record-level attachment fields (JSON array of file UUIDs,
        // validated exactly like records.normalizeData validates them).
        let result: string | undefined;
        if (field.type === 'attachment') {
          try {
            const parsed = fileIds.safeParse(JSON.parse(value || '[]'));
            result = parsed.success ? JSON.stringify(parsed.data) : undefined;
          } catch {
            result = undefined;
          }
        } else {
          result = value === '' ? '' : normalizeValue(field.type, value, options);
        }
        const prefix = 'Row ' + (index + 1) + ' · ' + field.name + ' · ';
        if (result === undefined || result !== oldValue && !await directory(field.type, result)) error(fieldId, prefix + 'invalid value');
        if (field.required && (!result || result === '[]' &&
          (multiOptionFieldTypes.has(field.type) || field.type === 'attachment'))) error(fieldId, prefix + 'required');
        if (!result) continue;
        const keys = seen.get(field.fieldId);
        if (keys) {
          const key = uniqueKey(result);
          if (keys.has(key)) error(fieldId, prefix + 'duplicate value');
          keys.add(key);
        }
        normalized[field.fieldId] = result;
      }
      calculateFields(table.fields, normalized);
      row.data = normalized;
    }
    replacements.set(fieldId, rows);
    for (const [position, row] of rows.entries()) {
      const oldRow = previous.get(row.rowId);
      if (!oldRow) changes.push({ fieldId, rowId: row.rowId, rowChange: 'added', oldValue: null, newValue: String(position + 1) });
      else if (old[position]?.rowId !== row.rowId) changes.push({
        fieldId, rowId: row.rowId, rowChange: 'moved', oldValue: String(old.indexOf(oldRow) + 1), newValue: String(position + 1),
      });
      for (const child of table.fields) {
        const oldValue = oldRow?.data[child.fieldId] ?? null;
        const newValue = row.data[child.fieldId] ?? null;
        if (oldValue !== newValue) changes.push({ fieldId, rowId: row.rowId, childFieldId: child.fieldId, oldValue, newValue });
      }
      previous.delete(row.rowId);
    }
    for (const { rowId } of previous.values()) changes.push({
      fieldId, rowId, rowChange: 'removed', oldValue: String(old.findIndex((row) => row.rowId === rowId) + 1), newValue: null,
    });
  }
  return { replacements, changes };
}

function verifyRowChanges(fieldId: string, table: TableConfiguration, old: TableRow[], rows: TableRow[], creating: boolean) {
  if (creating) return;
  const before = new Set(old.map(({ rowId }) => rowId));
  const after = new Set(rows.map(({ rowId }) => rowId));
  if (!table.addRows && rows.some(({ rowId }) => !before.has(rowId))) error(fieldId, 'Adding rows is disabled');
  if (!table.deleteRows && old.some(({ rowId }) => !after.has(rowId))) error(fieldId, 'Removing rows is disabled');
  if (!table.reorderRows && old.filter(({ rowId }) => after.has(rowId)).some(({ rowId }, index) =>
    rowId !== rows.filter((row) => before.has(row.rowId))[index]?.rowId)) error(fieldId, 'Reordering rows is disabled');
}

export async function replaceTableRows(tx: TenantTransaction, scope: Scope, replacements: Map<string, TableRow[]>) {
  for (const [fieldId, rows] of replacements) {
    await tx.delete(recordTableRows).where(and(tableRowScope(scope), eq(recordTableRows.fieldId, fieldId)));
    if (rows.length) await tx.insert(recordTableRows).values(rows.map((row, rowOrder) => ({ ...scope, ...row, fieldId, rowOrder })));
  }
}
