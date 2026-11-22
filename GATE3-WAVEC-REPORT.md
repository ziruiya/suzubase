# Gate 3 — Wave C report (G3-10 … G3-15)

Branch `gate3-inheritance` (not merged, not pushed). Raw evidence:
`~/dev/suzubase-spec/gate3-evidence/` on the Mac (scenario traces, checklist,
backup drill record, audit output, drill + perf logs).

## Commits

- `e785609` G3-11/G3-14/G3-15 + gap fixes (upload cap, queue-run/resume tests,
  format-version rejection, golden package, storage portability,
  least-privilege, second-migration chain)
- `ffb43ce` G3-12 isolation matrix
- `519650e` G3-13 backup CLI + boundary copy
- `3aa94bf` G3-14 audit script + CI step
- `0965d00` G3-10 fixture apps + scenario runner
- `7a13429` G3-13 post-restore ownership normalization
- `e13066b` G3-11/G3-15 DB upgrade drill + perf benches

## Test results

- Full suite (`pnpm test`): **93/93 pass** (baseline 68 + 25 new), 0 fail.
- Typecheck (`pnpm -r typecheck`): api + web pass. Docker build pass.
- Browser suite (`pnpm test:browser`, 3 Gate 1/2-era tests): **cannot run in
  the local test image** — the image is Alpine/musl; Playwright's glibc
  Chromium headless shell cannot execute there (missing ELF interpreter;
  with `gcompat` it then misses X libraries). Pre-existing environment gap,
  unrelated to Wave C (no browser-tested surface changed except two
  boundary-copy strings). These tests run on the hosted glibc CI runner.

## G3-10 Fixtures + core scenario — DONE

- `tools/fixtures/fixture-tools.mjs`: re-runnable construction of
  ①「顧客・案件管理」(24 fields F1–F17 variety + F27 auto-number CASE- +
  subtable + 3-layer ACL + published workflow 受付→対応中→完了 with reject +
  WORKFLOW_REPAIR + comments incl. @mention + attachments + notification
  rule; 52 records, 2 soft-deleted, deleted-field history surviving) and
  ②「紹介・着工管理」 with cross-app lookup into ①.
- Attachments are single-version product-wide (storage key hardcodes v1):
  fixture uses multiple files + lifecycle states (ATTACHED ×3 on records, one
  DETACHED/DELETED file, one READY-only file). Multi-version is NOT faked.
- `tools/fixtures/run-scenario.mjs phase-a|phase-b`: Phase A on deployment A
  (Compose project gate3c), Phase B on a FRESH deployment B (gate3d, distinct
  instance id `19469252-…`, empty DB). **Checklist 24/24 PASS**
  (`checklist.json` / `checklist.md` in evidence): counts incl. soft-deleted
  (52/52, 2/2), subtable rows 104/104, attachment SHA-256 bodies identical,
  workflow distribution open 40 / doing 4 / done 8, current assignments
  44 = package assignee set (source raw table holds 65 rows incl. superseded
  transition rows — history, correctly not assignments), comment count/time
  fidelity + migration markers, history migration-marked, ACL sample
  (member-visible 37 = 37), auto-number fresh record = CASE-0053 (no
  collision, counter advanced), notification rules imported disabled,
  zero import outbox. App ② without target → pending + invisible +
  activation blocked (400) → resolve-dependencies → activated; app ② with
  target present → direct complete. Evidence chain: `app1-package.zip`,
  `app2-package.zip`, `source-snapshot.json`, `traces.jsonl`,
  `app1-import-job.json`, `app1-report.json`, `app2-import-job.json`,
  `app2-second-import-job.json`, `checklist.json`, `checklist.md`.

## G3-11 Compatibility + portability — DONE

- Format-version tests: formatVersion `2.0` rejected with reason;
  `minimumProgramVersion 99.0.0` rejected with upgrade recourse; no crash
  (in `gate3-wavec.test.cjs`).
- Golden package: `packages/db/test/fixtures/golden-app-1.zip` (6,160 bytes,
  compact app — 3 records, 1 attachment, auto-number, comment; built by
  `tools/fixtures/build-golden.mjs` with current code) + regression test
  importing it with current code. Compact golden chosen over the full
  fixture package per the brief's allowance (full package is 43 KB and
  carries scenario-specific identities).
- DB upgrade drill (`tools/drills/db-upgrade-drill.mjs`, evidence
  `db-upgrade-drill.log`): Gate 2-era DB (32 migrations, fixture tenant)
  upgraded with all current migrations (34): tenant/data survived, Gate 3
  tables present, journal matches. **Reversibility declaration:** 0032 and
  0033 are additive (new tables, `apps.activation_state` column) —
  schema-reversible by dropping the added objects, but any data written
  into Gate 3 tables after upgrade would be lost on such a downgrade;
  treat as one-way in production once Gate 3 features are used.
- Storage portability test: same package restored into two tenants with
  different storage roots → identical attachment SHA-256, bodies and
  references. S3 not claimed (not implemented).

## G3-12 Dual-tenant isolation — DONE

`packages/db/test/gate3-isolation-matrix.test.cjs` (11/11): list, detail,
search, count, aggregate, export (cross-tenant 404, no existence leak),
attachment download, background-task tenant scoping (task rows carry and
verify tenant context; worker refuses tenant-less rows), composite-FK
cross-tenant refusal, import isolation (A's job invisible under B's session
— 404 after the admin gate; same-instance cross-tenant import lands
products only in B), RLS floor (runtime role without tenant context reads
0 records), P0 group (injection-shaped ids → 400/404).

## G3-13 Backup/restore CLI + drill — DONE

- `tools/backup/suzubase-backup.mjs` (create / verify / restore / list):
  pg_dump custom-format native backup + attachments + config + manifest
  with SHA-256, auto-verify after create, pre-restore compatibility refusal
  (unsupported app major; backup DB newer than deployment), retention via
  `SUZUBASE_BACKUP_RETENTION` (default 7), sets labelled sensitive-data.
  Failure = non-zero exit + reason in deployment log + per-admin alert line
  in `alerts.jsonl`. **Decision/gap:** the product `notifications` table is
  FK-bound to record events/outbox, so no generic in-app admin channel
  exists in P1 — the alert is delivered as log + `alerts.jsonl` + exit code,
  documented in `tools/backup/README.md`.
- Boundary copy: tool README **and** the app's Import/Export tab (both
  sections) state M1 package ≠ disaster backup, deployment backup ≠
  migration tool.
- Drill (evidence `backup-drill/`): backup of deployment B running the
  fixture apps (63 records, 3 apps, 3 attached files) → verify OK → restore
  into fresh deployment E → counts match, attachment hashes match, health
  OK, login 200 and apps list served. One forced-failure run recorded
  (create.log from the first attempt: log + alert + exit 1).
- **Drill finding (real product bug class):** `pg_restore` recreates
  objects owned by the restoring role; the migrator then fails with
  `permission denied for schema drizzle` (42501). Fix shipped:
  `tools/backup/post-restore-normalize.sql` + CLI post-restore step
  (`SUZUBASE_POST_RESTORE_SQL_CMD`), README marks it required.

## G3-14 Least privilege + audit integrity — DONE

- Least-privilege tests (`gate3-wavec.test.cjs`): ordinary user cannot see
  import-pending apps/wizard; app admin without tenant-admin cannot issue
  migration tokens (403 on upload/view/list/token); tenant admin without a
  migration token is rejected by the migration channel; queue-run requires
  the migration token (session token → 401); export gated by the app ACL
  `export` bit (no bit → 404, bit granted → 201).
- `tools/audit/audit-integrity.mjs` (re-runnable; also wired into CI with
  `--sample 20`): run against the restored deployment with `--sample 25` —
  **6/6 checks PASS** (evidence `audit-output.json`): history↔revision
  sample 25/25, migrated provenance four elements 25/25, migration audit
  rows present, import-period outbox = 0, no duplicate notifications,
  processed-outbox readable.

## G3-15 Tests + CI + performance — DONE

- Named-test coverage: Wave A/B items confirmed present (manifest mismatch
  refusal, export resume, attachment triple hash, system-field rejections,
  token expiry/cross-job/cross-app, idempotent concurrent re-run, duplicate
  warning, FAILED cleanup zero, ACL default-deny, unmapped assignee,
  cross-app dependency pending→map→activate, zero side effects,
  auto-number). Wave C added: queue-run + resume, format-version rejection,
  golden regression, dual-tenant matrix, backup verify + restore-refusal,
  second-migration chain fidelity (re-export keeps FIRST
  importJobId/sourceActorId), storage portability, least-privilege tiers,
  export ACL bit, DB upgrade drill (scripted), backup drill (scripted CLI +
  recorded run).
- CI (`.github/workflows/ci.yaml`): build + typecheck + full suite incl.
  golden regression + audit sample step.
- Performance (evidence `search-bench.log`, `large-app-bench.log`):
  100k-record search, HTTP end-to-end: exact P50 4 ms / **P95 10.9 ms**,
  tail-4 P50 4 ms / **P95 12.3 ms** (Gate 1/2 baseline ≈53 ms; this run on
  the Mac Docker stack, warm cache — directionally better, method differs
  slightly: HTTP end-to-end vs DB-plan timing).
  Large app: 10,000 records + 500 attachments, package 574,427 bytes:
  **export 372 ms, import 9,448 ms**, 10,000/10,000 records, 0 attachment
  failures. Bottleneck: the import write path (~0.94 ms/record across
  record + projection + unique-value + history writes in per-app
  transactions) is ~25× the export read path; export is a single streaming
  pass. No pass line per brief.

## Gap fixes required by the brief — both DONE

1. Import upload size cap: route-scoped streaming parser in
   `apps/api/src/main.ts` — `/imports/upload` limit is
   `maxImportPackageBytes` = 256 MiB (exported from
   `apps/api/src/import.ts`); the global attachment parser stays at 8 MB.
   Test: 9 MiB package uploads successfully; attachment route still 413.
2. Queue-run + resume tests: worker-drained queue-run (token flags
   `execute_requested`, audit `execution-queued`, job completes via the
   real worker) and `/imports/:id/resume` (400 from non-interrupted state;
   DB-forced `stage='writing'` → resume → validated → run completes).

## Honest remainders for the verifier

- Browser suite not runnable in the local Alpine test image (see above);
  re-run on the hosted glibc CI.
- Backup failure "in-app notification" is delivered as deployment log +
  `alerts.jsonl` + exit code, not an in-app notification (no generic
  channel exists in P1) — decision documented in the tool README.
- Scenario checklist item "workflow assignment count" compares the
  package's current-assignee set (44) — the source deployment's raw
  `workflow_assignments` table retains 65 rows including superseded
  transition rows; those are history rows, also present in the migrated
  history, not current assignments.
- Golden package is a compact app by design (brief allowance), not the
  full 52-record fixture package.
- Search P95 comparison vs the ≈53 ms baseline crosses measurement
  methods (HTTP end-to-end now vs DB-plan then); treat as indicative.
