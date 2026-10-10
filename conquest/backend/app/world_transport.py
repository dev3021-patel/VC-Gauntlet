"""Durable, ordered shared-world event transport."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

import asyncpg

from app.eliminations import resolve_eliminations, VICTIM_DEATHS_QUERY

PROTOCOL_VERSION = 1
SCHEMA_VERSION = 2
WORLD_CHANNEL = "party_conquest_world_events"
WORLD_ID_MAX_LENGTH = 80
COMMAND_ID_MAX_LENGTH = 128
logger = logging.getLogger("party_conquest.transport")
# Moves and turns are broadcast in one frame per tick instead of one per event.
BROADCAST_TICK_SECONDS = 0.05
# Memory is re-read periodically so it never drifts from storage.
RUNTIME_REFRESH_SECONDS = 2.0
# A dead owner's TCP session must release the ownership lock quickly.
SHUTDOWN_FLUSH_ATTEMPTS = 3
SHUTDOWN_FLUSH_BACKOFF_SECONDS = 0.2
SHUTDOWN_TICK_GRACE_SECONDS = 2.0
# The laser recharges for one second. Every shot for a world reaches the process
# that owns it, so that process's clock decides; the tolerance absorbs network
# jitter between the client's own one-second cadence and arrival here.
SHOT_COOLDOWN_SECONDS = 1.0
SHOT_COOLDOWN_TOLERANCE_SECONDS = 0.1
OWNER_KEEPALIVES = {"tcp_keepalives_idle": "10", "tcp_keepalives_interval": "5", "tcp_keepalives_count": "3"}


def _json_object(value: Any) -> dict[str, Any]:
    return json.loads(value) if isinstance(value, str) else dict(value)


class TransportError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details or {}

    def envelope(self) -> dict[str, Any]:
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "error": {"code": self.code, "message": self.message, "details": self.details},
        }


class OwnershipLost(TransportError):
    """This process no longer holds the world ownership lock."""

    def __init__(self) -> None:
        super().__init__("storage_unavailable", "World transport storage is unavailable", 503)


@dataclass(frozen=True)
class ActorContext:
    """Trusted server-side identity supplied by future authentication middleware."""

    actor_id: str | None = None


@dataclass(frozen=True)
class Command:
    world_id: str
    command_id: str
    action_type: str
    payload: dict[str, Any]
    protocol_version: int = PROTOCOL_VERSION
    schema_version: int = SCHEMA_VERSION

    @classmethod
    def parse(cls, world_id: str, value: Any) -> "Command":
        if not isinstance(value, dict):
            raise TransportError("invalid_command", "Command body must be a JSON object")
        if value.get("protocolVersion") != PROTOCOL_VERSION:
            raise TransportError("unsupported_protocol_version", "Only protocol version 1 is supported")
        if value.get("schemaVersion") != SCHEMA_VERSION:
            raise TransportError("unsupported_schema_version", f"Only command schema version {SCHEMA_VERSION} is supported")
        if value.get("worldId") != world_id:
            raise TransportError("world_mismatch", "Path and command world IDs must match")
        command_id, action_type, payload = value.get("commandId"), value.get("actionType"), value.get("payload")
        if not isinstance(command_id, str) or not command_id or len(command_id) > COMMAND_ID_MAX_LENGTH:
            raise TransportError("invalid_command", "commandId must be a non-empty string of at most 128 characters")
        if not isinstance(action_type, str) or not action_type:
            raise TransportError("invalid_command", "actionType must be a non-empty string")
        if not isinstance(payload, dict):
            raise TransportError("invalid_command", "payload must be a JSON object")
        return cls(world_id, command_id, action_type, payload)

    def content_hash(self) -> str:
        canonical = json.dumps(
            {"protocolVersion": self.protocol_version, "schemaVersion": self.schema_version, "worldId": self.world_id, "actionType": self.action_type, "payload": self.payload},
            sort_keys=True,
            separators=(",", ":"),
        )
        return hashlib.sha256(canonical.encode()).hexdigest()


class Resolver(Protocol):
    async def __call__(self, command: Command, actor: ActorContext, connection: asyncpg.Connection) -> tuple[str, dict[str, Any]]: ...


async def reject_unsupported(command: Command, actor: ActorContext, connection=None) -> tuple[str, dict[str, Any]]:
    del actor, connection
    raise TransportError("unsupported_action", f"Action type '{command.action_type}' is not supported", 422)


async def test_resolver(command: Command, actor: ActorContext, connection=None) -> tuple[str, dict[str, Any]]:
    """Deterministic non-production resolver used to prove transport behavior."""
    del actor
    if command.action_type != "transport.test":
        return await reject_unsupported(command, ActorContext(), connection)
    return "transport.tested", command.payload


SCHEMA_SQL = """
-- Exclusive-mode fencing token: each new world owner increments it, and every
-- owner write re-reads it FOR SHARE inside its own transaction.
CREATE TABLE IF NOT EXISTS world_owner_epoch (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  epoch bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS world_streams (
  world_id text PRIMARY KEY,
  current_revision bigint NOT NULL DEFAULT 0,
  oldest_revision bigint NOT NULL DEFAULT 1,
  CHECK (current_revision >= 0), CHECK (oldest_revision >= 1)
);
CREATE TABLE IF NOT EXISTS world_commands (
  world_id text NOT NULL,
  command_id text NOT NULL,
  content_hash text NOT NULL,
  outcome jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, command_id)
);
CREATE TABLE IF NOT EXISTS world_events (
  world_id text NOT NULL,
  revision bigint NOT NULL,
  event jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, revision)
);
CREATE INDEX IF NOT EXISTS world_events_committed_at ON world_events (committed_at);
"""


@dataclass(eq=False)
class Subscriber:
    queue: asyncio.Queue[dict[str, Any]]
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str | None = None


class PostgresWorldStore:
    def __init__(
        self,
        database_url: str,
        resolver: Resolver,
        retention_events: int = 10_000,
        queue_size: int = 256,
        *,
        schema: str = "public",
        pool: asyncpg.Pool | None = None,
        exclusive: bool = False,
    ):
        self.database_url, self.resolver = database_url, resolver
        self.retention_events, self.queue_size = max(1, retention_events), max(1, queue_size)
        self.schema = schema
        # PostgreSQL notification channels are database-wide, unlike tables.
        # Preview traffic must never wake production listeners for world-01.
        self.channel = (
            f"{WORLD_CHANNEL}_{hashlib.sha256(schema.encode()).hexdigest()[:16]}"
            if schema.startswith("party_conquest_preview_") else WORLD_CHANNEL
        )
        self.pool = pool
        self._owns_pool = pool is None
        self.listener: asyncpg.Connection | None = None
        self.subscribers: dict[str, set[Subscriber]] = {}
        self._start_lock = asyncio.Lock()
        self._notifications: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10_000)
        self._notification_worker: asyncio.Task | None = None
        self._mob_worker: asyncio.Task | None = None
        # Exclusive mode: one process owns every world (a session advisory lock),
        # moves commit in memory, and fan-out is local instead of LISTEN/NOTIFY.
        self.exclusive, self.owner = exclusive, False
        # Fencing token taken when ownership was acquired; owner writes verify it is still current.
        self._epoch: int | None = None
        self._closing = False
        self.runtimes: dict[str, Any] = {}
        # (world, player) -> monotonic time of the last accepted shot.
        self._last_shots: dict[tuple[str, str], float] = {}
        self._tick_worker: asyncio.Task | None = None

    async def start(self) -> None:
        if self.exclusive:
            return await self._start_exclusive()
        async with self._start_lock:
            if (
                self.pool
                and self.listener
                and not self.listener.is_closed()
                and self._notification_worker
                and not self._notification_worker.done()
            ):
                return
            try:
                if not self.pool:
                    self.pool = await asyncpg.create_pool(
                        self.database_url,
                        min_size=1,
                        max_size=10,
                        server_settings={"search_path": self.schema},
                    )
                    async with self.pool.acquire() as connection:
                        await connection.execute(SCHEMA_SQL)
                if not self.listener or self.listener.is_closed():
                    self.listener = await asyncpg.connect(
                        self.database_url, server_settings={"search_path": self.schema}
                    )
                    await self.listener.add_listener(self.channel, self._notification)
                if not self._notification_worker or self._notification_worker.done():
                    self._notification_worker = asyncio.create_task(self._consume_notifications())
                if not self._mob_worker or self._mob_worker.done():
                    self._mob_worker = asyncio.create_task(self._mob_loop())
                logger.info("world_transport_ready")
            except Exception:
                if self.listener and not self.listener.is_closed():
                    await self.listener.close()
                if self.pool and self._owns_pool:
                    await self.pool.close()
                    self.pool = None
                self.listener = None
                raise

    async def _start_exclusive(self) -> None:
        async with self._start_lock:
            if self.pool and self.owner and self.listener and not self.listener.is_closed():
                return
            if not self.pool:
                self.pool = await asyncpg.create_pool(
                    self.database_url, min_size=1, max_size=10, server_settings={"search_path": self.schema},
                )
                async with self.pool.acquire() as connection:
                    await connection.execute(SCHEMA_SQL)
            if not self.listener or self.listener.is_closed():
                # The lock dies with this session; memory must be rebuilt from storage.
                self.owner = False
                self.listener = await asyncpg.connect(
                    self.database_url, server_settings={"search_path": self.schema, **OWNER_KEEPALIVES}
                )
                self.listener.add_termination_listener(self._ownership_lost)
            self.owner = await self.listener.fetchval(
                "SELECT pg_try_advisory_lock(hashtext($1))", f"party_conquest_world_owner:{self.schema}"
            )
            if not self.owner:
                logger.warning("world_transport_waiting_for_ownership")
                return
            # Waits for any in-flight write by a previous owner, then fences it out.
            self._epoch = await self.listener.fetchval(
                """INSERT INTO world_owner_epoch(epoch) VALUES(1)
                   ON CONFLICT (singleton) DO UPDATE SET epoch=world_owner_epoch.epoch+1 RETURNING epoch"""
            )
            self.runtimes.clear()
            for name, loop in (("_tick_worker", self._tick_loop), ("_mob_worker", self._mob_loop)):
                worker = getattr(self, name)
                if not worker or worker.done():
                    setattr(self, name, asyncio.create_task(loop()))
            logger.info("world_transport_ready owner=true")

    def _ownership_lost(self, _connection=None) -> None:
        """The lock session ended: stop admitting memory commands and drop unwritten state."""
        if not self.owner:
            return
        self.owner, self._epoch = False, None
        logger.error("world_ownership_lost")
        for runtime in tuple(self.runtimes.values()):
            runtime.reset()
            self._close_subscribers(runtime.world_id, "ownership_lost")

    def holds_ownership(self) -> bool:
        if self._closing or not self.owner:
            return False
        if not self.listener or self.listener.is_closed():
            self._ownership_lost()
            return False
        return True

    async def close(self) -> None:
        # Admission stops first, so nothing is accepted after the final flush.
        self._closing = True
        if self._tick_worker:
            # The tick exits at its next wake-up, so an in-flight flush finishes rather than being cut.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(self._tick_worker), SHUTDOWN_TICK_GRACE_SECONDS)
            self._tick_worker.cancel()
            await asyncio.gather(self._tick_worker, return_exceptions=True)
            self._tick_worker = None
        for runtime in tuple(self.runtimes.values()):
            await self._drain_on_close(runtime)
        if self._mob_worker:
            self._mob_worker.cancel()
            await asyncio.gather(self._mob_worker, return_exceptions=True)
            self._mob_worker = None
        if self._notification_worker:
            self._notification_worker.cancel()
            await asyncio.gather(self._notification_worker, return_exceptions=True)
            self._notification_worker = None
        if self.listener:
            self.owner, self._epoch = False, None
            await self.listener.close()
        if self.pool and self._owns_pool:
            await self.pool.close()
            self.pool = None
        self.listener = None

    async def _fence(self, connection) -> None:
        """Inside an owner write: prove no successor has taken over, and block one until commit."""
        if self._epoch is None or await connection.fetchval(
            "SELECT epoch FROM world_owner_epoch FOR SHARE"
        ) != self._epoch:
            raise OwnershipLost()

    async def _drain_on_close(self, runtime) -> None:
        """Accepted moves survive a graceful shutdown; a failure is retried, then reported."""
        for attempt in range(1, SHUTDOWN_FLUSH_ATTEMPTS + 1):
            pending = len(runtime.unflushed)
            if not pending:
                return
            try:
                async with runtime.lock, runtime.flushing:
                    await self._flush_batch(runtime, keep_on_failure=True)
                return
            except OwnershipLost:
                break
            except Exception:
                logger.warning("world_shutdown_flush_retry world_id=%s attempt=%d", runtime.world_id, attempt)
                await asyncio.sleep(SHUTDOWN_FLUSH_BACKOFF_SECONDS * attempt)
        logger.error("world_shutdown_flush_failed world_id=%s dropped_events=%d", runtime.world_id, len(runtime.unflushed))
        runtime.reset()
        self._close_subscribers(runtime.world_id, "stream_unavailable")

    async def ready(self) -> bool:
        try:
            await self.start()
            assert self.pool
            if self.exclusive and not self.owner:
                return False
            return await self.pool.fetchval("SELECT 1") == 1
        except Exception:
            logger.exception("world_transport_readiness_failed")
            return False

    @contextlib.contextmanager
    def _shot_cadence(self, command: Command, actor: ActorContext):
        """Reserve this shot's slot in the shooter's cadence; a rejected shot gives it back."""
        if command.action_type != "player.shoot" or not actor.actor_id:
            yield
            return
        key, now = (command.world_id, actor.actor_id), time.monotonic()
        previous = self._last_shots.get(key)
        if previous is not None and now - previous < SHOT_COOLDOWN_SECONDS - SHOT_COOLDOWN_TOLERANCE_SECONDS:
            raise TransportError("shot_cooldown", "Your laser is recharging", 429, {
                "retryAfterMs": max(1, round((previous + SHOT_COOLDOWN_SECONDS - now) * 1000)),
            })
        if len(self._last_shots) > 4096:
            self._last_shots = {item: at for item, at in self._last_shots.items() if now - at < SHOT_COOLDOWN_SECONDS}
        self._last_shots[key] = now
        try:
            yield
        except BaseException:
            if self._last_shots.get(key) == now:
                if previous is None:
                    self._last_shots.pop(key, None)
                else:
                    self._last_shots[key] = previous
            raise

    async def submit(self, command: Command, actor: ActorContext) -> tuple[dict[str, Any], bool]:
        with self._shot_cadence(command, actor):
            return await self._submit(command, actor)

    async def _submit(self, command: Command, actor: ActorContext) -> tuple[dict[str, Any], bool]:
        if not self.pool:
            raise TransportError("storage_unavailable", "World transport storage is unavailable", 503)
        try:
            runtime = self.runtimes.get(command.world_id)
            # Terrain only changes with a deploy, so the owner reconciles each world once.
            if not (runtime and runtime.reconciled):
                await self._reconcile_map(command.world_id)
        except TransportError as exc:
            if exc.code != "no_spawn_available":
                raise
            # Valid players can still move/shoot to free capacity. The position
            # resolver rejects invalid actors until relocation succeeds.
        digest = command.content_hash()
        async with self._world(command.world_id) as runtime, self.pool.acquire() as connection, connection.transaction():
            if runtime is not None:
                await self._fence(connection)
            await connection.execute(
                "INSERT INTO world_streams(world_id) VALUES($1) ON CONFLICT DO NOTHING", command.world_id
            )
            stream = await connection.fetchrow(
                "SELECT current_revision FROM world_streams WHERE world_id=$1 FOR UPDATE", command.world_id
            )
            if stream is None:
                await connection.execute(
                    "INSERT INTO world_streams(world_id) VALUES($1) ON CONFLICT DO NOTHING", command.world_id
                )
                stream = await connection.fetchrow(
                    "SELECT current_revision FROM world_streams WHERE world_id=$1 FOR UPDATE", command.world_id
                )
            prior = await connection.fetchrow(
                "SELECT content_hash, outcome FROM world_commands WHERE world_id=$1 AND command_id=$2",
                command.world_id, command.command_id,
            )
            if prior:
                if prior["content_hash"] != digest:
                    logger.info("command_rejected code=idempotency_conflict world_id=%s", command.world_id)
                    raise TransportError("idempotency_conflict", "commandId was already used with different content", 409)
                logger.info("command_duplicate world_id=%s", command.world_id)
                return _json_object(prior["outcome"]), True

            revision = int(stream["current_revision"])
            event_type, payload = await self.resolver(command, actor, connection)
            await resolve_eliminations(connection, command.world_id, payload)
            revision += 1
            event = {
                "protocolVersion": PROTOCOL_VERSION,
                "schemaVersion": SCHEMA_VERSION,
                "type": "event",
                "worldId": command.world_id,
                "revision": revision,
                "eventType": event_type,
                "commandId": command.command_id,
                "payload": payload,
                "committedAt": datetime.now(timezone.utc).isoformat(),
            }
            outcome = {"protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION, "status": "committed", "event": event}
            await connection.execute(
                "INSERT INTO world_events(world_id, revision, event) VALUES($1,$2,$3::jsonb)",
                command.world_id, revision, json.dumps(event),
            )
            await connection.execute(
                "INSERT INTO world_commands(world_id, command_id, content_hash, outcome) VALUES($1,$2,$3,$4::jsonb)",
                command.world_id, command.command_id, digest, json.dumps(outcome),
            )
            await connection.execute(
                "UPDATE world_streams SET current_revision=$2 WHERE world_id=$1", command.world_id, revision
            )
            await self._compact(connection, command.world_id, revision)
            await self._emit(connection, event)
        logger.info("command_accepted world_id=%s revision=%s", command.world_id, revision)
        return outcome, False

    async def _append_system_event(
        self, connection, world_id: str, revision: int, event_type: str, payload: dict, *, retain_outcome: bool = False
    ) -> None:
        command_id = f"system-{event_type}-{revision}"
        event = {
            "protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION,
            "type": "event", "worldId": world_id, "revision": revision,
            "eventType": event_type, "commandId": command_id,
            "payload": payload, "committedAt": datetime.now(timezone.utc).isoformat(),
        }
        await connection.execute(
            "INSERT INTO world_events(world_id,revision,event) VALUES($1,$2,$3::jsonb)",
            world_id, revision, json.dumps(event),
        )
        if retain_outcome:
            # Deaths are looked up from retained command outcomes after event
            # compaction; a lethal system event must be discoverable the same way.
            outcome = {"protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION, "status": "committed", "event": event}
            await connection.execute(
                "INSERT INTO world_commands(world_id, command_id, content_hash, outcome) VALUES($1,$2,$3,$4::jsonb)",
                world_id, command_id, hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest(), json.dumps(outcome),
            )
        await connection.execute("UPDATE world_streams SET current_revision=$2 WHERE world_id=$1", world_id, revision)
        await self._emit(connection, event)

    async def _emit(self, connection, event: dict[str, Any]) -> None:
        """Announce a committed-with-the-transaction event to other processes.

        The owner itself publishes from storage once the transaction commits.
        """
        await connection.execute(
            "SELECT pg_notify($1, $2)", self.channel, json.dumps({"worldId": event["worldId"], "revision": event["revision"]})
        )

    def _runtime(self, world_id: str):
        from app.realtime import WorldRuntime
        runtime = self.runtimes.get(world_id)
        if runtime is None:
            runtime = self.runtimes[world_id] = WorldRuntime(world_id)
        return runtime

    @contextlib.asynccontextmanager
    async def _world(self, world_id: str):
        """Serialize a database transaction with this world's in-memory commits.

        Pending in-memory moves are written first so the resolver sees them; the
        transaction's events are published from storage only after it commits.
        """
        if not self.exclusive:
            yield None
            return
        if not self.holds_ownership():
            raise TransportError("storage_unavailable", "This instance does not own the world", 503)
        runtime = self._runtime(world_id)
        async with runtime.lock:
            # Re-checked after the wait: shutdown or ownership loss may have happened meanwhile.
            if not self.holds_ownership():
                raise TransportError("storage_unavailable", "This instance does not own the world", 503)
            await self._flush(runtime)
            if not runtime.loaded:
                await self._load(runtime)
            yield runtime
            if await self._catch_up(runtime):
                await self._load(runtime)

    async def _load(self, runtime) -> None:
        from app.realtime import STATE_QUERY
        assert self.pool
        runtime.load(await self.pool.fetchrow(STATE_QUERY, runtime.world_id))

    async def _catch_up(self, runtime) -> bool:
        """Publish durable events newer than the runtime has broadcast, in order."""
        assert self.pool
        rows = await self.pool.fetch(
            "SELECT event FROM world_events WHERE world_id=$1 AND revision > $2 ORDER BY revision",
            runtime.world_id, runtime.known,
        )
        runtime.publish_committed([_json_object(row["event"]) for row in rows])
        return bool(rows)

    async def _flush(self, runtime) -> None:
        """Write the in-memory batch after whatever storage already holds.

        Moves committed while the write is in flight join the next batch.
        """
        async with runtime.flushing:
            await self._flush_batch(runtime)

    async def _flush_batch(self, runtime, keep_on_failure: bool = False) -> None:
        """Write the batch. ``keep_on_failure`` restores it for a retry instead of resetting."""
        from app.realtime import FLUSH_QUERY
        if not runtime.unflushed:
            return
        taken = None
        try:
            assert self.pool
            async with self.pool.acquire() as connection, connection.transaction():
                base = await connection.fetchval(
                    "SELECT current_revision FROM world_streams WHERE world_id=$1 FOR UPDATE", runtime.world_id
                )
                await self._fence(connection)
                # Another writer (a Preview backend sharing this schema) committed first.
                foreign = [] if base == runtime.known else await connection.fetch(
                    "SELECT event FROM world_events WHERE world_id=$1 AND revision > $2 ORDER BY revision",
                    runtime.world_id, runtime.known,
                )
                taken = (runtime.unflushed, set(runtime.dirty))
                events, frames, rows, arguments = runtime.flush_arguments(int(base), self.retention_events)
                if await connection.fetchval(FLUSH_QUERY, *arguments) != len(arguments[3]):
                    raise RuntimeError("a position changed outside this runtime")
                await connection.execute("SELECT pg_notify($1, $2)", self.channel, json.dumps({
                    "worldId": runtime.world_id, "from": events[0]["revision"], "revision": events[-1]["revision"],
                }))
        except asyncio.CancelledError:
            # The transaction rolled back; the batch stays in memory for the next writer.
            if taken is not None:
                runtime.unflushed, runtime.dirty = taken[0] + runtime.unflushed, taken[1] | runtime.dirty
            raise
        except Exception as error:
            if isinstance(error, OwnershipLost):
                self._ownership_lost()
                raise
            if keep_on_failure:
                if taken is not None:
                    runtime.unflushed, runtime.dirty = taken[0] + runtime.unflushed, taken[1] | runtime.dirty
                raise
            # Unwritten moves were never broadcast; everyone resynchronizes from storage.
            logger.exception("world_flush_failed world_id=%s", runtime.world_id)
            runtime.reset()
            self._close_subscribers(runtime.world_id, "stream_unavailable")
            raise TransportError("storage_unavailable", "World transport storage is unavailable", 503)
        runtime.publish_committed([_json_object(row["event"]) for row in foreign])
        runtime.flushed(events, frames, rows)
        if foreign:
            # Reload under the world lock on this tick, not beneath live commands.
            runtime.refreshed_at = 0.0

    async def submit_live(self, command: Command, actor: ActorContext) -> dict[str, Any] | None:
        """Commit a socket command. Returns ``None`` when the event will only be streamed.

        Ordinary moves and turns commit in the owner's memory; everything else,
        and every move with a side effect, takes the database path.
        """
        with self._shot_cadence(command, actor):
            return await self._submit_live(command, actor)

    async def _submit_live(self, command: Command, actor: ActorContext) -> dict[str, Any] | None:
        from app.realtime import FAST_ACTIONS
        if self.exclusive and self.holds_ownership() and actor.actor_id and command.action_type in FAST_ACTIONS:
            runtime = self._runtime(command.world_id)
            async with runtime.lock:
                if not runtime.loaded and self.holds_ownership():
                    await self._load(runtime)
                # Checked again with no await before the commit: a command that waited
                # while shutdown drained, or ownership was lost, is never accepted.
                if not self.holds_ownership():
                    raise TransportError("storage_unavailable", "World transport storage is unavailable", 503)
                if runtime.try_command(command, actor.actor_id) is not None:
                    return None
        outcome, _ = await self._submit(command, actor)
        return outcome

    async def _tick_loop(self) -> None:
        clock = time.monotonic
        while not self._closing:
            await asyncio.sleep(BROADCAST_TICK_SECONDS)
            for runtime in tuple(self.runtimes.values()):
                if self._closing:
                    # Shutdown's drain owns the final write.
                    return
                if not (runtime.unflushed or runtime.outbox or clock() - runtime.refreshed_at > RUNTIME_REFRESH_SECONDS):
                    continue
                try:
                    if not self.holds_ownership():
                        runtime.reset()
                        continue
                    # Routine flushes never block live commands; only a reload does.
                    await self._flush(runtime)
                    batch = runtime.drain()
                    if batch is not None:
                        self._deliver(runtime.world_id, batch)
                    if runtime.loaded and clock() - runtime.refreshed_at > RUNTIME_REFRESH_SECONDS:
                        async with runtime.lock:
                            await self._flush(runtime)
                            await self._catch_up(runtime)
                            await self._load(runtime)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("world_tick_failed world_id=%s", runtime.world_id)

    def _deliver(self, world_id: str, item) -> None:
        for subscriber in tuple(self.subscribers.get(world_id, ())):
            try:
                subscriber.queue.put_nowait(item)
            except asyncio.QueueFull:
                subscriber.reason = "slow_consumer"
                subscriber.closed.set()
                logger.warning("slow_consumer_disconnected world_id=%s", world_id)

    def _close_subscribers(self, world_id: str, reason: str) -> None:
        for subscriber in tuple(self.subscribers.get(world_id, ())):
            subscriber.reason = reason
            subscriber.closed.set()

    async def _mob_loop(self) -> None:
        from app.mobs import ACTIVE_WORLDS_QUERY, TICK_SECONDS
        from app.presence import STALE_CONNECTION_SECONDS
        while True:
            try:
                await asyncio.sleep(TICK_SECONDS / 2)
                assert self.pool
                # Only worlds with a connected living player have mobs to run.
                for row in await self.pool.fetch(ACTIVE_WORLDS_QUERY, float(STALE_CONNECTION_SECONDS)):
                    await self.tick_mobs(row["world_id"])
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("mob_tick_sweep_failed")

    async def tick_mobs(self, world_id: str) -> dict[str, Any] | None:
        """Run one due mob tick under the world lock; replicas that lose the lock simply retry next sweep."""
        from app.mobs import EVENT_TYPE, tick
        assert self.pool
        async with self._world(world_id) as runtime, self.pool.acquire() as connection, connection.transaction():
            if runtime is not None:
                await self._fence(connection)
            stream = await connection.fetchrow(
                "SELECT current_revision FROM world_streams WHERE world_id=$1 FOR UPDATE SKIP LOCKED", world_id
            )
            if not stream:
                return None
            payload = await tick(connection, world_id)
            if not payload:
                return None
            revision = int(stream["current_revision"]) + 1
            await self._append_system_event(
                connection, world_id, revision, EVENT_TYPE, payload, retain_outcome=bool(payload.get("eliminatedVictims"))
            )
            await self._compact(connection, world_id, revision)
        return payload

    async def _compact(self, connection: asyncpg.Connection, world_id: str, revision: int) -> None:
        keep_from = max(1, revision - self.retention_events + 1)
        await connection.execute("DELETE FROM world_events WHERE world_id=$1 AND revision<$2", world_id, keep_from)
        await connection.execute("UPDATE world_streams SET oldest_revision=$2 WHERE world_id=$1", world_id, keep_from)

    async def _reconcile_map(self, world_id: str) -> None:
        # Terrain changes preserve accounts and valid locations. Use the same
        # world lock and commit-gated event channel as gameplay commands.
        from app.player_positions import relocate_invalid_positions

        assert self.pool
        async with self._world(world_id) as runtime, self.pool.acquire() as connection, connection.transaction():
            if runtime is not None:
                await self._fence(connection)
            stream = await connection.fetchrow(
                "SELECT current_revision FROM world_streams WHERE world_id=$1 FOR UPDATE", world_id
            )
            if not stream:
                return
            relocated = await relocate_invalid_positions(connection, world_id)
            if runtime is not None:
                runtime.reconciled = True
            revision = int(stream["current_revision"])
            for payload in relocated:
                revision += 1
                event = {
                    "protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION,
                    "type": "event", "worldId": world_id, "revision": revision,
                    "eventType": "player.respawned", "commandId": f"map-relocation-{revision}",
                    "payload": payload, "committedAt": datetime.now(timezone.utc).isoformat(),
                }
                await connection.execute(
                    "INSERT INTO world_events(world_id, revision, event) VALUES($1,$2,$3::jsonb)",
                    world_id, revision, json.dumps(event),
                )
                await self._emit(connection, event)
            if relocated:
                await connection.execute(
                    "UPDATE world_streams SET current_revision=$2 WHERE world_id=$1", world_id, revision
                )
                await self._compact(connection, world_id, revision)

    async def snapshot(self, world_id: str) -> dict[str, Any]:
        if not self.pool:
            raise TransportError("storage_unavailable", "World transport storage is unavailable", 503)
        await self._reconcile_map(world_id)
        # Snapshot access activates a new world's durable cooldown and also
        # materializes overdue work if no replica sweep has run yet.
        if not await self.pool.fetchval("SELECT 1 FROM world_streams WHERE world_id=$1", world_id):
            await self.pool.execute("INSERT INTO world_streams(world_id) VALUES($1) ON CONFLICT DO NOTHING", world_id)
        async with self.pool.acquire() as connection, connection.transaction(isolation="repeatable_read", readonly=True):
            row = await connection.fetchrow("SELECT current_revision FROM world_streams WHERE world_id=$1", world_id)
            revision = int(row["current_revision"]) if row else 0
            positions = await connection.fetch(
                """SELECT pp.*, p.name, p.avatar
                   FROM player_positions pp
                   JOIN players p ON p.id=pp.player_id WHERE pp.world_id=$1 ORDER BY pp.player_id""",
                world_id,
            )
            players = [{"playerId": str(item["player_id"]), "name": item["name"], "avatar": item["avatar"],
                        "x": item["x"], "y": item["y"], "positionRevision": item["revision"],
                        "facing": item["facing"]} for item in positions]
            server_time = await connection.fetchval("SELECT clock_timestamp()")
            deaths = await connection.fetch(VICTIM_DEATHS_QUERY, world_id)
            active = {item["playerId"] for item in players}
            from app.mobs import public_mobs, public_projectiles
            mobs = await public_mobs(connection, world_id)
            projectiles = await public_projectiles(connection, world_id)
            return {
                "protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION, "worldId": world_id,
                "revision": revision, "serverTime": server_time.astimezone(timezone.utc).isoformat(),
                "state": {
                    "players": players,
                    "eliminated": {row["player_id"]: row["revision"] for row in deaths if row["player_id"] not in active},
                    "deathAttribution": {row["player_id"]: row["attacker_name"] for row in deaths if row["player_id"] not in active},
                    "mobs": mobs,
                    "mobProjectiles": projectiles,
                },
            }

    async def replay(self, world_id: str, after_revision: int) -> list[dict[str, Any]]:
        if not self.pool:
            raise TransportError("storage_unavailable", "World transport storage is unavailable", 503)
        row = await self.pool.fetchrow("SELECT current_revision, oldest_revision FROM world_streams WHERE world_id=$1", world_id)
        if not row:
            return []
        if after_revision < int(row["oldest_revision"]) - 1:
            raise TransportError("stale_cursor", "Requested history is no longer retained", 409, {"snapshotRequired": True})
        rows = await self.pool.fetch(
            "SELECT event FROM world_events WHERE world_id=$1 AND revision>$2 ORDER BY revision", world_id, after_revision
        )
        return [_json_object(item["event"]) for item in rows]

    def subscribe(self, world_id: str) -> Subscriber:
        subscriber = Subscriber(asyncio.Queue(self.queue_size))
        self.subscribers.setdefault(world_id, set()).add(subscriber)
        return subscriber

    def unsubscribe(self, world_id: str, subscriber: Subscriber) -> None:
        self.subscribers.get(world_id, set()).discard(subscriber)

    async def publish_taunt(self, world_id: str, player_id: str) -> bool:
        """Broadcast a live-only taunt without advancing or persisting world history.

        Only a placed (living) player may taunt; defeat deletes the position row.
        """
        if not self.pool:
            raise TransportError("storage_unavailable", "World transport storage is unavailable", 503)
        try:
            actor_id = uuid.UUID(player_id)
        except ValueError:
            return False
        if not await self.pool.fetchval(
            "SELECT 1 FROM player_positions WHERE world_id=$1 AND player_id=$2", world_id, actor_id,
        ):
            return False
        message = {
            "protocolVersion": PROTOCOL_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "type": "taunt",
            "worldId": world_id,
            "playerId": player_id,
        }
        if self.exclusive:
            self._deliver(world_id, message)
        else:
            await self.pool.execute(
                "SELECT pg_notify($1, $2)", self.channel, json.dumps({"worldId": world_id, "transient": message}),
            )
        return True

    def _notification(self, connection: asyncpg.Connection, pid: int, channel: str, payload: str) -> None:
        del connection, pid, channel
        try:
            self._notifications.put_nowait(json.loads(payload))
        except asyncio.QueueFull:
            logger.error("stream_notification_overflow")
            for subscribers in self.subscribers.values():
                for subscriber in subscribers:
                    subscriber.reason = "stream_overflow"
                    subscriber.closed.set()

    async def _consume_notifications(self) -> None:
        while True:
            notice = await self._notifications.get()
            try:
                await self._publish_notification(notice)
            except Exception:
                logger.exception("stream_notification_failed")
                for subscriber in tuple(self.subscribers.get(notice.get("worldId"), ())):
                    subscriber.reason = "stream_unavailable"
                    subscriber.closed.set()

    async def _publish_notification(self, notice: dict[str, Any]) -> None:
        transient = notice.get("transient")
        if isinstance(transient, dict):
            self._deliver(notice["worldId"], transient)
            return
        assert self.pool
        # The world owner announces each written batch as one revision range.
        first = notice.get("from", notice["revision"])
        events = await self.pool.fetch(
            "SELECT event FROM world_events WHERE world_id=$1 AND revision BETWEEN $2 AND $3 ORDER BY revision",
            notice["worldId"], first, notice["revision"],
        )
        if len(events) != notice["revision"] - first + 1:
            for subscriber in tuple(self.subscribers.get(notice["worldId"], ())):
                subscriber.reason = "history_compacted"
                subscriber.closed.set()
            return
        for row in events:
            event = _json_object(row["event"])
            for subscriber in tuple(self.subscribers.get(notice["worldId"], ())):
                try:
                    subscriber.queue.put_nowait(event)
                except asyncio.QueueFull:
                    subscriber.reason = "slow_consumer"
                    subscriber.closed.set()
                    logger.warning("slow_consumer_disconnected world_id=%s", notice["worldId"])


def validate_world_id(world_id: str) -> None:
    if not world_id or len(world_id) > WORLD_ID_MAX_LENGTH or not all(char.isalnum() or char in "-_" for char in world_id):
        raise TransportError("invalid_world", "worldId must contain only letters, numbers, '-' or '_' and be at most 80 characters")


async def purge_world(pool, world_id: str) -> None:
    """Remove every transport record for an isolated verification world."""
    async with pool.acquire() as connection, connection.transaction():
        await connection.execute("DELETE FROM world_commands WHERE world_id=$1", world_id)
        await connection.execute("DELETE FROM world_events WHERE world_id=$1", world_id)
        await connection.execute("DELETE FROM world_streams WHERE world_id=$1", world_id)
