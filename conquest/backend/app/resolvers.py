"""Application-level command resolver composition."""

import os

from app.player_positions import position_resolver
from app.world_transport import ActorContext, Command, Resolver, reject_unsupported, test_resolver


def configured_resolver() -> Resolver:
    test_enabled = (
        os.environ.get("ENABLE_TEST_RESOLVER", "").lower() == "true"
        and os.environ.get("APP_ENV", "production").lower() != "production"
    )

    async def resolve(command: Command, actor: ActorContext, connection):
        if command.action_type.startswith("player."):
            return await position_resolver(command, actor, connection)
        if test_enabled and command.action_type == "transport.test":
            return await test_resolver(command, actor, connection)
        return await reject_unsupported(command, actor, connection)

    return resolve
