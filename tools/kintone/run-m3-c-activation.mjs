#!/usr/bin/env node
/**
 * P4-T3a M3-C activation driver: fresh extraction of the three kintone
 * fixture applications (A cases, B customers, C categories) with the P4
 * resolution mechanisms (choice identifiers, directory identities,
 * categories, six-item lookup verification), M1 package build, ordered
 * import into an ISOLATED target tenant (B -> A -> C), activation, and a
 * full numeric read-back gate. This supersedes run-m3-c.mjs for the
 * completion batch; the P2 runner is left untouched as the historical
 * PENDING_COMPLETION record.
 *
 * Required environment:
 *   KINTONE_SUBDOMAIN, KINTONE_API_TOKEN_A, KINTONE_API_TOKEN_B,
 *   KINTONE_API_TOKEN_C, KINTONE_FREEZE_WINDOW_CONFIRMED=true,
 *   KINTONE_CATEGORY_TREE_C (path to the out-of-band App C tree capture),
 *   KINTONE_REPORT_DIR,
 *   SUZUBASE_TARGET_API_ORIGIN, SUZUBASE_TARGET_ACCESS_TOKEN,
 *   SUZUBASE_TARGET_ISOLATED=true,
 *   SUZUBASE_TARGET_USER_MAPPING_BY_CODE (JSON: kintone user code ->
 *     target tenant user id; every directory user must be mapped)
 * Optional: KINTONE_APP_A_ID (2), KINTONE_APP_B_ID (1), KINTONE_APP_C_ID (4).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  KintoneSourceAdapter, buildM1CompatiblePackage, stableSourceUuid,
} from '../../apps/api/dist/kintone-import.js';
import { verifyPackage } from '../../apps/api/dist/export-package.js';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const truthy = (name) => ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase());
if (!truthy('KINTONE_FREEZE_WINDOW_CONFIRMED')) {
  throw new Error('KINTONE_FREEZE_WINDOW_CONFIRMED=true is required');
}
if (!truthy('SUZUBASE_TARGET_ISOLATED')) {
  throw new Error('SUZUBASE_TARGET_ISOLATED=true is required: activation runs only against an isolated target');
}
const subdomain = required('KINTONE_SUBDOMAIN');
const sourceOrigin = `https://${subdomain}.cybozu.com`;
const appIds = {
  A: process.env.KINTONE_APP_A_ID ?? '2',
  B: process.env.KINTONE_APP_B_ID ?? '1',
  C: process.env.KINTONE_APP_C_ID ?? '4',
};
const tokens = {
  A: required('KINTONE_API_TOKEN_A'),
  B: required('KINTONE_API_TOKEN_B'),
  C: required('KINTONE_API_TOKEN_C'),
};
const reportDir = resolve(required('KINTONE_REPORT_DIR'));
const targetOrigin = required('SUZUBASE_TARGET_API_ORIGIN').replace(/\/$/, '');
const targetToken = required('SUZUBASE_TARGET_ACCESS_TOKEN');
const userMappingByCode = JSON.parse(required('SUZUBASE_TARGET_USER_MAPPING_BY_CODE'));
const categoryTreeC = JSON.parse(await readFile(required('KINTONE_CATEGORY_TREE_C'), 'utf8'));

const ACCEPTS = {
  acceptCalcDataOnly: true,
  acceptLayoutDowngrade: true,
  acceptWorkflowDowngrade: true,
  acceptPermissionDowngrade: true,
  tolerateUnavailable: ['processDefinitions'],
};

async function targetRequest(path, { method = 'GET', expected = 200, token = targetToken,
  contentType, body } = {}) {
  const response = await fetch(targetOrigin + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body)
        ? { 'content-type': 'application/json' } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    body: body !== undefined && typeof body === 'object' && !Buffer.isBuffer(body)
      ? JSON.stringify(body) : body,
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== expected) {
    throw new Error(`target ${method} ${path} returned ${response.status}: ${JSON.stringify(payload)?.slice(0, 400)}`);
  }
  return payload;
}

const adapterFor = (token) => new KintoneSourceAdapter(sourceOrigin, token);
const completionStatusOf = (run) => typeof run?.completion === 'string'
  ? run.completion : run?.completion?.status;
const pendingIsEmpty = (run) => {
  const pending = run?.pending ?? {};
  return Object.values(pending).every((value) =>
    value === null || value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && Object.keys(value).length === 0));
};

const gates = [];
const gate = (name, expected, actual) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  gates.push({ name, expected, actual, pass });
  return pass;
};

async function importPackage(archive, mappings) {
  const job = await targetRequest('/imports/upload', {
    method: 'POST', expected: 201, contentType: 'application/octet-stream', body: archive,
  });
  const validated = await targetRequest(`/imports/${job.id}/validate`, { method: 'POST', expected: 201 });
  if (validated.status !== 'staging') {
    throw new Error(`import ${job.id} did not reach staging: ${JSON.stringify(validated).slice(0, 400)}`);
  }
  if (mappings && Object.keys(mappings).length) {
    await targetRequest(`/imports/${job.id}/mappings`, { method: 'PUT', expected: 200, body: mappings });
  }
  const issued = await targetRequest(`/imports/${job.id}/migration-token`, { method: 'POST', expected: 201 });
  const run = await targetRequest(`/imports/${job.id}/run`, {
    method: 'POST', expected: 201, token: issued.token,
  });
  return { job, run };
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  const report = {
    startedAt: new Date().toISOString(), sourceOrigin, appIds,
    sourceUnavailable: {}, extractions: {}, packages: {}, imports: {}, gates,
    migrationNotes: [
      'Comment bodies are copied verbatim with their source timestamps; authorship is carried ' +
        'through package directory entries and mapped explicitly to dedicated target users ' +
        '(the original kintone accounts do not exist in the target tenant).',
      'Record creators/modifiers and creation/update timestamps are carried from the source ' +
        'API values through the same explicit directory mapping.',
      'Workflow definitions are SOURCE_UNAVAILABLE for API tokens (the process-definitions ' +
        'endpoint answers 404); status values are carried as record data and their distribution ' +
        'is verified on the target. No workflow engine state is fabricated.',
      'Permissions and form layout are accepted as explicit administrator downgrades ' +
        '(P2 precedent); the evidence stays in each package.',
    ],
  };

  // 1. Fresh extraction: B first (A's lookup verification needs B's fields).
  const extractionB = await adapterFor(tokens.B).extract(appIds.B, true, { ...ACCEPTS });
  const extractionA = await adapterFor(`${tokens.A},${tokens.B}`).extract(appIds.A, true, {
    ...ACCEPTS,
    relatedApps: {
      [appIds.B]: { fields: extractionB.compatibility.map((item) => item.sourceConfig) },
    },
  });
  const extractionC = await adapterFor(tokens.C).extract(appIds.C, true, {
    ...ACCEPTS, categoryTree: categoryTreeC,
  });
  const extractions = { A: extractionA, B: extractionB, C: extractionC };
  for (const [key, extraction] of Object.entries(extractions)) {
    report.extractions[key] = {
      records: extraction.records.length,
      comments: extraction.comments.length,
      attachments: extraction.attachments.length,
      subtableRows: extraction.subtableRows.length,
      packageReady: extraction.packageReady,
      unresolved: extraction.compatibility
        .filter((item) => item.status === 'UNRESOLVED')
        .map((item) => item.sourceFieldCode),
      gateProblems: extraction.gateProblems,
    };
    report.sourceUnavailable[key] = extraction.evidence.unavailable.map(({ item }) => item);
    if (!extraction.packageReady) {
      report.conclusion = 'BLOCKED_EXTRACTION';
      await writeFile(resolve(reportDir, 'm3-c-activation-report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ result: 'BLOCKED_EXTRACTION', report: report.extractions }));
      process.exit(2);
    }
  }

  // Directory users must all be explicitly mapped; groups/organizations are
  // asserted empty for this fixture (a non-empty set would need mappings).
  const userMappingFor = (appId) => {
    const mapping = {};
    for (const [code, targetUserId] of Object.entries(userMappingByCode)) {
      mapping[stableSourceUuid(`kintone:${appId}:user:${code}`)] = targetUserId;
    }
    return mapping;
  };

  // 2. Packages.
  const keyFieldCode = extractionA.compatibility
    .find((item) => item.lookupResolution)?.lookupResolution.relatedKeyField;
  const recordsByKey = {};
  for (const record of extractionB.records) {
    recordsByKey[String(record[keyFieldCode]?.value ?? '')] =
      stableSourceUuid(`kintone:${appIds.B}:record:${String(record.$id?.value ?? '')}`);
  }
  const packageB = buildM1CompatiblePackage(extractionB);
  const packageA = buildM1CompatiblePackage(extractionA, {
    relatedApps: { [appIds.B]: { recordsByKey } },
  });
  const packageC = buildM1CompatiblePackage(extractionC);
  const packages = { A: packageA, B: packageB, C: packageC };
  for (const [key, pkg] of Object.entries(packages)) {
    const verification = verifyPackage(pkg.archive);
    report.packages[key] = {
      counts: verification.manifest.counts.actual, problems: verification.problems,
    };
    if (verification.problems.length) {
      report.conclusion = 'BLOCKED_PACKAGE';
      await writeFile(resolve(reportDir, 'm3-c-activation-report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ result: 'BLOCKED_PACKAGE', key, problems: verification.problems }));
      process.exit(2);
    }
    await writeFile(resolve(reportDir, `m3-c-package-${key}.zip`), pkg.archive);
  }

  // 3. Ordered import + activation: B, then A (with the lookup dependency
  // decision), then C.
  const importedB = await importPackage(packageB.archive, { users: userMappingFor(appIds.B) });
  report.imports.B = { jobId: importedB.job.id, run: importedB.run };
  gate('B import completion', 'complete', completionStatusOf(importedB.run));
  const activatedB = await targetRequest(`/imports/${importedB.job.id}/activate`, { method: 'POST', expected: 201 });
  gate('B import pending empty', true, pendingIsEmpty(importedB.run));
  gate('B activation', 'activated', activatedB.status);
  const targetAppB = importedB.run.targetAppId;

  const targetBDetail = await targetRequest(`/apps/${targetAppB}`);
  const targetBFieldByCode = Object.fromEntries(
    (targetBDetail.fields ?? []).map((field) => [field.code, field.fieldId]));
  const lookupItem = extractionA.compatibility.find((item) => item.lookupResolution);
  const resolution = lookupItem.lookupResolution;
  const foreignCodes = [...new Set([
    resolution.relatedKeyField,
    ...resolution.copies.map((copy) => copy.relatedField),
    ...resolution.pickerFields,
    ...(resolution.sort ? [resolution.sort.field] : []),
  ])];
  const fieldMappings = {};
  for (const code of foreignCodes) {
    const targetFieldId = targetBFieldByCode[code];
    if (!targetFieldId) throw new Error(`target B has no field with code ${code}`);
    fieldMappings[stableSourceUuid(`kintone:${appIds.B}:field:${code}`)] = targetFieldId;
  }
  const importedA = await importPackage(packageA.archive, {
    users: userMappingFor(appIds.A),
    dependencies: {
      [stableSourceUuid(`kintone:${appIds.A}:field:${lookupItem.sourceFieldCode}`)]: {
        action: 'map', targetAppId: targetAppB, fieldMappings,
      },
    },
  });
  report.imports.A = { jobId: importedA.job.id, run: importedA.run };
  gate('A import completion', 'complete', completionStatusOf(importedA.run));
  gate('A import pending empty', true, pendingIsEmpty(importedA.run));
  const activatedA = await targetRequest(`/imports/${importedA.job.id}/activate`, { method: 'POST', expected: 201 });
  gate('A activation', 'activated', activatedA.status);
  const targetAppA = importedA.run.targetAppId;

  const importedC = await importPackage(packageC.archive, { users: userMappingFor(appIds.C) });
  report.imports.C = { jobId: importedC.job.id, run: importedC.run };
  gate('C import completion', 'complete', completionStatusOf(importedC.run));
  const activatedC = await targetRequest(`/imports/${importedC.job.id}/activate`, { method: 'POST', expected: 201 });
  gate('C import pending empty', true, pendingIsEmpty(importedC.run));
  gate('C activation', 'activated', activatedC.status);
  const targetAppC = importedC.run.targetAppId;
  report.targetApps = { A: targetAppA, B: targetAppB, C: targetAppC };

  // 4. Read-back gates through the target API.
  const listRecords = async (appId, query = '') =>
    (await targetRequest(`/apps/${appId}/records?limit=100${query}`)).items ?? [];
  const recordsB = await listRecords(targetAppB);
  gate('B records', 5, recordsB.length);
  const recordsA = await listRecords(targetAppA);
  gate('A records', 12, recordsA.length);
  const recordsC = await listRecords(targetAppC);
  gate('C records', 5, recordsC.length);

  const detailA = await targetRequest(`/apps/${targetAppA}`);
  const fieldByCodeA = Object.fromEntries((detailA.fields ?? []).map((f) => [f.code, f]));
  const statusFieldId = fieldByCodeA['状态']?.fieldId;
  const distribution = {};
  for (const record of recordsA) {
    const value = record.data?.[statusFieldId];
    distribution[value] = (distribution[value] ?? 0) + 1;
  }
  const sourceDistribution = {};
  for (const record of extractionA.records) {
    const value = String(record['状态']?.value ?? '');
    sourceDistribution[value] = (sourceDistribution[value] ?? 0) + 1;
  }
  gate('A status distribution (target vs source)', sourceDistribution, distribution);
  gate('A status distribution counts', [1, 1, 10],
    Object.values(distribution).sort((a, b) => a - b));

  // Lookup links: the stored reference of every A record must resolve
  // through the live lookup machinery (refresh preview) to the B record
  // carrying the same key value, yielding that record's copied name.
  const lookupFieldId = fieldByCodeA[lookupItem.sourceFieldCode]?.fieldId;
  const keyFieldIdA = fieldByCodeA[`${lookupItem.sourceFieldCode}__key`]?.fieldId;
  const bKeyFieldId = (targetBDetail.fields ?? [])
    .find((f) => f.code === resolution.relatedKeyField)?.fieldId;
  const bNameFieldId = (targetBDetail.fields ?? [])
    .find((f) => f.code === 'customer_name')?.fieldId;
  const bNameByKey = new Map();
  for (const record of recordsB) {
    bNameByKey.set(record.data?.[bKeyFieldId], record.data?.[bNameFieldId]);
  }
  let linked = 0;
  const linkMismatches = [];
  for (const record of recordsA) {
    const keyValue = record.data?.[keyFieldIdA];
    try {
      const refresh = await targetRequest(
        `/apps/${targetAppA}/records/${record.id}/lookups/${lookupFieldId}/refresh`);
      const expectedName = bNameByKey.get(keyValue);
      if (expectedName && JSON.stringify(refresh.changes ?? {}).includes(expectedName)) {
        linked += 1;
      } else {
        linkMismatches.push({ recordNo: record.recordNo, keyValue, changes: refresh.changes });
      }
    } catch (error) {
      linkMismatches.push({ recordNo: record.recordNo, keyValue, error: String(error).slice(0, 160) });
    }
  }
  gate('A lookup links resolved', 12, linked);
  if (linkMismatches.length) report.linkMismatches = linkMismatches;

  // Comments on the three commented source records (2, 4, 8).
  let commentTotal = 0;
  for (const record of recordsA) {
    const comments = await targetRequest(`/apps/${targetAppA}/records/${record.id}/comments`);
    commentTotal += (comments.items ?? comments.comments ?? []).length;
  }
  gate('A comments', 3, commentTotal);

  // Categories on C: tree nodes, per-record assignments by node name, and
  // the descendant-inclusive filter on the Kanto node.
  const detailC = await targetRequest(`/apps/${targetAppC}`);
  const categories = detailC.categories ?? { enabled: false, nodes: [] };
  gate('C categories enabled', true, categories.enabled === true);
  gate('C category nodes', 5, (categories.nodes ?? []).length);
  const nodeNameById = Object.fromEntries((categories.nodes ?? []).map((n) => [n.id, n.name]));
  const expectedAssignments = { 1: ['东京'], 2: ['大阪'], 3: ['东京', '神奈川'], 4: ['关东'], 5: [] };
  const actualAssignments = {};
  for (const record of recordsC) {
    actualAssignments[record.recordNo] = (record.categoryIds ?? [])
      .map((id) => nodeNameById[id]).sort();
  }
  const expectedSorted = Object.fromEntries(Object.entries(expectedAssignments)
    .map(([key, value]) => [key, [...value].sort()]));
  gate('C category assignments by recordNo', expectedSorted, actualAssignments);
  const kantoNode = (categories.nodes ?? []).find((n) => n.name === '关东');
  const kantoRecords = await listRecords(targetAppC, `&category=${kantoNode.id}`);
  gate('C category filter Kanto subtree recordNos', ['1', '3', '4'],
    kantoRecords.map((r) => String(r.recordNo)).sort());

  // Job-report counts for attachments and subtable rows on A.
  gate('A attachments (job report target count)', 4, importedA.run.report?.counts?.target?.attachments);
  gate('A table rows (job report target count)', 17, importedA.run.report?.counts?.target?.tableRows);
  gate('B attachments (job report target count)', 0, importedB.run.report?.counts?.target?.attachments);
  // The run report reconciles source vs target counts; every reconciled
  // kind must match (the completion flag alone does not check comments).
  const aCounts = importedA.run.report?.counts ?? {};
  gate('A job report count matches', true,
    Object.values(aCounts.matches ?? {}).every(Boolean));
  gate('A comments (job report target count)', 3, aCounts.target?.comments);
  const bCounts = importedB.run.report?.counts ?? {};
  gate('B job report count matches', true,
    Object.values(bCounts.matches ?? {}).every(Boolean));
  const cCounts = importedC.run.report?.counts ?? {};
  gate('C job report count matches', true,
    Object.values(cCounts.matches ?? {}).every(Boolean));

  const failed = gates.filter(({ pass }) => !pass);
  report.conclusion = failed.length ? 'PENDING_COMPLETION' : 'COMPLETE';
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(reportDir, 'm3-c-activation-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    result: report.conclusion, gates: gates.length, failed: failed.length,
    failedNames: failed.map(({ name }) => name),
  }));
  if (failed.length) process.exit(3);
}

await main();
