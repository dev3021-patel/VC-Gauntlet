"""Party Conquest backend application factory."""

import asyncio
import json
import logging
import os
import uuid

import asyncpg
from quart import Quart, Response, has_request_context, has_websocket_context, jsonify, request, websocket
from quart_cors import cors

from app.migrate import SchemaCompatibilityError, assert_pool_schema_compatible
from app.players import PlayerError, PlayerStore
from app.resolvers import configured_resolver
from app.presence import connection_heartbeat, player_connected, player_disconnected
from app.world_transport import (
    ActorContext,
    Command,
    PostgresWorldStore,
    PROTOCOL_VERSION,
    SCHEMA_VERSION,
    TransportError,
    validate_world_id,
)

SERVICE_NAME = "party-conquest-backend"
SCHEMA_CHECK_TIMEOUT_SECONDS = 5
# Under half the presence stale threshold, so a live connection always heartbeats before it is swept.
PING_INTERVAL_SECONDS = 20
HEARTBEAT_INTERVAL_SECONDS = 10
SOCKET_COMMANDS = frozenset({"player.move", "player.face", "player.shoot"})


async def _send_stream_item(client, item, last_sent: int, batches: bool) -> int:
    """Send one queued event or tick batch; returns the last revision sent."""
    from app.realtime import Batch

    if isinstance(item, Batch):
        if item.events[-1]["revision"] <= last_sent:
            return last_sent
        if item.first_revision > last_sent:
            frames = (item.frame,) if batches else item.event_frames
        else:
            fresh = [index for index, event in enumerate(item.events) if event["revision"] > last_sent]
            fresh_frames = [item.event_frames[index] for index in fresh]
            frames = (Batch.of(item.events[0]["worldId"], [item.events[index] for index in fresh], fresh_frames).frame,) if batches else fresh_frames
        for frame in frames:
            await client.send(frame)
        return item.events[-1]["revision"]
    if item.get("type") == "taunt":
        # Live-only cosmetic: no revision, so it never moves the replay cursor.
        await client.send(json.dumps(item))
        return last_sent
    if item["revision"] > last_sent:
        await client.send(json.dumps(item))
        return item["revision"]
    return last_sent


async def _socket_command(client, store, world_id: str, incoming: dict, actor) -> None:
    """Moves, turns, and shots over the open socket; the committed event arrives on the stream."""
    command_id = incoming.get("commandId")
    try:
        if not actor:
            raise TransportError("unauthorized", "Sign in to place or move a player", 401)
        command = Command.parse(world_id, {**incoming, "worldId": world_id})
        if command.action_type not in SOCKET_COMMANDS:
            raise TransportError("unsupported_action", "Only moves, turns, and shots are accepted over the stream", 422)
        await store.submit_live(command, ActorContext(actor.id))
    except TransportError as error:
        await client.send(json.dumps({**error.envelope(), "type": "commandError", "commandId": command_id, "status": error.status}))
transport_logger = logging.getLogger("party_conquest.transport")


def _cors_origins() -> str | list[str]:
    """Comma-separated CORS_ORIGINS, or "*" (the API is public and cookie-free)."""
    raw = os.environ.get("CORS_ORIGINS", "*").strip()
    if raw == "*" or not raw:
        return "*"
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def _bearer_token() -> str | None:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


def create_app(store: PlayerStore | None = None, *, world_store=None) -> Quart:
    """Build the Quart application.

    Startup uses an explicit ``DATABASE_URL`` or ``DB_*`` connection
    and fails if configuration is missing or Postgres is unreachable.
    Tests inject ``store`` / ``world_store`` (or stub the loader) to stay offline.
    """
    app = Quart(SERVICE_NAME)
    app.config["APP_VERSION"] = os.environ.get("APP_VERSION", "dev")
    cors(app, allow_origin=_cors_origins(), allow_headers=["Authorization", "Content-Type"])
    injected_store = store is not None
    holder = {
        "store": store or PlayerStore(os.environ.get("PLAYER_STORE_PATH") or None),
        "world_store": world_store,
        "pool": None,
        "schema_state": "ok",
        "schema_reason": None,
    }
    app.config["DATABASE_SCHEMA"] = None

    @app.before_serving
    async def connect_database():
        if not injected_store:
            from app import db as database
            from app.pg_store import PostgresPlayerStore

            config = database.load_db_config()
            if config is not None:
                pool = await database.create_pool(config, max_size=10)
                holder["pool"] = pool
                try:
                    async with asyncio.timeout(SCHEMA_CHECK_TIMEOUT_SECONDS):
                        await assert_pool_schema_compatible(pool)
                except SchemaCompatibilityError as exc:
                    holder["schema_state"] = "incompatible"
                    holder["schema_reason"] = str(exc)
                    transport_logger.error("schema_contract_incompatible reason=%s", exc)
                except Exception:  # noqa: BLE001 - report availability separately from proven incompatibility
                    holder["schema_state"] = "unknown"
                    holder["schema_reason"] = "schema contract check unavailable"
                    transport_logger.warning("schema_contract_unknown")
                else:
                    holder["schema_state"] = "ok"
                holder["store"] = PostgresPlayerStore(pool, owns_pool=False)
                if holder["world_store"] is None:
                    holder["world_store"] = PostgresWorldStore(
                        config.dsn,
                        configured_resolver(),
                        int(os.environ.get("WORLD_EVENT_RETENTION", "10000")),
                        int(os.environ.get("WORLD_STREAM_QUEUE_SIZE", "256")),
                        schema=config.schema,
                        pool=pool,
                        # One process owns live worlds; WORLD_OWNERSHIP=shared restores multi-replica fan-out.
                        exclusive=os.environ.get("WORLD_OWNERSHIP", "exclusive") != "shared",
                    )
                app.config["DATABASE_SCHEMA"] = config.schema
        if holder["world_store"] is not None:
            await holder["world_store"].start()

    @app.after_serving
    async def disconnect_database():
        if holder["world_store"] is not None:
            await holder["world_store"].close()
        close = getattr(holder["store"], "close", None)
        if close:
            await close()
        if holder["pool"] is not None:
            await holder["pool"].close()

    class _Players:
        def __getattr__(self, name):
            return getattr(holder["store"], name)

    players = _Players()

    @app.errorhandler(PlayerError)
    async def handle_player_error(error: PlayerError):
        response = jsonify(error=error.code, message=error.message)
        response.status_code = error.status
        if error.retry_after is not None:
            response.headers["Retry-After"] = str(error.retry_after)
        return response

    @app.errorhandler(TransportError)
    async def handle_transport_error(error: TransportError):
        transport_logger.info("command_or_stream_rejected code=%s status=%s", error.code, error.status)
        return jsonify(error.envelope()), error.status

    @app.errorhandler(asyncpg.PostgresError)
    async def handle_storage_error(error: asyncpg.PostgresError):
        # WebSocket handlers have no request context; touching `request` there raises
        # and hides the database error that actually failed (Issue #79).
        if has_request_context():
            route = request.url_rule.rule if request.url_rule else "unknown"
        elif has_websocket_context():
            route = websocket.url_rule.rule if websocket.url_rule else "unknown"
        else:
            route = "unknown"
        transport_logger.error(
            "world_transport_storage_error type=%s sqlstate=%s constraint=%s route=%s",
            type(error).__name__,
            getattr(error, "sqlstate", None) or "unknown",
            getattr(error, "constraint_name", None) or "unknown",
            route,
        )
        unavailable = TransportError("storage_unavailable", "World transport storage is unavailable", 503)
        if not has_request_context():
            await websocket.send(json.dumps(unavailable.envelope()))
            await websocket.close(1011)
            return None
        return jsonify(unavailable.envelope()), unavailable.status

    async def _json_body() -> dict:
        body = await request.get_json(silent=True)
        if not isinstance(body, dict):
            raise PlayerError(400, "invalid-body", "Send a JSON object.")
        return body

    @app.post("/players/register")
    async def register():
        body = await _json_body()
        token, player = await players.register(
            body.get("name"), body.get("pin"), body.get("avatar"), body.get("customAvatar")
        )
        return jsonify(token=token, player=player.public()), 201

    @app.post("/players/login")
    async def login():
        body = await _json_body()
        token, player = await players.login(body.get("name"), body.get("pin"))
        return jsonify(token=token, player=player.public())

    @app.get("/players/me")
    async def me():
        player = await players.authenticate(_bearer_token())
        return jsonify(player=player.public())

    @app.put("/players/me/custom-avatar")
    async def upload_custom_avatar():
        player = await players.authenticate(_bearer_token())
        updated = await players.set_custom_avatar(player.id, await _json_body())
        return jsonify(player=updated.public())

    @app.get("/avatars/<avatar_id>")
    async def custom_avatar_image(avatar_id: str):
        image = await players.custom_avatar_image(avatar_id)
        if image is None:
            return jsonify(error="not-found", message="No such avatar image."), 404
        content_type, data = image
        # Each upload has its own ID, so a short shared cache only delays a replacement
        # for viewers still holding a superseded ID.
        return Response(data, content_type=content_type, headers={
            "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff",
        })

    @app.post("/players/logout")
    async def logout():
        await players.logout(_bearer_token())
        return "", 204

    async def _database_state() -> str:
        from app.db import ping_pool

        pool = holder["pool"]
        if pool is None:
            return "ok" if not app.config["DATABASE_SCHEMA"] else "error"
        return "ok" if await ping_pool(pool) else "error"

    @app.get("/healthz")
    async def healthz():
        # Process-alive probe: always 200 so a brief database outage does not
        # restart pods. Readiness uses /readyz.
        return jsonify(
            status="ok",
            service=SERVICE_NAME,
            version=app.config["APP_VERSION"],
            storage="postgres" if app.config["DATABASE_SCHEMA"] else "memory",
            database=await _database_state(),
        )

    @app.get("/readyz")
    async def readyz():
        database = await _database_state()
        schema = holder["schema_state"]
        current = holder["world_store"]
        world_ok = True if current is None else bool(await current.ready())
        ok = database == "ok" and schema == "ok" and world_ok
        response = {"status": "ok" if ok else "unavailable", "database": database, "schema": schema}
        if holder["schema_reason"]:
            response["schemaReason"] = holder["schema_reason"]
        return jsonify(response), (200 if ok else 503)

    def require_world_store():
        if holder["schema_state"] != "ok":
            raise TransportError("service_unavailable", "World schema is not ready for this map. Try again after deployment.", 503)
        current = holder["world_store"]
        if current is None:
            raise TransportError("service_unavailable", "World transport storage is unavailable", 503)
        return current

    @app.post("/v1/worlds/<world_id>/commands")
    async def submit_command(world_id: str):
        from app.world_transport import Command

        validate_world_id(world_id)
        command = Command.parse(world_id, await request.get_json(silent=True))
        token = _bearer_token()
        actor = ActorContext((await players.authenticate(token)).id) if token else ActorContext()
        outcome, duplicate = await require_world_store().submit(command, actor)
        response = jsonify(outcome)
        response.headers["Idempotent-Replay"] = "true" if duplicate else "false"
        return response, 200 if duplicate else 201

    @app.get("/v1/worlds/<world_id>/snapshot")
    async def world_snapshot(world_id: str):
        validate_world_id(world_id)
        return jsonify(await require_world_store().snapshot(world_id))

    @app.get("/v1/worlds/<world_id>/avatars")
    async def world_avatars(world_id: str):
        # Public so registration can mark taken choices before an account exists.
        from app.avatar_claims import in_use
        validate_world_id(world_id)
        pool = require_world_store().pool
        if not hasattr(pool, "acquire"):
            return jsonify(worldId=world_id, inUse=[])
        async with pool.acquire() as connection:
            return jsonify(worldId=world_id, inUse=await in_use(connection, world_id))

    @app.websocket("/v1/worlds/<world_id>/events")
    async def world_events(world_id: str):
        validate_world_id(world_id)
        try:
            after_revision = int(websocket.args.get("after", "0"))
            if after_revision < 0:
                raise ValueError
        except ValueError:
            await websocket.send(
                json.dumps(TransportError("invalid_cursor", "after must be a non-negative integer").envelope())
            )
            await websocket.close(4400)
            return

        current = require_world_store()
        connection_id = uuid.uuid4()
        presence_registered = False
        client = websocket._get_current_object()
        actor = None
        features: set[str] = set()
        try:
            first_frame = await asyncio.wait_for(client.receive(), timeout=1)
            incoming = json.loads(first_frame) if first_frame else {}
            if (incoming.get("protocolVersion"), incoming.get("schemaVersion")) != (PROTOCOL_VERSION, SCHEMA_VERSION):
                await client.send(json.dumps(TransportError(
                    "unsupported_schema_version",
                    f"World transport requires protocol {PROTOCOL_VERSION}, schema {SCHEMA_VERSION}",
                ).envelope()))
                await client.close(4400)
                return
            token = incoming.get("token") if incoming.get("type") == "auth" else None
            if incoming.get("type") == "auth" and isinstance(incoming.get("features"), list):
                features = {item for item in incoming["features"] if isinstance(item, str)}
            if token:
                try:
                    actor = await players.authenticate(token)
                except PlayerError:
                    # World events remain anonymously readable when credentials
                    # expire; account HTTP requests surface the sign-in failure.
                    actor = None
        except (TimeoutError, TypeError, json.JSONDecodeError):
            pass
        subscriber = current.subscribe(world_id)
        last_sent = after_revision
        awaiting_pong = False
        # Ping on a fixed cadence even while events stream continuously. Presence heartbeats
        # only advance on client frames, so a busy connection that is never pinged is swept
        # as stale after STALE_CONNECTION_SECONDS (Issue #79).
        loop = asyncio.get_running_loop()
        ping_due_at = loop.time() + PING_INTERVAL_SECONDS
        transport_logger.info("stream_connected world_id=%s after_revision=%s", world_id, after_revision)
        try:
            try:
                replay = await current.replay(world_id, after_revision)
                transport_logger.info("stream_replay world_id=%s event_count=%s", world_id, len(replay))
                for event in replay:
                    await client.send(json.dumps(event))
                    last_sent = max(last_sent, event["revision"])
                if actor:
                    avatar_available = await player_connected(current.pool, world_id, actor.id, connection_id)
                    presence_registered = True
                    if avatar_available is False:
                        # Private: the returning player must pick another avatar before spawning.
                        await client.send(json.dumps({
                            "protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION,
                            "type": "avatarStatus", "available": False, "avatar": actor.avatar,
                        }))
                await client.send(
                    json.dumps(
                        {
                            "protocolVersion": PROTOCOL_VERSION,
                            "schemaVersion": SCHEMA_VERSION,
                            "type": "ready",
                            "worldId": world_id,
                            "revision": last_sent,
                            # Socket commands are offered only by an in-memory world owner.
                            "features": ["batch", "commands"] if getattr(current, "exclusive", False) else ["batch"],
                        }
                    )
                )
            except TransportError as error:
                transport_logger.info("stream_resync_required world_id=%s code=%s", world_id, error.code)
                await client.send(json.dumps(error.envelope()))
                await client.close(4409)
                return

            receive_task = asyncio.create_task(client.receive())
            closed_task = asyncio.create_task(subscriber.closed.wait())
            event_task = asyncio.create_task(subscriber.queue.get())
            heartbeat_due_at = 0.0
            try:
                while True:
                    done, _ = await asyncio.wait(
                        {event_task, receive_task, closed_task},
                        timeout=max(0.0, ping_due_at - loop.time()),
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    if loop.time() >= ping_due_at:
                        if awaiting_pong:
                            transport_logger.info("dead_stream_disconnected world_id=%s", world_id)
                            await client.close(4408)
                            return
                        await client.send(json.dumps({"protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION, "type": "ping"}))
                        awaiting_pong = True
                        ping_due_at = loop.time() + PING_INTERVAL_SECONDS
                    if closed_task in done and subscriber.closed.is_set():
                        await client.send(
                            json.dumps(
                                TransportError(
                                    "resync_required",
                                    "Client fell behind and must reconnect",
                                    409,
                                    {"reason": subscriber.reason},
                                ).envelope()
                            )
                        )
                        await client.close(4409)
                        return
                    if event_task in done:
                        last_sent = await _send_stream_item(client, event_task.result(), last_sent, "batch" in features)
                        event_task = asyncio.create_task(subscriber.queue.get())
                    if receive_task in done:
                        message = receive_task.result()
                        if message is None:
                            return
                        receive_task = asyncio.create_task(client.receive())
                        awaiting_pong = False
                        ping_due_at = loop.time() + PING_INTERVAL_SECONDS
                        # Commands arrive many times a second; presence only needs a recent heartbeat.
                        if presence_registered and loop.time() >= heartbeat_due_at:
                            await connection_heartbeat(current.pool, connection_id)
                            heartbeat_due_at = loop.time() + HEARTBEAT_INTERVAL_SECONDS
                        try:
                            incoming = json.loads(message)
                        except (TypeError, json.JSONDecodeError):
                            incoming = {}
                        if not isinstance(incoming, dict):
                            incoming = {}
                        if incoming.get("type") == "ping":
                            await client.send(
                                json.dumps({"protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION, "type": "pong"})
                            )
                        elif incoming.get("type") == "command" and getattr(current, "exclusive", False):
                            await _socket_command(client, current, world_id, incoming, actor)
                        elif (
                            incoming.get("type") == "taunt"
                            and (incoming.get("protocolVersion"), incoming.get("schemaVersion")) == (PROTOCOL_VERSION, SCHEMA_VERSION)
                            and incoming.get("worldId") == world_id
                            and presence_registered
                            and actor
                        ):
                            await current.publish_taunt(world_id, actor.id)
            finally:
                for task in (event_task, receive_task, closed_task):
                    task.cancel()
                await asyncio.gather(event_task, receive_task, closed_task, return_exceptions=True)
        finally:
            current.unsubscribe(world_id, subscriber)
            if presence_registered and actor:
                await player_disconnected(current.pool, world_id, actor.id, connection_id)
            transport_logger.info("stream_disconnected world_id=%s last_revision=%s", world_id, last_sent)

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(message)s")

    return app
