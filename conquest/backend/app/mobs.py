"""Server-authoritative enemy mobs: spawning, pursuit, melee attacks, and defeat.

Every decision (spawn cell, target, path step, attack) is made on the backend
while the caller holds the per-world stream lock, so replicas never disagree
and clients only ever render committed outcomes. ``plan_tick`` is pure so the
AI rules are unit-testable; ``tick`` applies a plan inside the world
transaction and reuses the shared elimination consumer. Melee ``basic`` mobs
chase and swing; ``ranged`` mobs stop on a clear line, wind up, and fire one
straight, non-homing projectile. Three arrow hits defeat either kind, and a
defeat awards nothing.
"""

from __future__ import annotations

import json
import math
import secrets
import uuid
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from datetime import datetime

from app.eliminations import resolve_eliminations
from app.hitboxes import body_contact, body_kind, laser_strike, segment_box
from app.player_positions import DIRECTIONS, MOVEMENT_WORLD_SIZE, TRAVERSABLE_BLOCKS, _public_position, block_is_traversable, current_facing, first_spawn_block, safe_spawn_block
from app.presence import STALE_CONNECTION_SECONDS

# One connected living player draws three mobs; two or more draw four, and four
# is the absolute cap. Worlds already above the target keep the extras.
SOLO_POPULATION = 3
POPULATION_CAP = 4
MAX_MOBS = POPULATION_CAP
MOB_HEALTH = 3
MOB_NAME = "a mob"
MOB_KIND = "basic"
RANGED_KIND = "ranged"
MOB_KINDS = (MOB_KIND, RANGED_KIND)
# Mobs act on the server clock: idle AI at most every 400 ms, live physics every
# 50 ms, movement at 1.5x the original speed, and melee swings every 1.5 s.
TICK_SECONDS = 0.05
AI_TICK_SECONDS = 0.4
MOVE_SECONDS = 0.8 / 1.5
ATTACK_COOLDOWN_SECONDS = 1.5
SPAWN_INTERVAL_SECONDS = 6.0
# Ranged shots aim in any direction within 32 cells. Physics advances at 20 Hz;
# swept collisions check the entire segment, including walls and unit bodies (app.hitboxes).
RANGED_RANGE = 32
WINDUP_SECONDS = 0.8
RANGED_COOLDOWN_SECONDS = 3.0
RANGED_RESPAWN_SECONDS = 10.0
PROJECTILE_SPEED = 50.0
SHOT_CELLS_PER_TICK = PROJECTILE_SPEED * TICK_SECONDS
PROJECTILE_RADIUS = 0.15
# Spawns stay beyond the four-cell arrow reach of every connected player.
SPAWN_CLEARANCE = 5
EVENT_TYPE = "mob.tick"

Cell = tuple[int, int]
Chooser = Callable[[Sequence[Cell]], Cell]

CONNECTED_PLAYERS_QUERY = """
    SELECT pp.*, p.name, p.avatar FROM player_positions pp
    JOIN players p ON p.id=pp.player_id
    WHERE pp.world_id=$1 AND EXISTS (
        SELECT 1 FROM player_world_connections c
        WHERE c.world_id=pp.world_id AND c.player_id=pp.player_id
          AND c.last_seen_at > transaction_timestamp() - make_interval(secs=>$2)
    )
    ORDER BY pp.player_id
"""
ACTIVE_WORLDS_QUERY = """
    SELECT DISTINCT pp.world_id FROM player_positions pp
    JOIN player_world_connections c ON c.world_id=pp.world_id AND c.player_id=pp.player_id
    WHERE c.last_seen_at > now() - make_interval(secs=>$1)
"""


def chebyshev(first: Cell, second: Cell) -> int:
    return max(abs(first[0] - second[0]), abs(first[1] - second[1]))


def population_target(player_count: int) -> int:
    """Living mobs to maintain for the current connected living players."""
    if player_count <= 0:
        return 0
    if player_count == 1:
        return SOLO_POPULATION
    return POPULATION_CAP


def ranged_target(target: int) -> int:
    """Ranged mobs wanted within a population target: one of three, two of four."""
    return target // 2


def public_mob(row) -> dict:
    return {
        "mobId": str(row["id"]),
        "kind": row["kind"],
        "x": row["x"],
        "y": row["y"],
        "facing": row["facing"],
        "health": row["health"],
        "maxHealth": MOB_HEALTH,
        "revision": row["revision"],
        "windingUp": row.get("windup_until") is not None,
    }


def facing_toward(origin: Cell, cell: Cell) -> str:
    dx, dy = cell[0] - origin[0], cell[1] - origin[1]
    if dx != 0 and abs(dx) >= abs(dy):
        return "east" if dx > 0 else "west"
    return "south" if dy > 0 else "north"


def spawn_cell(occupied: set[Cell], players: Sequence[Cell], choose: Chooser = secrets.choice) -> Cell | None:
    """A random safe block that is free, has a free exit, and is outside arrow reach of every player."""
    eligible = [
        cell for cell in TRAVERSABLE_BLOCKS
        if safe_spawn_block(cell, occupied) and all(chebyshev(cell, player) >= SPAWN_CLEARANCE for player in players)
    ]
    return choose(eligible) if eligible else None


def pursue(
    origin: Cell, targets: set[Cell], blocked: set[Cell], max_depth: int | None = None, preferred: Cell | None = None,
) -> tuple[Cell | None, Cell | None]:
    """Breadth-first route to the nearest target by traversable path length.

    The search covers the whole map unless ``max_depth`` is set. Returns
    ``(None, target)`` when already orthogonally adjacent, ``(step, target)``
    for the first cell toward the chosen target, or ``(None, None)`` when no
    target is reachable. Neighbours expand in the fixed ``DIRECTIONS`` order.
    Equal-length routes keep ``preferred`` when it is one of the nearest cells;
    otherwise the first cell reached in that order wins, so replicas agree.
    """
    if not targets:
        return None, None
    limit = max_depth if max_depth is not None else MOVEMENT_WORLD_SIZE * MOVEMENT_WORLD_SIZE
    order = tuple(DIRECTIONS.values())
    first_step: dict[Cell, Cell | None] = {origin: None}
    frontier: deque[tuple[Cell, int]] = deque([(origin, 0)])
    found: list[tuple[Cell, int, Cell | None]] = []
    while frontier and len(found) < len(targets):
        cell, depth = frontier.popleft()
        # Breadth-first: once a target is found, only its equally near rivals matter.
        if depth >= limit or (found and depth >= found[0][1]):
            break
        for dx, dy in order:
            neighbour = (cell[0] + dx, cell[1] + dy)
            if neighbour in first_step:
                continue
            step = first_step[cell] or neighbour
            first_step[neighbour] = step
            if neighbour in targets:
                found.append((neighbour, depth + 1, None if depth == 0 else step))
                continue
            if neighbour in blocked or not block_is_traversable(*neighbour):
                continue
            frontier.append((neighbour, depth + 1))
    if not found:
        return None, None
    best = min(distance for _, distance, _ in found)
    nearest = [item for item in found if item[1] == best]
    chosen = next((item for item in nearest if item[0] == preferred), nearest[0])
    return chosen[2], chosen[0]


def terrain_contact(origin, end):
    """Sweep the orb against solid tiles, including off-map cells and corners."""
    radius = 0.5 + PROJECTILE_RADIUS
    hit = None
    for x in range(math.floor(min(origin[0], end[0]) - radius), math.ceil(max(origin[0], end[0]) + radius) + 1):
        for y in range(math.floor(min(origin[1], end[1]) - radius), math.ceil(max(origin[1], end[1]) + radius) + 1):
            if block_is_traversable(x, y):
                continue
            contact = segment_box(origin, end, (x, y), radius)
            if contact is not None and (hit is None or contact < hit):
                hit = contact
    return hit


def aim_direction(origin, target):
    dx, dy = target[0] - origin[0], target[1] - origin[1]
    length = math.hypot(dx, dy)
    return (dx / length, dy / length) if length else (0.0, 1.0)


@lru_cache(maxsize=8192)
def clear_line(origin: Cell, cell: Cell) -> bool:
    """Any angle within firing range, with clearance for the projectile."""
    distance = math.dist(origin, cell)
    return 0 < distance <= RANGED_RANGE and terrain_contact(origin, cell) is None


def firing_cells(target: Cell, blocked: set[Cell]) -> set[Cell]:
    """Free open cells from which a ranged mob has a clear shot at ``target``."""
    cells = set()
    for dx, dy in DIRECTIONS.values():
        for distance in range(1, RANGED_RANGE + 1):
            cell = (target[0] + dx * distance, target[1] + dy * distance)
            if not block_is_traversable(*cell):
                break
            if cell not in blocked:
                cells.add(cell)
    return cells


def advance_shot(x, y, facing, distance, bodies, *, direction=None, travel=SHOT_CELLS_PER_TICK):
    """Sweep the full flight segment; the first solid tile or unit body wins.

    Coordinates are cell centers, not rounded tile indices. Swept body
    contact catches diagonal and grazing hits as well as fast tunnelling;
    enemy bodies are their full drawn footprint, players one round cell.
    """
    if travel <= 0:
        return (x, y), distance, None
    dx, dy = direction or DIRECTIONS[facing]
    origin, end = (x, y), (x + dx * travel, y + dy * travel)
    wall = terrain_contact(origin, end)
    nearest, victim = wall if wall is not None else math.inf, None
    for cell in sorted(bodies):
        contact = body_contact(origin, end, cell, body_kind(bodies[cell]), PROJECTILE_RADIUS)
        if contact is not None and contact < nearest:
            nearest, victim = contact, cell
    if nearest != math.inf:
        return None, distance + travel * nearest, victim
    return end, distance + travel, None


def wander_step(origin: Cell, blocked: set[Cell], choose: Chooser = secrets.choice) -> Cell | None:
    options = [
        (origin[0] + dx, origin[1] + dy)
        for dx, dy in DIRECTIONS.values()
        if block_is_traversable(origin[0] + dx, origin[1] + dy) and (origin[0] + dx, origin[1] + dy) not in blocked
    ]
    return choose(options) if options else None


@dataclass
class MobPlan:
    spawn: Cell | None = None
    spawn_attempted: bool = False
    moves: list[tuple[uuid.UUID, Cell, str]] = field(default_factory=list)
    turns: list[tuple[uuid.UUID, str]] = field(default_factory=list)
    attacks: list[tuple[uuid.UUID, uuid.UUID, str]] = field(default_factory=list)
    spawn_kind: str = MOB_KIND
    consume_respawn: bool = False
    mob_damage: dict = field(default_factory=dict)
    # (mob id, facing): a ranged mob begins its visible wind-up.
    windups: list[tuple[uuid.UUID, str]] = field(default_factory=list)
    # Wind-ups dropped because the target was defeated or disconnected.
    cancels: list[uuid.UUID] = field(default_factory=list)
    # (mob id, facing): the wind-up finished and a projectile leaves the mob's cell.
    launches: list[tuple[uuid.UUID, str]] = field(default_factory=list)
    # Every projectile still in flight after this tick, launches excluded.
    shots: list[dict] = field(default_factory=list)
    shots_changed: bool = False
    launch_directions: dict = field(default_factory=dict)
    # (mob id, player id): projectile hits; each projectile hits at most one player.
    shot_hits: list[tuple[uuid.UUID, uuid.UUID]] = field(default_factory=list)
    # (mob id, player id or None). Persisted even when the tick emits no event.
    retargets: list[tuple[uuid.UUID, uuid.UUID | None]] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(
            self.spawn or self.moves or self.turns or self.attacks
            or self.windups or self.cancels or self.launches or self.shots_changed
        )


def plan_tick(
    players: Sequence, mobs: Sequence, next_spawn_at: datetime, now: datetime, choose: Chooser = secrets.choice,
    projectiles: Sequence[dict] = (), ranged_respawns: Sequence[datetime] = (),
) -> MobPlan:
    """Decide one tick for a world with at least one connected living player.

    ``players`` are the connected living positions (the only valid targets);
    ``mobs`` are ordered by id. Occupied cells (players, mobs, this tick's
    earlier movers) are never entered, so entities can never stack. Every
    connected living player is a target for every mob.
    """
    plan = MobPlan()
    # Projectiles in flight move first, against this tick's positions; a player
    # they hit is no longer a target for anything else this tick.
    hit_ids = set()
    live_mobs = {(mob["x"], mob["y"]): dict(mob) for mob in mobs}
    mob_died = False
    live_cells: dict[Cell, object] = {(player["x"], player["y"]): player for player in players}
    for shot in projectiles:
        elapsed = max(0.0, now.timestamp() - shot["updatedAt"]) if "updatedAt" in shot else SHOT_CELLS_PER_TICK / PROJECTILE_SPEED
        # Even after a long pause, a ray exits this world within two map widths.
        travel = min(PROJECTILE_SPEED * elapsed, MOVEMENT_WORLD_SIZE * 2)
        plan.shots_changed = True
        bodies = {**live_cells, **{cell: mob for cell, mob in live_mobs.items() if str(mob["id"]) != shot["mobId"]}}
        cell, distance, victim = advance_shot(shot["x"], shot["y"], shot["facing"], shot["distance"], bodies,
            direction=(shot["dx"], shot["dy"]) if "dx" in shot else None, travel=travel)
        if cell is not None:
            plan.shots.append({**shot, "x": cell[0], "y": cell[1], "distance": distance, "updatedAt": now.timestamp()})
        if victim in live_mobs:
            hit_mob = live_mobs[victim]
            plan.mob_damage[hit_mob["id"]] = plan.mob_damage.get(hit_mob["id"], 0) + 1
            hit_mob["health"] -= 1
            if hit_mob["health"] <= 0:
                del live_mobs[victim]
                mob_died = True
        elif victim is not None:
            victim_id = live_cells.pop(victim)["player_id"]
            hit_ids.add(victim_id)
            plan.shot_hits.append((uuid.UUID(shot["mobId"]), victim_id))
    mobs = list(live_mobs.values())
    players = [player for player in players if player["player_id"] not in hit_ids]
    player_cells: dict[Cell, object] = {(player["x"], player["y"]): player for player in players}
    players_by_id = {player["player_id"]: player for player in players}
    occupied = set(player_cells) | {(mob["x"], mob["y"]) for mob in mobs}
    target_count = population_target(len(players))
    ranged = sum(1 for mob in mobs if mob["kind"] == RANGED_KIND)
    missing_ranged = max(0, ranged_target(target_count) - ranged)
    pending = sorted(ranged_respawns)
    ready = bool(pending and pending[0] <= now)
    reserved = sum(when > now for when in pending[:missing_ranged])
    # A ready replacement bypasses the ordinary six-second population cadence.
    # Future ranged slots cannot be filled early by either enemy type.
    if players and not mob_died and len(mobs) < target_count - reserved and (next_spawn_at <= now or (ready and missing_ranged)):
        plan.spawn_attempted = True
        plan.spawn = spawn_cell(occupied, list(player_cells), choose)
        if plan.spawn:
            occupied.add(plan.spawn)
            spawn_ranged = missing_ranged > reserved
            plan.spawn_kind = RANGED_KIND if spawn_ranged else MOB_KIND
            plan.consume_respawn = spawn_ranged and ready
    for mob in mobs:
        origin = (mob["x"], mob["y"])
        targets = set(player_cells)
        blocked = (occupied - targets) - {origin}
        current_id = mob.get("target_player_id")
        current = players_by_id.get(current_id)
        if mob["kind"] == RANGED_KIND and mob.get("windup_until") is not None:
            # A wind-up keeps its target and facing; losing the target cancels it without a shot.
            if current is None:
                plan.cancels.append(mob["id"])
                if current_id is not None:
                    plan.retargets.append((mob["id"], None))
            elif mob["windup_until"] <= now:
                # Lock a normalized direction at launch; never home afterwards.
                aim = (current["x"], current["y"])
                facing = facing_toward(origin, aim)
                plan.launches.append((mob["id"], facing))
                plan.launch_directions[mob["id"]] = aim_direction(origin, aim)
            continue
        preferred = (current["x"], current["y"]) if current is not None else None
        # Prefer a visible target immediately, rather than following a nearer
        # path target behind cover until we happen to align on a row/column.
        visible = [cell for cell in targets if clear_line(origin, cell)] if mob["kind"] == RANGED_KIND else []
        if visible:
            target = min(visible, key=lambda cell: (math.dist(origin, cell), cell != preferred, cell))
            step = None
        else:
            step, target = pursue(origin, targets, blocked, preferred=preferred)
        chosen_id = player_cells[target]["player_id"] if target is not None else None
        if chosen_id != current_id:
            plan.retargets.append((mob["id"], chosen_id))
        if mob["kind"] == RANGED_KIND:
            step = _plan_ranged(plan, mob, origin, target, blocked, targets, now)
            if step is False:
                continue
        elif target is not None and step is None:
            facing = facing_toward(origin, target)
            if mob["next_attack_at"] <= now:
                plan.attacks.append((mob["id"], player_cells[target]["player_id"], facing))
            elif facing != mob["facing"]:
                plan.turns.append((mob["id"], facing))
            continue
        if mob["next_move_at"] > now:
            continue
        if step is None and mob["kind"] != RANGED_KIND or step is True:
            step = wander_step(origin, blocked, choose)
        if step is None:
            continue
        plan.moves.append((mob["id"], step, facing_toward(origin, step)))
        occupied.discard(origin)
        occupied.add(step)
    return plan


def _plan_ranged(
    plan: MobPlan, mob, origin: Cell, target: Cell | None, blocked: set[Cell], players: set[Cell], now: datetime,
):
    """Plan a ranged mob that is not winding up.

    Returns ``False`` when it stays put this tick, ``True`` to wander, or the
    next step toward the nearest free cell with a clear shot at its target.
    """
    if target is None:
        return True
    if clear_line(origin, target):
        facing = facing_toward(origin, target)
        # The cooldown runs from launch.
        if mob["next_attack_at"] <= now:
            plan.windups.append((mob["id"], facing))
        elif facing != mob["facing"]:
            plan.turns.append((mob["id"], facing))
        return False
    goals = firing_cells(target, blocked | players)
    step, goal = pursue(origin, goals, blocked)
    if goal is None:
        # No reachable firing cell: close in on the player instead.
        step, _ = pursue(origin, {target}, blocked)
        return step if step is not None else False
    return goal if step is None else step


def _projectiles(value) -> list[dict]:
    return json.loads(value) if isinstance(value, str) else list(value or [])


async def public_projectiles(connection, world_id: str) -> list[dict]:
    return _projectiles(await connection.fetchval("SELECT projectiles FROM world_mob_states WHERE world_id=$1", world_id))


async def ensure_state(connection, world_id: str) -> None:
    await connection.execute("INSERT INTO world_mob_states(world_id) VALUES($1) ON CONFLICT DO NOTHING", world_id)


async def mob_rows(connection, world_id: str):
    return await connection.fetch("SELECT * FROM world_mobs WHERE world_id=$1 ORDER BY id", world_id)


async def public_mobs(connection, world_id: str) -> list[dict]:
    return [public_mob(row) for row in await mob_rows(connection, world_id)]


async def mob_cells(connection, world_id: str) -> set[Cell]:
    return {(row["x"], row["y"]) for row in await connection.fetch("SELECT x, y FROM world_mobs WHERE world_id=$1", world_id)}


async def mob_occupies(connection, world_id: str, x: int, y: int) -> bool:
    return bool(await connection.fetchval("SELECT 1 FROM world_mobs WHERE world_id=$1 AND x=$2 AND y=$3", world_id, x, y))


async def mob_on_path(connection, world_id: str, origin: Cell, facing: str, path: Sequence[Cell]):
    """The first mob whose body the laser lane strikes, locked for this attack."""
    if not path:
        return None
    rows = await connection.fetch("SELECT * FROM world_mobs WHERE world_id=$1 ORDER BY id FOR UPDATE", world_id)
    struck, _ = laser_strike(origin, DIRECTIONS[facing], len(path), {(row["x"], row["y"]): row for row in rows})
    return next((row for row in rows if (row["x"], row["y"]) == struck), None)


async def mobs_in_cells(connection, world_id: str, cells: Sequence[Cell]):
    if not cells:
        return []
    return await connection.fetch(
        """SELECT m.* FROM world_mobs m
           JOIN unnest($2::integer[], $3::integer[]) cells(x, y) ON cells.x=m.x AND cells.y=m.y
           WHERE m.world_id=$1 ORDER BY m.id FOR UPDATE OF m""",
        world_id, [cell[0] for cell in cells], [cell[1] for cell in cells],
    )


async def damage_mob(connection, world_id: str, mob, amount: int) -> dict:
    """Apply arrow damage; a defeat removes the mob once and awards nothing."""
    remaining = int(mob["health"]) - amount
    if remaining > 0:
        row = await connection.fetchrow(
            "UPDATE world_mobs SET health=$3, revision=revision+1 WHERE id=$1 AND world_id=$2 RETURNING *",
            mob["id"], world_id, remaining,
        )
        return {**public_mob(row), "defeated": False}
    revision = await connection.fetchval(
        "DELETE FROM world_mobs WHERE id=$1 AND world_id=$2 RETURNING revision", mob["id"], world_id
    )
    if revision is None:
        # Already removed inside this transaction.
        return {**public_mob(mob), "health": 0, "defeated": True}
    if mob["kind"] == RANGED_KIND:
        await ensure_state(connection, world_id)
        await connection.execute(
            """UPDATE world_mob_states SET ranged_respawns=array_append(ranged_respawns,
               transaction_timestamp() + make_interval(secs=>$2::float8)) WHERE world_id=$1""",
            world_id, RANGED_RESPAWN_SECONDS,
        )
    return {**public_mob(mob), "health": 0, "revision": int(revision) + 1, "defeated": True}


async def normalize_mobs(connection, world_id: str, mobs: Sequence) -> tuple[list, bool]:
    """Bring legacy rows onto the flat map as basic mobs; nothing is deleted.

    Rows left on a retired cube face, or of a retired variant, are rewritten in
    place: stranded mobs move to a safe free cell and every mob becomes the
    basic kind with its health capped at three.
    """
    # Only relocation needs occupancy, so ticks without a stranded mob skip the player read.
    occupied: set[Cell] | None = None
    changed = False
    for mob in mobs:
        cell = (mob["x"], mob["y"])
        stranded = not block_is_traversable(*cell)
        kind = mob["kind"] if mob["kind"] in MOB_KINDS else MOB_KIND
        if not stranded and kind == mob["kind"] and mob["health"] <= MOB_HEALTH:
            continue
        if stranded:
            if occupied is None:
                occupied = {(row["x"], row["y"]) for row in await connection.fetch(
                    "SELECT x, y FROM player_positions WHERE world_id=$1", world_id
                )} | {(other["x"], other["y"]) for other in mobs if block_is_traversable(other["x"], other["y"])}
            chosen = first_spawn_block(None, occupied)
            if chosen is None:
                continue
            occupied.add(chosen)
            cell = chosen
        await connection.execute(
            """UPDATE world_mobs SET kind=$3, health=LEAST(health, $4), x=$5, y=$6, revision=revision+1
               WHERE id=$1 AND world_id=$2""",
            mob["id"], world_id, kind, MOB_HEALTH, *cell,
        )
        changed = True
    return (await mob_rows(connection, world_id) if changed else list(mobs)), changed


async def tick(connection, world_id: str, *, choose: Chooser = secrets.choice) -> dict | None:
    """Advance one world's mobs by one tick. The caller holds the world stream lock.

    Returns the ``mob.tick`` event payload, or ``None`` when the tick is not due,
    no connected living player is present, or nothing changed.
    """
    await ensure_state(connection, world_id)
    state = await connection.fetchrow(
        "SELECT next_tick_at, next_spawn_at, projectiles, ranged_respawns, transaction_timestamp() now FROM world_mob_states WHERE world_id=$1 FOR UPDATE",
        world_id,
    )
    now = state["now"]
    if state["next_tick_at"] > now:
        return None
    players = await connection.fetch(CONNECTED_PLAYERS_QUERY, world_id, float(STALE_CONNECTION_SECONDS))
    mobs = await mob_rows(connection, world_id) if players else []
    interval = TICK_SECONDS if _projectiles(state["projectiles"]) else AI_TICK_SECONDS
    # Wake at a pending step instead of rounding movement up to the next AI or
    # physics tick. Ignore overdue timers on enemies that are blocked or firing;
    # those still reconsider their situation on the ordinary AI cadence.
    interval = min([interval] + [
        (mob["next_move_at"] - now).total_seconds()
        for mob in mobs if mob["next_move_at"] > now
    ])
    await connection.execute(
        "UPDATE world_mob_states SET next_tick_at=$2::timestamptz + make_interval(secs=>$3::float8), updated_at=now() WHERE world_id=$1",
        world_id, now, interval,
    )
    if not players:
        return None
    normalized, stranded = await normalize_mobs(connection, world_id, mobs)
    mobs = [mob for mob in normalized if block_is_traversable(mob["x"], mob["y"])]
    plan = plan_tick(players, mobs, state["next_spawn_at"], now, choose, _projectiles(state["projectiles"]), state["ranged_respawns"])
    mob_hits = [await damage_mob(connection, world_id, mob, plan.mob_damage[mob["id"]])
                for mob in mobs if mob["id"] in plan.mob_damage]
    for mob_id, player_id in plan.retargets:
        await connection.execute(
            "UPDATE world_mobs SET target_player_id=$3 WHERE id=$1 AND world_id=$2",
            mob_id, world_id, player_id,
        )
    if plan.consume_respawn:
        # Slice one sorted entry, preserving simultaneous deaths as separate slots.
        await connection.execute(
            """UPDATE world_mob_states SET ranged_respawns=(
               SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::timestamptz[])
               FROM (SELECT t FROM unnest(ranged_respawns) t ORDER BY t OFFSET 1) pending)
               WHERE world_id=$1""", world_id,
        )
    if plan.spawn_attempted:
        await connection.execute(
            "UPDATE world_mob_states SET next_spawn_at=$2::timestamptz + make_interval(secs=>$3::float8), updated_at=now() WHERE world_id=$1",
            world_id, now, SPAWN_INTERVAL_SECONDS,
        )
    if not plan.changed and not stranded:
        return None
    spawned = []
    if plan.spawn:
        row = await connection.fetchrow(
            """INSERT INTO world_mobs(id, world_id, kind, x, y, health, revision, next_move_at, next_attack_at)
               VALUES($1, $2, $3, $4, $5, $6, (SELECT current_revision+1 FROM world_streams WHERE world_id=$2),
                      $7::timestamptz + make_interval(secs=>$8::float8), $7::timestamptz + make_interval(secs=>$9::float8))
               RETURNING *""",
            uuid.uuid4(), world_id, plan.spawn_kind, plan.spawn[0], plan.spawn[1], MOB_HEALTH, now, MOVE_SECONDS, ATTACK_COOLDOWN_SECONDS,
        )
        spawned.append(public_mob(row))
    for mob_id, (x, y), facing in plan.moves:
        # Keep the cadence when a normal sweep is slightly late. A blocked mob
        # or a paused world starts a fresh interval, without catch-up steps.
        await connection.execute(
            """UPDATE world_mobs SET x=$3, y=$4, facing=$5, revision=revision+1,
                      next_move_at=(CASE WHEN next_move_at >= $6::timestamptz - make_interval(secs=>$8::float8)
                                        THEN next_move_at ELSE $6::timestamptz END) + make_interval(secs=>$7::float8)
               WHERE id=$1 AND world_id=$2""",
            mob_id, world_id, x, y, facing, now, MOVE_SECONDS, TICK_SECONDS,
        )
    for mob_id, facing in plan.turns:
        await connection.execute(
            "UPDATE world_mobs SET facing=$3, revision=revision+1 WHERE id=$1 AND world_id=$2", mob_id, world_id, facing
        )
    for mob_id, facing in plan.windups:
        await connection.execute(
            """UPDATE world_mobs SET facing=$3, revision=revision+1, windup_until=$4::timestamptz + make_interval(secs=>$5::float8)
               WHERE id=$1 AND world_id=$2""",
            mob_id, world_id, facing, now, WINDUP_SECONDS,
        )
    for mob_id in plan.cancels:
        await connection.execute(
            "UPDATE world_mobs SET windup_until=NULL, revision=revision+1 WHERE id=$1 AND world_id=$2", mob_id, world_id
        )
    shots = list(plan.shots)
    for mob_id, facing in plan.launches:
        # Launch from the mob's own cell; the cooldown is measured from this moment.
        origin = await connection.fetchrow(
            """UPDATE world_mobs SET windup_until=NULL, facing=$3, revision=revision+1,
                      next_attack_at=$4::timestamptz + make_interval(secs=>$5::float8)
               WHERE id=$1 AND world_id=$2 RETURNING x, y""",
            mob_id, world_id, facing, now, RANGED_COOLDOWN_SECONDS,
        )
        shots.append({"id": str(uuid.uuid4()), "mobId": str(mob_id), "x": origin["x"], "y": origin["y"], "facing": facing, "distance": 0,
                      "dx": plan.launch_directions[mob_id][0], "dy": plan.launch_directions[mob_id][1],
                      "updatedAt": now.timestamp()})
    if plan.launches:
        await connection.execute(
            "UPDATE world_mob_states SET next_tick_at=$2::timestamptz + make_interval(secs=>$3::float8) WHERE world_id=$1",
            world_id, now, TICK_SECONDS,
        )
    if plan.shots_changed or plan.launches:
        await connection.execute(
            "UPDATE world_mob_states SET projectiles=$2::jsonb, updated_at=now() WHERE world_id=$1", world_id, json.dumps(shots)
        )
    by_id = {player["player_id"]: player for player in players}
    attacks, victims = [], []
    killed: set[uuid.UUID] = set()
    for mob_id, player_id in plan.shot_hits:
        killed.add(player_id)
        victims.append(_public_position(by_id[player_id], await current_facing(connection, world_id, player_id)))
        attacks.append({"mobId": str(mob_id), "playerId": str(player_id), "outcome": "eliminated", "ranged": True})
    for mob_id, player_id, facing in plan.attacks:
        if player_id in killed:
            continue
        await connection.execute(
            """UPDATE world_mobs SET facing=$3, revision=revision+1, next_attack_at=$4::timestamptz + make_interval(secs=>$5::float8)
               WHERE id=$1 AND world_id=$2""",
            mob_id, world_id, facing, now, ATTACK_COOLDOWN_SECONDS,
        )
        killed.add(player_id)
        victims.append(_public_position(by_id[player_id], await current_facing(connection, world_id, player_id)))
        attacks.append({"mobId": str(mob_id), "playerId": str(player_id), "outcome": "eliminated"})
    payload = {
        "mobs": await public_mobs(connection, world_id),
        "projectiles": shots,
        "mobHits": mob_hits,
        "spawned": spawned,
        "attacks": attacks,
        "attackerName": MOB_NAME,
        # No attacker account: the elimination consumer records each death without crediting anyone.
        "combatElimination": {"attackerId": None, "victims": victims},
    }
    await resolve_eliminations(connection, world_id, payload)
    return payload
