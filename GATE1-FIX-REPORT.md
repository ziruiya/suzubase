# SuzuBase Gate 1 fix report

- Branch `gate1-foundation`
- Starting commit `dd1b41f`
- Tested implementation `767a07c`
- Verification date 2026-11-22 JST

All requested GF items have implementation and local verification. Physical-device mobile verification remains open. The final section records implementation boundaries and carryovers from the earlier report.

## Fix ledger

| Requested item | Commit | Status and evidence |
| --- | --- | --- |
| GF-A · Administrator TOTP | `1e319d9` | Passed. Enrollment confirms an authenticator code and issues ten single-use recovery codes. Login presents a challenge before issuing a session. Replay, reused recovery codes and sessions issued before enablement or disablement were rejected. |
| GF-B · F3, F5 and F26 | `11b5015` | Passed. Rich text, calculated results and four layout elements round-tripped. Record writes rejected forged calculation and layout values. Chromium formatted and displayed bold text. |
| GF-C · Designer and schema publication | `e4ba02d`, `767a07c` | Passed within the boundaries below. Chromium dragged a field between rows, undid the change, opened both previews and saved layout by field ID. Integration tests verified draft isolation, published edits, option deactivation, destructive preflight, explicit migration, archive grants and layout/view rollback. |
| GF-D · Attachment retention | `164a126` | Passed. Count-limit errors identified `receipt.pdf`. The cleanup worker removed expired bytes and crash-left staging files. The integration test preserved a recent deleted file and a ready upload. |
| GF-E · Runtime Index Manager | `a586439`, `767a07c` | Passed. A numeric index went from building to failed, then to available after repair and retry. A runtime-role query used the index. Field deletion waited for concurrent retirement. The customer template created separate Name and Name kana fields. |
| GF-F · Browser management | `96b9da4` | Passed. Chromium created an organization, renamed a group, configured a saved filter, sort, column width, numeric summary and default view, then restored record 2 from the recycle bin. |
| GF-G · Permission editing and preview | `1988c0a` | Passed. Chromium saved all three ACL layers and ran condition preview. Integration results matched the formal read and edit checks and left audit rows with the submitted conditions. |
| GF-H · History and archive export | `91449ec` | Passed. Per-record JSON history export preserved event schemas and required the export grant. The independent archive grant controlled access to deleted field definitions and values. |
| GF-I · Bulk update | `d339ae8` | Passed. One request returned row statuses `200` and `409`; clearing a required value returned per-row `400`. Chromium also saved a batch edit and displayed its row result. |
| GF-J · Search export, ZIP and selectors | `d52f9af` | Passed. The search and CSV contained one authorized hit. The ZIP matched the attachment bytes and SHA-256 manifest. Organization and group UUIDs round-tripped, and the current-user-group view selected only the member's group. |
| GF-K · OpenAPI | `8d8305f` | Passed. The live document described 71 operations. The test checked path parameters, the login challenge, migration errors, batch updates, history export, ZIP and one-time token issuance. |

## Clean database and full suite

The Compose project started from an empty PostgreSQL volume. It applied all 24 migrations as `suzubase_migration`. The migration integration test also applied all 24 migrations to a separate empty database, reran them and checked RLS and table ownership.

```sh
COMPOSE_PARALLEL_LIMIT=1 docker compose -p suzubase-gf-final build api
API_PORT=23006 WEB_PORT=25179 SEARCH_TIMING=1 MAINTENANCE_INTERVAL_SECONDS=3600 \
  COMPOSE_PARALLEL_LIMIT=1 docker compose -p suzubase-gf-final up -d --no-build --wait --pull never
```

PostgreSQL and the API were healthy. The migration container exited successfully, and the web and maintenance worker were running. API `/health` and web-proxied `/api/health` each returned `{"status":"ok","database":"connected"}`. The build reused the pre-pulled `postgres:16-alpine` and `node:24-alpine` images. No image pull was run.

Workspace typecheck, the Docker build, integration tests, Chromium tests and the benchmark ran serially. The Chromium run used the local Chrome for Testing 153.0.8010.12 headless executable.

| Command | Tests | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| `pnpm test` | 36 | 36 | 0 | 0 | 25.36 s |
| `pnpm test:browser` | 2 | 2 | 0 | 0 | 8.59 s |

The 26 previous integration tests and the previous Chromium test passed. The viewport test exercised list, detail and edit at 320, 375, 390 and 1,280 px. It also checked wrapping, visible focus, sticky save, date/time input types, delete confirmation, draft recovery, upload retry and field ACL.

## Field round trips

The integration test created the fields below, published the schema, wrote a record and fetched its form. F26 elements returned from the schema and were absent from the record's value map.

| Field or element | Field ID | Write/read evidence |
| --- | --- | --- |
| F3 rich text | `b7b9522d-94b8-4e6d-b581-67f17b28d86b` | Stored and read `<p>First <b>paragraph</b></p><ul><li><a href="https://example.test">Item</a></li></ul>`. CSV contained `First paragraph` and `Item` on separate lines, with plain-text conversion identified in the filename. ZIP exports with rich text include a note. |
| F5 calculation | `de6e21d3-fa26-4005-aa70-c5468d4d85a2` | The record supplied `3.25` under amount field `090e346a-9338-4476-bbfa-db11928923c4`. The formula multiplied that field by two and appended ` items`. The read returned `6.5 items`. Updating the amount to `7` returned `14 items`. |
| F26 label | `0b0dada6-d78c-45ea-84ef-12a22210bd0a` | `{"kind":"label","text":"label"}` |
| F26 separator | `59a67e9c-445b-4ca1-a664-ca7d1dbb9035` | `{"kind":"separator","text":"separator"}` |
| F26 blank | `fc0ba3cc-94e1-4abf-91ad-11a5d548948a` | `{"kind":"blank","text":"blank"}` |
| F26 group | `770a8a89-88df-470f-b392-cb5c7dc6c260` | `{"kind":"group","text":"group"}` |
| Organization selector | Test field `Office` | Stored and read Tokyo UUID `4bf5800f-5b88-461c-abd6-4d2d5f76835f`. |
| Group selector | Test field `Team` | Stored and read Sales UUID `9d0163ee-c0a2-4e83-ae79-a2a9cf1ec662`. A second record in Support was excluded by the employee's current-user-group view. |

## Publication, migration and authorization evidence

1. A record used Quantity as the input for a multiplication formula. Renaming Quantity to Units preserved the UUID. Updating Units to `4` still produced `8`.
2. Changing Units from number to text and then trying to delete it each returned HTTP 409. The response identified the calculation's `formula` dependency and a saved view's `view-aggregate` dependency. After removing both dependencies and selecting the explicit compatible migration, publication returned HTTP 201 with `migrated: 1` and `failed: 0`.
3. In a separate fixture, converting Cost to number returned 409 for record `1`, with original value `"bad"` and reason `"incompatible value"`. Retrying with `{"migration":{"incompatible":"clear-optional"}}` returned 201. The stored migration report retained the offending value and reason, and the record kept its unrelated deactivated choice.
4. Publication reported `workflow` and `lookup` as the two Gate 2 dependencies skipped. Record and field ACL checks applied to reads of affected values. An ordinary read returned no deleted fields. The archived-field route and inclusive history export required the independent grant.
5. Condition preview selected one candidate visible to the administrator. For that candidate, the target user could read and edit, and could not read the restricted field. The formal list and aggregate also returned one record. A separate condition matched one candidate and granted the target zero reads.

Publication preserves field snapshots and applies an explicitly selected data migration in the same transaction as the published pointer, history and uniqueness changes. The migration strategies are rejecting incompatible values or clearing incompatible optional values with a report. Type changes involving attachment storage or existing auto-number sequences use a replacement field. The rollback endpoint restores the previous compatible layout and saved views as a new publication. It preserves record data and ACLs.

## Worker evidence

The scheduled maintenance process shares the persistent attachment volume with the API. Default retention is 720 hours for deleted files and 24 hours for interrupted uploads, with a 60-second polling interval. The acceptance stack used a longer interval while running the serial fixtures.

The integration test and a separate `worker.js --once` smoke run each reported the following result. The smoke check verified that both metadata rows were `DELETED` with `purged_at` set and both storage directories were empty.

```text
expiredTemporary: 1
purgedDeleted:    1
failed:           0
```

The runtime Index Manager declared an Amount sort index with reason `Sort invoices by amount`. The worker's preflight reported record `1` with `bad-number` and marked the job `failed`. After repair to `20` and retry, the worker created `sb_runtime_cffd7e83d2da2f37d7fcd2ba3d8dd3c1` at 16,384 bytes and marked it `available`. PostgreSQL's definition used `::numeric`; an RLS-scoped execution plan used that index and ordered `20` ahead of `100`. PostgreSQL recorded last use at `2026-11-21 16:15:51.833373+00`. Field deletion queued retirement and publication passed after the physical index was removed. The registry retained the retirement and last-use timestamps.

Index DDL uses a worker-only table-owner connection and the independent job registry. The API uses the runtime role. Strong uniqueness continues through the transactional `record_unique_values` table. [PostgreSQL 16 concurrent index documentation](https://www.postgresql.org/docs/16/sql-createindex.html)

## Export and 100,000-record search

The search ZIP fixture produced one visible search hit, one CSV row and one 27-byte PDF. The manifest SHA-256 `56062753162b285433dda21d16d54bf91f09965b95f16063d174490de586429b` matched the unzipped bytes. A matching unauthorized record and a visible nonmatching record were excluded.

The benchmark reused the baseline fixture and measurement method with the final implementation. Each mode ran five warmups and measured 40 sequential searches. Access rules made 80,000 of the 100,000 synthetic records visible. Direct tests against deliberately hidden full numbers and suffixes returned zero hits, and the restricted predicate field was absent from results.

| Mode | Browser P95 | Database round-trip P95 | 500 ms browser target |
| --- | ---: | ---: | --- |
| Full phone | 52.56 ms | 1.33 ms | Met |
| Four-digit suffix | 54.38 ms | 1.47 ms | Met |

A representative suffix plan used `record_search_values_prefix_idx` with a bounded range from `1800` to `1801`. It returned ten rows in 0.320 ms. These measurements describe the local synthetic workload.

## Remaining verification and boundaries

- **Physical-device mobile verification** remains the human verification item. Keyboard obstruction, the operating-system date/time pickers and physical camera capture still need a device pass.
- No contract conflict blocked a requested GF item. The first administrator still uses trusted provisioning. With workflow deferred to Gate 2, directory disablement lists created, undeleted records that require handoff. The directory UI exposes the blocker.
- The earlier report also tracked browser application lifecycle/copy, remaining general app settings controls, a structured CSV column-mapping UI and browser token management. Those surfaces were outside the prioritized GF list. The existing REST operations and CSV mapping input remain available.
- Administrator TOTP is an account enrollment setting. Enrolled administrators use an authenticator code or a recovery code at login. The browser supports entering the enrollment key in an authenticator. The test exercised session revocation on enrollment and disablement. [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)

The local run verified the implementation before publication. Hosted CI for the branch push is outside this report's verification window.
