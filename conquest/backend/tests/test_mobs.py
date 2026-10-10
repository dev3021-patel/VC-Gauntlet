"""Enemy mob AI: pure planning rules, arrow integration, and PostgreSQL lifecycle."""
import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import asyncpg
import pytest

from app import mobs
from app.eliminations import resolve_eliminations
from app.mobs import (
    MOB_HEALTH, MOB_KIND, MOVE_SECONDS, RANGED_COOLDOWN_SECONDS, RANGED_KIND, RANGED_RANGE, advance_shot, clear_line, public_mob, POPULATION_CAP, SOLO_POPULATION, SPAWN_CLEARANCE, chebyshev, damage_mob,
    normalize_mobs, plan_tick, population_target, pursue, spawn_cell,
)
from app.player_positions import DIRECTIONS, block_is_traversable, first_spawn_block, position_resolver
from app.world_transport import ActorContext, Command, PostgresWorldStore, TransportError

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
NOW = datetime(2030, 1, 1, tzinfo=timezone.utc)
LATER = NOW + timedelta(seconds=5)
EARLIER = NOW - timedelta(seconds=5)


def mob(x, y, *, facing="south", attack_at=EARLIER, move_at=EARLIER, health=MOB_HEALTH, mob_id=None, kind="basic",
        target_player_id=None, windup_until=None):
    return {"id": mob_id or uuid.uuid4(), "kind": kind, "x": x, "y": y, "facing": facing, "health": health,
            "revision": 1, "next_attack_at": attack_at, "next_move_at": move_at, "target_player_id": target_player_id,
            "windup_until": windup_until}


def shot(mob_row, x, y, facing, distance):
    return {"id": str(uuid.uuid4()), "mobId": str(mob_row["id"]), "x": x, "y": y, "facing": facing, "distance": distance}


def player(x, y, player_id=None, name="Wren"):
    return {"player_id": player_id or uuid.uuid4(), "name": name, "avatar": "moss", "x": x, "y": y, "revision": 3}


def first(options):
    return sorted(options)[0]


def walk(origin, target, blocked=frozenset(), limit=60):
    """Simulate pursuit until adjacent; every step must be a legal, free, orthogonal move."""
    steps = 0
    while True:
        step, found = pursue(origin, {target}, set(blocked))
        if step is None:
            return steps, found
        assert abs(step[0] - origin[0]) + abs(step[1] - origin[1]) == 1
        assert block_is_traversable(*step) and step not in blocked
        origin = step
        steps += 1
        assert steps <= limit, "pursuit did not converge"


def test_pursuit_takes_the_shortest_route_and_resolves_ties_in_fixed_direction_order():
    assert pursue((5, 3), {(9, 3)}, set()) == ((6, 3), (9, 3))
    # Equidistant targets north and south: north is expanded first on every replica.
    assert pursue((5, 3), {(5, 1), (5, 5)}, set()) == ((5, 2), (5, 1))
    # The current target stays when the route lengths are equal.
    assert pursue((5, 3), {(5, 1), (5, 5)}, set(), preferred=(5, 5)) == ((5, 4), (5, 5))
    # A strictly shorter route replaces the current target.
    assert pursue((5, 3), {(5, 0), (5, 9)}, set(), preferred=(5, 9)) == ((5, 2), (5, 0))
    assert pursue((5, 3), {(5, 4)}, set()) == (None, (5, 4)), "adjacent targets are attacked, not entered"
    assert pursue((5, 3), {(6, 4)}, set())[0] is not None, "diagonal neighbours are not adjacent"
    # The old 40-cell cutoff must not abandon a reachable player.
    assert pursue((5, 3), {(55, 3)}, set()) == ((6, 3), (55, 3))


def test_pursuit_routes_around_walls_through_the_courtyard_gate():
    # (10,10) is inside the walled courtyard whose only gap is (8,14); the target waits outside.
    steps, found = walk((10, 10), (5, 10))
    assert found == (5, 10) and 8 <= steps <= 12


def test_pursuit_treats_entities_as_walls_and_reports_unreachable_targets():
    step, found = pursue((3, 3), {(3, 6)}, {(3, 4)})
    assert found == (3, 6) and step in {(2, 3), (4, 3)}
    enclosed = {(2, 3), (4, 3), (3, 2), (3, 4)}
    assert pursue((3, 3), {(9, 9)}, enclosed) == (None, None)
    assert pursue((3, 3), {(30, 3)}, set(), max_depth=5) == (None, None)


def test_spawn_cell_is_free_traversable_with_an_exit_and_outside_arrow_reach():
    players = [(2, 2), (30, 5)]
    occupied = {(2, 2), (30, 5), (9, 3)}
    chosen = spawn_cell(occupied, players, first)
    assert chosen is not None and chosen not in occupied and block_is_traversable(*chosen)
    assert all(chebyshev(chosen, cell) >= SPAWN_CLEARANCE for cell in players)
    # Every candidate offered to the chooser satisfies the same rules.
    seen = []
    spawn_cell(occupied, players, lambda options: seen.extend(options) or options[0])
    assert seen and all(cell not in occupied and all(chebyshev(cell, p) >= SPAWN_CLEARANCE for p in players) for cell in seen)
    assert (9, 3) not in seen


def test_plan_scales_population_to_connected_players_and_never_despawns():
    assert population_target(0) == 0
    assert population_target(1) == SOLO_POPULATION == 3
    assert population_target(2) == population_target(6) == POPULATION_CAP == 4
    solo = [player(2, 2)]
    pair = [player(2, 2), player(30, 5)]
    three = [mob(20 + index, 2) for index in range(3)]
    assert plan_tick(solo, three, EARLIER, NOW, first).spawn is None
    assert not plan_tick(solo, three, EARLIER, NOW, first).spawn_attempted
    assert plan_tick([], three, EARLIER, NOW, first).spawn is None
    # Already above the new target: keep every mob and do not replace.
    crowded = [mob(20 + index, 2) for index in range(8)]
    assert plan_tick(pair, crowded, EARLIER, NOW, first).spawn is None
    assert not plan_tick(pair, crowded, EARLIER, NOW, first).spawn_attempted
    waiting = plan_tick(solo, three[:-1], LATER, NOW, first)
    assert waiting.spawn is None and not waiting.spawn_attempted
    due = plan_tick(solo, three[:-1], EARLIER, NOW, first)
    assert due.spawn_attempted and due.spawn is not None
    assert due.spawn not in {(m["x"], m["y"]) for m in three} and chebyshev(due.spawn, (2, 2)) >= SPAWN_CLEARANCE
    # A second player raises the target from three to four.
    opened = plan_tick(pair, three, EARLIER, NOW, first)
    assert opened.spawn_attempted and opened.spawn is not None
    assert plan_tick(pair, three + [mob(24, 2)], EARLIER, NOW, first).spawn is None


def test_mob_kinds_share_health_and_movement():
    assert (MOB_KIND, RANGED_KIND, MOB_HEALTH) == ("basic", "ranged", 3)
    assert MOVE_SECONDS == pytest.approx(0.8 / 1.5)
    assert not hasattr(mobs, "HUNTER") and not hasattr(mobs, "BRUTE")


def test_spawns_mix_one_ranged_mob_per_two_population_slots():
    solo = [player(2, 2)]
    assert plan_tick(solo, [mob(30, 2)], EARLIER, NOW, first).spawn_kind == RANGED_KIND
    assert plan_tick(solo, [mob(30, 2), mob(31, 2, kind=RANGED_KIND)], EARLIER, NOW, first).spawn_kind == MOB_KIND
    pair = [player(2, 2), player(2, 4)]
    one_ranged = [mob(30, 2), mob(31, 2, kind=RANGED_KIND), mob(32, 2)]
    assert plan_tick(pair, one_ranged, EARLIER, NOW, first).spawn_kind == RANGED_KIND


def test_ranged_mob_stops_on_a_clear_line_and_winds_up_only_off_cooldown():
    target = player(10, 3)
    ready = mob(15, 3, kind=RANGED_KIND, facing="south")
    cooling = mob(10, 6, kind=RANGED_KIND, facing="west", attack_at=LATER)
    plan = plan_tick([target], [ready, cooling], LATER, NOW, first)
    assert plan.windups == [(ready["id"], "west")]
    assert plan.turns == [(cooling["id"], "north")] and plan.moves == [] and plan.attacks == []
    # It shoots from far away: 32 cells along an open row.
    sniper = mob(42, 3, kind=RANGED_KIND)
    assert RANGED_RANGE == 32 and plan_tick([target], [sniper], LATER, NOW, first).windups == [(sniper["id"], "west")]


def test_ranged_mob_repositions_when_terrain_or_range_blocks_the_shot():
    # The courtyard wall at y=7 sits between (10,5) and (10,9).
    assert not clear_line((10, 5), (10, 9)) and clear_line((10, 3), (22, 3)) and not clear_line((10, 3), (43, 3))
    assert clear_line((10, 3), (35, 5)), "distant off-axis players are acquired immediately"
    far = mob(46, 3, kind=RANGED_KIND)
    plan = plan_tick([player(10, 3)], [far], LATER, NOW, first)
    assert plan.windups == [] and plan.moves == [(far["id"], (45, 3), "west")]
    off_line = mob(14, 5, kind=RANGED_KIND)
    plan = plan_tick([player(10, 3)], [off_line], LATER, NOW, first)
    assert plan.windups == [(off_line["id"], "west")] and not plan.moves


def test_wind_up_launches_after_its_delay_and_cancels_when_the_target_is_lost():
    target = player(10, 3)
    winding = mob(15, 3, kind=RANGED_KIND, facing="west", target_player_id=target["player_id"], windup_until=LATER)
    waiting = plan_tick([target], [winding], LATER, NOW, first)
    assert waiting.launches == [] and waiting.moves == [] and not waiting.changed
    done = mob(15, 3, kind=RANGED_KIND, facing="west", target_player_id=target["player_id"], windup_until=EARLIER)
    assert plan_tick([target], [done], LATER, NOW, first).launches == [(done["id"], "west")]
    # A sidestep during wind-up changes the launch vector, which is then fixed.
    moved = player(10, 4, player_id=target["player_id"])
    assert plan_tick([moved], [done], LATER, NOW, first).launches == [(done["id"], "west")]
    aimed = plan_tick([moved], [done], LATER, NOW, first)
    assert aimed.launch_directions[done["id"]] == pytest.approx(mobs.aim_direction((15, 3), (10, 4)))
    # Defeated or disconnected targets are absent from the connected living players.
    lost = plan_tick([player(30, 30)], [done], LATER, NOW, first)
    assert lost.launches == [] and lost.cancels == [done["id"]]


def test_projectiles_sweep_fast_flight_hitboxes_terrain_and_map_edges():
    assert mobs.PROJECTILE_SPEED == 50
    assert advance_shot(15, 3, "west", 0, {}) == ((12.5, 3), 2.5, None)
    # Cross many cells in one delayed tick: nearest player wins, regardless of iteration order.
    end, distance, victim = advance_shot(35, 3, "west", 0, {(12, 3): "behind", (24, 3): "first"}, travel=25)
    assert end is None and victim == (24, 3) and distance == pytest.approx(10.35)
    # A grazing hit counts; a sidestep beyond the combined radii survives.
    assert advance_shot(15, 3.6, "west", 0, {(14, 3): "edge"})[2] == (14, 3)
    assert advance_shot(15, 3.7, "west", 0, {(14, 3): "dodged"})[2] is None
    assert advance_shot(13, 3, "west", 2, {(13, 3): "entered"}) == (None, 2, (13, 3))
    # Wall before player wins even when the endpoint is beyond both.
    assert advance_shot(10, 6, "south", 1, {(10, 9): "covered"}, travel=12)[::2] == (None, None)
    assert advance_shot(1, 3, "west", 1, {}, travel=10)[0] is None
    assert advance_shot(30, 3, "west", 40, {}) == ((27.5, 3), 42.5, None)
    # Fractional diagonal flight is swept too; direction never changes to chase a player.
    direction = mobs.aim_direction((30, 3), (20, 5))
    assert advance_shot(30, 3, "west", 0, {(20, 5): "diagonal"}, direction=direction, travel=15)[2] == (20, 5)
    assert advance_shot(30, 3, "west", 0, {(20, 3): "sidestepped"}, direction=direction, travel=15)[2] is None


def test_delayed_tick_uses_elapsed_time_and_does_not_tunnel():
    shooter = mob(40, 3, kind=RANGED_KIND)
    projectile = {**shot(shooter, 40, 3, "west", 0), "updatedAt": NOW.timestamp() - 0.4}
    plan = plan_tick([player(10, 3)], [], LATER, NOW, first, [projectile])
    assert plan.shots[0]["x"] == pytest.approx(20)
    hit = plan_tick([player(25, 3)], [], LATER, NOW, first, [projectile])
    assert len(hit.shot_hits) == 1 and not hit.shots


def test_projectile_hit_eliminates_one_player_once_and_frees_them_from_other_attacks():
    victim = player(14, 3)
    shooter = mob(16, 3, kind=RANGED_KIND, attack_at=LATER)
    melee = mob(13, 3, facing="east")
    # Two shots in flight (a long miss outlasts the cooldown); the second passes the defeated player
    # and strikes the edge of the melee body behind them instead.
    first_shot, second_shot = shot(shooter, 16, 3, "west", 0), shot(shooter, 15, 3, "west", 6)
    plan = plan_tick([victim], [shooter, melee], LATER, NOW, first, [first_shot, second_shot])
    assert plan.shot_hits == [(shooter["id"], victim["player_id"])]
    assert plan.shots == [] and plan.mob_damage == {melee["id"]: 1} and plan.attacks == []
    # A shot outlives its defeated shooter, and the next tick does not repeat the hit.
    assert plan_tick([player(14, 3)], [], LATER, NOW, first, plan.shots).shot_hits == []


def test_public_mob_exposes_wind_up_state():
    assert public_mob(mob(15, 3, kind=RANGED_KIND, windup_until=LATER))["windingUp"] is True
    assert public_mob(mob(1, 1))["windingUp"] is False and RANGED_COOLDOWN_SECONDS == 3.0


def test_plan_attacks_on_cooldown_turns_while_waiting_pursues_and_honours_move_timing():
    target = player(10, 3)
    ready = mob(10, 4, facing="north", attack_at=EARLIER)
    cooling = mob(9, 3, facing="south", attack_at=LATER)
    far = mob(15, 3)
    resting = mob(20, 3, move_at=LATER)
    plan = plan_tick([target], [ready, cooling, far, resting], LATER, NOW, first)
    assert plan.attacks == [(ready["id"], target["player_id"], "north")]
    assert plan.turns == [(cooling["id"], "east")]
    assert plan.moves == [(far["id"], (14, 3), "west")]
    assert all(mob_id != resting["id"] for mob_id, _, _ in plan.moves)


def test_plan_keeps_an_equal_target_switches_when_closer_and_wanders_only_if_unreachable():
    north, south = player(5, 1, name="North"), player(5, 5, name="South")
    sticky = mob(5, 3, target_player_id=south["player_id"])
    tied = plan_tick([north, south], [sticky], LATER, NOW, first)
    assert tied.moves == [(sticky["id"], (5, 4), "south")]
    assert tied.retargets == []
    near, far = player(5, 0, name="Near"), player(5, 12, name="Far")
    switcher = mob(5, 3, target_player_id=far["player_id"])
    switched = plan_tick([far, near], [switcher], LATER, NOW, first)
    assert switched.moves == [(switcher["id"], (5, 2), "north")]
    assert switched.retargets == [(switcher["id"], near["player_id"])]
    # A dead or disconnected id is absent from the living list, so the next player is chosen.
    lost = mob(5, 3, target_player_id=uuid.uuid4())
    replaced = plan_tick([north], [lost], LATER, NOW, first)
    assert replaced.retargets == [(lost["id"], north["player_id"])]
    assert replaced.moves[0][1] == (5, 2)
    # Beyond the old 40-cell cutoff the mob still steps toward the only player.
    distant = player(55, 3)
    chaser = mob(5, 3)
    chase = plan_tick([distant], [chaser], LATER, NOW, first)
    assert chase.moves == [(chaser["id"], (6, 3), "east")]
    assert chase.retargets == [(chaser["id"], distant["player_id"])]
    # No route: wander inside the open pocket instead of attacking.
    center = mob(5, 3, target_player_id=distant["player_id"])
    walls = [mob(5, 2, move_at=LATER), mob(5, 4, move_at=LATER), mob(4, 3, move_at=LATER), mob(6, 3, move_at=LATER)]
    trapped = plan_tick([distant], [center, *walls], LATER, NOW, first)
    assert trapped.attacks == []
    assert all(mob_id != center["id"] for mob_id, _, _ in trapped.moves)
    assert (center["id"], None) in trapped.retargets
    # A closed pocket with one free cell wanders there instead of chasing through the wall.
    pocket = mob(5, 8)
    seal = [mob(x, y, move_at=LATER) for x, y in ((5, 7), (4, 8), (6, 8), (4, 9), (6, 9), (5, 10))]
    wandering = plan_tick([distant], [pocket, *seal], LATER, NOW, first)
    assert wandering.moves == [(pocket["id"], (5, 9), "south")]
    assert wandering.attacks == []


def test_plan_without_players_only_wanders_and_never_attacks():
    lonely = mob(10, 4)
    plan = plan_tick([], [lonely], EARLIER, NOW, first)
    assert plan.attacks == [] and plan.spawn is None
    assert len(plan.moves) == 1 and block_is_traversable(*plan.moves[0][1])


def test_plan_never_moves_two_mobs_into_one_cell_or_onto_a_player():
    target = player(5, 4)
    crowd = [mob(5, 2), mob(4, 2), mob(6, 2), mob(5, 1)]
    plan = plan_tick([target], crowd, LATER, NOW, first)
    destinations = [cell for _, cell, _ in plan.moves]
    assert len(destinations) == len(set(destinations))
    stationary = {(m["x"], m["y"]) for m in crowd if m["id"] not in {mob_id for mob_id, _, _ in plan.moves}}
    assert not set(destinations) & (stationary | {(5, 4)})


def test_pursuit_uses_every_cardinal_direction_order_from_the_shared_movement_contract():
    assert list(DIRECTIONS) == ["north", "south", "west", "east"]


class RecordingConnection:
    """Minimal fake for the mob damage path: records SQL and answers with scripted rows."""

    def __init__(self, deleted_revision):
        self.deleted_revision = deleted_revision
        self.calls = []

    async def fetchrow(self, query, *args):
        self.calls.append((query, args))
        if "UPDATE world_mobs" in query:
            return {"id": args[0], "kind": "basic", "x": 12, "y": 4, "facing": "south", "health": args[2], "revision": 6}
        raise AssertionError(query)

    async def fetchval(self, query, *args):
        self.calls.append((query, args))
        assert "DELETE FROM world_mobs" in query
        return self.deleted_revision

    async def execute(self, query, *args):
        self.calls.append((query, args))


def test_damage_reduces_health_then_defeats_exactly_once_without_a_reward():
    async def scenario():
        target = mob(12, 4, health=2)
        connection = RecordingConnection(deleted_revision=7)
        hit = await damage_mob(connection, "w", target, 1)
        assert hit["health"] == 1 and not hit["defeated"]
        assert not any("DELETE" in query for query, _ in connection.calls)

        target = mob(12, 4, health=1)
        hit = await damage_mob(connection, "w", target, 1)
        assert hit["defeated"] and hit["health"] == 0 and hit["revision"] == 8
        assert not any("gold" in query or "progression" in query for query, _ in connection.calls)

        gone = RecordingConnection(deleted_revision=None)
        hit = await damage_mob(gone, "w", target, MOB_HEALTH)
        assert hit["defeated"], "a mob already removed in this transaction is reported once"

    asyncio.run(scenario())


class LegacyMobConnection:
    """Answers the normalisation queries for one world's legacy mob rows."""

    def __init__(self, rows, players=()):
        self.rows = [dict(row) for row in rows]
        self.players = list(players)
        self.updates = []
        self.player_reads = 0

    async def fetch(self, query, *args):
        if "FROM player_positions" in query:
            self.player_reads += 1
            return [{"x": x, "y": y} for x, y in self.players]
        return [dict(row) for row in self.rows]

    async def execute(self, query, *args):
        assert query.strip().startswith("UPDATE world_mobs") and "DELETE" not in query
        mob_id, _, kind, health, x, y = args
        row = next(row for row in self.rows if row["id"] == mob_id)
        row.update(kind=kind, health=min(row["health"], health), x=x, y=y, revision=row["revision"] + 1)
        self.updates.append(mob_id)


def test_legacy_mobs_are_relocated_and_converted_in_place_without_deletion():
    async def scenario():
        stranded = mob(120, 30, kind="hunter", health=2)
        brute = mob(20, 2, kind="brute", health=5)
        basic = mob(21, 2)
        ranged = mob(22, 2, kind=RANGED_KIND)
        connection = LegacyMobConnection([stranded, brute, basic, ranged], players=[(11, 4)])
        rows, changed = await normalize_mobs(connection, "w", connection.rows)
        assert changed and connection.updates == [stranded["id"], brute["id"]]
        assert len(rows) == 4 and {row["id"] for row in rows} == {stranded["id"], brute["id"], basic["id"], ranged["id"]}
        assert [row["kind"] for row in rows] == [MOB_KIND, MOB_KIND, MOB_KIND, RANGED_KIND]
        assert all(row["health"] <= MOB_HEALTH for row in rows)
        assert all(block_is_traversable(row["x"], row["y"]) for row in rows)
        assert len({(row["x"], row["y"]) for row in rows} | {(11, 4)}) == 5
        again, changed = await normalize_mobs(connection, "w", rows)
        assert not changed and again == rows

    asyncio.run(scenario())


def test_normalisation_reads_player_occupancy_only_to_relocate_a_stranded_mob():
    async def scenario():
        brute = mob(20, 2, kind="brute", health=5)
        for rows, updated in (([], []), ([mob(20, 2), mob(22, 2, kind=RANGED_KIND)], []), ([brute], [brute["id"]])):
            connection = LegacyMobConnection(rows, players=[(11, 4)])
            _, changed = await normalize_mobs(connection, "w", connection.rows)
            assert connection.player_reads == 0 and connection.updates == updated and changed == bool(updated)

        # The first two free blocks hold a player and a valid mob, so both stranded mobs must go further.
        player_cell = first_spawn_block(None, set())
        valid = mob(*first_spawn_block(None, {player_cell}))
        connection = LegacyMobConnection([mob(120, 30), valid, mob(121, 30, kind="hunter")], players=[player_cell])
        rows, changed = await normalize_mobs(connection, "w", connection.rows)
        assert changed and connection.player_reads == 1 and len(connection.updates) == 2
        cells = [(row["x"], row["y"]) for row in rows]
        assert len(set(cells)) == 3 and player_cell not in cells and (valid["x"], valid["y"]) in cells
        assert all(block_is_traversable(*cell) for cell in cells)

    asyncio.run(scenario())


def test_a_stranded_mob_without_a_safe_destination_keeps_its_row(monkeypatch):
    async def scenario():
        monkeypatch.setattr("app.mobs.first_spawn_block", lambda *_: None)
        stranded = mob(120, 30, kind="hunter")
        connection = LegacyMobConnection([stranded])
        rows, changed = await normalize_mobs(connection, "w", connection.rows)
        assert not changed and connection.updates == [] and rows == [stranded]
        assert connection.player_reads == 1

    asyncio.run(scenario())


def shooter_setup(monkeypatch, connection):
    connection.fetchval.return_value = "east"


def test_laser_stops_at_the_nearer_mob_and_never_passes_through_to_the_player_behind(monkeypatch):
    async def scenario():
        attacker_id, victim_id = uuid.uuid4(), uuid.uuid4()
        attacker = dict(player_id=attacker_id, name="Archer", avatar="moss", x=11, y=4, revision=7)
        victim = dict(player_id=victim_id, name="Behind", avatar="tide", x=14, y=4, revision=2)
        connection = AsyncMock()
        connection.fetchrow.side_effect = [attacker, victim]
        shooter_setup(monkeypatch, connection)
        blocker = mob(12, 4)
        monkeypatch.setattr("app.mobs.mob_on_path", AsyncMock(return_value=blocker))
        damage = AsyncMock(return_value={"mobId": str(blocker["id"]), "x": 12, "y": 4, "health": 2, "maxHealth": 3, "revision": 2, "defeated": False})
        monkeypatch.setattr("app.mobs.damage_mob", damage)

        event_type, payload = await position_resolver(
            Command("mobs-test", "shot-1", "player.shoot", {"expectedRevision": 7}), ActorContext(str(attacker_id)), connection
        )

        assert event_type == "player.shot"
        assert payload["path"] == [{"x": 12, "y": 4}]
        assert payload["victim"] is None and payload["victims"] == []
        assert payload["combatElimination"] == {"attackerId": str(attacker_id), "victims": []}
        assert payload["mobHits"] == [damage.return_value] and "goldDrops" not in payload
        damage.assert_awaited_once_with(connection, "mobs-test", blocker, 1)

    asyncio.run(scenario())


def test_laser_hits_the_nearer_player_and_leaves_a_mob_behind_them_untouched(monkeypatch):
    async def scenario():
        attacker_id, victim_id = uuid.uuid4(), uuid.uuid4()
        attacker = dict(player_id=attacker_id, name="Archer", avatar="moss", x=11, y=4, revision=7)
        victim = dict(player_id=victim_id, name="Front", avatar="tide", x=12, y=4, revision=2)
        connection = AsyncMock()
        connection.fetchrow.side_effect = [attacker, victim]
        shooter_setup(monkeypatch, connection)
        monkeypatch.setattr("app.mobs.mob_on_path", AsyncMock(return_value=mob(14, 4)))
        damage = AsyncMock()
        monkeypatch.setattr("app.mobs.damage_mob", damage)

        _, payload = await position_resolver(
            Command("mobs-test", "shot-2", "player.shoot", {"expectedRevision": 7}), ActorContext(str(attacker_id)), connection
        )

        assert payload["victim"]["playerId"] == str(victim_id)
        assert payload["path"] == [{"x": 12, "y": 4}]
        assert payload["mobHits"] == []
        damage.assert_not_awaited()

    asyncio.run(scenario())


def test_laser_reaches_a_player_far_beyond_four_cells_and_stops_there(monkeypatch):
    async def scenario():
        attacker_id, victim_id = uuid.uuid4(), uuid.uuid4()
        attacker = dict(player_id=attacker_id, name="Archer", avatar="moss", x=11, y=4, revision=7)
        victim = dict(player_id=victim_id, name="Far", avatar="tide", x=40, y=4, revision=2)
        connection = AsyncMock()
        connection.fetchrow.side_effect = [attacker, victim]
        shooter_setup(monkeypatch, connection)

        _, payload = await position_resolver(
            Command("mobs-test", "shot-far", "player.shoot", {"expectedRevision": 7}), ActorContext(str(attacker_id)), connection
        )

        assert payload["victim"]["playerId"] == str(victim_id)
        assert payload["path"] == [{"x": x, "y": 4} for x in range(12, 41)]

    asyncio.run(scenario())


def test_laser_uses_the_requested_heading_and_falls_back_to_the_committed_facing(monkeypatch):
    async def fire(payload):
        attacker_id = uuid.uuid4()
        connection = AsyncMock()
        connection.fetchrow.side_effect = [dict(player_id=attacker_id, name="Archer", avatar="moss", x=11, y=4, revision=7), None]
        shooter_setup(monkeypatch, connection)
        _, shot = await position_resolver(
            Command("mobs-test", f"shot-{uuid.uuid4()}", "player.shoot", {"expectedRevision": 7, **payload}),
            ActorContext(str(attacker_id)), connection,
        )
        return shot

    async def scenario():
        assert (await fire({"facing": "south"}))["facing"] == "south"
        assert (await fire({}))["facing"] == "east"
        assert (await fire({"facing": "up"}))["facing"] == "east"

    asyncio.run(scenario())


def test_mob_kill_records_one_death_and_credits_no_account():
    async def scenario():
        victim_id = uuid.uuid4()

        class Connection:
            async def fetchval(self, query, *args):
                assert "DELETE FROM player_positions" in query and args[2] == 3
                return victim_id

        payload = {"combatElimination": {"attackerId": None, "victims": [
            {"playerId": str(victim_id), "positionRevision": 3, "x": 4, "y": 4},
            {"playerId": str(victim_id), "positionRevision": 3, "x": 4, "y": 4},
        ]}}
        await resolve_eliminations(Connection(), "w", payload)
        assert [v["playerId"] for v in payload["eliminatedVictims"]] == [str(victim_id)]
        assert set(payload) == {"eliminatedVictims"}

    asyncio.run(scenario())


# --- Real PostgreSQL scenarios (each owns a disposable schema) -----------------

pg = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
WORLD = "mob-world"


@asynccontextmanager
async def world(monkeypatch, *, exclusive=False, immediate_timers=True):
    from app.db import DatabaseConfig
    from app.migrate import run_migrations

    # Make every timer due immediately so a tick both spawns and acts.
    if immediate_timers:
        for name in ("TICK_SECONDS", "AI_TICK_SECONDS", "MOVE_SECONDS", "ATTACK_COOLDOWN_SECONDS", "SPAWN_INTERVAL_SECONDS"):
            monkeypatch.setattr(mobs, name, 0.0)
    schema = "party_conquest_preview_test_" + uuid.uuid4().hex[:12]
    await run_migrations(DatabaseConfig(DATABASE_URL, schema), log=lambda *_: None)
    stores = [PostgresWorldStore(DATABASE_URL, position_resolver, schema=schema, exclusive=exclusive and i == 0) for i in range(2)]
    await asyncio.gather(*(store.start() for store in stores))
    for store in stores:
        # The background sweeps must not race the scripted ticks below.
        store._mob_worker.cancel()
    ids = [uuid.uuid4(), uuid.uuid4()]
    actors = [ActorContext(str(pid)) for pid in ids]
    async with stores[0].pool.acquire() as conn:
        for index, pid in enumerate(ids):
            await conn.execute("INSERT INTO players(id,name,name_key,avatar,pin_salt,pin_hash) VALUES($1,$2,$2,'moss','00','00')", pid, f"p{index}")

    async def send(index, action, payload=None, command_id=None, replica=0):
        return await stores[replica].submit(Command(WORLD, command_id or str(uuid.uuid4()), action, payload or {}), actors[index])

    async def connect(index):
        await stores[0].pool.execute(
            "INSERT INTO player_world_connections(connection_id,world_id,player_id) VALUES($1,$2,$3)", uuid.uuid4(), WORLD, ids[index]
        )

    async def place_mob(x, y, health=MOB_HEALTH):
        return await stores[0].pool.fetchval(
            """INSERT INTO world_mobs(id,world_id,x,y,health,revision) VALUES($1,$2,$3,$4,$5,1) RETURNING id""",
            uuid.uuid4(), WORLD, x, y, health,
        )

    try:
        yield stores, ids, send, connect, place_mob
    finally:
        await asyncio.gather(*(store.close() for store in stores))
        conn = await asyncpg.connect(DATABASE_URL)
        try:
            await conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
        finally:
            await conn.close()


@pg
@pytest.mark.real_mobs
@pytest.mark.parametrize("kind", [MOB_KIND, RANGED_KIND])
@pytest.mark.parametrize("in_flight", [False, True])
def test_effective_movement_is_fifty_percent_faster_with_the_world_scheduler(monkeypatch, kind, in_flight):
    async def scenario():
        async with world(monkeypatch, immediate_timers=False) as (stores, ids, send, connect, place_mob):
            await send(0, "player.place", {"suggestedPosition": {"x": 70, "y": 3}})
            await connect(0)
            enemy_id = await place_mob(5, 3)
            async with stores[0].pool.acquire() as conn:
                await mobs.ensure_state(conn, WORLD)

                class ClockConnection:
                    """Use real SQL and tick scheduling with a deterministic server clock."""
                    now = NOW

                    async def fetchrow(self, query, *args):
                        query = query.replace("transaction_timestamp() now", f"'{self.now.isoformat()}'::timestamptz now")
                        return await conn.fetchrow(query, *args)

                    def __getattr__(self, name):
                        return getattr(conn, name)

                clock = ClockConnection()
                distances = []
                for interval in (0.8, MOVE_SECONDS):
                    monkeypatch.setattr(mobs, "MOVE_SECONDS", interval)
                    await conn.execute(
                        "UPDATE world_mobs SET kind=$2, x=5, y=3, next_move_at=$3, next_attack_at=$4, target_player_id=NULL WHERE id=$1",
                        enemy_id, kind, NOW + timedelta(seconds=interval), NOW + timedelta(hours=1),
                    )
                    await conn.execute(
                        "UPDATE world_mob_states SET next_tick_at=$2, next_spawn_at=$3, projectiles='[]' WHERE world_id=$1",
                        WORLD, NOW, NOW + timedelta(hours=1),
                    )
                    # Match _mob_loop's 25 ms sweep, including tick's persisted
                    # gate. Keep a harmless rocket in flight for the physics case.
                    for sweep in range(481):
                        clock.now = NOW + timedelta(seconds=sweep * mobs.TICK_SECONDS / 2)
                        if in_flight:
                            rocket = {**shot(mob(60, 3, mob_id=enemy_id), 60, 3, "east", 0),
                                      "updatedAt": clock.now.timestamp() - mobs.TICK_SECONDS / 2}
                            await conn.execute("UPDATE world_mob_states SET projectiles=$2::jsonb WHERE world_id=$1", WORLD, json.dumps([rocket]))
                        await mobs.tick(clock, WORLD, choose=first)
                    distances.append(await conn.fetchval("SELECT x-5 FROM world_mobs WHERE id=$1", enemy_id))
                assert distances[0] == 15
                assert distances[1] == 22
                assert abs(distances[1] - distances[0] * 1.5) <= 1
    asyncio.run(scenario())


@pg
@pytest.mark.real_mobs
@pytest.mark.parametrize("replacement", [False, True])
def test_spawned_and_respawned_enemies_use_the_faster_movement_deadline(monkeypatch, replacement):
    async def scenario():
        async with world(monkeypatch, immediate_timers=False) as (stores, ids, send, connect, _):
            await send(0, "player.place", {"suggestedPosition": {"x": 70, "y": 3}})
            await connect(0)
            async with stores[0].pool.acquire() as conn:
                await mobs.ensure_state(conn, WORLD)
                if replacement:
                    await conn.execute("UPDATE world_mob_states SET ranged_respawns=ARRAY[now()], next_spawn_at=now()+interval '1 hour' WHERE world_id=$1", WORLD)
                result = await mobs.tick(conn, WORLD, choose=lambda _: (5, 3))
                assert len(result["spawned"]) == 1
                row = await conn.fetchrow("SELECT next_move_at-transaction_timestamp() delay FROM world_mobs WHERE world_id=$1", WORLD)
                assert row["delay"].total_seconds() == pytest.approx(MOVE_SECONDS, abs=0.1)
    asyncio.run(scenario())


@pg
@pytest.mark.real_mobs
def test_mobs_spawn_to_the_cap_only_for_connected_players_and_tick_once_across_replicas(monkeypatch):
    async def scenario():
        async with world(monkeypatch) as (stores, ids, send, connect, _):
            await send(0, "player.place", {"suggestedPosition": {"x": 11, "y": 4}})
            assert await stores[0].tick_mobs(WORLD) is None, "no connected player: nothing spawns"
            assert (await stores[1].snapshot(WORLD))["state"]["mobs"] == []
            await connect(0)
            for _ in range(SOLO_POPULATION + 2):
                await stores[0].tick_mobs(WORLD)
            snapshot = await stores[1].snapshot(WORLD)
            population = snapshot["state"]["mobs"]
            assert len(population) == SOLO_POPULATION
            assert sorted(m["kind"] for m in population) == [MOB_KIND, MOB_KIND, RANGED_KIND]
            cells = {(m["x"], m["y"]) for m in population}
            assert len(cells) == SOLO_POPULATION and all(block_is_traversable(*cell) for cell in cells)
            assert all(m["health"] == m["maxHealth"] == MOB_HEALTH for m in population)
            # A crowd already above the target is left in place and not refilled.
            extra = spawn_cell(cells | {(11, 4)}, [(11, 4)], first)
            extra_id = await stores[0].pool.fetchval(
                """INSERT INTO world_mobs(id,world_id,kind,x,y,health,revision) VALUES($1,$2,'basic',$3,$4,3,1) RETURNING id""",
                uuid.uuid4(), WORLD, extra[0], extra[1],
            )
            for _ in range(2):
                await stores[0].tick_mobs(WORLD)
            held = (await stores[1].snapshot(WORLD))["state"]["mobs"]
            assert len(held) == SOLO_POPULATION + 1 and str(extra_id) in {m["mobId"] for m in held}
            await stores[0].pool.execute("DELETE FROM world_mobs WHERE id=$1", extra_id)
            # A second living player is a placed position plus a fresh connection.
            # Their avatar must differ from the connected player's claim.
            await stores[0].pool.execute("UPDATE players SET avatar='tide' WHERE id=$1", ids[1])
            await send(1, "player.place", {"suggestedPosition": {"x": 30, "y": 5}})
            await connect(1)
            for _ in range(3):
                await stores[0].tick_mobs(WORLD)
            capped = (await stores[0].snapshot(WORLD))["state"]["mobs"]
            assert len(capped) == POPULATION_CAP
            assert sorted(m["kind"] for m in capped) == [MOB_KIND, MOB_KIND, RANGED_KIND, RANGED_KIND]
            events = await stores[0].replay(WORLD, 1)
            ticks = [event for event in events if event["eventType"] == "mob.tick"]
            assert ticks and all(event["payload"]["attackerName"] == "a mob" for event in ticks)
            assert sum(len(event["payload"]["spawned"]) for event in ticks) == POPULATION_CAP
            # A due tick is processed by exactly one replica even when both sweep at the same instant.
            monkeypatch.setattr(mobs, "TICK_SECONDS", 30.0)
            monkeypatch.setattr(mobs, "AI_TICK_SECONDS", 30.0)
            await stores[0].tick_mobs(WORLD)
            outcomes = await asyncio.gather(stores[0].tick_mobs(WORLD), stores[1].tick_mobs(WORLD))
            assert all(outcome is None for outcome in outcomes)
    asyncio.run(scenario())


@pg
@pytest.mark.real_mobs
def test_adjacent_mob_kills_a_player_without_crediting_anyone_and_the_player_respawns(monkeypatch):
    async def scenario():
        async with world(monkeypatch) as (stores, ids, send, connect, place_mob):
            await send(0, "player.place", {"suggestedPosition": {"x": 11, "y": 4}})
            await send(1, "player.place", {"suggestedPosition": {"x": 30, "y": 4}})
            await connect(0)
            await connect(1)
            monkeypatch.setattr(mobs, "SPAWN_INTERVAL_SECONDS", 3600.0)
            async with stores[0].pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO world_mob_states(world_id,next_spawn_at) VALUES($1,now()+interval '1 hour')
                       ON CONFLICT (world_id) DO UPDATE SET next_spawn_at=EXCLUDED.next_spawn_at""", WORLD,
                )
            attacker = await place_mob(12, 4)
            lethal = await stores[1].tick_mobs(WORLD)
            assert lethal["attacks"] == [{"mobId": str(attacker), "playerId": str(ids[0]), "outcome": "eliminated"}]
            assert [v["playerId"] for v in lethal["eliminatedVictims"]] == [str(ids[0])]
            assert not {"goldDrops", "combatRecords", "progressions", "shieldImpacts"} & set(lethal)
            snapshot = await stores[0].snapshot(WORLD)
            assert [p["playerId"] for p in snapshot["state"]["players"]] == [str(ids[1])]
            death_revision = snapshot["state"]["eliminated"][str(ids[0])]
            assert snapshot["state"]["deathAttribution"][str(ids[0])] == "a mob"
            with pytest.raises(TransportError) as error:
                await send(0, "player.place", {"suggestedPosition": {"x": 11, "y": 4}})
            assert error.value.code == "not_active"
            rejoined, _ = await send(0, "player.place", {"suggestedPosition": {"x": 5, "y": 4}, "expectedDeathRevision": death_revision})
            assert rejoined["event"]["payload"]["avatar"] == "moss" and rejoined["event"]["payload"]["name"] == "p0"
    asyncio.run(scenario())


@pg
@pytest.mark.real_mobs
def test_three_laser_hits_defeat_a_mob_that_blocks_movement_and_rewards_nothing(monkeypatch):
    async def scenario():
        async with world(monkeypatch) as (stores, ids, send, connect, place_mob):
            await send(0, "player.place", {"suggestedPosition": {"x": 11, "y": 4}})
            await send(0, "player.move", {"expected": {"x": 11, "y": 4}, "destination": {"x": 12, "y": 4}, "expectedRevision": 1})
            target = await place_mob(14, 4)
            await send(0, "player.move", {"expected": {"x": 12, "y": 4}, "destination": {"x": 13, "y": 4}, "expectedRevision": 2})
            with pytest.raises(TransportError) as occupied:
                await send(0, "player.move", {"expected": {"x": 13, "y": 4}, "destination": {"x": 14, "y": 4}, "expectedRevision": 3})
            assert occupied.value.code == "occupied"
            for expected_health in (2, 1, 0):
                outcome, _ = await send(0, "player.shoot", {"expectedRevision": 3}, replica=expected_health % 2)
                payload = outcome["event"]["payload"]
                assert payload["path"] == [{"x": 14, "y": 4}]
                hit = payload["mobHits"][0]
                assert (hit["mobId"], hit["health"], hit["defeated"]) == (str(target), expected_health, expected_health == 0)
                assert payload["victim"] is None and "goldDrops" not in payload
            snapshot = await stores[1].snapshot(WORLD)
            assert snapshot["state"]["mobs"] == []
            assert set(snapshot["state"]) == {"players", "eliminated", "deathAttribution", "mobs", "mobProjectiles"}
            # Replaying the same command never re-damages.
            replay, duplicate = await send(0, "player.shoot", {"expectedRevision": 3}, outcome["event"]["commandId"], replica=1)
            assert duplicate and replay == outcome
    asyncio.run(scenario())


@pg
@pytest.mark.real_mobs
@pytest.mark.parametrize("exclusive", [False, True])
def test_ranged_mob_winds_up_fires_once_per_cooldown_and_eliminates_a_player_once(monkeypatch, exclusive):
    async def scenario():
        async with world(monkeypatch, exclusive=exclusive) as (stores, ids, send, connect, place_mob):
            monkeypatch.setattr(mobs, "WINDUP_SECONDS", 0.0)
            await send(0, "player.place", {"suggestedPosition": {"x": 11, "y": 4}})
            await send(1, "player.place", {"suggestedPosition": {"x": 30, "y": 20}})
            await connect(0)
            await connect(1)
            async with stores[0].pool.acquire() as conn:
                await conn.execute(
                    """INSERT INTO world_mob_states(world_id,next_spawn_at) VALUES($1,now()+interval '1 hour')
                       ON CONFLICT (world_id) DO UPDATE SET next_spawn_at=EXCLUDED.next_spawn_at""", WORLD,
                )
            shooter = await place_mob(16, 4)
            await stores[0].pool.execute("UPDATE world_mobs SET kind='ranged' WHERE id=$1", shooter)
            winding = await stores[0].tick_mobs(WORLD)
            assert winding["mobs"][0]["windingUp"] and winding["mobs"][0]["facing"] == "west"
            launched = await stores[1].tick_mobs(WORLD)
            assert [(s["x"], s["y"], s["facing"], s["distance"]) for s in launched["projectiles"]] == [(16, 4, "west", 0)]
            assert (await stores[0].snapshot(WORLD))["state"]["mobProjectiles"] == launched["projectiles"]
            row = await stores[0].pool.fetchrow("SELECT next_attack_at, windup_until FROM world_mobs WHERE id=$1", shooter)
            assert row["windup_until"] is None
            if exclusive:
                # A real socket-style move remains in memory until the physics
                # transaction flushes it. Hit testing must use this new position.
                position = next(p for p in (await stores[0].snapshot(WORLD))["state"]["players"] if p["playerId"] == str(ids[0]))
                await stores[0].submit_live(Command(WORLD, str(uuid.uuid4()), "player.move", {
                    "expected": {"x": 11, "y": 4}, "destination": {"x": 12, "y": 4},
                    "expectedRevision": position["positionRevision"],
                }), ActorContext(str(ids[0])))
            flight = []
            for index in range(3):
                await stores[0].pool.execute(
                    "UPDATE world_mob_states SET next_tick_at=now()-interval '1 second', projectiles=(SELECT coalesce(jsonb_agg(s - 'updatedAt'), '[]') FROM jsonb_array_elements(projectiles) s) WHERE world_id=$1", WORLD)
                flight.append(await stores[0 if exclusive else index % 2].tick_mobs(WORLD))
            hits = [payload for payload in flight if payload and payload["attacks"]]
            assert len(hits) == 1 and hits[0]["attacks"] == [
                {"mobId": str(shooter), "playerId": str(ids[0]), "outcome": "eliminated", "ranged": True}
            ]
            assert [v["playerId"] for v in hits[0]["eliminatedVictims"]] == [str(ids[0])]
            assert hits[0]["projectiles"] == []
            assert hits[0]["eliminatedVictims"][0]["x"] == (12 if exclusive else 11)
            # The cooldown runs from launch: no new wind-up while it lasts, even with a new target.
            for _ in range(3):
                payload = await stores[0].tick_mobs(WORLD)
                assert not payload or (not payload["projectiles"] and not any(m["windingUp"] for m in payload["mobs"]))
            later = await stores[0].pool.fetchrow("SELECT next_attack_at, windup_until FROM world_mobs WHERE id=$1", shooter)
            assert later["next_attack_at"] == row["next_attack_at"] and later["windup_until"] is None
            snapshot = await stores[1].snapshot(WORLD)
            assert [p["playerId"] for p in snapshot["state"]["players"]] == [str(ids[1])]
            assert snapshot["state"]["deathAttribution"][str(ids[0])] == "a mob"
    asyncio.run(scenario())


def test_rockets_damage_nearest_friendly_mob_without_hitting_the_shooter_or_piercing():
    target = player(10, 3)
    shooter = mob(16, 3, kind=RANGED_KIND, attack_at=LATER)
    blocker = mob(14, 3, move_at=LATER, attack_at=LATER)
    rocket = shot(shooter, 16, 3, "west", 0)
    plan = plan_tick([target], [shooter, blocker], LATER, NOW, first, [rocket])
    assert plan.mob_damage == {blocker["id"]: 1}
    assert not plan.shots and not plan.shot_hits
    # Three rockets kill the blocker before its due attack/launch this tick.
    blocker.update(health=3, kind=RANGED_KIND, target_player_id=target["player_id"], windup_until=EARLIER)
    plan = plan_tick([target], [shooter, blocker], LATER, NOW, first, [rocket] * 3)
    assert plan.mob_damage == {blocker["id"]: 3}
    assert not plan.shots and not plan.shot_hits and not plan.launches


def test_ranged_respawn_slots_wait_ten_seconds_without_melee_filling_them():
    players = [player(10, 3)]
    survivors = [mob(30, 3), mob(31, 3)]
    ready_at = NOW + timedelta(seconds=10)
    assert plan_tick(players, survivors, EARLIER, ready_at - timedelta(microseconds=1), first,
                     ranged_respawns=[ready_at]).spawn is None
    ready = plan_tick(players, survivors, ready_at + timedelta(hours=1), ready_at, first,
                      ranged_respawns=[ready_at])
    assert ready.spawn and ready.spawn_kind == RANGED_KIND and ready.consume_respawn
    # Separate deaths reserve separate slots, even if one is now ready.
    pair = [*players, player(10, 5)]
    first_due = plan_tick(pair, survivors, LATER, NOW, first,
                          ranged_respawns=[NOW, ready_at])
    assert first_due.spawn_kind == RANGED_KIND and first_due.consume_respawn
    assert plan_tick(pair, survivors, EARLIER, NOW, first,
                     ranged_respawns=[ready_at, ready_at]).spawn is None


@pg
@pytest.mark.real_mobs
@pytest.mark.parametrize("friendly_fire", [False, True])
def test_ranged_death_persists_one_respawn_deadline_and_replaces_only_when_due(monkeypatch, friendly_fire):
    async def scenario():
        async with world(monkeypatch) as (stores, ids, send, connect, place_mob):
            await send(0, "player.place", {"suggestedPosition": {"x": 11, "y": 4}})
            await connect(0)
            target = await place_mob(14, 4, health=1)
            await stores[0].pool.execute("UPDATE world_mobs SET kind='ranged' WHERE id=$1", target)
            await place_mob(30, 3)
            await place_mob(31, 3)
            await stores[0].pool.execute("UPDATE world_mobs SET next_move_at=now()+interval '1 hour', next_attack_at=now()+interval '1 hour' WHERE world_id=$1", WORLD)
            async with stores[0].pool.acquire() as conn:
                await mobs.ensure_state(conn, WORLD)
                before = await conn.fetchval("SELECT transaction_timestamp()")
            if friendly_fire:
                rocket = {"id": str(uuid.uuid4()), "mobId": str(uuid.uuid4()), "x": 16, "y": 4, "facing": "west", "distance": 0}
                await stores[0].pool.execute("UPDATE world_mob_states SET projectiles=$2::jsonb WHERE world_id=$1", WORLD, json.dumps([rocket]))
                payload = await stores[0].tick_mobs(WORLD)
            else:
                outcome, _ = await send(0, "player.shoot", {"expectedRevision": 1, "facing": "east"})
                payload = outcome["event"]["payload"]
            assert payload["mobHits"][0]["defeated"]
            assert not payload["eliminatedVictims"]
            deadlines = await stores[0].pool.fetchval("SELECT ranged_respawns FROM world_mob_states WHERE world_id=$1", WORLD)
            assert len(deadlines) == 1 and 10 <= (deadlines[0] - before).total_seconds() < 11
            # Another replica sees the reserved slot and cannot fill it early.
            await stores[1].tick_mobs(WORLD)
            assert len((await stores[1].snapshot(WORLD))["state"]["mobs"]) == 2
            await stores[0].pool.execute("UPDATE world_mob_states SET ranged_respawns=ARRAY[now()-interval '1 second'], next_spawn_at=now()+interval '1 hour', next_tick_at=now()-interval '1 second' WHERE world_id=$1", WORLD)
            replacement = await stores[1].tick_mobs(WORLD)
            assert len(replacement["spawned"]) == 1 and replacement["spawned"][0]["kind"] == RANGED_KIND
            assert await stores[0].pool.fetchval("SELECT ranged_respawns FROM world_mob_states WHERE world_id=$1", WORLD) == []
    asyncio.run(scenario())
