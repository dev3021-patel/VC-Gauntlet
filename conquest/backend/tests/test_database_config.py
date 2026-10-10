import asyncio

import pytest
from app import create_app
from app.db import DatabaseConfig, DatabaseConnectError, load_db_config, ping_pool
from app.migrate import SchemaCompatibilityError

pytestmark = pytest.mark.no_db_stub


@pytest.fixture(autouse=True)
def no_aws(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("database configuration must not contact AWS")
    monkeypatch.setattr("app.db.load_from_secrets_manager", forbidden, raising=False)


def test_database_url_is_used_without_aws(monkeypatch):
    # An explicit local URL must work even if no AWS SDK or credentials exist.
    config = load_db_config({"DATABASE_URL": "postgresql://party:local@127.0.0.1:5432/party", "DB_SCHEMA": "team_one"})
    assert config.dsn == "postgresql://party:local@127.0.0.1:5432/party"
    assert config.schema == "team_one"
    assert "local" not in repr(config)


def test_missing_configuration_fails_without_contacting_aws():
    with pytest.raises(ValueError, match="DATABASE_URL"):
        load_db_config({})


def test_explicit_parts_support_local_postgres_without_tls():
    config = load_db_config({"DB_HOST": "127.0.0.1", "DB_USER": "party", "DB_PASSWORD": "p:a", "DB_SSLMODE": "disable"})
    assert config.dsn == "postgresql://party:p%3Aa@127.0.0.1:5432/postgres?sslmode=disable"


def test_startup_uses_explicit_configuration(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://party:local@127.0.0.1:5432/party")
    async def assert_config(config, **kwargs):
        assert config.dsn == "postgresql://party:local@127.0.0.1:5432/party"
        raise DatabaseConnectError("explicit database reached")
    monkeypatch.setattr("app.db.create_pool", assert_config)
    with pytest.raises(DatabaseConnectError, match="explicit database reached"):
        asyncio.run(create_app().startup())


def test_startup_fails_closed_if_postgres_is_unreachable(monkeypatch):
    monkeypatch.setattr(
        "app.db.load_db_config",
        lambda *args, **kwargs: DatabaseConfig(
            dsn="postgresql://u:p@127.0.0.1:1/db?sslmode=require", schema="party_conquest"
        ),
    )

    async def boom(config, **kwargs):
        raise DatabaseConnectError("failed to connect to postgres")

    monkeypatch.setattr("app.db.create_pool", boom)
    with pytest.raises(DatabaseConnectError, match="failed to connect to postgres"):
        asyncio.run(create_app().startup())


def test_healthz_stays_up_when_database_ping_fails(monkeypatch):
    monkeypatch.setattr(
        "app.db.load_db_config",
        lambda *args, **kwargs: DatabaseConfig(
            dsn="postgresql://u:p@db.example/db?sslmode=require", schema="party_conquest"
        ),
    )

    class FakePool:
        async def close(self):
            return None

        def acquire(self, *args, **kwargs):
            raise AssertionError("healthz must use ping_pool, not acquire directly")

    class FakeWorldStore:
        async def start(self):
            return None

        async def close(self):
            return None

        async def ready(self):
            return True

    async def fake_create_pool(config, **kwargs):
        return FakePool()

    async def fake_ping(pool, timeout=0.75):
        return False

    monkeypatch.setattr("app.db.create_pool", fake_create_pool)
    monkeypatch.setattr("app.db.ping_pool", fake_ping)

    async def scenario():
        app = create_app(world_store=FakeWorldStore())
        await app.startup()
        try:
            client = app.test_client()
            health = await client.get("/healthz")
            ready = await client.get("/readyz")
            return (
                health.status_code,
                await health.get_json(),
                ready.status_code,
                await ready.get_json(),
            )
        finally:
            await app.shutdown()

    health_status, health_body, ready_status, ready_body = asyncio.run(scenario())

    assert health_status == 200
    assert health_body["status"] == "ok"
    assert health_body["database"] == "error"
    assert health_body["storage"] == "postgres"
    for leaked in ("password", "dsn", "host", "user", "db.example"):
        assert leaked not in str(health_body).lower()
    assert ready_status == 503
    assert ready_body["database"] == "error"
    assert ready_body["schema"] == "unknown"
    assert ready_body["schemaReason"] == "schema contract check unavailable"
    assert ready_body["status"] == "unavailable"


def test_ping_pool_does_not_raise_on_a_dead_pool():
    class DeadPool:
        def acquire(self, *args, **kwargs):
            raise RuntimeError("connection refused")

    assert asyncio.run(ping_pool(DeadPool())) is False
    assert asyncio.run(ping_pool(None)) is False


def test_schema_incompatibility_reason_is_cached_and_distinct(monkeypatch):
    monkeypatch.setattr(
        "app.db.load_db_config",
        lambda *args, **kwargs: DatabaseConfig(dsn="postgresql://redacted", schema="party_conquest"),
    )

    class FakePool:
        async def close(self):
            return None

    class FakeWorldStore:
        async def start(self):
            return None

        async def close(self):
            return None

        async def ready(self):
            return True

    async def fake_create_pool(config, **kwargs):
        return FakePool()

    checks = 0

    async def incompatible(pool):
        nonlocal checks
        checks += 1
        raise SchemaCompatibilityError("missing versions [5]")

    async def healthy(pool, timeout=0.75):
        return True

    monkeypatch.setattr("app.db.create_pool", fake_create_pool)
    monkeypatch.setattr("app.db.ping_pool", healthy)
    monkeypatch.setattr("app.assert_pool_schema_compatible", incompatible)

    async def scenario():
        app = create_app(world_store=FakeWorldStore())
        await app.startup()
        try:
            client = app.test_client()
            first = await client.get("/readyz")
            second = await client.get("/readyz")
            return first.status_code, await first.get_json(), second.status_code
        finally:
            await app.shutdown()

    status, body, second_status = asyncio.run(scenario())
    assert status == second_status == 503
    assert body["schema"] == "incompatible"
    assert body["schemaReason"] == "missing versions [5]"
    assert checks == 1
