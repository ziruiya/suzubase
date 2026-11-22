import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { lookupTargets, type FieldDefinition, type RecordData, type TableRow } from '@suzubase/shared-types';

export const tableHeaders = ['record_no', '__table', '__table_name', '__row_order'] as const;
type Mapping = Record<string, string | null>;
export type CsvRow = { line: number; data: RecordData; recordNo?: string; lines?: number[] };
export type CsvError = { line: number; cells: string[]; issues: unknown[] };
type ParsedRows = { candidates: CsvRow[]; errors: CsvError[]; lookupColumns: string[] };

function numberCell(value: string) {
  return /^'[-+]\d/.test(value) ? value.slice(1) : value;
}

export function mapCsvRows(headers: string[], rows: string[][], mapping: Mapping, fields: FieldDefinition[]): ParsedRows {
  if (headers.includes('__table') && headers.includes('record_no')) return groupTableRows(headers, rows, mapping, fields);
  const snapshots = lookupTargets(fields);
  const lookups = new Set(fields.flatMap((field) => field.lookup ? [field.lookup.localKeyFieldId] : []));
  const definitions = new Map(fields.map((field) => [field.fieldId, field]));
  const lookupColumns: string[] = [];
  const unresolved: string[] = [];
  const targets = new Set<string>();
  const plan = headers.map((header) => {
    const id = Object.hasOwn(mapping, header) ? mapping[header] : undefined;
    if (!id || id === 'lookup') {
      if (id === 'lookup' || !Object.hasOwn(mapping, header) && /^lookup:/i.test(header)) {
        lookupColumns.push(header);
        unresolved.push(header);
      }
      return undefined;
    }
    const configured = definitions.get(id);
    const field = configured?.lookup ? definitions.get(configured.lookup.localKeyFieldId) : configured;
    if (field && snapshots.has(field.fieldId) || /^snapshot:/i.test(header)) {
      throw new BadRequestException('Lookup snapshots are read-only. Map the lookup key column instead.');
    }
    if (!field || ['layout', 'calculation', 'related', 'table', 'lookup'].includes(field.type) || targets.has(field.fieldId)) {
      throw new BadRequestException('Map each column to a distinct writable published field');
    }
    if (lookups.has(field.fieldId)) lookupColumns.push(header);
    targets.add(field.fieldId);
    return field;
  });
  if (!targets.size && !lookupColumns.length) throw new BadRequestException('Map at least one column');
  const candidates: CsvRow[] = [];
  const errors: CsvError[] = [];
  for (const [index, cells] of rows.entries()) {
    const line = index + 2;
    const issues = unresolved.filter((header) => cells[headers.indexOf(header)] !== '')
      .map((column) => ({ column, message: 'Lookup columns must be mapped to a configured lookup or its local key field' }));
    if (issues.length) { errors.push({ line, cells, issues }); continue; }
    const data: RecordData = {};
    for (const [i, field] of plan.entries()) {
      if (!field || cells[i] === '') continue;
      const value = cells[i];
      data[field.fieldId] = field.type === 'richText'
        ? '<p>' + value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\r?\n/g, '<br>') + '</p>'
        : field.type === 'number' ? numberCell(value) : value;
    }
    candidates.push({ line, data });
  }
  return { candidates, errors, lookupColumns };
}

function groupTableRows(headers: string[], rows: string[][], mapping: Mapping, fields: FieldDefinition[]): ParsedRows {
  const tables = fields.flatMap(({ table, code, fieldId }) => table ? [{ ...table, code, fieldId }] : []);
  const byCode = new Map(tables.map((table) => [table.code, table]));
  const childIds = new Set(tables.flatMap(({ fields }) => fields.filter(({ type }) => type !== 'calculation').map(({ fieldId }) => fieldId)));
  for (const [header, mapped] of Object.entries(mapping)) {
    if (mapped && !childIds.has(mapped)) throw new BadRequestException('Subtable CSV accepts writable child mappings only. Parent columns are read-only.');
    if (mapped && (tableHeaders as readonly string[]).includes(header)) throw new BadRequestException('Subtable control columns are mapped automatically');
  }
  const keyColumn = headers.indexOf('record_no');
  const tableColumn = headers.indexOf('__table');
  const errors: CsvError[] = [];
  const groups = new Map<string, { lines: number[]; tables: Map<string, TableRow[]> }>();
  for (const [i, cells] of rows.entries()) {
    const line = i + 2;
    const key = cells[keyColumn];
    const tableCode = cells[tableColumn];
    if (!/^[1-9]\d{0,18}$/.test(key) || BigInt(key) > 9223372036854775807n) {
      errors.push({ line, cells, issues: [{ message: 'Invalid parent record number ' + key }] });
      continue;
    }
    if (!tableCode) {
      // Export repeats parent data in an empty marker when there are no child rows.
      continue;
    }
    const table = byCode.get(tableCode);
    if (!table) {
      errors.push({ line, cells, issues: [{ message: 'No writable subtable matches code ' + tableCode }] });
      continue;
    }
    const data: RecordData = {};
    const duplicates = new Set<string>();
    for (const [column, header] of headers.entries()) {
      const target = Object.hasOwn(mapping, header) ? mapping[header] : undefined;
      if (target === null) continue;
      const child = table.fields.find(({ fieldId, code }) => target ? fieldId === target : header === tableCode + '.' + code);
      if (!child || child.type === 'calculation') continue;
      if (Object.hasOwn(data, child.fieldId)) duplicates.add(child.fieldId);
      data[child.fieldId] = child.type === 'number' ? numberCell(cells[column]) : cells[column];
    }
    if (duplicates.size) {
      errors.push({ line, cells, issues: [{ message: 'Map each child column to a distinct field' }] });
      continue;
    }
    const group = groups.get(key) ?? { lines: [], tables: new Map<string, TableRow[]>() };
    group.lines.push(line);
    const entries = group.tables.get(table.fieldId) ?? [];
    entries.push({ rowId: randomUUID(), data });
    group.tables.set(table.fieldId, entries);
    groups.set(key, group);
  }
  return {
    candidates: [...groups].map(([recordNo, { lines, tables }]) => ({
      recordNo, line: lines[0], lines, data: Object.fromEntries([...tables].map(([id, rows]) => [id, JSON.stringify(rows)])),
    })), errors, lookupColumns: [],
  };
}
