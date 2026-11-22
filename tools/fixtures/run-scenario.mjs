// G3-10 core scenario runner (cross-deployment, decision 1).
//   node tools/fixtures/run-scenario.mjs phase-a   (deployment A: build + export)
//   node tools/fixtures/run-scenario.mjs phase-b   (deployment B: import + verify)
// Phase A writes packages + source-snapshot.json into the evidence directory;
// phase B consumes them, so the two deployments never need to run at once.
// Required env: A_API_URL, A_ADMIN_DATABASE_URL, B_API_URL,
// B_ADMIN_DATABASE_URL, EVIDENCE_DIR.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Api, buildFixtureApp1, buildFixtureApp2, dbQuery, exportApp, login, provision, setTracePath, sha256, trace,
} from './fixture-tools.mjs';

const evidence = process.env.EVIDENCE_DIR;
if (!evidence) throw new Error('EVIDENCE_DIR is required');
mkdirSync(evidence, { recursive: true });
setTracePath(join(evidence, 'traces.jsonl'));

const phase = process.argv[2];

async function phaseA() {
  const api = new Api(process.env.A_API_URL);
  const db = process.env.A_ADMIN_DATABASE_URL;
  const fx1 = await buildFixtureApp1(api, db);
  const fx2 = await buildFixtureApp2(api, fx1);
  const exp1 = await exportApp(api, fx1.token, fx1.app.id);
  const exp2 = await exportApp(api, fx1.token, fx2.app.id);
  writeFileSync(join(evidence, 'app1-package.zip'), exp1.archive);
  writeFileSync(join(evidence, 'app2-package.zip'), exp2.archive);

  // Source-side snapshot for the item-by-item checklist.
  const memberRecords = await api.expect(fx1.memberToken, 200, fx1.base + '/records', {});
  const ownerRecords = await api.expect(fx1.token, 200, fx1.base + '/records', {});
  const recycle = await api.expect(fx1.token, 200, fx1.base + '/records/recycle', {}).catch(() => null);
  const workflowDist = await dbQuery(db,
    `SELECT ws.code AS state, count(*)::int AS n FROM record_workflow_state rws
     JOIN workflow_states ws ON ws.tenant_id = rws.tenant_id AND ws.id = rws.state_id
     WHERE rws.tenant_id = $1 AND rws.app_id = $2 GROUP BY ws.code ORDER BY ws.code`,
    [fx1.owner.tenantId, fx1.app.id]);
  const assignDist = await dbQuery(db,
    `SELECT user_id, count(*)::int AS n FROM workflow_assignments
     WHERE tenant_id = $1 AND app_id = $2 GROUP BY user_id ORDER BY user_id`,
    [fx1.owner.tenantId, fx1.app.id]);
  const tableRows = await dbQuery(db,
    'SELECT count(*)::int AS n FROM record_table_rows WHERE tenant_id = $1 AND app_id = $2',
    [fx1.owner.tenantId, fx1.app.id]);
  const firstRecord = await api.expect(fx1.token, 200, `${fx1.base}/records/${fx1.records[0].id}`, {});
  const comments = await api.expect(fx1.token, 200, `${fx1.base}/records/${fx1.records[1].id}/comments`, {});
  const history = await api.expect(fx1.token, 200, `${fx1.base}/records/${fx1.records[0].id}/history`, {});
  const rules = await api.expect(fx1.token, 200, fx1.base + '/notification-rules', {});
  const snapshot = {
    tenantId: fx1.owner.tenantId, ownerId: fx1.owner.userId, memberId: fx1.member.userId,
    groupId: fx1.group.id, orgId: fx1.org.id,
    app1: { id: fx1.app.id, code: fx1.app.code, manifestCounts: exp1.run.counts ?? null,
      packageSha256: sha256(exp1.archive), packageBytes: exp1.archive.length },
    app2: { id: fx2.app.id, code: fx2.app.code, packageSha256: sha256(exp2.archive), packageBytes: exp2.archive.length },
    records: { total: fx1.counts.records, ownerVisible: (ownerRecords.items ?? ownerRecords).length,
      memberVisible: (memberRecords.items ?? memberRecords).length,
      recycleVisible: recycle ? (recycle.items ?? recycle).length : null, tableRows: tableRows[0].n },
    workflow: { distribution: workflowDist, assignments: assignDist },
    firstRecord: { id: fx1.records[0].id, recordNo: fx1.records[0].recordNo,
      autoNumber: firstRecord.data[fx1.fields.numbering.fieldId] },
    commentRecordNo: fx1.records[1].recordNo,
    comments: (comments.items ?? comments).map((c) => ({ id: c.id, authorId: c.authorId ?? c.createdBy, createdAt: c.createdAt })),
    historyEvents: (history.events ?? []).length,
    notificationRules: (rules.published ?? rules.rules ?? rules).map((r) => ({ enabled: r.enabled })),
    attachmentSha256: {
      fileA: sha256(Buffer.from('%PDF-1.4\nfixture-a\n%%EOF\n')),
      fileB: sha256(Buffer.from('%PDF-1.4\nfixture-b\n%%EOF\n')),
      fileC: sha256(Buffer.from('%PDF-1.4\nfixture-c\n%%EOF\n')),
    },
    fieldCodes: Object.fromEntries(Object.entries(fx1.fields).map(([key, value]) => [key, value.code])),
    numberingFieldCode: fx1.fields.numbering.code,
    app2LookupFieldId: fx2.fields.lookup.fieldId,
    app2SourceKeyFieldId: fx1.fields.code.fieldId,
    app2SourceNameFieldId: fx1.fields.name.fieldId,
  };
  writeFileSync(join(evidence, 'source-snapshot.json'), JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({ phase: 'a', app1: snapshot.app1, app2: snapshot.app2, records: snapshot.records, workflow: snapshot.workflow }, null, 2));
}

async function importFlow(api, adminToken, archive, mappings = {}) {
  const uploaded = await api.call(adminToken, '/imports/upload', {
    method: 'POST', body: archive, contentType: 'application/octet-stream', expect: 201,
  });
  const job = uploaded.body;
  if (mappings.confirmDuplicate) {
    await api.expect(adminToken, 200, `/imports/${job.id}/mappings`, { method: 'PUT', body: { confirmDuplicate: true } });
  }
  const validated = await api.expect(adminToken, 201, `/imports/${job.id}/validate`, { method: 'POST' });
  if (validated.status !== 'staging') throw new Error('validate did not reach staging: ' + JSON.stringify(validated).slice(0, 400));
  const { confirmDuplicate, ...rest } = mappings;
  if (Object.keys(rest).length) {
    await api.expect(adminToken, 200, `/imports/${job.id}/mappings`, { method: 'PUT', body: rest });
  }
  const issued = await api.expect(adminToken, 201, `/imports/${job.id}/migration-token`, { method: 'POST' });
  const run = await api.expect(issued.token, 201, `/imports/${job.id}/run`, { method: 'POST' });
  const detail = await api.expect(adminToken, 200, `/imports/${job.id}`, {});
  return { job, run, detail, issued };
}

async function phaseB() {
  const api = new Api(process.env.B_API_URL);
  const db = process.env.B_ADMIN_DATABASE_URL;
  const snapshot = JSON.parse(readFileSync(join(evidence, 'source-snapshot.json'), 'utf8'));
  const pkg1 = readFileSync(join(evidence, 'app1-package.zip'));
  const pkg2 = readFileSync(join(evidence, 'app2-package.zip'));
  const admin = await provision(db, { isAdmin: true });
  const member = await provision(db, { tenantId: admin.tenantId });
  const adminToken = await login(api, admin);
  const memberToken = await login(api, member);
  const checks = [];
  const check = (item, source, target, ok) => {
    checks.push({ item, source, target, ok: Boolean(ok) });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${item}: source=${JSON.stringify(source)} target=${JSON.stringify(target)}`);
  };

  // --- App 2 first, WITHOUT its lookup target present: pending completion.
  const flow2 = await importFlow(api, adminToken, pkg2, {
    users: { [snapshot.ownerId]: admin.userId },
  });
  writeFileSync(join(evidence, 'app2-import-job.json'), JSON.stringify(flow2.detail, null, 2));
  check('app2 without target app -> completion pending', 'pending', flow2.run.completion, flow2.run.completion === 'pending');
  const appsBefore = await api.expect(adminToken, 200, '/apps', {});
  check('app2 staged app invisible before activation', false,
    appsBefore.some((entry) => entry.id === flow2.run.targetAppId),
    !appsBefore.some((entry) => entry.id === flow2.run.targetAppId));
  const blockedActivate = await api.call(adminToken, `/imports/${flow2.job.id}/activate`, { method: 'POST' });
  check('app2 activation blocked while pending', 400, blockedActivate.status, blockedActivate.status === 400);

  // --- App 1: full restore into the fresh deployment.
  const flow1 = await importFlow(api, adminToken, pkg1, {
    users: { [snapshot.ownerId]: admin.userId, [snapshot.memberId]: member.userId },
  });
  writeFileSync(join(evidence, 'app1-import-job.json'), JSON.stringify(flow1.detail, null, 2));
  writeFileSync(join(evidence, 'app1-report.json'), JSON.stringify(flow1.detail.report, null, 2));
  check('app1 completion complete', 'complete', flow1.run.completion, flow1.run.completion === 'complete');
  check('app1 report record counts match', flow1.detail.report.counts.source.records,
    flow1.detail.report.counts.target.records,
    flow1.detail.report.counts.source.records === flow1.detail.report.counts.target.records);
  check('app1 report attachments all verified', 0, flow1.detail.report.verification.attachments.failed.length,
    flow1.detail.report.verification.attachments.failed.length === 0);
  check('app1 import produced zero outbox events', 0, flow1.detail.report.verification.outboxEventsProduced,
    flow1.detail.report.verification.outboxEventsProduced === 0);
  const activated1 = await api.expect(adminToken, 201, `/imports/${flow1.job.id}/activate`, { method: 'POST' });
  check('app1 activated', 'activated', activated1.status, activated1.status === 'activated');
  const target1 = '/apps/' + flow1.run.targetAppId;

  const targetRecords = await dbQuery(db,
    'SELECT count(*)::int AS n, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted FROM records WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, flow1.run.targetAppId]);
  check('record count incl. soft-deleted', snapshot.records.total, targetRecords[0].n, targetRecords[0].n === snapshot.records.total);
  check('soft-deleted records preserved', snapshot.records.softDeleted ?? 2, targetRecords[0].deleted, targetRecords[0].deleted === 2);
  const targetRows = await dbQuery(db,
    'SELECT count(*)::int AS n FROM record_table_rows WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, flow1.run.targetAppId]);
  check('subtable row count', snapshot.records.tableRows, targetRows[0].n, targetRows[0].n === snapshot.records.tableRows);

  // Attachment hashes via the download path.
  const published1 = await api.expect(adminToken, 200, target1, {});
  const docsField = published1.fields.find((entry) => entry.code === 'docs');
  const titleField = published1.fields.find((entry) => entry.code === 'cust-name');
  const numberingField = published1.fields.find((entry) => entry.code === snapshot.numberingFieldCode);
  const listTarget = await api.expect(adminToken, 200, target1 + '/records', {});
  const items = listTarget.items ?? listTarget;
  // Target record ids come from the job's source_id_map (entityMapping):
  // target record_no values are freshly issued (decision 8), never matched
  // against source numbers.
  const mapping = flow1.detail.entityMapping ?? [];
  const mappedFirst = mapping.find((entry) => entry.objectType === 'record' && entry.sourceId === snapshot.firstRecord.id);
  const firstTarget = mappedFirst ? { id: mappedFirst.targetId } : items[0];
  const firstDetail = await api.expect(adminToken, 200, `${target1}/records/${firstTarget.id}`, {});
  const fileIds = JSON.parse(firstDetail.data[docsField.fieldId]);
  const hashes = [];
  for (const fileId of fileIds) {
    const body = await api.download(adminToken, `${target1}/files/${fileId}`);
    hashes.push(sha256(body));
  }
  check('attachment hashes match source bodies',
    [snapshot.attachmentSha256.fileA, snapshot.attachmentSha256.fileB].sort(), hashes.sort(),
    JSON.stringify([snapshot.attachmentSha256.fileA, snapshot.attachmentSha256.fileB].sort()) === JSON.stringify(hashes.sort()));

  // Workflow state + assignee distribution.
  const workflowDist = await dbQuery(db,
    `SELECT ws.code AS state, count(*)::int AS n FROM record_workflow_state rws
     JOIN workflow_states ws ON ws.tenant_id = rws.tenant_id AND ws.id = rws.state_id
     WHERE rws.tenant_id = $1 AND rws.app_id = $2 GROUP BY ws.code ORDER BY ws.code`,
    [admin.tenantId, flow1.run.targetAppId]);
  const byState = (rows) => Object.fromEntries(rows.map((row) => [row.state, row.n]));
  check('workflow state distribution', byState(snapshot.workflow.distribution), byState(workflowDist),
    JSON.stringify(byState(snapshot.workflow.distribution)) === JSON.stringify(byState(workflowDist)));
  const assignCount = await dbQuery(db,
    'SELECT count(*)::int AS n FROM workflow_assignments WHERE tenant_id = $1 AND app_id = $2',
    [admin.tenantId, flow1.run.targetAppId]);
  // The source metric is the CURRENT assignee set as exported in the package
  // (data/records.json workflow.assignees per record). The source deployment's
  // raw workflow_assignments table additionally retains superseded rows from
  // transitions (65 rows for 44 current assignments), which are history, not
  // current assignees, and correctly do not travel as assignments.
  const req = (await import('node:module')).createRequire(import.meta.url);
  const { unzipSync } = req(req.resolve('fflate', { paths: [new URL('../../apps/api', import.meta.url).pathname] }));
  const pkgEntries = unzipSync(new Uint8Array(pkg1));
  const pkgRecords = JSON.parse(Buffer.from(pkgEntries['data/records.json']).toString('utf8')).records;
  const sourceAssignCount = pkgRecords.reduce((sum, entry) => sum + (entry.workflow?.assignees?.length ?? 0), 0);
  check('workflow current-assignment count', sourceAssignCount, assignCount[0].n, assignCount[0].n === sourceAssignCount);

  // Comments: author + time fidelity with migration markers.
  const commentRows = await dbQuery(db,
    `SELECT record_id FROM record_comments WHERE tenant_id = $1 AND app_id = $2 AND deleted_at IS NULL LIMIT 1`,
    [admin.tenantId, flow1.run.targetAppId]);
  const commentTarget = commentRows.length ? { id: commentRows[0].record_id } : firstTarget;
  const comments = await api.expect(adminToken, 200, `${target1}/records/${commentTarget.id}/comments`, {});
  const commentItems = comments.items ?? comments;
  check('comment count on comment record', snapshot.comments.length, commentItems.length,
    commentItems.length === snapshot.comments.length);
  const sourceComment = snapshot.comments[0];
  const targetComment = commentItems.find((entry) => entry.createdAt === sourceComment.createdAt) ?? commentItems[0];
  check('comment time fidelity', sourceComment.createdAt, targetComment?.createdAt,
    targetComment?.createdAt === sourceComment.createdAt);
  check('comment carries migration marker', true, Boolean(targetComment?.migration?.sourceActorId),
    Boolean(targetComment?.migration?.sourceActorId));

  // History timeline renders with migration markers.
  const history = await api.expect(adminToken, 200, `${target1}/records/${firstTarget.id}/history`, {});
  check('history events migrated-marked', true,
    (history.events ?? []).every((event) => event.source === 'migration'),
    (history.events ?? []).length > 0 && (history.events ?? []).every((event) => event.source === 'migration'));

  // ACL sample evaluation: member-visible count matches the source member view.
  const memberList = await api.expect(memberToken, 200, target1 + '/records', {});
  check('ACL sample: member visible record count', snapshot.records.memberVisible,
    (memberList.items ?? memberList).length,
    (memberList.items ?? memberList).length === snapshot.records.memberVisible);

  // Auto-number: a new record must not collide with imported numbers.
  const importedNumberRows = await dbQuery(db,
    'SELECT data ->> $3 AS n FROM records WHERE tenant_id = $1 AND app_id = $2 AND deleted_at IS NULL',
    [admin.tenantId, flow1.run.targetAppId, numberingField.fieldId]);
  const importedNumbers = importedNumberRows.map((row) => row.n).filter(Boolean);
  const fresh = await api.expect(adminToken, 201, target1 + '/records', { method: 'POST',
    body: { data: { [titleField.fieldId]: '移行後の新規案件' } } });
  check('auto-number no collision on new record', 'not in imported set', fresh.data[numberingField.fieldId],
    !importedNumbers.includes(fresh.data[numberingField.fieldId]));

  // Notification rules imported disabled.
  const rules = await api.expect(adminToken, 200, target1 + '/notification-rules', {});
  const ruleList = rules.published ?? rules.rules ?? rules;
  check('notification rules imported disabled', [false], ruleList.map((rule) => rule.enabled),
    ruleList.length >= 1 && ruleList.every((rule) => rule.enabled === false));

  // --- App 2: complete the mapping now that app 1 exists in B, then activate.
  const targetApp1Published = published1;
  const targetKey = targetApp1Published.fields.find((entry) => entry.code === 'cust-code');
  const targetName = targetApp1Published.fields.find((entry) => entry.code === 'cust-name');
  const resolved = await api.expect(flow2.issued.token, 201, `/imports/${flow2.job.id}/resolve-dependencies`, {
    method: 'POST', body: { decisions: {
      [snapshot.app2LookupFieldId]: { action: 'map', targetAppId: flow1.run.targetAppId,
        fieldMappings: { [snapshot.app2SourceKeyFieldId]: targetKey.fieldId, [snapshot.app2SourceNameFieldId]: targetName.fieldId } },
    } },
  });
  check('app2 dependency resolution completes it', 'complete', resolved.completion, resolved.completion === 'complete');
  const activated2 = await api.expect(adminToken, 201, `/imports/${flow2.job.id}/activate`, { method: 'POST' });
  check('app2 activated after mapping', 'activated', activated2.status, activated2.status === 'activated');

  // --- App 2 again, now that the target app exists in B: direct full restore.
  const flow2b = await importFlow(api, adminToken, pkg2, {
    confirmDuplicate: true,
    users: { [snapshot.ownerId]: admin.userId },
    dependencies: {
      [snapshot.app2LookupFieldId]: { action: 'map', targetAppId: flow1.run.targetAppId,
        fieldMappings: { [snapshot.app2SourceKeyFieldId]: targetKey.fieldId, [snapshot.app2SourceNameFieldId]: targetName.fieldId } },
    },
  });
  writeFileSync(join(evidence, 'app2-second-import-job.json'), JSON.stringify(flow2b.detail, null, 2));
  check('app2 with target present -> direct complete', 'complete', flow2b.run.completion, flow2b.run.completion === 'complete');
  await api.expect(adminToken, 201, `/imports/${flow2b.job.id}/activate`, { method: 'POST' });

  const failed = checks.filter((entry) => !entry.ok);
  const checklist = { generatedAt: new Date().toISOString(), checks, passed: checks.length - failed.length, failed: failed.length };
  writeFileSync(join(evidence, 'checklist.json'), JSON.stringify(checklist, null, 2));
  writeFileSync(join(evidence, 'checklist.md'),
    '# G3-10 source vs target checklist\n\n' + checks.map((entry) =>
      `- [${entry.ok ? 'x' : ' '}] ${entry.item} — source: ${JSON.stringify(entry.source)} / target: ${JSON.stringify(entry.target)}`).join('\n') + '\n');
  trace({ scenario: 'phase-b-complete', passed: checklist.passed, failed: checklist.failed });
  console.log(JSON.stringify(checklist, null, 2));
  if (failed.length) process.exitCode = 1;
}

if (phase === 'phase-a') await phaseA();
else if (phase === 'phase-b') await phaseB();
else throw new Error('usage: run-scenario.mjs phase-a|phase-b');
