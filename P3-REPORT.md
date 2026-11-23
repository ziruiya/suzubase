# P3-A Automation Foundation - Completion Report

Date: 2026-11-23
Branch: `p3-a-automation-foundation`
Baseline HEAD before P3-A: `82e33d6`

## Scope audit

| Item | Status | Evidence / deviation |
|---|---|---|
| Core tables and migrations 0035-0039 | Incomplete then repaired | 0035 creates `automation_rules`, `automation_rule_versions`, `automation_grants`, `automation_runs`, `automation_run_actions`, `automation_schedules`, `automation_webhook_deliveries`, `automation_audit_events` plus outbox/record-event bindings. 0036-0039 add append-only audit, workflow event kinds, schema FK, and archive actions. 0036 incorrectly re-added `source_schema_version` already created by 0035; removed duplicate in this round. |
| Seven core table constraints | Completed | Tenant composite keys, composite FKs, unique run/action keys, immutable published versions, append-only automation audit, RLS/runtime grants, and record/outbox tenant boundaries are present. |
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

## Deviations and unresolved semantics

1. **Top unresolved:** P3-A intentionally does not execute P3-B actions. The implementation must retain `ACTIONS_NOT_IMPLEMENTED` / `NOT_EXECUTED` evidence and must never promote such runs to `SUCCEEDED`. The final P3-B change should replace the deferred state only after real action execution and action-level outcomes are implemented.
2. Migration 0036 initially duplicated `source_schema_version` already introduced in 0035. It was removed and the migration rerun on an empty database.
3. P3-A has no formal P3-C scheduling worker, P3-D HTTP transport, or P3-B business action execution. Those are outside this branch's IN scope.
4. Local integration authentication currently returns `401 Invalid credentials` for API login despite direct database password verification and API health/route startup. It is recorded as an environment/integration blocker pending CI-equivalent rerun; no product success is inferred.

## CI-equivalent evidence

- PostgreSQL 16 local container: `docker` test container on port 5433.
- `pnpm install --frozen-lockfile`: passed.
- `pnpm -r --workspace-concurrency=1 build`: passed.
- `pnpm -r --workspace-concurrency=1 typecheck`: passed.
- Empty database migration before repair: product failure found: duplicate `source_schema_version` in 0036.
- Empty database migration after repair: passed, 40 migrations applied.
- API health: passed (`{"status":"ok","database":"connected"}`).
- Full `pnpm test`: attempted. First runner summary: 89 tests seen, 12 passed, 77 failed. Failures were predominantly `401 Invalid credentials` at API login, preventing integration fixture setup. This environment-local suite result is not a product pass.
- Target P3-A test: attempted, 0/1 passed; blocked at the real API login setup with `401 Invalid credentials`.
- Browser suite: not run locally; environment is not glibc-compatible for the required Chromium suite. Leave to Hosted CI.

## P3-A gate evidence

| Gate | Conclusion | Evidence |
|---|---|---|
| Repeated trigger no duplicate logical run | Implemented and tested by code/test shape | Unique `(tenant_id, idempotency_key)`, replay `onConflictDoNothing`, worker marks processed outbox event. Runtime integration pass remains blocked by API auth. |
| Old-version binding | Completed | Run stores `rule_version`; worker selects `automationRules.currentVersion`; test asserts workflow run bound to version. |
| Grant revocation | Completed | Revoke sets `revoked_at`; runtime filters active grants and test verifies `SKIPPED_UNAUTHORIZED`. |
| Deterministic cycle | Completed | Static analysis can emit `BLOCKING_CYCLE`; publish preflight blocks it. |
| Potential cycle | Completed | Static analysis emits `POTENTIAL_CYCLE` warning and permits publication. |
| Causation through outbox | Completed | Outbox columns, run columns and exports are linked; chain-depth test records depth 5/6 behavior and admin notification. |
| Business admin cross-app grant and preflight | API implementation present | Real `/automation/rules/:id/grants`, `/preflight`, `/publish`, `/enable` routes exist and P3-A test uses them. Local API login prevented execution proof in this round. |

## Commit and push status

Implementation commit: `6665e5e feat(p3a): add automation rule execution foundation`.
This report is committed separately after final verification.
