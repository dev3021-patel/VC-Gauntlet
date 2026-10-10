"""In-memory movement authority for one world, owned by a single backend process.

Ordinary steps, turns, and missed shots are the overwhelming majority of
commands. They are validated here against an exact in-memory copy of occupancy
and mobs, then persisted and broadcast in batches. Anything this runtime cannot
answer exactly — a player it does not know, or an off-map position — returns ``None`` so the caller uses the database resolver,
which stays the single source of every side effect. A shot that could hit
anything is one of those.

World revisions are assigned when a batch is written, under the stream row
lock, so another writer on the same database (a Preview backend) interleaves
safely; nothing is broadcast before it is durable.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.player_positions import (
    LASER_RANGE, DIRECTIONS, _public_position, arrow_path, block_is_traversable, revision_is_current, shot_facing,
)
from app.hitboxes import laser_strike
from app.world_transport import PROTOCOL_VERSION, SCHEMA_VERSION, TransportError

Cell = tuple[int, int]
FAST_ACTIONS = frozenset({"player.move", "player.face", "player.shoot"})

STATE_QUERY = """
SELECT
  (SELECT current_revision FROM world_streams WHERE world_id=$1) revision,
  (SELECT coalesce(json_agg(json_build_object(
      'player_id', pp.player_id, 'name', p.name, 'avatar', p.avatar, 'x', pp.x, 'y', pp.y,
      'revision', pp.revision, 'facing', pp.facing)), '[]')
     FROM player_positions pp JOIN players p ON p.id=pp.player_id WHERE pp.world_id=$1) positions,
  (SELECT coalesce(json_agg(json_build_array(x, y)), '[]') FROM world_mobs WHERE world_id=$1) mobs
"""

# One statement persists a whole batch (inside the transaction holding the
# stream row lock). The cell constraint is deferred to the end of the statement,
# so chained moves inside one batch never collide. A position another writer
# advanced is not overwritten: the moved count comes back short instead.
FLUSH_QUERY = """
WITH appended AS (
  INSERT INTO world_events(world_id, revision, event)
  SELECT $1, item.revision, item.event::jsonb FROM unnest($2::bigint[], $3::text[]) AS item(revision, event)
), moved AS (
  UPDATE player_positions pp
  SET x=item.x, y=item.y, revision=item.revision, facing=item.facing, updated_at=now()
  FROM unnest($4::uuid[], $5::integer[], $6::integer[], $7::bigint[], $8::text[], $9::bigint[])
    AS item(player_id, x, y, revision, facing, stored_revision)
  WHERE pp.world_id=$1 AND pp.player_id=item.player_id AND pp.revision=item.stored_revision
  RETURNING 1
), compacted AS (
  DELETE FROM world_events WHERE world_id=$1 AND revision < $11
), stream AS (
  UPDATE world_streams SET current_revision=$10, oldest_revision=$11 WHERE world_id=$1
)
SELECT count(*) FROM moved
"""


@dataclass(frozen=True)
class Batch:
    """Events in revision order, serialized once for every subscriber."""

    events: tuple[dict[str, Any], ...]
    event_frames: tuple[str, ...]
    frame: str

    @property
    def first_revision(self) -> int:
        return self.events[0]["revision"]

    @property
    def last_revision(self) -> int:
        return self.events[-1]["revision"]

    @classmethod
    def of(cls, world_id: str, events: list[dict[str, Any]], frames: list[str]) -> "Batch":
        frame = (
            f'{{"protocolVersion":{PROTOCOL_VERSION},"schemaVersion":{SCHEMA_VERSION},'
            f'"type":"batch","worldId":{json.dumps(world_id)},"events":[{",".join(frames)}]}}'
        )
        return cls(tuple(events), tuple(frames), frame)


@dataclass(eq=False)
class WorldRuntime:
    world_id: str
    loaded: bool = False
    # Last revision queued for broadcast; anything newer in storage came from another writer.
    known: int = 0
    players: dict[str, dict[str, Any]] = field(default_factory=dict)
    occupied: dict[Cell, str] = field(default_factory=dict)
    mobs: set[Cell] = field(default_factory=set)
    refreshed_at: float = 0.0
    # Committed in memory, not yet written; revisions are assigned by the flush.
    unflushed: list[dict[str, Any]] = field(default_factory=list)
    dirty: set[str] = field(default_factory=set)
    # Durable events waiting for the next broadcast tick.
    outbox: list[tuple[dict[str, Any], str]] = field(default_factory=list)
    reconciled: bool = False
    # Held by database transactions and reloads, which live commands must not interleave with.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # Serializes batch writes so each one numbers its events after the last.
    flushing: asyncio.Lock = field(default_factory=asyncio.Lock)

    def load(self, row) -> None:
        """Replace every cache from one STATE_QUERY row. Callers flush first."""
        now = time.monotonic()
        if not self.loaded:
            self.known = int(row["revision"] or 0)
        self.players = {str(item["player_id"]): item for item in json.loads(row["positions"])}
        for item in self.players.values():
            item["stored_revision"] = item["revision"]
        self.occupied = {(item["x"], item["y"]): player_id for player_id, item in self.players.items()}
        self.mobs = {tuple(cell) for cell in json.loads(row["mobs"])}
        self.refreshed_at = now
        self.loaded = True

    def publish(self, event: dict[str, Any]) -> None:
        self.outbox.append((event, json.dumps(event, separators=(",", ":"))))

    def drain(self) -> Batch | None:
        if not self.outbox:
            return None
        events, frames = zip(*self.outbox)
        self.outbox = []
        return Batch.of(self.world_id, list(events), list(frames))

    def flush_arguments(self, base: int, retention_events: int):
        """Take the unwritten batch, number it after ``base``, and build FLUSH_QUERY arguments.

        Positions are copied, so moves committed while the write is in flight
        start the next batch.
        """
        events, dirty = self.unflushed, self.dirty
        self.unflushed, self.dirty = [], set()
        for offset, event in enumerate(events, start=1):
            event["revision"] = base + offset
        frames = [json.dumps(event, separators=(",", ":")) for event in events]
        rows = [
            (player_id, row["x"], row["y"], row["revision"], row["facing"], row["stored_revision"])
            for player_id in dirty for row in (self.players[player_id],)
        ]
        columns = [list(column) for column in zip(*rows)] if rows else [[] for _ in range(6)]
        last = base + len(events)
        return events, frames, rows, (
            self.world_id, [event["revision"] for event in events], frames, *columns,
            last, max(1, last - retention_events + 1),
        )

    def flushed(self, events: list[dict[str, Any]], frames: list[str], rows: list[tuple]) -> None:
        for player_id, _, _, revision, *_ in rows:
            if player_id in self.players:
                self.players[player_id]["stored_revision"] = revision
        self.outbox.extend(zip(events, frames))
        self.known = events[-1]["revision"]

    def publish_committed(self, events: list[dict[str, Any]]) -> None:
        """Queue durable events already written by a transaction, in revision order."""
        for event in events:
            if event["revision"] > self.known:
                self.publish(event)
                self.known = event["revision"]

    def reset(self) -> None:
        """Forget every uncommitted and undelivered event; the next command reloads."""
        self.unflushed, self.dirty, self.outbox = [], set(), []
        self.loaded = False

    def try_command(self, command, actor_id: str) -> dict[str, Any] | None:
        """Commit an ordinary move or turn in memory.

        Returns the event, raises the resolver's own rejection when memory
        answers it exactly, or returns ``None`` when the database must decide.
        """
        row = self.players.get(actor_id)
        if not self.loaded or row is None or not block_is_traversable(row["x"], row["y"]):
            return None
        payload = command.payload
        expected_revision = payload.get("expectedRevision")
        if command.action_type == "player.shoot":
            if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or not revision_is_current(command.action_type, expected_revision, row["revision"]):
                raise TransportError("stale_position", "Player position has advanced; synchronize and try again", 409)
            return self._miss(command, row)
        if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or expected_revision != row["revision"]:
            raise TransportError("stale_position", "Player position has advanced; synchronize and try again", 409)
        if command.action_type == "player.face":
            facing = payload.get("facing")
            if facing not in DIRECTIONS:
                raise TransportError("invalid_facing", "facing must be north, south, east, or west", 422)
            row["facing"] = facing
            return self._commit(command, "player.faced", row)
        expected, destination = payload.get("expected"), payload.get("destination")
        if not isinstance(expected, dict) or not isinstance(destination, dict):
            return None
        origin = (expected.get("x"), expected.get("y"))
        target = (destination.get("x"), destination.get("y"))
        if not all(isinstance(value, int) and not isinstance(value, bool) for value in (*origin, *target)):
            return None
        if origin != (row["x"], row["y"]):
            raise TransportError("stale_position", "Player position has advanced", 409, {
                "position": _public_position(row, row["facing"]),
            })
        facing = next((name for name, offset in DIRECTIONS.items() if offset == (target[0] - origin[0], target[1] - origin[1])), None)
        if facing is None:
            raise TransportError("invalid_move", "Moves must be one orthogonal block", 422)
        if not block_is_traversable(*target):
            raise TransportError("blocked_terrain", "Destination block is not traversable", 409)
        if target in self.occupied:
            raise TransportError("occupied", "Destination is occupied", 409)
        if target in self.mobs:
            raise TransportError("occupied", "Destination is occupied by an enemy", 409)
        del self.occupied[origin]
        self.occupied[target] = actor_id
        row["x"], row["y"], row["revision"], row["facing"] = *target, row["revision"] + 1, facing
        return self._commit(command, "player.moved", row)

    def _miss(self, command, row: dict[str, Any]) -> dict[str, Any] | None:
        """The resolver's laser payload when its lane touches no player or enemy body."""
        facing = shot_facing(command.payload, row["facing"] or "south")
        path = arrow_path(row["x"], row["y"], facing, LASER_RANGE)
        # Cached mobs carry no kind, so each counts as the larger square body; a near miss takes the resolver.
        bodies = {**{cell: {"kind": "basic"} for cell in self.mobs}, **{cell: {} for cell in self.occupied if cell != (row["x"], row["y"])}}
        if laser_strike((row["x"], row["y"]), DIRECTIONS[facing], len(path), bodies)[0] is not None:
            return None
        cells = [{"x": x, "y": y} for x, y in path]
        return self._commit(command, "player.shot", row, {
            "shotId": command.command_id, "shooterId": str(row["player_id"]), "shooterName": row["name"],
            "facing": facing, "origin": {"x": row["x"], "y": row["y"]}, "path": cells,
            "victim": None, "victims": [], "eliminatedVictims": [],
            "mobHits": [],
        })

    def _commit(self, command, event_type: str, row: dict[str, Any], payload: dict[str, Any] | None = None) -> dict[str, Any]:
        event = {
            "protocolVersion": PROTOCOL_VERSION, "schemaVersion": SCHEMA_VERSION,
            "type": "event", "worldId": self.world_id, "revision": None,
            "eventType": event_type, "commandId": command.command_id,
            "payload": _public_position(row, row["facing"]) if payload is None else payload,
            "committedAt": datetime.now(timezone.utc).isoformat(),
        }
        self.unflushed.append(event)
        if payload is None:
            self.dirty.add(str(row["player_id"]))
        return event
