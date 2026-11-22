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

- Added SSRF-safe kintone domain validation and a source adapter for app,
  fields, layout, settings, ACL, records cursor, comments and attachments.
- Added explicit four-state field compatibility analysis and source-unavailable
  evidence. Unsupported and blocked dependencies are not silently downgraded.
- The kintone CLI creates a report rather than a false full-success result.
  It requires `KINTONE_FREEZE_WINDOW_CONFIRMED=true` and an allowlisted HTTPS
  source domain.
- Subtable row identities and attachment SHA-256 extraction are represented,
  with source row/record/table evidence.
- Record cursor pagination now uses the kintone cursor POST contract, cursor
  deletion uses the supported DELETE contract, and subtable target row IDs are
  deterministic from source app/record/table/row identity.
- The extract CLI writes a secret-free checkpoint summary containing counts and
  source availability state, while each detailed report is written separately.
- With `KINTONE_BUILD_M1_PACKAGE=true`, the CLI seals a M1 1.0-compatible zip
  only after frozen-snapshot and all source/field/dependency gates pass.
  `verifyPackage` must report zero problems before the CLI returns pending
  activation; failed generation is retained as a blocked task, never success.
- M3 does not yet claim final M1 activation. M1 package production, real
  kintone credential/permission execution and the complex real-app acceptance
  drill require source credentials and an isolated target application.

## Acceptance evidence

- Targeted backup CLI tests: 4/4 pass, including the P2 backup alert case.
- P2 kintone source safety/mapping test: pass.
- API and DB builds/typechecks pass.
- Integrated Docker/PostgreSQL suite: `96/96` pass.
- Migration `0034_gate2_system_notifications.sql` is registered in
  `meta/_journal.json` and applied in the local integration database.
- A post-migration OpenAPI contract regression was found and fixed for
  `/notifications/system/deliver`; the full suite passed after the fix.

## Explicit degradations and unavailable items

- Stand-in notification: database unavailable can delay in-app delivery; local
  `alerts.jsonl` and `system-alert-outbox.jsonl` remain the disaster evidence.
- M3 real source freeze, permissions, formula equivalence, identity mapping,
  workflow history and cross-app lookup activation remain administrator-
  resolved or blocked.
- P2 category tree remains unsupported and blocks activation rather than using
  dropdown downgrade.
- Demo host scheduling remains inactive pending the root-only unit installation
  above; the existing demo backup set was verified and exercised only in a
  local isolated restore target.
- Real kintone migration and restore drills are not verified.

## Not done

- M2, category tree, group concurrent approval, encrypted/signed packages,
  real mobile verification, online sync, generic task/event platforms,
  email/Slack/webhook channels and product scheduling.
