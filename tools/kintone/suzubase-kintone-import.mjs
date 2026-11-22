#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const distUrl = new URL('../../apps/api/dist/kintone-import.js', import.meta.url);
const { KintoneSourceAdapter, validateKintoneDomain, buildM1CompatiblePackage } = await import(distUrl);
const { verifyPackage } = await import(new URL('../../apps/api/dist/export-package.js', import.meta.url));

const [command, appId] = process.argv.slice(2);
if (!['preflight', 'extract'].includes(command) || !appId) {
  console.error('usage: suzubase-kintone-import.mjs preflight|extract <kintone-app-id>');
  process.exit(2);
}
if (!process.env.KINTONE_API_TOKEN) {
  console.error('KINTONE_API_TOKEN is required');
  process.exit(2);
}
if (!process.env.KINTONE_SOURCE_ORIGIN) {
  console.error('KINTONE_SOURCE_ORIGIN is required');
  process.exit(2);
}

let origin;
try { origin = validateKintoneDomain(process.env.KINTONE_SOURCE_ORIGIN); }
catch (error) { console.error(error instanceof Error ? error.message : 'invalid kintone source'); process.exit(2); }

const adapter = new KintoneSourceAdapter(origin, process.env.KINTONE_API_TOKEN);
try {
  if (command === 'preflight') {
    const result = await adapter.preflight(appId);
    console.log(JSON.stringify({
      appId,
      availableApis: Object.keys(result.available),
      unavailableApis: result.unavailable,
      result: result.unavailable.length ? 'BLOCKED' : 'READY',
    }, null, 2));
  } else {
    const frozen = process.env.KINTONE_FREEZE_WINDOW_CONFIRMED === 'true';
    const result = await adapter.extract(appId, frozen);
    if (!frozen) result.evidence.unavailable.push({
      item: 'full-snapshot-consistency',
      reason: 'KINTONE_FREEZE_WINDOW_CONFIRMED=true is required for a provable full migration snapshot',
      evidence: null,
    });
    const report = {
      ...result,
      finalM1BusinessResult: result.packageReady && frozen ? 'PENDING_ACTIVATION' : 'BLOCKED',
      dataCompleteness: null,
      functionEquivalenceCount: result.compatibility.filter((item) => item.status === 'EQUIVALENT').length,
      unresolvedDependencyCount: result.compatibility.filter((item) => item.status === 'UNRESOLVED').length,
      unsupportedCount: result.compatibility.filter((item) => item.status === 'UNSUPPORTED').length,
      sourceUnavailableCount: result.evidence.unavailable.length,
    };
    let packageOutput = null;
    if (process.env.KINTONE_BUILD_M1_PACKAGE === 'true') {
      try {
        const sealed = buildM1CompatiblePackage(result, {
          sourceInstanceId: process.env.KINTONE_SOURCE_INSTANCE_ID,
          sourceTenantId: process.env.KINTONE_SOURCE_TENANT_ID,
        });
        const outDir = resolve(process.env.KINTONE_REPORT_DIR ?? './kintone-reports');
        mkdirSync(outDir, { recursive: true });
        packageOutput = resolve(outDir, `kintone-${appId}-${Date.now()}.m1.zip`);
        writeFileSync(packageOutput, sealed.archive);
        const verification = verifyPackage(sealed.archive);
        if (verification.problems.length) throw new Error(`M1 package verification failed: ${verification.problems.join('; ')}`);
        report.package = {
          path: packageOutput,
          formatVersion: sealed.manifest.formatVersion,
          counts: sealed.manifest.counts.actual,
          verification: 'VERIFIED',
        };
        report.finalM1BusinessResult = 'PENDING_ACTIVATION';
      } catch (error) {
        report.finalM1BusinessResult = 'BLOCKED';
        report.package = {
          verification: 'FAILED',
          reason: error instanceof Error ? error.message : 'M1 package generation failed',
        };
      }
    }
    const outDir = resolve(process.env.KINTONE_REPORT_DIR ?? './kintone-reports');
    mkdirSync(outDir, { recursive: true });
    const out = resolve(outDir, `kintone-${appId}-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify(report, null, 2));
    const checkpoint = resolve(outDir, `kintone-${appId}.checkpoint.json`);
    writeFileSync(checkpoint, JSON.stringify({
      appId,
      extractedAt: report.evidence.extractedAt,
      frozenWindow: report.evidence.frozenWindow,
      recordCount: report.records.length,
      commentCount: report.comments.length,
      attachmentCount: report.attachments.length,
      subtableRowCount: report.subtableRows.length,
      unavailableCount: report.evidence.unavailable.length,
      packageReady: report.packageReady,
    }, null, 2));
    console.log(JSON.stringify({ report: out, result: report.finalM1BusinessResult,
      recordsExtracted: result.records.length, compatibility: report.functionEquivalenceCount }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'kintone extraction failed');
  process.exit(1);
}
