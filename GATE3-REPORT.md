# SuzuBase Gate 3 completion report

- Branch `gate3-inheritance` (not merged to `main`, not pushed by the builders)
- Base: `main` at `ae9c74aea847d537fdd88b340e025590ac52b190` (B0 + Gate 1 + Gate 2 merged)
- Verification date 2026-11-22 JST
- Wave reports and raw evidence: `GATE3-WAVEC-REPORT.md` (repo root),
  `~/dev/suzubase-spec/gate3-evidence/` (scenario traces, checklist, backup
  drill record, audit output, drill and perf logs), verifier evidence in
  `~/dev/verify-g3/` (fresh projects `verify-g3*`).

## Builder attribution (read first)

- **This batch was built by Muse directly** (the coordinator builder
  subagents), **NOT by Codex**. Codex ChatGPT quota was exhausted
  (recovery 2026-11-25 15:36 JST) and the user ordered progress via Muse
  under his standing decide-yourself / maximum-permission orders, following
  the Gate 2 completion precedent (Gate 2 items G2-11 to G2-15 were also
  completed by Muse directly for the same reason).
- **Independent verification was performed by a separate agent that wrote
  none of the code.** Its results are in the Independent verification
  section below and are reported separately from builder results wherever
  the numbers differ.
- Commit count note: `git rev-list --count main..HEAD` before this report
  commit is **17** builder commits (full list at the end of this report).

## Verdict

Gate 3 items G3-01 to G3-15 are all Done, with G3-13 marked Done with a
documented deviation (deviation 1, backup failure in-app notification).
The core differentiation combination B1 + B2 + B3 + B7 + B9 is proven by
the G3-10 cross-deployment scenario: a real business app was exported
from deployment A, imported into a fresh deployment B, fully restored
and verified, with the evidence chain generated before activation.

## Full test results (builder runs)

```text
Wave A complete (G3-01 to G3-05):   tests 58, pass 58, fail 0
Wave B complete (G3-06 to G3-09):   tests 68, pass 68, fail 0
Wave C complete (G3-10 to G3-15):   tests 93, pass 93, fail 0
Typecheck (pnpm -r typecheck): api + web pass. Docker build pass.
Browser suite (3 Chromium tests): not runnable in the local Alpine dev
  image - see deviation 3. Hosted CI is the arbiter.
托管 CI: run 44999907127 on 5eb3e68 - conclusion success (attempt 2).
  All steps green, including the 3 Chromium browser tests (14 s) and the
  post-suite audit. The first hosted run (44999038047, fb99bda) failed in
  the combined test step: root cause was an audit-integrity population
  bug, NOT a product defect - the audit selected package-import events
  by source = 'migration' alone, conflating Gate 1/2 schema-publication
  events ('schema-migrated' / 'workflow-pool', which legitimately carry
  no import provenance and do produce outbox rows) with Gate 3 import
  events. Reproduced locally in CI order (audit failed twice against
  the post-suite database; all 25 real import events fully provenanced);
  fixed in 433ea7d by scoping checks 2/3a to import_job_id IS NOT NULL
  (the product read path's own discriminator; negative control: an
  injected import outbox row still fails the audit). CI step split into
  named steps in 5eb3e68 for diagnosability. Honest remainder: attempt 1
  of run 44999907127 failed once in the integration step (79 s vs 86 s
  on the passing rerun) and passed on rerun; job logs are not
  retrievable through the available API tooling, so the specific test
  behind that single failure is unidentified - recorded as a one-off
  flake sighting, not a diagnosed fix.
```

## Wave A - Export (G3-01 to G3-05)

- Migration `0032`: `export_jobs` table and the `deployment_instance`
  identity used to distinguish source deployments.
- `ExportService` + `export-package.ts`: package format **1.0** (the
  format spec lives in the module header), `verifyPackage`, manifest
  counts across **21 object types**, pre-seal reconciliation (a count
  mismatch refuses sealing), a SHA-256 for every file in the package,
  and the conditional-inclusion discipline: objects that exist in the
  product model but are unimplemented in P1 are marked `unsupported`,
  objects absent in the source are marked `absent`; the two are never
  conflated.
- The background worker claims export jobs: proven live, with a package
  sealed by the background worker alone (no request-path shortcut).
- G3-02 structure export: app metadata and settings, plus **all
  field-definition version snapshots** and **deleted-field archives
  with their surviving values**, form layout, views, all published and
  disabled workflow versions, subtable structure.
- G3-03 records and attachments: all records **including soft-deleted**
  (with deletion markers), all subtable rows, current workflow state
  and assignees and the bound workflow version per record, auto-number
  values and the source record number preserved (ruling 8). Attachments
  are read **only through the Storage Adapter** and referenced by
  **(id, version, SHA-256) triples**; `TEMPORARY` uploads are excluded
  and counted in the manifest.
- G3-04 comments and history: deleted comments travel as **metadata
  only - the body is nowhere in the package** (asserted by a test that
  scans the package). History is exported event-level, and the
  migration provenance chain (`import_job_id` / `source_actor_id` /
  `source_timestamp`) of already-migrated events is copied **verbatim**,
  so a second migration never launders migrated events into local ones.

## Wave B - Import (G3-06 to G3-09)

- Migration `0033`: `import_jobs`, migration tokens (prefix `sbm1_`),
  `migration_audit_log`, provenance columns on migrated objects, and
  app activation isolation (staged apps are invisible until activated).
- G3-06 migration channel (B7): the **7 token rules of ruling 7 are
  implemented exactly** (tenant-admin issued; bound to a single import
  job and a single target app; expiry is the earlier of job terminal
  state and 24 hours after issue; no renewal; plaintext shown once;
  every migration-channel write audit-logged; wizard server writes go
  through the migration channel, never through ordinary session app
  permissions). Daily-API writes to system fields are **rejected
  item by item, each with a test**. Import produces **zero outbox rows
  and zero notifications** - asserted, not assumed.
- G3-07 job state machine: `UPLOADED -> VALIDATING -> STAGING -> READY
  -> ACTIVATED`, with `FAILED` / `CANCELLED` terminal. Preflight runs
  `verifyPackage`, format and minimum-program-version compatibility,
  and **reference integrity** item by item. Re-importing the same
  package requires an explicit duplicate warning confirmation
  (`confirmDuplicate`); the conflict strategy is **create-new only**.
  FAILED/CANCELLED cleanup is verified down to **zero** residual rows.
  An idempotent concurrent re-run of the same job is proven by test.
- G3-08 wizard UI: existing-target mapping only for cross-app
  dependencies (ruling 4 - no login accounts are ever created by
  import); assignee handling per ruling 5 (unmapped assignees go to
  the completion-pending list, never silently to the operator);
  unmapped ACL subjects are **default-deny dropped** and listed in the
  report; pending apps are isolated - staged apps are filtered out of
  **both** ACL scope functions, so they are invisible and unusable
  before activation.
- G3-09 evidence chain (B9): the four-piece chain (object manifest,
  dependency report, verification results, difference report) is
  **auto-generated before activation; there is no activate button
  before the report exists**; the activation itself is audit-logged.
  The per-app token re-issue list follows ruling 6 (source tokens
  travel as metadata only; re-issue is per-item admin confirmation,
  plaintext shown once), and the difference report carries the list of
  external systems to notify.
- Documented decision: `record_events.import_job_id` deliberately has
  **NO foreign key** - restored events must be able to name jobs of
  the source deployment, which do not exist as rows in the target.

## Wave C - Proof, isolation, backup, audit (G3-10 to G3-15)

Detail is in `GATE3-WAVEC-REPORT.md`; the load-bearing numbers:

- G3-10 fixtures: two meaningful business apps built by re-runnable
  scripts in `tools/fixtures/` (app 1 self-contained, 52 records; app 2
  with a cross-app lookup into app 1). The cross-deployment scenario
  checklist is **24/24 PASS** (evidence `checklist.json` / `checklist.md`).
- G3-11: golden package (compact app, **6,160 B**) stored in the repo
  with a CI regression import; DB upgrade drill from the Gate 2 schema
  (**32 migrations**) to current (**34**) with fixture data surviving;
  storage portability test (same package, two storage roots, identical
  attachment hashes and references). S3 is not claimed (registered P2).
- G3-12: dual-tenant isolation matrix **11/11**, including the P0 RLS /
  dynamic-SQL group and same-instance cross-tenant import.
- G3-13: backup CLI in `tools/backup/` (create / verify / restore /
  list) plus a full drill. The drill found and fixed a **real bug**:
  `pg_restore` recreates objects owned by the restoring role and the
  migrator then fails; fixed by `post-restore-normalize.sql` plus a CLI
  post-restore step. See deviation 1 for the notification substitution.
- G3-14: audit-integrity script run at **sample 25: 6/6 checks PASS**
  (history-revision correspondence, migrated provenance four elements,
  migration audit rows, import-period outbox = 0, no duplicate
  notifications, processed-outbox readable); also wired into CI.
- G3-15 gap fixes: `/imports/upload` has a **route-scoped 256 MiB**
  streaming parser while the global attachment limit stays **8 MB**
  (test: a 9 MiB package uploads; the attachment route still returns
  413); queue-run and resume tests added. Full suite **93/93**.

## Independent verification (separate agent, fresh projects verify-g3*)

- Full suite re-run under a CI-equivalent environment: **93/93 pass**.
  Note: one legacy test (`gate2-related.test.cjs:65`) hard-depends on
  the `TEST_API_URL` environment variable that CI sets; without it the
  test fails with an invalid-URL error. That is harness fragility in a
  Gate 2-era test, not a product defect.
- Scenario independently re-run on distinct instances: **24/24 with
  identical values** - records 52/52, subtable rows 104/104, attachment
  hashes identical, workflow distribution 40/4/8, assignments **44 = 44**
  (the 65-row raw-table explanation confirmed: the extra rows are
  superseded transition rows, i.e. history, not current assignments),
  comment timestamps exact, auto-number `CASE-0053` with no collision,
  import outbox 0.
- Isolation matrix standalone **11/11**, plus manual cross-tenant spot
  checks: all returned 404 with no existence leak.
- Backup drill re-run independently, **including the health check the
  builder drill had skipped**: `"health":"ok"`, restored counts
  **70|10|11 exact**, **19 attachment hashes identical**, login smoke
  passed. Forced-failure cases produce exit 1 plus `backup.log`
  FAILED/ALERT entries plus `alerts.jsonl` lines.
- Audit-integrity re-run at `--sample 25`: **6/6**.
- Performance re-measured (HTTP end-to-end, in-container): 100k search
  P95 **6.5 ms exact / 8.5 ms tail** (builders measured 10.9 / 12.3 ms;
  the Gate 1 baseline of about 53 ms used a different DB-plan method -
  directional comparison only, see deviation 5).
- Large app re-measured: 10,000 records + 500 attachments, package
  **572,539 B**, export **358 ms**, import **10,006 ms**, **0 attachment
  failures** (builders: 372 ms / 9,448 ms - consistent). Bottleneck is
  the import write path (record + projection + unique-value + history
  writes in per-app transactions), about 25x the export read path.

## Per-item verdicts

| Item | Verdict |
| --- | --- |
| G3-01 Export job and package format 1.0 | Done |
| G3-02 Structure export (all field versions, deleted-field archives) | Done |
| G3-03 Records and attachments export | Done |
| G3-04 Comments and history export | Done |
| G3-05 Config export (ACL / notifications / relations / token metadata) | Done |
| G3-06 Migration channel and token rules | Done |
| G3-07 Import state machine, preflight, idempotency, cleanup | Done |
| G3-08 Mapping wizard and completion-pending handling | Done |
| G3-09 Verification and difference report (evidence chain) | Done |
| G3-10 Core cross-deployment scenario (24/24) | Done |
| G3-11 Version compatibility and storage portability | Done |
| G3-12 Dual-tenant isolation matrix (11/11) | Done |
| G3-13 Backup/restore CLI and drill | Done with documented deviation (deviation 1) |
| G3-14 Least privilege and audit integrity (6/6 at sample 25) | Done |
| G3-15 Tests, CI, performance | Done |

## Deviations and honest remainders

1. **Ruling 9 backup-failure notification - in-app leg substituted.**
   The in-app （站内） leg is SUBSTITUTED by deployment log +
   `alerts.jsonl` + non-zero exit code. Verified fact: the
   `notifications` table (migration `0030`) has `app_id` / `record_id`
   / `event_id` all NOT NULL with foreign keys to outbox/records, so
   no generic deployment alert can be inserted without a record event.
   The failure is **not silent**: the three-part signalling was proven
   in forced-failure runs by both builders and the verifier. Registered
   as a follow-up below (needs a system-notice mechanism decision in a
   later batch).
2. **Attachments are single-version product-wide.** The storage key
   hardcodes v1 and there is no version column. This is Gates 1/2
   heritage, not a Gate 3 regression; package triples carry version=1
   truthfully, and the fixtures do not fake multi-version attachments.
   Multi-version attachments do not exist yet (registered below).
3. **The 3 Chromium browser tests are not runnable in the local Alpine
   dev image** (Chromium absent; the Playwright glibc headless shell
   cannot execute on musl). Environment-only; no browser-tested surface
   changed in Wave C beyond two boundary-copy strings. Hosted CI is
   the arbiter: 托管 CI: run 44999907127 on 5eb3e68 - conclusion success; the 3
   Chromium browser tests pass on the hosted runner (14 s), so this
   deviation is closed. See the test summary block for the audit
   population bug (433ea7d) that caused the first hosted failure and
   the one unidentified integration-step flake on attempt 1.
4. **Migration reversibility (ruling 11).** Migrations `0032` / `0033`
   are additive and schema-reversible (dropping the added objects),
   but **one-way in production once Gate 3 data exists** - a downgrade
   would lose data written into the Gate 3 tables.
5. **Search P95 cross-gate comparison is directional only.** The Gate 1
   baseline (about 53 ms) was measured with a DB-plan method; Gate 3
   numbers are HTTP end-to-end. The direction is better; the ratio is
   not a like-for-like claim.

## Decisions and conflicts

- Conflicts with `contracts-v1.md`: **none unresolved**. （合同冲突：无未决。）
- `record_events.import_job_id` has deliberately NO foreign key (see
  Wave B): restored events name source-deployment jobs.
- Backup failure notification substitution: see deviation 1.
- Golden package is a **compact** app (6,160 B) rather than the full
  52-record fixture package (43 KB, scenario-specific identities) -
  an allowance the brief explicitly grants.
- Container-mode `verifySet` skips `pg_restore --list`; file hashes are
  still verified, and readability is proven at restore time.
- The importer coerces `null` to the field default for NOT NULL fields
  rather than failing the whole job on such rows.

## Four-state registry increments （四态登记增量）

States follow scope-draft v1.2 section F.2 exactly: the only legal
states are **P1 / P2 / L / 不做**, and P2 entries must carry a dependency
and an entry condition. New registrations from this batch:

| Item | State | Entry condition |
| --- | --- | --- |
| Package encryption / signing | P2 (candidate) | A real cross-organization package delivery scenario appears (ruling 10). Checksums prove untampered only; they are not a confidentiality measure. |
| S3 Storage Adapter implementation, run against the same adapter contract test suite | P2 | The first deployment need for S3 storage (registered by G3-11; the portability test in this batch covers local roots only). |
| Package format v2 plus the full backward-compatibility conversion window | P2 | Format 2.0 actually ships. Until then the P1 form of the window is the golden-package CI regression delivered in this batch. |
| Backup failure in-app admin notification (generic system-notice mechanism) | P2 (follow-up) | A generic system-notice channel is designed (see deviation 1: the current notifications table cannot carry a deployment alert). |
| Multi-version attachments | P2 | Attachment versioning is scheduled as product work; the gap predates Gate 3 (see deviation 2). |
| M2 full-environment package | P2 | Unchanged from the brief prohibitions: M1 runs stable plus dependency-graph scanning. Not built in this batch. |
| M3 kintone importer | P2 | Unchanged: depends on the P1 data model and the M1 package format being stable. Not built in this batch. |
| M4 scheduled backup plus backup UI | P2 | Unchanged: this batch delivers the manual CLI and the drill only (ruling 9). |

No item in this batch is registered as L or 不做.

## Commit list (branch `gate3-inheritance`, base `main` ae9c74a)

17 builder commits, oldest first:

- `4536c219594662cb9047cfcecd9550c30b1b1275` G3-01: export job, package format 1.0 and pre-seal reconciliation
- `0e4d7f6275229cf4c6635519e2be1dbf2aa432b7` G3-01: fix export directory lookup and add OpenAPI contracts for export routes
- `b0360a7dbe7ce850587b712ea4b2a2f38c8a2d1d` G3-02..G3-05: export content tests for structure, records, attachments, comments, history and config
- `c11373705be3ad6c764fac4b950f9973a5124662` G3-06: import migration 0033 - import_jobs, migration tokens, audit log, provenance columns, app activation isolation
- `2cfe2873a2812b0a3fda14ed5f7b9928c9480608` G3-06: provenance chain correction, activation grant, definer purge/reference functions, migration rendering markers
- `6d4cac6146d0f8dadad7ccc3ee2080333a50842b` G3-07/G3-08/G3-09: migration-channel import - job state machine, preflight, idempotent executor, mapping + pending completion, verification and difference report, worker execution
- `901ea7f0035a928b6518d6aead89fe43f391e27a` G3-09: OpenAPI contracts for /imports routes and per-application token re-issues
- `fcbb376e0700efc143b002e9f372efa217a9ca24` G3-08: import wizard UI (mapping, migration token, pending resolution, report-gated activation), settings export panel with decision-6 re-issues, migration badges
- `73e0d7f0eca1e06ae4237eac1a64f5328621f919` G3-06..G3-09: import test suite - system-field rejection, channel separation, idempotency, duplicate warning, cleanup, ACL default-deny, assignee pending, cross-app dependency, zero side effects
- `e785609dcb199dfc77b0876e4c5a3f58ed79c848` G3-11/G3-14/G3-15 + gap fixes: route-scoped import upload limit (>8MB packages), queue-run/resume tests, format-version rejection, golden package + regression, storage portability, least-privilege and second-migration chain tests
- `ffb43ce774ce119536fd32b142d6c27da3a23764` G3-12: dual-tenant isolation total acceptance matrix + P0 RLS/dynamic-SQL group + same-instance cross-tenant import
- `519650ec274e9d732d7e8c181589234c7b53d449` G3-13: deployment backup/restore CLI (create/verify/restore/list, pg_dump sets, compatibility refusal, failure log+alert+exit code) + boundary copy in tool doc and Import/Export tab
- `3aa94bfdbb5d91a68ae8fe9933f7dabff12a6270` G3-14: audit/history integrity checker script (history-revision, migrated provenance four elements, outbox reconciliation) wired into CI
- `0965d00543b578721d6d05e4b7e958a58e86135e` G3-10: re-runnable fixture construction (two business apps) + cross-deployment scenario runner with source-vs-target checklist
- `7a13429b8e9fde48d4fad1db61796f73c4341666` G3-13: post-restore ownership normalization SQL + CLI post-restore step + README (drill finding: pg_restore ownership breaks migrator)
- `e13066b68095fb5eef0bd24f5a32b2e1f5e7013b` G3-11/G3-15: DB upgrade drill (Gate2 schema -> current, data survives) + search/large-app perf benches
- `ed4635b1bffd49cf1f40a1cac70b0824d5d704fa` G3-10..G3-15: Wave C report (scenario 24/24, suite 93/93, drills, perf, honest remainders)
- (this commit) G3: GATE3-REPORT.md completion report

The report is the final commit on `gate3-inheritance`. The branch was
not pushed and not merged by the builders; merge is for the coordinator
to decide, and the hosted CI line above is to be filled from the branch
CI run after push.
