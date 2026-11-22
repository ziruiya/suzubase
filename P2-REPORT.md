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

- Added systemd service/timer and watchdog service/timer files as the only
  formal scheduling implementation.
- The scheduled service reuses `suzubase-backup.mjs create`, uses `flock` anti-
  reentry, and has a 2-hour timeout.
- Backup CLI status now preserves recent success and failure timestamps.
- The watchdog detects missing status or a success older than 26 hours and uses
  the existing failure-alert path.
- Deployment host OS/scheduler access was not available from this worktree, so
  `suzubase.suzu.life` host capability could not be independently confirmed.
  The systemd units are therefore implementation-ready but deployment
  activation and real-host verification remain explicitly pending.
- No real production restore drill was performed in this batch. The existing
  backup/restore implementation and local tests remain, but database/attachment/
  configuration real-host verification is pending because no isolated target
  environment or production credentials were available.

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

- Targeted backup tests: 3/3 pass.
- P2 backup alert persistence test: pass.
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
- Real deployment host OS, systemd availability and `suzubase.suzu.life`
  activation are not verified.
- Real kintone migration and restore drills are not verified.

## Not done

- M2, category tree, group concurrent approval, encrypted/signed packages,
  real mobile verification, online sync, generic task/event platforms,
  email/Slack/webhook channels and product scheduling.
