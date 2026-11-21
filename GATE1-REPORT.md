# SuzuBase Gate 1 completion report

Gate 1 remains open. The foundation branch delivers a working subset of basic apps. Local Compose, the full database and API suite, and the Chromium suite passed. Acceptance still requires administrator TOTP, the full field and designer scope, attachment retention, the runtime Index Manager, and physical mobile verification. The item ledger below records additional gaps.

- Branch `gate1-foundation`
- B0 base `0050202d0cd0c61ccaede1d91cc00c0c88226b85`
- Architecture baseline `contracts-v1.md`
- Verification date 2026-11-22 JST

## Fresh Compose and health

```sh
API_PORT=23004 WEB_PORT=25177 SEARCH_TIMING=1 COMPOSE_PARALLEL_LIMIT=1 \
  docker compose -p suzubase-gate1-release up -d --build --wait --pull never
```

The release project created a new PostgreSQL volume and ran all 18 migrations as `suzubase_migration`. Compose reused local `postgres:16-alpine` and `node:24-alpine` and built `suzubase-dev:local` from the workspace. No image pull was executed. The initial inherited Dockerfile allowed two workspace builds to overlap. G1-02 set workspace concurrency to one for subsequent Docker builds. The final build, integration tests, browser suite, and benchmark ran serially.

```text
NAME                                IMAGE                COMMAND                  SERVICE    CREATED         STATUS                     PORTS
suzubase-gate1-release-api-1        suzubase-dev:local   "docker-entrypoint.s…"   api        5 seconds ago   Up 2 seconds (healthy)     127.0.0.1:23004->3000/tcp
suzubase-gate1-release-migrate-1    suzubase-dev:local   "docker-entrypoint.s…"   migrate    5 seconds ago   Exited (0) 2 seconds ago
suzubase-gate1-release-postgres-1   postgres:16-alpine   "docker-entrypoint.s…"   postgres   6 seconds ago   Up 5 seconds (healthy)     5432/tcp
suzubase-gate1-release-web-1        suzubase-dev:local   "docker-entrypoint.s…"   web        5 seconds ago   Up 5 seconds               127.0.0.1:25177->5173/tcp
```

API `GET /health` and web-proxied `GET /api/health` both returned the following.

```json
{"status":"ok","database":"connected"}
```

The web service started successfully and served the tested app. Compose has explicit health checks for PostgreSQL and the API. The web proxy was verified by HTTP and by Chromium.

## Full test results

`pnpm -r --workspace-concurrency=1 typecheck` and the Docker build completed with exit code 0. The API and DB run included all 11 B0 tests. The B0 migration inventory assertion gained the new tables and continued checking RLS and migration-role ownership on every table.

```text
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 16693.924258
```

```text
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5568.360875
```

GitHub Actions now runs serial build, typecheck, migrations, API and DB tests, and browser tests. The local runs verify those commands. Hosted run status is outside this report because the branch push follows the report commit as the final action.

## Item evidence

| Item | Status | Implementation and evidence | Open work |
| --- | --- | --- | --- |
| G1-01 | Partial | Tenant-admin directory API supports user creation, rename, password reset, disable, organization trees, and many-to-many groups. Tests rejected a weak password, reported both duplicate items, blocked an organization cycle and deletion with a child reference, revoked stale sessions, and displayed `New name（已停用）`. Disablement lists the user's created, undeleted records and blocks. | TOTP enrollment, challenge, disablement and recovery codes are missing. The first admin still requires trusted provisioning. The directory lacks a browser UI, group rename and deletion, a handoff workflow, and reference enumeration for organization UUIDs in application data and ACL rules. |
| G1-02 | Partial | App management REST supports settings, archive, soft delete, recycle listing, restore, and structure-only copy. A rename kept the app code. Copy assigned a fresh field ID, remapped the title field, and exposed zero source records. Archive preserved reads and rejected a record write. Recycle listing and restoration required the independent grant. The settings tabs run in the browser, with Workflow and Notifications labeled as unavailable. | Lifecycle and copy remain API operations. The general settings UI covers name, description, and the local draft toggle. Duplicate hints and numeric precision are stored settings. Their behavior and the remaining settings controls need implementation. |
| G1-03 | Partial | Field contracts are shared with browser and API code. The API independently validates record values and keeps the published structure separate from draft additions. The preflight and field samples below were exercised. The form settings help explains the category limitations of dropdowns. | Rich text, formula evaluation, layout elements, structured drag and drop, designer previews and undo are missing. Published field editing and deactivation, deleted-field archive, structural migration strategies, dependency preflight for destructive versions, and safe settings rollback are missing. The shipped preflight covers additive drafts and validates referenced view and ACL fields when drafts are saved. |
| G1-04 | Partial | Create, edit, detail, and list use schema definitions. A revision conflict retained edits, displayed the latest version and field differences, and let the user merge and resubmit. A batch returned one row conflict and one success. Cursor paging and idempotent creation passed. Soft delete released the unique value and restore returned 409 identifying the visible holder. Removing the holder allowed restore at revision 3. Record, history, and outbox writes remained atomic. | The browser lacks record recycle listing and restore. History renders against the event schema and has a JSON API. The dedicated history export and deleted-field access grant are missing. Bulk write covers creation. |
| G1-05 | Partial | Saved-view CRUD and default selection are versioned REST operations. Draft view access was rejected until publish. The current-user filter selected 20 and 100, excluded 1, and paged in numeric order. Desktop and mobile can switch published views. | Browser view editing, filter/sort configuration, default selection and rendering configured column widths are incomplete. The current-user-group operator is implemented and lacks a dedicated end-to-end example. |
| G1-06 | Implemented for the shipped query paths | A page size of 1 still produced count `2`, sum `120` and average `60.0000000000000000`. Hand calculation gives `20 + 100 = 120` and `120 / 2 = 60`. Hidden numeric fields were rejected. The aggregate takes at most ten numeric fields and has a 1.5-second PostgreSQL statement timeout with an explicit error. | The browser displays up to three numeric summaries. |
| G1-07 | Partial | FileService and the local Storage Adapter implement SHA-256, immutable tenant/app/file/version keys, configurable size/count/type limits, authorized attachment downloads, and transactional references. The adapter contract and failure examples are below. | Physical retention and scheduled cleanup are missing. Crash-left temporary data still needs an expiry/reconciliation job. A soft-deleted record keeps file references for restoration. Count-limit errors lack a per-file list. |
| G1-08 | Partial | Application, record and field rules publish together. Filtered record queries, counts, aggregates, exports and search share authorization predicates. History and attachment authorization also apply record and field grants. A preview for a visible record allowed view/edit and denied hidden-field view. Its preview for a hidden record denied view/edit, matching the formal request. Both preview calls left an audit row. | Preview accepts a record ID. Condition-based preview and a structured permissions editor are missing. The suite exercises the five shipped paths and does not exercise the Gate 2 reference path. |
| G1-09 | Implemented for the shipped field configuration | One concurrent REST test issued 20 distinct Tokyo numbers from `G-0008` to `G-0027`. Osaka had its own `G-0008`. After soft deletion, Tokyo advanced to `G-0028`. Editing preserved the issued value. CSV preserved `I-040`, `I-045` and `I-041`, then normal creation assigned `I-046`. The form settings display the gap semantics. | Configuration is immutable after publication alongside other published field definitions. Live counter administration is outside the implemented settings surface. |
| G1-10 | Partial | Single-app search supports normalized phone exact and suffix, separate name and kana, customer ID exact/prefix, and case-insensitive email. Scope and field projection apply the same ACLs as the list. See normalization, P0 isolation and benchmark below. | The runtime Index Manager, independent concurrent index jobs, operator-visible index states and a preconfigured customer template are missing. The current search projections use one static shared B-tree. |
| G1-11 | Partial | CSV mapping, full preflight, downloadable error rows, atomic batches, resumable offsets, partial counts, number preservation, saved-view CSV and attachment ZIP export are implemented. The test and its actual counts are below. APIs check import/export grants separately. | Export covers published views. Ad hoc search-result export is missing. The browser mapping UI uses JSON. Attachment ZIP export lacks a dedicated automated round-trip test. |
| G1-12 | Partial | Per-app REST tokens can be issued, listed and revoked. A read token read records, failed on writes, settings, a different app and token management. The one-time value was present on issuance only. After revoke, its read returned 401. Swagger includes bearer usage and issuance metadata. | OpenAPI request and response schemas remain incomplete on several new routes. Token management is exposed through REST. |
| G1-13 | Partial | Chromium exercised the actual UI at all four widths. The test covered field ACL on the mobile path, long-value wrapping, focus visibility, delete confirmation, native input types, time-zone rendering, upload retry and the local draft state machine. | Physical keyboard obstruction, operating-system date/time pickers and camera capture remain unverified. The desktop accessibility check covers visible focus and responsive layout. It does not constitute a full keyboard-navigation or contrast audit. Mobile form configuration currently requires a tenant-admin session with app-management access. |
| G1-14 | Local pass | Fresh migration and full suite output, P0 test, viewport output and 100k benchmark are included in this report. | Hosted CI will run on branch publication. Gate acceptance remains open for the incomplete features above. |

## Draft preflight and field evidence

1. A revision-1 record at schema version 1 existed before a required Title field was added to schema draft 2.
2. `POST /apps/{appId}/publish` returned HTTP 409 with record number `1`, the Title field UUID, `value: null`, and `reason: "required"`. Draft status became `validation-failed` and the published pointer stayed at 1.
3. `PATCH /apps/{appId}/draft/fields/{fieldId}` set `required: false`. A subsequent publish returned HTTP 201 and `publishedSchemaVersion: 2`. The original record still reported schema version 1. The browser obtains field definitions for a record's version from its form endpoint.
4. Workflow and lookup checks were explicitly listed as skipped because both belong to Gate 2.

| Field type | Field ID | Normalized value read back |
| --- | --- | --- |
| text | `90b08dca-beef-4e3e-9660-f8e789890613` | `One line` |
| multiline | `4c561a3c-d34d-4e46-bbb3-bd4efe9bbda7` | `First\nSecond` |
| number | `24948a8d-b2be-4602-95dd-4a9b2c704165` | `1.25` |
| radio | `9a10ac4b-3f3d-453f-964d-7c8fb1a7aabc` | `a` |
| checkbox | `e69393ef-7b7c-4133-bff4-718697f16e5b` | `["a","b"]` |
| select | `95ebf4b7-41ff-4ab6-971f-da9015c0e794` | `b` |
| multiselect | `b5b1adae-638d-4e7f-a018-f1f1208f5dbf` | `["b"]` |
| date | `87814bbc-436d-41cc-845a-f7aa6c996250` | `2026-11-21` |
| time | `e639bfdf-2ee5-43e1-bc1d-ed6b4b9a5371` | `11:30:00` |
| datetime | `bbc23430-9667-434a-86fb-e6da3f9d0c57` | `2026-11-21T02:30:00.000Z` |
| url | `f13376ce-07f6-41e4-b74a-8423972611d9` | `https://example.test/` |
| phone | `2c33baea-2c22-4c01-aa1c-0641fe53d051` | `０９０-１２３４-５６７８` |
| email | `b314b19c-5b83-4b33-9954-e6d3b006e315` | `Example@example.test` |
| user | `cc9aee79-81a6-4857-ac9e-4db4a02ed004` | `b585208b-a294-4d01-90b6-a25e1db531a5` |

The file test created an attachment field, uploaded a PDF, saved its UUID array, and read the original bytes through the authorized download endpoint. The numbering tests created an automatic-number field and retrieved its generated value by UUID. B0 supplies `recordNo`, `createdBy`, `updatedBy`, `createdAt`, and `updatedAt`. Organization and group selectors validate UUID membership in the tenant on writes. Their record round-trip examples remain unverified. F3, F5 and F26 have no sample because the types are missing.

## Search and authorization evidence

| Search field | Input | Mode | Matches |
| --- | --- | --- | --- |
| Phone | `090-1234-5678` | Exact against a full-width stored number | 2 |
| Phone | `５６７８` | Suffix | 2 |
| Name | `山 田 太 郎` | Exact against `山田　太郎` | 2 |
| Name | `ヤマダ タロウ` | Exact against the kanji field | 0 |
| Kana | `ﾔﾏﾀﾞﾀﾛｳ` | Exact against the separate kana field | 2 |
| Customer ID | `C-11` | Prefix | 2 |
| Customer ID | `C-1%` | Literal prefix | 0 |
| Email | `contact@EXAMPLE.test` | Exact, original display case retained | 2 |

A three-digit suffix returned HTTP 400. As a restricted user, the same suffix yielded only one of two records and the hidden email was absent from returned data. Searching the hidden email field returned 404 with `无权限`. A separate fixture returned one list row, count one, one search hit and exactly one CSV data row. The CSV had only the visible phone and text fields. A P0 case used two tenants with the same app code and field UUID. The API denied the other tenant's app and the runtime role, with a tenant transaction, saw only its own two projections for that UUID.

## 100,000-record search benchmark

The benchmark scripts are `packages/db/test/search-performance.cjs` and `test/browser/search-performance.cjs`. The seed uses SQL to generate one app with 100,000 synthetic phone records and their two normalized projections. Every fifth record is hidden from the test reader, and the predicate field is hidden on API responses. The run used Chromium on the local Mac, a fresh Compose database, and PostgreSQL 16. Each mode discarded five warmups and measured 40 sequential searches. Browser time starts before filling the value and ends when the matching record action is present in the rendered page. The API reports the separate PostgreSQL client round trip for the count and result query with `SEARCH_TIMING=1`. That measurement excludes session lookup and query-scope setup. A separate runtime-role `EXPLAIN (ANALYZE, BUFFERS)` checks the index and actual row count.

| Mode | Measured samples | Browser P95 | PostgreSQL round-trip P95 | 500 ms browser target |
| --- | ---: | ---: | ---: | --- |
| Full phone | 40 | 62.51 ms | 1.19 ms | Met |
| Four-digit suffix | 40 | 62.83 ms | 1.72 ms | Met |

The unrestricted fixture held 100,000 records. The reader could see 80,000. Queries against deliberately hidden full numbers and suffixes each returned zero hits.
The representative suffix plan returned 10 rows in 0.331 ms and used `record_search_values_prefix_idx` with `value ~>=~ '1800'` and `value ~<~ '1801'`, followed by the record primary key. The P95 values apply to this local synthetic workload.

The first benchmark showed a reverse-projection scan even though its browser latency was under 500 ms. PostgreSQL 16 marks `LIKE` as non-leakproof. The final query uses parameterized byte-order bounds from `text_pattern_ops`. Those comparison operators are leakproof, and the benchmark now asserts both ends of the prefix index range in the RLS plan.

## Mobile and attachment evidence

| Chromium viewport | List | Detail | Edit | Long text wrapping | Date/time input types | Delete confirmation | Visible focus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 320 px | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
| 375 px | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
| 390 px | Pass | Pass | Pass | Pass | Pass | Pass | Pass |
| 1280 px | Pass | Pass | Pass | Pass | Pass | Pass | Pass |

At 375 px, IndexedDB contained the five-component key and the draft value. Publishing a new form version triggered the recovery warning. A server edit then produced a revision conflict. Applying the draft changes preserved an independent server-side field change. Saving cleared the draft. At 390 px, the browser injected HTTP 503 for the upload, blocked record save while the failed file was pending, retried the same file successfully and exposed its download action. The 320 px ordinary-user run exposed neither management controls nor a hidden field, and reduced a 403 response to `无权限`. Sticky save controls were observed at all widths. The OS keyboard and physical camera were unavailable for verification.

The file integration test returned 400 for `too-big.pdf` and named the rejected file. A successful upload entered `READY`. A failed record submit after the first attachment link rolled back to `READY` with zero references. Retrying the valid attachment succeeded and the owner downloaded the exact upload bytes. An unauthorized same-tenant user received 404 with `无权限`. Removing the last link set `DELETED` and reference count zero. The adapter rejected invalid keys and overwrites, verified SHA-256, and removed a file idempotently.

## CSV and token evidence

CSV preflight returned two eligible and three failed rows while the app still had zero records. The error report identified an invalid number, the unsupported `Customer` lookup column and a duplicate automatic number. Applying offset 0 twice kept the imported count at one. Applying offset 1 advanced to two. A corrected error row was re-preflighted and imported separately.

```csv
amount,number
10,I-040
15,I-045
22,I-041
100,I-046
```

Token issuance returned HTTP 201 and a bearer matching `sb1_[redacted]`. Listing returned its ID and actions without the secret or hash. The token read its intended app, while the write, other-app, settings and token-management calls failed. Revocation returned a timestamp and subsequent use returned HTTP 401 with `无权限`.

## Contract decisions and gaps

- The brief and the contract introduction split the work across three gates. Lookup key matching from §4.8 and the subtable designer container from §1.7 stay with Gate 2. In Gate 1, an explicitly mapped lookup or a `lookup:` header with a value reports a row error and identifies its column. Other mapped fields still undergo preflight.
- G1-02 asks for a comment setting placeholder and the prohibition section limits placeholders to the Workflow and Notifications tabs. The two listed tabs are the only placeholders. The comment setting is absent.
- Section 3.2 calls the save state machine five-state and enumerates six labels. The editor uses all six named states and gives server success and device-draft success separate messages.
- Existing B0 record routes expect one indistinguishable 404 response for absent and foreign records in apps with the default policy. That response remains `Not Found`. Record-rule denials within a visible app and new search and attachment denials use `无权限`. The browser maps all 403 and 404 responses to `无权限`.
- The B0 per-account app-creation grant remains valid for existing accounts. New ordinary accounts default to no app creation unless the tenant enables it. Tenant admins can administer app settings. Record rules still apply to their business-data reads.
- With workflow deferred, the disable API treats created, undeleted records as the blocking list. The app does not track reassignment yet. Retaining historical user IDs keeps labels recoverable after disablement.
- Local draft keys are ordered JSON tuples. Drafts expire after seven days, are pruned on access and are cleared on explicit sign-out. Tenant and app flags both apply. The editor saves schema-approved record values and attachment IDs or filename placeholders, with no authenticated session or credential data. The default tenant time zone is `Asia/Tokyo`, and API datetimes use explicit offsets with UTC storage.
- The CSV job limits are 1,000 rows, 100 columns, and 50 rows per applied batch. CSV export caps at 10,000 rows. Attachment ZIP export caps at 256 files and 32 MiB. The serializer escapes spreadsheet formula prefixes. Preflight uses savepoints under the tenant transaction and always rolls back its trial records, counters, history, and outbox effects.
- Automatic-number uniqueness is scoped to the app and the configured sequence value. An issued number survives record deletion. The app-token limit is 50 active tokens per app, and a token's action list intersects with its issuer's current authorization.
- Runtime indexing remains incomplete under §5.5. The search implementation uses a static projection index with bound parameters and RLS. This avoids introducing runtime DDL through a tenant request transaction.
- The fresh Compose check covers the local deployment topology on the available images. Production HTTPS installation and Gate 3 recovery acceptance remain outside this run. No additional Docker image was needed for the delivered features.

## Commits

- `7c1da7346e3aee9ebf0addd764720255c4266cc9` G1-01 Add tenant directory and account administration API
- `68880a129d57b4850d2bb8ce0c2aa9eee6888089` G1-02 Add app settings, structural copy, archive and recycle bin APIs
- `cf8bb362c5d34bc1ae621df3e066370d9a84229c` G1-03 Add field contracts and required-field publication preflight
- `43e5d8c235675eca511d0ca29c6c185975b4a72b` G1-04 Add cursor reads, bulk create, history and transactional record recycle
- `d62babc61641ba98fc5a78b509520383420fdcb1` G1-05 Add versioned saved views with dynamic filtering and typed sort
- `121acc5ac2279872488402342a4b22fd70d48cd6` G1-06 Add bounded full-view count, sum and average
- `1fdc35bf725c039e2d29ebd4eb9c28e981497928` G1-07 Add attachment storage, upload authorization and transactional references
- `01a4f8f15384b5cfa5efa4ca87e4b9bc7c79ef0c` G1-08 Publish three-layer ACLs and share SQL authorization with audited preview
- `346467d51447db97ff350d8cb24edd20cef1c257` G1-09 Allocate automatic numbers with transactional scoped counters
- `a88aacef9125c83b02a8b8ad385b1595a1f6afae` G1-10 Add indexed Japanese search projections and authorization checks
- `ccc31ffa176f7d0ed338186114a37e792c1c3f28` G1-11 Add CSV preflight, resumable imports, number preservation and scoped export
- `cfe3f38a8eabd75cdacdd8a333c137e84b7a6102` G1-12 Issue, scope, list and revoke per-app REST tokens
- `3a2a19f0106ce7f4defdeac4504ce1d3fa58004a` G1-13 Add responsive record forms, local drafts and viewport verification
- `7ab4b03bfb612e9dbc1c478ecca0c35adb195ddf` G1-14 Extend CI and verify indexed 100k search under RLS

The report is the final commit on `gate1-foundation`.
