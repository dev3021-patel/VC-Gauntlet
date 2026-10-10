import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location(
    'party_conquest_org_provision', Path(__file__).parents[2] / 'scripts/provision_team.py')
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)

ORG_ID = '3d872f24-a0e0-4e03-b39c-16b242a0e3f7'
TENANT_ID = '2d41eebf-9f28-40f2-bf30-353f1f2507fd'
WORKSPACE_ID = '5268c7ea-95a4-4a46-a6f5-2168c19c9e83'
REPO = 'Party-Internal/hackathon-team'
REPOSITORY_ID = 123456


def private_config(path, **values):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(values))
    path.chmod(0o600)
    return path


@pytest.fixture
def starter(tmp_path):
    source = tmp_path / 'starter'
    for name in ('README.md', 'backend/Dockerfile', 'deploy/Dockerfile.frontend',
                 'deploy/github/railway.yml', 'scripts/railway_deploy.py'):
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('prepared starter')
    return source


@pytest.fixture
def resolved_org(monkeypatch):
    calls = []
    def lookup(org_id, config):
        calls.append((org_id, config))
        return {'org_id': ORG_ID, 'tenant_id': TENANT_ID, 'repo': REPO,
                'repository_id': REPOSITORY_ID}
    monkeypatch.setattr(provision, 'lookup_party_org', lookup, raising=False)
    return calls


def test_private_organizer_configuration_and_absent_optional_file(tmp_path):
    assert provision.read_organizer_config(tmp_path / 'absent.json') == {}
    config = {'railway_workspace_id': WORKSPACE_ID, 'railway_api_token': 'organizer-secret'}
    path = private_config(tmp_path / 'organizer.json', **config)
    assert provision.read_organizer_config(path) == config


@pytest.mark.parametrize('origin', ['', None, 42, 'http://party.example',
                                    'https://private-user:private-password@party.example',
                                    'https://party.example/api', 'https://party.example?query=private',
                                    'https://party.example#fragment'])
def test_private_configuration_rejects_invalid_party_api_origin(tmp_path, monkeypatch, origin):
    monkeypatch.syspath_prepend(str(Path(__file__).parents[2] / 'scripts'))
    config = private_config(tmp_path / 'organizer.json', party_api_url=origin)
    with pytest.raises(ValueError) as error:
        provision.read_organizer_config(config)
    assert 'private-password' not in str(error.value)


def test_party_environment_factory_passes_the_explicit_api_origin_without_rewriting_saved_sign_in(monkeypatch):
    calls = []
    client = object()
    helper = SimpleNamespace(
        signed_in_client=lambda binding, **options: calls.append((binding, options)) or client,
        PartyEnvironment=lambda received: received,
    )
    monkeypatch.setitem(sys.modules, 'party_environment', helper)
    binding = {'org_id': ORG_ID, 'tenant_id': TENANT_ID, 'repo': REPO}
    config = {'party_cli_source': '/private/party-cli-source', 'party_api_url': 'https://public.party.example'}
    assert provision.party_environment_for_org(binding, config) is client
    assert calls == [(binding, {'cli_source': '/private/party-cli-source', 'api_url': 'https://public.party.example'})]


def test_organizer_configuration_cannot_be_kept_in_a_git_checkout(tmp_path):
    repo = tmp_path / 'repo'
    subprocess.run(['git', 'init', '--initial-branch=main', str(repo)],
                   capture_output=True, check=True)
    config = private_config(repo / 'private/organizer.json', railway_api_token='never-publish')
    with pytest.raises(ValueError, match='(?i)outside.*Git'):
        provision.read_organizer_config(config)


def test_organizer_configuration_cannot_be_copied_with_a_custom_starter(
        tmp_path, monkeypatch, starter):
    config = private_config(starter / 'organizer.json', railway_workspace_id=WORKSPACE_ID,
                            railway_api_token='never-publish')
    monkeypatch.setattr(provision, 'lookup_party_org',
                        lambda *args: pytest.fail('Unsafe source must fail before lookup'))
    with pytest.raises(ValueError, match='(?i)config.*outside'):
        provision.main(['--org-id', ORG_ID, '--config', str(config),
                        '--source', str(starter), '--dry-run'])


@pytest.mark.parametrize('kind', ['public', 'symlink', 'invalid-json', 'not-an-object'])
def test_organizer_configuration_rejects_unsafe_files_without_echoing_secrets(tmp_path, kind):
    path = private_config(tmp_path / 'organizer.json', railway_api_token='never-echo-this-secret')
    if kind == 'public':
        path.chmod(0o644)
    elif kind == 'symlink':
        link = tmp_path / 'organizer-link.json'
        link.symlink_to(path)
        path = link
    elif kind == 'invalid-json':
        path.write_text('{"railway_api_token":"never-echo-this-secret",BROKEN}')
    else:
        path.write_text('["never-echo-this-secret"]')
    with pytest.raises(ValueError) as error:
        provision.read_organizer_config(path)
    assert 'never-echo-this-secret' not in str(error.value)


def test_org_only_dry_run_resolves_repo_with_saved_configuration_without_writes(
        tmp_path, monkeypatch, starter, resolved_org, capsys):
    home = tmp_path / 'home'
    config = {'railway_workspace_id': WORKSPACE_ID, 'railway_api_token': 'organizer-secret',
              'party_kube_context': 'party-cluster', 'party_namespace': 'party',
              'party_deployment': 'party-api'}
    private_config(home / '.config/party-conquest/organizer.json', **config)
    monkeypatch.setattr(Path, 'home', lambda: home)
    monkeypatch.delenv('PARTY_CONQUEST_CONFIG', raising=False)
    monkeypatch.delenv('RAILWAY_WORKSPACE_ID', raising=False)
    monkeypatch.delenv('RAILWAY_API_TOKEN', raising=False)
    monkeypatch.setattr(provision, 'Railway', lambda *args: pytest.fail('Dry-run must not contact Railway'))
    monkeypatch.setattr(provision, 'run_process', lambda *args, **kwargs: pytest.fail('Dry-run must not modify GitHub'))
    provision.main(['--org-id', ORG_ID.upper(), '--source', str(starter), '--dry-run'])
    plan = json.loads(capsys.readouterr().out)
    assert plan['repo'] == REPO
    assert plan['workspace'] == WORKSPACE_ID
    assert plan['party_org_id'] == ORG_ID
    assert plan['party_tenant_id'] == TENANT_ID
    assert plan['repository_id'] == REPOSITORY_ID
    assert plan['state'] == str(home / '.local/state/party-conquest/teams' / f'{ORG_ID}.json')
    assert resolved_org == [(ORG_ID, config)]
    assert not (home / '.local/state/party-conquest').exists()
    assert 'organizer-secret' not in json.dumps(plan)


def test_org_dry_run_respects_environment_configuration_and_workspace_override(
        tmp_path, monkeypatch, starter, resolved_org, capsys):
    path = private_config(tmp_path / 'custom.json', railway_workspace_id='saved-workspace',
                          railway_api_token='saved-secret')
    monkeypatch.setenv('PARTY_CONQUEST_CONFIG', str(path))
    monkeypatch.setenv('RAILWAY_WORKSPACE_ID', WORKSPACE_ID)
    provision.main(['--org-id', ORG_ID, '--source', str(starter), '--dry-run'])
    plan = json.loads(capsys.readouterr().out)
    assert plan['workspace'] == WORKSPACE_ID
    assert resolved_org[0][1]['railway_api_token'] == 'saved-secret'
    assert 'saved-secret' not in json.dumps(plan)


@pytest.mark.parametrize('target', ['not-a-uuid', '../org', '3d872f24-a0e0-4e03'])
def test_invalid_org_is_rejected_before_lookup_or_resource_creation(monkeypatch, target):
    monkeypatch.setattr(provision, 'lookup_party_org', lambda *args: pytest.fail('Invalid org must not be looked up'), raising=False)
    with pytest.raises(ValueError, match='UUID'):
        provision.main(['--org-id', target])


def test_org_and_explicit_repo_are_mutually_exclusive(monkeypatch):
    monkeypatch.setattr(provision, 'lookup_party_org', lambda *args: pytest.fail('Conflicting input must fail before lookup'), raising=False)
    with pytest.raises(SystemExit) as error:
        provision.main(['--org-id', ORG_ID, '--repo', REPO])
    assert error.value.code == 2


def test_explicit_repo_dry_run_stays_offline(tmp_path, monkeypatch, starter, capsys):
    monkeypatch.setattr(provision, 'lookup_party_org', lambda *args: pytest.fail('Explicit repo does not need Party'), raising=False)
    monkeypatch.setattr(provision, 'run_process', lambda *args, **kwargs: pytest.fail('Explicit dry-run stays offline'))
    provision.main(['--repo', REPO, '--workspace-id', WORKSPACE_ID,
                    '--state', str(tmp_path / 'state.json'), '--source', str(starter), '--dry-run'])
    assert json.loads(capsys.readouterr().out)['repo'] == REPO


def test_org_binding_repository_identity_is_verified_before_railway(
        tmp_path, monkeypatch, starter, resolved_org):
    path = private_config(tmp_path / 'organizer.json', railway_workspace_id=WORKSPACE_ID,
                          railway_api_token='saved-organizer-secret')
    class Github(provision.GitHub):
        def __init__(self, repo):
            assert repo == REPO
        def preflight(self):
            return {'id': REPOSITORY_ID + 1, 'full_name': REPO}
    monkeypatch.setattr(provision, 'GitHub', Github)
    monkeypatch.setattr(provision, 'Railway', lambda *args: pytest.fail('Wrong repository must abort before paid resources'))
    monkeypatch.setattr(provision.shutil, 'which', lambda _: '/test/tool')
    with pytest.raises(ValueError, match='(?i)(identity|binding|repository)'):
        provision.main(['--org-id', ORG_ID, '--config', str(path), '--source', str(starter),
                        '--state', str(tmp_path / 'private/state.json')])


@pytest.mark.parametrize('field,replacement', [
    ('party_org_id', '523658d4-6356-4c3a-a42d-e9dd7d4cc7f'),
    ('party_tenant_id', '792b7caf-789b-4de0-ae25-ac47159bec6a'),
    ('repository_id', REPOSITORY_ID + 1),
])
def test_org_checkpoint_cannot_be_reused_after_binding_identity_changes(
        tmp_path, monkeypatch, starter, resolved_org, field, replacement):
    config = private_config(tmp_path / 'organizer.json', railway_workspace_id=WORKSPACE_ID,
                            railway_api_token='saved-organizer-secret')
    checkpoint = tmp_path / 'private/state.json'
    state = provision.State(checkpoint, REPO, WORKSPACE_ID)
    saved_binding = {'party_org_id': ORG_ID, 'party_tenant_id': TENANT_ID,
                     'repository_id': REPOSITORY_ID}
    saved_binding[field] = replacement
    state.update(**saved_binding)
    before = checkpoint.read_bytes()
    class Github(provision.GitHub):
        def __init__(self, repo):
            assert repo == REPO
        def preflight(self):
            return {'id': REPOSITORY_ID, 'full_name': REPO}
    monkeypatch.setattr(provision, 'GitHub', Github)
    monkeypatch.setattr(provision, 'Railway', lambda *args: pytest.fail('Binding mismatch must stop before Railway'))
    monkeypatch.setattr(provision.shutil, 'which', lambda _: '/test/tool')
    with pytest.raises(ValueError, match='(?i)(identity|binding|different|checkpoint)'):
        provision.main(['--org-id', ORG_ID, '--config', str(config), '--source', str(starter),
                        '--state', str(checkpoint)])
    assert checkpoint.read_bytes() == before


@pytest.mark.parametrize('environment_token', [None, 'environment-organizer-secret'])
@pytest.mark.parametrize('failed_stage', [None, 'workflow', 'readiness'])
def test_org_only_handoff_uses_saved_defaults_and_persists_canonical_binding(
        tmp_path, monkeypatch, starter, resolved_org, capsys, environment_token, failed_stage):
    def git(*args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd, text=True, check=True,
                              capture_output=True).stdout.strip()
    home = tmp_path / 'home'
    monkeypatch.setattr(Path, 'home', lambda: home)
    private_config(home / '.config/party-conquest/organizer.json',
                   railway_workspace_id=WORKSPACE_ID, railway_api_token='saved-organizer-secret')
    monkeypatch.delenv('PARTY_CONQUEST_CONFIG', raising=False)
    if environment_token:
        monkeypatch.setenv('RAILWAY_API_TOKEN', environment_token)
    else:
        monkeypatch.delenv('RAILWAY_API_TOKEN', raising=False)
    monkeypatch.delenv('RAILWAY_WORKSPACE_ID', raising=False)
    remote, initial = tmp_path / 'remote.git', tmp_path / 'initial'
    git('init', '--bare', str(remote))
    git('init', '--initial-branch=main', str(initial))
    git('config', 'user.name', 'Test Organizer', cwd=initial)
    git('config', 'user.email', 'test@example.invalid', cwd=initial)
    (initial / 'existing-team-data.txt').write_text('preserve')
    git('add', '.', cwd=initial)
    git('commit', '-m', 'initial', cwd=initial)
    git('remote', 'add', 'origin', str(remote), cwd=initial)
    git('push', 'origin', 'main', cwd=initial)
    credentials, organizer_calls, verified, environment_calls = [], [], [], []
    class Github(provision.GitHub):
        def preflight(self):
            return {'id': REPOSITORY_ID, 'full_name': REPO}
        def api(self, path):
            assert path == 'branches/main'
            return {'commit': {'sha': git('--git-dir', str(remote), 'rev-parse', 'main')}}
        def clone(self, target):
            git('clone', '--branch', 'main', str(remote), str(target))
        def set_deployment_credentials(self, token, public_url):
            credentials.append((token, public_url))
        def deploy(self, state, timeout):
            assert self.api('branches/main')['commit']['sha'] == state.data['commit']
            if failed_stage == 'workflow':
                raise RuntimeError('Controlled workflow failure')
            state.update(run_url='https://github.com/Party-Internal/hackathon-team/actions/runs/1')
    class Railway:
        def __init__(self, token, workspace, region):
            organizer_calls.append((token, workspace, region))
        def provision(self, state, name):
            state.update(project_id='project', environment_id='production',
                         project_token='project-secret', public_url='https://team.up.railway.app')
    monkeypatch.setattr(provision, 'GitHub', Github)
    monkeypatch.setattr(provision, 'Railway', Railway)
    monkeypatch.setattr(provision.shutil, 'which', lambda _: '/test/tool')
    class Environment:
        def inspect(self, state, binding):
            assert state.data['party_org_id'] == binding['org_id'] == ORG_ID
        def configure(self, state, binding, timeout):
            assert verified[-1] == (state.data['public_url'], state.data['commit'])
            environment_calls.append(state.data['commit'])
            state.update(party_environment_complete=True, party_environment_id='seeded-environment',
                         party_profile_id='seeded-profile', party_environment_version='v2',
                         party_environment_build_id='team-build')
    monkeypatch.setattr(provision, 'party_environment_for_org', lambda *args: Environment(), raising=False)
    def verify(url, sha, **_):
        if failed_stage == 'readiness':
            raise RuntimeError('Controlled readiness failure')
        verified.append((url, sha))
    monkeypatch.setitem(sys.modules, 'railway_deploy', SimpleNamespace(
        verify_release=verify))
    args = ['--org-id', ORG_ID, '--source', str(starter)]
    if failed_stage:
        with pytest.raises(RuntimeError, match='Controlled'):
            provision.main(args)
        checkpoint = home / '.local/state/party-conquest/teams' / f'{ORG_ID}.json'
        assert not json.loads(checkpoint.read_text()).get('complete')
        assert not environment_calls
        return
    provision.main(args)
    checkpoint = home / '.local/state/party-conquest/teams' / f'{ORG_ID}.json'
    state = json.loads(checkpoint.read_text())
    commit = git('--git-dir', str(remote), 'rev-parse', 'main')
    provision.main(args)
    assert git('--git-dir', str(remote), 'rev-parse', 'main') == commit
    assert state['party_org_id'] == ORG_ID
    assert state['party_tenant_id'] == TENANT_ID
    assert state['repository_id'] == REPOSITORY_ID
    assert state['repo'] == REPO and state['workspace'] == WORKSPACE_ID
    assert state['complete'] is True
    assert state['party_environment_complete'] is True
    assert environment_calls == [commit] * 2
    assert checkpoint.stat().st_mode & 0o077 == 0
    assert organizer_calls == [(environment_token or 'saved-organizer-secret', WORKSPACE_ID, 'us-west2')] * 2
    assert credentials == [('project-secret', 'https://team.up.railway.app')] * 2
    assert verified == [('https://team.up.railway.app', commit)] * 2
    assert git('--git-dir', str(remote), 'show', 'main:existing-team-data.txt') == 'preserve'
    paths = git('--git-dir', str(remote), 'ls-tree', '-r', '--name-only', 'main').splitlines()
    assert 'conquest/README.md' in paths
    assert '.github/workflows/conquest-railway.yml' in paths
    assert not any('organizer.json' in path for path in paths)
    output = capsys.readouterr().out
    assert 'saved-organizer-secret' not in output
    assert 'environment-organizer-secret' not in output
    assert 'project-secret' not in output


def test_missing_seeded_environment_is_rejected_before_provisioning_paid_resources(
        tmp_path, monkeypatch, starter, resolved_org):
    config = private_config(tmp_path / 'organizer.json', railway_workspace_id=WORKSPACE_ID,
                            railway_api_token='saved-organizer-secret')
    class Github(provision.GitHub):
        def __init__(self, repo):
            pass
        def preflight(self):
            return {'id': REPOSITORY_ID}
    class Environment:
        def inspect(self, state, binding):
            raise ValueError('Expected exactly one seeded conquest Party Environment')
    monkeypatch.setattr(provision, 'GitHub', Github)
    monkeypatch.setattr(provision, 'party_environment_for_org', lambda *args: Environment(), raising=False)
    monkeypatch.setattr(provision, 'Railway', lambda *args: pytest.fail('Missing seed must fail before paid resources'))
    monkeypatch.setattr(provision.shutil, 'which', lambda _: '/test/tool')
    with pytest.raises(ValueError, match='seeded conquest'):
        provision.main(['--org-id', ORG_ID, '--config', str(config), '--source', str(starter),
                        '--state', str(tmp_path / 'private/state.json')])

