# SuzuBase

SuzuBase B0 is a development skeleton for tenant-scoped applications and records.

## Local development

Use Node.js 24, the pnpm version pinned in `package.json`, and Docker Compose. For the initial build or after code changes, run `docker compose up -d --build`. Subsequent starts can use `docker compose up -d`. Compose runs the Drizzle migrations before starting the API.

| Endpoint | URL |
| --- | --- |
| Web homepage | http://127.0.0.1:5173 |
| API health | http://127.0.0.1:3000/health |
| Swagger UI | http://127.0.0.1:3000/docs |
| OpenAPI JSON | http://127.0.0.1:3000/docs-json |

To create an isolated local development account with permission to create apps, run the same provisioning helper used by integration tests.

```sh
docker compose run --rm migrate node -e 'require("./packages/db/test/support.cjs").provision().then(({ email, password }) => console.log({ email, password })).catch(error => { console.error(error); process.exitCode = 1; })'
```

Use those credentials with `POST /auth/login`, then send the returned session token as `Authorization: Bearer <token>`. The API generates a new session signing key at startup unless `SESSION_SECRET` is provided, so default development sessions expire on restart. Create an app, add optional text or number fields to its draft, and publish. Use the returned field IDs as keys in the record's `data` object. Supply numbers as decimal strings. Record updates replace `data` and require the last read `revision`.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm -r build
pnpm -r typecheck
SUZUBASE_SYSTEM_NOTIFICATION_SECRET=p2-t2-integration-secret export SUZUBASE_SYSTEM_NOTIFICATION_SECRET="$(openssl rand -hex 32)"
API_PORT=13000 WEB_PORT=15173 docker compose -p suzubase-ci up -d --build --wait
docker compose -p suzubase-ci run --rm migrate pnpm test
docker compose -p suzubase-ci down
```

The integration suite provisions test tenants and creates a temporary database to verify the empty-database migration. The separate Compose project keeps test fixtures out of the development database. Its volume persists across test runs. The checked-in schema and migration CLI support forward migration. Restoring a prior backup is required to reverse the foundation migrations after recording data.
