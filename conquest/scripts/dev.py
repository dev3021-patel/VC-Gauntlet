#!/usr/bin/env python3
"""Run an isolated PostgreSQL database, Quart, and Vite for local development."""
from __future__ import annotations

import glob
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"


def run(command, **kwargs):
    return subprocess.run([str(part) for part in command], check=True, **kwargs)


def port(name, default):
    value = int(os.environ.get(name, default))
    if not 1 <= value <= 65535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return value


def require_free(value):
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", value))
        except OSError:
            raise RuntimeError(f"Port {value} is occupied; choose another port") from None


def pg_binary(name):
    found = shutil.which(name)
    directories = [str(Path(found).resolve().parent)] if found else []
    for pattern in ("/usr/lib/postgresql/*/bin", "/opt/homebrew/opt/postgresql*/bin", "/usr/local/opt/postgresql*/bin", "/Applications/Postgres.app/Contents/Versions/*/bin"):
        directories.extend(sorted(glob.glob(pattern), reverse=True))
    for directory in directories:
        candidate = Path(directory) / name
        # libpq's client-only package includes initdb/pg_ctl without postgres.
        if candidate.exists() and (Path(directory) / "postgres").exists():
            return str(candidate)
    return None


def local_database(db_port):
    """Return (URL, cleanup). An explicit connection bypasses all local DB setup."""
    explicit = os.environ.get("DATABASE_URL", "").strip()
    if explicit:
        return explicit, lambda: None
    mode = os.environ.get("LOCAL_DB_MODE", "auto")
    if mode not in {"auto", "native", "docker"}:
        raise ValueError("LOCAL_DB_MODE must be auto, native, or docker")
    initdb, pg_ctl = pg_binary("initdb"), pg_binary("pg_ctl")
    if mode == "native" or (mode == "auto" and initdb and pg_ctl):
        if not initdb or not pg_ctl:
            raise RuntimeError("Install PostgreSQL server binaries, or set DATABASE_URL; see README.md")
        data = LOCAL / "postgres"
        data.mkdir(parents=True, exist_ok=True)
        prefix = []
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            # PostgreSQL cannot run as root. Package installs create this user.
            import pwd
            try:
                account = pwd.getpwnam("postgres")
            except KeyError:
                raise RuntimeError("Install PostgreSQL to create the postgres user, or set DATABASE_URL") from None
            if not shutil.which("runuser"):
                raise RuntimeError("Root sessions need runuser to launch PostgreSQL")
            os.chown(data, account.pw_uid, account.pw_gid)
            prefix = ["runuser", "-u", "postgres", "--"]
        if not (data / "PG_VERSION").exists():
            run(prefix + [initdb, "-D", data, "-U", "party", "-A", "trust", "--encoding=UTF8", "--locale=C"])
        ctl = prefix + [pg_ctl, "-D", data]
        status = subprocess.run(ctl + ["status"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        started = status.returncode != 0
        if started:
            require_free(db_port)
            run(ctl + ["-l", data / "server.log", "-o", f"-h 127.0.0.1 -p {db_port} -k ''", "-w", "start"])

        def cleanup():
            if started:
                subprocess.run(ctl + ["-m", "fast", "-w", "stop"], check=False)

        return f"postgresql://party@127.0.0.1:{db_port}/postgres?sslmode=disable", cleanup
    if not shutil.which("docker"):
        raise RuntimeError("Install PostgreSQL server binaries or Docker, or set DATABASE_URL; see README.md")
    run(["docker", "compose", "-f", ROOT / "compose.yaml", "up", "-d", "--wait"], cwd=ROOT)
    # Docker DB persists independently of the dev servers; the README gives the stop command.
    return f"postgresql://party:party_local@127.0.0.1:{db_port}/party_conquest?sslmode=disable", lambda: None


def bootstrap():
    if sys.version_info < (3, 12):
        raise RuntimeError("Python 3.12 or newer is required")
    if not shutil.which("npm"):
        raise RuntimeError("Install Node.js 22.12 or newer (including npm)")
    LOCAL.mkdir(exist_ok=True)
    python = ROOT / "backend/.venv/bin/python"
    if not python.exists():
        run([sys.executable, "-m", "venv", ROOT / "backend/.venv"])
    requirements = ROOT / "backend/requirements-dev.txt"
    digest = hashlib.sha256(requirements.read_bytes() + (ROOT / "backend/requirements.txt").read_bytes()).hexdigest()
    marker = ROOT / "backend/.venv/requirements.sha256"
    if not marker.exists() or marker.read_text() != digest:
        run([python, "-m", "pip", "install", "-r", requirements])
        marker.write_text(digest)
    npm_digest = hashlib.sha256((ROOT / "package-lock.json").read_bytes()).hexdigest()
    npm_marker = LOCAL / "frontend-lock.sha256"
    if not (ROOT / "node_modules").exists() or not npm_marker.exists() or npm_marker.read_text() != npm_digest:
        run(["npm", "ci"], cwd=ROOT)
        npm_marker.write_text(npm_digest)
    return python


def stop_child(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def main():
    children = []
    stop_database = lambda: None
    # Signals interrupt startup as well as the running servers, invoking cleanup.
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        frontend_port = port("PREVIEW_PORT", os.environ.get("FRONTEND_PORT", "5173"))
        backend_port = port("BACKEND_PORT", "8000")
        db_port = port("LOCAL_DB_PORT", "55432")
        if len({frontend_port, backend_port, db_port}) != 3:
            raise ValueError("Frontend, backend, and database ports must be different")
        require_free(frontend_port)
        require_free(backend_port)
        python = bootstrap()
        database_url, stop_database = local_database(db_port)
        env = dict(os.environ, DATABASE_URL=database_url, DB_SCHEMA=os.environ.get("DB_SCHEMA", "party_conquest"))
        env.setdefault("APP_ENV", "development")
        env.setdefault("ENABLE_TEST_RESOLVER", "true")
        run([python, "-m", "app.migrate"], cwd=ROOT / "backend", env=env)
        backend = subprocess.Popen(
            [str(python), "-m", "hypercorn", "app.main:app", "--bind", f"127.0.0.1:{backend_port}"],
            cwd=ROOT / "backend", env=env, start_new_session=True,
        )
        children.append(backend)
        for _ in range(120):
            if backend.poll() is not None:
                raise RuntimeError("Backend exited before becoming ready")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{backend_port}/readyz", timeout=1) as response:
                    if json.load(response).get("status") == "ok":
                        break
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("Backend did not become ready; check PostgreSQL and migrations")
        env.update(VITE_BACKEND_URL="/api", VITE_BACKEND_PROXY=f"http://127.0.0.1:{backend_port}")
        frontend = subprocess.Popen(
            ["npm", "run", "dev", "--", "--host", os.environ.get("DEV_HOST", "127.0.0.1"), "--port", str(frontend_port), "--strictPort"],
            cwd=ROOT, env=env, start_new_session=True,
        )
        children.append(frontend)
        print(f"Conquest: http://127.0.0.1:{frontend_port} (API proxied through /api). Ctrl+C stops the servers.", flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.25)
        raise RuntimeError("A development server exited; stopping its sibling")
    except KeyboardInterrupt:
        return 0
    except (RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        return 1
    finally:
        for child in reversed(children):
            stop_child(child)
        stop_database()


if __name__ == "__main__":
    raise SystemExit(main())
