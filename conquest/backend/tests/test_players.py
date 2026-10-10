import asyncio
import base64
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app import create_app
from app.pg_store import _to_player
from app.players import (
    ALL_AVATARS, AVATARS, CUSTOM_AVATAR_MAX_BYTES, LOCKOUT_SECONDS, MAX_FAILED_ATTEMPTS, Player, PlayerStore,
    custom_avatar_owner,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def test_postgres_player_ids_use_canonical_uuid_format():
    player_id = uuid.UUID("adad3b09-f266-4295-b84c-821096b9b0cd")
    row = {
        "id": player_id,
        "name": "Christian",
        "avatar": "ember",
        "created_at": datetime.now(timezone.utc),
        "last_seen_at": datetime.now(timezone.utc),
        "pin_salt": "00",
        "pin_hash": "00",
        "failed_attempts": 0,
        "locked_until": None,
    }
    assert _to_player(row).id == str(player_id)


def call(client, method, path, body=None, token=None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    coro = getattr(client, method)(path, json=body, headers=headers)
    response = asyncio.run(coro)
    payload = asyncio.run(response.get_json()) if response.status_code != 204 else None
    return response, payload


def make_client(path=None):
    return create_app(PlayerStore(path)).test_client()


def test_register_login_and_me_round_trip():
    client = make_client()

    response, body = call(client, "post", "/players/register", {"name": "  Marlowe  ", "pin": "1234", "avatar": "moss"})
    assert response.status_code == 201
    assert body["player"]["name"] == "Marlowe"
    assert body["player"]["avatar"] == "moss"
    assert "pin" not in json.dumps(body)
    assert body["token"]

    response, me = call(client, "get", "/players/me", token=body["token"])
    assert response.status_code == 200
    assert me["player"]["id"] == body["player"]["id"]

    response, login = call(client, "post", "/players/login", {"name": "marlowe", "pin": "1234"})
    assert response.status_code == 200
    assert login["player"]["id"] == body["player"]["id"]
    assert login["token"] != body["token"]


def test_register_rejects_bad_input_and_duplicates():
    client = make_client()
    assert call(client, "post", "/players/register", {"name": "  ", "pin": "1234", "avatar": "moss"})[0].status_code == 400
    assert call(client, "post", "/players/register", {"name": "Ok", "pin": "12a4", "avatar": "moss"})[0].status_code == 400
    assert call(client, "post", "/players/register", {"name": "Ok", "pin": "12345", "avatar": "moss"})[0].status_code == 400
    assert call(client, "post", "/players/register", {"name": "Ok", "pin": "1234", "avatar": "unicorn"})[0].status_code == 400
    assert call(client, "post", "/players/register", "nope")[0].status_code == 400

    assert call(client, "post", "/players/register", {"name": "Wren", "pin": "1234", "avatar": "tide"})[0].status_code == 201
    response, body = call(client, "post", "/players/register", {"name": " WREN ", "pin": "0000", "avatar": "ash"})
    assert response.status_code == 409
    assert body["error"] == "name-taken"


def test_avatar_catalog_has_sprites_and_representative_avatars_are_free_at_registration():
    # The frontend AVATAR_IDS mirrors this order (validation.test.ts pins it).
    assert AVATARS == (
        "ember", "tide", "moss", "dune", "frost", "ash",
        "dog", "clown", "shark", "toilet", "hot-dog", "cowboy-hat",
        "cleopatra", "julius-caesar", "genghis-khan", "joan-of-arc", "leonardo-da-vinci", "william-shakespeare",
        "galileo-galilei", "isaac-newton", "napoleon-bonaparte", "ada-lovelace", "abraham-lincoln", "harriet-tubman",
        "robot", "dragon", "crown", "ghost", "cat", "alien", "wizard", "skull",
    )
    assert ALL_AVATARS == AVATARS
    root = Path(__file__).resolve().parents[2]
    for avatar in AVATARS[6:]:
        assert (root / "public" / "avatars" / f"{avatar}.png").read_bytes().startswith(b"\x89PNG")
    # Every avatar registers through the same allow-list; test_avatar_catalog.py
    # registers each one in the full suite.
    client = make_client()
    for index, avatar in enumerate(("dog", "cleopatra", "skull")):
        response, body = call(client, "post", "/players/register", {
            "name": f"New Player {index}", "pin": "1234", "avatar": avatar,
        })
        assert response.status_code == 201
        assert body["player"]["avatar"] == avatar
        assert "unlockedAvatars" not in body["player"]


def test_legacy_records_with_shop_ownership_still_load(tmp_path):
    path = tmp_path / "players.json"
    path.write_text(json.dumps({"version": 1, "players": [{
        "id": "y", "name": "Old", "avatar": "dragon", "created_at": 1.0, "last_seen_at": 2.0, "pin_salt": "00", "pin_hash": "00",
        "failed_attempts": 0, "locked_until": 0.0, "tokens": ["tok"], "unlocked_avatars": ["dragon"],
    }]}))
    store = PlayerStore(str(path))
    restored = asyncio.run(store.authenticate("tok"))
    assert restored.public()["avatar"] == "dragon" and "unlockedAvatars" not in restored.public()


def test_login_failures_are_uniform_and_lock_out():
    client = make_client()
    call(client, "post", "/players/register", {"name": "Wren", "pin": "1234", "avatar": "tide"})

    missing = call(client, "post", "/players/login", {"name": "Nobody", "pin": "1234"})
    wrong = call(client, "post", "/players/login", {"name": "Wren", "pin": "9999"})
    assert missing[0].status_code == wrong[0].status_code == 401
    assert missing[1]["message"] == wrong[1]["message"]

    for _ in range(MAX_FAILED_ATTEMPTS - 1):
        call(client, "post", "/players/login", {"name": "Wren", "pin": "9999"})
    response, body = call(client, "post", "/players/login", {"name": "Wren", "pin": "1234"})
    assert response.status_code == 429
    assert body["error"] == "locked"
    assert int(response.headers["Retry-After"]) <= LOCKOUT_SECONDS + 1


def test_me_requires_a_valid_token_and_logout_revokes_it():
    client = make_client()
    assert call(client, "get", "/players/me")[0].status_code == 401
    assert call(client, "get", "/players/me", token="bogus")[0].status_code == 401

    _, body = call(client, "post", "/players/register", {"name": "Wren", "pin": "1234", "avatar": "tide"})
    assert call(client, "post", "/players/logout", token=body["token"])[0].status_code == 204
    assert call(client, "get", "/players/me", token=body["token"])[0].status_code == 401


def test_store_persists_across_restarts(tmp_path):
    path = str(tmp_path / "players.json")
    first = make_client(path)
    _, body = call(first, "post", "/players/register", {"name": "Wren", "pin": "1234", "avatar": "tide"})

    second = make_client(path)
    response, me = call(second, "get", "/players/me", token=body["token"])
    assert response.status_code == 200
    assert me["player"]["name"] == "Wren"
    assert call(second, "post", "/players/login", {"name": "wren", "pin": "1234"})[0].status_code == 200
    assert call(second, "post", "/players/register", {"name": "Wren", "pin": "1234", "avatar": "tide"})[0].status_code == 409


def image(data: bytes = PNG, content_type: str = "image/png") -> dict:
    return {"contentType": content_type, "data": base64.b64encode(data).decode()}


def test_registration_with_custom_image_equips_a_private_owner_scoped_avatar():
    client = make_client()
    response, body = call(client, "post", "/players/register", {
        "name": "Painter", "pin": "1234", "avatar": "custom", "customAvatar": image(),
    })
    assert response.status_code == 201
    custom = body["player"]["customAvatar"]
    assert body["player"]["avatar"] == custom
    assert str(custom_avatar_owner(custom)) == str(uuid.UUID(body["player"]["id"]))
    served = asyncio.run(client.get(f"/avatars/{custom}"))
    assert served.status_code == 200 and served.headers["Content-Type"] == "image/png"
    assert asyncio.run(served.get_data()) == PNG
    assert asyncio.run(client.get(f"/avatars/custom-{uuid.uuid4().hex}-00000000")).status_code == 404
    # Choosing the upload option without an image is a field error, not an account.
    response, body = call(client, "post", "/players/register", {"name": "Blank", "pin": "1234", "avatar": "custom"})
    assert response.status_code == 400 and body["error"] == "avatar-image-invalid"


def test_custom_upload_rejects_bad_images_without_replacing_and_replacement_supersedes():
    client = make_client()
    _, body = call(client, "post", "/players/register", {"name": "Painter", "pin": "1234", "avatar": "custom", "customAvatar": image()})
    token, first = body["token"], body["player"]["customAvatar"]
    rejected = [
        (image(content_type="image/gif"), 415, "avatar-image-type"),
        (image(b"\xff\xd8\xff" + b"\x00" * 8), 400, "avatar-image-invalid"),
        (image(PNG + b"\x00" * CUSTOM_AVATAR_MAX_BYTES), 413, "avatar-image-too-large"),
        ({"contentType": "image/png", "data": "not base64!"}, 400, "avatar-image-invalid"),
    ]
    for upload, status, code in rejected:
        response, error = call(client, "put", "/players/me/custom-avatar", upload, token=token)
        assert (response.status_code, error["error"]) == (status, code)
    _, me = call(client, "get", "/players/me", token=token)
    assert me["player"]["customAvatar"] == first
    webp = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 8
    response, replaced = call(client, "put", "/players/me/custom-avatar", image(webp, "image/webp"), token=token)
    assert response.status_code == 200
    second = replaced["player"]["customAvatar"]
    # The equipped previous upload is swapped; either ID serves only the latest image.
    assert second != first and replaced["player"]["avatar"] == second
    for avatar_id in (first, second):
        assert asyncio.run(asyncio.run(client.get(f"/avatars/{avatar_id}")).get_data()) == webp
    assert call(client, "put", "/players/me/custom-avatar", image(), token="bogus")[0].status_code == 401
