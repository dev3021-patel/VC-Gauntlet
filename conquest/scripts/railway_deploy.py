#!/usr/bin/env python3
"""Deploy pre-provisioned team services; never upload local credentials/data."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
API = 'https://backboard.railway.com/graphql/v2'
USER_AGENT = 'party-conquest-deployer/1.0'


def validate_revision(revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('revision must be a full 40-character Git commit SHA')


def stage_sources(root: Path, target: Path, revision: str):
    validate_revision(revision)
    def ignored(directory, names):
        excluded = shutil.ignore_patterns('.git', '.aws', '.ssh', '.codex', '.env*', '.venv', '.local', '.vercel', 'node_modules', 'dist', '__pycache__', '*.pyc', '.pytest_cache', 'coverage')(directory, names)
        return set(excluded) | {name for name in names if (Path(directory) / name).is_symlink()}
    shutil.copytree(root, target, ignore=ignored)
    dockerfile = target / 'backend/Dockerfile'
    dockerfile.write_text(dockerfile.read_text() + f'\nENV APP_VERSION={revision}\n')
    (target / 'public/version.json').write_text(json.dumps({'version': revision}) + '\n')


def token_context(token):
    request = urllib.request.Request(API, data=json.dumps({'query': 'query { projectToken { projectId environmentId } }'}).encode(), headers={'Content-Type': 'application/json', 'Project-Access-Token': token, 'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if payload.get('errors') or not payload.get('data', {}).get('projectToken'):
        raise RuntimeError('Railway rejected the project token; check its environment scope')
    return payload['data']['projectToken']


def read_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def verify_release(public_url, revision, *, attempts=60, pause=time.sleep):
    for _ in range(attempts):
        try:
            backend = read_json(public_url + '/api/healthz')
            frontend = read_json(public_url + '/version.json')
            ready = read_json(public_url + '/api/readyz')
            if backend.get('version') == frontend.get('version') == revision and ready.get('status') == 'ok':
                return
        except (urllib.error.URLError, TimeoutError, ValueError):
            pass
        pause(3)
    raise RuntimeError('Published frontend/backend did not become ready at the expected commit')


def deploy(root: Path, revision: str, public_url: str):
    token = os.environ.get('RAILWAY_TOKEN', '').strip()
    if not token:
        raise ValueError('Set RAILWAY_TOKEN to the team project environment token')
    validate_revision(revision)
    if not public_url.startswith('https://'):
        raise ValueError('Set RAILWAY_PUBLIC_URL to the generated HTTPS frontend domain')
    public_url = public_url.rstrip('/')
    context = token_context(token)
    # Avoid accidentally authenticating CLI calls with an organizer token.
    env = {key: value for key, value in os.environ.items() if key != 'RAILWAY_API_TOKEN'}
    with tempfile.TemporaryDirectory(prefix='party-conquest-release-') as temp:
        staged = Path(temp) / 'conquest'
        stage_sources(root, staged, revision)
        common = ['--project', context['projectId'], '--environment', context['environmentId']]
        # In non-interactive runs up can return after queueing the upload.
        # Published versions and readiness below determine release success.
        for service, source in [('backend', staged / 'backend'), ('frontend', staged)]:
            subprocess.run(['railway', 'up', str(source), '--path-as-root', '--service', service, *common, '--message', f'Conquest {revision}'], check=True, env=env, cwd=staged)
    verify_release(public_url, revision)
    print(f'Published commit {revision}: {public_url}')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write(f'Conquest published: [{public_url}]({public_url})\n\nCommit: `{revision}`\n')


if __name__ == '__main__':
    try:
        deploy(ROOT, os.environ.get('GITHUB_SHA', ''), os.environ.get('RAILWAY_PUBLIC_URL', ''))
    except (ValueError, RuntimeError, subprocess.CalledProcessError, urllib.error.URLError) as error:
        print(f'Deployment failed: {error}', file=sys.stderr)
        raise SystemExit(1)
