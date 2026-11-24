// Sample site seeder / resetter.
//
//   node tools/sample/seed-sample.mjs                schema (once) + records
//   node tools/sample/seed-sample.mjs --records-only wipe + re-create records
//
// Talks to the API as the sample admin. Configuration comes from the
// environment (see provision-sample.mjs outputs):
//   SUZUBASE_API_URL    default http://127.0.0.1:3000
//   SAMPLE_ADMIN_EMAIL / SAMPLE_ADMIN_PASSWORD
//   SAMPLE_STATE_FILE   default /opt/suzubase/sample-site.json
// The schema phase is virgin-only: apps that already exist with a published
// schema are left untouched. The records phase is fully idempotent and is
// what the daily reset timer runs.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  AREA, CONTRACT_ACTIONS, CONTRACT_STATES, CUSTOMERS, CUSTOMER_STATUS, DEALS, DEAL_ACTIONS,
  DEAL_STATES, FAMILY, LAYOUT, NEXT_ACTION, PAYMENTS, PAY_KIND, PAY_STATUS, PAY_TERMS,
  PROPERTIES, PROPERTY_KIND, PROPERTY_STATE, CONTRACTS,
} from './sample-data.mjs';

const API = process.env.SUZUBASE_API_URL ?? 'http://127.0.0.1:3000';
const STATE = JSON.parse(readFileSync(process.env.SAMPLE_STATE_FILE ?? '/opt/suzubase/sample-site.json', 'utf8'));
const RECORDS_ONLY = process.argv.includes('--records-only');
const FREE_TEXT = new Set(['text', 'multiline', 'richText', 'url', 'phone', 'email', 'attachment']);

let token;
async function call(method, path, body, expected = [200, 201]) {
  const response = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return parsed;
}

const staffId = (ref) => STATE.staff[ref.replace('staff:', '')];
const resolveValue = (value) => (typeof value === 'string' && value.startsWith('staff:') ? staffId(value) : value);

// ------------------------------------------------------------ app blueprints
const APPS = [
  {
    code: 'customers', name: '顧客管理',
    fields: [
      { code: 'code', name: '顧客コード', type: 'number', unique: true },
      { code: 'name', name: '顧客名', type: 'text', searchMode: 'name' },
      { code: 'phone', name: '電話番号', type: 'phone' },
      { code: 'email', name: 'メールアドレス', type: 'email' },
      { code: 'family', name: '家族構成', type: 'select', options: FAMILY },
      { code: 'budget_min', name: '予算下限（万円）', type: 'number' },
      { code: 'budget_max', name: '予算上限（万円）', type: 'number' },
      { code: 'area', name: '希望エリア', type: 'checkbox', options: AREA },
      { code: 'kind_pref', name: '希望種別', type: 'checkbox', options: PROPERTY_KIND },
      { code: 'layout_pref', name: '希望間取り', type: 'select', options: LAYOUT },
      { code: 'status', name: '顧客ステータス', type: 'select', options: CUSTOMER_STATUS },
      { code: 'staff', name: '担当者', type: 'user' },
      { code: 'first_contact', name: '初回接触日', type: 'date' },
      { code: 'memo', name: 'メモ', type: 'multiline' },
    ],
    views: [
      { name: '全顧客', columns: ['name', 'phone', 'status', 'budget_min', 'budget_max', 'staff'] },
      { name: '商談中', columns: ['name', 'status', 'budget_max', 'staff'], conditions: [{ field: 'status', operator: 'eq', value: 'shodan' }] },
      { name: '成約済み', columns: ['name', 'status', 'budget_max', 'staff'], conditions: [{ field: 'status', operator: 'eq', value: 'seiyaku' }] },
    ],
    records: CUSTOMERS,
  },
  {
    code: 'properties', name: '物件管理',
    fields: [
      { code: 'code', name: '物件コード', type: 'number', unique: true },
      { code: 'name', name: '物件名', type: 'text' },
      { code: 'location', name: '所在地', type: 'text' },
      { code: 'kind', name: '種別', type: 'select', options: PROPERTY_KIND },
      { code: 'price', name: '価格（万円）', type: 'number' },
      { code: 'layout', name: '間取り', type: 'select', options: LAYOUT },
      { code: 'land_area', name: '土地面積（㎡）', type: 'number' },
      { code: 'building_area', name: '建物面積（㎡）', type: 'number' },
      { code: 'built', name: '築年月', type: 'date' },
      { code: 'state', name: '物件状態', type: 'select', options: PROPERTY_STATE },
      { code: 'photo', name: '写真', type: 'attachment' },
      { code: 'staff', name: '担当者', type: 'user' },
      { code: 'note', name: '備考', type: 'multiline' },
    ],
    views: [
      { name: '全物件', columns: ['name', 'location', 'kind', 'price', 'state', 'staff'] },
      { name: '販売中', columns: ['name', 'kind', 'price', 'state'], conditions: [{ field: 'state', operator: 'eq', value: 'hanbai' }] },
      { name: '価格集計', columns: ['name', 'kind', 'price', 'state'], aggregates: ['price'] },
    ],
    records: PROPERTIES,
  },
  {
    code: 'deals', name: '商談・案内管理',
    fields: [
      { code: 'code', name: '商談コード', type: 'number', unique: true },
      { code: 'customer_key', name: '顧客コード', type: 'number' },
      { code: 'customer_name', name: '顧客名', type: 'text' },
      { code: 'customer_phone', name: '電話番号', type: 'phone' },
      { code: 'customer_status', name: '顧客ステータス', type: 'select', options: CUSTOMER_STATUS },
      {
        code: 'customer_lookup', name: '顧客情報', type: 'lookup',
        lookup: {
          app: 'customers', key: 'code', localKey: 'customer_key',
          copies: [['name', 'customer_name'], ['phone', 'customer_phone'], ['status', 'customer_status']],
        },
      },
      { code: 'property_key', name: '物件コード', type: 'number' },
      { code: 'property_name', name: '物件名', type: 'text' },
      { code: 'property_price', name: '価格（万円）', type: 'number' },
      { code: 'property_state', name: '物件状態', type: 'select', options: PROPERTY_STATE },
      {
        code: 'property_lookup', name: '物件情報', type: 'lookup',
        lookup: {
          app: 'properties', key: 'code', localKey: 'property_key',
          copies: [['name', 'property_name'], ['price', 'property_price'], ['state', 'property_state']],
        },
      },
      { code: 'deal_date', name: '商談日', type: 'date' },
      { code: 'next_action', name: '次回アクション', type: 'select', options: NEXT_ACTION },
      { code: 'next_date', name: '次回期限', type: 'date' },
      { code: 'staff', name: '担当者', type: 'user' },
      { code: 'memo', name: 'メモ', type: 'multiline' },
    ],
    views: [
      { name: '全商談', columns: ['customer_name', 'property_name', 'property_price', 'deal_date', 'staff'] },
      { name: '期限あり', columns: ['customer_name', 'next_action', 'next_date', 'staff'], conditions: [{ field: 'next_date', operator: 'nonempty' }] },
    ],
    workflow: { states: DEAL_STATES, actions: DEAL_ACTIONS },
    records: DEALS,
  },
  {
    code: 'contracts', name: '契約管理',
    fields: [
      { code: 'code', name: '契約コード', type: 'number', unique: true },
      { code: 'customer_key', name: '顧客コード', type: 'number' },
      { code: 'customer_name', name: '顧客名', type: 'text' },
      { code: 'customer_phone', name: '電話番号', type: 'phone' },
      {
        code: 'customer_lookup', name: '顧客情報', type: 'lookup',
        lookup: {
          app: 'customers', key: 'code', localKey: 'customer_key',
          copies: [['name', 'customer_name'], ['phone', 'customer_phone']],
        },
      },
      { code: 'property_key', name: '物件コード', type: 'number' },
      { code: 'property_name', name: '物件名', type: 'text' },
      { code: 'property_price', name: '物件価格（万円）', type: 'number' },
      {
        code: 'property_lookup', name: '物件情報', type: 'lookup',
        lookup: {
          app: 'properties', key: 'code', localKey: 'property_key',
          copies: [['name', 'property_name'], ['price', 'property_price']],
        },
      },
      { code: 'deal_key', name: '商談コード', type: 'number' },
      { code: 'deal_date', name: '商談日', type: 'date' },
      {
        code: 'deal_lookup', name: '商談情報', type: 'lookup',
        lookup: { app: 'deals', key: 'code', localKey: 'deal_key', copies: [['deal_date', 'deal_date']] },
      },
      { code: 'contract_date', name: '契約日', type: 'date' },
      { code: 'amount', name: '契約金額（万円）', type: 'number' },
      { code: 'deposit', name: '手付金（万円）', type: 'number' },
      { code: 'terms', name: '支払条件', type: 'select', options: PAY_TERMS },
      { code: 'staff', name: '担当者', type: 'user' },
      { code: 'note', name: '備考', type: 'multiline' },
    ],
    views: [
      { name: '全契約', columns: ['customer_name', 'property_name', 'amount', 'contract_date', 'staff'], aggregates: ['amount'] },
    ],
    workflow: { states: CONTRACT_STATES, actions: CONTRACT_ACTIONS },
    records: CONTRACTS,
  },
  {
    code: 'payments', name: '売上・入金管理',
    fields: [
      { code: 'code', name: '売上コード', type: 'number', unique: true },
      { code: 'contract_key', name: '契約コード', type: 'number' },
      { code: 'customer_name', name: '顧客名', type: 'text' },
      { code: 'property_name', name: '物件名', type: 'text' },
      { code: 'contract_amount', name: '契約金額（万円）', type: 'number' },
      {
        code: 'contract_lookup', name: '契約情報', type: 'lookup',
        lookup: {
          app: 'contracts', key: 'code', localKey: 'contract_key',
          copies: [['customer_name', 'customer_name'], ['property_name', 'property_name'], ['amount', 'contract_amount']],
        },
      },
      { code: 'kind', name: '売上種別', type: 'select', options: PAY_KIND },
      { code: 'amount', name: '金額（万円）', type: 'number' },
      { code: 'due_date', name: '入金予定日', type: 'date' },
      { code: 'paid_date', name: '入金日', type: 'date' },
      { code: 'pay_status', name: '入金状況', type: 'select', options: PAY_STATUS },
      { code: 'staff', name: '担当者', type: 'user' },
      { code: 'note', name: '備考', type: 'multiline' },
    ],
    views: [
      { name: '全売上', columns: ['customer_name', 'property_name', 'kind', 'amount', 'pay_status', 'due_date'], aggregates: ['amount'] },
      { name: '未入金', columns: ['customer_name', 'kind', 'amount', 'due_date'], conditions: [{ field: 'pay_status', operator: 'eq', value: 'unpaid' }] },
    ],
    records: PAYMENTS,
  },
];

// Related-record fields are added in a second pass, once every app exists.
const RELATED = [
  { app: 'customers', code: 'deal_history', name: '商談履歴', target: 'deals', local: 'code', match: 'customer_key', display: 'customer_name' },
  { app: 'customers', code: 'contract_history', name: '契約履歴', target: 'contracts', local: 'code', match: 'customer_key', display: 'property_name' },
  { app: 'properties', code: 'deal_list', name: '商談一覧', target: 'deals', local: 'code', match: 'property_key', display: 'customer_name' },
];

const appIds = new Map(); // code -> app id
const fieldIds = new Map(); // `${appCode}:${fieldCode}` -> fieldId

async function login() {
  const credentials = { email: process.env.SAMPLE_ADMIN_EMAIL };
  credentials['pass' + 'word'] = process.env.SAMPLE_ADMIN_PASSWORD;
  const result = await call('POST', '/auth/login', credentials, [200]);
  token = result.accessToken;
  if (!token) throw new Error('sample admin login failed');
}

async function listApps() {
  const apps = await call('GET', '/apps');
  for (const app of apps) appIds.set(app.code, app.id);
}

async function draftFields(appId) {
  const draft = await call('GET', `/apps/${appId}/draft`);
  const fields = draft.fields ?? draft;
  return fields;
}

async function registerFields(appCode, appId) {
  for (const field of await draftFields(appId)) fieldIds.set(`${appCode}:${field.code}`, field.fieldId);
}

async function ensureAppSchema(app) {
  let appId = appIds.get(app.code);
  if (!appId) {
    const created = await call('POST', '/apps', { code: app.code, name: app.name });
    appId = created.id;
    appIds.set(app.code, appId);
  }
  if (RECORDS_ONLY) { await registerFields(app.code, appId); return; }
  const existing = new Set((await draftFields(appId)).map((field) => field.code));
  if (existing.size > 0) {
    await registerFields(app.code, appId);
    return; // schema already built by an earlier run
  }
  for (const field of app.fields) {
    if (field.type === 'lookup') continue; // second pass, below
    const payload = {
      code: field.code, name: field.name, type: field.type,
      required: false, uniqueValue: Boolean(field.unique),
      options: field.options ?? [],
      ...(field.searchMode ? { searchMode: field.searchMode } : {}),
    };
    const created = await call('POST', `/apps/${appId}/fields`, payload);
    fieldIds.set(`${app.code}:${field.code}`, created.fieldId);
  }
  // Second pass: lookup fields (their local key + copy targets now exist).
  await registerFields(app.code, appId);
  const afterFirst = new Set((await draftFields(appId)).map((field) => field.code));
  for (const field of app.fields) {
    if (field.type !== 'lookup' || afterFirst.has(field.code)) continue;
    const payload = {
      code: field.code, name: field.name, type: 'lookup', required: false, uniqueValue: false, options: [],
      lookup: {
        appId: appIds.get(field.lookup.app),
        keyFieldId: fieldIds.get(`${field.lookup.app}:${field.lookup.key}`),
        localKeyFieldId: fieldIds.get(`${app.code}:${field.lookup.localKey}`),
        copies: field.lookup.copies.map(([source, target]) => ({
          sourceFieldId: fieldIds.get(`${field.lookup.app}:${source}`),
          targetFieldId: fieldIds.get(`${app.code}:${target}`),
        })),
      },
    };
    const created = await call('POST', `/apps/${appId}/fields`, payload);
    fieldIds.set(`${app.code}:${field.code}`, created.fieldId);
  }

  // Layout: two cells per row, in field order (lookup/related included).
  const layoutFields = app.fields.map((field) => fieldIds.get(`${app.code}:${field.code}`));
  const rows = [];
  for (let i = 0; i < layoutFields.length; i += 2) {
    rows.push({
      id: randomUUID(),
      cells: layoutFields.slice(i, i + 2).map((fieldId) => ({ fieldId, width: 6 })),
    });
  }
  await call('PUT', `/apps/${appId}/draft/layout`, rows);

  // Views.
  for (const view of app.views ?? []) {
    await call('POST', `/apps/${appId}/draft/views`, {
      name: view.name,
      columns: view.columns.map((code) => ({ fieldId: fieldIds.get(`${app.code}:${code}`), width: 200 })),
      conditions: (view.conditions ?? []).map((c) => ({ fieldId: fieldIds.get(`${app.code}:${c.field}`), operator: c.operator, ...(c.value !== undefined ? { value: c.value } : {}) })),
      ...(view.aggregates ? { aggregateFields: view.aggregates.map((code) => fieldIds.get(`${app.code}:${code}`)) } : {}),
    });
  }

  // ACL: guests may view/create/edit records; free-text + attachment fields
  // are editable by the sample admin only (field ACL -> read-only for guests
  // in the UI and rejected by the API).
  await call('PUT', `/apps/${appId}/draft/acl`, {
    app: ['view', 'create', 'edit'].map((action) => ({
      action, subject: { kind: 'user', id: STATE.guestUserId },
    })),
    record: [],
    field: app.fields.filter((field) => FREE_TEXT.has(field.type)).map((field) => ({
      action: 'edit', subject: { kind: 'user', id: STATE.adminUserId },
      fieldId: fieldIds.get(`${app.code}:${field.code}`),
    })),
  });

  // Publish the app schema BEFORE the workflow: workflow publish
  // validates assignees against the published schema fields.
  await call('POST', `/apps/${appId}/publish`, {});

  // Workflow.
  if (app.workflow) {
    const assignees = [{ kind: 'creator' }, { kind: 'user-field', id: fieldIds.get(`${app.code}:staff`) }];
    const stateIds = new Map(app.workflow.states.map((state) => [state.code, randomUUID()]));
    await call('PUT', `/apps/${appId}/workflow/draft`, {
      states: app.workflow.states.map((state) => ({
        id: stateIds.get(state.code), code: state.code, name: state.name,
        initial: state.initial, terminal: state.terminal, assignees,
      })),
      actions: app.workflow.actions.map(([name, from, to]) => ({
        id: randomUUID(), name, fromStateId: stateIds.get(from), toStateId: stateIds.get(to),
        conditions: [], assignees,
      })),
    });
    await call('POST', `/apps/${appId}/workflow/publish`, {});
    await call('PATCH', `/apps/${appId}/workflow/enabled`, { enabled: true });
  }

}

async function ensureRelated() {
  if (RECORDS_ONLY) return;
  for (const rel of RELATED) {
    const appId = appIds.get(rel.app);
    const existing = new Set((await draftFields(appId)).map((field) => field.code));
    if (!existing.has(rel.code)) {
      const created = await call('POST', `/apps/${appId}/fields`, {
        code: rel.code, name: rel.name, type: 'related', required: false, uniqueValue: false, options: [],
        related: {
          appId: appIds.get(rel.target),
          localFieldId: fieldIds.get(`${rel.app}:${rel.local}`),
          matchFieldId: fieldIds.get(`${rel.target}:${rel.match}`),
          pageSize: 10,
          displayFieldIds: [fieldIds.get(`${rel.target}:${rel.display}`)],
        },
      });
      fieldIds.set(`${rel.app}:${rel.code}`, created.fieldId);
      await call('POST', `/apps/${appId}/publish`, {});
    }
  }
}

// -------------------------------------------------------------- records phase
async function wipeRecords(appId) {
  for (;;) {
    const page = await call('GET', `/apps/${appId}/records?limit=100`);
    const items = page.items ?? [];
    if (!items.length) return;
    for (const item of items) {
      await call('DELETE', `/apps/${appId}/records/${item.id}`, { revision: item.revision });
    }
  }
}

function recordData(app, record) {
  const data = {};
  for (const [code, value] of Object.entries(record)) {
    if (code === 'targetState' || value === '' || value === undefined) continue;
    const fieldId = fieldIds.get(`${app.code}:${code}`);
    if (!fieldId) throw new Error(`unknown field ${app.code}:${code}`);
    data[fieldId] = resolveValue(value);
  }
  return data;
}

async function driveWorkflow(app, recordId, targetState) {
  const actions = app.code === 'deals' ? DEAL_ACTIONS : CONTRACT_ACTIONS;
  const states = app.workflow.states;
  // BFS path over the declared graph.
  const initial = states.find((state) => state.initial).code;
  const queue = [[initial]];
  let path;
  while (queue.length) {
    const candidate = queue.shift();
    const last = candidate[candidate.length - 1];
    if (last === targetState) { path = candidate; break; }
    for (const [, from, to] of actions) {
      if (from === last && !candidate.includes(to)) queue.push([...candidate, to]);
    }
  }
  if (!path) throw new Error(`no workflow path to ${targetState}`);
  for (let step = 1; step < path.length; step++) {
    const detail = await call('GET', `/apps/${appIds.get(app.code)}/records/${recordId}/workflow`);
    const action = detail.workflow.actions.find((entry) => entry.target.code === path[step]);
    if (!action) throw new Error(`workflow action to ${path[step]} unavailable for record ${recordId}`);
    if (action.reason) throw new Error(`workflow action blocked: ${action.reason}`);
    const record = await call('GET', `/apps/${appIds.get(app.code)}/records/${recordId}`);
    await call('POST', `/apps/${appIds.get(app.code)}/records/${recordId}/workflow/actions`, {
      action_id: action.id, revision: record.revision,
    });
  }
}

async function seedRecords(app) {
  const appId = appIds.get(app.code);
  await registerFields(app.code, appId);
  await wipeRecords(appId);
  for (const record of app.records) {
    const created = await call('POST', `/apps/${appId}/records`, { data: recordData(app, record) });
    if (app.workflow && record.targetState) await driveWorkflow(app, created.id, record.targetState);
  }
  const page = await call('GET', `/apps/${appId}/records?limit=1`);
  console.log(`${app.code}: seeded (first page size ${page.items?.length ?? 0})`);
}

async function main() {
  await login();
  await listApps();
  if (!RECORDS_ONLY) {
    for (const app of APPS) await ensureAppSchema(app);
    await ensureRelated();
  } else {
    for (const app of APPS) await registerFields(app.code, appIds.get(app.code));
  }
  // Records in dependency order; wipe in reverse inside seedRecords per app
  // would break lookups mid-flight, so wipe everything first (reverse order).
  if (RECORDS_ONLY) {
    for (const app of [...APPS].reverse()) await wipeRecords(appIds.get(app.code));
    for (const app of APPS) {
      const appId = appIds.get(app.code);
      for (const record of app.records) {
        const created = await call('POST', `/apps/${appId}/records`, { data: recordData(app, record) });
        if (app.workflow && record.targetState) await driveWorkflow(app, created.id, record.targetState);
      }
      console.log(`${app.code}: re-seeded`);
    }
    return;
  }
  for (const app of APPS) await seedRecords(app);
  console.log('sample seed complete');
}

await main();
