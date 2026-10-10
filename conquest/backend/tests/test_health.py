import asyncio

from app import SERVICE_NAME, create_app


def test_healthz_reports_ok_and_version(monkeypatch):
    monkeypatch.setenv("APP_VERSION", "abc123")
    client = create_app().test_client()

    response = asyncio.run(client.get("/healthz"))

    assert response.status_code == 200
    assert asyncio.run(response.get_json()) == {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": "abc123",
        "storage": "memory",
        "database": "ok",
    }


def test_version_defaults_to_dev(monkeypatch):
    monkeypatch.delenv("APP_VERSION", raising=False)
    client = create_app().test_client()

    body = asyncio.run(asyncio.run(client.get("/healthz")).get_json())

    assert body["version"] == "dev"


def test_unknown_route_is_404():
    client = create_app().test_client()

    response = asyncio.run(client.get("/does-not-exist"))

    assert response.status_code == 404


def test_cors_allows_any_origin_by_default(monkeypatch):
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    client = create_app().test_client()

    response = asyncio.run(client.get("/healthz", headers={"Origin": "http://localhost:5173"}))

    assert response.headers["Access-Control-Allow-Origin"] == "*"


def test_cors_origins_can_be_restricted(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://game.example.test, http://localhost:5173")
    client = create_app().test_client()

    allowed = asyncio.run(client.get("/healthz", headers={"Origin": "https://game.example.test"}))
    denied = asyncio.run(client.get("/healthz", headers={"Origin": "https://evil.example"}))

    assert allowed.headers["Access-Control-Allow-Origin"] == "https://game.example.test"
    assert "Access-Control-Allow-Origin" not in denied.headers


def test_readyz_is_ok_without_a_database():
    client = create_app().test_client()

    response = asyncio.run(client.get("/readyz"))

    assert response.status_code == 200
    assert asyncio.run(response.get_json()) == {"status": "ok", "database": "ok", "schema": "ok"}


def test_healthz_does_not_leak_connection_details():
    body = asyncio.run(asyncio.run(create_app().test_client().get("/healthz")).get_json())
    serialized = str(body).lower()

    assert body["status"] == "ok"
    assert "password" not in serialized
    assert "dsn" not in serialized
    assert "conquest_db_" not in serialized


def test_incompatible_map_schema_blocks_world_access(monkeypatch):
    from unittest.mock import AsyncMock
    from app import db
    from app.migrate import SchemaCompatibilityError
    from app.world_transport import PostgresWorldStore

    pool = AsyncMock()
    config = db.DatabaseConfig('postgresql://unused', 'party_conquest')
    monkeypatch.setattr(db, 'load_db_config', lambda: config)
    monkeypatch.setattr(db, 'create_pool', AsyncMock(return_value=pool))
    monkeypatch.setattr('app.assert_pool_schema_compatible', AsyncMock(side_effect=SchemaCompatibilityError('missing map migration')))
    monkeypatch.setattr(PostgresWorldStore, 'start', AsyncMock())
    monkeypatch.setattr(PostgresWorldStore, 'close', AsyncMock())
    snapshot = AsyncMock()
    monkeypatch.setattr(PostgresWorldStore, 'snapshot', snapshot)

    async def scenario():
        app = create_app()
        async with app.test_app():
            response = await app.test_client().get('/v1/worlds/world-01/snapshot')
            assert response.status_code == 503
            assert (await response.get_json())['error']['code'] == 'service_unavailable'
        snapshot.assert_not_awaited()
    asyncio.run(scenario())
