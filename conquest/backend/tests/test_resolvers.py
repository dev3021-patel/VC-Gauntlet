import asyncio

import pytest

import app.resolvers as resolvers
from app.world_transport import ActorContext, Command, TransportError


def test_development_test_resolver_is_additive(monkeypatch):
    calls = []

    async def resolve_position(command, actor, connection):
        calls.append((command.action_type, actor.actor_id, connection))
        return "player.placed", {}

    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ENABLE_TEST_RESOLVER", "true")
    monkeypatch.setattr(resolvers, "position_resolver", resolve_position)
    resolve = resolvers.configured_resolver()

    async def scenario():
        tested = await resolve(Command("world", "test", "transport.test", {"ok": True}), ActorContext(), None)
        placed = await resolve(Command("world", "place", "player.place", {}), ActorContext("player"), "connection")
        assert tested == ("transport.tested", {"ok": True})
        assert placed == ("player.placed", {})
        assert calls == [("player.place", "player", "connection")]
        with pytest.raises(TransportError) as unsupported:
            await resolve(Command("world", "bad", "other.action", {}), ActorContext(), None)
        assert unsupported.value.code == "unsupported_action"

    asyncio.run(scenario())
