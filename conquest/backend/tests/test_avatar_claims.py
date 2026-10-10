"""Real PostgreSQL connected-world avatar uniqueness; each scenario owns a disposable schema."""
import asyncio
import base64
import os
import uuid
from contextlib import asynccontextmanager

import asyncpg
import pytest

from app import avatar_claims
from app.db import DatabaseConfig
from app.migrate import run_migrations
from app.pg_store import PostgresPlayerStore
from app.player_positions import position_resolver
from app.players import PlayerError
from app.presence import player_connected, player_disconnected
from app.world_transport import ActorContext, Command, PostgresWorldStore, TransportError

DATABASE_URL = os.environ.get('TEST_DATABASE_URL')
pytestmark = [
    pytest.mark.skipif(not DATABASE_URL, reason='TEST_DATABASE_URL is not configured'),
    pytest.mark.real_avatar_claims,
]
WORLD = 'avatar-claims-world'
PNG = {'contentType': 'image/png', 'data': base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'\x00' * 16).decode()}


@asynccontextmanager
async def world(avatars):
    schema = 'party_conquest_preview_test_' + uuid.uuid4().hex[:12]
    await run_migrations(DatabaseConfig(DATABASE_URL, schema), log=lambda *_: None)
    stores = [PostgresWorldStore(DATABASE_URL, position_resolver, schema=schema) for _ in range(2)]
    await asyncio.gather(*(store.start() for store in stores))
    # Avatar claims must not race unrelated enemy ticks or player deaths.
    for store in stores:
        store._mob_worker.cancel()
    accounts = PostgresPlayerStore(stores[0].pool, owns_pool=False)
    ids = []
    for index, avatar in enumerate(avatars):
        _, player = await accounts.register(f'Claimer {index}', '1234', avatar)
        ids.append(uuid.UUID(player.id))
    leases = {}

    async def send(index, action, payload=None, replica=0):
        return await stores[replica].submit(Command(WORLD, str(uuid.uuid4()), action, payload or {}), ActorContext(str(ids[index])))

    async def connect(index):
        leases[index] = uuid.uuid4()
        return await player_connected(stores[0].pool, WORLD, str(ids[index]), leases[index])

    async def disconnect(index):
        await player_disconnected(stores[0].pool, WORLD, str(ids[index]), leases.pop(index))

    try:
        yield stores, accounts, ids, send, connect, disconnect
    finally:
        await asyncio.gather(*(store.close() for store in stores))
        conn = await asyncpg.connect(DATABASE_URL)
        try:
            await conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
        finally:
            await conn.close()


async def in_use(stores):
    async with stores[0].pool.acquire() as conn:
        return {item['avatar']: item['playerId'] for item in await avatar_claims.in_use(conn, WORLD)}


def test_connected_holder_blocks_registration_change_and_release_follows_presence():
    async def scenario():
        async with world(['moss', 'tide']) as (stores, accounts, ids, send, connect, disconnect):
            assert await connect(0) is True and await connect(1) is True
            await send(0, 'player.place', {'suggestedPosition': {'x': 11, 'y': 4}})
            await send(1, 'player.place', {'suggestedPosition': {'x': 13, 'y': 4}})
            assert await in_use(stores) == {'moss': str(ids[0]), 'tide': str(ids[1])}
            with pytest.raises(PlayerError) as registration:
                await accounts.register('Latecomer', '1234', 'moss')
            assert registration.value.code == 'avatar-in-use'
            with pytest.raises(TransportError) as change:
                await send(1, 'player.avatar', {'avatar': 'moss', 'expectedRevision': 2})
            assert change.value.code == 'avatar_in_use'
            # Changing releases the previous avatar in the same transaction.
            await send(0, 'player.avatar', {'avatar': 'dog', 'expectedRevision': 1})
            assert await in_use(stores) == {'dog': str(ids[0]), 'tide': str(ids[1])}
            await send(1, 'player.avatar', {'avatar': 'moss', 'expectedRevision': 2})
            # The server-side presence lease, not client state, frees an avatar.
            await disconnect(0)
            assert 'dog' not in await in_use(stores)
            changed, _ = await send(1, 'player.avatar', {'avatar': 'dog', 'expectedRevision': 2})
            assert changed['event']['payload']['avatar'] == 'dog'
    asyncio.run(scenario())


def test_stale_lease_releases_and_returning_player_must_choose_before_spawning():
    async def scenario():
        async with world(['moss', 'tide']) as (stores, accounts, ids, send, connect, disconnect):
            await connect(0)
            async with stores[0].pool.acquire() as conn:
                await conn.execute(
                    "UPDATE player_world_connections SET last_seen_at=now()-interval '10 minutes' WHERE player_id=$1", ids[0]
                )
            assert 'moss' not in await in_use(stores)
            # Another player takes the stale holder's avatar before it returns.
            await connect(1)
            await send(1, 'player.place', {'suggestedPosition': {'x': 13, 'y': 4}})
            await send(1, 'player.avatar', {'avatar': 'moss', 'expectedRevision': 1})
            assert await connect(0) is False
            with pytest.raises(TransportError) as blocked:
                await send(0, 'player.place', {'suggestedPosition': {'x': 11, 'y': 4}})
            assert blocked.value.code == 'avatar_in_use'
            with pytest.raises(TransportError) as still_blocked:
                await send(0, 'player.place', {'avatar': 'moss'})
            assert still_blocked.value.code == 'avatar_in_use'
            placed, _ = await send(0, 'player.place', {'suggestedPosition': {'x': 11, 'y': 4}, 'avatar': 'frost'})
            assert placed['event']['payload']['avatar'] == 'frost'
            assert await in_use(stores) == {'frost': str(ids[0]), 'moss': str(ids[1])}
    asyncio.run(scenario())


def test_simultaneous_claims_on_two_replicas_grant_one_holder():
    async def scenario():
        async with world(['moss', 'tide', 'ash', 'dune']) as (stores, accounts, ids, send, connect, disconnect):
            for index, x in enumerate((11, 13, 15, 17)):
                await connect(index)
                await send(index, 'player.place', {'suggestedPosition': {'x': x, 'y': 4}})
            for _ in range(3):
                results = await asyncio.gather(*(
                    send(index, 'player.avatar', {'avatar': 'shark', 'expectedRevision': index + 1}, replica=index % 2)
                    for index in range(4)
                ), return_exceptions=True)
                winners = [r for r in results if not isinstance(r, Exception)]
                assert len(winners) <= 1 and all(r.code == 'avatar_in_use' for r in results if isinstance(r, Exception))
                holders = [pid for avatar, pid in (await in_use(stores)).items() if avatar == 'shark']
                assert len(holders) == 1
    asyncio.run(scenario())


def test_custom_avatars_are_private_and_never_contested():
    async def scenario():
        async with world(['moss']) as (stores, accounts, ids, send, connect, disconnect):
            _, painter = await accounts.register('Painter', '1234', 'custom', PNG)
            ids.append(uuid.UUID(painter.id))
            assert painter.avatar == painter.custom_avatar and await connect(1) is True
            await send(1, 'player.place', {'suggestedPosition': {'x': 13, 'y': 4}})
            assert await in_use(stores) == {}
            await connect(0)
            await send(0, 'player.place', {'suggestedPosition': {'x': 11, 'y': 4}})
            with pytest.raises(TransportError) as foreign:
                await send(0, 'player.avatar', {'avatar': painter.custom_avatar, 'expectedRevision': 2})
            assert foreign.value.code == 'avatar-locked'
            replaced = await accounts.set_custom_avatar(painter.id, PNG)
            assert replaced.avatar == replaced.custom_avatar != painter.custom_avatar
            with pytest.raises(TransportError) as superseded:
                await send(1, 'player.avatar', {'avatar': painter.custom_avatar, 'expectedRevision': 1})
            assert superseded.value.code == 'avatar-locked'
            snapshot = await stores[1].snapshot(WORLD)
            marker = next(p for p in snapshot['state']['players'] if p['playerId'] == painter.id)
            assert marker['avatar'] == replaced.custom_avatar
    asyncio.run(scenario())


def test_defeated_player_saves_avatar_without_respawning_and_rejoins_with_it():
    async def scenario():
        async with world(['moss', 'tide']) as (stores, accounts, ids, send, connect, disconnect):
            await connect(0)
            await connect(1)
            placed, _ = await send(0, 'player.place', {'suggestedPosition': {'x': 11, 'y': 4}})
            await send(1, 'player.place', {'suggestedPosition': {'x': 13, 'y': 4}})
            revision = placed['event']['payload']['positionRevision']
            shot, _ = await send(0, 'player.shoot', {'expectedRevision': revision, 'facing': 'east'})
            assert shot['event']['payload']['eliminatedVictims'][0]['playerId'] == str(ids[1])
            death_revision = shot['event']['revision']
            with pytest.raises(TransportError) as held:
                await send(1, 'player.avatar', {'avatar': 'moss'})
            assert held.value.code == 'avatar_in_use'
            changed, _ = await send(1, 'player.avatar', {'avatar': 'dog'})
            replayed, duplicate = await stores[1].submit(
                Command(WORLD, changed['event']['commandId'], 'player.avatar', {'avatar': 'dog'}),
                ActorContext(str(ids[1])),
            )
            assert duplicate and replayed == changed
            assert changed['event']['payload'] == {'playerId': str(ids[1]), 'avatar': 'dog'}
            snapshot = await stores[1].snapshot(WORLD)
            assert all(p['playerId'] != str(ids[1]) for p in snapshot['state']['players'])
            assert snapshot['state']['eliminated'][str(ids[1])] == death_revision
            async with stores[0].pool.acquire() as connection:
                assert await connection.fetchval('SELECT avatar FROM players WHERE id=$1', ids[1]) == 'dog'
            assert await in_use(stores) == {'moss': str(ids[0]), 'dog': str(ids[1])}
            rejoined, _ = await send(1, 'player.place', {'expectedDeathRevision': death_revision})
            assert rejoined['event']['payload']['avatar'] == 'dog'
    asyncio.run(scenario())
