"""Apply SQL migrations from ``backend/migrations`` to the configured database.

Usage: ``python -m app.migrate`` (uses ``DATABASE_URL`` or ``DB_*``). Each ``NNNN_name.sql`` file runs once, inside a transaction,
with ``search_path`` set to the app schema. Applied versions are recorded in
``<schema>.schema_migrations``. A session-level advisory lock keeps concurrent
runs from racing.
"""

from __future__ import annotations

import asyncio
import pathlib
import re
import sys

from app.db import DatabaseConfig, DatabaseConfigError, load_db_config
from app.player_positions import COORDINATE_VERSION

MIGRATIONS_DIR = pathlib.Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_FILE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
ADVISORY_LOCK_KEY = 0x5041_5254  # "PART"


class SchemaCompatibilityError(RuntimeError):
    """The database migration history does not match this application build."""


def list_migrations(directory: pathlib.Path = MIGRATIONS_DIR) -> list[tuple[int, pathlib.Path]]:
    found: list[tuple[int, pathlib.Path]] = []
    for path in sorted(directory.glob("*.sql")):
        match = MIGRATION_FILE.match(path.name)
        if not match:
            raise ValueError(f"Migration file name must look like 0001_name.sql: {path.name}")
        found.append((int(match.group(1)), path))
    versions = [version for version, _ in found]
    if len(set(versions)) != len(versions):
        raise ValueError("Duplicate migration version numbers")
    return found


def expected_migrations(directory: pathlib.Path = MIGRATIONS_DIR) -> dict[int, str]:
    return {version: path.stem for version, path in list_migrations(directory)}


def assert_compatible_migrations(applied_rows, directory: pathlib.Path = MIGRATIONS_DIR) -> None:
    expected = expected_migrations(directory)
    applied = {int(row["version"]): row["name"] for row in applied_rows}
    if applied != expected:
        missing = sorted(set(expected) - set(applied))
        unexpected = sorted(set(applied) - set(expected))
        renamed = sorted(version for version in set(expected) & set(applied) if expected[version] != applied[version])
        details = []
        if missing:
            details.append(f"missing versions {missing}")
        if unexpected:
            details.append(f"unexpected versions {unexpected}")
        if renamed:
            details.append(
                "name conflicts "
                + ", ".join(f"{version}: expected {expected[version]}, found {applied[version]}" for version in renamed)
            )
        raise SchemaCompatibilityError("schema migration contract mismatch: " + "; ".join(details))


async def assert_pool_schema_compatible(pool, directory: pathlib.Path = MIGRATIONS_DIR) -> None:
    """Validate the immutable schema contract once during application startup."""
    async with pool.acquire() as connection:
        rows = await connection.fetch("SELECT version, name FROM schema_migrations ORDER BY version")
        assert_compatible_migrations(rows, directory)
        await assert_coordinate_contract(connection)


async def assert_coordinate_contract(connection) -> None:
    """Require the stored coordinate version to match the model in this image."""
    expected = COORDINATE_VERSION
    actual = await connection.fetchval("SELECT value FROM schema_contract WHERE key='coordinate_version'")
    if actual != expected:
        raise SchemaCompatibilityError(f"coordinate contract mismatch: expected version {expected}, found {actual}")


async def run_migrations(config: DatabaseConfig, directory: pathlib.Path = MIGRATIONS_DIR, *, log=print) -> list[int]:
    import asyncpg

    schema = config.schema
    applied_now: list[int] = []
    connection = await asyncpg.connect(config.dsn)
    try:
        await connection.execute("SELECT pg_advisory_lock($1)", ADVISORY_LOCK_KEY)
        await connection.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        await connection.execute(f'SET search_path TO "{schema}"')
        await connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    integer PRIMARY KEY,
                name       text NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        rows = await connection.fetch("SELECT version, name FROM schema_migrations ORDER BY version")
        expected = expected_migrations(directory)
        applied = {int(row["version"]): row["name"] for row in rows}
        conflicts = {version: name for version, name in applied.items() if expected.get(version) != name}
        if conflicts:
            raise SchemaCompatibilityError("database contains an unknown or conflicting migration history")
        if list(applied) != list(expected)[: len(applied)]:
            raise SchemaCompatibilityError("database migration history is not a contiguous application prefix")
        for version, path in list_migrations(directory):
            if version in applied:
                continue
            log(f"applying {path.name}")
            async with connection.transaction():
                await connection.execute(path.read_text(encoding="utf-8"))
                await connection.execute(
                    "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", version, path.stem
                )
            applied_now.append(version)
        rows = await connection.fetch("SELECT version, name FROM schema_migrations ORDER BY version")
        assert_compatible_migrations(rows, directory)
        await assert_coordinate_contract(connection)
        await connection.execute("SELECT pg_advisory_unlock($1)", ADVISORY_LOCK_KEY)
    finally:
        await connection.close()
    return applied_now


def main() -> int:
    try:
        config = load_db_config()
    except DatabaseConfigError as exc:
        print(f"{exc}; set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD for a database connection.", file=sys.stderr)
        return 2
    applied = asyncio.run(run_migrations(config))
    print(f"schema {config.schema}: {len(applied)} migration(s) applied, up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
