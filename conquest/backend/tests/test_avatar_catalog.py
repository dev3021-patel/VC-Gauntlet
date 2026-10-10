"""Exhaustive avatar registration; full-suite only (not a required PR check).

test_players.py covers the catalog, sprites, and representative registrations.
"""
from app.players import AVATARS
from tests.test_players import call, make_client


def test_every_avatar_is_free_at_registration():
    client = make_client()
    for index, avatar in enumerate(AVATARS):
        response, body = call(client, "post", "/players/register", {
            "name": f"New Player {index}", "pin": "1234", "avatar": avatar,
        })
        assert response.status_code == 201
        assert body["player"]["avatar"] == avatar
        assert "unlockedAvatars" not in body["player"]
