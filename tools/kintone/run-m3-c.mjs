#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiModule = await import(new URL('../../apps/api/dist/kintone-import.js', import.meta.url));
const packageModule = await import(new URL('../../apps/api/dist/export-package.js', import.meta.url));
const {
  KintoneSourceAdapter, buildM1CompatiblePackage, validateKintoneDomain,
} = apiModule;
const { verifyPackage } = packageModule;

const reportDir = resolve(process.env.KINTONE_REPORT_DIR ?? './kintone-reports');
const dryRun = process.env.KINTONE_DRY_RUN === 'true';
let targetOrigin;
try { targetOrigin = new URL(process.env.SUZUBASE_TARGET_API_ORIGIN); }
catch { console.error('SUZUBASE_TARGET_API_ORIGIN must be an absolute URL'); process.exit(2); }
const required = [
  'KINTONE_SUBDOMAIN', 'KINTONE_APP_A_ID', 'KINTONE_APP_B_ID',
  'KINTONE_API_TOKEN_A', 'KINTONE_API_TOKEN_B',
  'SUZUBASE_TARGET_API_ORIGIN', 'SUZUBASE_TARGET_ACCESS_TOKEN',
];
const absent = required.filter((name) => !process.env[name]);
if (absent.length) {
  console.error(`Missing required environment variables: ${absent.join(', ')}`);
  process.exit(2);
}
if (process.env.KINTONE_FREEZE_WINDOW_CONFIRMED !== 'true') {
  console.error('KINTONE_FREEZE_WINDOW_CONFIRMED=true is required; freeze both source apps before running');
  process.exit(2);
}
if (process.env.SUZUBASE_TARGET_ISOLATED !== 'true') {
  console.error('SUZUBASE_TARGET_ISOLATED=true is required for the target instance');
  process.exit(2);
}
if (targetOrigin.username || targetOrigin.password || targetOrigin.pathname !== '/' ||
  targetOrigin.search || targetOrigin.hash ||
  (dryRun && (!['http:', 'https:'].includes(targetOrigin.protocol) ||
    !['127.0.0.1', '::1', 'localhost', 'api'].includes(targetOrigin.hostname))) ||
  (!dryRun && targetOrigin.protocol !== 'https:')) {
  console.error('Target must be an isolated HTTPS origin (or a local origin in dry-run mode)');
  process.exit(2);
}
if (dryRun && !process.env.KINTONE_MOCK_ORIGIN) {
  console.error('KINTONE_MOCK_ORIGIN is required in dry-run mode');
  process.exit(2);
}
if (process.env.KINTONE_MOCK_ORIGIN && !dryRun) {
  console.error('KINTONE_MOCK_ORIGIN is only permitted with KINTONE_DRY_RUN=true');
  process.exit(2);
}

const subdomain = process.env.KINTONE_SUBDOMAIN;
if (!/^[a-z0-9][a-z0-9-]*$/i.test(subdomain)) {
  console.error('KINTONE_SUBDOMAIN must contain only a subdomain label');
  process.exit(2);
}
const sourceOrigin = `https://${subdomain}.cybozu.com`;
let validatedOrigin;
try {
  validatedOrigin = validateKintoneDomain(sourceOrigin);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid kintone source domain');
  process.exit(2);
}

const mockOrigin = process.env.KINTONE_MOCK_ORIGIN;
let fetcher = fetch;
if (mockOrigin) {
  let mock;
  try { mock = new URL(mockOrigin); } catch { console.error('Invalid local mock origin'); process.exit(2); }
  if (!dryRun || mock.username || mock.password || mock.pathname !== '/' || mock.search || mock.hash ||
    !['http:', 'https:'].includes(mock.protocol) ||
    !['127.0.0.1', '::1', 'localhost'].includes(mock.hostname)) {
    console.error('KINTONE_MOCK_ORIGIN must be a loopback HTTP(S) fixture in dry-run mode');
    process.exit(2);
  }
  fetcher = (input, init) => {
    const requestUrl = new URL(input);
    return fetch(new URL(requestUrl.pathname + requestUrl.search, mock), init);
  };
}

mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const writePrivateJson = (path, value) =>
  writeFileSync(path, JSON.stringify(value, (_key, item) => item, 2), { mode: 0o600 });
function entryCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return 0;
  return ['rights', 'states', 'actions'].reduce((count, key) => {
    const entry = value[key];
    return count + (Array.isArray(entry) ? entry.length :
      entry && typeof entry === 'object' ? Object.keys(entry).length : 0);
  }, 0) || (value.processes && typeof value.processes === 'object'
    ? Object.keys(value.processes).length : 0);
}
function sourceAttachmentCount(extraction) {
  let count = 0;
  for (const field of extraction.compatibility) {
    if (field.sourceType === 'FILE') {
      for (const record of extraction.records) count += record[field.sourceFieldCode]?.value?.length ?? 0;
    }
    if (field.sourceType === 'SUBTABLE') {
      for (const record of extraction.records) {
        for (const row of record[field.sourceFieldCode]?.value ?? []) {
          for (const value of Object.values(row.value ?? {})) {
            count += value?.value?.filter?.((file) => file?.fileKey).length ?? 0;
          }
        }
      }
    }
  }
  return count;
}
const checkpointPath = (appId) => resolve(reportDir, `m3-c-${appId}.checkpoint.json`);
function readCheckpoint(appId) {
  if (process.env.KINTONE_RESUME_CHECKPOINT !== 'true') return undefined;
  try {
    const parsed = JSON.parse(readFileSync(checkpointPath(appId), 'utf8'));
    parsed.attachments = parsed.attachments.map(({ bodyBase64, ...file }) => ({
      ...file, body: bodyBase64 ? new Uint8Array(Buffer.from(bodyBase64, 'base64')) : undefined,
    }));
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}
function saveCheckpoint(checkpoint) {
  writePrivateJson(checkpointPath(checkpoint.appId), {
    ...checkpoint,
    attachments: checkpoint.attachments.map(({ body, ...file }) => ({
      ...file, bodyBase64: body ? Buffer.from(body).toString('base64') : null,
    })),
  });
}

async function targetRequest(path, { method = 'GET', body, binary = false, token } = {}) {
  const response = await fetch(new URL(path, targetOrigin), {
    method,
    headers: {
      Authorization: `Bearer ${token ?? process.env.SUZUBASE_TARGET_ACCESS_TOKEN}`,
      ...(body && !binary ? { 'Content-Type': 'application/json' } : {}),
      ...(binary ? { 'Content-Type': 'application/octet-stream' } : {}),
    },
    body: binary ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const raw = binary ? null : await response.text();
  let parsed = null;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { parsed = { message: raw.slice(0, 1000) }; }
  }
  if (!response.ok) {
    throw new Error(`SuzuBase ${method} ${path} failed with HTTP ${response.status}: ${
      parsed?.message ?? parsed?.error ?? response.statusText}`);
  }
  return binary ? response : parsed;
}

async function importPackage(archive) {
  const uploaded = await targetRequest('/imports/upload', { method: 'POST', body: archive, binary: true });
  const job = await uploaded.json();
  const validated = await targetRequest(`/imports/${job.id}/validate`, { method: 'POST' });
  if (validated.status !== 'staging') return { jobId: job.id, status: validated.status, validated };
  const migration = await targetRequest(`/imports/${job.id}/migration-token`, { method: 'POST' });
  const run = await targetRequest(`/imports/${job.id}/run`, {
    method: 'POST', token: migration.token,
  });
  const detail = await targetRequest(`/imports/${job.id}`);
  if (run.status !== 'ready') return { jobId: job.id, status: run.status, run, detail };
  const pending = detail.pending ?? {};
  if (run.completion !== 'complete' || pending.unmappedUsers?.length ||
    pending.unmappedGroups?.length || pending.dependencies?.length || pending.references?.length) {
    return { jobId: job.id, status: 'PENDING_COMPLETION', run, detail };
  }
  const activated = await targetRequest(`/imports/${job.id}/activate`, { method: 'POST' });
  return { jobId: job.id, status: activated.status, run, detail, activated };
}

const report = {
  runId: randomUUID(),
  mode: dryRun ? 'DRY_RUN' : 'REAL_RUN',
  source: { subdomain, applications: [] },
  target: { isolated: true, origin: targetOrigin.origin },
  freezeWindow: {
    confirmed: true,
    rule: 'No other writer may modify either fixture app from extraction start through extraction end.',
  },
  dataCompleteness: { numerator: 0, denominator: 0, rate: null },
  functionalEquivalenceCount: 0,
  unresolvedDependencyCount: 0,
  explicitDowngrades: [],
  sourceUnavailable: [],
};
let blocked = false;
let pendingCompletion = false;

for (const [label, appId, apiToken] of [
  ['A', process.env.KINTONE_APP_A_ID, process.env.KINTONE_API_TOKEN_A],
  ['B', process.env.KINTONE_APP_B_ID, process.env.KINTONE_API_TOKEN_B],
]) {
  const appReport = {
    label, appId,
    precheckStartedAt: new Date().toISOString(),
    precheckEndedAt: null,
    extractionStartedAt: null,
    extractionEndedAt: null,
    sourceRecordIdRange: null,
    sourceGaps: [],
    status: 'BLOCKED',
  };
  report.source.applications.push(appReport);
  try {
    const adapter = new KintoneSourceAdapter(
      validatedOrigin, apiToken, 15000, 2, fetcher,
    );
    const precheck = await adapter.preflight(appId);
    appReport.precheckEndedAt = new Date().toISOString();
    appReport.precheck = {
      availableApis: Object.keys(precheck.available),
      unavailableApis: precheck.unavailable,
    };
    appReport.sourceGaps.push(...precheck.unavailable);
    const savedCheckpoint = readCheckpoint(appId);
    appReport.extractionStartedAt = savedCheckpoint?.extractionStartedAt ?? new Date().toISOString();
    let activeCheckpoint;
    const extraction = await adapter.extract(appId, true, {
      acceptCalcDataOnly: process.env.KINTONE_ACCEPT_CALC_DATA_ONLY === 'true',
      acceptLayoutDowngrade: process.env.KINTONE_ACCEPT_LAYOUT_DOWNGRADE === 'true',
      acceptWorkflowDowngrade: process.env.KINTONE_ACCEPT_WORKFLOW_DOWNGRADE === 'true',
      acceptPermissionDowngrade: process.env.KINTONE_ACCEPT_PERMISSION_DOWNGRADE === 'true',
      checkpoint: savedCheckpoint,
      onCheckpoint: (checkpoint) => {
        activeCheckpoint = { ...checkpoint, extractionStartedAt: appReport.extractionStartedAt };
        saveCheckpoint(activeCheckpoint);
      },
    });
    appReport.extractionEndedAt = new Date().toISOString();
    activeCheckpoint ??= {
      appId, lastRecordId: null, records: extraction.records, comments: extraction.comments,
      attachments: extraction.attachments, subtableRows: extraction.subtableRows,
      subtableStates: extraction.subtableStates, unavailable: extraction.evidence.unavailable,
      extractionStartedAt: appReport.extractionStartedAt,
    };
    for (const gap of extraction.evidence.unavailable.filter(({ item }) => item.startsWith('attachment:'))) {
      const match = gap.item.match(/^attachment:([^:]+):([^:]+):(.+)$/);
      if (!match) continue;
      const [, recordId, fieldCode, fileKey] = match;
      const record = extraction.records.find((entry) => String(entry.$id?.value ?? '') === recordId);
      const topLevel = record?.[fieldCode]?.value?.find((file) => file.fileKey === fileKey);
      let nested;
      if (!topLevel && fieldCode.includes('.')) {
        const [tableCode, childCode] = fieldCode.split('.', 2);
        nested = record?.[tableCode]?.value?.flatMap((row) => row.value?.[childCode]?.value ?? [])
          .find((file) => file.fileKey === fileKey);
      }
      const sourceFile = topLevel ?? nested;
      if (!sourceFile) continue;
      try {
        activeCheckpoint = await adapter.retryAttachment(activeCheckpoint, {
          recordId, fieldCode, fileKey, name: sourceFile.name ?? null,
        });
        const unavailable = gap;
        extraction.evidence.unavailable = extraction.evidence.unavailable
          .filter((entry) => entry.item !== unavailable.item);
      } catch (error) {
        const retryReason = error instanceof Error ? error.message : 'attachment retry failed';
        extraction.evidence.unavailable = extraction.evidence.unavailable.map((entry) =>
          entry.item === gap.item ? { ...entry, reason: `${entry.reason}; independent retry failed: ${retryReason}` } : entry);
      }
    }
    saveCheckpoint({ ...activeCheckpoint, extractionStartedAt: appReport.extractionStartedAt });
    extraction.attachments = activeCheckpoint.attachments;
    extraction.subtableRows = activeCheckpoint.subtableRows;
    extraction.packageReady = extraction.evidence.unavailable.length === 0 &&
      extraction.blocking.length === 0 && extraction.gateProblems.length === 0 &&
      !extraction.compatibility.some(({ status }) => status === 'UNRESOLVED');
    appReport.extractedCounts = {
      fields: extraction.compatibility.length,
      records: extraction.records.length,
      subtableRows: extraction.subtableRows.length,
      attachments: extraction.attachments.length,
      comments: extraction.comments.length,
    };
    appReport.sourceDimensionCounts = {
      workflow: entryCount(extraction.sourceMetadata.workflow.status) +
        entryCount(extraction.sourceMetadata.workflow.definitions),
      permissions: ['app', 'record', 'field'].reduce((total, layer) =>
        total + entryCount(extraction.sourceMetadata.acl[layer]), 0),
      layout: Array.isArray(extraction.sourceMetadata.layout)
        ? extraction.sourceMetadata.layout.length
        : Array.isArray(extraction.sourceMetadata.layout?.layout)
          ? extraction.sourceMetadata.layout.layout.length : 0,
    };
    appReport.sourceRecordIdRange = extraction.evidence.recordIdRange;
    appReport.pendingGateProblems = extraction.gateProblems ?? [];
    appReport.explicitDowngrades = extraction.downgrades ?? [];
    appReport.sourceGaps = [...new Map(
      [...appReport.sourceGaps, ...extraction.evidence.unavailable]
        .map((gap) => [`${gap.item}:${gap.reason}`, gap]),
    ).values()];
    report.sourceUnavailable.push(...extraction.evidence.unavailable.map((gap) => ({ appId, ...gap })));
    report.functionalEquivalenceCount += extraction.compatibility
      .filter(({ status }) => status === 'EQUIVALENT').length;
    report.unresolvedDependencyCount += extraction.compatibility
      .filter(({ status }) => status === 'UNRESOLVED').length;
    report.unresolvedDependencies ??= [];
    report.unresolvedDependencies.push(...extraction.compatibility
      .filter(({ status }) => status === 'UNRESOLVED')
      .map(({ sourceFieldCode, reason }) => ({ appId, field: sourceFieldCode, reason })));
    report.explicitDowngrades.push(...extraction.compatibility
      .filter(({ status }) => status === 'DATA_ONLY')
      .map(({ sourceFieldCode, reason }) => ({ appId, field: sourceFieldCode, reason })));
    report.explicitDowngrades.push(...(extraction.downgrades ?? [])
      .map((downgrade) => ({ appId, ...downgrade })));
    const sourceAttachments = sourceAttachmentCount(extraction);
    report.dataCompleteness.denominator += extraction.records.length +
      extraction.subtableRows.length + sourceAttachments + extraction.comments.length;
    report.dataCompleteness.numerator += extraction.records.length +
      extraction.subtableRows.length +
      extraction.attachments.filter((file) => file.bytes !== null && file.sha256 !== null).length +
      extraction.comments.length;

    if (!extraction.packageReady) {
      appReport.sourceGaps.push(...extraction.blocking.map((field) => ({
        item: `field:${field.sourceFieldCode}`, reason: field.reason, evidence: field.sourceConfig,
      })));
      appReport.status = 'PENDING_COMPLETION';
      const hasSourceGap = extraction.evidence.unavailable.length > 0;
      if (hasSourceGap || extraction.blocking.length) blocked = true;
      else pendingCompletion = true;
      continue;
    }

    const sealed = buildM1CompatiblePackage(extraction);
    const verification = verifyPackage(sealed.archive);
    appReport.packageVerification = verification.problems;
    if (verification.problems.length) {
      appReport.status = 'BLOCKED';
      blocked = true;
      continue;
    }
    appReport.package = {
      formatVersion: sealed.manifest.formatVersion,
      counts: sealed.manifest.counts.actual,
    };
    const imported = await importPackage(sealed.archive);
    appReport.import = imported;
    appReport.status = imported.status;
    if (imported.status === 'PENDING_COMPLETION') pendingCompletion = true;
    else if (imported.status !== 'activated') blocked = true;
  } catch (error) {
    appReport.extractionEndedAt ??= new Date().toISOString();
    appReport.error = error instanceof Error ? error.message : 'M3-C application run failed';
    blocked = true;
  }
}

report.dataCompleteness.rate = report.dataCompleteness.denominator === 0 ? null :
  report.dataCompleteness.numerator / report.dataCompleteness.denominator;
report.dimensions = {
  structure: report.source.applications.map(({ appId, extractedCounts, sourceDimensionCounts, import: imported }) => ({
    appId, sourceFields: extractedCounts?.fields ?? null,
    targetFields: imported?.detail?.report?.counts?.target?.fields ?? null,
    sourceLayoutItems: sourceDimensionCounts?.layout ?? null,
  })),
  records: report.source.applications.map(({ appId, extractedCounts, import: imported }) => ({
    appId, source: extractedCounts?.records ?? null,
    target: imported?.detail?.report?.counts?.target?.records ?? null,
  })),
  subtableRows: report.source.applications.map(({ appId, extractedCounts, import: imported }) => ({
    appId, source: extractedCounts?.subtableRows ?? null,
    target: imported?.detail?.report?.counts?.target?.tableRows ?? null,
  })),
  attachments: report.source.applications.map(({ appId, extractedCounts, import: imported }) => ({
    appId, source: extractedCounts?.attachments ?? null,
    target: imported?.detail?.report?.counts?.target?.attachments ?? null,
  })),
  comments: report.source.applications.map(({ appId, extractedCounts, import: imported }) => ({
    appId, source: extractedCounts?.comments ?? null,
    target: imported?.detail?.report?.counts?.target?.comments ?? null,
  })),
  workflow: report.source.applications.map(({ appId, sourceDimensionCounts, import: imported }) => ({
    appId, source: sourceDimensionCounts?.workflow ?? null,
    target: imported?.detail?.report?.counts?.target?.workflowVersions ?? null,
  })),
  permissions: report.source.applications.map(({ appId, sourceDimensionCounts, import: imported }) => ({
    appId, source: sourceDimensionCounts?.permissions ?? null,
    target: imported?.detail?.report?.counts?.target?.aclEntries ?? null,
  })),
  externalDependencies: {
    unresolvedCount: report.unresolvedDependencyCount,
    explicitDowngrades: report.explicitDowngrades,
  },
  sourceGaps: report.sourceUnavailable,
};
report.extractionWindow = report.source.applications.map(({
  label, appId, extractionStartedAt, extractionEndedAt, sourceRecordIdRange,
}) => ({ label, appId, extractionStartedAt, extractionEndedAt, sourceRecordIdRange }));
const reportPath = resolve(reportDir, `m3-c-${report.runId}.json`);
writePrivateJson(reportPath, report);
console.log(JSON.stringify({
  report: reportPath,
  result: blocked ? 'BLOCKED' : pendingCompletion ? 'PENDING_COMPLETION' : 'ACTIVATED',
  applications: report.source.applications.map(({ label, status }) => ({ label, status })),
}));
if (blocked) process.exitCode = 1;
