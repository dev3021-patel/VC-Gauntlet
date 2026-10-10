import pytest


@pytest.fixture(autouse=True)
def stub_database_config(monkeypatch, request):
    """Keep unit tests offline; database tests explicitly provide disposable connections."""
    if request.node.get_closest_marker("no_db_stub"):
        return

    monkeypatch.setattr("app.db.load_db_config", lambda *args, **kwargs: None)


@pytest.fixture(autouse=True)
def empty_mob_world(monkeypatch, request):
    """Mocked-connection tests predate mobs: present an empty mob population.

    Every resolver query goes through the same AsyncMock, so without this stub a
    player row would be mistaken for a mob. Mark a test ``real_mobs`` to exercise
    the real mob queries against PostgreSQL.
    """
    if request.node.get_closest_marker("real_mobs"):
        return

    async def no_cells(connection, world_id):
        return set()

    async def unoccupied(connection, world_id, x, y):
        return False

    async def nothing_on_path(connection, world_id, *_):
        return None

    async def nothing_in_cells(connection, world_id, cells):
        return []

    monkeypatch.setattr("app.mobs.mob_cells", no_cells)
    monkeypatch.setattr("app.mobs.mob_occupies", unoccupied)
    monkeypatch.setattr("app.mobs.mob_on_path", nothing_on_path)
    monkeypatch.setattr("app.mobs.mobs_in_cells", nothing_in_cells)


@pytest.fixture(autouse=True)
def uncontested_avatars(monkeypatch, request):
    """Mocked-connection tests predate avatar uniqueness: every claim succeeds.

    Mark a test ``real_avatar_claims`` to run the real claim queries.
    """
    if request.node.get_closest_marker("real_avatar_claims"):
        return

    async def claimed(*args):
        return True

    async def nothing(*args):
        return None

    async def free(*args):
        return False

    async def nobody(*args):
        return []

    monkeypatch.setattr("app.avatar_claims.claim", claimed)
    monkeypatch.setattr("app.avatar_claims.claim_saved", claimed)
    monkeypatch.setattr("app.avatar_claims.release", nothing)
    monkeypatch.setattr("app.avatar_claims.held_anywhere", free)
    monkeypatch.setattr("app.avatar_claims.in_use", nobody)


@pytest.fixture(autouse=True)
def unthrottled_shots(monkeypatch, request):
    """Most tests fire several shots in quick succession; mark ``shot_cadence`` to keep the real cooldown."""
    if request.node.get_closest_marker("shot_cadence"):
        return
    monkeypatch.setattr("app.world_transport.SHOT_COOLDOWN_SECONDS", 0.0)
