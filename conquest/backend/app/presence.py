"""Authenticated world presence: connection leases and avatar claim release."""

from __future__ import annotations

import logging
import uuid

import asyncpg

from app import avatar_claims

logger = logging.getLogger("party_conquest.transport")

STALE_CONNECTION_SECONDS = 45


async def lock_presence(connection, world_id: str, player_id: uuid.UUID) -> None:
    # Presence writers serialize per player; they never take the world lock, so lock order cannot invert.
    await connection.execute("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", world_id, str(player_id))


async def sweep_stale_connections(connection) -> None:
    """Drop stale presence rows and release the avatar of players left without a connection.

    Runs inside the connecting player's registration transaction, so each swept
    row is handled in its own savepoint: another player's bad row must never
    abort this player's connect (Issue #79).
    """
    stale = await connection.fetch(
        """DELETE FROM player_world_connections WHERE last_seen_at < now()-($1*interval '1 second')
           RETURNING world_id,player_id""", STALE_CONNECTION_SECONDS,
    )
    for row in stale:
        try:
            async with connection.transaction():
                await lock_presence(connection, row["world_id"], row["player_id"])
                if not await connection.fetchval(
                    "SELECT 1 FROM player_world_connections WHERE world_id=$1 AND player_id=$2 LIMIT 1",
                    row["world_id"], row["player_id"],
                ):
                    await avatar_claims.release(connection, row["world_id"], row["player_id"])
        except asyncpg.PostgresError:
            logger.exception("stale_connection_sweep_failed world_id=%s player_id=%s", row["world_id"], row["player_id"])


async def player_connected(pool, world_id: str, player_id: str, connection_id: uuid.UUID) -> bool:
    """Register presence; returns False when another connected player holds the saved avatar."""
    actor_id = uuid.UUID(player_id)
    async with pool.acquire() as connection, connection.transaction():
        await sweep_stale_connections(connection)
        await lock_presence(connection, world_id, actor_id)
        await connection.execute(
            "INSERT INTO player_world_connections(connection_id,world_id,player_id) VALUES($1,$2,$3)",
            connection_id, world_id, actor_id,
        )
        return await avatar_claims.claim_saved(connection, world_id, actor_id)


async def connection_heartbeat(pool, connection_id: uuid.UUID) -> None:
    await pool.execute("UPDATE player_world_connections SET last_seen_at=now() WHERE connection_id=$1", connection_id)


async def player_disconnected(pool, world_id: str, player_id: str, connection_id: uuid.UUID) -> None:
    actor_id = uuid.UUID(player_id)
    async with pool.acquire() as connection, connection.transaction():
        await lock_presence(connection, world_id, actor_id)
        await connection.execute("DELETE FROM player_world_connections WHERE connection_id=$1", connection_id)
        if not await connection.fetchval(
            "SELECT 1 FROM player_world_connections WHERE world_id=$1 AND player_id=$2 LIMIT 1", world_id, actor_id,
        ):
            await avatar_claims.release(connection, world_id, actor_id)
