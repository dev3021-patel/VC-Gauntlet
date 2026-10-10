"""Server-authoritative, collision-free player placement and movement."""

from __future__ import annotations

import json
import secrets
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path

from app import avatar_claims
from app.eliminations import VICTIM_DEATHS_QUERY
from app.hitboxes import laser_strike
from app.world_transport import ActorContext, Command, TransportError

MAP_LAYOUT = json.loads(Path(__file__).with_name("map-layout.json").read_text())
MOVEMENT_BLOCK_SIZE = MAP_LAYOUT["movementBlockSize"]
MOVEMENT_WORLD_SIZE = len(MAP_LAYOUT["rows"])
TERRAIN_WORLD_SIZE = MOVEMENT_WORLD_SIZE * MOVEMENT_BLOCK_SIZE
WORLD_SIZE = MOVEMENT_WORLD_SIZE
COORDINATE_VERSION = MAP_LAYOUT["coordinateVersion"]
DIRECTIONS = {
    "north": (0, -1),
    "south": (0, 1),
    "west": (-1, 0),
    "east": (1, 0),
}
# The laser crosses the whole map; only terrain, the map edge, or the first unit stops it.
LASER_RANGE = MOVEMENT_WORLD_SIZE
POSITION_EVENTS = ("player.placed", "player.moved", "player.respawned")
# Turning in place changes orientation only; it never alters occupancy.
FACING_EVENTS = (*POSITION_EVENTS, "player.faced")
ACTIONS = frozenset({"player.place", "player.move", "player.shoot", "player.face", "player.avatar"})


def block_terrain(x: int, y: int) -> str:
    if not 0 <= x < MOVEMENT_WORLD_SIZE or not 0 <= y < MOVEMENT_WORLD_SIZE:
        return "water"
    return MAP_LAYOUT["legend"][MAP_LAYOUT["rows"][y][x]]


def terrain_at(x: int, y: int) -> str:
    return block_terrain(x // MOVEMENT_BLOCK_SIZE, y // MOVEMENT_BLOCK_SIZE)


def block_is_traversable(block_x: int, block_y: int) -> bool:
    return block_terrain(block_x, block_y) in {"land", "bridge", "courtyard"}


TRAVERSABLE_BLOCKS: tuple[tuple[int, int], ...] = tuple(
    (x, y) for y in range(MOVEMENT_WORLD_SIZE) for x in range(MOVEMENT_WORLD_SIZE) if block_is_traversable(x, y)
)


def cell_is_passable(block_x: int, block_y: int, blocked: set[tuple[int, int]] | None = None) -> bool:
    return block_is_traversable(block_x, block_y) and (block_x, block_y) not in (blocked or ())


def safe_spawn_block(
    cell: tuple[int, int],
    occupied: set[tuple[int, int]],
    blocked: set[tuple[int, int]] | None = None,
) -> bool:
    x, y = cell
    shut = blocked or set()
    return cell not in occupied and cell_is_passable(x, y, shut) and any(
        (x + dx, y + dy) not in occupied and cell_is_passable(x + dx, y + dy, shut)
        for dx, dy in DIRECTIONS.values()
    )


def _coordinate(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TransportError("invalid_position", f"{name} must be an integer", 422)
    return value


def _public_position(row, facing: str = "south") -> dict:
    return {
        "playerId": str(row["player_id"]),
        "name": row["name"],
        "avatar": row["avatar"],
        "x": row["x"],
        "y": row["y"],
        "positionRevision": row["revision"],
        "facing": facing,
    }


async def current_facing(connection, world_id: str, player_id: uuid.UUID) -> str:
    """Orientation is stored with the position by every FACING_EVENTS writer."""
    return await connection.fetchval(
        "SELECT facing FROM player_positions WHERE world_id=$1 AND player_id=$2", world_id, player_id,
    ) or "south"


def arrow_path(
    x: int,
    y: int,
    facing: str,
    maximum_distance: int = LASER_RANGE,
    blocked: set[tuple[int, int]] | None = None,
) -> list[tuple[int, int]]:
    """Return the traversable cells a laser crosses, nearest first."""
    return ray_path(x, y, DIRECTIONS[facing], maximum_distance, blocked)


def shot_facing(payload: dict, committed: str) -> str:
    """A shot may name the shooter's newest heading so a press mid-turn never
    resolves from an orientation the player has already left."""
    requested = payload.get("facing")
    return requested if requested in DIRECTIONS else committed


def ray_path(
    x: int,
    y: int,
    offset: tuple[int, int],
    maximum_distance: int,
    blocked: set[tuple[int, int]] | None = None,
) -> list[tuple[int, int]]:
    path = []
    for distance in range(1, maximum_distance + 1):
        cell = (x + offset[0] * distance, y + offset[1] * distance)
        if not cell_is_passable(*cell, blocked):
            break
        path.append(cell)
    return path


def first_spawn_block(
    suggested: tuple[int, int] | None,
    occupied: set[tuple[int, int]],
    choose: Callable[[Sequence[tuple[int, int]]], tuple[int, int]] = secrets.choice,
    blocked: set[tuple[int, int]] | None = None,
) -> tuple[int, int] | None:
    if suggested is not None and safe_spawn_block(suggested, occupied, blocked):
        return suggested
    available = [cell for cell in TRAVERSABLE_BLOCKS if safe_spawn_block(cell, occupied, blocked)]
    return choose(available) if available else None


async def relocate_invalid_positions(connection, world_id: str) -> list[dict]:
    """Caller holds the world lock. Reserve valid players before relocating anyone."""
    rows = await connection.fetch(
        """SELECT pp.*, p.name, p.avatar FROM player_positions pp
           JOIN players p ON p.id=pp.player_id WHERE pp.world_id=$1 ORDER BY pp.player_id""",
        world_id,
    )
    from app.mobs import mob_cells
    occupied = {(row["x"], row["y"]) for row in rows} | await mob_cells(connection, world_id)
    relocated = []
    for existing in rows:
        origin = (existing["x"], existing["y"])
        if block_is_traversable(*origin):
            continue
        chosen = first_spawn_block(None, occupied)
        if chosen is None:
            raise TransportError("no_spawn_available", "Map relocation has no safe destination. Try again shortly.", 409)
        row = await connection.fetchrow(
            """UPDATE player_positions SET x=$3, y=$4, revision=revision+1, facing='south', updated_at=now()
               WHERE world_id=$1 AND player_id=$2
               RETURNING *, (SELECT name FROM players WHERE id=$2) name,
                            (SELECT avatar FROM players WHERE id=$2) avatar""",
            world_id, existing["player_id"], *chosen,
        )
        occupied.discard(origin)
        occupied.add(chosen)
        relocated.append(_public_position(row))
    return relocated


# Clients pipeline moves ahead of confirmation, so a projectile fired mid-glide
# may carry a revision a few moves behind. It always launches from the committed
# cell and facing, so a small lag is safe; a new life starts at the world
# revision, far beyond this window, so shots from a previous life stay stale.
PROJECTILE_ACTIONS = frozenset({"player.shoot"})
PROJECTILE_REVISION_LAG = 8


def revision_is_current(action_type: str, expected: int, current: int) -> bool:
    if action_type in PROJECTILE_ACTIONS:
        return current - PROJECTILE_REVISION_LAG <= expected <= current
    return expected == current


async def _player_row(connection, world_id: str, player_id: uuid.UUID):
    return await connection.fetchrow(
        """SELECT pp.*, p.name, p.avatar FROM player_positions pp
           JOIN players p ON p.id=pp.player_id WHERE pp.world_id=$1 AND pp.player_id=$2""",
        world_id, player_id,
    )


async def _place(connection, command: Command, actor_id: uuid.UUID, existing) -> tuple[str, dict]:
    if existing:
        return "player.placed", _public_position(existing, await current_facing(connection, command.world_id, actor_id))
    # Commands are retained even when the replay event window is compacted.
    death_revision = await connection.fetchval(
        f"SELECT revision FROM ({VICTIM_DEATHS_QUERY}) deaths WHERE player_id=$2",
        command.world_id, str(actor_id),
    )
    if death_revision is not None and command.payload.get("expectedDeathRevision") != death_revision:
        raise TransportError("not_active", "You were defeated. Rejoin the world to begin a new life.", 409)
    # A returning player whose saved avatar is held by a connected player picks
    # another one here; spawning never proceeds on a contested built-in avatar.
    chosen_avatar = command.payload.get("avatar")
    if chosen_avatar is not None:
        await avatar_claims.ensure_selectable(connection, actor_id, chosen_avatar)
        await connection.execute("UPDATE players SET avatar=$2 WHERE id=$1", actor_id, chosen_avatar)
    if not await avatar_claims.claim_saved(connection, command.world_id, actor_id):
        raise TransportError("avatar_in_use", avatar_claims.AVATAR_IN_USE_MESSAGE, 409)
    suggested = command.payload.get("suggestedPosition")
    suggested_block = None
    if isinstance(suggested, dict):
        x, y = suggested.get("x"), suggested.get("y")
        if isinstance(x, int) and not isinstance(x, bool) and isinstance(y, int) and not isinstance(y, bool):
            suggested_block = (x, y)
    occupied_rows = await connection.fetch("SELECT x, y FROM player_positions WHERE world_id=$1", command.world_id)
    from app.mobs import mob_cells
    occupied_blocks = {(row["x"], row["y"]) for row in occupied_rows} | await mob_cells(connection, command.world_id)
    chosen = first_spawn_block(suggested_block, occupied_blocks)
    if chosen is None:
        raise TransportError("no_spawn_available", "No safe destination is available. Try joining again shortly.", 409)
    row = await connection.fetchrow(
        """INSERT INTO player_positions(world_id, player_id, x, y, revision)
           VALUES($1,$2,$3,$4,(SELECT current_revision+1 FROM world_streams WHERE world_id=$1))
           RETURNING *, (SELECT name FROM players WHERE id=$2) name,
                        (SELECT avatar FROM players WHERE id=$2) avatar""",
        command.world_id, actor_id, *chosen,
    )
    payload = _public_position(row)
    payload["firstSpawn"] = death_revision is None
    return "player.placed", payload


async def _shoot(connection, command: Command, actor_id: uuid.UUID, existing) -> tuple[str, dict]:
    """One laser: ended by terrain or the map edge, or hitting only the first body it touches.

    Players are struck on their lane cell; enemies anywhere their drawn body
    (``app.hitboxes``) overlaps the beam, including off the lane.
    """
    facing = shot_facing(command.payload, await current_facing(connection, command.world_id, actor_id))
    path = arrow_path(existing["x"], existing["y"], facing)
    target = None
    if path:
        target = await connection.fetchrow(
            """SELECT pp.*, p.name, p.avatar FROM player_positions pp
               JOIN players p ON p.id=pp.player_id
               JOIN unnest($3::integer[], $4::integer[]) WITH ORDINALITY path(x,y,step)
                 ON path.x=pp.x AND path.y=pp.y
               WHERE pp.world_id=$1 AND pp.player_id<>$2
               ORDER BY path.step LIMIT 1 FOR UPDATE OF pp""",
            command.world_id, actor_id, [cell[0] for cell in path], [cell[1] for cell in path],
        )
    from app.mobs import damage_mob, mob_on_path
    origin = (existing["x"], existing["y"])
    mob = await mob_on_path(connection, command.world_id, origin, facing, path)
    # The nearer of the first player and the first mob wins; the beam ends on its contact cell.
    bodies = {(row["x"], row["y"]): row for row in (target, mob) if row}
    struck, kept = laser_strike(origin, DIRECTIONS[facing], len(path), bodies)
    path = path[:kept]
    victims = []
    mob_hits = []
    if mob and struck == (mob["x"], mob["y"]):
        mob_hits.append(await damage_mob(connection, command.world_id, mob, 1))
    elif target and struck == (target["x"], target["y"]):
        # Player hits are one-hit eliminations; removal stays with the elimination consumer.
        victims.append(_public_position(target, await current_facing(connection, command.world_id, target["player_id"])))
    return "player.shot", {
        "shotId": command.command_id,
        "shooterId": str(actor_id),
        "shooterName": existing["name"],
        "facing": facing,
        "origin": {"x": existing["x"], "y": existing["y"]},
        "path": [{"x": x, "y": y} for x, y in path],
        "victim": victims[0] if victims else None,
        "victims": victims,
        "combatElimination": {"attackerId": str(actor_id), "victims": victims},
        "mobHits": mob_hits,
    }


async def _move(connection, command: Command, actor_id: uuid.UUID, existing) -> tuple[str, dict]:
    expected = command.payload.get("expected")
    destination = command.payload.get("destination")
    if not isinstance(expected, dict) or not isinstance(destination, dict):
        raise TransportError("invalid_move", "expected and destination positions are required", 422)
    ex, ey = _coordinate(expected.get("x"), "expected.x"), _coordinate(expected.get("y"), "expected.y")
    x, y = _coordinate(destination.get("x"), "destination.x"), _coordinate(destination.get("y"), "destination.y")
    if (ex, ey) != (existing["x"], existing["y"]):
        raise TransportError("stale_position", "Player position has advanced", 409, {
            "position": _public_position(existing, await current_facing(connection, command.world_id, actor_id))
        })
    facing = next((name for name, offset in DIRECTIONS.items() if offset == (x - ex, y - ey)), None)
    if facing is None:
        raise TransportError("invalid_move", "Moves must be one orthogonal block", 422)
    if not block_is_traversable(x, y):
        raise TransportError("blocked_terrain", "Destination block is not traversable", 409)
    if await connection.fetchval(
        "SELECT 1 FROM player_positions WHERE world_id=$1 AND x=$2 AND y=$3", command.world_id, x, y
    ):
        raise TransportError("occupied", "Destination is occupied", 409)
    from app.mobs import mob_occupies
    if await mob_occupies(connection, command.world_id, x, y):
        raise TransportError("occupied", "Destination is occupied by an enemy", 409)
    row = await connection.fetchrow(
        """UPDATE player_positions SET x=$3, y=$4, revision=revision+1, facing=$5, updated_at=now()
           WHERE world_id=$1 AND player_id=$2
           RETURNING *, (SELECT name FROM players WHERE id=$2) name,
                        (SELECT avatar FROM players WHERE id=$2) avatar""",
        command.world_id, actor_id, x, y, facing,
    )
    return "player.moved", _public_position(row, facing)


async def position_resolver(command: Command, actor: ActorContext, connection) -> tuple[str, dict]:
    if command.action_type not in ACTIONS:
        raise TransportError("unsupported_action", f"Action type '{command.action_type}' is not supported", 422)
    if not actor.actor_id:
        raise TransportError("unauthorized", "Sign in to place or move a player", 401)
    try:
        actor_id = uuid.UUID(actor.actor_id)
    except ValueError as exc:
        raise TransportError("unauthorized", "Invalid authenticated player", 401) from exc

    # Avatar selection belongs to the account, not a life or position revision.
    # Keep the positioned response for existing clients during rolling deploys.
    if command.action_type == "player.avatar":
        avatar = command.payload.get("avatar")
        await avatar_claims.ensure_selectable(connection, actor_id, avatar)
        if not await avatar_claims.claim(connection, command.world_id, actor_id, avatar):
            raise TransportError("avatar_in_use", avatar_claims.AVATAR_IN_USE_MESSAGE, 409)
        await connection.execute("UPDATE players SET avatar=$2 WHERE id=$1", actor_id, avatar)
        row = await _player_row(connection, command.world_id, actor_id)
        payload = (_public_position(row, await current_facing(connection, command.world_id, actor_id))
                   if row else {"playerId": str(actor_id), "avatar": avatar})
        return "player.avatar_changed", payload

    existing = await _player_row(connection, command.world_id, actor_id)
    if existing and not block_is_traversable(existing["x"], existing["y"]):
        raise TransportError("no_spawn_available", "Map relocation has no safe destination. Try again shortly.", 409)
    if command.action_type == "player.place":
        return await _place(connection, command, actor_id, existing)
    if not existing:
        raise TransportError("not_active", "Player must be active before acting", 409)
    expected_revision = command.payload.get("expectedRevision")
    if isinstance(expected_revision, bool) or not isinstance(expected_revision, int) or not revision_is_current(
        command.action_type, expected_revision, existing["revision"]
    ):
        raise TransportError("stale_position", "Player position has advanced; synchronize and try again", 409)
    if command.action_type == "player.shoot":
        return await _shoot(connection, command, actor_id, existing)
    if command.action_type == "player.face":
        facing = command.payload.get("facing")
        if facing not in DIRECTIONS:
            raise TransportError("invalid_facing", "facing must be north, south, east, or west", 422)
        await connection.execute(
            "UPDATE player_positions SET facing=$3 WHERE world_id=$1 AND player_id=$2", command.world_id, actor_id, facing,
        )
        return "player.faced", _public_position(existing, facing)
    return await _move(connection, command, actor_id, existing)
