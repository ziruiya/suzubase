# SuzuBase deployment backup / restore tool

`tools/backup/suzubase-backup.mjs` is the deployment-level backup tool
(contracts ch.5 §5.3, Gate 3 G3-13, decision 9). It is a CLI tool by design;
there is no backup management UI (registered for P2 together with scheduled
backups, M4).

## Commands

```
node tools/backup/suzubase-backup.mjs create [--name <label>]
node tools/backup/suzubase-backup.mjs verify <backup-set-dir>
node tools/backup/suzubase-backup.mjs restore <backup-set-dir>
node tools/backup/suzubase-backup.mjs list
```

A backup set is one directory holding a PostgreSQL-native database dump
(`pg_dump` custom format — never a file copy of a live database), a copy of
the attachment directory, copies of the deployment config files, and a
`manifest.json` with the application/database versions and a SHA-256 hash
per file. Integrity is verified automatically right after creation
(readability + hashes), and again before every restore.

Restore refuses, explicitly and before touching anything, when the backup
set's application-version / database-migration combination is not supported
by this deployment (for example a backup taken from a newer database than
the target deployment runs).

## Boundary — read this first

- **An M1 single-application package is not a disaster backup.** It is the
  migration/inheritance tool of the Import/Export feature.
- **A deployment backup set is not a migration tool.** It restores one whole
  deployment (database + attachments + config); it does not move a single
  application between deployments.
- Neither substitutes for the other (contracts §5.3.1).

Backup sets contain complete business data and are labelled
**sensitive data** in the manifest and in `list` output. Store and transfer
them as sensitive data.

## Configuration (deployment config values)

| Variable | Meaning | Default |
|---|---|---|
| `SUZUBASE_BACKUP_DIR` | where backup sets live | `./backups` |
| `SUZUBASE_BACKUP_RETENTION` | sets kept after a successful `create` | `7` |
| `SUZUBASE_BACKUP_LOG` | deployment log file | `<backup dir>/backup.log` |
| `ADMIN_DATABASE_URL` | admin DB connection for `pg_dump`/`pg_restore` (direct mode) | — |
| `ATTACHMENT_DIRECTORY` | attachment root (direct mode) | — |
| `SUZUBASE_CONFIG_FILES` | comma-separated config files included in each set | — |
| `SUZUBASE_APP_VERSION` | application version stamped into the manifest | `unknown` |
| `SUZUBASE_HEALTH_URL` | health endpoint checked after a restore | — |
| `SUZUBASE_POST_RESTORE_SQL_CMD` | command template receiving `{file}` = `tools/backup/post-restore-normalize.sql`; **required after every restore** | — |

### Post-restore ownership normalization (required step)

`pg_restore` recreates objects owned by the restoring (bootstrap/admin)
role, while a fresh deployment's objects belong to the least-privilege
migration role (`suzubase_migration`) that the migrator connects as. Without
normalization the restored deployment cannot apply migrations
(`permission denied for schema drizzle`, SQLSTATE 42501).
`suzubase-backup restore` runs `tools/backup/post-restore-normalize.sql`
whenever `SUZUBASE_POST_RESTORE_SQL_CMD` is set — direct mode:
`psql "$ADMIN_DATABASE_URL" -f {file}`; container mode:
`docker exec -i <postgres-container> psql -U suzubase -d suzubase < {file}` —
handing schemas, tables, views, sequences, functions and enum types in the
application schemas back to the migration role. Run restores with the
application stack stopped, then start it.
| `SUZUBASE_PG_DUMP_CMD` / `SUZUBASE_PG_RESTORE_CMD` / `SUZUBASE_PGSQL_CMD` | command templates for containerised deployments, e.g. `docker exec -i <postgres-container> pg_dump -U suzubase -d suzubase -Fc` | — |
| `SUZUBASE_ATTACH_EXPORT_CMD` / `SUZUBASE_ATTACH_IMPORT_CMD` | command templates copying attachments out of / into the running deployment (`{dir}` = staging directory) | — |

## Failure behaviour (never silent)

Any create/verify/restore failure does all three of:

1. exits with a non-zero exit code,
2. appends the reason to the deployment log (`SUZUBASE_BACKUP_LOG`),
3. appends an admin alert record addressed to tenant administrators to
   `<backup dir>/alerts.jsonl` (the deployment tooling alert outbox; the
   deployment operator surfaces these lines to tenant administrators — the
   product's in-app notification stream is record-event based and has no
   generic deployment-alert channel in P1, which is registered as a gap in
   the Gate 3 report).

Scheduled automatic backups (M4) are P2; this tool is manual + drill-driven.
