> Hackathon starter: use the team-local database and `scripts/dev.sh` described
> in the root README. Historical upstream deployment notes below do not apply.

# Testing the starter

Run `npm test`, `npm run build`, and `backend/.venv/bin/python -m pytest -q`
from `backend/` (or see the commands in the root README).

Integration tests only run when TEST_DATABASE_URL points to a separate disposable
PostgreSQL database. They may truncate public-schema tables and create/drop test
schemas. Do not use the database holding your game, or a shared production DB.
There are no automatic GitHub Actions workflows in this starter.

Before the full database suite, initialize its public schema (several inherited
transport fixtures expect public-schema tables). From `backend/`:

```bash
export TEST_DATABASE_URL='postgresql://USER:PASSWORD@HOST:PORT/DISPOSABLE_TEST_DB?sslmode=disable'
DATABASE_URL="$TEST_DATABASE_URL" DB_SCHEMA=public .venv/bin/python -m app.migrate
.venv/bin/python -m pytest -q
```

Use `sslmode=require` when your hosted test database requires TLS.
