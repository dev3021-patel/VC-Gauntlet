import asyncio
import json
import os
import uuid
from pathlib import Path

import asyncpg
import pytest

from app.player_positions import (
    ACTIONS,
    MOVEMENT_BLOCK_SIZE,
    MOVEMENT_WORLD_SIZE,
    PROJECTILE_ACTIONS,
    PROJECTILE_REVISION_LAG,
    TERRAIN_WORLD_SIZE,
    TRAVERSABLE_BLOCKS,
    block_is_traversable,
    arrow_path,
    first_spawn_block,
    position_resolver,
    revision_is_current,
    terrain_at,
)
from app.world_transport import ActorContext, Command, PostgresWorldStore, TransportError

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
TERRAIN_CONTRACT = json.loads((Path(__file__).parents[2] / "terrain-contract.json").read_text())


def position_command(player_id, number, action, payload):
    return Command("positions-test", f"{player_id}-{number}", action, payload)


def test_projectiles_tolerate_a_bounded_revision_lag_while_other_commands_stay_exact():
    for action in PROJECTILE_ACTIONS:
        assert revision_is_current(action, 50, 50)
        assert revision_is_current(action, 50 - PROJECTILE_REVISION_LAG, 50)
        assert not revision_is_current(action, 49 - PROJECTILE_REVISION_LAG, 50)
        assert not revision_is_current(action, 51, 50)
    assert PROJECTILE_ACTIONS == {"player.shoot"}
    for action in ("player.move", "player.face", "player.avatar"):
        assert revision_is_current(action, 50, 50)
        assert not revision_is_current(action, 49, 50)


def test_only_core_actions_are_accepted():
    assert ACTIONS == {"player.place", "player.move", "player.shoot", "player.face", "player.avatar"}

    async def scenario():
        for number, action in enumerate((
            "player.special_shoot", "player.throw_grenade", "player.throw_heavy_grenade", "player.throw_web",
            "player.self_destruct", "player.buy_avatar", "player.buy_shield", "player.activate_speed",
            "player.activate_nitro", "player.toggle_door", "player.steal_grenade", "player.stealth",
        )):
            with pytest.raises(TransportError) as error:
                await position_resolver(position_command("x", number, action, {}), ActorContext(str(uuid.uuid4())), None)
            assert error.value.code == "unsupported_action"
    asyncio.run(scenario())


def test_terrain_contract_matches_known_map_regions():
    codes = {"water": 0, "wall": 1, "land": 2, "tree": 3, "barricade": 4, "bridge": 5, "courtyard": 6}
    checksum = 2_166_136_261
    for y in range(TERRAIN_WORLD_SIZE):
        for x in range(TERRAIN_WORLD_SIZE):
            checksum ^= codes[terrain_at(x, y)]
            checksum = (checksum * 16_777_619) & 0xFFFFFFFF
    assert f"{checksum:08x}" == TERRAIN_CONTRACT["fnv1a32"]
    assert len(TRAVERSABLE_BLOCKS) == TERRAIN_CONTRACT["traversableBlocks"]
    assert MOVEMENT_WORLD_SIZE == 80

def test_blocks_are_traversable_only_when_all_64_pixels_are_land():
    for block_y in range(MOVEMENT_WORLD_SIZE):
        for block_x in range(MOVEMENT_WORLD_SIZE):
            pixels = (
                terrain_at(x, y)
                for y in range(block_y * MOVEMENT_BLOCK_SIZE, (block_y + 1) * MOVEMENT_BLOCK_SIZE)
                for x in range(block_x * MOVEMENT_BLOCK_SIZE, (block_x + 1) * MOVEMENT_BLOCK_SIZE)
            )
            assert block_is_traversable(block_x, block_y) == all(pixel in {"land", "bridge", "courtyard"} for pixel in pixels)
    assert not block_is_traversable(-1, 4)
    assert not block_is_traversable(MOVEMENT_WORLD_SIZE, 4)


def test_spawn_preserves_valid_block_uses_random_fallback_and_reports_exhaustion():
    first = lambda choices: choices[0]
    assert first_spawn_block((11, 4), set(), first) == (11, 4)
    fallback = first_spawn_block((0, 0), set(), first)
    assert fallback is not None and block_is_traversable(*fallback)
    all_land = set(TRAVERSABLE_BLOCKS)
    assert first_spawn_block((11, 4), all_land, first) is None


def test_laser_path_is_ordered_and_runs_until_terrain_or_the_map_edge():
    south = arrow_path(3, 4, "south")
    assert south[:4] == [(3, 5), (3, 6), (3, 7), (3, 8)]
    assert len(south) > 4 and not block_is_traversable(3, south[-1][1] + 1)
    assert arrow_path(66, 44, "north") == []  # preserved fortress wall
    assert arrow_path(11, 4, "east")[:4] == [(12, 4), (13, 4), (14, 4), (15, 4)]
    assert arrow_path(0, 0, "west") == []  # world edge (also non-traversable origin)
    assert all(0 <= x < MOVEMENT_WORLD_SIZE for x, _ in arrow_path(11, 4, "east"))


async def positioned_world(xs=(11, 13)):
    connection = await asyncpg.connect(DATABASE_URL)
    player_ids = [uuid.uuid4(), uuid.uuid4()]
    try:
        await connection.execute(
            "TRUNCATE player_positions, world_events, world_commands, "
            "world_streams, player_tokens, players CASCADE"
        )
        for index, player_id in enumerate(player_ids):
            await connection.execute(
                """INSERT INTO players(id,name,name_key,avatar,pin_salt,pin_hash)
                   VALUES($1,$2,$3,'moss','00','00')""",
                player_id,
                f"Player {index}",
                f"player-{index}",
            )
    finally:
        await connection.close()

    stores = [PostgresWorldStore(DATABASE_URL, position_resolver) for _ in range(2)]
    await asyncio.gather(*(store.start() for store in stores))
    actors = [ActorContext(str(item)) for item in player_ids]
    for index, x in enumerate(xs):
        await stores[0].submit(
            position_command(player_ids[index], 1, "player.place", {"suggestedPosition": {"x": x, "y": 4}}),
            actors[index],
        )
    return stores, player_ids, actors


async def close_stores(stores):
    await asyncio.gather(*(store.close() for store in stores))


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_placement_and_snapshot_are_complete_and_unique():
    async def scenario():
        stores, _, _ = await positioned_world()
        try:
            snapshot = await stores[0].snapshot("positions-test")
            positions = snapshot["state"]["players"]
            assert len(positions) == 2
            assert {(item["x"], item["y"]) for item in positions} == {(11, 4), (13, 4)}
            assert all("firstSpawn" not in item for item in positions)
            connection = await asyncpg.connect(DATABASE_URL)
            try:
                flags = await connection.fetch(
                    """SELECT event->'payload'->>'firstSpawn' AS first_spawn FROM world_events
                       WHERE world_id='positions-test' AND event->>'eventType'='player.placed'
                       ORDER BY revision"""
                )
                assert [row["first_spawn"] for row in flags] == ["true", "true"]
            finally:
                await connection.close()
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_cross_replica_collision_commits_once_and_replays_idempotently():
    async def scenario():
        stores, player_ids, actors = await positioned_world()
        moves = [
            position_command(player_ids[0], 2, "player.move", {
                "expected": {"x": 11, "y": 4}, "destination": {"x": 12, "y": 4}, "expectedRevision": 1,
            }),
            position_command(player_ids[1], 2, "player.move", {
                "expected": {"x": 13, "y": 4}, "destination": {"x": 12, "y": 4}, "expectedRevision": 2,
            }),
        ]
        try:
            results = await asyncio.gather(
                stores[0].submit(moves[0], actors[0]),
                stores[1].submit(moves[1], actors[1]),
                return_exceptions=True,
            )
            successes = [item for item in results if not isinstance(item, Exception)]
            failures = [item for item in results if isinstance(item, Exception)]
            assert len(successes) == len(failures) == 1
            assert isinstance(failures[0], TransportError) and failures[0].code == "occupied"
            winner = successes[0][0]
            winner_index = 0 if winner["event"]["payload"]["playerId"] == str(player_ids[0]) else 1
            duplicate, replayed = await stores[0].submit(moves[winner_index], actors[winner_index])
            assert replayed is True
            assert duplicate == winner
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_stale_diagonal_and_multicell_moves_are_rejected():
    async def scenario():
        stores, player_ids, actors = await positioned_world()
        try:
            stale_payload = {
                "expected": {"x": 10, "y": 4}, "destination": {"x": 11, "y": 5}, "expectedRevision": 1,
            }
            with pytest.raises(TransportError) as stale:
                await stores[0].submit(position_command(player_ids[0], 2, "player.move", stale_payload), actors[0])
            assert stale.value.code == "stale_position"

            for number, destination in ((3, {"x": 12, "y": 5}), (4, {"x": 13, "y": 4})):
                payload = {
                    "expected": {"x": 11, "y": 4}, "destination": destination, "expectedRevision": 1,
                }
                with pytest.raises(TransportError) as invalid:
                    await stores[0].submit(position_command(player_ids[0], number, "player.move", payload), actors[0])
                assert invalid.value.code == "invalid_move"
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_blocked_and_out_of_bounds_destinations_are_rejected():
    async def scenario():
        stores, player_ids, actors = await positioned_world((1, 3))
        try:
            for number, destination in ((2, {"x": 0, "y": 4}), (3, {"x": -1, "y": 4})):
                payload = {
                    "expected": {"x": 1, "y": 4}, "destination": destination, "expectedRevision": 1,
                }
                with pytest.raises(TransportError) as blocked:
                    await stores[0].submit(position_command(player_ids[0], number, "player.move", payload), actors[0])
                expected_code = "blocked_terrain" if number == 2 else "invalid_move"
                assert blocked.value.code == expected_code
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_adjacent_players_cannot_swap_across_replicas():
    async def scenario():
        stores, player_ids, actors = await positioned_world((11, 12))
        try:
            commands = [
                position_command(player_ids[0], 2, "player.move", {
                    "expected": {"x": 11, "y": 4}, "destination": {"x": 12, "y": 4}, "expectedRevision": 1,
                }),
                position_command(player_ids[1], 2, "player.move", {
                    "expected": {"x": 12, "y": 4}, "destination": {"x": 11, "y": 4}, "expectedRevision": 2,
                }),
            ]
            swaps = await asyncio.gather(
                stores[0].submit(commands[0], actors[0]),
                stores[1].submit(commands[1], actors[1]),
                return_exceptions=True,
            )
            assert all(isinstance(item, TransportError) and item.code == "occupied" for item in swaps)
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_shot_kills_first_target_once_and_preserves_shooter_for_replay():
    async def scenario():
        stores, player_ids, actors = await positioned_world((11, 13))
        try:
            await stores[0].submit(position_command(player_ids[0], 2, "player.move", {
                "expected": {"x": 11, "y": 4}, "destination": {"x": 12, "y": 4}, "expectedRevision": 1,
            }), actors[0])
            command = position_command(player_ids[0], 3, "player.shoot", {"expectedRevision": 2})
            outcome, duplicate = await stores[0].submit(command, actors[0])
            assert not duplicate
            assert outcome["event"]["payload"]["victim"]["playerId"] == str(player_ids[1])
            assert outcome["event"]["payload"]["path"] == [{"x": 13, "y": 4}]
            assert outcome["event"]["payload"]["eliminatedVictims"][0]["playerId"] == str(player_ids[1])
            assert "combatRecords" not in outcome["event"]["payload"]

            replay, duplicate = await stores[1].submit(command, actors[0])
            assert duplicate and replay == outcome
            snapshot = await stores[0].snapshot("positions-test")
            players = snapshot["state"]["players"]
            assert [(item["playerId"], item["facing"]) for item in players] == [(str(player_ids[0]), "east")]
            assert set(snapshot["state"]) == {"players", "eliminated", "deathAttribution", "mobs", "mobProjectiles"}
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


def test_avatar_change_rejects_unauthorized_before_reading_state():
    async def scenario():
        with pytest.raises(TransportError) as avatar_error:
            await position_resolver(position_command('anonymous', 2, 'player.avatar', {'avatar': 'dog'}), ActorContext(), None)
        assert avatar_error.value.code == 'unauthorized'
    asyncio.run(scenario())


class AvatarConnection:
    def __init__(self):
        self.row = {'player_id': uuid.uuid4(), 'name': 'Player', 'avatar': 'moss', 'x': 11, 'y': 4, 'revision': 8}
        self.writes = 0

    async def fetchrow(self, sql, *args):
        if sql.strip().startswith('UPDATE'):
            raise AssertionError('avatar account writes use execute')
        return self.row

    async def execute(self, sql, *args):
        assert sql.startswith('UPDATE players SET avatar=')
        self.row = {**self.row, 'avatar': args[1]}
        self.writes += 1

    async def fetchval(self, sql, *args):
        return 'east'


def test_avatar_change_validates_and_returns_authoritative_player_without_moving():
    async def scenario():
        connection = AvatarConnection()
        actor = ActorContext(str(connection.row['player_id']))
        before = {key: connection.row[key] for key in ('x', 'y', 'revision')}
        event_type, player = await position_resolver(
            position_command(actor.actor_id, 1, 'player.avatar', {'avatar': 'cowboy-hat', 'expectedRevision': 8}),
            actor, connection,
        )
        assert event_type == 'player.avatar_changed'
        assert player['avatar'] == 'cowboy-hat' and player['facing'] == 'east'
        assert {key: player[{'revision': 'positionRevision'}.get(key, key)] for key in before} == before
        assert connection.writes == 1

        with pytest.raises(TransportError) as error:
            await position_resolver(
                position_command(actor.actor_id, 2, 'player.avatar', {'avatar': 'unicorn', 'expectedRevision': 8}),
                actor, connection,
            )
        assert error.value.code == 'avatar-invalid' and connection.writes == 1
    asyncio.run(scenario())

def test_former_shop_avatars_are_free_for_every_account():
    async def scenario():
        connection = AvatarConnection()
        actor = ActorContext(str(connection.row['player_id']))
        for number, avatar in enumerate(('robot', 'dragon', 'crown', 'skull'), start=1):
            event_type, player = await position_resolver(
                position_command(actor.actor_id, number, 'player.avatar', {'avatar': avatar, 'expectedRevision': 8}),
                actor, connection,
            )
            assert event_type == 'player.avatar_changed' and player['avatar'] == avatar
            assert 'progression' not in player and 'unlockedAvatars' not in player
        assert connection.writes == 4
    asyncio.run(scenario())


def test_avatar_held_by_a_connected_player_is_rejected_without_writing(monkeypatch):
    async def held(*args):
        return False
    monkeypatch.setattr('app.avatar_claims.claim', held)

    async def scenario():
        connection = AvatarConnection()
        actor = ActorContext(str(connection.row['player_id']))
        with pytest.raises(TransportError) as error:
            await position_resolver(
                position_command(actor.actor_id, 1, 'player.avatar', {'avatar': 'dog', 'expectedRevision': 8}), actor, connection,
            )
        assert (error.value.code, error.value.status) == ('avatar_in_use', 409)
        assert connection.writes == 0 and connection.row['avatar'] == 'moss'
    asyncio.run(scenario())


def test_custom_avatar_is_selectable_only_by_its_owner_and_current_upload():
    class CustomConnection(AvatarConnection):
        async def fetchval(self, sql, *args):
            if 'FROM player_custom_avatars' in sql:
                return self.custom if args[0] == self.row['player_id'] else None
            return await super().fetchval(sql, *args)

    async def scenario():
        connection = CustomConnection()
        owner = connection.row['player_id']
        connection.custom = f'custom-{owner.hex}-0000abcd'
        actor = ActorContext(str(owner))
        for index, avatar in enumerate((f'custom-{uuid.uuid4().hex}-0000abcd', f'custom-{owner.hex}-0000ffff'), start=1):
            with pytest.raises(TransportError) as error:
                await position_resolver(
                    position_command(actor.actor_id, index, 'player.avatar', {'avatar': avatar, 'expectedRevision': 8}), actor, connection,
                )
            assert error.value.code == 'avatar-locked' and connection.writes == 0
        event_type, player = await position_resolver(
            position_command(actor.actor_id, 3, 'player.avatar', {'avatar': connection.custom, 'expectedRevision': 8}), actor, connection,
        )
        # Equipped, the upload is public like any other avatar on the shared marker.
        assert event_type == 'player.avatar_changed' and player['avatar'] == connection.custom
    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_avatar_change_persists_and_is_replayed_to_other_replicas():
    async def scenario():
        stores, ids, actors = await positioned_world()
        try:
            outcome, duplicate = await stores[0].submit(
                position_command(ids[0], 2, 'player.avatar', {'avatar': 'shark', 'expectedRevision': 1}), actors[0]
            )
            assert not duplicate and outcome['event']['eventType'] == 'player.avatar_changed'
            assert outcome['event']['payload']['avatar'] == 'shark'
            snapshot = await stores[1].snapshot('positions-test')
            changed = next(item for item in snapshot['state']['players'] if item['playerId'] == str(ids[0]))
            assert changed['avatar'] == 'shark' and changed['positionRevision'] == 1
            replay = await stores[1].replay('positions-test', 1)
            assert replay[-1]['eventType'] == 'player.avatar_changed'
        finally:
            await close_stores(stores)
    asyncio.run(scenario())


def test_shot_captures_authoritative_names_not_command_claims(monkeypatch):
    from unittest.mock import AsyncMock

    monkeypatch.setattr("app.mobs.mob_on_path", AsyncMock(return_value=None))

    async def scenario():
        attacker_id, victim_id = uuid.uuid4(), uuid.uuid4()
        attacker = dict(player_id=attacker_id, name="Robert <&> Nessler", avatar="moss", x=11, y=4, revision=7)
        victim = dict(player_id=victim_id, name="Arjun Vasan", avatar="tide", x=13, y=4, revision=2)
        connection = AsyncMock()
        connection.fetchrow.side_effect = [attacker, victim]
        connection.fetchval.return_value = "east"
        event_type, payload = await position_resolver(
            position_command(attacker_id, 8, "player.shoot", {"expectedRevision": 7, "shooterName": "Forged"}),
            ActorContext(str(attacker_id)), connection,
        )
        assert event_type == "player.shot"
        assert payload["shooterName"] == attacker["name"]
        assert payload["victim"]["name"] == victim["name"]
        assert payload["path"] == [{"x": 12, "y": 4}, {"x": 13, "y": 4}]
        assert not any(
            "DELETE FROM player_positions" in call.args[0]
            for call in connection.execute.await_args_list
        )
        assert payload["combatElimination"] == {"attackerId": str(attacker_id), "victims": [payload["victim"]]}

    asyncio.run(scenario())


@pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")
def test_attribution_survives_attacker_departure_and_event_compaction():
    async def scenario():
        stores, ids, actors = await positioned_world()
        try:
            await stores[0].submit(position_command(ids[0], 2, 'player.move', {
                'expected': {'x': 11, 'y': 4}, 'destination': {'x': 12, 'y': 4}, 'expectedRevision': 1,
            }), actors[0])
            outcome, _ = await stores[0].submit(position_command(ids[0], 3, 'player.shoot', {'expectedRevision': 2}), actors[0])
            name = outcome['event']['payload']['shooterName']
            async with stores[0].pool.acquire() as connection:
                await connection.execute('DELETE FROM player_positions WHERE player_id=$1', ids[0])
                await connection.execute('DELETE FROM world_events WHERE world_id=$1', 'positions-test')
            snapshot = await stores[1].snapshot('positions-test')
            assert snapshot['state']['deathAttribution'][str(ids[1])] == name
            assert snapshot['state']['eliminated'][str(ids[1])] == outcome['event']['revision']
        finally:
            await close_stores(stores)

    asyncio.run(scenario())


@pytest.mark.parametrize("avatar, rejection", [("dog", None), ("unicorn", "avatar-invalid"),
                                                 ("custom-00000000000000000000000000000000-0000abcd", "avatar-locked"),
                                                 ("tide", "avatar_in_use")])
def test_avatar_change_without_an_active_position_keeps_selection_rules(monkeypatch, avatar, rejection):
    class DefeatedConnection(AvatarConnection):
        async def fetchrow(self, sql, *args):
            return None

    async def available(_connection, _world, _actor, selected):
        return selected != 'tide'
    monkeypatch.setattr('app.avatar_claims.claim', available)

    async def scenario():
        connection = DefeatedConnection()
        actor = ActorContext(str(connection.row['player_id']))
        command = position_command(actor.actor_id, 1, 'player.avatar', {'avatar': avatar})
        if rejection:
            with pytest.raises(TransportError) as error:
                await position_resolver(command, actor, connection)
            assert error.value.code == rejection
            assert connection.writes == 0 and connection.row['avatar'] == 'moss'
        else:
            event_type, payload = await position_resolver(command, actor, connection)
            assert event_type == 'player.avatar_changed'
            assert payload == {'playerId': actor.actor_id, 'avatar': 'dog'}
            assert connection.row['avatar'] == 'dog' and connection.writes == 1
    asyncio.run(scenario())
