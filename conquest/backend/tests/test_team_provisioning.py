import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('party_conquest_provision', Path(__file__).parents[2] / 'scripts/provision_team.py')
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


@pytest.mark.parametrize('repo', ['https://github.com/owner/repo', '../repo', 'owner/repo/extra', '-owner/repo'])
def test_invalid_target_is_rejected(repo):
    with pytest.raises(ValueError, match='OWNER/REPO'):
        provision.validate_repo(repo)


def test_copy_keeps_game_but_not_local_credentials_or_nested_git(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    for name in ['.git/config', '.github/workflows/old.yml', '.local/postgres/data',
                 'backend/.venv/token', 'node_modules/token', '.aws/credentials']:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('private')
    (source / '.env').write_text('private')
    (source / 'README.md').write_text('game')
    (source / 'secret-link').symlink_to(source / '.env')
    target = tmp_path / 'target'
    provision.copy_starter(source, target)
    assert sorted(str(p.relative_to(target)) for p in target.rglob('*') if p.is_file()) == ['README.md']


def test_state_is_private_and_cannot_be_reused_for_a_different_team(tmp_path):
    path = tmp_path / 'state.json'
    state = provision.State(path, 'team/repo', 'workspace')
    state.update(project_token='secret', project_id='project')
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert provision.State(path, 'team/repo', 'workspace').data['project_token'] == 'secret'
    with pytest.raises(ValueError, match='different'):
        provision.State(path, 'other/repo', 'workspace')


def test_state_refuses_a_symlink(tmp_path):
    actual = tmp_path / 'actual'
    actual.write_text('{}')
    link = tmp_path / 'state.json'
    link.symlink_to(actual)
    with pytest.raises(ValueError, match='symlink'):
        provision.State(link, 'team/repo', 'workspace')


def test_project_secret_goes_over_stdin_and_organizer_token_is_not_in_child_env(monkeypatch):
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(args, 0, stdout='')
    monkeypatch.setattr(provision.subprocess, 'run', run, raising=False)
    monkeypatch.setenv('RAILWAY_API_TOKEN', 'organizer-secret')
    monkeypatch.setenv('RAILWAY_TOKEN', 'unrelated-project-secret')
    provision.GitHub('team/repo').set_deployment_credentials('project-secret', 'https://team.up.railway.app')
    secret_command, options = calls[0]
    assert secret_command == ['gh', 'secret', 'set', 'RAILWAY_TOKEN', '--repo', 'team/repo']
    assert options['input'] == 'project-secret'
    assert 'project-secret' not in ' '.join(secret_command)
    assert 'RAILWAY_API_TOKEN' not in options['env']
    assert 'RAILWAY_TOKEN' not in options['env']


def test_failed_process_does_not_echo_credential_bearing_output(monkeypatch):
    monkeypatch.setattr(provision.subprocess, 'run', lambda args, **kwargs: subprocess.CompletedProcess(args, 1, stdout='leaked-secret', stderr='leaked-secret'), raising=False)
    with pytest.raises(RuntimeError, match='gh secret failed') as error:
        provision.run_process(['gh', 'secret', 'set', 'RAILWAY_TOKEN'], input='secret')
    assert 'leaked-secret' not in str(error.value)


def test_lost_push_response_is_reconciled_without_overwriting_team_source(tmp_path):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(pending_commit='a' * 40, base_commit='b' * 40)
    class Remote:
        def api(self, path):
            return {'commit': {'sha': 'a' * 40}}
    provision.reconcile_commit(Remote(), state)
    assert state.data['commit'] == 'a' * 40


def test_different_workflow_is_rejected_before_paid_resources_are_created(tmp_path):
    source = tmp_path / 'source'
    checkout = tmp_path / 'checkout'
    (source / 'deploy/github').mkdir(parents=True)
    (source / 'deploy/github/railway.yml').write_text('our workflow')
    (checkout / '.github/workflows').mkdir(parents=True)
    (checkout / '.github/workflows/conquest-railway.yml').write_text('team workflow')
    with pytest.raises(ValueError, match='different'):
        provision.check_repository(source, checkout, replace=False)


def test_initial_workflow_dispatch_is_identifiable_and_not_repeated_on_resume(tmp_path, monkeypatch):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(commit='a' * 40)
    calls, runs = [], []
    github = provision.GitHub('team/repo')
    def api(path):
        if path == 'branches/main':
            return {'commit': {'sha': 'a' * 40}}
        if '/runs?' in path:
            return {'workflow_runs': runs}
        return {'id': 1}
    def dispatch(command, **kwargs):
        calls.append(command)
        runs.append({'id': 7, 'display_title': f'Conquest deploy {state.data["provisioning_id"]}',
                     'head_sha': 'a' * 40, 'status': 'completed', 'conclusion': 'success',
                     'html_url': 'https://github.com/team/repo/actions/runs/7'})
    monkeypatch.setattr(github, 'api', api)
    monkeypatch.setattr(provision, 'run_process', dispatch)
    github.deploy(state, 10)
    github.deploy(state, 10)
    assert len(calls) == 1
    assert 'expected_revision=' + 'a' * 40 in calls[0]
    assert 'provisioning_id=' + state.data['provisioning_id'] in calls[0]


def test_workflow_failure_is_reported_with_link_and_never_called_success(tmp_path, monkeypatch):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(commit='a' * 40, dispatch_requested=True)
    github = provision.GitHub('team/repo')
    run = {'id': 7, 'display_title': f'Conquest deploy {state.data["provisioning_id"]}',
           'head_sha': 'a' * 40, 'status': 'completed', 'conclusion': 'failure',
           'html_url': 'https://github.com/team/repo/actions/runs/7'}
    def api(path):
        if path == 'branches/main':
            return {'commit': {'sha': 'a' * 40}}
        if '/runs?' in path:
            return {'workflow_runs': [run]}
        return {'id': 1}
    monkeypatch.setattr(github, 'api', api)
    with pytest.raises(RuntimeError, match='failure: https://github.com/team/repo/actions/runs/7'):
        github.deploy(state, 10)
    assert not state.data.get('complete')


def test_full_handoff_publishes_only_conquest_and_root_workflow_to_a_real_git_repo(tmp_path, monkeypatch):
    def git(*args, cwd=None):
        return subprocess.run(['git', *args], cwd=cwd, text=True, check=True, capture_output=True).stdout.strip()
    remote = tmp_path / 'remote.git'
    initial = tmp_path / 'initial'
    git('init', '--bare', str(remote))
    git('init', '--initial-branch=main', str(initial))
    git('config', 'user.name', 'Test Organizer', cwd=initial)
    git('config', 'user.email', 'test@example.invalid', cwd=initial)
    (initial / 'existing.txt').write_text('keep team data')
    git('add', '.', cwd=initial)
    git('commit', '-m', 'initial', cwd=initial)
    git('remote', 'add', 'origin', str(remote), cwd=initial)
    git('push', 'origin', 'main', cwd=initial)
    source = tmp_path / 'starter'
    for name in ['README.md', 'backend/Dockerfile', 'deploy/Dockerfile.frontend', 'scripts/railway_deploy.py']:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('starter')
    template = source / 'deploy/github/railway.yml'
    template.parent.mkdir(parents=True, exist_ok=True)
    template.write_text((Path(__file__).parents[2] / 'deploy/github/railway.yml').read_text())
    (source / '.env').write_text('never publish')
    handoffs = []
    class Github(provision.GitHub):
        def preflight(self):
            pass
        def api(self, path):
            assert path == 'branches/main'
            return {'commit': {'sha': git('--git-dir', str(remote), 'rev-parse', 'main')}}
        def clone(self, target):
            git('clone', '--branch', 'main', str(remote), str(target))
        def set_deployment_credentials(self, token, public_url):
            handoffs.append((token, public_url))
        def deploy(self, state, timeout):
            assert self.api('branches/main')['commit']['sha'] == state.data['commit']
            state.update(run_url='https://github.com/team/repo/actions/runs/1')
    class Railway:
        def __init__(self, token, workspace, region):
            assert token == 'organizer-secret'
        def provision(self, state, name):
            state.update(project_id='project', environment_id='production',
                         project_token='project-secret', public_url='https://team.up.railway.app')
    verified = []
    monkeypatch.setattr(provision, 'GitHub', Github)
    monkeypatch.setattr(provision, 'Railway', Railway)
    monkeypatch.setenv('RAILWAY_API_TOKEN', 'organizer-secret')
    monkeypatch.setattr(provision.shutil, 'which', lambda _: '/test/tool')
    monkeypatch.setitem(sys.modules, 'railway_deploy', SimpleNamespace(
        verify_release=lambda url, sha, **_: verified.append((url, sha))))
    state = tmp_path / 'private/state.json'
    args = ['--repo', 'team/repo', '--workspace-id', 'workspace', '--state', str(state), '--source', str(source)]
    provision.main(args)
    commit = git('--git-dir', str(remote), 'rev-parse', 'main')
    provision.main(args)
    assert git('--git-dir', str(remote), 'rev-parse', 'main') == commit
    paths = git('--git-dir', str(remote), 'ls-tree', '-r', '--name-only', 'main').splitlines()
    assert 'existing.txt' in paths
    assert '.github/workflows/conquest-railway.yml' in paths
    assert 'conquest/.env' not in paths
    assert git('--git-dir', str(remote), 'show', 'main:existing.txt') == 'keep team data'
    assert 'https://team.up.railway.app' in git('--git-dir', str(remote), 'show', 'main:conquest/README.md')
    assert '[skip ci]' in git('--git-dir', str(remote), 'log', '-1', '--format=%s', 'main')
    assert handoffs == [('project-secret', 'https://team.up.railway.app')] * 2
    assert verified == [('https://team.up.railway.app', commit)] * 2


@pytest.mark.parametrize('allow', [False, True])
def test_protected_repo_requires_explicit_bootstrap_permission(monkeypatch, allow):
    github = provision.GitHub('team/repo')
    monkeypatch.setattr(github, 'api', lambda path: {'enabled': True})
    def process(args, **kwargs):
        return json.dumps({'default_branch': 'main', 'permissions': {'push': True, 'admin': True}})
    monkeypatch.setattr(provision, 'run_process', process)
    monkeypatch.setattr(github, 'api', lambda path: {'protected': True} if path == 'branches/main' else {'enabled': True})
    github.allow_protected_bootstrap = allow
    if allow:
        github.preflight()
    else:
        with pytest.raises(ValueError, match='allow-protected-bootstrap'):
            github.preflight()


@pytest.mark.parametrize('merge_fails', [False, True])
def test_protected_setup_restores_admin_enforcement_on_success_or_failure(tmp_path, monkeypatch, merge_fails):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(setup_pr_url='https://github.com/team/repo/pull/1', setup_pr_head='a' * 40)
    github = provision.GitHub('team/repo')
    github.allow_protected_bootstrap = True
    enabled = True
    def api(path):
        if path.endswith('enforce_admins'):
            return {'enabled': enabled}
        return {'state': 'MERGED', 'mergeCommit': {'oid': 'b' * 40}}
    monkeypatch.setattr(github, 'api', api)
    def process(args, **kwargs):
        nonlocal enabled
        if args[:3] == ['gh', 'api', '--method']:
            enabled = args[3] == 'POST'
            return ''
        if args[:3] == ['gh', 'pr', 'merge'] and merge_fails:
            raise RuntimeError('merge rejected')
        if args[:3] == ['gh', 'pr', 'view']:
            return json.dumps({'state': 'MERGED', 'mergeCommit': {'oid': 'b' * 40}})
        return ''
    monkeypatch.setattr(provision, 'run_process', process)
    if merge_fails:
        with pytest.raises(RuntimeError, match='merge rejected'):
            github.merge_setup_pr(state)
        assert not state.data.get('commit')
    else:
        github.merge_setup_pr(state)
        assert state.data['commit'] == 'b' * 40
    assert enabled is True
    assert state.data['admin_restore_required'] is False


def test_interrupted_bootstrap_restores_protection_before_reconciling(tmp_path, monkeypatch):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(admin_restore_required=True)
    github = provision.GitHub('team/repo')
    operations = []
    monkeypatch.setattr(provision, 'run_process', lambda args, **kwargs: operations.append(args) or '')
    monkeypatch.setattr(github, 'api', lambda path: {'enabled': True})
    github.restore_admin_protection(state)
    assert operations[0][3] == 'POST'
    assert state.data['admin_restore_required'] is False


def test_setup_branch_and_pr_are_reused_after_lost_response(tmp_path, monkeypatch):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(setup_pr_head='a' * 40, pending_commit='b' * 40)
    github = provision.GitHub('team/repo')
    github.protected = True
    calls = []
    def process(args, **kwargs):
        calls.append(args)
        if args[:2] == ['git', 'ls-remote']:
            return 'a' * 40 + '\trefs/heads/setup'
        if args[:3] == ['gh', 'pr', 'list']:
            return json.dumps([{'url': 'https://github.com/team/repo/pull/1'}])
        pytest.fail('Lost branch/PR response must not cause another push or PR creation')
    monkeypatch.setattr(provision, 'run_process', process)
    monkeypatch.setattr(github, 'merge_setup_pr', lambda checkpoint: checkpoint.update(commit='c' * 40))
    github.publish(state, tmp_path)
    assert state.data['setup_pr_head'] == 'a' * 40
    assert state.data['commit'] == 'c' * 40
    assert not any(args[:2] == ['git', 'push'] for args in calls)


def test_failed_protection_restore_keeps_recovery_intent(tmp_path, monkeypatch):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(admin_restore_required=True)
    github = provision.GitHub('team/repo')
    monkeypatch.setattr(provision, 'run_process', lambda *args, **kwargs: '')
    monkeypatch.setattr(github, 'api', lambda path: {'enabled': False})
    with pytest.raises(RuntimeError, match='restored admin'):
        github.restore_admin_protection(state)
    assert provision.State(tmp_path / 'state.json', 'team/repo', 'workspace').data['admin_restore_required'] is True


def test_resumed_merged_setup_records_the_squash_commit_without_another_bypass(tmp_path, monkeypatch):
    state = provision.State(tmp_path / 'state.json', 'team/repo', 'workspace')
    state.update(setup_pr_url='https://github.com/team/repo/pull/1', setup_pr_head='a' * 40)
    github = provision.GitHub('team/repo')
    monkeypatch.setattr(github, 'setup_pr', lambda checkpoint: {
        'state': 'MERGED', 'headRefOid': 'a' * 40, 'mergeCommit': {'oid': 'b' * 40}})
    monkeypatch.setattr(github, 'merge_setup_pr', lambda checkpoint: pytest.fail('Do not merge twice'))
    github.recover_setup(state)
    assert state.data['commit'] == 'b' * 40
