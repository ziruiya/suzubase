# SuzuBase B0 acceptance report

Branch `b0-skeleton` · 2026-11-21 · Node 24.14.1 · pnpm 12.21.0 · PostgreSQL 16

## Deliverable status

| Item | Verified locally | Partial or missing |
| --- | --- | --- |
| B0-01 | Frozen workspace install, recursive build and typecheck | None |
| B0-02 | Compose starts PostgreSQL, runs migrations, and serves the API and web. Health returns 200 with DB connectivity. | None |
| B0-03 | Five Drizzle migrations apply from an empty database. Records use fixed system columns, JSONB, a per-app BIGINT counter and tenant-bearing foreign keys. | None |
| B0-04 | Runtime role has RLS, no ownership or BYPASSRLS, and transaction-local context. Tests cover missing context, successive tenant contexts and rollback. | None |
| B0-05 | Password hashes, signed sessions, separate tenant membership and creator-based effective permissions. App creation requires an explicit member grant. | The B0 authorization stub covers the creator rule. Full ACL and the permission-preview endpoint are P1 work. |
| B0-06 | Optional text and number fields go through an explicit additive draft publish. Records retain their original schema version. JSONB round-trips immutable field IDs and normalized decimal strings. | The B0 schema editor supports additions only. |
| B0-07 | Duplicate creates replay the original response. A stale update returns 409 and the current record. Record, history and outbox writes roll back together. | Outbox consumption is outside B0. |
| B0-08 | 11 integration tests pass locally. GitHub Actions is configured for build, typecheck and the same suite on an Ubuntu hosted runner. | Hosted execution remains unverified because the branch is local. |

## 1. Compose startup and health

Fresh acceptance project output from `docker compose -p suzubase-b0-acceptance up -d --build --wait`, using ports 23000 and 25173. The default project also passed `docker compose up -d --build` and a subsequent `docker compose up -d`.

```text
Volume suzubase-b0-acceptance_postgres-data Creating
Volume suzubase-b0-acceptance_postgres-data Creating
Volume suzubase-b0-acceptance_postgres-data Created
Volume suzubase-b0-acceptance_postgres-data Created
Container suzubase-b0-acceptance-web-1 Creating
Container suzubase-b0-acceptance-postgres-1 Creating
Container suzubase-b0-acceptance-postgres-1 Created
Container suzubase-b0-acceptance-migrate-1 Creating
Container suzubase-b0-acceptance-web-1 Created
Container suzubase-b0-acceptance-migrate-1 Created
Container suzubase-b0-acceptance-api-1 Creating
Container suzubase-b0-acceptance-api-1 Created
Container suzubase-b0-acceptance-web-1 Starting
Container suzubase-b0-acceptance-postgres-1 Starting
Container suzubase-b0-acceptance-web-1 Started
Container suzubase-b0-acceptance-postgres-1 Started
Container suzubase-b0-acceptance-postgres-1 Waiting
Container suzubase-b0-acceptance-postgres-1 Healthy
Container suzubase-b0-acceptance-migrate-1 Starting
Container suzubase-b0-acceptance-migrate-1 Started
Container suzubase-b0-acceptance-migrate-1 Waiting
Container suzubase-b0-acceptance-migrate-1 Exited
Container suzubase-b0-acceptance-api-1 Starting
Container suzubase-b0-acceptance-api-1 Started
Container suzubase-b0-acceptance-postgres-1 Waiting
Container suzubase-b0-acceptance-migrate-1 Waiting
Container suzubase-b0-acceptance-api-1 Waiting
Container suzubase-b0-acceptance-web-1 Waiting
Container suzubase-b0-acceptance-postgres-1 Healthy
Container suzubase-b0-acceptance-web-1 Healthy
Container suzubase-b0-acceptance-migrate-1 Exited
Container suzubase-b0-acceptance-api-1 Healthy
```

Default-port `GET http://127.0.0.1:3000/health` response

```http
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
content-length: 38
Date: Sat, 21 Nov 2026 12:53:04 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"status":"ok","database":"connected"}
```

The web homepage served `<title>SuzuBase</title>` on port 5173. The acceptance API served OpenAPI 3.0.0 with eight paths and the `Idempotency-Key` header.

## 2. Empty-database migrations

```text
migrate-1  | $ node dist/migrate.js
migrate-1  | Applying Drizzle migrations to suzubase as suzubase_migration
migrate-1  | Drizzle migrations complete (5 applied in total)
```

The automated test also created a separate database from `template0`, asserted that `records` was absent before migration, and reran the migrator.

```text
ℹ Run 1 on empty database
Applying Drizzle migrations to suzubase_empty_ede7b2150481 as suzubase_migration
Drizzle migrations complete (5 applied in total)
ℹ Run 2 on migrated database
Applying Drizzle migrations to suzubase_empty_ede7b2150481 as suzubase_migration
Drizzle migrations complete (5 applied in total)
```

## 3. Two-tenant isolation

The fixtures created one record in each tenant under the same app code. Both records received number 1 from their own app counter.

```text
▶ two tenants with the same app code remain isolated on all three requested paths
  ✔ API denies tenant A access to tenant B’s record (39.795334ms)
  ℹ A → own record 200. B → own record 200. A → B app/record 404, including with supplied tenant hints.
  ✔ tenant-scoped DB query sees A’s row only, even without a tenant predicate (11.041584ms)
  ℹ A-scoped SELECT id FROM records (no WHERE clause) → one row for A, zero rows for B.
  ✔ composite foreign key rejects a cross-tenant record reference (7.376833ms)
  ℹ A → B reference rejected by record_references_target_fk (SQLSTATE 23503). A → A reference committed.
✔ two tenants with the same app code remain isolated on all three requested paths (674.003834ms)
```

## 4. Field-ID JSONB round trip

The create request returned HTTP 201. Reading the same record returned HTTP 200 with the same data and revision.

```http
POST /apps/6288ced9-e9d7-42a6-805c-e0f29f94ce23/records
Content-Type: application/json

{
  "data": {
    "e4860559-0e67-4a0b-a3b7-b276b41f0a3c": "Invoice 7",
    "48c9d75a-6e83-4dd8-8ce3-e00c0e608a44": "+000123.45000"
  }
}
```

```http
GET /apps/6288ced9-e9d7-42a6-805c-e0f29f94ce23/records/eff1361f-57c5-4170-89db-7f0478732391

HTTP/1.1 200 OK
Content-Type: application/json

{
  "id": "eff1361f-57c5-4170-89db-7f0478732391",
  "appId": "6288ced9-e9d7-42a6-805c-e0f29f94ce23",
  "recordNo": "1",
  "data": {
    "48c9d75a-6e83-4dd8-8ce3-e00c0e608a44": "123.45",
    "e4860559-0e67-4a0b-a3b7-b276b41f0a3c": "Invoice 7"
  },
  "schemaVersion": 2,
  "revision": 1,
  "status": "active",
  "createdBy": "6b367c50-8259-410a-90c6-86095ae1420d",
  "createdAt": "2026-11-21 12:52:51.881162+00",
  "updatedBy": "6b367c50-8259-410a-90c6-86095ae1420d",
  "updatedAt": "2026-11-21 12:52:51.881162+00"
}
```

## 5–6. Idempotency, optimistic locking and rollback

```text
✔ concurrent duplicate creates return the original result and allocate one number (677.866001ms)
ℹ 8 concurrent POSTs → 8 original 201 responses, 1 record, 1 number, 1 key, 1 history event, 1 outbox row
✔ one concurrent revision update wins and stale writes return the current record (465.461291ms)
ℹ Concurrent PUTs at revision 1 → 200 and 409 REVISION_CONFLICT. Current revision 2, exactly 2 history events and 2 outbox rows.
✔ outbox failure rolls back record creation and updates with their history (468.990459ms)
```

Key scope is tenant, user, app and record creation. Keys are retained until physical deletion of the record. The test also verified that the original response was replayed after an update and that a different app can use the same key.

## 7. Full verification

```text
apps/web build$ tsc --noEmit && vite build
packages/shared-types build$ tsc
packages/shared-types build: Done
packages/db build$ tsc
apps/web build: vite v7.3.8 building client environment for production...
apps/web build: transforming...
apps/web build: ✓ 26 modules transformed.
apps/web build: rendering chunks...
apps/web build: computing gzip size...
apps/web build: dist/index.html                  0.31 kB │ gzip:  0.23 kB
apps/web build: dist/assets/index-BFJUE4Hn.js  222.52 kB │ gzip: 69.29 kB
apps/web build: ✓ built in 515ms
apps/web build: Done
packages/db build: Done
apps/api build$ tsc
apps/api build: Done
apps/web typecheck$ tsc --noEmit
packages/shared-types typecheck$ tsc --noEmit
packages/shared-types typecheck: Done
packages/db typecheck$ tsc --noEmit
apps/web typecheck: Done
packages/db typecheck: Done
apps/api typecheck$ tsc --noEmit
apps/api typecheck: Done

✔ email and password authenticate independent tenant accounts and reject a supplied tenant ID (1851.564001ms)
✔ two tenants with the same app code remain isolated on all three requested paths (674.003834ms)
✔ all Drizzle migrations run from an empty PostgreSQL database and can be rerun (557.105709ms)
✔ published field IDs round-trip text and canonical decimal JSONB values (1176.008792ms)
✔ runtime role is isolated by transaction-local RLS (133.220126ms)
✔ concurrent duplicate creates return the original result and allocate one number (677.866001ms)
✔ one concurrent revision update wins and stale writes return the current record (465.461291ms)
✔ outbox failure rolls back record creation and updates with their history (468.990459ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1920.157001
```

## 8. Commits

```text
0c5cf1bc46bf1906486fe2263950d65c537e6402 B0-01 Bootstrap the pnpm workspace
e852378cb0a7cc13438aa3797861eee083d27cae B0-02 Add the Compose development stack and database health check
ba953f8eb8a5e8858c2b9d4ba2534841209456c4 B0-03 Define the tenant-aware schema and Drizzle migrations
9668711e5614d737040710ebadef8e0f5d87fe1c B0-04 Enforce transaction-local tenant scope and runtime RLS
452bc9ddd93cc8ac2be1463608c51fa04e937a60 B0-05 Authenticate tenant sessions and define creator-based authorization
1f07a59c486714070ae254a83bb88ea453a5548d B0-06 Publish additive field definitions and round-trip JSONB records
93491b428cc85736c00b0e8d75df06553cf89cd0 B0-07 Add idempotent creates and optimistic record updates
f50834f084fe38207ce908a04a3ced61409004a9 B0-08 Verify empty migrations and two-tenant isolation in hosted CI
```

`B0-REPORT.md` is committed as the final commit on `b0-skeleton`. Its SHA is available from `git rev-parse b0-skeleton`.

## Contract conflicts and blockers

No conflicts with `contracts-v1.md` required stopping a deliverable. The brief’s PR instruction was superseded by the explicit direction to keep the branch local.

There are no remaining local blockers. The following issues were resolved during verification.

- pnpm required a build-script allowlist. The workspace allows esbuild’s install script and disables Scarf’s script.
- Swagger UI initially failed to start because the Fastify static adapter dependency was absent. The final workspace installs the matching peer version.
- Drizzle Kit could not serialize a JavaScript BigInt default. The counter uses a typed SQL default of zero.
- The RLS fixture initially bound one ID parameter as both UUID and text. Explicit casts fixed the fixture while preserving the isolation assertions.
- The first authentication migration attempt lacked the generated authentication schema declaration. Exporting the schema and adding its creation before the credential table fixed the migration.
- The default API port was occupied by the development stack during isolated testing. The test projects used separate host ports.

Docker used the locally available `postgres:16-alpine` and `node:24-alpine` images. No Docker pull command ran. GitHub-hosted execution remains the only unverified environment.
