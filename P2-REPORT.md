# SuzuBase P2 batch report

## Baseline

- Main baseline verified at `3528953b4c876f47a323e881c1ce5ed927b389e5`.
- The source branch is `ziruiya03-p2-t2-system-notifications`.
- The five contracts file named in the brief was not present in this worktree;
  implementation was checked against the repository's existing migrations,
  services and P1/P1 reports instead.

## T2 - Unified system notifications

- Added migration `0034_gate2_system_notifications.sql`.
- `notifications` now distinguishes `RECORD` and `SYSTEM` sources. Record rows
  retain app/record/event foreign identity; system rows require null app/record/
  event fields plus stable source event and dedup identity.
- The existing notification center, unread/read APIs and bell now show system
  notices and leave record-notice authorization unchanged.
- System delivery resolves the current tenant administrators at delivery time
  and creates one receipt per actual administrator. Tenant RLS and row
  constraints prevent cross-tenant or role leakage.
- Backup CLI failure writes `alerts.jsonl` and a local retry outbox. It posts
  only a whitelist payload (`operation`, `status`) to the system delivery API;
  command text and sensitive diagnostics stay in local evidence only.
- Local alert evidence write failure is explicit and produces a non-zero CLI
  exit.

### T2 failure-alert end-to-end verification

- On `suzubase-lab` as `sbdeploy`, the staged CLI hash matched this branch:
  `7874e2b2dfc67a51b98b0c97eb81d3a7284a35b4015245e2594f138ab1aa552e`.
  The controlled create used
  `SUZUBASE_PG_DUMP_CMD='nc -z -w 1 127.0.0.1 1'`, targeting an unreachable
  loopback port. It did not use the real database or backup directory.
- Both create runs exited `1`. In
  `/opt/suzubase/backups/scratch-t2-verify-unreachable`, the first run left
  `alerts.jsonl=1` and `system-alert-outbox.jsonl=1`; the second appended one
  each (`2` and `2`). Both outbox entries have exactly
  `{"operation":"create","status":"failed"}` as their payload; no command or
  connection string is included in the delivery payload. The host notification
  service was intentionally unset, so both events remain pending in the
  outbox. The scratch directory is retained for audit.
- The first outbox event, `sourceEventId=9b2852a3-1389-40e2-98c4-6ac33d65b964`,
  was delivered through `POST /notifications/system/deliver` on an isolated
  branch API + PostgreSQL Compose stack. Tenant A used the event tenant ID and
  had one admin and one ordinary member; tenant B had one admin. Results:
  1. Tenant A admin received exactly one SYSTEM item and unread count `1`.
  2. First delivery inserted `1`; replay with the same event ID inserted `0`.
  3. Tenant A member had no system items and unread count `0`.
  4. Tenant B admin had no system items and unread count `0`.
  5. Persisted payload was exactly `{"operation":"create","status":"failed"}`;
     its only keys were `operation` and `status`.
- Replaced the prior direct-database dedup test with an endpoint-level
  regression test and wired a generated integration credential through local
  Compose and CI. The branch full integration suite passed: **97/97**.
  Regression/test-configuration commit: `685bbd3`. No application delivery fix
  was needed.
- A preliminary scratch attempt using a bogus `ADMIN_DATABASE_URL` also failed
  safely, but the host lacks `pg_dump` (`spawn pg_dump ENOENT`); it was followed
  by the controlled unreachable-loopback runs above. Its separate scratch
  evidence remains at `/opt/suzubase/backups/scratch-t2-verify`.

## T3 - Scheduled backups

- Host capability probes (SSH `suzubase-lab`, as `sbdeploy`; output verbatim):
  ```
  === docker ps ===
  permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
  docker_exit=1
  === /etc/systemd/system writable ===
  write_test_exit=1
  === systemctl --user ===
  running
  user_systemctl_exit=0
  ```
- Before deployment, the host's three existing backup tool files were copied to
  `/opt/suzubase/backups/pre-p2-tools-backup/` (`README.md`,
  `post-restore-normalize.sql`, and `suzubase-backup.mjs`); all remain there.
- Staged the updated CLI, watchdog, and four unit files in
  `/opt/suzubase/tools/backup/`. The service units explicitly run as root for
  Docker access. Backup `ExecStart` uses the host CLI path with `flock -n` and
  `RuntimeMaxSec=2h`; both unit files and the watchdog use `/opt/suzubase`.
  SHA-256 values were checked against this branch:
  - `suzubase-backup.mjs`: `7874e2b2dfc67a51b98b0c97eb81d3a7284a35b4015245e2594f138ab1aa552e`
  - `suzubase-backup-watchdog.mjs`: `1055f42cdb7c54c0109a840e552f5a97fa35e3e30a4174bac91cb3b1ccd22171`
  - `suzubase-backup.service`: `65ca767a0fe718e2372dd57695dbbd82d6945bf80d73d2ba311c05213614e7b2`
  - `suzubase-backup.timer`: `1f4d928eb34ad42f91c73b091c02ebdc9c8fa927f1e502d3ce46b65ff39efe21`
  - `suzubase-backup-watchdog.service`: `533695c80042b550c72f6fbc6b5632c0012c1ab9494e92e7bd8bae174e8f1098`
  - `suzubase-backup-watchdog.timer`: `cb9f4da1f9cee37ba60d2928df09f589c474005b2d913d2cc1c27ee4e4ae71ac`
- `sbctl daemon-reload` succeeded (`daemon_reload_exit=0`). Enabling the
  scheduled timer failed with `Failed to enable unit: Unit
  suzubase-backup.timer does not exist` (`enable_timer_exit=1`); the scoped
  wrapper's timer list showed no SuzuBase backup timers. `sbdeploy` cannot
  write `/etc/systemd/system` (`write_test_exit=1`), so no escalation or
  alternate install path was attempted.
- Ran the backup service's exact `ExecStart` command under `sbdeploy` with its
  backup directory redirected to a host `/tmp` scratch directory. It reached
  the CLI but failed at `docker exec` with the same Docker socket permission
  denial (`exact_execstart_exit=1`). It did not write into the live backups
  directory or contact the live database.
- Copied the existing host set
  `backup-2026-11-22T08-11-17-329Z-demo-initial` to a local isolated drill
  directory. CLI `verify` passed: 7 manifest files, `problems=[]`. Manifest
  metadata: `appVersion=3528953`, `databaseMigrations=34`; files comprise the
  database dump, five attachments, and `config/compose.yaml`. All seven
  manifest file SHA-256 values matched. The manifest contains no row/object
  count fields.
- CLI `restore` correctly refused before database changes because
  `appVersion=3528953` is unsupported by its compatibility gate (supported
  majors are `1`). For raw dump reconciliation, restored that unchanged dump
  directly with `pg_restore --clean --if-exists --no-owner` into a temporary
  local PostgreSQL 16 container (`--network none`, 512 MiB limit, no published
  ports), created the two deployment roles required by the dump/policies, and
  ran `post-restore-normalize.sql` successfully. The scratch database contained:
  `public` 38 tables / 1,122 rows; `authentication` 3 / 2; `drizzle` 1 / 34;
  total 42 tables / 1,158 rows. PostgreSQL application-schema object counts:
  42 table relations, 70 indexes, 2 sequences.
- All 5 restored attachment files matched their manifest SHA-256 values:
  `23b88a70000127a5b494459fcfef13a4d94e50fe51b3d37e1ccb735bf82ba06b`,
  `8bd90eb287e9efaad0b778bd54156e8784d4f702ffb2c5e94f5252e1053e3060`,
  `577cc461fd455eb5a0a01ec58258e04f2e20690b7c067ef416d3ef8d19703a13`,
  `c749cb27834d668c59b15e1d77a6751c29aaec26f336a4060915114206079ce5`,
  `311487125c3cef3740d50ef586a5e849757448a5db661af38ac7d485aa271f01`.
  `config/compose.yaml` was present and matched SHA-256
  `30475034e7f9fff235eb32259ae41d4bfe78c6642d84bac93fd92e1c609e8ce1`.
  The local container and scratch copy were removed; the running demo was not
  restored to or otherwise changed.
- Watchdog scratch checks: fresh `recentSuccessAt` exited 0 with no
  `alerts.jsonl`; a 48-hour-old status exited 1 and created exactly one
  `backup-alert` row (`scheduled backup did not run within the configured
  threshold`). The non-zero stale result is the CLI failure path propagated by
  the watchdog; the live status file was not touched.
- Root-only installation remains pending. Exact required step:
  `PENDING-ROOT: cp /opt/suzubase/tools/backup/suzubase-backup.service /opt/suzubase/tools/backup/suzubase-backup.timer /opt/suzubase/tools/backup/suzubase-backup-watchdog.service /opt/suzubase/tools/backup/suzubase-backup-watchdog.timer /etc/systemd/system/ && sbctl daemon-reload && sbctl enable --now suzubase-backup.timer && sbctl enable --now suzubase-backup-watchdog.timer`

## M3 - kintone import adapter

- **M3-A/M3-B local gates:** the following are covered by implementation and
  focused regression tests. Fixes are committed separately:
  - SSRF/domain validation rejects non-allowlisted hosts, non-HTTPS production
    URLs, private/internal IPs, DNS results resolving internally, and redirects
    before making source requests (`c192ad6`).
  - Required-source 403s remain source-unavailable evidence, not empty data;
    unavailable/missing-permission fields are omitted rather than written as
    null (`a293a8f`, `5f48190`).
  - Cursor pagination and checkpoint resume preserve the full record tail
    without duplicates; failed attachment downloads can be retried
    independently and retain byte length, SHA-256 and source record reference
    (`a293a8f`).
  - Every brief field type gets an explicit compatibility result. Safe CALC
    formulas stay live; non-convertible formulas require acceptance as
    DATA_ONLY and retain the formula/warning. CATEGORY blocks or requires an
    approved downgrade. Lookup detection uses the lookup property and a missing
    target remains UNRESOLVED/pending, not plain text (`c192ad6`, `242f189`,
    `5f48190`).
  - Deterministic subtable IDs use source app/record/table/row identity; row
    ordering and NULL-versus-empty reconciliation states are preserved
    (`a293a8f`).
  - M1 sealing requires all package gates and zero `verifyPackage` problems;
    failures remain blocked. The existing Gate 3 package import has a passing
    regression test (`242f189`, `a293a8f`; regression: `G3-11 golden package
    imports cleanly with current code`).
  - Comment ordering/pagination, identity-resolvable mentions and record
    linkage are retained; deleted/invisible comments are reported as source
    gaps rather than fabricated (`5f48190`).
- **M3-C runner:** `tools/kintone/run-m3-c.mjs` accepts app IDs, source tokens,
  allowed hosts and target credentials only through environment variables; it
  never prints tokens. It performs precheck, extraction/checkpointing and
  independent attachment retries, M1 package build/verification, isolated
  target import, activation or pending-completion handling, then writes a
  private per-run report. Reconciliation separates structure, records,
  subtable rows, attachments, comments, workflow, permissions, external
  dependencies and source gaps; it reports completeness, functional-equivalence
  and unresolved-dependency counts, explicit downgrades, and source-unavailable
  items independently.
- **M3-C dry run:** the full script ran against a local mock kintone HTTP
  fixture and a fresh isolated local SuzuBase Compose target. Both fixture apps
  (synthetic IDs `100` and `200`) activated; each had 1 record, 1 subtable row,
  1 attachment and 1 comment imported and reconciled. Package verification had
  zero problems, completeness was 100%, and source gaps were zero. The test
  asserts extraction timestamps and source ID ranges (`1`–`1`) are present,
  reports tokens only through HTTP authentication (not logs), and verifies
  record/subtable/attachment/comment source and target counts. This does not
  substitute for the real fixture run.

### M3-C real run

- **Target and freeze:** Ran against a newly built, isolated local Compose
  instance at `http://127.0.0.1:23183` (`suzubase-m3-c-real`), not the demo
  deployment. Both source apps were frozen for extraction. Source:
  `https://8xymf703g7p3.cybozu.com`.
- **Extraction window (UTC; JST):**

  | App | ID range | Start | End |
  |---|---:|---|---|
  | A (案件管理, app 2) | 2–13 | 2026-11-22 16:23:56.386Z (11-23 01:23:56.386 JST) | 2026-11-22 16:23:59.997Z (11-23 01:23:59.997 JST) |
  | B (得意先マスタ, app 1) | 2–6 | 2026-11-22 16:24:01.570Z (11-23 01:24:01.570 JST) | 2026-11-22 16:24:04.380Z (11-23 01:24:04.380 JST) |

- **Runner corrections found in the live run:** Kintone rejects a GET carrying
  `Content-Type: application/json` (`CB_IL02`); the adapter now sends that
  header only with a body. `/k/v1/app.json` requires `id=`, not `app=`.
  Cursor pages and deletion use `GET`/`DELETE .../records/cursor.json?id=...`,
  not POST bodies. Regression tests cover the corrected requests. Both
  applications were re-extracted after these fixes.
- **Extraction totals:** A: 30 fields, 12 records, 17 subtable rows, 4
  downloaded attachments, 3 comments. B: 13 fields, 5 records, no subtables,
  attachments, or comments. Source data completeness is **41/41 = 100%**
  (17 records + 17 rows + 4 byte/hash-verified files + 3 comments). This is
  extraction completeness, not target import completeness; **0/41 data items
  were imported** because the M1 gates did not pass.
- **Structure and constraints:** A's field codes/types are `attachments:FILE`,
  `assignee_user:USER_SELECT`, `assignee_org:ORGANIZATION_SELECT`,
  `contact_phone:LINK(CALL)`, `状态:STATUS`, `title:SINGLE_LINE_TEXT`,
  `assignee_group:GROUP_SELECT`, `details:SUBTABLE`,
  `创建人:CREATOR`, `customer_code:SINGLE_LINE_TEXT`, `类别:CATEGORY`,
  `summary:MULTI_LINE_TEXT`, `执行者:STATUS_ASSIGNEE`, `amount:CALC`,
  `quantity:NUMBER`, `registered_at:DATETIME`, `kind:DROP_DOWN`,
  `ref_url:LINK(WEB)`, `unit_price:NUMBER`, `priority:RADIO_BUTTON`,
  `doc_types:MULTI_SELECT`, `更新时间:UPDATED_TIME`, `更新人:MODIFIER`,
  `start_time:TIME`, `记录编号:RECORD_NUMBER`, `channels:CHECK_BOX`,
  `创建时间:CREATED_TIME`, `detail:RICH_TEXT`, `customer_name:SINGLE_LINE_TEXT`,
  `wish_date:DATE`. `details` children are `item_file:FILE`,
  `item_subtotal:CALC`, `item_price:NUMBER`, `item_name:SINGLE_LINE_TEXT`,
  `item_qty:NUMBER`.
  B's codes/types are `note:MULTI_LINE_TEXT`, `执行者:STATUS_ASSIGNEE`,
  `contact_name:SINGLE_LINE_TEXT`, `状态:STATUS`, `更新时间:UPDATED_TIME`,
  `更新人:MODIFIER`, `记录编号:RECORD_NUMBER`, `phone:SINGLE_LINE_TEXT`,
  `创建时间:CREATED_TIME`, `创建人:CREATOR`,
  `customer_name:SINGLE_LINE_TEXT`, `customer_code:SINGLE_LINE_TEXT`,
  `类别:CATEGORY`.
- App A requires `title` and `priority`; `priority` defaults to `中` with
  `高/中/低`. `kind` options are `保守/修理/新規/その他`, `doc_types` are
  `見積書/請求書/契約書/写真`, and `channels` are `電話/訪問/メール/オンライン`.
  `amount` is a numeric calculation `unit_price * quantity`. App B requires
  `customer_code` and `customer_name`; `customer_code` is unique, max length
  64. Both apps specify 16-digit numeric precision, 4 decimal places, and
  HALF_EVEN rounding. Layout item counts are A=22 and B=5; title fields are
  A=`title`, B=`customer_code`.
- **Compatibility states:** the adapter's field mapper returned A 18
  EQUIVALENT / 11 UNRESOLVED / 1 UNSUPPORTED and B 9 / 3 / 1. Its apparent
  EQUIVALENT for A's `customer_code` is not accepted: the source field is
  lookup-backed but its lookup object is null to this token. Corrected
  semantic totals are **26 EQUIVALENT, 15 UNRESOLVED, 2 UNSUPPORTED** across
  43 fields. A's unresolved fields are `assignee_user`, `assignee_org`,
  `assignee_group`, `details` (FILE child unsupported in target subtables),
  `创建人`, `执行者`, `kind`, `priority`, `doc_types`, `更新人`, `channels`,
  plus the unavailable lookup dependency. B's unresolved fields are
  `执行者`, `更新人`, `创建人`. Both `类别` fields are UNSUPPORTED: the P2
  category tree is not implemented. Non-ASCII choice values are unresolved
  rather than silently rewritten.
- **Records and lookup-value reconciliation:** source IDs map directly to the
  same fixture record IDs; A has 2–13 and B has 2–6. A's
  `customer_code/customer_name` snapshots matched B's master records **12/12**:
  `TOK-001`→B2 `株式会社山田商事`, `TOK-002`→B3 `鈴木製作所株式会社`,
  `TOK-003`→B4 `有限会社佐藤運輸`, `TOK-004`→B5 `高橋電気株式会社`,
  `TOK-005`→B6 `名古屋フーズ株式会社`.

  | A ID | Code | Title | Amount | Status |
  |---:|---|---|---:|---|
  | 2 | TOK-001 | POSレジ入替の見積 | 240000 | 対応中 |
  | 3 | TOK-002 | 冷蔵ケース修理依頼 | 45000 | 完了 |
  | 4 | TOK-003 | 新規出店の内装相談 | 800000 | 未処理 |
  | 5 | TOK-004 | 看板デザイン更新 | 60000 | 未処理 |
  | 6 | TOK-005 | 駐車場ライン引き直し | 90000 | 未処理 |
  | 7 | TOK-001 | 空調フィルター交換 | 48000 | 未処理 |
  | 8 | TOK-002 | 防犯カメラ増設 | 220000 | 未処理 |
  | 9 | TOK-003 | レジ周り配線整理 | 25000 | 未処理 |
  | 10 | TOK-004 | 店舗Wi-Fi更改相談 | 15000 | 未処理 |
  | 11 | TOK-005 | 冷凍庫温度異常の点検 | 38000 | 未処理 |
  | 12 | TOK-001 | 年末大掃除の手配 | 90000 | 未処理 |
  | 13 | TOK-002 | POP・ポスター差し替え | 60000 | 未処理 |

  B values were also read in full: ID 2 TOK-001 / 株式会社山田商事 /
  山田太郎 / 052-111-2222 / 名古屋市内の老舗卸売業; ID 3 TOK-002 /
  鈴木製作所株式会社 / 鈴木一郎 / 052-333-4444 / 金属加工; ID 4 TOK-003 /
  有限会社佐藤運輸 / 佐藤健 / 0561-55-6666 / 運送業; ID 5 TOK-004 /
  高橋電気株式会社 / 高橋美咲 / 052-777-8888 / 電気工事; ID 6 TOK-005 /
  名古屋フーズ株式会社 / 田中誠 / 052-999-0000 / 食品卸 (name, contact,
  phone, note).
- **Subtable rows:** extracted order, source row ID, item, quantity, unit
  price, subtotal: A2 `17` POSレジ本体 2/98000/196000, `18` 設置作業
  1/20000/20000; A3 `24` コンプレッサー交換 1/45000/45000; A4 `32`
  内装工事一式 1/650000/650000, `33` 照明器具 1/120000/120000,
  `35` サイン工事 1/30000/30000; A5 `41` デザイン費 1/60000/60000;
  A6 `94` blank item/qty/price with subtotal 0; A7 `52` フィルター
  6/8000/48000; A8 `59` カメラ本体 4/40000/160000, `60` 配線工事
  1/15000/15000; A9 `65` 配線整理作業 1/25000/25000; A10 `71`
  現地調査 1/15000/15000; A11 `78` 点検作業 1/20000/20000, `79`
  温度センサー交換 1/18000/18000; A12 `86` 清掃作業一式 1/90000/90000;
  A13 `91` 印刷費 5/12000/60000.

  **Fixture discrepancy:** the handover expected an empty subtable on A6 and
  only A2/A4/A8 to have 2–3 rows. Both the cursor extraction and an independent
  records-list read instead returned a blank-valued row 94 on A6 and a second
  row on A11 (78/79). Observed distribution is 0 empty, 4 multi-row
  (A2/A4/A8/A11), and 8 one-row records, total 17 rows. No source mutation or
  row deletion was attempted.
- **Attachments:** all four downloads had bytes and SHA-256. Record-level:
  A2 `attachments/att1.txt`, 42 bytes,
  `336dba6a006986c9889bc0d46b477836444ff7a6769fd417c70ab72b5a545f01`;
  A7 `attachments/att2.txt`, 45 bytes,
  `3cf2ea9aa0e96c9a4e3d5596e249d9265f65aca2000faf883c1a5d4f2dad4fbf`.
  Subtable: A4 row 33 `details.item_file/att3.txt`, 42 bytes,
  `051d0756376cad41c1d8fda08c2eebe01edf31e75ffd14ab5042479a3c4575c2`;
  A11 row 79 `details.item_file/att4.txt`, 43 bytes,
  `181612bc29c4ea8d448a6136051f09ee5c3509f4716effd5987bf037ccb235a7`.
- **Comments:** three on A2/A4/A8; none on B. All authored by
  `Administrator`. A2 at `2026-11-22T15:51:49Z`:
  `蘇 子睿 見積を作成しました。内容をご確認ください。`; its @mention
  resolves to the configured login user. A4 at `15:51:50Z`:
  `現地調査の日程を調整中です。`; A8 at `15:51:51Z`:
  `カメラの設置位置について先方と合意済み。`. A4/A8 have no mentions.
- **Workflow:** actual status field code is `状态`, assignee field code
  `执行者`. A's current values are `未处理` 10, `対応中` 1 (ID 2), `完了` 1
  (ID 3); this preserves the exact source spelling (`未处理`, rather than the
  Japanese spelling in the handover). ID 2's `执行者` is the login user, ID 3
  has no assignee, and IDs 4–13 have `Administrator`; `assignee_user` separately
  contains the login user on all 12 records. B workflow is disabled. The
  `app/processes.json` history/definitions endpoint returned HTTP 404 for both
  apps and is marked SOURCE_UNAVAILABLE, not treated as empty history.
- **Permissions:** app, record, and field ACL endpoints all returned data.
  Both apps have two app rules: CREATOR has all app/record rights true;
  GROUP `everyone` has `appEditable=false`, record view/add/edit/delete true,
  import/export false. Record ACL is empty for both. A has one field rule on
  `detail`: USER `miuraharudori@gmail.com` WRITE and GROUP `everyone` NONE.
  B has no field ACL rules. No ACL endpoint or principal remained unresolved.
- **External dependency and SOURCE_UNAVAILABLE:** App A's `customer_code`
  field response has `lookup: null`; `relatedApp` and `fieldMappings` are
  unavailable to this token. It is explicitly **SOURCE_UNAVAILABLE** and is
  not treated as a plain-text equivalent. Only the key and copied
  `customer_name` snapshots are reconciled (12/12 above). The full unavailable
  list is: (1) A `customer_code` lookup structure; (2) A workflow
  process/history endpoint (`/k/v1/app/processes.json`, HTTP 404); (3) B same
  workflow endpoint (HTTP 404).
- **Separate final results:** source data completeness **100% (41/41)**;
  verified functional equivalence **26/43 fields**; unresolved dependencies
  **15** (14 adapter-reported identity/choice/subtable mappings plus the
  unavailable lookup structure); unsupported fields **2** (`类别`, one per
  app); explicit accepted downgrades **5** (A permissions 3 entries, workflow
  5 entries, layout 22 items; B permissions 2 entries, layout 5 items).
  Downgrades were gate-accepted for reporting but none were materialized in a
  target because neither package passed the M1 field/dependency gates.
- **Final M1 business result:** App A: **PENDING_COMPLETION** (lookup,
  identity/choice mappings, category, and table-file mapping); App B:
  **PENDING_COMPLETION** (category and identity mappings). No M1 package was
  sealed or uploaded; there are no import jobs, activated apps, or target
  records. App A's lookup requires an authorized mapping; it was not guessed.
  Private generated reports/checkpoints remain under
  `/tmp/kintone-m3-c-real-20261123`; they contain no API tokens.

## Acceptance evidence

- Targeted backup CLI tests: 4/4 pass, including the P2 backup alert case.
- P2 kintone source safety/mapping test: pass.
- API and DB builds/typechecks pass.
- Full integrated Docker/PostgreSQL suite after the live-run adapter fixes:
  `99/99` pass, including M3-C cursor-resume and mock import regressions and the
  Gate 3 package regression.
- Migration `0034_gate2_system_notifications.sql` is registered in
  `meta/_journal.json` and applied in the local integration database.
- A post-migration OpenAPI contract regression was found and fixed for
  `/notifications/system/deliver`; the full suite passed after the fix.

## Explicit degradations and unavailable items

- Stand-in notification: database unavailable can delay in-app delivery; local
  `alerts.jsonl` and `system-alert-outbox.jsonl` remain the disaster evidence.
- M3-C real extraction is complete. Real target import remains pending due the
  unresolved mappings, unsupported category fields, and source-unavailable
  lookup structure described above.
- Demo host scheduling remains inactive pending the root-only unit installation
  above; the existing demo backup set was verified and exercised only in a
  local isolated restore target.
- A real kintone import/activation or restore drill is not verified; no
  source records were imported into the isolated target.

## Not done

- M2, category tree, group concurrent approval, encrypted/signed packages,
  real mobile verification, online sync, generic task/event platforms,
  email/Slack/webhook channels and product scheduling.
