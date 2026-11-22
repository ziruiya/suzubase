// Shared helpers for the Gate 3 Wave C fixture builder and scenario runner.
// API-driven only (plus direct DB provisioning of tenant accounts, the same
// pattern the integration-test support module uses).
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const dbRequire = createRequire(new URL('../../packages/db/package.json', import.meta.url));
const { Client } = dbRequire('pg');

let tracePath = null;
export function setTracePath(path) {
  tracePath = path;
  mkdirSync(dirname(path), { recursive: true });
}

export function trace(entry) {
  if (tracePath) appendFileSync(tracePath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

export class Api {
  constructor(baseUrl) { this.base = baseUrl.replace(/\/$/, ''); }
  async call(token, path, { method = 'GET', body, contentType, expect } = {}) {
    const response = await fetch(new URL(path, this.base + '/'), {
      method,
      headers: {
        ...(token && { Authorization: 'Bearer ' + token }),
        ...(body !== undefined && !contentType && { 'Content-Type': 'application/json' }),
        ...(contentType && { 'Content-Type': contentType }),
      },
      body: body === undefined ? undefined : (contentType ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(60000),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* binary */ }
    trace({ side: this.base, method, path, status: response.status });
    if (expect !== undefined && response.status !== expect) {
      throw new Error(`${method} ${path} -> ${response.status} (expected ${expect}): ${text.slice(0, 500)}`);
    }
    return { status: response.status, body: parsed, raw: text, buffer: Buffer.from(text, 'binary') };
  }
  async expect(token, status, path, options = {}) {
    const result = await this.call(token, path, { ...options, expect: status });
    return result.body;
  }
  async download(token, path) {
    const response = await fetch(new URL(path, this.base + '/'), {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(120000),
    });
    trace({ side: this.base, method: 'GET', path, status: response.status });
    if (response.status !== 200) throw new Error(`GET ${path} -> ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

export async function provision(adminDbUrl, { tenantId, isAdmin = false, canCreateApps = true } = {}) {
  const userId = randomUUID();
  const tenant = tenantId ?? randomUUID();
  const email = `${userId}@example.test`;
  const password = randomUUID();
  const client = new Client({ connectionString: adminDbUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (!tenantId) await client.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenant, 'Fixture tenant']);
    await client.query('INSERT INTO users (tenant_id, id, email) VALUES ($1, $2, $3)', [tenant, userId, email]);
    await client.query(
      'INSERT INTO tenant_members (tenant_id, user_id, can_create_apps, is_admin, can_manage_recycle_bin) VALUES ($1, $2, $3, $4, $5)',
      [tenant, userId, canCreateApps, isAdmin, false]);
    await client.query(`
      INSERT INTO authentication.login_credentials (tenant_id, user_id, email, password_hash)
      VALUES ($1, $2, $3, authentication.crypt(
        encode(authentication.digest($4::text, 'sha256'), 'hex'), authentication.gen_salt('bf', 12)))`,
      [tenant, userId, email, password]);
    await client.query('COMMIT');
  } finally { await client.end(); }
  return { tenantId: tenant, userId, email, password };
}

export async function dbQuery(adminDbUrl, sqlText, params) {
  const client = new Client({ connectionString: adminDbUrl });
  await client.connect();
  try { return (await client.query(sqlText, params)).rows; } finally { await client.end(); }
}

export async function login(api, identity) {
  const body = await api.expect(null, 200, '/auth/login', { method: 'POST', body: { email: identity.email, password: identity.password } });
  return body.accessToken;
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const OPTS = (...values) => values.map((value) => ({ value, label: value, disabled: false }));

// ---------------------------------------------------------------------------
// Fixture app 1: 「顾客・案件管理」 (self-contained). See GATE3 Wave C report
// for the construction notes. Attachments are single-version product-wide
// (storage keys hardcode v1), so variety is expressed through multiple files
// and lifecycle states, never through fabricated versions.
// ---------------------------------------------------------------------------
export async function buildFixtureApp1(api, adminDbUrl, { suffix = '' } = {}) {
  const owner = await provision(adminDbUrl, { isAdmin: true });
  const member = await provision(adminDbUrl, { tenantId: owner.tenantId });
  const token = await login(api, owner);
  const memberToken = await login(api, member);

  // Organization + group for organization/group ACL subjects and field values.
  const org = await api.expect(token, 201, '/tenant/organizations', { method: 'POST', body: { name: '名古屋営業所', parentId: null } });
  const group = await api.expect(token, 201, '/tenant/groups', { method: 'POST', body: { name: '営業部' } });
  await api.expect(token, 200, `/tenant/groups/${group.id}/members/${member.userId}`, { method: 'PUT', body: { included: true } });

  const app = await api.expect(token, 201, '/apps', { method: 'POST', body: { code: 'customers-cases' + suffix, name: '顧客・案件管理' } });
  const base = '/apps/' + app.id;
  const field = async (code, name, type, extra = {}) =>
    api.expect(token, 201, base + '/fields', { method: 'POST', body: { code, name, type, ...extra } });

  const f = {};
  f.code = await field('cust-code', '顧客コード', 'text', { uniqueValue: true, searchMode: 'customer-id' });
  f.name = await field('cust-name', '顧客名', 'text', { searchMode: 'name' });
  f.kana = await field('cust-kana', '顧客名かな', 'text', { searchMode: 'kana' });
  f.phone = await field('phone', '電話番号', 'phone');
  f.email = await field('email', 'メール', 'email');
  f.url = await field('url', '関連URL', 'url');
  f.amount = await field('amount', '金額', 'number');
  f.date = await field('visit-date', '訪問日', 'date');
  f.time = await field('visit-time', '訪問時刻', 'time');
  f.datetime = await field('next-contact', '次回連絡日時', 'datetime');
  f.radio = await field('channel', '流入経路', 'radio', { options: OPTS('web', 'phone', 'visit') });
  f.checkbox = await field('interests', '関心事項', 'checkbox', { options: OPTS('price', 'support', 'delivery') });
  f.select = await field('visibility', '公開区分', 'select', { options: OPTS('public', 'internal') });
  f.multiselect = await field('tags', 'タグ', 'multiselect', { options: OPTS('vip', 'new', 'repeat') });
  f.multiline = await field('memo', 'メモ', 'multiline');
  f.rich = await field('detail', '詳細', 'richText');
  f.assignee = await field('owner-user', '担当者', 'user');
  f.org = await field('branch', '担当営業所', 'organization');
  f.group = await field('team', '担当グループ', 'group');
  f.docs = await field('docs', '添付資料', 'attachment');
  f.legacy = await field('legacy-memo', '旧メモ', 'text');
  f.calc = await field('amount-x2', '金額×2', 'calculation', {
    formula: [{ kind: 'field', fieldId: f.amount.fieldId }, { kind: 'operator', operator: '*' }, { kind: 'number', value: '2' }],
  });
  const childName = randomUUID(); const childQty = randomUUID();
  f.lines = await api.expect(token, 201, base + '/fields', { method: 'POST', body: {
    code: 'lines', name: '明細', type: 'table',
    table: { fields: [
      { fieldId: childName, code: 'item', name: '品目', type: 'text', required: true, uniqueValue: false, options: [] },
      { fieldId: childQty, code: 'qty', name: '数量', type: 'number', required: true, uniqueValue: false, options: [] },
    ], minRows: 0, maxRows: 20, addRows: true, deleteRows: true, reorderRows: true },
  } });
  f.numbering = await api.expect(token, 201, base + '/fields', { method: 'POST', body: {
    code: 'case-no', name: '案件番号', type: 'autoNumber',
    autoNumber: { prefix: 'CASE-', scopeFieldId: null, nextValue: '1', padding: 4, enabled: true },
  } });

  // Three-layer ACL (draft): app layer (member + group subjects), record
  // layer (member sees only visibility=public), field layer (amount hidden
  // from member), workflow-repair bit for the owner.
  await api.expect(token, 200, base + '/draft/acl', { method: 'PUT', body: {
    app: [
      { action: 'view', subject: { kind: 'user', id: member.userId } },
      { action: 'view', subject: { kind: 'group', id: group.id } },
      { action: 'workflow-repair', subject: { kind: 'user', id: owner.userId } },
    ],
    record: [
      { action: 'view', subject: { kind: 'user', id: member.userId },
        conditions: [{ fieldId: f.select.fieldId, operator: 'eq', value: 'public' }] },
      { action: 'view', subject: { kind: 'group', id: group.id },
        conditions: [{ fieldId: f.select.fieldId, operator: 'eq', value: 'public' }] },
    ],
    field: [
      { action: 'view', fieldId: f.amount.fieldId, subject: { kind: 'user', id: owner.userId } },
    ],
  } });
  await api.expect(token, 201, base + '/publish', { method: 'POST' });

  // Published workflow: 受付 (initial) -> 対応中 (middle) -> 完了 (terminal),
  // with a reject action 対応中 -> 受付.
  const sOpen = randomUUID(); const sMid = randomUUID(); const sDone = randomUUID();
  const aStart = randomUUID(); const aFinish = randomUUID(); const aReject = randomUUID();
  await api.expect(token, 200, base + '/workflow/draft', { method: 'PUT', body: { states: [
    { id: sOpen, code: 'open', name: '受付', initial: true, terminal: false, assignees: [{ kind: 'creator' }] },
    { id: sMid, code: 'doing', name: '対応中', initial: false, terminal: false, assignees: [{ kind: 'user', id: member.userId }] },
    { id: sDone, code: 'done', name: '完了', initial: false, terminal: true, assignees: [] },
  ], actions: [
    { id: aStart, name: '対応開始', fromStateId: sOpen, toStateId: sMid, assignees: [], conditions: [] },
    { id: aFinish, name: '完了', fromStateId: sMid, toStateId: sDone, assignees: [], conditions: [] },
    { id: aReject, name: '差戻し', fromStateId: sMid, toStateId: sOpen, assignees: [], conditions: [] },
  ] } });
  await api.expect(token, 201, base + '/workflow/publish', { method: 'POST' });
  await api.expect(token, 200, base + '/workflow/enabled', { method: 'PATCH', body: { enabled: true } });

  // Notification rule (enabled in the source; must arrive disabled).
  await api.expect(token, 200, base + '/notification-rules', { method: 'PUT', body: { rules: [{
    id: randomUUID(), enabled: true, trigger: 'created', conditions: [],
    recipients: [{ kind: 'creator' }], title: '新規案件', body: '案件が作成されました',
  }] } });

  const names = ['山田太郎', '佐藤花子', '鈴木一郎', '高橋美咲', '田中健二', '伊藤真理', '渡辺翔', '中村あかり', '小林大輔', '加藤結衣'];
  const records = [];
  const total = 52;
  for (let i = 0; i < total; i++) {
    const n = i + 1;
    const data = {
      [f.code.fieldId]: 'CUST-' + String(n).padStart(4, '0'),
      [f.name.fieldId]: names[i % names.length],
      [f.kana.fieldId]: 'かな' + n,
      [f.phone.fieldId]: '090-' + String(1000 + n) + '-' + String(2000 + n),
      [f.email.fieldId]: `cust${n}@example.jp`,
      [f.url.fieldId]: 'https://example.jp/c/' + n,
      [f.amount.fieldId]: String(n * 1000),
      [f.date.fieldId]: '2026-11-' + String((i % 28) + 1).padStart(2, '0'),
      [f.time.fieldId]: '10:30:00',
      [f.datetime.fieldId]: '2026-12-01T10:00:00+09:00',
      [f.radio.fieldId]: ['web', 'phone', 'visit'][i % 3],
      [f.checkbox.fieldId]: JSON.stringify(['price']),
      [f.select.fieldId]: i % 4 === 0 ? 'internal' : 'public',
      [f.multiselect.fieldId]: JSON.stringify(['new']),
      [f.multiline.fieldId]: 'メモ ' + n,
      [f.rich.fieldId]: '<p>詳細 ' + n + '</p>',
      [f.assignee.fieldId]: member.userId,
      [f.org.fieldId]: org.id,
      [f.group.fieldId]: group.id,
      [f.legacy.fieldId]: '旧値 ' + n,
      [f.lines.fieldId]: JSON.stringify([
        { rowId: randomUUID(), data: { [childName]: '品目A-' + n, [childQty]: '2' } },
        { rowId: randomUUID(), data: { [childName]: '品目B-' + n, [childQty]: '3' } },
      ]),
    };
    const record = await api.expect(token, 201, base + '/records', { method: 'POST', body: { data } });
    records.push(record);
  }

  // Workflow distribution: 12 to middle, 8 of those to final, 1 rejected back
  // to initial (through the reject action), 1 repaired into middle.
  const act = async (record, actionId, rev, asToken = token) => {
    const current = await api.expect(asToken, 200, `${base}/records/${record.id}`, {});
    return api.expect(asToken, 201, `${base}/records/${record.id}/workflow/actions`, {
      method: 'POST', body: { action_id: actionId, revision: current.revision },
    });
  };
  for (let i = 0; i < 12; i++) await act(records[i], aStart);
  for (let i = 0; i < 8; i++) await act(records[i], aFinish, undefined, memberToken);
  await act(records[12], aStart);
  await act(records[12], aReject, undefined, memberToken);
  const repairTarget = await api.expect(token, 200, `${base}/records/${records[13].id}`, {});
  const repaired = await api.expect(token, 201, `${base}/records/${records[13].id}/workflow/repair`, {
    method: 'POST', body: { revision: repairTarget.revision, stateId: sMid, reason: '誤配送の復旧', userIds: [member.userId] },
  });

  // Comments: two live (one with @mention by the member), one deleted.
  const c1 = await api.expect(token, 201, `${base}/records/${records[0].id}/comments`, {
    method: 'POST', body: { parts: [{ kind: 'text', text: '初回連絡済みです。' }] },
  });
  const c2 = await api.expect(memberToken, 201, `${base}/records/${records[0].id}/comments`, {
    method: 'POST', body: { parts: [{ kind: 'text', text: '確認しました ' }, { kind: 'mention', userId: owner.userId }] },
  });
  const c3 = await api.expect(token, 201, `${base}/records/${records[1].id}/comments`, {
    method: 'POST', body: { parts: [{ kind: 'text', text: '削除予定コメント' }] },
  });
  await api.expect(token, 200, `${base}/records/${records[1].id}/comments/${c3.id}`, { method: 'DELETE' });

  // Attachments: three PDFs on record 1 (multiple files, single version each),
  // one file attached then detached (lifecycle DELETED), one left READY.
  const pdf = (label) => Buffer.from(`%PDF-1.4\n${label}\n%%EOF\n`);
  const upload = async (label) => {
    const result = await api.call(token, base + '/files?' + new URLSearchParams({ name: label + '.pdf', type: 'application/pdf' }), {
      method: 'POST', body: pdf(label), contentType: 'application/octet-stream', expect: 201,
    });
    return result.body;
  };
  const fileA = await upload('fixture-a');
  const fileB = await upload('fixture-b');
  const fileC = await upload('fixture-c');
  const fileDetached = await upload('fixture-detached');
  await upload('fixture-ready-only');
  const withFiles = async (record, fileIds) => {
    const current = await api.expect(token, 200, `${base}/records/${record.id}`, {});
    // Partial-form PUT (same shape the Wave B tests use): resubmit the title
    // plus the attachment field only; computed/auto-number fields stay server-side.
    const data = { [f.name.fieldId]: current.data[f.name.fieldId], [f.docs.fieldId]: JSON.stringify(fileIds) };
    return api.expect(token, 200, `${base}/records/${record.id}`, { method: 'PUT', body: { revision: current.revision, data } });
  };
  await withFiles(records[0], [fileA.id, fileB.id]);
  await withFiles(records[1], [fileC.id]);
  await withFiles(records[2], [fileDetached.id]);
  await withFiles(records[2], []);

  // Soft-delete two records into the recycle bin.
  for (const record of [records[50], records[51]]) {
    const current = await api.expect(token, 200, `${base}/records/${record.id}`, {});
    await api.expect(token, 200, `${base}/records/${record.id}`, { method: 'DELETE', body: { revision: current.revision } });
  }

  // Delete the legacy field and publish: its definition + surviving values
  // must travel in the package as a deleted field.
  await api.expect(token, 200, base + '/draft/fields/' + f.legacy.fieldId, { method: 'DELETE' });
  await api.expect(token, 201, base + '/publish', { method: 'POST', body: { migration: { incompatible: 'reject' } } });

  return {
    owner, member, token, memberToken, org, group, app, base, fields: f,
    states: { sOpen, sMid, sDone }, actions: { aStart, aFinish, aReject },
    records, comments: { c1, c2 }, files: { fileA, fileB, fileC },
    repairedEventId: repaired.eventId,
    counts: { records: total, softDeleted: 2 },
  };
}

// Fixture app 2: 「紹介・着工管理」 with a cross-app lookup into app 1.
export async function buildFixtureApp2(api, fx1) {
  const { token } = fx1;
  const app = await api.expect(token, 201, '/apps', { method: 'POST', body: { code: 'referral-works', name: '紹介・着工管理' } });
  const base = '/apps/' + app.id;
  const field = async (code, name, type, extra = {}) =>
    api.expect(token, 201, base + '/fields', { method: 'POST', body: { code, name, type, ...extra } });
  const localKey = await field('cust-code', '顧客コード', 'text');
  const copyName = await field('cust-name-copy', '顧客名（複写）', 'text');
  const workDate = await field('start-date', '着工日', 'date');
  const lookup = await api.expect(token, 201, base + '/fields', { method: 'POST', body: {
    code: 'cust-lookup', name: '顧客参照', type: 'lookup',
    lookup: { appId: fx1.app.id, keyFieldId: fx1.fields.code.fieldId, localKeyFieldId: localKey.fieldId,
      copies: [{ sourceFieldId: fx1.fields.name.fieldId, targetFieldId: copyName.fieldId }] },
  } });
  await api.expect(token, 201, base + '/publish', { method: 'POST' });
  const records = [];
  for (let i = 0; i < 5; i++) {
    const record = await api.expect(token, 201, base + '/records', { method: 'POST', body: { data: {
      [localKey.fieldId]: 'CUST-' + String(i + 1).padStart(4, '0'),
      [workDate.fieldId]: '2026-12-' + String(10 + i),
    } } });
    records.push(record);
  }
  return { app, base, fields: { localKey, copyName, workDate, lookup }, records };
}

export async function exportApp(api, token, appId) {
  const job = await api.expect(token, 201, `/apps/${appId}/exports`, { method: 'POST' });
  const run = await api.expect(token, 201, `/apps/${appId}/exports/${job.id}/run`, { method: 'POST' });
  if (run.status !== 'sealed') throw new Error('export did not seal: ' + JSON.stringify(run));
  const archive = await api.download(token, `/apps/${appId}/exports/${job.id}/package`);
  return { job, run, archive };
}
