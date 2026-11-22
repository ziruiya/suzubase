import { richTextPlain } from './rich-text';
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpException, Injectable,
  NotFoundException, Param, Post, Query, ServiceUnavailableException, StreamableFile, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { and, csvJobs, eq, inArray, records, recordTableRows, sql, TenantContext, TenantTransaction, withTenantTransaction } from '@suzubase/db';
import { lookupTargets, relatedCountHelp, RecordData, RelatedConfiguration } from '@suzubase/shared-types';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { mapCsvRows, tableHeaders, type CsvRow } from './csv-rows';
import { AppSchemaService } from './app-schema';
import { FileService } from './files';
import { AuthenticatedTenant, SessionGuard } from './identity';
import { RecordQueryService } from './record-query';
import { RecordService } from './records';
import { SearchService, searchInput } from './search';
import { identifier, parseInput, postgresErrorCode } from './validation';

const preflightInput = z.strictObject({
  csv: z.string().max(200000),
  mapping: z.record(z.string().max(128), z.union([identifier, z.literal('lookup'), z.null()])),
});
const attachmentQuery = z.enum(['true', 'false']).optional();
const exportQuery = z.union([
  z.strictObject({ view: identifier.optional(), attachments: attachmentQuery }),
  searchInput.extend({ attachments: attachmentQuery }),
]);
const batchInput = z.strictObject({ offset: z.int().min(0).max(1000), size: z.int().min(1).max(50).default(50) });
export const csvHttp = { preflightInput, batchInput, exportQuery };
type Job = typeof csvJobs.$inferSelect;

class PreflightRollback extends Error {}

function csvFile(rows: string[][], name: string) {
  return new StreamableFile(Buffer.from(stringify(rows, { escape_formulas: true })), {
    type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${name}"`,
  });
}

function parseCsv(source: string): string[][] {
  let matrix: string[][];
  try {
    matrix = parse(source, { bom: true, skip_empty_lines: true, max_record_size: 32000 });
  } catch {
    throw new BadRequestException('Invalid CSV syntax or mismatched number of columns');
  }
  const headers = matrix[0] ?? [];
  if (!headers.length || headers.length > 100 || matrix.length > 1001 ||
    headers.some((name) => !name || name.length > 128) ||
    new Set(headers).size !== headers.length || /[\x00\p{Surrogate}]/u.test(source)) {
    throw new BadRequestException('CSV requires unique named columns, at most 100 columns and at most 1000 data rows');
  }
  return matrix;
}

function jobSummary(job: Job) {
  return {
    id: job.id, schemaVersion: job.schemaVersion, eligible: job.rows.length, failed: job.errors.length,
    imported: job.imported, remaining: job.rows.length - job.imported, lookupColumns: job.lookupColumns,
    eligibleRows: job.rows.reduce((sum, row) => sum + (row.lines?.length ?? 1), 0),
    importedRows: job.rows.slice(0, job.imported).reduce((sum, row) => sum + (row.lines?.length ?? 1), 0),
    errorReport: job.errors.map(({ line, issues }) => ({ line, issues })),
  };
}

@Injectable()
export class CsvService {
  constructor(
    private readonly schema: AppSchemaService,
    private readonly records: RecordService,
    private readonly query: RecordQueryService,
    private readonly files: FileService,
    private readonly search: SearchService,
  ) {}

  async preflight(context: TenantContext, appId: string, input: z.infer<typeof preflightInput>) {
    const [headers, ...data] = parseCsv(input.csv);
    return withTenantTransaction(context, async (tx) => {
      const grant = await this.schema.writable(tx, context, appId, 'import');
      const { app, fields } = grant;
      const { candidates, errors, lookupColumns } = mapCsvRows(headers, data, input.mapping, fields);
      const lookupIds = new Set(fields.flatMap(({ lookup }) => lookup ? [lookup.localKeyFieldId] : []));
      const rows: Job['rows'] = [];
      try {
        // Nested Drizzle transactions are savepoints under the same tenant transaction.
        // Keep accepted trial rows visible to later trials for duplicate detection, then remove all trial writes.
        await tx.transaction(async (trial) => {
          for (const candidate of candidates) {
            try {
              await trial.transaction((row) => this.writeCsvRow(row, context, appId, candidate, grant));
              rows.push(candidate);
            } catch (error) {
              if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
              const response = error.getResponse();
              const issues = ['object' === typeof response && response !== null && 'message' in response && Array.isArray(response.message)
                ? { ...response, message: response.message.map((item) =>
                  item && typeof item === 'object' && 'field' in item && lookupIds.has(item.field) && candidate.data[item.field] !== undefined
                    ? { ...item, keyValue: candidate.data[item.field] } : item) }
                : response];
              for (const line of candidate.lines ?? [candidate.line]) errors.push({ line, cells: data[line - 2], issues });
            }
          }
          throw new PreflightRollback();
        });
      } catch (error) {
        if (!(error instanceof PreflightRollback)) throw error;
      }
      const [job] = await tx.insert(csvJobs).values({
        tenantId: context.tenantId, appId, userId: context.userId, schemaVersion: app.publishedSchemaVersion,
        headers, rows, errors: errors.sort((a, b) => a.line - b.line), lookupColumns,
      }).returning();
      return jobSummary(job);
    });
  }

  private async writeCsvRow(tx: TenantTransaction, context: TenantContext, appId: string, row: CsvRow,
    grant: Awaited<ReturnType<AppSchemaService['writable']>>,
  ) {
    if (row.recordNo) await this.records.replaceImportedRows(tx, context, appId, row.recordNo, row.data);
    else await this.records.persistCreate(tx, context, appId, row.data, grant, 'import');
  }

  private scope(context: TenantContext, appId: string, id: string) {
    return and(eq(csvJobs.tenantId, context.tenantId), eq(csvJobs.appId, appId),
      eq(csvJobs.userId, context.userId), eq(csvJobs.id, id));
  }

  private async job(tx: TenantTransaction, context: TenantContext, appId: string, id: string, lock = false) {
    const query = tx.select().from(csvJobs).where(this.scope(context, appId, id));
    const [job] = await (lock ? query.for('update') : query);
    if (!job) throw new NotFoundException('无权限');
    return job;
  }

  async apply(context: TenantContext, appId: string, id: string, { offset, size }: z.infer<typeof batchInput>) {
    return withTenantTransaction(context, async (tx) => {
      const grant = await this.schema.writable(tx, context, appId, 'import');
      const job = await this.job(tx, context, appId, id, true);
      if (offset < job.imported) return jobSummary(job);
      if (offset !== job.imported) throw new ConflictException({ message: 'Resume at the current import offset', imported: job.imported });
      if (job.schemaVersion !== grant.app.publishedSchemaVersion) throw new ConflictException('Schema changed. Run preflight again.');
      const batch = job.rows.slice(offset, offset + size);
      for (const row of batch) {
        try {
          await this.writeCsvRow(tx, context, appId, row, grant);
        } catch (error) {
          if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
          throw new ConflictException({ message: 'Batch rolled back', line: row.line, offset, issues: error.getResponse() });
        }
      }
      const [updated] = await tx.update(csvJobs).set({ imported: offset + batch.length })
        .where(this.scope(context, appId, id)).returning();
      return jobSummary(updated);
    });
  }

  async errorReport(context: TenantContext, appId: string, id: string) {
    return withTenantTransaction(context, async (tx) => {
      await this.schema.access(tx, context, appId, 'import');
      const job = await this.job(tx, context, appId, id);
      const reserved = new Set(job.headers);
      const suffix = (name: string) => {
        while (reserved.has(name)) name = '_' + name;
        return name;
      };
      return csvFile([[...job.headers, suffix('_row'), suffix('_errors')], ...job.errors.map(({ line, cells, issues }) =>
        [...cells, String(line), JSON.stringify(issues)])], 'import-errors.csv');
    });
  }

  private async exportRelated(tx: TenantTransaction, context: TenantContext, config: RelatedConfiguration, data: RecordData) {
    try {
      const page = await this.query.relatedPage(tx, context, config, data);
      if (BigInt(page.count) > 10000n) throw new BadRequestException('Related records exceed the 10,000-row export limit');
      const lines = [page.count + ' related records. ' + relatedCountHelp];
      let current = page;
      while (true) {
        for (const item of current.items) {
          if (current.columns.length) lines.push(current.columns.map(({ fieldId, name }) => name + ': ' + (item[fieldId] ?? '')).join(' | '));
        }
        if (!current.next || !current.columns.length) break;
        current = await this.query.relatedPage(tx, context, config, data, current.next);
      }
      return lines.join('\n');
    } catch (error) {
      if (error instanceof NotFoundException) return '';
      throw error;
    }
  }

  async export(context: TenantContext, appId: string, { view: viewId, attachments, ...filters }: z.infer<typeof exportQuery>) {
    const bundle = attachments === 'true';
    const { csv, attachmentIds, richText, snapshots, hasTables } = await withTenantTransaction(context, async (tx) => {
      const { where, fields, data, view, sort, descending } = await this.query.scope(tx, context, appId, viewId, 'export');
      const visible = new Map(fields.map((field) => [field.fieldId, field]));
      const columns = view?.columns.length ? view.columns.map(({ fieldId }) => visible.get(fieldId)!) : fields;
      const selectedIds = new Set(columns.flatMap((field) => field.lookup
        ? [field.lookup.localKeyFieldId, ...field.lookup.copies.map(({ targetFieldId }) => targetFieldId)] : [field.fieldId]));
      const selected = [...selectedIds].flatMap((id) => {
        const field = visible.get(id);
        return field && field.type !== 'layout' ? [field] : [];
      });
      const eligible = tx.select({ id: records.id, recordNo: records.recordNo, data, schemaVersion: records.schemaVersion }).from(records).$dynamic();
      const search = 'field' in filters ? filters : undefined;
      if (search) {
        const hits = this.search.matchingRecords(tx, context, appId, fields, search);
        eligible.innerJoin(hits, eq(records.id, hits.recordId));
      }
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      const rows = await eligible.where(where)
        .orderBy(...(sort ? [sql`${sort} ${descending ? sql`DESC` : sql`ASC`} NULLS LAST`, records.recordNo] : [records.recordNo]))
        .limit(10001);
      if (rows.length > 10000) throw new BadRequestException('Export exceeds 10,000 rows. Narrow the view filters.');
      const parentFields = selected.filter(({ table }) => !table);
      const snapshotIds = lookupTargets(fields);
      const snapshots = parentFields.some(({ fieldId }) => snapshotIds.has(fieldId));
      const tables = selected.flatMap((field) => field.table ? [{ ...field, table: field.table }] : []);
      const hasTables = tables.length > 0;
      const childColumns = tables.flatMap(({ fieldId, code, table }) => table.fields.map((child) =>
        ({ tableId: fieldId, childId: child.fieldId, header: code + '.' + child.code })));
      const parentHeaders = parentFields.map(({ code, fieldId }) =>
        snapshotIds.has(fieldId) ? 'snapshot:' + code : hasTables ? 'field:' + code : code);
      const csv = [hasTables ? [...tableHeaders, ...parentHeaders, ...childColumns.map(({ header }) => header)] : parentHeaders];
      const tableRows = hasTables && rows.length ? await tx.select().from(recordTableRows).where(and(
        eq(recordTableRows.tenantId, context.tenantId), eq(recordTableRows.appId, appId),
        inArray(recordTableRows.recordId, rows.map(({ id }) => id)), inArray(recordTableRows.fieldId, tables.map(({ fieldId }) => fieldId)),
      )).orderBy(recordTableRows.fieldId, recordTableRows.rowOrder).limit(10001) : [];
      if (tableRows.length > 10000) throw new BadRequestException('Flattened export exceeds 10,000 rows');
      const byRecord = new Map<string, typeof tableRows>();
      for (const tableRow of tableRows) {
        const children = byRecord.get(tableRow.recordId);
        if (children) children.push(tableRow);
        else byRecord.set(tableRow.recordId, [tableRow]);
      }
      const tableById = new Map(tables.map((field) => [field.fieldId, field]));
      const hasRelated = selected.some(({ type }) => type === 'related');
      const schemas = new Map<number, Awaited<ReturnType<AppSchemaService['getFields']>>>();
      for (const row of rows) {
        if (hasRelated && !schemas.has(row.schemaVersion)) {
          schemas.set(row.schemaVersion, await this.schema.getFields(tx, context, appId, row.schemaVersion));
        }
        const cells = [];
        for (const { fieldId, type } of parentFields) {
          const raw = row.data[fieldId] ?? '';
          const related = type === 'related' && schemas.get(row.schemaVersion)?.find((field) => field.fieldId === fieldId)?.related;
          cells.push(related && visible.has(related.localFieldId) ? await this.exportRelated(tx, context, related, row.data)
            : type === 'richText' ? richTextPlain(raw) : raw);
        }
        if (!hasTables) csv.push(cells);
        else {
          const childRows = byRecord.get(row.id) ?? [];
          const recordNo = row.recordNo.toString();
          if (!childRows.length) csv.push([recordNo, '', '', '', ...cells, ...childColumns.map(() => '')]);
          for (const { fieldId, rowOrder, data } of childRows) {
            const table = tableById.get(fieldId)!;
            csv.push([recordNo, table.code, table.name, String(rowOrder + 1), ...cells,
              ...childColumns.map(({ tableId, childId }) => tableId === fieldId ? data[childId] ?? '' : '')]);
          }
          if (csv.length > 10001) throw new BadRequestException('Flattened export exceeds 10,000 rows');
        }
      }
      return {
        csv, snapshots, hasTables,
        richText: selected.some(({ type }) => type === 'richText'),
        attachmentIds: bundle ? [...new Set(rows.flatMap(({ data }) => selected
          .filter(({ type }) => type === 'attachment').flatMap(({ fieldId }) => JSON.parse(data[fieldId] || '[]') as string[])))] : [],
      };
    }).catch((error) => {
      if (postgresErrorCode(error) === '57014') throw new ServiceUnavailableException('Export timed out. Narrow the filters and retry.');
      throw error;
    });
    if (!bundle) {
      const notes = [hasTables && 'subtable-rows', snapshots && 'lookup-snapshots', richText && 'rich-text-exported-as-plain-text'].filter(Boolean);
      return csvFile(csv, 'records' + (notes.length ? '-' + notes.join('-') : '') + '.csv');
    }
    if (attachmentIds.length > 256) throw new BadRequestException('Attachment bundle exceeds 256 files. Narrow the view filters.');
    const bytes: Record<string, Uint8Array> = { 'records.csv': Buffer.from(stringify(csv, { escape_formulas: true })) };
    const notes = [
      richText && 'Rich text fields were exported as plain text.',
      snapshots && 'Columns prefixed snapshot: contain read-only lookup snapshots.',
      hasTables && 'Subtable rows repeat parent values. To import rows, preserve record_no and __table, and use an existing parent.',
    ].filter(Boolean);
    if (notes.length) bytes['export-notes.txt'] = Buffer.from(notes.join('\n') + '\n');
    const manifest = [['id', 'name', 'sha256', 'bytes', 'path']];
    let total = 0;
    for (const id of attachmentIds) {
      const { data, file } = await this.files.readAuthorized(context, appId, id);
      total += data.length;
      if (total > 32 * 1024 * 1024) throw new BadRequestException('Attachment bundle exceeds 32 MiB. Narrow the view filters.');
      const path = 'attachments/' + file.id;
      bytes[path] = data;
      manifest.push([file.id, file.name, file.sha256!, String(file.bytes), path]);
    }
    bytes['attachments.csv'] = Buffer.from(stringify(manifest, { escape_formulas: true }));
    return new StreamableFile(Buffer.from(zipSync(bytes, { level: 0 })), {
      type: 'application/zip', disposition: 'attachment; filename="records-with-attachments.zip"',
    });
  }
}

@ApiTags('CSV')
@ApiBearerAuth()
@UseGuards(SessionGuard)
@Controller('apps/:appId/csv')
export class CsvController {
  constructor(private readonly csv: CsvService) {}

  @Post('preflight')
  preflight(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Body() body: unknown) {
    return this.csv.preflight(context, parseInput(identifier, appId), parseInput(preflightInput, body));
  }

  @Post(':jobId/apply')
  apply(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string,
    @Param('jobId') jobId: string, @Body() body: unknown) {
    return this.csv.apply(context, parseInput(identifier, appId), parseInput(identifier, jobId), parseInput(batchInput, body));
  }

  @Get(':jobId/errors')
  @ApiProduces('text/csv')
  errors(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Param('jobId') jobId: string) {
    return this.csv.errorReport(context, parseInput(identifier, appId), parseInput(identifier, jobId));
  }

  @Get('export')
  @ApiProduces('text/csv', 'application/zip')
  export(@AuthenticatedTenant() context: TenantContext, @Param('appId') appId: string, @Query() query: unknown) {
    return this.csv.export(context, parseInput(identifier, appId), parseInput(exportQuery, query));
  }
}
