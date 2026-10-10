"""In-memory movement must accept and reject exactly like the database resolver."""

import asyncio
import os
import uuid

import asyncpg
import pytest

from app.eliminations import resolve_eliminations
from app.player_positions import position_resolver
from app.realtime import Batch
from app.world_transport import ActorContext, Command, PostgresWorldStore, TransportError

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
WORLD = "positions-test"
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")


def move(player, number, origin, destination, revision):
    return Command(WORLD, f"{player}-live-{number}", "player.move", {
        "expected": {"x": origin[0], "y": origin[1]}, "destination": {"x": destination[0], "y": destination[1]},
        "expectedRevision": revision,
    })


async def owner_world():
    from tests.test_player_positions import positioned_world, close_stores
    stores, player_ids, actors = await positioned_world()
    await close_stores(stores)
    store = PostgresWorldStore(DATABASE_URL, position_resolver, exclusive=True)
    await store.start()
    return store, [str(item) for item in player_ids], actors


async def positions(store):
    rows = await store.pool.fetch(
        "SELECT player_id::text id, x, y, revision, facing FROM player_positions WHERE world_id=$1", WORLD
    )
    return {row["id"]: (row["x"], row["y"], row["revision"], row["facing"]) for row in rows}


async def streamed(subscriber, count):
    """Events from the broadcast ticks, which may split them across batches."""
    events = []
    async with asyncio.timeout(2):
        while len(events) < count:
            batch = await subscriber.queue.get()
            assert isinstance(batch, Batch)
            events.extend(batch.events)
    return events


def test_live_moves_match_resolver_rules_flush_in_one_batch_and_survive_chained_cells():
    async def scenario():
        store, (first, second), (first_actor, second_actor) = await owner_world()
        try:
            assert await store.ready()
            standby = PostgresWorldStore(DATABASE_URL, position_resolver, exclusive=True)
            assert not await standby.ready()
            await standby.close()

            subscriber = store.subscribe(WORLD)
            start = await positions(store)
            first_revision, second_revision = start[first][2], start[second][2]
            # second (13,4) steps west; first (11,4) cannot enter the occupied cell.
            assert await store.submit_live(move(second, 1, (13, 4), (12, 4), second_revision), second_actor) is None
            for command, code in (
                (move(first, 1, (11, 4), (12, 4), first_revision), "occupied"),
                (move(first, 2, (11, 4), (13, 4), first_revision), "invalid_move"),
                (move(first, 3, (11, 4), (10, 4), first_revision + 5), "stale_position"),
                (move(first, 4, (10, 4), (9, 4), first_revision), "stale_position"),
            ):
                with pytest.raises(TransportError) as rejected:
                    await store.submit_live(command, first_actor)
                assert rejected.value.code == code
            # Chained cells in one flush: first leaves (11,4) as second enters it. No await
            # separates the two commits, so the broadcast tick writes them together.
            runtime = store.runtimes[WORLD]
            assert runtime.try_command(move(first, 5, (11, 4), (10, 4), first_revision), first)
            assert runtime.try_command(move(second, 2, (12, 4), (11, 4), second_revision + 1), second)
            turn = Command(WORLD, f"{first}-live-turn", "player.face", {"facing": "north", "expectedRevision": first_revision + 1})
            assert await store.submit_live(turn, first_actor) is None

            events = await streamed(subscriber, 4)
            assert [event["eventType"] for event in events] == ["player.moved"] * 3 + ["player.faced"]
            revisions = [event["revision"] for event in events]
            assert revisions == list(range(revisions[0], revisions[0] + 4))
            assert await positions(store) == {
                **start, first: (10, 4, first_revision + 1, "north"), second: (11, 4, second_revision + 2, "west"),
            }
            assert await store.replay(WORLD, revisions[0] - 1) == events

            # The database path sees flushed memory and its event follows in order.
            shot = Command(WORLD, f"{first}-live-shot", "player.shoot", {"expectedRevision": first_revision + 1})
            outcome, _ = await store.submit(shot, first_actor)
            assert outcome["event"]["revision"] == revisions[-1] + 1
            assert (await streamed(subscriber, 1))[0]["revision"] == revisions[-1] + 1
        finally:
            await store.close()

    asyncio.run(scenario())


def test_a_shared_writer_interleaves_with_the_owner_and_hears_its_batches():
    async def scenario():
        store, (first, second), (first_actor, second_actor) = await owner_world()
        shared = PostgresWorldStore(DATABASE_URL, position_resolver)
        try:
            await shared.start()
            owned, heard = store.subscribe(WORLD), shared.subscribe(WORLD)
            start = await positions(store)
            # Hold the actual batch-write lock before queuing the owner's move.
            # Broadcast ticks intentionally do not acquire the runtime command lock.
            runtime = store._runtime(WORLD)
            async with runtime.flushing:
                assert await store.submit_live(move(first, 1, (11, 4), (10, 4), start[first][2]), first_actor) is None
                # A Preview backend commits while the owner's move is still in memory.
                shot = Command(WORLD, f"{second}-shared-shot", "player.shoot", {"expectedRevision": start[second][2]})
                committed = (await shared.submit(shot, second_actor))[0]["event"]
            events = await streamed(owned, 2)
            assert [event["eventType"] for event in events] == ["player.shot", "player.moved"]
            assert events[0] == committed and events[1]["revision"] == committed["revision"] + 1
            async with asyncio.timeout(2):
                assert [await heard.queue.get() for _ in range(2)] == events
            assert (await positions(store))[first][:3] == (10, 4, start[first][2] + 1)
        finally:
            await shared.close()
            await store.close()

    asyncio.run(scenario())


def test_a_move_committed_while_its_previous_step_is_being_written_joins_the_next_batch():
    async def scenario():
        store, (first, _), (first_actor, _) = await owner_world()
        try:
            subscriber = store.subscribe(WORLD)
            revision = (await positions(store))[first][2]
            assert await store.submit_live(move(first, 1, (11, 4), (10, 4), revision), first_actor) is None
            runtime = store.runtimes[WORLD]
            writing = asyncio.create_task(store._flush(runtime))
            while runtime.unflushed:
                await asyncio.sleep(0)
            assert not runtime.lock.locked()
            assert await store.submit_live(move(first, 2, (10, 4), (9, 4), revision + 1), first_actor) is None
            await writing
            events = await streamed(subscriber, 2)
            assert [event["payload"]["x"] for event in events] == [10, 9]
            assert events[1]["revision"] == events[0]["revision"] + 1
            assert (await positions(store))[first][:3] == (9, 4, revision + 2)
        finally:
            await store.close()

    asyncio.run(scenario())


def test_missed_shots_match_the_resolver_and_anything_they_could_hit_takes_the_database_path():
    async def scenario():
        store, (first, second), (first_actor, _) = await owner_world()
        try:
            subscriber = store.subscribe(WORLD)
            revision = (await positions(store))[first][2]
            face = Command(WORLD, f"{first}-face", "player.face", {"facing": "west", "expectedRevision": revision})
            assert await store.submit_live(face, first_actor) is None
            runtime = store.runtimes[WORLD]
            await store._flush(runtime)
            miss = Command(WORLD, f"{first}-miss", "player.shoot", {"expectedRevision": revision})
            async with store.pool.acquire() as connection:
                transaction = connection.transaction()
                await transaction.start()
                try:
                    _, expected = await position_resolver(miss, first_actor, connection)
                    await resolve_eliminations(connection, WORLD, expected)
                finally:
                    await transaction.rollback()
            assert expected["path"] and not expected["victims"] and not expected["mobHits"]
            assert await store.submit_live(miss, first_actor) is None
            shot = (await streamed(subscriber, 2))[1]
            assert shot["eventType"] == "player.shot" and shot["payload"] == expected

            # A ray reaching the other player is the resolver's.
            runtime.players[first]["facing"] = "east"
            assert runtime.try_command(Command(WORLD, f"{first}-hit", "player.shoot", {"expectedRevision": revision}), first) is None
            # A shot's requested heading decides its lane, exactly as in the resolver.
            turned = runtime.try_command(Command(WORLD, f"{first}-turned", "player.shoot", {"expectedRevision": revision, "facing": "west"}), first)
            assert turned["payload"]["facing"] == "west" and turned["payload"]["path"] == expected["path"]
            with pytest.raises(TransportError) as stale:
                runtime.try_command(Command(WORLD, f"{first}-stale", "player.shoot", {"expectedRevision": revision + 1}), first)
            assert stale.value.code == "stale_position"
        finally:
            await store.close()

    asyncio.run(scenario())


async def take_over():
    """What a successor owner does on acquisition: bump the fencing epoch."""
    connection = await asyncpg.connect(DATABASE_URL)
    try:
        return await connection.fetchval("UPDATE world_owner_epoch SET epoch=epoch+1 RETURNING epoch")
    finally:
        await connection.close()


def test_a_successor_fences_out_the_old_owner_even_between_its_check_and_write():
    async def scenario():
        store, (first, _), (first_actor, _) = await owner_world()
        try:
            x, y, revision, _ = (await positions(store))[first]
            assert await store.submit_live(move(first, 1, (x, y), (x - 1, y), revision), first_actor) is None
            runtime = store.runtimes[WORLD]
            original, successor = runtime.flush_arguments, []

            def take_over_mid_flush(*args):
                # The fence has passed; a successor arrives before the batch is written.
                successor.append(asyncio.create_task(take_over()))
                return original(*args)

            runtime.flush_arguments = take_over_mid_flush
            await store._flush(runtime)
            runtime.flush_arguments = original
            # The successor's takeover waited for that write, so it reloads a state that includes it.
            await asyncio.wait_for(successor[0], 2)
            assert (await positions(store))[first][:3] == (x - 1, y, revision + 1)

            # Every later write by the old owner is refused, and nothing is left in its memory.
            assert await store.submit_live(move(first, 2, (x - 1, y), (x - 2, y), revision + 1), first_actor) is None
            with pytest.raises(TransportError):
                await store._flush(runtime)
            assert not store.owner and not runtime.unflushed
            assert (await positions(store))[first][:3] == (x - 1, y, revision + 1)
            with pytest.raises(TransportError) as refused:
                await store.submit_live(move(first, 3, (x - 1, y), (x - 2, y), revision + 1), first_actor)
            assert refused.value.status == 503

            # A dropped lock session is noticed before the next admission.
            store.owner, store._epoch = True, await store.pool.fetchval("SELECT epoch FROM world_owner_epoch")
            await store.listener.close()
            assert not store.holds_ownership()
        finally:
            await store.close()

    asyncio.run(scenario())


def test_a_command_waiting_when_shutdown_begins_is_refused_not_lost():
    async def scenario():
        store, (first, _), (first_actor, _) = await owner_world()
        x, y, revision, _ = (await positions(store))[first]
        assert await store.submit_live(move(first, 1, (x, y), (x - 1, y), revision), first_actor) is None
        runtime = store.runtimes[WORLD]
        pool, store._owns_pool = store.pool, False
        async with runtime.lock:
            # Admitted before shutdown, then queued behind the world lock.
            waiting = asyncio.create_task(
                store.submit_live(move(first, 2, (x - 1, y), (x - 2, y), revision + 1), first_actor)
            )
            await asyncio.sleep(0.05)
            closing = asyncio.create_task(store.close())
            await asyncio.sleep(0.05)
        with pytest.raises(TransportError) as refused:
            await waiting
        assert refused.value.status == 503
        await closing
        stored = await pool.fetchrow("SELECT x, revision FROM player_positions WHERE world_id=$1 AND player_id=$2::uuid", WORLD, first)
        await pool.close()
        # The accepted move was drained; the refused one never entered memory.
        assert (stored["x"], stored["revision"]) == (x - 1, revision + 1) and not runtime.unflushed

    asyncio.run(scenario())


def test_shutdown_retries_a_failed_drain_and_reports_what_it_could_not_write(caplog):
    async def scenario(failures):
        store, (first, _), (first_actor, _) = await owner_world()
        x, y, revision, _ = (await positions(store))[first]
        assert await store.submit_live(move(first, failures, (x, y), (x - 1, y), revision), first_actor) is None
        runtime = store.runtimes[WORLD]
        original, calls = runtime.flush_arguments, []

        def flaky(*args):
            result = original(*args)
            calls.append(1)
            if len(calls) <= failures:
                raise ConnectionError("storage blip")
            return result

        runtime.flush_arguments = flaky
        pool = store.pool
        store._owns_pool = False
        await store.close()
        stored = await pool.fetchrow("SELECT x, revision FROM player_positions WHERE world_id=$1 AND player_id=$2::uuid", WORLD, first)
        await pool.close()
        return stored, x, revision

    stored, x, revision = asyncio.run(scenario(1))
    assert (stored["x"], stored["revision"]) == (x - 1, revision + 1)
    stored, x, revision = asyncio.run(scenario(3))
    assert stored["revision"] == revision
    assert "world_shutdown_flush_failed world_id=positions-test dropped_events=1" in caplog.text
