import importlib.util
import json
from pathlib import Path
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread

import pytest

spec = importlib.util.spec_from_file_location('party_conquest_railway', Path(__file__).parents[2] / 'scripts/railway_deploy.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
SHA = 'a' * 40


def test_api_requests_are_accepted_by_transport_that_rejects_generic_python_clients(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get('Content-Length', '0')))
            if self.headers.get('User-Agent', '').startswith('Python-urllib/'):
                self.send_error(403)
                return
            self.send_response(200)
            body = b'{"data":{"projectToken":{"projectId":"team","environmentId":"production"}}}'
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(deployment, 'API', f'http://127.0.0.1:{server.server_port}')
    try:
        assert deployment.token_context('test-only-token') == {'projectId': 'team', 'environmentId': 'production'}
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_release_staging_excludes_credentials_and_stamps_both_services(tmp_path):
    root = tmp_path / 'source'
    (root / 'backend/app').mkdir(parents=True)
    (root / 'public').mkdir()
    (root / 'backend/Dockerfile').write_text('FROM python:3.12-slim\n')
    for secret in (root / '.env', root / '.env.production', root / 'backend/.env'):
        secret.write_text('PASSWORD=never-upload-this')
    (root / 'backend/.venv').mkdir()
    (root / 'backend/.venv/secret').write_text('credentials')
    for private_path in ('.aws/credentials', '.ssh/id_ed25519', '.codex/config.toml',
                         'backend/.aws/credentials', 'backend/.ssh/id_ed25519',
                         'backend/.codex/config.toml'):
        path = root / private_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('credentials')
    stage = tmp_path / 'stage'
    deployment.stage_sources(root, stage, SHA)
    assert not list(stage.rglob('.env*'))
    assert not (stage / 'backend/.venv').exists()
    for private_directory in ('.aws', '.ssh', '.codex'):
        assert not list(stage.rglob(private_directory))
    assert f'ENV APP_VERSION={SHA}' in (stage / 'backend/Dockerfile').read_text()
    assert json.loads((stage / 'public/version.json').read_text())['version'] == SHA


def test_no_token_fails_before_contacting_railway(monkeypatch, tmp_path):
    monkeypatch.delenv('RAILWAY_TOKEN', raising=False)
    with pytest.raises(ValueError, match='RAILWAY_TOKEN'):
        deployment.deploy(tmp_path, SHA, 'https://team.up.railway.app')


def test_invalid_revision_is_not_inserted_into_dockerfile(tmp_path):
    with pytest.raises(ValueError, match='revision'):
        deployment.stage_sources(tmp_path, tmp_path / 'out', 'sha\nENV SECRET=bad')


def test_failed_backend_deploy_never_publishes_frontend(monkeypatch, tmp_path):
    monkeypatch.setenv('RAILWAY_TOKEN', 'test-only-token')
    monkeypatch.setattr(deployment, 'token_context', lambda _: {'projectId': 'team-project', 'environmentId': 'team-env'})
    monkeypatch.setattr(deployment, 'stage_sources', lambda *_: None)
    calls = []
    def fail(command, **kwargs):
        calls.append(command)
        raise subprocess.CalledProcessError(1, command)
    monkeypatch.setattr(deployment.subprocess, 'run', fail)
    with pytest.raises(subprocess.CalledProcessError):
        deployment.deploy(tmp_path, SHA, 'https://team.up.railway.app')
    assert len(calls) == 1
    assert calls[0][calls[0].index('--service') + 1] == 'backend'
    assert calls[0][calls[0].index('--project') + 1] == 'team-project'
    assert calls[0][calls[0].index('--environment') + 1] == 'team-env'


def test_stale_frontend_cannot_be_reported_as_published(monkeypatch):
    def response(url):
        if url.endswith('/version.json'):
            return {'version': 'b' * 40}
        return {'version': SHA, 'status': 'ok'}
    monkeypatch.setattr(deployment, 'read_json', response)
    with pytest.raises(RuntimeError, match='expected commit'):
        deployment.verify_release('https://team.example', SHA, attempts=1, pause=lambda _: None)


def test_matching_versions_still_require_backend_readiness(monkeypatch):
    monkeypatch.setattr(deployment, 'read_json', lambda _: {'version': SHA, 'status': 'unavailable'})
    with pytest.raises(RuntimeError, match='expected commit'):
        deployment.verify_release('https://team.example', SHA, attempts=1, pause=lambda _: None)
