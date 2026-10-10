# Party Conquest backend

Quart/Hypercorn with PostgreSQL-backed accounts, game state, and realtime world
transport. See [the starter README](../README.md) for local setup and hosting.

Use `DATABASE_URL` or explicit `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USER`,
`DB_PASSWORD`, and `DB_SSLMODE`. `DATABASE_URL` takes precedence; `DB_SCHEMA`
defaults to `party_conquest`. No AWS credential or secret lookup occurs.

`../scripts/dev.sh` installs a virtual environment and starts the complete stack.
`run-local.sh [all|migrate|serve]` runs backend components only, using an explicit
connection. `all` applies migrations then serves; `serve` does not migrate.

`python -m app.migrate` applies numbered migrations with an advisory lock and
verifies the schema contract. The backend must use the same database/schema.
Run one backend process: the default exclusive world owner holds a PostgreSQL
advisory lock and runs continuous simulation loops. WebSockets carry updates.

`/healthz` reports liveness; `/readyz` checks database, schema, and world ownership.
`CORS_ORIGINS` is a comma-separated origin list (default `*`). `APP_VERSION` sets
the reported version. `APP_ENV=development` with `ENABLE_TEST_RESOLVER=true` enables
the local Dev tools; hosted runs should use `APP_ENV=production`.

Run `.venv/bin/python -m pytest -q`. Database integration tests need an explicitly
provided, disposable `TEST_DATABASE_URL`; do not use your saved game database.
