"""Explicit PostgreSQL configuration, shared by migrations and backend startup.

DATABASE_URL takes precedence over DB_* variables. No implicit cloud credentials
or shared database are used. DB_SCHEMA defaults to party_conquest.
"""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass
from urllib.parse import quote

SCHEMA_NAME_PATTERN = re.compile(r"^[a-z_][a-z0-9_]*$")

DEFAULT_SCHEMA = "party_conquest"


class DatabaseConfigError(ValueError):
    """Database configuration is missing or invalid."""


class DatabaseConnectError(RuntimeError):
    """The process could not open or verify a Postgres connection."""


@dataclass(frozen=True)
class DatabaseConfig:
    dsn: str
    schema: str

    def __repr__(self) -> str:
        return f"DatabaseConfig(dsn=<redacted>, schema={self.schema!r})"

    @staticmethod
    def from_env(env=os.environ) -> DatabaseConfig | None:
        schema = env.get("DB_SCHEMA", DEFAULT_SCHEMA)
        url = env.get("DATABASE_URL", "").strip()
        if url:
            return _validated(DatabaseConfig(dsn=url, schema=schema))

        host = env.get("DB_HOST", "").strip()
        if not host:
            return None
        return _from_parts(
            host=host,
            port=env.get("DB_PORT", "5432"),
            database=env.get("DB_DATABASE", "postgres"),
            user=env.get("DB_USER", ""),
            password=env.get("DB_PASSWORD", ""),
            schema=schema,
            sslmode=env.get("DB_SSLMODE", "require"),
        )


def load_db_config(env=os.environ) -> DatabaseConfig:
    """Require an explicit DATABASE_URL or DB_* connection."""
    config = DatabaseConfig.from_env(env)
    if config is None:
        raise DatabaseConfigError("Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD before starting the backend")
    return config


def _validated(config: DatabaseConfig) -> DatabaseConfig:
    if not SCHEMA_NAME_PATTERN.match(config.schema):
        raise ValueError("DB_SCHEMA must be a lowercase identifier")
    return config


def _from_parts(
    *,
    host: str,
    port: str,
    database: str,
    user: str,
    password: str,
    schema: str,
    sslmode: str,
) -> DatabaseConfig:
    host = host.strip()
    port = (port or "5432").strip() or "5432"
    database = (database or "postgres").strip() or "postgres"
    sslmode = (sslmode or "require").strip() or "require"
    user = (user or "").strip().lower()
    password = password or ""
    try:
        port_n = int(port)
    except ValueError:
        raise DatabaseConfigError("DB_PORT is not an integer") from None
    if not 1 <= port_n <= 65535:
        raise DatabaseConfigError("DB_PORT is out of range")
    auth = f"{quote(user, safe='')}:{quote(password, safe='')}@" if user else ""
    return _validated(
        DatabaseConfig(
            dsn=f"postgresql://{auth}{host}:{port_n}/{database}?sslmode={sslmode}",
            schema=schema,
        )
    )


async def create_pool(config: DatabaseConfig, *, min_size: int = 1, max_size: int = 5):
    import asyncpg

    try:
        # A startup parameter (not SET) so the pool's per-release RESET ALL keeps it.
        pool = await asyncpg.create_pool(
            config.dsn,
            min_size=min_size,
            max_size=max_size,
            timeout=10,
            command_timeout=10,
            server_settings={"search_path": config.schema},
        )
    except Exception:  # noqa: BLE001 - wrap without leaking DSN/host
        raise DatabaseConnectError("failed to connect to postgres") from None
    try:
        await verify_pool(pool)
    except Exception:  # noqa: BLE001 - wrap without leaking DSN/host
        await pool.close()
        raise DatabaseConnectError("failed to connect to postgres") from None
    return pool


async def verify_pool(pool) -> None:
    async with pool.acquire() as connection:
        await connection.execute("SELECT 1")


async def ping_pool(pool, timeout: float = 0.75) -> bool:
    """Cheap connectivity check. Never raises; never logs connection details."""
    if pool is None:
        return False
    try:
        async with asyncio.timeout(timeout):
            async with pool.acquire(timeout=timeout) as connection:
                await connection.execute("SELECT 1")
        return True
    except Exception:  # noqa: BLE001 - ping is best-effort and must not log details
        return False
