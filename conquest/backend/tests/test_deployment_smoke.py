from app import deployment_smoke
from app.player_positions import WORLD_SIZE, block_is_traversable


def test_smoke_path_uses_current_coordinate_model_and_traversable_cells():
    spawn, destination = deployment_smoke.smoke_path()

    assert all(0 <= value < WORLD_SIZE for value in (*spawn, *destination))
    assert block_is_traversable(*spawn)
    assert block_is_traversable(*destination)
    assert abs(spawn[0] - destination[0]) + abs(spawn[1] - destination[1]) == 1


def test_main_preserves_verification_failure_when_cleanup_also_fails(monkeypatch, capsys):
    monkeypatch.setattr(deployment_smoke.sys, "argv", ["deployment_smoke", "https://example.test"])
    monkeypatch.setattr(deployment_smoke, "verify", lambda *args: (_ for _ in ()).throw(RuntimeError("primary")))

    async def fail_cleanup(*args):
        raise RuntimeError("secondary")

    monkeypatch.setattr(deployment_smoke, "cleanup", fail_cleanup)

    assert deployment_smoke.main() == 1
    error = capsys.readouterr().err
    assert "verification failed: primary" in error
    assert "cleanup failed: secondary" in error
