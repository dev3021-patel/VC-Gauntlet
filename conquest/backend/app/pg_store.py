"""Postgres-backed player store with the same interface as ``PlayerStore``."""

from __future__ import annotations

import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone

from app import avatar_claims
from app.players import (
    LOCKOUT_SECONDS,
    MAX_FAILED_ATTEMPTS,
    Player,
    PlayerError,
    PlayerStore,
    custom_avatar_id,
    custom_avatar_owner,
    decode_custom_avatar,
    hash_pin,
    name_key,
)


# Correlated subquery appended to every account RETURNING so one round trip
# yields the account's uploaded image avatar, if any.
ACCOUNT_COLUMNS = """(SELECT c.avatar_id FROM player_custom_avatars c WHERE c.player_id = players.id) custom_avatar"""


def _to_player(row) -> Player:
    return Player(
        # Use the same canonical UUID representation as world position payloads
        # so clients can associate the authenticated player with its marker.
        id=str(row["id"]),
        name=row["name"],
        avatar=row["avatar"],
        created_at=row["created_at"].timestamp(),
        last_seen_at=row["last_seen_at"].timestamp(),
        pin_salt=row["pin_salt"],
        pin_hash=row["pin_hash"],
        failed_attempts=row["failed_attempts"],
        locked_until=row["locked_until"].timestamp() if row["locked_until"] else 0.0,
        custom_avatar=row.get("custom_avatar"),
    )


class PostgresPlayerStore:
    def __init__(self, pool, *, owns_pool: bool = True):
        self._pool = pool
        self._owns_pool = owns_pool

    async def close(self) -> None:
        if self._owns_pool:
            await self._pool.close()

    async def register(self, name, pin, avatar, custom_image=None) -> tuple[str, Player]:
        clean_name = PlayerStore._validate_name(name)
        clean_pin = PlayerStore._validate_pin(pin)
        clean_avatar, image = PlayerStore._validate_registration_avatar(avatar, custom_image)
        salt = secrets.token_bytes(16)
        player_id = uuid.uuid4()
        token = secrets.token_urlsafe(32)
        if image:
            clean_avatar = custom_avatar_id(str(player_id))
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                exists = await connection.fetchval("SELECT 1 FROM players WHERE name_key = $1", name_key(clean_name))
                if exists:
                    raise PlayerError(409, "name-taken", "That name is already taken. Choose another or sign in.")
                if await avatar_claims.held_anywhere(connection, clean_avatar):
                    raise PlayerError(409, "avatar-in-use", avatar_claims.AVATAR_IN_USE_MESSAGE)
                row = await connection.fetchrow(
                    """
                    INSERT INTO players (id, name, name_key, avatar, pin_salt, pin_hash)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING *, NULL::text custom_avatar
                    """,
                    player_id,
                    clean_name,
                    name_key(clean_name),
                    clean_avatar,
                    salt.hex(),
                    hash_pin(clean_pin, salt),
                )
                if image:
                    await connection.execute(
                        "INSERT INTO player_custom_avatars (player_id, avatar_id, content_type, image) VALUES ($1, $2, $3, $4)",
                        player_id, clean_avatar, *image,
                    )
                    row = {**dict(row), "custom_avatar": clean_avatar}
                await connection.execute("INSERT INTO player_tokens (token, player_id) VALUES ($1, $2)", token, player_id)
        return token, _to_player(row)

    async def login(self, name, pin) -> tuple[str, Player]:
        clean_name = PlayerStore._validate_name(name)
        clean_pin = PlayerStore._validate_pin(pin)
        failure: PlayerError | None = None
        async with self._pool.acquire() as connection:
            # Failure bookkeeping must commit, so the error is raised after the transaction closes.
            async with connection.transaction():
                row = await connection.fetchrow(
                    "SELECT * FROM players WHERE name_key = $1 FOR UPDATE", name_key(clean_name)
                )
                now = datetime.now(timezone.utc)
                if row and row["locked_until"] and row["locked_until"] > now:
                    remaining = int((row["locked_until"] - now).total_seconds()) + 1
                    failure = PlayerError(429, "locked", "Too many attempts. Try again in a minute.", retry_after=remaining)
                else:
                    valid = row is not None and hmac.compare_digest(
                        hash_pin(clean_pin, bytes.fromhex(row["pin_salt"])), row["pin_hash"]
                    )
                    if valid:
                        row = await connection.fetchrow(
                            f"""
                            UPDATE players SET failed_attempts = 0, locked_until = NULL, last_seen_at = now()
                            WHERE id = $1 RETURNING *, {ACCOUNT_COLUMNS}
                            """,
                            row["id"],
                        )
                        token = secrets.token_urlsafe(32)
                        await connection.execute(
                            "INSERT INTO player_tokens (token, player_id) VALUES ($1, $2)", token, row["id"]
                        )
                    else:
                        if row:
                            attempts = row["failed_attempts"] + 1
                            if attempts >= MAX_FAILED_ATTEMPTS:
                                await connection.execute(
                                    "UPDATE players SET failed_attempts = 0, locked_until = $2 WHERE id = $1",
                                    row["id"],
                                    now + timedelta(seconds=LOCKOUT_SECONDS),
                                )
                            else:
                                await connection.execute(
                                    "UPDATE players SET failed_attempts = $2 WHERE id = $1", row["id"], attempts
                                )
                        failure = PlayerError(401, "invalid-credentials", "That name and PIN don't match.")
        if failure:
            raise failure
        return token, _to_player(row)

    async def authenticate(self, token: str | None) -> Player:
        if not token:
            raise PlayerError(401, "unauthorized", "Sign in to continue.")
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                f"""
                WITH touched AS (
                    UPDATE player_tokens SET last_used_at = now() WHERE token = $1 RETURNING player_id
                )
                UPDATE players SET last_seen_at = now()
                WHERE id = (SELECT player_id FROM touched)
                RETURNING *, {ACCOUNT_COLUMNS}
                """,
                token,
            )
        if row is None:
            raise PlayerError(401, "unauthorized", "Your session is no longer valid. Sign in again.")
        return _to_player(row)

    async def logout(self, token: str | None) -> None:
        if not token:
            return
        async with self._pool.acquire() as connection:
            await connection.execute("DELETE FROM player_tokens WHERE token = $1", token)

    async def set_custom_avatar(self, player_id: str, raw) -> Player:
        """Store or replace the account's image; an equipped previous upload is swapped for the new ID."""
        content_type, data = decode_custom_avatar(raw)
        actor_id = uuid.UUID(player_id)
        avatar_id = custom_avatar_id(player_id)
        async with self._pool.acquire() as connection:
            async with connection.transaction():
                previous = await connection.fetchval(
                    "SELECT avatar_id FROM player_custom_avatars WHERE player_id = $1 FOR UPDATE", actor_id
                )
                await connection.execute(
                    """
                    INSERT INTO player_custom_avatars (player_id, avatar_id, content_type, image) VALUES ($1, $2, $3, $4)
                    ON CONFLICT (player_id) DO UPDATE
                    SET avatar_id = EXCLUDED.avatar_id, content_type = EXCLUDED.content_type,
                        image = EXCLUDED.image, updated_at = now()
                    """,
                    actor_id, avatar_id, content_type, data,
                )
                row = await connection.fetchrow(
                    f"""
                    UPDATE players SET avatar = CASE WHEN avatar = $2 THEN $3 ELSE avatar END
                    WHERE id = $1 RETURNING *, {ACCOUNT_COLUMNS}
                    """,
                    actor_id, previous, avatar_id,
                )
        if row is None:
            raise PlayerError(401, "unauthorized", "Your session is no longer valid. Sign in again.")
        return _to_player(row)

    async def custom_avatar_image(self, avatar_id: str) -> tuple[str, bytes] | None:
        """The owner's current image; a superseded ID resolves to the latest upload."""
        owner = custom_avatar_owner(avatar_id)
        if owner is None:
            return None
        async with self._pool.acquire() as connection:
            row = await connection.fetchrow(
                "SELECT content_type, image FROM player_custom_avatars WHERE player_id = $1", owner
            )
        return (row["content_type"], bytes(row["image"])) if row else None


async def purge_player_by_name(pool, player_name: str) -> None:
    """Remove a disposable player; token and position rows cascade by schema contract."""
    async with pool.acquire() as connection:
        await connection.execute("DELETE FROM players WHERE name_key=$1", name_key(player_name))
