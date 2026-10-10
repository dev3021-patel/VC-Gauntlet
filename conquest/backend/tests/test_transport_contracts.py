import asyncio
import json

import pytest

from app import create_app
from app.world_transport import Command, Subscriber, TransportError


def event(revision):
    return {
        "protocolVersion": 1, "schemaVersion": 2, "type": "event", "worldId": "world-01",
        "revision": revision, "eventType": "transport.tested", "commandId": f"c{revision}",
        "payload": {}, "committedAt": "2026-01-01T00:00:00+00:00",
    }


class FakeStore:
    def __init__(self):
        self.subscriber = None
        self.last_actor = None
        self.taunts = []

    async def start(self): pass
    async def close(self): pass
    async def ready(self): return True
    async def snapshot(self, world_id):
        return {"protocolVersion": 1, "schemaVersion": 2, "worldId": world_id, "revision": 1, "state": {}}
    async def submit(self, command, actor):
        self.last_actor = actor
        return {"protocolVersion": 1, "schemaVersion": 2, "status": "committed", "event": event(1)}, False
    def subscribe(self, world_id):
        del world_id
        self.subscriber = Subscriber(asyncio.Queue(4))
        return self.subscriber
    def unsubscribe(self, world_id, subscriber):
        del world_id, subscriber
    async def replay(self, world_id, after_revision):
        del world_id, after_revision
        # This commit lands while replay is loading. The pre-replay subscription preserves it.
        self.subscriber.queue.put_nowait(event(2))
        return [event(1)]
    async def publish_taunt(self, world_id, player_id):
        self.taunts.append((world_id, player_id))
        self.subscriber.queue.put_nowait({
            "protocolVersion": 1, "schemaVersion": 2, "type": "taunt",
            "worldId": world_id, "playerId": player_id,
        })
        return True


def valid_command():
    return {"protocolVersion": 1, "schemaVersion": 2, "worldId": "world-01", "commandId": "c1", "actionType": "transport.test", "payload": {}}


def test_command_contract_validation_and_structured_errors():
    with pytest.raises(TransportError) as version:
        Command.parse("world-01", {**valid_command(), "schemaVersion": 1})
    assert version.value.code == "unsupported_schema_version"

    app = create_app(world_store=FakeStore())
    client = app.test_client()
    bad = asyncio.run(client.post("/v1/worlds/world-01/commands", json={**valid_command(), "worldId": "other"}))
    body = asyncio.run(bad.get_json())
    assert bad.status_code == 400
    assert body["protocolVersion"] == 1
    assert body["schemaVersion"] == 2
    assert body["error"]["code"] == "world_mismatch"


def test_snapshot_submission_and_readiness_contracts():
    async def scenario():
        store = FakeStore()
        client = create_app(world_store=store).test_client()
        ready = await client.get("/readyz")
        assert ready.status_code == 200
        snapshot = await (await client.get("/v1/worlds/world-01/snapshot")).get_json()
        assert snapshot["revision"] == 1
        registered = await client.post(
            "/players/register", json={"name": "Wren", "pin": "1234", "avatar": "tide"}
        )
        identity = await registered.get_json()
        submitted = await client.post(
            "/v1/worlds/world-01/commands",
            json=valid_command(),
            headers={"Authorization": f"Bearer {identity['token']}"},
        )
        assert submitted.status_code == 201
        assert submitted.headers["Idempotent-Replay"] == "false"
        assert store.last_actor.actor_id == identity["player"]["id"]
    asyncio.run(scenario())


def test_subscription_closes_snapshot_to_live_race():
    async def scenario():
        app = create_app(world_store=FakeStore())
        client = app.test_client()
        async with client.websocket(
            "/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}
        ) as stream:
            first = json.loads(await stream.receive())
            ready = json.loads(await stream.receive())
            second = json.loads(await stream.receive())
            assert ready["type"] == "ready"
            assert [first["revision"], second["revision"]] == [1, 2]
    asyncio.run(scenario())


def test_websocket_first_frame_authenticates_privately_and_invalid_tokens_fall_back_to_anonymous(monkeypatch):
    from unittest.mock import AsyncMock

    connected = AsyncMock()
    monkeypatch.setattr("app.player_connected", connected)
    monkeypatch.setattr("app.player_disconnected", AsyncMock())

    async def scenario():
        store = FakeStore()
        store.pool = object()
        client = create_app(world_store=store).test_client()
        registered = await client.post("/players/register", json={"name": "Auth Wren", "pin": "1234", "avatar": "tide"})
        token = (await registered.get_json())["token"]
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": token}))
            assert (json.loads(await stream.receive()))["revision"] == 1
            # Only connection state is private now: no special, power-up, Nitro, or hunt frames.
            assert (json.loads(await stream.receive()))["type"] == "ready"
        connected.assert_awaited_once()

        connected.reset_mock()
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": "expired"}))
            assert (json.loads(await stream.receive()))["revision"] == 1
            assert (json.loads(await stream.receive()))["type"] == "ready"
        connected.assert_not_awaited()

        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 1, "type": "auth", "token": None}))
            rejected = json.loads(await stream.receive())
            assert rejected["schemaVersion"] == 2
            assert rejected["error"]["code"] == "unsupported_schema_version"
    asyncio.run(scenario())


def test_authenticated_websocket_taunts_are_broadcast_live_without_a_revision(monkeypatch):
    from unittest.mock import AsyncMock

    monkeypatch.setattr("app.player_connected", AsyncMock())
    monkeypatch.setattr("app.player_disconnected", AsyncMock())
    monkeypatch.setattr("app.connection_heartbeat", AsyncMock())

    async def scenario():
        store = FakeStore()
        store.pool = object()
        client = create_app(world_store=store).test_client()
        registered = await client.post("/players/register", json={"name": "Taunting Wren", "pin": "1234", "avatar": "tide"})
        identity = await registered.get_json()
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": identity["token"]}))
            assert (json.loads(await stream.receive()))["revision"] == 1
            assert (json.loads(await stream.receive()))["type"] == "ready"
            assert (json.loads(await stream.receive()))["revision"] == 2
            await stream.send(json.dumps({
                "protocolVersion": 1, "schemaVersion": 2, "type": "taunt", "worldId": "world-01",
            }))
            taunt = json.loads(await stream.receive())
            assert taunt == {
                "protocolVersion": 1, "schemaVersion": 2, "type": "taunt",
                "worldId": "world-01", "playerId": identity["player"]["id"],
            }
            # A revisionless taunt leaves the replay cursor alone; later events still arrive.
            store.subscriber.queue.put_nowait(event(3))
            assert (json.loads(await stream.receive()))["revision"] == 3
        assert store.taunts == [("world-01", identity["player"]["id"])]

    asyncio.run(scenario())


def test_anonymous_and_mismatched_taunt_frames_are_ignored(monkeypatch):
    from unittest.mock import AsyncMock

    monkeypatch.setattr("app.player_connected", AsyncMock())
    monkeypatch.setattr("app.player_disconnected", AsyncMock())
    monkeypatch.setattr("app.connection_heartbeat", AsyncMock())

    async def scenario():
        store = FakeStore()
        store.pool = object()
        client = create_app(world_store=store).test_client()
        registered = await client.post("/players/register", json={"name": "Quiet Wren", "pin": "1234", "avatar": "tide"})
        identity = await registered.get_json()
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            assert (json.loads(await stream.receive()))["revision"] == 1
            assert (json.loads(await stream.receive()))["type"] == "ready"
            assert (json.loads(await stream.receive()))["revision"] == 2
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "taunt", "worldId": "world-01"}))
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "ping"}))
            assert (json.loads(await stream.receive()))["type"] == "pong"
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": identity["token"]}))
            assert (json.loads(await stream.receive()))["revision"] == 1
            assert (json.loads(await stream.receive()))["type"] == "ready"
            assert (json.loads(await stream.receive()))["revision"] == 2
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "taunt", "worldId": "world-02"}))
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 1, "type": "taunt", "worldId": "world-01"}))
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "ping"}))
            assert (json.loads(await stream.receive()))["type"] == "pong"
        assert store.taunts == []

    asyncio.run(scenario())


class TauntPool:
    def __init__(self, placed):
        self.placed = placed
        self.notifications = []

    async def fetchval(self, query, *args):
        del query, args
        return 1 if self.placed else None

    async def execute(self, query, *args):
        del query
        self.notifications.append(json.loads(args[1]))


def test_only_placed_players_taunt_and_taunts_reach_only_current_world_subscribers():
    from app.world_transport import PostgresWorldStore, reject_unsupported

    player_id = "00000000-0000-0000-0000-000000000001"

    async def scenario():
        shared = PostgresWorldStore("unused", reject_unsupported, pool=TauntPool(placed=True))
        assert await shared.publish_taunt("world-01", player_id) is True
        [notice] = shared.pool.notifications
        assert notice["transient"]["type"] == "taunt" and "revision" not in notice["transient"]

        current = shared.subscribe("world-01")
        other_world = shared.subscribe("world-02")
        await shared._publish_notification(notice)
        assert await current.queue.get() == notice["transient"]
        assert other_world.queue.empty()
        # Taunts are never replayed to a later subscriber.
        assert shared.subscribe("world-01").queue.empty()

        defeated = PostgresWorldStore("unused", reject_unsupported, pool=TauntPool(placed=False))
        assert await defeated.publish_taunt("world-01", player_id) is False
        assert await defeated.publish_taunt("world-01", "not-a-uuid") is False
        assert defeated.pool.notifications == []

        owner = PostgresWorldStore("unused", reject_unsupported, pool=TauntPool(placed=True), exclusive=True)
        local = owner.subscribe("world-01")
        assert await owner.publish_taunt("world-01", player_id) is True
        assert (await local.queue.get())["playerId"] == player_id
        assert owner.pool.notifications == []

    asyncio.run(scenario())


def test_isolated_previews_have_separate_postgres_notification_channels():
    from app.world_transport import PostgresWorldStore, WORLD_CHANNEL, reject_unsupported

    production = PostgresWorldStore('unused', reject_unsupported, schema='party_conquest')
    first = PostgresWorldStore('unused', reject_unsupported, schema='party_conquest_preview_first')
    second = PostgresWorldStore('unused', reject_unsupported, schema='party_conquest_preview_second')
    same_session = PostgresWorldStore('unused', reject_unsupported, schema='party_conquest_preview_first')
    assert production.channel == WORLD_CHANNEL
    assert len({production.channel, first.channel, second.channel}) == 3
    assert first.channel == same_session.channel
    assert len(first.channel) <= 63


def test_websocket_storage_errors_are_logged_and_close_the_stream_cleanly(monkeypatch, caplog):
    """Issue #79: a database failure while registering presence must surface in logs and
    close the socket with a structured error, not crash inside the error handler."""
    import asyncpg
    from unittest.mock import AsyncMock

    failure = asyncpg.exceptions.CheckViolationError("new row violates check constraint")
    monkeypatch.setattr("app.player_connected", AsyncMock(side_effect=failure))
    monkeypatch.setattr("app.player_disconnected", AsyncMock())

    async def scenario():
        store = FakeStore()
        store.pool = object()
        client = create_app(world_store=store).test_client()
        registered = await client.post("/players/register", json={"name": "Storage Wren", "pin": "1234", "avatar": "tide"})
        token = (await registered.get_json())["token"]
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": token}))
            assert (json.loads(await stream.receive()))["revision"] == 1
            failed = json.loads(await stream.receive())
            assert failed["error"]["code"] == "storage_unavailable"
    with caplog.at_level("ERROR", logger="party_conquest.transport"):
        asyncio.run(scenario())
    assert "world_transport_storage_error type=CheckViolationError" in caplog.text
    assert "route=/v1/worlds/<world_id>/events" in caplog.text
    assert "Not within a request context" not in caplog.text


def test_websocket_pings_on_a_fixed_cadence_while_events_keep_streaming(monkeypatch):
    """Issue #79: presence heartbeats only advance on client frames, so a busy stream
    must still be pinged or the connection is swept as stale."""
    monkeypatch.setattr("app.PING_INTERVAL_SECONDS", 0.05)

    async def scenario():
        store = FakeStore()
        client = create_app(world_store=store).test_client()
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            assert (json.loads(await stream.receive()))["type"] == "event"
            assert (json.loads(await stream.receive()))["type"] == "ready"
            assert (json.loads(await stream.receive()))["revision"] == 2

            async def flood():
                revision = 3
                while True:
                    await store.subscriber.queue.put(event(revision))
                    revision += 1
                    await asyncio.sleep(0.005)
            pump = asyncio.create_task(flood())
            try:
                types = []
                async with asyncio.timeout(2):
                    while "ping" not in types:
                        types.append(json.loads(await stream.receive())["type"])
            finally:
                pump.cancel()
                await asyncio.gather(pump, return_exceptions=True)
            assert types.count("event") >= 1 and types[-1] == "ping"
    asyncio.run(scenario())


def test_batches_reach_opted_in_clients_as_one_frame_and_socket_commands_report_errors(monkeypatch):
    from unittest.mock import AsyncMock

    from app.realtime import Batch

    monkeypatch.setattr("app.player_connected", AsyncMock())
    monkeypatch.setattr("app.player_disconnected", AsyncMock())
    monkeypatch.setattr("app.connection_heartbeat", AsyncMock())

    class LiveStore(FakeStore):
        exclusive = True

        async def submit_live(self, command, actor):
            if command.payload.get("blocked"):
                raise TransportError("occupied", "Destination is occupied", 409)
            self.last_actor = actor
            return None

    def batch(*revisions):
        events = [event(revision) for revision in revisions]
        return Batch.of("world-01", events, [json.dumps(item) for item in events])

    async def scenario():
        store = LiveStore()
        store.pool = object()
        client = create_app(world_store=store).test_client()
        registered = await client.post("/players/register", json={"name": "Batch Wren", "pin": "1234", "avatar": "tide"})
        identity = await registered.get_json()
        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": None, "features": ["batch"]}))
            assert json.loads(await stream.receive())["revision"] == 1
            ready = json.loads(await stream.receive())
            assert ready["features"] == ["batch", "commands"]
            assert json.loads(await stream.receive())["revision"] == 2
            # Revisions already sent are trimmed from an overlapping batch.
            store.subscriber.queue.put_nowait(batch(2, 3, 4))
            framed = json.loads(await stream.receive())
            assert framed["type"] == "batch" and [item["revision"] for item in framed["events"]] == [3, 4]
            command = {"protocolVersion": 1, "schemaVersion": 2, "type": "command", "commandId": "m1", "actionType": "player.move", "payload": {}}
            await stream.send(json.dumps(command))
            unauthorized = json.loads(await stream.receive())
            assert (unauthorized["type"], unauthorized["commandId"], unauthorized["status"]) == ("commandError", "m1", 401)

        async with client.websocket("/v1/worlds/world-01/events", query_string={"after": "0"}, headers={"Origin": "http://localhost:5173"}) as stream:
            # Clients that never opted in keep receiving one frame per event.
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "auth", "token": identity["token"]}))
            assert json.loads(await stream.receive())["revision"] == 1
            assert json.loads(await stream.receive())["type"] == "ready"
            assert json.loads(await stream.receive())["revision"] == 2
            store.subscriber.queue.put_nowait(batch(3, 4))
            assert [json.loads(await stream.receive())["revision"] for _ in range(2)] == [3, 4]
            await stream.send(json.dumps({**command, "commandId": "m2", "payload": {"blocked": True}}))
            blocked = json.loads(await stream.receive())
            assert (blocked["type"], blocked["commandId"], blocked["error"]["code"]) == ("commandError", "m2", "occupied")
            await stream.send(json.dumps({**command, "commandId": "m3"}))
            await stream.send(json.dumps({"protocolVersion": 1, "schemaVersion": 2, "type": "ping"}))
            assert json.loads(await stream.receive())["type"] == "pong"
            assert store.last_actor.actor_id == identity["player"]["id"]

    asyncio.run(scenario())


@pytest.mark.shot_cadence
def test_a_shooter_fires_at_most_once_a_second_over_http_or_socket_and_a_rejected_shot_keeps_its_slot(monkeypatch):
    from app import world_transport
    from app.world_transport import ActorContext, PostgresWorldStore

    clock = [100.0]
    monkeypatch.setattr(world_transport.time, "monotonic", lambda: clock[0])
    store = PostgresWorldStore("postgresql://unused", resolver=None)
    outcomes = []

    async def resolved(command, actor):
        if command.payload.get("reject"):
            raise TransportError("stale_position", "Player position has advanced", 409)
        outcomes.append(command.command_id)
        return {"event": {"commandId": command.command_id}}, False

    store._submit = resolved

    def shot(number, **payload):
        return Command("world-01", f"shot-{number}", "player.shoot", {"expectedRevision": 1, **payload})

    async def scenario():
        archer, other = ActorContext("p1"), ActorContext("p2")
        with pytest.raises(TransportError):
            await store.submit(shot(0, reject=True), archer)
        await store.submit(shot(1), archer)
        clock[0] += 0.5
        with pytest.raises(TransportError) as cooling:
            await store.submit(shot(2), archer)
        assert (cooling.value.code, cooling.value.status) == ("shot_cooldown", 429)
        assert cooling.value.details["retryAfterMs"] == 500
        # Other players and other commands are unaffected.
        await store.submit(shot(3), other)
        await store.submit(Command("world-01", "move-1", "player.move", {"expectedRevision": 1}), archer)
        clock[0] += 0.45
        await store.submit(shot(4), archer)
        # The socket entry point shares the same cadence as HTTP, in both orders.
        clock[0] += 0.5
        with pytest.raises(TransportError) as socket_cooling:
            await store.submit_live(shot(5), archer)
        assert socket_cooling.value.code == "shot_cooldown"
        clock[0] += 0.5
        await store.submit_live(shot(6), archer)
        with pytest.raises(TransportError):
            await store.submit(shot(7), archer)
        assert outcomes == ["shot-1", "shot-3", "move-1", "shot-4", "shot-6"]

    asyncio.run(scenario())
