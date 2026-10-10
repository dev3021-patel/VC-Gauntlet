"""Connected-world avatar uniqueness.

A built-in avatar is held by at most one player per
world through ``world_avatar_claims``. A claim counts only while its holder has
a fresh ``player_world_connections`` lease, so the existing presence rules
decide when an avatar becomes available again. Custom uploads are account
private and never contested.
"""

from __future__ import annotations

import uuid

from app.players import ALL_AVATARS, custom_avatar_owner
from app.world_transport import TransportError

AVATAR_IN_USE_MESSAGE = "Another player is using that avatar right now. Choose a different one."


def _holder_connected(parameter: int) -> str:
    return f"""EXISTS (SELECT 1 FROM player_world_connections w
        WHERE w.world_id=c.world_id AND w.player_id=c.player_id
          AND w.last_seen_at >= now()-(${parameter}*interval '1 second'))"""


def _stale_seconds() -> int:
    from app.presence import STALE_CONNECTION_SECONDS
    return STALE_CONNECTION_SECONDS


async def ensure_selectable(connection, player_id: uuid.UUID, avatar) -> None:
    """Reject avatars this account may not equip, before any claim or write."""
    owner = custom_avatar_owner(avatar)
    if owner is not None:
        current = await connection.fetchval(
            "SELECT avatar_id FROM player_custom_avatars WHERE player_id=$1", player_id
        )
        if owner != player_id or current != avatar:
            raise TransportError("avatar-locked", "That image avatar is not yours to use.", 409)
        return
    # Every built-in avatar is free; only connected-world uniqueness can refuse it.
    if avatar not in ALL_AVATARS:
        raise TransportError("avatar-invalid", "Choose a valid avatar.", 422)


async def claim(connection, world_id: str, player_id: uuid.UUID, avatar: str) -> bool:
    """Hold ``avatar`` for the player in this world; False when a connected player holds it.

    Concurrent claims serialize on the primary key: the loser's insert waits for
    the winner's commit and then observes the winner as holder.
    """
    if avatar not in ALL_AVATARS:
        await release(connection, world_id, player_id)
        return True
    await connection.execute(
        f"""DELETE FROM world_avatar_claims c
            WHERE c.world_id=$1 AND c.avatar=$2 AND c.player_id<>$3 AND NOT {_holder_connected(4)}""",
        world_id, avatar, player_id, _stale_seconds(),
    )
    await connection.execute(
        """INSERT INTO world_avatar_claims(world_id, avatar, player_id) VALUES($1,$2,$3)
           ON CONFLICT (world_id, avatar) DO NOTHING""",
        world_id, avatar, player_id,
    )
    holder = await connection.fetchval(
        "SELECT player_id FROM world_avatar_claims WHERE world_id=$1 AND avatar=$2", world_id, avatar
    )
    if holder != player_id:
        return False
    await connection.execute(
        "DELETE FROM world_avatar_claims WHERE world_id=$1 AND player_id=$2 AND avatar<>$3",
        world_id, player_id, avatar,
    )
    return True


async def claim_saved(connection, world_id: str, player_id: uuid.UUID) -> bool:
    avatar = await connection.fetchval("SELECT avatar FROM players WHERE id=$1", player_id)
    return await claim(connection, world_id, player_id, avatar)


async def release(connection, world_id: str, player_id: uuid.UUID) -> None:
    await connection.execute("DELETE FROM world_avatar_claims WHERE world_id=$1 AND player_id=$2", world_id, player_id)


async def in_use(connection, world_id: str) -> list[dict]:
    rows = await connection.fetch(
        f"""SELECT c.avatar, c.player_id FROM world_avatar_claims c
            WHERE c.world_id=$1 AND {_holder_connected(2)} ORDER BY c.avatar""",
        world_id, _stale_seconds(),
    )
    return [{"avatar": row["avatar"], "playerId": str(row["player_id"])} for row in rows]


async def held_anywhere(connection, avatar) -> bool:
    """Registration is world-agnostic: a built-in avatar held in any world is taken."""
    if avatar not in ALL_AVATARS:
        return False
    return bool(await connection.fetchval(
        f"SELECT 1 FROM world_avatar_claims c WHERE c.avatar=$1 AND {_holder_connected(2)} LIMIT 1",
        avatar, _stale_seconds(),
    ))
