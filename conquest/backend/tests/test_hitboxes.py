"""Avatar-sized enemy bodies for lasers and rockets, and the retired stealth mode (Issue #110)."""
import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.hitboxes import MOB_BODY_SIZE, laser_strike
from app.mobs import advance_shot, mob_on_path, plan_tick
from app.player_positions import _public_position
from app.realtime import WorldRuntime
from app.world_transport import Command

NOW = datetime(2030, 1, 1, tzinfo=timezone.utc)
LATER = NOW + timedelta(seconds=5)
EAST = (1, 0)


def mob(x, y, kind="basic"):
    return {"id": uuid.uuid4(), "kind": kind, "x": x, "y": y, "facing": "south", "health": 3, "revision": 1,
            "next_attack_at": NOW - timedelta(seconds=5), "next_move_at": NOW - timedelta(seconds=5),
            "target_player_id": None, "windup_until": None}


def player(x, y, **extra):
    return {"player_id": uuid.uuid4(), "name": "Wren", "avatar": "moss", "x": x, "y": y, "revision": 3, **extra}


def first(options):
    return sorted(options)[0]


def test_laser_strikes_an_enemy_body_off_its_center_lane_and_misses_beyond_it():
    assert MOB_BODY_SIZE == 2.5
    for kind in ("basic", "ranged"):
        # The body edge reaches the adjacent lane: a hit, ending on the lane cell holding that edge.
        assert laser_strike((10, 4), EAST, 20, {(15, 5): mob(15, 5, kind)}) == ((15, 5), 4)
        assert laser_strike((10, 4), EAST, 20, {(15, 3): mob(15, 3, kind)})[0] == (15, 3)
        # Two lanes away the beam passes entirely outside the body.
        assert laser_strike((10, 4), EAST, 20, {(15, 6): mob(15, 6, kind)}) == (None, 20)
    # Centered on the lane, the beam ends where it meets the body's near edge.
    assert laser_strike((10, 4), EAST, 20, {(15, 4): mob(15, 4)}) == ((15, 4), 4)
    # Players keep their one-cell body: only their own lane cell, ending on it.
    assert laser_strike((10, 4), EAST, 20, {(15, 4): {}}) == ((15, 4), 5)
    assert laser_strike((10, 4), EAST, 20, {(15, 5): {}}) == (None, 20)


def test_laser_terrain_and_firing_direction_bound_enemy_bodies():
    # A body whose edge lies past the terrain stop (the far edge of the last lane cell) is safe.
    assert laser_strike((10, 4), EAST, 3, {(16, 5): mob(16, 5)}) == (None, 3)
    # One that pokes into the open lane before the wall is struck.
    assert laser_strike((10, 4), EAST, 3, {(14, 5): mob(14, 5)}) == ((14, 5), 3)
    # An enemy behind the shooter is never hit; one beside them is.
    assert laser_strike((10, 4), EAST, 20, {(8, 4): mob(8, 4)})[0] is None
    assert laser_strike((10, 4), EAST, 20, {(10, 5): mob(10, 5)}) == ((10, 5), 1)
    # An empty lane (an adjacent wall) strikes nothing.
    assert laser_strike((10, 4), EAST, 0, {(11, 4): mob(11, 4)}) == (None, 0)


def test_the_nearest_body_contact_wins_even_off_lane():
    # The off-lane enemy's edge comes before the player's cell.
    bodies = {(15, 5): mob(15, 5), (16, 4): player(16, 4)}
    assert laser_strike((10, 4), EAST, 20, bodies) == ((15, 5), 4)
    # A player in front of the enemy's edge is struck first.
    bodies = {(18, 5): mob(18, 5), (15, 4): player(15, 4)}
    assert laser_strike((10, 4), EAST, 20, bodies) == ((15, 4), 5)


def test_mob_on_path_locks_mobs_and_returns_the_body_the_lane_strikes():
    near, far, clear = mob(15, 5), mob(13, 4), mob(12, 7)
    connection = AsyncMock()
    connection.fetch.return_value = [near, far, clear]
    path = [(x, 4) for x in range(11, 30)]
    assert asyncio.run(mob_on_path(connection, "w", (10, 4), "east", path)) is far
    assert "FOR UPDATE" in connection.fetch.await_args.args[0]
    connection.fetch.return_value = [near, clear]
    assert asyncio.run(mob_on_path(connection, "w", (10, 4), "east", path)) is near
    connection.fetch.return_value = [clear]
    assert asyncio.run(mob_on_path(connection, "w", (10, 4), "east", path)) is None


def test_rockets_hit_enemy_body_edges_but_keep_the_player_body():
    # A rocket one lane over grazes a melee or ranged enemy body, but would pass a player there.
    assert advance_shot(20, 3, "west", 0, {(14, 4): mob(14, 4)}, travel=10)[2] == (14, 4)
    assert advance_shot(20, 3, "west", 0, {(14, 4): mob(14, 4, "ranged")}, travel=10)[2] == (14, 4)
    assert advance_shot(20, 3, "west", 0, {(14, 4): player(14, 4)}, travel=10)[2] is None
    # Two lanes over, the rocket misses even the larger body.
    assert advance_shot(20, 3, "west", 0, {(14, 5): mob(14, 5)}, travel=10)[2] is None
    # A square melee body reaches its corner; the round ranged body does not.
    length = (0.95 ** 2 + 0.312 ** 2) ** 0.5
    direction = (-0.95 / length, 0.312 / length)
    corner = (14 + 1.35, 4 - 1.35)  # inside the padded square's corner, outside the padded circle
    start = (corner[0] - direction[0] * 3, corner[1] - direction[1] * 3)
    assert advance_shot(*start, "west", 0, {(14, 4): mob(14, 4)}, direction=direction, travel=3.2)[2] == (14, 4)
    assert advance_shot(*start, "west", 0, {(14, 4): mob(14, 4, "ranged")}, direction=direction, travel=3.2)[2] is None


def test_rocket_damage_applies_once_to_the_struck_enemy():
    shooter, struck, other = mob(30, 3, "ranged"), mob(20, 4), mob(10, 3)
    rocket = {"id": "r", "mobId": str(shooter["id"]), "x": 30, "y": 3, "facing": "west", "distance": 0}
    plan = plan_tick([player(60, 60)], [shooter, struck, other], LATER, NOW, first, [{**rocket, "updatedAt": NOW.timestamp() - 1}])
    assert plan.mob_damage == {struck["id"]: 1} and plan.shots == []


def test_retired_stealth_state_never_hides_a_player_or_reaches_clients():
    # Rows written while stealth existed still carry its columns; nothing reads them.
    hidden = player(10, 3, stealth=True, stealth_detected=False, pace=0.0, pace_at=0.0)
    hunter = mob(20, 3)
    plan = plan_tick([hidden], [hunter], LATER, NOW, first)
    assert plan.retargets == [(hunter["id"], hidden["player_id"])]
    assert not hasattr(plan, "stealth")
    assert "stealth" not in _public_position(hidden) and "stealthDetected" not in _public_position(hidden)
    with pytest.raises(ModuleNotFoundError):
        __import__("app.stealth")


def test_in_memory_misses_defer_to_the_resolver_when_an_enemy_body_reaches_the_lane():
    shooter = str(uuid.uuid4())

    def runtime(mob_cells):
        world = WorldRuntime("w")
        world.load({"revision": 1, "mobs": json.dumps(mob_cells), "positions": json.dumps([
            {"player_id": shooter, "name": "Wren", "avatar": "moss", "x": 11, "y": 4, "revision": 3, "facing": "east"},
        ])})
        return world

    fire = Command("w", "shot", "player.shoot", {"expectedRevision": 3})
    assert runtime([[15, 5]]).try_command(fire, shooter) is None
    miss = runtime([[15, 6]]).try_command(fire, shooter)
    assert miss["eventType"] == "player.shot" and "stealthBroken" not in miss["payload"]
