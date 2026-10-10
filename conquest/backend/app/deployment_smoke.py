"""Exercise authenticated production commands, then remove all smoke records."""

from __future__ import annotations

import asyncio
import json
import secrets
import sys
import urllib.request

from app.db import create_pool, load_db_config
from app.pg_store import purge_player_by_name
from app.player_positions import WORLD_SIZE, block_is_traversable
from app.world_transport import PROTOCOL_VERSION, SCHEMA_VERSION, purge_world


def request_json(url: str, method: str = "GET", body: dict | None = None, token: str | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=15) as response:
        return json.load(response)


def command(world_id: str, command_id: str, action: str, payload: dict) -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "schemaVersion": SCHEMA_VERSION,
        "worldId": world_id,
        "commandId": command_id,
        "actionType": action,
        "payload": payload,
    }


async def cleanup(world_id: str, player_name: str) -> None:
    pool = await create_pool(load_db_config(), max_size=1)
    try:
        await purge_world(pool, world_id)
        await purge_player_by_name(pool, player_name)
    finally:
        await pool.close()


def smoke_path() -> tuple[tuple[int, int], tuple[int, int]]:
    """Find adjacent traversable blocks under the coordinate model in this image."""
    for y in range(WORLD_SIZE):
        for x in range(WORLD_SIZE):
            if not block_is_traversable(x, y):
                continue
            for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
                destination = (x + dx, y + dy)
                if 0 <= destination[0] < WORLD_SIZE and 0 <= destination[1] < WORLD_SIZE:
                    if block_is_traversable(*destination):
                        return (x, y), destination
    raise RuntimeError("coordinate model has no adjacent traversable blocks")


def verify(base_url: str, world_id: str, player_name: str, suffix: str) -> None:
    spawn, destination = smoke_path()
    identity = request_json(
        f"{base_url}/players/register",
        "POST",
        {"name": player_name, "pin": "4837", "avatar": "moss"},
    )
    token = identity["token"]
    placed = request_json(
        f"{base_url}/v1/worlds/{world_id}/commands",
        "POST",
        command(world_id, f"place-{suffix}", "player.place", {"suggestedPosition": {"x": spawn[0], "y": spawn[1]}}),
        token,
    )
    position = placed["event"]["payload"]
    if placed["status"] != "committed" or (position["x"], position["y"]) != spawn:
        raise RuntimeError("authenticated placement did not commit at the model-derived cell")
    moved = request_json(
        f"{base_url}/v1/worlds/{world_id}/commands",
        "POST",
        command(
            world_id,
            f"move-{suffix}",
            "player.move",
            {
                "expected": {"x": spawn[0], "y": spawn[1]},
                "destination": {"x": destination[0], "y": destination[1]},
                "expectedRevision": position["positionRevision"],
            },
        ),
        token,
    )
    if moved["status"] != "committed" or moved["event"]["eventType"] != "player.moved":
        raise RuntimeError("authenticated movement did not commit")
    snapshot = request_json(f"{base_url}/v1/worlds/{world_id}/snapshot")
    matches = [item for item in snapshot["state"]["players"] if item["playerId"] == identity["player"]["id"]]
    if len(matches) != 1 or (matches[0]["x"], matches[0]["y"]) != destination:
        raise RuntimeError("committed movement is absent from the world snapshot")


def main() -> int:
    base_url = sys.argv[1].rstrip("/")
    suffix = secrets.token_hex(6)
    world_id = f"deployment-smoke-{suffix}"
    player_name = f"smoke-{suffix}"
    result = 0
    try:
        verify(base_url, world_id, player_name, suffix)
        print("Authenticated placement, movement, and snapshot verification passed.")
    except Exception as exc:  # noqa: BLE001 - emit one safe delivery diagnostic, not a traceback
        print(f"Deployment smoke verification failed: {exc}", file=sys.stderr)
        result = 1
    try:
        asyncio.run(cleanup(world_id, player_name))
    except Exception as exc:  # noqa: BLE001 - never replace the primary verification failure
        print(f"Deployment smoke cleanup failed: {exc}", file=sys.stderr)
        result = 1
    return result


if __name__ == "__main__":
    raise SystemExit(main())
