# P3-A Automation Foundation - Completion Report

Date: 2026-11-23
Branch: `p3-a-automation-foundation`
Baseline HEAD before P3-A: `82e33d6`

## Scope audit

| Item | Status | Evidence / deviation |
|---|---|---|
| Core tables and migrations 0035-0039 | Incomplete then repaired | 0035 creates `automation_rules`, `automation_rule_versions`, `automation_grants`, `automation_runs`, `automation_run_actions`, `automation_schedules`, `automation_webhook_deliveries`, `automation_audit_events` plus outbox/record-event bindings. 0036-0039 add append-only audit, workflow event kinds, schema FK, and archive actions. 0036 incorrectly re-added `source_schema_version` already created by 0035; removed duplicate in this round. |
| Eight core table constraints | Completed | Tenant composite keys, composite FKs, unique run/action keys, immutable published versions, append-only automation audit, RLS/runtime grants, record/outbox tenant boundaries, and automation schedule constraints are present. |
| Rule Schema and trigger binding | Completed | Versioned Zod schema in `apps/api/src/automation.ts`; record/workflow trigger types and field-change constraints are explicit. |
| EVENT_SNAPSHOT / CURRENT_STATE | Completed | Implemented as distinct condition stages; event snapshot uses persisted snapshot/changes and current state re-reads the record before terminal action handling. |
| SKIPPED_STALE and two-phase checks | Completed | A stale current-state result is terminal `SKIPPED_STALE`; event snapshot mismatch is `SKIPPED_CONDITION`; unauthorized state is `SKIPPED_UNAUTHORIZED`. |
| Three-level idempotency, first two levels | Partially completed | Run identity and action identity constraints are implemented. Webhook delivery table exists as P3-A foundation, but P3-D HTTP delivery semantics are out of scope. |
| Static cycle analysis, two tiers | Completed | `BLOCKING_CYCLE` and `POTENTIAL_CYCLE` findings are distinct; publication blocks only blocking findings. |
| Causation five-tuple via outbox | Completed | `root_causation_id`, `parent_run_id`, `causation_depth`, `origin_rule_id`, `origin_action_id` are columns on outbox and runs, with five-layer depth handling. |
| Automation grants | Completed | Grant/revoke API, grant binding to rule version, field ranges, operations, source/target apps, audit, and runtime recheck are implemented. |
| Publish preflight and runtime recheck | Completed | Real API endpoints exist and preflight/publish inspect schema, fields, grants, targets, and cycles; runtime rechecks grant and field/app state. |
| Dry-run | Completed | API preview reports trigger, snapshot/current match, field version, authorization, planned actions, and `sideEffects: false`; no audit/run/action write is performed by the preview path. |
| Run/action relational state | Completed | Runs and per-action rows use relation columns and constraints; worker replay uses outbox locking and unique run/action identities. |
| Unexecuted action terminal semantics | Unresolved product semantic | P3-A records P3-B-deferred work as `ACTIONS_NOT_IMPLEMENTED`, and action rows as `NOT_EXECUTED` / `P3B_DEFERRED`; neither run nor action is marked `SUCCEEDED`. This remains an explicit P3-A boundary, not a successful execution claim. |

## Required table and field reconciliation

| Brief term | Repository implementation | Result |
|---|---|---|
| `automation_rules` | `automation_rules` with `tenant_id`, `app_id`, stable `id`, `current_version`, `enabled`, archive timestamp | Compatible |
| `automation_rule_versions` | `automation_rule_versions` with trigger/condition/action JSON, `schema_version`, `source_schema_version`, status and publisher fields | Compatible |
| `automation_grants` | `automation_grants` with source/target app and field arrays, operations, approver and revoked fields | Compatible |
| `automation_runs` | `automation_runs` includes tenant/app/rule/version, event identity, trigger identity, record/batch, causation columns, status and timestamps | Compatible |
| `automation_run_actions` | `automation_run_actions` includes action/position/status/attempt/idempotency/error/timestamps | Compatible |
| `automation_schedules` | `automation_schedules` includes rule version, record, schedule key, due time and invalidation fields | P3-A foundation; P3-C semantics remain deferred |
| `automation_webhook_deliveries` | `automation_webhook_deliveries` includes stable delivery ID, request summary, retry fields and P3-D status values | P3-A foundation; P3-D HTTP delivery remains deferred |
| `automation_audit_events` | Append-only rule/grant/publish/runtime guardrail audit records with immutable primary history | Compatible; append-only |

## Deviations and unresolved semantics

1. **Top unresolved:** P3-A intentionally does not execute P3-B actions. The implementation must retain `ACTIONS_NOT_IMPLEMENTED` / `NOT_EXECUTED` evidence and must never promote such runs to `SUCCEEDED`. The final P3-B change should replace the deferred state only after real action execution and action-level outcomes are implemented.
2. Migration 0036 initially duplicated `source_schema_version` already introduced in 0035. It was removed and the migration rerun on an empty database.
3. P3-A has no formal P3-C scheduling worker, P3-D HTTP transport, or P3-B business action execution. Those are outside this branch's IN scope.
4. The fourth-round CI-equivalent rerun no longer has a login blocker: direct credential verification and login through the built API both pass. The earlier 401 swarm was traced to a stale API container occupying the local port, not to P3-A code or password hashing.

## Fourth-round diagnosis

### Reproduction and failure inventory

- CI PostgreSQL 16 was recreated as a fresh database on port 5432 with CI-equivalent environment variables.
- Build and 40-migration empty-database migration passed.
- The first CI-equivalent attempt produced 89 tests: 12 passed and 77 failed. The failure inventory and first errors are retained in `/tmp/p3a-failures.txt`.
- Every suite failure named in that run shared the same setup symptom: `401 Invalid credentials` at `/auth/login`, including the P3-A integration test. This was not multiple independent P3-A or product regressions.
- Investigation found the local `127.0.0.1:3000` port was owned by the existing `suzubase-api-1` container. A fresh API process was also started, but the Docker listener reached stale database/application state. Direct verification of the credential SQL function and the exact built `verifyLogin` function passed, and login through the new API passed after the stale container was stopped.

### Failure classification

| Class | Evidence |
|---|---|
| (a) P3-A test wiring/coverage defects | The P3-A test itself passed after the stale API port was removed. The new P3-A routes were also found missing from `/docs-json`; after explicit OpenAPI contracts were added, `GF-11` passed. The migration exact-table test was reconciled to include the eight P3-A tables. |
| (b) Existing test regression | None was found. The first 77 failures were produced by the stale/wrong API process, and the clean rerun passed all 99 baseline tests plus the P3-A test. |

### Root cause and repair

- Root cause: local port 3000 was polluted by a pre-existing Docker API container, so test requests did not reach the freshly built API/database pair. Password hashing and P3-A migrations did not cause the credential rejection.
- Product/test repairs: added complete OpenAPI contracts for all P3-A automation routes; extended the migration exact-table assertion with the eight P3-A tables so schema verification remains exact rather than being weakened.

### Final CI-equivalent rerun

- `pnpm -r --workspace-concurrency=1 build`: passed.
- `pnpm -r --workspace-concurrency=1 typecheck`: passed.
- Fresh PostgreSQL 16, 40 migrations applied: passed.
- `pnpm test`: 100 tests, 100 passed, 0 failed.
- P3-A integration: passed; P3-A diagnostics reported `ACTIONS_NOT_IMPLEMENTED` as the intentional P3-A boundary.
- `audit-integrity --sample 20`: passed, 0 failures across all six checks.

## CI-equivalent evidence

- PostgreSQL 16 fresh local container: CI-equivalent port 5432, PostgreSQL 16 Alpine.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm -r --workspace-concurrency=1 build`: passed.
- `pnpm -r --workspace-concurrency=1 typecheck`: passed.
- Empty database migration: passed, 40 migrations applied.
- API health: passed (`{"status":"ok","database":"connected"}`).
- Full `pnpm test`: passed, 100 tests / 100 passed.
- Target P3-A test: passed.
- `audit-integrity --sample 20`: passed, 0 failures.
- Browser suite: not run; this round's required gates were build, typecheck, migration, integration and audit integrity.

## P3-A gate evidence

| Gate | Conclusion | Evidence |
|---|---|---|
| Repeated trigger no duplicate logical run | Implemented and passed in full integration | Unique `(tenant_id, idempotency_key)`, replay `onConflictDoNothing`, worker marks processed outbox event. P3-A integration test passed in 100/100 rerun. |
| Old-version binding | Completed | Run stores `rule_version`; worker selects `automationRules.currentVersion`; test asserts workflow run bound to version. |
| Grant revocation | Completed | Revoke sets `revoked_at`; runtime filters active grants and test verifies `SKIPPED_UNAUTHORIZED`. |
| Deterministic cycle | Completed | Static analysis can emit `BLOCKING_CYCLE`; publish preflight blocks it. |
| Potential cycle | Completed | Static analysis emits `POTENTIAL_CYCLE` warning and permits publication. |
| Causation through outbox | P3-A schema + SQL simulation | P3-A established outbox/run causal columns and SQL-simulated depth/cycle evidence. Real cross-rule action-chain propagation is validated in P3-B (C3). |
| Business admin cross-app grant and preflight | API implementation present and passed | Real `/automation/rules/:id/grants`, `/preflight`, `/publish`, `/enable` routes exist and P3-A integration test passed them. |

## Commit and push status

Implementation commit: `6665e5e feat(p3a): add automation rule execution foundation`.
This report is committed separately after final verification.

---

# P3-B Local Automation Actions - Completion Report

Branch: `p3-b-automation-actions` (from P3-A `dce80f3`). Not merged to main; not deployed.

## Deviations and unresolved semantics (read first)

1. **Migration 0042 relaxes `notifications_record_source_check`.** RECORD notifications previously required `event_id NOT NULL`; T-4 manual runs have no source event, so their A-1 notifications could not be stored. The constraint now requires `app_id` + `record_id` for RECORD rows (SYSTEM branch unchanged). Consequence: manual-run notifications fall outside the `(tenant, app, event, user, rule_key)` unique key (event is NULL); deduplication for them is guaranteed by run-level idempotency (deduplicated manual-run requests return the existing run without executing; retries skip SUCCEEDED actions), not by a notification unique key. This is recorded as a deliberate, bounded deviation.
2. **Brief-authorized test adaptation (not silent).** When real execution landed, the P3-A and guardrail fixtures gained real action parameters (recipient assignee, create mappings, update operations), and four terminal-state assertions were updated per the brief's replacement rule: runs now end `SUCCEEDED` with `error_code` NULL instead of `ACTIONS_NOT_IMPLEMENTED` / `NOT_EXECUTED` / `P3B_DEFERRED`. P3-A historical runs are not retroactively promoted and are never replayed.
3. **Retention pruning writes no audit row.** `automation_audit_events.actor_id` is NOT NULL with a tenant-member FK and there is no system actor; the 90-day pruner therefore records counts in the worker log instead of an audit event. Audit events themselves are never deleted by the pruner.
4. **Worker cadence.** Chain hops propagate on the worker's ~60s cycle (each outbox pass advances the chain); the ping-pong and cross-app chain tests observe this honestly instead of forcing synchronous execution.
5. **Pre-existing unused statuses.** `RATE_LIMITED` / `BACKLOG_LIMITED` remain in the run-status CHECK but are never assigned by code (the signal is carried by audit events, per the P3-A design); they are reserved for a possible P3-C activation. Unlike the removed `POTENTIAL_CYCLE` dead value, this is intentional and documented here.

## Checkpoint disposition (b56db33 audit)

The checkpoint was audited before any new feature work was layered on it. Findings:

- All red tests were **test-side wiring faults**, not product defects: eight `expectRequest` calls missing `method: 'POST'`, a misused `assert.rejects`, and 200-vs-201 status expectations. Fixed in `c5869a1`.
- The BLOCKED_CYCLE / repeated-failure / depth legs originally fired events that could never match their rules; they were rewritten to drive genuine matching events with strong assertions (exact status, exact run counts, problem-chain rows).
- The backlog leg backfills `started_at` to escape the 60-second rate window; the rate limiter counts by `started_at` — that is the product semantic, verified in code.
- The migration test's expected-table list gained `automation_problem_chains`.
- **One real product defect found and fixed:** the problem-chain routes did not declare `@Param('appId')` and the service did not scope by application. Routes now take the parameter; listing filters by the last run's app and resume validates app ownership.
- Migration 0040 verified correct (zero-to-head migration suite green); `rule_versions` status convergence to draft/published is safe; `grant()` / `validateVersion` sourceAppId checks verified present (C6); guardrail behavior (paused-chain skip, rate/backlog audit without marking events processed, problem chain + SYSTEM admin notification on CHAIN_PAUSED / depth) verified in code and by test.
- Baseline after repair: **101/101 tests green** on the verification stack.

## Scope completion

| Brief item | Status | Evidence |
| --- | --- | --- |
| A-1 in-app notification action | Done | `executeNotifyAction`; T1 test (field recipient + template rendering), V-10 dedup asserted |
| A-2 update own-record fields | Done | set/copy/increment/decrement/clear via `persistUpdate`; T1 test incl. no-progress suppression |
| A-3 cross-app record creation | Done | `executeCreateAction` with action-row idempotency key in `record_create_keys`; T2 test |
| A-4 restricted workflow advance | Done | `WorkflowRuntimeService.executeAutomation`; opt-in flag (migration 0041), `actor_type='AUTOMATION'` + rule/run/action attribution on `workflow_events`; T3 test |
| T-4 manual trigger | Done | `manualRun` with `trigger.allowManual`, idempotency-key dedup; T5 test |
| Ordered execution, action-level idempotency, fail-stop, retry-failed-only | Done | Savepoint per action; SUCCEEDED actions skipped on retry; T2/T3 tests |
| Run history detail + C4 query APIs | Done | runs list/detail, audit list, summary endpoints; T5 test |
| Non-atomic chain risk notice in UI | Done | Automation settings tab states the non-rollback semantics verbatim |
| WEBHOOK action | Deferred to P3-D by design | Fails explicitly with `WEBHOOK_NOT_IMPLEMENTED_P3D`; asserted in T2 |

## Commit list (dce80f3..HEAD)

- `b56db33` checkpoint (predecessor, audited above)
- `c5869a1` checkpoint test repair + problem-chain app scoping fix
- `d73aea5` foundations: migration 0041, action-parameter config types
- `45f3baf` threading: persistUpdate extraction, causation on writes, workflow attribution + executeAutomation
- `ad76189` engine: real execution of A-1..A-4, manual runs, retry, C4 APIs, 90-day retention, dry-run action plans; worker wiring
- `6401076` fixture adaptation per replacement rule; **also contains the P3-B web UI** (automation settings tab: summary, run history/detail, retry, manual run, problem chains) — swept in by the same commit; content verified by full workspace build
- `ea8691d` user-field recipient parsing accepts bare id and JSON array forms
- `f96d660` P3-B integration tests (7) + migration 0042
- (final) audit-integrity 3b rescoping + this report section

## Test evidence

- Full suite on the verification stack: **108/108 pass** (101 pre-P3-B baseline + 7 new `p3-b-actions` tests).
- Full workspace build / typecheck: clean (`pnpm -r build`, including the web app).
- Migrations from zero: covered by the in-suite migration tests (43 migrations applied on the verification stack, incl. 0041/0042).
- Post-suite audit-integrity tool: all 6 checks PASS after the 3b rescoping (see C5 note).

## Gate evidence (six items)

1. **Retry never duplicates a created record** — T2: A-3 action row keeps `attempt_count = 1` across a failed-then-retried run; exactly one record exists in the target app; `record_create_keys` holds the action-row idempotency key.
2. **Numeric increment/decrement never double-applies** — T1: increment executes once; repeated `processOutbox` passes and the V-10 re-drive leave value and revision unchanged after the first application.
3. **Failure recovery never replays succeeded actions** — T2/T3: after a later action fails, retry resumes at the first non-SUCCEEDED action; succeeded rows keep `attempt_count = 1`; workflow state advances exactly once.
4. **Unauthorized execution never writes** — T6: after publish-time grant narrowing, the run ends `SKIPPED_UNAUTHORIZED` and the record is byte-identical (revision unchanged, no value change); revoked grants make retry and manual-run return 409 with zero writes.
5. **No forged human approval** — T3: a non-opted-in workflow action fails `WORKFLOW_ACTION_NOT_AUTOMATION_ALLOWED` and **zero** workflow transition events exist; successful automation transitions carry `actor_type='AUTOMATION'` with rule/run/action attribution, never a user identity.
6. **No-progress writes never loop** — T1: an update that changes nothing produces `result_ref = 'no-progress'`, no record event, no revision bump, and therefore no downstream trigger.

## Admission conditions C2-C8

- **C2 (runtime guardrails before real actions)** — Checkpoint implementation audited (rate limit, backlog limit, no-progress suppression, problem-chain isolation with default pause) and exercised by the repaired guardrail suite; the engine was layered on top only after this audit.
- **C3 (first real action proven by a genuine chain)** — T4 ping-pong: two rules updating each other's records through real record writes and the real outbox; the third hop ends `BLOCKED_CYCLE`; exactly two executions; causation quintuple (root/parent/run/depth/rule) asserted field-by-field on every hop. T4b repeats the proof across applications. No SQL outbox fabrication anywhere in these tests.
- **C4 (run/audit query APIs + E-6 admin surface + 90-day retention)** — Endpoints for runs (filter + pagination), run detail, audit events, and per-rule summary; the Automation settings tab consumes them; `pruneRunHistory` deletes terminal runs older than 90 days except problem-chain-referenced ones; audit events are never pruned. All asserted in T5.
- **C5 (L2 idempotency + create uniqueness in the DB)** — Engine-level skip of SUCCEEDED actions plus the `record_create_keys` unique constraint as the database anchor for A-3; asserted in T2. The post-suite audit tool's duplicate check was rescoped to each population's real key (RECORD: event key; SYSTEM: dedup_key) after the checkpoint's guardrail tests exposed that the naive grouping counted distinct SYSTEM deliveries as duplicates — the same failure had failed hosted CI since the checkpoint commit.
- **C6 (small-fix remainder)** — `grant()` and `validateVersion` verify `sourceAppId` for all trigger types (audited in the checkpoint, covered by suite); run-status CHECK cleanup from migration 0040 verified.
- **C7 (F4 delegated identity / F8 preflight audit)** — All execution runs under the grant approver's delegated context; no system or forged identity exists in the write path (T3/T6 evidence). Preflight (dry-run) writes audit events as established in P3-A and retained.
- **C8 (dry-run completeness or explicit boundaries + re-grant semantics)** — Dry-run now returns per-action plans (recipients + rendered text, per-field from/to/changed, create payload preview, workflow current state with re-evaluation note, WEBHOOK P3-D note) and a `boundaries` block stating what a dry run does not prove. Re-authorization semantics: calling `grant()` again constitutes a fresh approval (new approver/timestamp recorded); T6 proves a revoked-then-regranted narrow grant governs execution exactly as written.

## Hosted CI

Hosted CI history on this branch, stated exactly:

- Every commit from the checkpoint (`b56db33`) through `f96d660` failed at the post-suite audit step (check 3b) — root cause in the C5 note above, fixed by the audit rescoping commit.
- `d1fb64f` (audit rescoping): hosted CI **success**.
- `3868b4f` (this report): first hosted run failed the audit step again, this time on check 1 (history-vs-revision sample: 1 problem record). Root cause identified and reproduced locally (2 of 10 local audit runs): the M3 staged-import test population creates records with no `record_events` (its tenants hold import jobs and zero record events), a pre-existing P2-era artifact unrelated to P3-B; the audit's random 20-record sample hits one intermittently (~10%). The failed job was re-run unchanged: **success**. This flake is disclosed rather than fixed here because the import path is outside P3-B scope; it is flagged for the M3 follow-up batch.

---

# P3-C Scheduled Execution - Complete

Branch: `p3-c-automation-schedules` (from P3-B `0dc4140`). Not merged to main; not deployed.
This section covers admission conditions C-0 and, in the second block,
C-1 / C-2 / C-3, then the P3-C scheduling features themselves: T-3 fixed
cadence (C-4) and date-relative plans (C-5), plus the P3-C fix batch
(B1 / C1 / C2) that closes the stage. One C-3 pruning item was already
landed with C-0 (the `pruneRunHistory` NOT IN → NOT EXISTS change, which is
directly tied to the pruning path fixed there).

## C-0 System actor for automation audit (GPT P3-B review condition 1)

### Problem (as admitted)

The production worker drives `processOutbox` and `pruneRunHistory` with
`maintenanceTenants()` contexts whose `userId` is the nil UUID — not a
`tenant_members` row. The RATE_LIMITED / BACKLOG_LIMITED audit inserts used that
value as `automation_audit_events.actor_id`, which has a composite FK to
`tenant_members`. In production, the first rate/backlog trigger would violate
the FK, roll back the whole outbox transaction, and the same events would fail
again every 60 seconds. The P3-B guardrail suite only ever used a real owner
context, so this path was unproven. `pruneRunHistory` never wrote its
RUN_HISTORY_PRUNED audit row for the same reason (P3-B report deviation 3).

### Reproduction first (red), then fix (green)

New suite `packages/db/test/p3-c-system-actor.test.cjs` (committed separately,
before the fix, as `ef4b902`) drives both functions with a frozen
`{ tenantId, userId: '00000000-0000-0000-0000-000000000000' }` context — the exact
`maintenanceTenants()` shape. On the P3-B base it failed exactly as predicted:

- `processOutbox` (rate-limit leg) rejected with
  `insert or update on table "automation_audit_events" violates foreign key
  constraint "automation_audit_events_tenant_id_actor_id_fkey"` on the
  RATE_LIMITED insert with the nil-UUID actor.
- `pruneRunHistory` pruned 0 runs (expected 1): the `NOT IN` exclusion returned
  UNKNOWN for every run because the fixture includes a problem chain whose
  `last_run_id` is NULL.

After the fix both tests pass, including assertions that the guardrail events
stay unprocessed, that problem-chain-referenced runs survive pruning, that
pruned action rows are deleted, and that pre-existing audit events survive.

### Chosen solution: (a) nullable actor_id + dedicated actor_type

Migration `0043_p3c_system_actor.sql`:

- `automation_audit_events.actor_id` drops NOT NULL (the composite FK to
  `tenant_members` stays and still applies whenever an actor is present).
- New column `actor_type text NOT NULL DEFAULT 'USER'` with
  CHECK `IN ('USER','SYSTEM')` and a consistency CHECK:
  `USER` rows must carry a non-null member actor; `SYSTEM` rows must carry
  `actor_id IS NULL`. Existing rows default to `USER` and already satisfy it.
- Drizzle schema (`packages/db/src/schema.ts`) mirrors both checks.

Code (`apps/api/src/automation.ts`): `auditActor(context)` maps the nil-UUID
maintenance identity to `{ actorId: null, actorType: 'SYSTEM' }` and every
other context to its real member id with `'USER'`. RATE_LIMITED and
BACKLOG_LIMITED inserts use it. All other audit writes (rule/grant/publish/
enable/retry/manual/chain-resume) keep the real member actor unchanged.

Why (a): it is the smallest change that keeps the signal inside the existing
audit table and transaction — the rate/backlog evidence remains atomically
bound to the outbox pass that produced it, with rule, version, event and limit
details intact. The audit query API already modelled `actorId` as nullable,
and the audit-integrity tool does not key any check on the automation audit
actor, so the blast radius is one column pair on one table.

Why not (b) a dedicated system member per tenant: it would fabricate a
`tenant_members` row that is not a person — it would surface in member lists,
admin/recipient resolution and counts, could be assigned or notified, and
needs provisioning/backfill for every existing and future tenant plus guards
against login/disable/deletion. It also makes system actions read as if a
member performed them, weakening exactly the distinction the audit exists to
keep.

Why not (c) moving the signals out of the outbox transaction: decoupling the
signal write from event consumption means the guardrail can fire (and be
retried every 60 s) with no durable evidence when the separate write fails,
or evidence can be written for a pass that later rolls back. It also creates
a second write path to keep consistent, for a problem that is purely about
actor representation, not about transaction boundaries.

### Audit-integrity impact

- No audit row is lost or weakened: RATE_LIMITED / BACKLOG_LIMITED rows are
  still written per candidate rule with the same details payload
  (rootCausationId, eventId, limit / pendingCount).
- Traceability changes form, not content: "who" for a system action is now
  explicitly `actor_type='SYSTEM'` + `actor_id NULL` instead of a member id;
  member actions are unchanged and still FK-bound to a real member.
- RUN_HISTORY_PRUNED (already present in the audit action CHECK since 0041)
  is now actually written: one row per (app, rule, version) group per pruning
  pass, `details = { prunedCount, retentionDays: 90 }`, with the caller's
  audit actor (SYSTEM under the worker). The P3-B retention test was updated
  accordingly: pre-existing audit events are never pruned; exactly the prune
  row is added (under an owner context it carries that owner as USER actor).
- Append-only protections on the audit table are untouched.

### Included C-3 pruning item

`pruneRunHistory`'s problem-chain exclusion changed from `NOT IN (SELECT
last_run_id ...)` to `NOT EXISTS` correlated on `last_run_id = run.id`, so a
chain row with `last_run_id NULL` no longer silently disables all pruning.
Covered by the NULL-chain leg of the new C-0 prune test.

### Evidence

- Verification stack: dedicated Postgres 16 container on 127.0.0.1:55436 and
  API on 127.0.0.1:3101 in the `suzubase-build-p3b` clone, with
  `TEST_API_URL` and `SUZUBASE_SYSTEM_NOTIFICATION_SECRET` injected.
- Build: `pnpm -r --workspace-concurrency=1 build` clean; typecheck clean.
- Migrations from zero: covered by the in-suite migration test (journal now
  44 entries, 0043 included); 0043 also applied incrementally on the
  verification stack (44 applied in total).
- Full suite: **110/110 pass** (108 P3-B baseline + 2 new C-0 tests), no
  reruns needed. Post-suite `audit-integrity --sample 20`: all 6 checks PASS,
  0 failures (the known check-1 M3 flake did not occur in this run).

### Commits

- `ef4b902` P3-C C-0 reproduction tests (red on P3-B base)
- `5006ca4` P3-C C-0 fix (option a): migration 0043, schema, engine, P3-B
  retention-test update
- (this report commit)

## C-1 Manual-notification dedup hardening (GPT P3-B review condition 2)

### C-1.1 Replay on the run unique constraint returns the existing run

`manualRun` already returned the existing run on the sequential path (a
pre-check by trigger identity). The unhandled case was the race: two
concurrent triggers with the same idempotency key can both pass the
pre-check, and the second insert then raised the run unique-constraint
violation as an error. The insert now uses `ON CONFLICT DO NOTHING`; on a
collision the winner run is read back by its run idempotency key and
returned with `deduplicated: true` — no second run, no execution, no
notification. Evidence (new suite `p3-c-admission`): the test
"P3-C C-1: manual replay returns the existing run (pre-check and
unique-collision paths); manual notifications reconcile via payload"
covers the sequential replay, plus a deterministic collision (a planted
run whose trigger identity differs so the pre-check misses it, but whose
run idempotency key collides) — the replay returns the planted run,
creates nothing, writes nothing, sends nothing.

### C-1.2 Event-less RECORD notifications reconcile back to their run

Implemented (the association option, not the report-only option). Every
automation notification now carries `payload = { runId, actionId,
actionIdempotencyKey }`. Event-triggered notifications were already
deduped by the `(tenant, app, event, user, rule_key)` unique key;
event-less manual notifications cannot use that key (NULL event), and
their `rule_key` (`automation:<ruleId>:<actionId>`) plus the payload now
tie each one to exactly one run action. The audit tool
(`tools/audit/audit-integrity.mjs`) gained check 3c: every event-less
automation notification must link via its payload to a real
`automation_run_actions` row, and no `(run, user, rule_key)` may carry
more than one notification. Disposition of the underlying semantics,
stated plainly: different manual runs are different deliveries; only
same-key replays are deduplicated — and same-key replays return before
execution, so they can never produce a second notification. On the
long-lived verification database the tool flags exactly 2 pre-change
rows (written 2026-11-23 03:39/03:41 UTC by the P3-B-era code, payload
empty); every row written by the new code carries the linkage, and on a
fresh database (45 migrations from zero, automation subset 15/15) all
audit checks pass including 3c.

## C-2 Status-value disposition (GPT P3-B review condition 3)

Decided per value; migration 0044 carries the run-CHECK change. This
supersedes the P3-B section's deviation 5, which had reserved
RATE_LIMITED / BACKLOG_LIMITED in the run CHECK "for a possible P3-C
activation" — that reservation is now closed by removal.

| Value | Where it appeared | Decision | Reason |
|---|---|---|---|
| `RATE_LIMITED` | run CHECK + UI filter + audit CHECK | Removed from run CHECK (0044) and UI filter; kept as audit action | Never written as a run status (verified by code search): when the tenant rate limit trips, no run is created — the event stays unprocessed and the signal is an audit row. A filter option for it could only ever return zero rows. |
| `BACKLOG_LIMITED` | run CHECK + UI filter + audit CHECK | Removed from run CHECK (0044) and UI filter; kept as audit action | Same as RATE_LIMITED: a guardrail audit signal, never a run status. |
| `ACTIONS_NOT_IMPLEMENTED` | run CHECK + UI filter | Removed from run CHECK (0044) and UI filter; legacy rows converted (see below) | It was the P3-A deferred terminal state. No code since P3-B writes it — real action outcomes replaced it (brief appendix 2, item 1). Keeping it in the filter offered a status no new run can reach. |
| `CHAIN_PAUSED` (run status) | run CHECK + UI filter | Kept in both | It has a real write path: `processOutbox` assigns it when a chain reaches the repeated-failure limit, and `runSummary` counts it as skipped. |
| `CHAIN_PAUSED` (audit action) | audit CHECK | Kept, and now actually written | Previously in the audit CHECK but never written. The pause path in `processOutbox` now writes exactly one `CHAIN_PAUSED` audit row per pause (details: root causation id, run id, reason `CHAIN_PAUSED` or `CHAIN_DEPTH_EXCEEDED`), so the value has a real writer instead of being dead. |
| `RUN_HISTORY_PRUNED` (audit action) | audit CHECK | Kept (already enabled by C-0) | Written by `pruneRunHistory` since C-0; not part of this disposition. |

Legacy-row handling for `ACTIONS_NOT_IMPLEMENTED`: a fresh database
contains no such rows (no current code writes the value, and migrations
create empty tables). Migration 0044 first converts any legacy P3-A rows
to `FAILED` with an explicit `last_error` annotation ("Legacy P3-A
deferred run (ACTIONS_NOT_IMPLEMENTED): actions were never executed."),
then tightens the CHECK. The conversion never promotes a run to
SUCCEEDED and never replays it: its action rows keep their
`NOT_EXECUTED` / `P3B_DEFERRED` evidence untouched, and recovery is only
possible through the operator-initiated retry path. No rows were present
on the verification stack, so the conversion branch is a documented
safety net, exercised only by the migration text itself.

## C-3 Small items (GPT F1/F2/F3/F4/F6 + acceptance observation 3)

1. **Problem-chain Resume disclosure (UI).** The Problem chains section
   of `automation-settings.tsx` now states, directly above the chain
   list and its Resume buttons: "Resuming a chain does not replay
   anything: events that arrived while the chain was paused were
   discarded and will not be re-run." (The UI is English; the copy
   follows the existing UI language and style.)
2. **Dry-run audit — disclosure option chosen.** A dry run deliberately
   writes NO audit event and no run history, and this is now disclosed
   in-band instead of only in this report: the API response carries
   `auditTrail: 'none'` and its `boundaries` text states "A dry run
   writes no audit event and leaves no run history: it is a
   zero-side-effect preview." Reason for choosing disclosure over an
   audit row: the P3-A disposition (brief appendix 2, F8) defines
   dry-run as the zero-side-effect path — operators may preview freely
   and repeatedly; an append-only audit row per preview would break
   that contract and flood the audit table with non-actions. The
   preview result is returned synchronously to the operator. Evidence:
   the `p3-c-admission` chain test asserts `auditTrail === 'none'`,
   the boundaries wording, and an unchanged audit-row count across a
   dry run.
3. **Deduplicated FAILED manual run — UI hint.** When a manual trigger
   returns a deduplicated run whose status is `FAILED`, the UI notice
   now says the run failed and was not executed again, and the manual
   result block shows an alert plus a "Retry failed actions" button —
   the user is routed to retry instead of believing the run executed.
   The API evidence for the pair the UI keys on (`deduplicated: true` +
   `status: 'FAILED'`) is covered in the C-1 test.
4. **Guardrail audit throttling.** RATE_LIMITED / BACKLOG_LIMITED audit
   writes are throttled per (tenant, app, rule, action): the first row
   inside each 60-second window (`AUTOMATION_GUARDRAIL_AUDIT_WINDOW_MS`,
   aligned with the rate-limit window) is always written; repeats
   inside the window are suppressed. The signal is not lost — the
   triggering event stays unprocessed, and a pass outside the window
   writes a fresh row. Evidence: the `p3-c-admission` throttle test
   drives three rate-limited passes and two backlog-limited passes
   under the maintenance (system) context and asserts exactly one
   audit row per signal, with the event still pending.
5. **P3-B section deduplication.** The P3-B completion section appeared
   twice in this file (86 lines each). The two copies differed in
   exactly one line ("byte-identical" vs "unchanged" in the
   unauthorized-execution item); the fuller first copy was kept and the
   second copy removed. No evidence entries were lost. (Noted in the
   commit message of the commit that carries this change.)

### Evidence (this block)

- Verification stack: same as C-0 (Postgres 16 on 127.0.0.1:55436, API
  on 127.0.0.1:3101, `TEST_API_URL` +
  `SUZUBASE_SYSTEM_NOTIFICATION_SECRET` injected).
- Build: `pnpm -r --workspace-concurrency=1 build` clean; typecheck
  clean.
- Migrations: 0044 applied incrementally on the verification stack (45
  in total) and from zero on a fresh database (45 applied; automation
  subset — p3-a, p3-b actions, p3-b guardrails, p3-c system actor,
  p3-c admission, migration — 15/15 pass there).
- Full suite: **113/113 pass** (110 C-0 baseline + 3 new
  `p3-c-admission` tests), no reruns needed.
- Audit tool: on the fresh database all checks PASS (8 checks,
  including the two new 3c checks). On the long-lived verification
  database: check 1 (history-vs-revision) hit the known M3
  staged-import flake twice and passed on the third unchanged rerun —
  that database holds exactly 4 event-less records out of 399 (the M3
  staged-import population), so a 20-record sample hits one more often
  than the nominal ~10%; the fresh database passed check 1 first try.
  Check 3c flags only the 2 pre-change legacy notifications described
  under C-1.2.

### Commits (this block)

- `165ce4b` P3-C C-1/C-2/C-3 code: migration 0044, manual-replay
  collision return, notification payload linkage + audit check 3c,
  CHAIN_PAUSED audit writer, guardrail audit throttling, dry-run
  disclosure, UI status filter + resume/FAILED hints, P3-B report
  dedup
- (this report commit)

## C-4 Fixed cadence scheduling (T-3 upper half): plans, slot keys, claiming, missed policy, DST/month-end, recovery, backlog

### Deviations and decisions (read first)

1. **Missed-slot boundary (builder-chosen operational definition, flagged
   for review):** the brief says missed periods are skipped by default
   and only a controlled catch-up may run the most recent one, but does
   not define when a due slot becomes "missed" for a worker that polls
   every 60 seconds. This block defines it as
   `AUTOMATION_SCHEDULE_ON_TIME_GRACE_MS` = 15 minutes: a slot first
   processed within 15 minutes of its scheduled instant is on time and
   executes under both policies; a slot first seen later is missed.
   Default `skip` then never executes missed slots (plan advances to
   the next valid period); `catch_up_latest` executes exactly the most
   recent missed slot, marked as catch-up. All gate tests below are
   written against this definition.
2. **New plan tables instead of bending `automation_schedules`:**
   migration 0045 adds `automation_cadence_plans` (one row per rule
   version) and `automation_cadence_slots` (one row per period). The
   P3-A `automation_schedules` table is per-record (`record_id` NOT
   NULL) and remains the date-relative wave's table, untouched; the
   brief's §3.1 persisted fields (timezone / cadence / local_time /
   next_due_at / last_completed_slot / missed_run_policy) live on the
   cadence plan row.
3. **Timezone conversion uses the platform IANA database via Intl**
   (Node ICU) — no new dependency and no hand-written offset tables.
   DST gap/fold resolution enumerates the UTC candidates whose zone
   rendering equals the requested wall time: zero candidates = gap,
   two = fold (first wins).
4. **Scope boundary kept:** date-relative scheduling (T-3 lower half)
   is not implemented here; no email, no generic job platform, no
   Redis/queue. The worker's existing maintenance loop drives
   `processSchedules` once per pass per tenant.

### Implementation

- **Trigger configuration:** `trigger.eventType = 'schedule.fixed'` with
  `trigger.schedule { cadence, localTime, timezone, weekdays?,
  monthDay?, missedRunPolicy? }`. The write-path Zod schema rejects
  illegal cadence forms, `HH:MM` violations, non-IANA timezones,
  duplicate/missing weekdays and missing/out-of-range month days;
  `validateVersion` re-checks the same rules at preflight/publish with
  `SCHEDULE_*` blocking findings, so a stored version cannot bypass
  validation through any path.
- **Plan generation & lifecycle:** publish creates the new version's
  plan and invalidates the superseded version's; enable refreshes /
  revives the current version's plan; disable invalidates it
  (`rule-disabled`); grant revoke invalidates that version's plan
  (`grant-revoked`); archive invalidates all; re-granting an enabled
  rule's current version revives it. The worker also lazily ensures
  plans for enabled schedule rules with an active grant. Unique
  `(tenant, rule, rule_version)` per plan.
- **Slot keys & next-due:** slot key = `<cadence>:<scheduled local
  date>` in the rule's IANA timezone; `next_due_at` is stored in UTC.
  Monthly day 31 clamps to the month's last day. A DST-gap slot keeps a
  pseudo-instant so it becomes due, is recorded
  `SKIPPED_NONEXISTENT_TIME` on the slot row, and the plan moves on; a
  DST-fold slot pins the first occurrence only.
- **Claiming:** one conditional `UPDATE ... SET claim_token, claimed_at
  WHERE status='ACTIVE' AND next_due_at <= now AND (claim free OR
  lease expired)` per plan — concurrent workers race on the row and
  exactly one wins (5-minute claim lease,
  `AUTOMATION_SCHEDULE_CLAIM_LEASE_MS`).
- **Execution:** due slots are classified (nonexistent / missed /
  on-time) under the missed policy; surviving slots get a CLAIMED slot
  row with a fresh `batch_id`. Candidate records are scanned in stable
  id order, filtered by the rule's two condition groups, and each
  matching record gets one run through the SAME engine as event runs
  (`executeActions`, grant revalidation via `grantCoversExecution`,
  approver-delegated context), sharing the slot's `batch_id`, with
  `trigger_identity = schedule:<slot key>` (`:catchup` suffix for
  catch-up runs) and run idempotency key
  `<app>:schedule:<rule>:<version>:<slot key>:<record>`.
- **Batching & recovery:** at most 1,000 candidates per pass
  (`AUTOMATION_SCHEDULE_BATCH_LIMIT`); the slot checkpoint (cursor
  record id + processed count) is persisted in the same transaction as
  each record's run. A slot left CLAIMED by a dead worker is resumed
  after its lease from the checkpoint; run idempotency keys make
  resumption duplicate-safe, and a due-pass that finds a slot already
  CLAIMED leaves the plan untouched (in-flight guard).
- **Backlog & alerting:** due ACTIVE plans are counted every pass;
  `GET /apps/:appId/automation/summary` now also returns
  `scheduleBacklog` and `scheduleInFlight`. Above
  `AUTOMATION_SCHEDULE_BACKLOG_ALERT_THRESHOLD` (100), tenant admins
  get one SYSTEM notification (`AUTOMATION_SCHEDULE_BACKLOG`, daily
  dedup key, C-0 SYSTEM actor口径 via the audit row
  `SCHEDULE_BACKLOG_ALERT`, throttled to one audit row per 24h).

### Gate evidence (all in `packages/db/test/p3-c-schedules.test.cjs`, 10 tests)

- Default skip across ≥2 missed periods: 4 due slots all
  `SKIPPED_MISSED`, 0 runs, plan advanced past recovery time; the next
  live cycle then executes exactly once.
- Controlled catch-up: same downtime with `catch_up_latest` produces
  exactly 1 run batch for the most recent missed slot
  (`is_catchup = true`, trigger identity ends `:catchup`); the 3 older
  slots stay `SKIPPED_MISSED`.
- Month-end: monthly day-31 rule resolves February 2026 to
  `monthly:2026-02-28`, fires once, next slot `monthly:2026-03-31`.
- DST (America/New_York): 2026-03-08 02:30 slot recorded
  `SKIPPED_NONEXISTENT_TIME` with 0 runs and the plan advanced to
  2026-03-09; 2026-11-01 01:30 fold has 2 UTC candidates, executes at
  the first, and a scan at the second occurrence creates nothing.
- Slot-key anti-duplication: a duplicate scan of the same period
  creates no second batch (also asserted inside the on-time and
  month-end tests).
- Concurrent claiming: two parallel `processSchedules` passes over the
  same due plan create exactly one run per record and one COMPLETED
  slot.
- Crash recovery + 1,000-limit continuation (batch limit injected as 2
  against 5 records): first pass stops at checkpoint 2 with the slot
  CLAIMED; recovery resumes, completes at processed_count 5, all 5
  runs share the original batch, zero duplicate runs. Production batch
  constant remains 1,000.
- Lifecycle & backlog: summary exposes `scheduleBacklog`; a forced
  threshold produces the SYSTEM admin notification + audit row;
  disable → plan INVALIDATED (`rule-disabled`) and the due slot never
  fires; re-enable revives; grant revoke → INVALIDATED
  (`grant-revoked`) and no runs.
- Config validation: 8 illegal schedule shapes rejected with 400 at
  the API; a tampered draft version's timezone is blocked at preflight
  with `SCHEDULE_TIMEZONE_INVALID`.

### Evidence (this block)

- Verification stack: Postgres 16 on 127.0.0.1:55436, API on
  127.0.0.1:3101, `TEST_API_URL` + `SUZUBASE_SYSTEM_NOTIFICATION_SECRET`
  injected (same口径 as C-0/C-1–C-3).
- Build clean; `pnpm -r typecheck` clean (4 packages).
- Migrations: 0045 applied incrementally on the verification stack
  (46 total) and from zero on a fresh database (46 applied;
  automation subset p3-a + p3-b actions + p3-c system actor +
  p3-c admission + p3-c schedules + migration = 24/24 pass there).
  `migration.test.cjs`'s hard-coded table list gained the two new
  tables (the list is maintained per migration, as with 0040).
- Full suite: **123/123 pass** (113 C-1–C-3 baseline + 10 new
  `p3-c-schedules` tests), no reruns needed. First full run was 122/123
  with only the migration table-list assertion failing; fixed and the
  unchanged rerun is 123/123.
- Audit tool: fresh database — all checks PASS. Long-lived
  verification database — check 1 passed first try this block; check
  3c still flags exactly the same 2 pre-change legacy notifications
  disclosed under C-1.2 (count unchanged by this block; schedule
  notifications carry the C-1 payload linkage and reconcile on the
  fresh database).

### Commits (this block)

- `72a2827` P3-C cadence code + tests: migration 0045, cadence plan /
  slot tables, schedule trigger schema + preflight validation, plan
  lifecycle hooks, `processSchedules` (claim / missed policy / batched
  execution / resume / backlog alert), worker wiring, summary backlog
  fields, 10 gate tests
- (migration table-list fix + this report commit)

## C-5 Date-relative scheduling (T-3 lower half): per-record plans, backfill, 24h late window, MISSED aggregation

### Deviations and decisions (read first)

1. **On-time vs LATE boundary (builder-chosen operational definition,
   flagged for review):** the brief fixes the 24-hour late window but
   does not define when an execution stops being "on time". The worker
   polls every 60 seconds, so without a grace every normal execution
   would be marked LATE and the SUCCEEDED plan state would be
   unreachable. This block reuses the fixed-cadence on-time grace
   (`AUTOMATION_SCHEDULE_ON_TIME_GRACE_MS`, 15 minutes) purely as the
   on-time/LATE classifier: execution within the grace of due_at ends
   SUCCEEDED, later but within 24 actual hours ends LATE, past 24 hours
   ends MISSED. The 24-hour window itself is the brief's §3.2 contract
   (measured from the plan's due_at in UTC) and is a different constant
   from the grace -- the two are not interchangeable.
2. **Backfill treatment of already-past-due stock (explicit, as
   required):** backfill only writes plans; it never executes. A stock
   record whose computed due_at is already past is still planned as
   PENDING with that past due_at, and the normal due-consumption pass
   then applies the §3.2 rules to it: within 24h it executes once as
   LATE, beyond 24h it is marked MISSED with no execution and no
   per-plan reminder (only the aggregated admin alert can fire). There
   is no backfill-time execution burst: consumption stays bounded by
   the same per-pass batch limit (1,000) and claim discipline as live
   plans.
3. **Plan identity lives in the P3-A table:** `automation_schedules`
   already carried the exact unique identity
   `(tenant, rule, rule_version, record, schedule_key)`; migration 0046
   only adds `source_date` (the date value the plan was computed from,
   for the execution-time staleness check), the claim lease columns
   (`claim_token` / `claimed_at`, same pattern as cadence plans) and
   `executed_at`. The status CHECK from C-2 already contained PENDING /
   SUCCEEDED / LATE / MISSED / INVALIDATED / CANCELLED, so no status
   change was needed. Backfill checkpoints get one new table,
   `automation_date_backfills` (one row per rule version).
4. **Terminal-plan reopening:** when a record's date changes after its
   plan already executed (SUCCEEDED / LATE / MISSED), the same logical
   row is reset to PENDING for the new source date -- the unique
   identity forbids a second row, and the earlier execution remains
   proven by its run / action rows and notifications. A date change
   before execution simply moves due_at on the PENDING row (V-02 gate
   asserts the old due_at never fires). **Fix-batch amendment (B1):**
   as originally shipped, the reopened plan run idempotency key did
   not include the source date, so the consumer adopted the previous
   date run and the new reminder was silently swallowed. The run
   idempotency key and trigger identity now embed the plan stored
   `source_date`: a different source date is a new logical execution
   with its own run and notification, while replaying the same source
   date keeps the same identity and still adopts the existing run
   (crash recovery unchanged). See the fix-batch section below.
5. **DST-gap wall times** for date-relative plans resolve to the
   pseudo-instant (pre-transition offset), reusing the cadence
   conversion helpers in `automation-schedule.ts`; the reminder still
   fires at approximately the configured local time instead of being
   skipped (the brief's SKIPPED_NONEXISTENT_TIME rule is stated for
   fixed cadence slots, §3.1, not for date-relative plans, §3.2).
6. **Fixture honesty fix during this block:** the backfill gate test
   originally bulk-inserted its 2,000 stock records without
   `record_events` rows, which polluted the audit tool's check-1
   sample population on the shared verification database (the same
   failure class as the known M3 staged-import flake, but introduced
   by this block's fixture). The fixture now writes each record's
   `created` history event in the same statement, and the polluted
   populations from the earlier runs were removed from the
   verification database. Check 1 passes first try on both databases
   with the fixed fixture; the sampling logic was not touched.

### Implementation

- **Trigger configuration:** `trigger.eventType =
  'schedule.dateRelative'` with `trigger.dateRelative { source:
  'field' | 'createdAt', fieldId?, offsetDays (signed, -3650..3650),
  localTime, timezone }`. The write-path Zod schema rejects illegal
  shapes (field source without fieldId, createdAt with fieldId,
  out-of-range offset, bad local time / timezone, event selectors);
  `validateVersion` re-checks at preflight/publish, including that a
  field source names an existing field of type `date`
  (`SCHEDULE_DATE_FIELD_TYPE_INVALID`). The date field joins
  `fieldsFor`, so grants must cover reading it.
- **Schedule key:** `daterel:<field:<fieldId>|createdAt>:<signed
  offset>d:<localTime>` -- stable encoding of the trigger elements
  (source field, offset magnitude and direction, execution wall time).
  due_at = (source local date + offset days) at localTime in the
  rule's IANA timezone, converted via the same Intl helpers as fixed
  cadence (`dateRelativeDueAt`). For `createdAt`, the source local
  date is the record's creation instant rendered in that timezone.
- **Generation & invalidation:** `processOutbox` maintains plans for
  every enabled date-relative rule of an app on record.created /
  record.updated / record.deleted events (create -> generate, date
  change -> move due_at / invalidate + regenerate, date cleared ->
  `date-cleared`, soft delete -> `record-deleted`). The sync sits
  before the guardrail deferrals so a rate/backlog pause cannot lose
  a plan update, and it is idempotent under event replay. Lifecycle
  hooks mirror the cadence ones: disable -> `rule-disabled`, grant
  revoke -> `grant-revoked` (that version), publish -> old versions
  `version-superseded`, archive -> `rule-archived`; execution-time
  revalidation repeats every check (rule still enabled and current,
  grant present and covering, record present and undeleted, current
  source date still equal to the plan's `source_date`, rule conditions
  still met -- otherwise the plan ends INVALIDATED with the reason, or
  CANCELLED with `conditions-not-met`).
- **Backfill:** publish / enable / grant-approval ensure one
  `automation_date_backfills` job per version (invalidation resets a
  job to a null cursor so a re-enabled rule rescans fully). The worker
  processes jobs in stable record-id order, at most
  `AUTOMATION_SCHEDULE_BATCH_LIMIT` (1,000) records per pass, with the
  checkpoint (cursor + processed count) persisted in the same
  transaction as each record's plan sync; an interrupted pass resumes
  from the checkpoint with no duplicates and no gaps.
- **Consumption:** `processDateRelativeSchedules` (worker loop, after
  `processSchedules`) claims due PENDING plans with the same atomic
  conditional-UPDATE discipline as cadence plans (5-minute lease).
  Surviving plans execute through the shared `executeActions` engine
  under the grant approver's delegated context, one run per plan with
  idempotency key
  `<app>:date-relative:<rule>:<version>:<schedule key>:<record>` and
  trigger identity `date-relative:<schedule key>`. A worker that dies
  after creating the run but before finalizing the plan leaves a
  claimed plan whose resumption adopts the existing run's outcome
  instead of executing twice.
- **Late / MISSED:** see decision 1 for the classifier. MISSED plans
  never execute and send nothing. At or above
  `AUTOMATION_DATE_RELATIVE_MISSED_ALERT_THRESHOLD` (100) MISSED in one
  pass, tenant admins receive ONE aggregated SYSTEM notification
  (`AUTOMATION_SCHEDULE_MISSED`, daily dedup key) plus one
  `SCHEDULE_MISSED_ALERT` audit row (C-0 SYSTEM actor口径), throttled
  to one alert per 24 hours.

### Gate evidence (all in `packages/db/test/p3-c-date-relative.test.cjs`, 11 tests)

- Config validation: 7 illegal date-relative shapes rejected with 400;
  preflight blocks a non-date source field with
  `SCHEDULE_DATE_FIELD_TYPE_INVALID`.
- S-02 form: wish_date 2026-12-13, minus 3 days, 09:00 Asia/Tokyo ->
  plan `source_date 2026-12-13`, due_at exactly
  `2026-12-10T00:00:00Z`; not-yet-due pass executes nothing; due pass
  executes once (run SUCCEEDED, plan SUCCEEDED with `executed_at`,
  exactly one notification linked to the run); replay passes create
  nothing.
- V-02: date 12/10 -> 12/20 moves the single logical plan to the new
  due_at (2026-12-17T00:00Z); a pass at the old due_at creates zero
  runs; the new due_at executes.
- V-03: soft delete invalidates the plan (`record-deleted`); the due
  pass produces zero runs and zero notifications.
- 24h boundary (constructed plan rows against an injected now):
  due 23:59 ago -> executed, plan LATE; due 24:01 ago -> plan MISSED,
  `executed_at` null, zero runs, zero notifications.
- Backfill: 2,000 stock records predating the rule; injected batch
  limit 700 completes in 3 passes (700 / 700 / 600) with the job's
  checkpoint persisted between passes and a fresh engine instance
  resuming; exactly 2,000 PENDING plans, no duplicates, zero runs.
- Lifecycle: disable -> plan INVALIDATED (`rule-disabled`), revoke ->
  INVALIDATED (`grant-revoked`), publish of v2 -> v1 plan INVALIDATED
  (`version-superseded`) and silent at the v1 due instant, while the
  v2 backfilled plan fires at its own due_at bound to v2.
- Concurrency & recovery: two engines racing one due plan produce
  exactly one run; a planted claim (dead worker) blocks execution
  inside the lease and is reclaimed after it, executing once with no
  duplicate run.
- Aggregated MISSED alert: 3 plans past the window with an injected
  threshold of 2 -> exactly 1 SYSTEM admin notification and 1
  `SCHEDULE_MISSED_ALERT` audit row (SYSTEM actor, missedCount 3); a
  second missed wave inside 24h stays silent.
- createdAt source: plan's source_date equals the record's creation
  date in Asia/Tokyo and due_at matches `dateRelativeDueAt` (+7 days,
  09:00).

### Evidence (this block)

- Verification stack: Postgres 16 on 127.0.0.1:55436, API on
  127.0.0.1:3101, `TEST_API_URL` +
  `SUZUBASE_SYSTEM_NOTIFICATION_SECRET` injected (same口径 as
  C-0..C-4).
- Build clean; `pnpm -r typecheck` clean.
- Migrations: 0046 applied incrementally on the verification stack
  (47 total) and from zero on a fresh database (47 applied; automation
  subset -- migration + p3-a + p3-b actions + p3-b guardrails + p3-c
  system actor + p3-c admission + p3-c schedules + p3-c date-relative
  = 36/36 pass there).
- Full suite: **134/134 pass** (123 C-4 baseline + 11 new
  `p3-c-date-relative` tests), no reruns needed.
- Audit tool: fresh database -- all checks PASS. Long-lived
  verification database -- check 1 passed first try; check 3c still
  flags exactly the same 2 pre-change legacy notifications disclosed
  under C-1.2 (unchanged by this block; date-relative notifications
  carry the C-1 payload linkage and reconcile on the fresh database).

### Commits (this block)

- `f4723ea` P3-C date-relative code: migration 0046, schema,
  date-relative trigger config + preflight validation, plan sync on
  record events, lifecycle invalidation hooks, backfill jobs,
  `processDateRelativeSchedules` (claim / revalidation / LATE /
  MISSED / aggregated alert), worker wiring, migration table list
- `51f5e27` P3-C date-relative tests (11 gates) + on-time grace
  classification for LATE marking
- (fixture history-event fix + this report commit)

With C-5, the P3-C stage is complete: T-3 fixed cadence (C-4) and
date-relative (C-5) both run on the shared worker loop and the shared
action engine. P3-D (Webhook / M1 compatibility / overall acceptance)
is untouched, as ordered.

## P3-C fix batch (B1 / C1 / C2): reopened-plan run identity, grace boundary gates, 100k scale smoke

### Deviations and unresolved items (read first)

- None unresolved. No product commitment changed in this batch: B1 is a
  defect fix inside the C-5 decision-4 contract (a reopened terminal plan
  is a new logical plan for the new source date), C1 only adds a test
  injection option whose default is the existing constant, and C2 is a
  measurement, not a behaviour change.
- Disclosure on C2 evidence: the first end-to-end smoke run completed
  the full backfill (100 batches, 496.5s) and then failed on a bug in
  the smoke script itself (`max(id)` over a uuid column, which Postgres
  rejects), before any consumption. The script was fixed
  (`ORDER BY id DESC LIMIT 1`) and the whole smoke was rerun from a
  fresh tenant to the PASS recorded below; the first run's population
  was left in the verification database and is not counted anywhere.

### B1 -- terminal plan reopened by a date change silently swallowed the new reminder (blocking defect, fixed)

- **Defect:** after a date-relative plan reached a terminal state
  (SUCCEEDED / LATE / FAILED), changing the record's source date reset
  the plan row to PENDING for the new date (C-5 decision 4). But the
  run idempotency key built by `processDateRelativePlan` --
  `<app>:date-relative:<rule>:<version>:<scheduleKey>:<record>` -- did
  not contain the source date, so at the new due date the existing-run
  lookup hit the OLD run, the consumer "adopted" its outcome, and no
  new run, action or notification was ever created for the new date.
- **Reproduction first (red):** new gate "B1 regression -- a terminal
  plan reopened by a date change executes a NEW run and notifies
  again" failed exactly as predicted before the fix:
  `AssertionError: B1: the new source date must produce a second run,
  not adopt the old one -- 1 !== 2` (runs stayed 1; the plan was
  finalized SUCCEEDED from the old run with zero new notifications).
  The companion gate (same-source-date replay) already passed,
  pinning the adoption behaviour that had to be preserved.
- **Fix:** the run idempotency key and the run `triggerIdentity` now
  embed the plan row's stored `source_date`:
  `<app>:date-relative:<rule>:<version>:<scheduleKey>:<record>:<sourceDate>`
  and `date-relative:<scheduleKey>:<sourceDate>`. `source_date` was
  chosen over `dueAt` because it is the plan's stored generation input
  -- the same value the execution-time staleness check already compares
  the live record against -- whereas `dueAt` is a derived rendering of
  it (source date + offset + wall time); keying on the input keeps the
  identity stable and meaningful for both `field` and `createdAt`
  sources. The S-02 gate's trigger-identity assertion was updated to
  the new shape.
- **Regression evidence (green):** both directions are gated in
  `packages/db/test/p3-c-date-relative.test.cjs` --
  (1) execute -> move date 2026-12-13 to 2026-12-20 -> new due date
  executes a SECOND, distinct run whose idempotency key carries
  `2026-12-20`, with a real second notification (per-run notification
  counts 1 and 1, none duplicated); (2) same-source-date replay
  (plan row rewound to its pre-finalize state, simulating a worker
  that created the run but died before finalizing) still adopts the
  existing run: run total unchanged, notification not duplicated,
  plan finalized SUCCEEDED from the adopted outcome.

### C1 -- 15-minute on-time grace boundary gates (injection-driven)

- `processDateRelativeSchedules` now accepts `onTimeGraceMs`, the same
  injection contract `processSchedules` already had; the default is
  still `AUTOMATION_SCHEDULE_ON_TIME_GRACE_MS` (15 minutes), so
  product behaviour is unchanged. The value is threaded into
  `processDateRelativePlan`'s LATE classification.
- Four boundary assertions, all with the grace injected explicitly
  (15 minutes) and time injected via `now`:
  - fixed cadence, slot consumed 14 minutes late -> executes on time
    (slot COMPLETED, 1 run);
  - fixed cadence, slot consumed 16 minutes late -> missed
    (slot SKIPPED_MISSED under the default skip policy, 0 runs);
  - date-relative, plan consumed 14 minutes late -> SUCCEEDED
    (not counted late);
  - date-relative, plan consumed 16 minutes late -> LATE
    (executes, counted late, inside the 24h window).
  Gates: "C1 grace boundary" tests in `p3-c-schedules.test.cjs` and
  `p3-c-date-relative.test.cjs`.

### C2 -- 100,000-record scale smoke (measured, standalone script)

- Script: `packages/db/test/p3-c-scale-smoke.cjs` (deliberately NOT
  matched by the `pnpm test` glob, so it stays out of the regular CI
  suite). Run on the verification stack with:
  `source <test-stack env> && node packages/db/test/p3-c-scale-smoke.cjs`
- Fixture: one app, 100,000 stock records bulk-inserted directly into
  `records` in 10 chunks of 10,000 (single `INSERT ... SELECT
  generate_series` per chunk), each record also receiving its
  `created` row in `record_events` in the same statement -- the same
  complete stored shape and the same approach as the 2,000-record
  backfill gate fixture. All records carry wish_date 2027-03-15, so
  the -3d 09:00 Asia/Tokyo rule owes exactly 100,000 plans due
  2027-03-12T00:00:00Z. Backfill ran with `now` long before any due
  date (never executes); consumption ran at due + 5 minutes; both
  phases used the product-default batch limit of 1,000.
- Measured results (second, complete run; PASS):

  | Measure | Expected | Actual |
  | --- | --- | --- |
  | Stock records | 100,000 | 100,000 (load 6.8s) |
  | Generated plans | 100,000 | 100,000 |
  | Duplicate plan groups (rule_version, record, schedule_key) | 0 | 0 |
  | Backfill batches (cap 1,000) | 100 | 100 |
  | Backfill time | -- | 487.6s |
  | Consumption batches (cap 1,000) | 100 | 100 |
  | Consumption time | -- | 3,284.9s |
  | Executed plans | 100,000 | 100,000 (all finalized SUCCEEDED) |
  | Runs | 100,000 | 100,000 |
  | Duplicate run groups (idempotency key) | 0 | 0 |
  | Notifications (one per run) | 100,000 | 100,000 |
  | Backfill checkpoint | COMPLETED, processed 100,000, cursor = max record id | matches |

  Total wall time 3,780.9s. The consumption rate (~30 plans/s) is the
  per-plan claim + execution transaction cost on this stack; no errors,
  no duplicates and no lost plans at this scale.

### Evidence (this batch)

- Verification stack: Postgres 16 (`suzubase_fresh46`) on
  127.0.0.1:55436, API on 127.0.0.1:3102, `TEST_API_URL` +
  `SUZUBASE_SYSTEM_NOTIFICATION_SECRET` injected (same口径 as
  C-0..C-5).
- Full suite: **138/138 pass** (134 C-5 baseline + 2 B1 gates + 2 C1
  gates), no reruns. The C2 smoke is a standalone script and does not
  add to the suite count.
- `pnpm -r --workspace-concurrency=1 build` clean;
  `pnpm -r --workspace-concurrency=1 typecheck` clean.
- Hosted CI: see the stage summary below.

### Commits (this batch)

- `a4c4a7f` B1 reproduction tests (red) + same-date replay adoption guard
- `9134d63` B1 fix: source date in date-relative run idempotency key
  and trigger identity; S-02 identity assertion updated
- `3d6b5e6` C1: `onTimeGraceMs` injection for
  `processDateRelativeSchedules` + four grace-boundary gates
- `e0af05a` C2: 100k scale smoke script
- (this report commit)

## P3-C stage summary

P3-C is complete. Delivered on this branch, in order: the admission
conditions C-0 (system actor for automation audit), C-1 (manual
notification dedup hardening), C-2 (status-value disposition) and C-3
(small items); the T-3 scheduling features -- C-4 fixed cadence
(persistent cadence plans, stable slot keys, atomic claiming, missed
policies, DST/month-end semantics, crash recovery, backlog alerting)
and C-5 date-relative scheduling (per-record plans, checkpointed
backfill, 24h late window with LATE/MISSED classification, aggregated
MISSED alerting); and this fix batch, which closed the one blocking
defect found in review (B1: reopened terminal plans now execute a new
run per source date), pinned the 15-minute on-time grace boundary with
injected tests on both scheduling kinds (C1), and proved the
date-relative pipeline end-to-end at 100,000 records with zero
duplicate plans or runs (C2). Final state: full suite 138/138 on the
verification stack, workspace build and typecheck clean, hosted CI
green on the pushed branch. Not merged to main; not deployed. P3-D
(Webhook / M1 compatibility / overall acceptance) remains untouched,
as ordered.
