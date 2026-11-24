// One-time provisioning for the public sample site (migration 0052):
// creates the sample tenant, its admin (with login credentials), the guest
// member (no credentials -- sessions are minted by POST /auth/sample-session
// after a Turnstile check), fictional staff members, and the
// authentication.sample_site designation row.
//
// Run on the deployment host (needs docker access to the postgres container):
//   SAMPLE_SITE_KEY=<turnstile site key> node tools/sample/provision-sample.mjs
// Outputs (server-side only, mode 600):
//   $SAMPLE_STATE_FILE   (default /opt/suzubase/sample-site.json)  ids only
//   $SAMPLE_ADMIN_ENV    (default /opt/suzubase/sample-admin.env)  admin login
// Idempotent: if the state file exists, it prints it and exits 0.
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const STATE_FILE = process.env.SAMPLE_STATE_FILE ?? '/opt/suzubase/sample-site.json';
const ADMIN_ENV = process.env.SAMPLE_ADMIN_ENV ?? '/opt/suzubase/sample-admin.env';
const PG_CONTAINER = process.env.SAMPLE_PG_CONTAINER ?? 'suzubase-postgres-1';
const SITE_KEY = process.env.SAMPLE_SITE_KEY;
const ADMIN_EMAIL = process.env.SAMPLE_ADMIN_EMAIL ?? 'sample-admin@example.jp';
const COMPANY = 'ひだまり不動産株式会社';
const STAFF = [
  ['sato', '佐藤 葵', 'staff-sato@example.jp'],
  ['suzuki', '鈴木 健太', 'staff-suzuki@example.jp'],
  ['nakamura', '中村 翼', 'staff-nakamura@example.jp'],
];

if (existsSync(STATE_FILE)) {
  console.log(`already provisioned: ${STATE_FILE}`);
  process.exit(0);
}
if (!SITE_KEY) {
  console.error('SAMPLE_SITE_KEY is required (Turnstile site key for the sample host)');
  process.exit(1);
}

const tenantId = randomUUID();
const adminId = randomUUID();
const guestId = randomUUID();
const staff = Object.fromEntries(STAFF.map(([key]) => [key, randomUUID()]));
const adminPass = randomBytes(18).toString('base64url');

const esc = (value) => value.replaceAll("'", "''");
const userRow = (id, email, name) =>
  `INSERT INTO users (tenant_id, id, email, display_name) VALUES ('${tenantId}', '${id}', '${esc(email)}', '${esc(name)}');`;
const memberRow = (id, flags = '') =>
  `INSERT INTO tenant_members (tenant_id, user_id ${flags}) VALUES ('${tenantId}', '${id}');`;

const sql = `
BEGIN;
INSERT INTO tenants (id, name, allow_app_creation, local_drafts, time_zone)
VALUES ('${tenantId}', '${COMPANY}', false, false, 'Asia/Tokyo');
${userRow(adminId, ADMIN_EMAIL, 'サンプル管理者')}
${userRow(guestId, 'guest@example.jp', 'ゲスト（サンプル閲覧）')}
${STAFF.map(([, name, email], i) => userRow(Object.values(staff)[i], email, name)).join('\n')}
INSERT INTO tenant_members (tenant_id, user_id, is_admin, can_create_apps, can_manage_recycle_bin)
VALUES ('${tenantId}', '${adminId}', true, true, true);
${memberRow(guestId)}
${Object.values(staff).map((id) => memberRow(id)).join('\n')}
INSERT INTO authentication.login_credentials (tenant_id, user_id, email, password_hash)
VALUES ('${tenantId}', '${adminId}', '${esc(ADMIN_EMAIL)}', authentication.crypt(
  encode(authentication.digest('${adminPass}', 'sha256'), 'hex'), authentication.gen_salt('bf', 12)
));
INSERT INTO authentication.sample_site (tenant_id, guest_user_id, site_key, enabled)
VALUES ('${tenantId}', '${guestId}', '${esc(SITE_KEY)}', true);
COMMIT;
`;

execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', 'suzubase', '-d', 'suzubase', '-v', 'ON_ERROR_STOP=1'],
  { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });

writeFileSync(STATE_FILE, JSON.stringify({
  tenantId, adminUserId: adminId, guestUserId: guestId, staff,
}, null, 2) + '\n', { mode: 0o600 });
writeFileSync(ADMIN_ENV,
  `SAMPLE_ADMIN_EMAIL=${ADMIN_EMAIL}\nSAMPLE_ADMIN_PASSWORD=${adminPass}\n`, { mode: 0o600 });
console.log(`provisioned sample tenant ${tenantId}; state=${STATE_FILE} adminEnv=${ADMIN_ENV}`);
