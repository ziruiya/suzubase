# SuzuBase Gate 2 completion report

- Branch `gate2-collaboration` (never merged to `main` by the builders)
- Baseline: Gate 1 close `1fe080f` on `main`
- Verification date 2026-11-22 JST
- Verification stack: Compose project `suzubase-gate2-verify` (API 127.0.0.1:23008, web 127.0.0.1:25181, PostgreSQL 127.0.0.1:25432, `SEARCH_TIMING=1`), plus a fresh from-empty project `suzubase-gate2-fresh` (API 23009 / web 25182). Only pre-pulled images were used (`postgres:16-alpine`, `node:24-alpine`); no `docker pull` was run.

## Builder attribution

- **G2-01 … G2-10: built by Codex** (commits `aca9992` … `2dec8bb`).
- **G2-11 … G2-15: completed by Muse directly**, because the Codex weekly quota was exhausted (reset 2026-11-25 15:36 JST) and Copilot CLI 1.0.114 was installed on the Mac but not authenticated (parked pending a user device-flow login; no login was attempted). The user explicitly authorized the Muse direct-writing fallback. The G2-11 CSV implementation existed as uncommitted WIP from the earlier attempt; Muse reviewed it, changed the subtable import semantics (see Decisions), added the missing tests and the OpenAPI fields, and committed it.

## Fresh Compose and health

`suzubase-gate2-fresh` was created from an empty volume with the final code:

```text
Container suzubase-gate2-fresh-postgres-1 Healthy
Container suzubase-gate2-fresh-migrate-1  Exited (0)
Container suzubase-gate2-fresh-api-1      Healthy
Container suzubase-gate2-fresh-web-1      Healthy
GET http://127.0.0.1:23009/health      -> {"status":"ok","database":"connected"}
GET http://127.0.0.1:25182/api/health  -> {"status":"ok","database":"connected"}
```

## Full test results

```text
pnpm -r --workspace-concurrency=1 build      exit 0
pnpm -r --workspace-concurrency=1 typecheck  exit 0
pnpm test          (integration, packages/db/test/*.test.cjs)
  tests 53, pass 53, fail 0
pnpm test:browser  (test/browser/*.test.cjs)
  tests 3, pass 3, fail 0
```

Counting: B0 11 + Gate 1 integration tests are inside the 53 and all pass (no regressions; the migration inventory and GF-11 needed the corrections documented below). Gate 2 integration files: gate2-lookup, gate2-related, gate2-table, gate2-workflow-definition, gate2-workflow-runtime, gate2-workflow-repair, gate2-comments, gate2-notifications, gate2-preflight (G2-01…G2-10, by Codex) plus the new remainder files below. Browser: gate1 + management (Gate 1 regression, unmodified) + gate2 (new).

New tests added in the remainder (counted separately):

| File | Tests | Covers |
| --- | --- | --- |
| `packages/db/test/gate2-csv.test.cjs` | 2 | G2-11 lookup hit/miss, snapshot rejection, subtable format/REPLACE/round trip |
| `packages/db/test/gate2-acl-paths.test.cjs` | 1 | G2-12 six paths + preview + blind re-fetch + notification masking |
| `packages/db/test/gate2-history.test.cjs` | 1 | G2-13 all event kinds, workflow detail, kind/field filters, export |
| `test/browser/gate2.test.cjs` (+ `packages/db/test/gate2-browser-fixture.cjs`) | 1 | G2-14 at 320/375/390 |
| `packages/db/test/gate1-openapi.test.cjs` (amended) | — | GF-11 correction + Gate 2 route assertions |
| `packages/db/test/migration.test.cjs` (amended) | — | Gate 2 table inventory |

## Item evidence (G2-11 … G2-15; G2-01 … G2-10 evidence is in the Codex run logs and the tests above)

### G2-11 CSV (lookup + subtable)
- Lookup hit: CSV keys `C-1`/`C-2` imported 2 records; snapshots written (`copy = 10.5 / 20`) and a `record_references` row verified in the database pointing at the source record.
- Lookup miss: key `NOPE` produced a per-line error whose issues carry the key value (`keyValue`), `eligible 2 / failed 1`, and the downloadable error CSV contains the miss row.
- Snapshot column mapping is rejected at preflight: `Lookup snapshots are read-only. Map the lookup key column instead.`
- Subtable export format verified byte-for-byte on the header row: `record_no,__table,__table_name,__row_order,field:title,lines.sku,lines.qty`, one row per child row with parent values repeated.
- Grouped import: missing parent `999999` is a per-line error naming the record number; `jobSummary` now reports `eligibleRows`/`importedRows` in source-file rows (2) distinct from grouped candidates.
- Gate 1 CSV regression: `gate1-csv` passes unchanged (eligible 2 / failed 3, `lookupColumns ['Customer']`, `/Lookup columns/` errors).

### G2-12 ACL sixth path
One fixture (source + destination with lookup and related fields; owner, restricted reader, destination-editor/source-blind user) asserts, under identical conditions:
- List = 2 records with the snapshot field absent; count/aggregate = 2 and the hidden numeric field is rejected for aggregation; reference display: detail + form mask the snapshot, related endpoint returns count 1 for the public source record and 0 for the private one; export contains no `snapshot:` column and no snapshot values; search on the visible key finds the record without the snapshot and searching the hidden snapshot field is rejected; history leaks no snapshot value.
- Preview consistency: `preview.fields[copyTarget].view.allowed === false` for the reader (predicting the masking) and `fields[relatedField].view.allowed === true` (predicting the related endpoint), both from the same `fieldDecision` the formal paths use. No new preview machinery was built.
- Notification masking cross-check: a rule template referencing the snapshot field delivered a notification to the reader containing the visible key (`K1`) and never the snapshot value (`4242`).
- Blind editor: refresh preview (GET), refresh confirm (POST), reference-search and lookup-preview all returned **404**, and the snapshot plus record revision were byte-identical afterwards.
- **No production code changed for G2-12**: the scattered Gate 2 implementations already agree; the suspected drift points (`records.ts form()` masking, restricted-exporter snapshot columns in `csv.ts`) were exercised by the test and behaved correctly.

### G2-13 Complete history
- Production change: `historySnapshot` now enriches workflow events from the `workflow_events` side table (same rows the workflow history view reads — single source) with `{ action, from, to, reason, assigneeIds }`, and the history endpoint accepts `kind` and `fieldId` query parameters (added to the OpenAPI contract). The web History UI gained event-type and field filter controls and renders the workflow detail line.
- Test drives one record through field edit, subtable row add/edit/remove, lookup refresh, workflow action, reassign, repair, comment create/delete. All kinds present (`created, updated ×3, lookup-refetched, workflow-action, workflow-reassigned, WORKFLOW_REPAIR, comment-created, comment-deleted`), `recordRevision` monotonic 1→10, kind/field filters verified, `/history/export` contains workflow + comment events and keeps the Gate 1 shape (`recordId`, `recordNo`, `recordRevision`, `events`, `schemas`), and the repair event carries its reason with `action: null` (never disguised as an approval).
- Attachment nuance: there is no dedicated attachment event kind; attachment changes ride `updated` field changes (Gate 1 behaviour). No new kind was invented; recorded here as the standing 口径.

### G2-14 Mobile Gate 2 share
Chromium at 320/375/390 against the real UI (fixture: lookup + subtable + published one-action workflow + notification):
- Subtable row card expands (`<details class=panel>`) and edits at all three widths; no horizontal scrolling anywhere.
- Reference picker fills the viewport at ≤600px (bounding box = viewport), search finds `K1`, Cancel closes.
- Workflow: `.workflow-actions` computed position is `sticky`; the confirm dialog names `Record 1 · Open → Review`, stays inside the 320px viewport, and Confirm moves the record to Review. The dialog already satisfied the bar at 320px (`width: min(36rem, calc(100% - 2rem))`), so **no CSS change was needed**.
- Comments post + delete leave the `Comment deleted` placeholder; notification centre shows the unread item and Open record navigates; My tasks lists the record and opens it.
- Gate 1 browser tests re-run unmodified: pass.

### G2-15 Tests, OpenAPI, performance
- **GF-11 true cause (diagnosed against the live API, not assumed):** the failure was the assertion at `/apps/{appId}/workflow/versions/{version}`. The `version` path parameter is a legitimate integer workflow version; its live schema is `{ type: 'integer', minimum: 1, maximum: 2147483647 }` with **no `format`**, while the Gate 1-era test required `format === 'uuid'` for every path parameter. The doc was not missing workflow endpoints (102 live operations, all with non-empty schemas). Correction, kept narrow: uuid parameters still require `format: 'uuid'`; `version` requires `type: 'integer'`. Explicit Gate 2 assertions were added (workflow publish/versions/repair/history, workflow tasks, lookup refresh, comments, notifications exist with schemas; the CSV preflight reply documents `eligibleRows`/`importedRows`).
- Migration inventory: the B0-era expected table list ended at Gate 1; the Gate 2 tables were inserted in sorted position (`comment_mentions`, `notifications`, `record_comments`, `record_table_rows`, `record_workflow_state`, `workflow_actions`, `workflow_assignments`, `workflow_definitions`, `workflow_events`, `workflow_states`; `record_references` was already listed).
- OpenAPI: `importJob` gained `eligibleRows`/`importedRows` (the API already returned them; the contract did not document them).
- 100k search P95: see Performance below.

## Decisions and conflicts

1. **Subtable grouped CSV import = REPLACE semantics** (coordinator decision, implemented in G2-11): for each table field present in the file, the file's grouped rows become that table's rows on the parent. The WIP's append semantics duplicated rows on re-import and failed the brief's CSV 往返 (round-trip) requirement; with REPLACE, export → import is idempotent (verified: `[OLD] → [A,B] → [A,B]`). The internal method was renamed `appendImportedRows` → `replaceImportedRows`; API behaviour is unchanged (parent found by record number under view+edit scope, CAS revision, history event with source `import`, row change set recorded).
2. **GF-11 expectation correction** (above): a genuinely stale Gate 1 test expectation for a legitimately integer parameter; narrowed, not weakened — every other parameter still requires uuid format, and Gate 2 assertions were added.
3. **Migration table inventory update** (above): the test's expected list was stale, the migrations were correct.
4. No conflicts with `contracts-v1.md` were found in the remainder items. (合同冲突：无。)

## Four-state registry increments (P2 / L)

| Item | State | Entry condition |
| --- | --- | --- |
| F13 attachment fields inside subtables | P2 (registered in brief ruling 3) | File references and reference relations extended to row scope |
| F18 lookup fields inside subtables | P2 (brief ruling 3/4) | Same row-scope relation work as above |
| Comment editing | L (candidate) | Only if a future brief reopens it; Gate 2 ruling 6 keeps comments create/delete only |
| Dedicated attachment history event kind | L | Attachment changes currently ride `updated` field changes; a dedicated kind needs a contract amendment in a future gate |

## Performance (100k search benchmark, same 口径 as Gate 1)

Same scripts and 口径 as Gate 1 (`packages/db/test/search-performance.cjs` seeds 100,000 records / 80,000 visible; `test/browser/search-performance.cjs` takes 40 samples after 5 warmups per mode against an API started with `SEARCH_TIMING=1`; seeding took ~24 minutes on this Mac, as in the Gate 1 run):

| Mode | Browser P95 | Database round-trip P95 | Target ≤ 500 ms |
| --- | --- | --- | --- |
| exact | **53.30 ms** | 1.28 ms | met |
| tail (suffix) | **52.63 ms** | 1.62 ms | met |

Gate 1 baseline was ≈53 ms browser P95. Gate 2 result is level with the baseline (53.30 / 52.63 ms) — **no regression**, no 口径 change. Hidden-parity checks passed (0 exact hits, 0 suffix hits for hidden records), and the suffix EXPLAIN still uses `record_search_values_prefix_idx` bounded at both ends (`~>=~ '1800'` / `~<~ '1801'`).

## Commit list (remainder; branch `gate2-collaboration`)

| SHA | Item |
| --- | --- |
| `734cb35` | G2-15 Fix migration table inventory for Gate 2 tables |
| `e341ca3` | G2-11 Complete CSV lookup matching and subtable round trip with replace semantics |
| `6a583ed` | G2-12 Add six-path ACL consistency tests for snapshots and related records |
| `7013ffe` | G2-13 Enrich record history with workflow detail and kind/field filters |
| `9c7a85c` | G2-14 Add Gate 2 mobile browser coverage at 320/375/390 |
| (this commit) | G2-15 Record Gate 2 evidence, GF-11 diagnosis and 100k P95 results |

G2-01…G2-10 (Codex): `aca9992` G2-01, `ccddd1b` G2-02, `8748621` G2-03, `3120c73` G2-04, `ae2a059` G2-05, `734d3e8` G2-06, `7cf73c5` G2-07, `4f83f0b` G2-08, `28f16f1` G2-09, `2dec8bb` G2-10.
