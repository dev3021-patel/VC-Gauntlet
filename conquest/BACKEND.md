# Party Conquest backend: where it is and how to use it

The backend is a [Quart](https://quart.palletsprojects.com/) service in
[`backend/`](backend/). It provides player accounts plus durable,
server-authoritative world-event ordering, replay, and WebSocket fan-out.
Gameplay rules remain separate.

## Local services

Run `./scripts/dev.sh` to start PostgreSQL, migrations, backend, and frontend.
The backend defaults to `http://localhost:8000`; `/healthz` is liveness and
`/readyz` checks database, schema, and world ownership. `APP_VERSION` sets the
reported version (default `dev`). No hosted infrastructure is included.

## Player accounts

| Method | Path | Body / header | Response |
|---|---|---|---|
| `POST` | `/players/register` | `{"name","pin","avatar"}` | `201 {"token","player"}`; `400` invalid; `409 name-taken` |
| `POST` | `/players/login` | `{"name","pin"}` | `200 {"token","player"}`; `401 invalid-credentials`; `429 locked` after 5 bad PINs (1 minute) |
| `GET` | `/players/me` | `Authorization: Bearer <token>` | `200 {"player"}`; `401` |
| `POST` | `/players/logout` | `Authorization: Bearer <token>` | `204` |

Names are trimmed and matched case-insensitively. PINs are stored as salted
PBKDF2 hashes and never returned. Errors are `{"error": <code>, "message": <text>}`.

**Persistence.** Both startup and migrations use explicit `DATABASE_URL` or `DB_*`
configuration. There is no AWS or shared production database lookup.

## Shared-world transport v1

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/worlds/{worldId}/commands` | Validate and submit a versioned command envelope |
| `GET` | `/v1/worlds/{worldId}/snapshot` | Load transport state at a consistent revision |
| `WS` | `/v1/worlds/{worldId}/events?after={revision}` | Replay retained events, then continue live |

Commands contain `protocolVersion`, `schemaVersion`, `worldId`, a unique
`commandId`, `actionType`, and opaque object `payload`. Identical command
retries return the original outcome; conflicting ID reuse returns
`idempotency_conflict`. Production rejects unsupported actions until gameplay
resolvers are added. A valid bearer token, when supplied, becomes trusted actor
context; player IDs inside payloads are never trusted.

The stream sends retained events in revision order, then a `ready` envelope.
Consumers deduplicate by world and revision. `stale_cursor` and
`resync_required` require a fresh snapshot. Application heartbeats, bounded
per-client queues, and capped browser reconnect backoff prevent dead or slow
connections from accumulating resources.

Startup and environment details live in
[`backend/README.md`](backend/README.md).

## How the frontend reaches it

[`src/backend.ts`](src/backend.ts) picks the base URL once at build time:

| Situation | Base URL |
|---|---|
| `VITE_BACKEND_URL` is set | that value |
| `npm run dev` (Vite dev server) | `http://localhost:8000` |
| `npm run build` (production bundle) | `http://localhost:8000` |

Use `backendUrl('/path')` rather than hard-coding hosts. The world badge in the
top-right corner shows synchronization state and the last applied revision.

To point a frontend at a backend you host:

```bash
VITE_BACKEND_URL=https://your-backend.example npm run build
```

The backend sends CORS headers (any origin by default; restrict with the
`CORS_ORIGINS` environment variable), so browsers on `localhost` or
your frontend can call it directly.

## Run the backend locally

Requires Python 3.12+.

```bash
export DATABASE_URL='postgresql://party@127.0.0.1:55432/postgres?sslmode=disable'
backend/run-local.sh
```

Then in another terminal:

```bash
curl http://localhost:8000/healthz
npm run dev            # frontend now talks to http://localhost:8000
```

The `serve` mode skips migrations and uses the existing team-local schema.
For Party, start both local services using the exact supervised command in
[the Preview guide](.party/preview.md) or [LOCAL.md](LOCAL.md). They use team-local
accounts and world data. There is no Redis configuration; PostgreSQL
LISTEN/NOTIFY supplies real-time synchronization. Test resolver commands and
database-mutating tests belong only on disposable test databases.

Environment variables the backend reads:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` (container) | Listen port |
| `APP_VERSION` | `dev` | Reported by `/healthz`; the image bakes in the git sha |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |
| `DB_SCHEMA` | `party_conquest` | Schema that owns all Party Conquest tables |
| `DATABASE_URL` | unset | Explicit PostgreSQL connection, used by startup and migrations |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`, `DB_PASSWORD`, `DB_SSLMODE` | unset / `5432` / `postgres` / `require` | Explicit PostgreSQL connection |
| `PLAYER_STORE_PATH` | unset | Memory-store fallback only: JSON file mirrored across restarts |
| `WORLD_EVENT_RETENTION` | `10000` | Maximum retained events per world |
| `WORLD_STREAM_QUEUE_SIZE` | `256` | Maximum queued events per stream |
| `APP_ENV` | `production` | Prevents test resolver use in production |
| `ENABLE_TEST_RESOLVER` | unset | Enables `transport.test` outside production |
