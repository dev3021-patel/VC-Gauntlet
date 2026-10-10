import asyncio
import os

import asyncpg
import pytest

from app.world_transport import ActorContext, Command, PostgresWorldStore, TransportError, test_resolver as resolve_test_action

DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="TEST_DATABASE_URL is not configured")


async def clean_database():
    connection = await asyncpg.connect(DATABASE_URL)
    # Full-schema CI includes gameplay tables referencing world_streams.
    await connection.execute("TRUNCATE world_events, world_commands, world_streams CASCADE")
    await connection.close()


def command(number: int, *, payload=None, action_type="transport.test"):
    return Command("test-world", f"command-{number}", action_type, payload or {"number": number})


def test_concurrent_ordering_idempotency_rejection_and_persistence():
    async def scenario():
        store = PostgresWorldStore(DATABASE_URL, resolve_test_action, retention_events=100)
        await store.start()
        await clean_database()
        outcomes = await asyncio.gather(*(store.submit(command(index), ActorContext()) for index in range(20)))
        revisions = sorted(result[0]["event"]["revision"] for result in outcomes)
        assert revisions == list(range(1, 21))

        original, duplicate = await store.submit(command(1), ActorContext())
        assert duplicate is True
        assert original["event"]["revision"] in revisions
        with pytest.raises(TransportError, match="different content") as conflict:
            await store.submit(command(1, payload={"different": True}), ActorContext())
        assert conflict.value.code == "idempotency_conflict"
        with pytest.raises(TransportError) as rejected:
            await store.submit(command(99, action_type="claim"), ActorContext())
        assert rejected.value.code == "unsupported_action"
        assert (await store.snapshot("test-world"))["revision"] == 20
        await store.close()

        restarted = PostgresWorldStore(DATABASE_URL, resolve_test_action)
        await restarted.start()
        assert (await restarted.snapshot("test-world"))["revision"] == 20
        assert [event["revision"] for event in await restarted.replay("test-world", 18)] == [19, 20]
        await restarted.close()

    asyncio.run(scenario())


def test_cross_replica_fanout_and_slow_consumer_disconnect():
    async def scenario():
        first = PostgresWorldStore(DATABASE_URL, resolve_test_action, queue_size=32)
        second = PostgresWorldStore(DATABASE_URL, resolve_test_action, queue_size=32)
        await first.start(); await second.start(); await clean_database()
        first_client, second_client = first.subscribe("test-world"), second.subscribe("test-world")
        for index in range(10):
            await first.submit(command(index), ActorContext())
        observed_first = [(await asyncio.wait_for(first_client.queue.get(), 2))["revision"] for _ in range(10)]
        observed_second = [(await asyncio.wait_for(second_client.queue.get(), 2))["revision"] for _ in range(10)]
        assert observed_first == observed_second == list(range(1, 11))
        await first.close(); await second.close()

    asyncio.run(scenario())


def test_slow_consumer_has_bounded_queue_and_resync_reason():
    async def scenario():
        store = PostgresWorldStore(DATABASE_URL, resolve_test_action, queue_size=1)
        await store.start(); await clean_database()
        client = store.subscribe("test-world")
        await store.submit(command(1), ActorContext())
        await asyncio.sleep(0.05)
        await store.submit(command(2), ActorContext())
        await asyncio.wait_for(client.closed.wait(), 2)
        assert client.reason == "slow_consumer"
        assert client.queue.qsize() == 1
        await store.close()

    asyncio.run(scenario())


def test_retention_requires_a_fresh_snapshot_for_stale_cursor():
    async def scenario():
        store = PostgresWorldStore(DATABASE_URL, resolve_test_action, retention_events=2)
        await store.start(); await clean_database()
        for index in range(4):
            await store.submit(command(index), ActorContext())
        with pytest.raises(TransportError) as stale:
            await store.replay("test-world", 0)
        assert stale.value.code == "stale_cursor"
        assert stale.value.details == {"snapshotRequired": True}
        assert [item["revision"] for item in await store.replay("test-world", 2)] == [3, 4]
        await store.close()

    asyncio.run(scenario())
