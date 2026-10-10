# Party Conquest — hackathon starter

A React/Vite game frontend and a Python Quart backend backed by PostgreSQL.
Each team runs its own game and database. Redis and AWS credentials are not
required. This copy has no upstream Git remote or AWS infrastructure.
The original CI/CD is removed; an optional Railway workflow template is included.

## Start everything locally

Requires Python 3.12+, Node.js 22.12+ (or a newer supported release), and either
PostgreSQL server binaries or Docker Compose. On macOS, `brew install postgresql@18`
installs PostgreSQL; add its `bin` directory to PATH. In a Linux Party session,
install the server with `sudo apt-get update && sudo apt-get install -y postgresql`
(omit `sudo` when already root). The launcher finds Debian/Ubuntu server binaries
under `/usr/lib/postgresql/*/bin`. No system PostgreSQL service is needed.

From this directory:

```bash
./scripts/dev.sh
```

The launcher installs dependencies, initializes a local database, applies all
migrations, starts the backend, checks readiness, and starts Vite. Open
**http://127.0.0.1:5173**. Create a name-and-PIN account in the game.

The frontend proxies HTTP and WebSocket `/api` requests to the backend, so the
same URL works through Party Preview. For the port allocated to your session:

```bash
PREVIEW_PORT=3000 VITE_HMR_CLIENT_PORT=443 ./scripts/dev.sh
```

Replace `3000` with the allocated port. Only set `VITE_HMR_CLIENT_PORT=443` when
the Preview tunnel uses HTTPS; leave it unset for direct localhost access.
`DEV_HOST=0.0.0.0` exposes Vite on container interfaces if the Preview setup
requires it. Keep the database and backend on loopback.

By default, native PostgreSQL uses `.local/postgres/` and port **55432**;
the backend uses **8000**. Override with `LOCAL_DB_PORT`, `BACKEND_PORT`, and
`PREVIEW_PORT` (or `FRONTEND_PORT`). Ctrl+C stops Vite, the backend, and native
PostgreSQL started by the launcher. Database files are retained between runs.
The native development database uses trust authentication on loopback only.

If native server binaries are unavailable, the launcher uses Docker Compose.
To select it explicitly:

```bash
LOCAL_DB_MODE=docker ./scripts/dev.sh
# Stop Docker PostgreSQL when finished; the volume retains your data:
docker compose down
```

Docker uses a persistent volume and a development-only password. Each team must
use its own database. Run one launcher per directory/database; the game backend
is a single long-running process that owns its live simulation.

## Use an existing local or hosted PostgreSQL database

An explicit URL bypasses both native and Docker database setup:

```bash
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require' ./scripts/dev.sh
```

For local PostgreSQL without TLS, use `sslmode=disable`. Set `DB_SCHEMA` to choose
a schema (default `party_conquest`). Startup applies migrations to this database;
use a database owned by your team, not the original game's production database.
Environment variables are read from the process; `.env` files are not sourced by
the backend or launcher. Keep credentials out of source control.

To run only the backend, with `DATABASE_URL` exported:

```bash
backend/run-local.sh migrate
backend/run-local.sh serve
```

The game state, accounts, avatars, and world events are stored in PostgreSQL.
No seed data or production dump is necessary; migrations initialize a fresh game.

## Verify changes

```bash
npm test
npm run build
cd backend
.venv/bin/python -m pytest -q
```

Some backend tests require `TEST_DATABASE_URL` and skip when it is unset. Those
tests truncate or drop their test state. Give them a **separate disposable test
database**, never the database holding your game. Apply migrations to its public
schema first, as described in `.party/testing.md`.

## Publish your team's game on Railway

See [railway.md](railway.md) for automatic deployment from `main`, your public
game URL, and troubleshooting. Optional manual deployment requires a project
token supplied securely outside the Party Profile. Project provisioning and
token creation are documented separately in
[railway-organizer.md](railway-organizer.md) for organizers.

## Starter provenance

Copied from Party Conquest revision `6e8f78c8b65b5c2f540952e0d7ae0e99c15a6dbc`.
The source repository's Git metadata, AWS infrastructure, deployment scripts,
GitHub workflows, production API defaults, and cloud credential loading were
removed. Game assets, gameplay, migrations, and relevant tests were retained.

## Your team's published game

[Play Conquest](https://frontend-production-b94c.up.railway.app)
