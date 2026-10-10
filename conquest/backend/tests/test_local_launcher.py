"""Launcher configuration failures must precede starting any services."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("party_conquest_dev", Path(__file__).parents[2] / "scripts/dev.py")
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


def test_client_only_postgres_installation_is_not_selected(monkeypatch, tmp_path):
    binary = tmp_path / "initdb"
    binary.touch()
    monkeypatch.setattr(dev.shutil, "which", lambda name: str(binary))
    monkeypatch.setattr(dev.glob, "glob", lambda pattern: [])
    assert dev.pg_binary("initdb") is None


def test_homebrew_server_is_found_when_not_on_path(monkeypatch, tmp_path):
    for name in ("initdb", "postgres", "pg_ctl"):
        (tmp_path / name).touch()
    monkeypatch.setattr(dev.shutil, "which", lambda name: None)
    monkeypatch.setattr(dev.glob, "glob", lambda pattern: [str(tmp_path)] if "homebrew" in pattern else [])
    assert dev.pg_binary("initdb") == str(tmp_path / "initdb")


def test_explicit_database_bypasses_local_provisioning(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://team:pw@db.example/team")
    monkeypatch.setattr(dev, "run", lambda *args, **kwargs: pytest.fail("must not provision a database"))
    url, cleanup = dev.local_database(55432)
    assert url == "postgresql://team:pw@db.example/team"
    cleanup()


def test_invalid_database_mode_fails_before_provisioning(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("LOCAL_DB_MODE", "unexpected")
    with pytest.raises(ValueError, match="LOCAL_DB_MODE"):
        dev.local_database(55432)


def test_duplicate_service_ports_fail_before_bootstrap(monkeypatch):
    monkeypatch.setenv("PREVIEW_PORT", "8000")
    monkeypatch.setenv("BACKEND_PORT", "8000")
    monkeypatch.setattr(dev, "bootstrap", lambda: pytest.fail("must not bootstrap"))
    assert dev.main() == 1
