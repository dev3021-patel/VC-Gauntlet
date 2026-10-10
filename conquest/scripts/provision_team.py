#!/usr/bin/env python3
"""Organizer entry point: provision Railway and publish /conquest to a team repo.

Uses Python's standard library and authenticated GitHub CLI. Credentials are
passed through environment/stdin, never command arguments or source files.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
API = 'https://backboard.railway.com/graphql/v2'
WORKFLOW = 'conquest-railway.yml'
EXCLUDED = ('.git', '.github', '.aws', '.ssh', '.codex', '.env*', '.venv', '.local',
            '.vercel', 'node_modules', 'dist', '__pycache__', '*.pyc', '.pytest_cache',
            'coverage', '.DS_Store')


def validate_repo(repo):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9_][A-Za-z0-9_.-]*', repo):
        raise ValueError('Use a GitHub OWNER/REPO target, not a URL or path')
    return repo


def read_organizer_config(path):
    """Load operator credentials from a private file outside the starter."""
    path = Path(path).expanduser()
    if path.is_symlink():
        raise ValueError('Organizer config must not be a symlink')
    if path.resolve().is_relative_to(ROOT):
        raise ValueError('Keep the organizer config outside the Conquest source directory')
    if path.exists() and any((parent / '.git').exists() for parent in path.resolve().parents):
        raise ValueError('Keep the organizer config outside Git repositories')
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return {}
    except OSError:
        raise ValueError('Could not read the private organizer config') from None
    with os.fdopen(descriptor) as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
            raise ValueError('Organizer config contains credentials; set its permissions to 0600')
        try:
            values = json.load(stream)
        except (ValueError, UnicodeError):
            raise ValueError('Organizer config must contain valid JSON') from None
    if not isinstance(values, dict):
        raise ValueError('Organizer config must be a JSON object')
    for key in ('railway_workspace_id', 'railway_api_token', 'party_kube_context',
                'party_namespace', 'party_deployment', 'party_cli_source', 'party_api_url'):
        if key in values and not isinstance(values[key], str):
            raise ValueError('Organizer config has invalid settings')
    if 'party_api_url' in values:
        from party_environment import validate_api_origin
        values['party_api_url'] = validate_api_origin(values['party_api_url'])
    return values


def lookup_party_org(org_id, config):
    from party_org_repository import resolve_org
    overrides = {argument: config[key] for key, argument in (
        ('party_kube_context', 'context'), ('party_namespace', 'namespace'),
        ('party_deployment', 'deployment')) if config.get(key)}
    return resolve_org(org_id, **overrides)


def party_environment_for_org(binding, config):
    from party_environment import PartyEnvironment, signed_in_client
    return PartyEnvironment(signed_in_client(binding, cli_source=config.get('party_cli_source'),
                                             api_url=config.get('party_api_url')))


def ignore_local(directory, names):
    ignored = set(shutil.ignore_patterns(*EXCLUDED)(directory, names))
    return ignored | {name for name in names if (Path(directory) / name).is_symlink()}


def copy_starter(source, target):
    shutil.copytree(source, target, ignore=ignore_local)


def fingerprint(source):
    digest = hashlib.sha256()
    for directory, folders, files in os.walk(source):
        ignored = ignore_local(directory, folders + files)
        folders[:] = sorted(name for name in folders if name not in ignored)
        for name in sorted(set(files) - ignored):
            path = Path(directory) / name
            digest.update(str(path.relative_to(source)).encode() + b'\0')
            digest.update(path.read_bytes())
    return digest.hexdigest()


def run_process(args, *, input=None, cwd=None):
    env = {key: value for key, value in os.environ.items()
           if key not in ('RAILWAY_API_TOKEN', 'RAILWAY_TOKEN')}
    result = subprocess.run(args, input=input, text=True, capture_output=True,
                            cwd=cwd, env=env)
    if result.returncode:
        # External responses can echo credentials: do not include their bytes.
        raise RuntimeError(f'{args[0]} {args[1] if len(args) > 1 else ""} failed '
                           f'(exit {result.returncode}); check authentication, permissions, '
                           'branch protection, or the linked workflow logs')
    return result.stdout.strip()


class State:
    def __init__(self, path, repo, workspace):
        self.path = Path(path)
        if self.path.is_symlink():
            raise ValueError('State must not be a symlink')
        if self.path.exists():
            if self.path.stat().st_mode & 0o077:
                raise ValueError('State contains secrets; set its permissions to 0600')
            self.data = json.loads(self.path.read_text())
            if (self.data.get('repo'), self.data.get('workspace')) != (repo, workspace):
                raise ValueError('State belongs to a different repository or workspace')
        else:
            self.data = {'repo': repo, 'workspace': workspace,
                         'provisioning_id': str(uuid.uuid4())}

    def update(self, **values):
        self.data.update(values)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix='.party-state-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(self.data, stream, indent=2)
                stream.write('\n')
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class GitHub:
    def __init__(self, repo):
        self.repo = validate_repo(repo)
        self.allow_protected_bootstrap = False
        self.protected = False
        self.already_published = False

    def api(self, path):
        return json.loads(run_process(['gh', 'api', f'repos/{self.repo}/{path}']))

    def preflight(self):
        repo = json.loads(run_process(['gh', 'api', f'repos/{self.repo}']))
        if repo['default_branch'] != 'main':
            raise ValueError('The target repository must have main as its default branch')
        if repo.get('archived') or not repo.get('permissions', {}).get('push'):
            raise ValueError('The target repository must be writable and unarchived')
        self.protected = bool(self.api('branches/main').get('protected'))
        if self.protected and not self.already_published:
            if not self.allow_protected_bootstrap:
                raise ValueError('main is protected; initial setup requires explicit '
                                 '--allow-protected-bootstrap permission for a one-time admin bypass')
            if not repo.get('permissions', {}).get('admin'):
                raise ValueError('Protected repository bootstrap requires GitHub admin access')
            # Require readable classic protection before creating paid resources.
            self.api('branches/main/protection/enforce_admins')
        if not self.api('actions/permissions').get('enabled'):
            raise ValueError('GitHub Actions is disabled for the target repository')
        # Read access does not prove write permissions; actual writes are checked later.
        self.api('actions/secrets')
        self.api('actions/variables')
        return repo

    def set_deployment_credentials(self, token, public_url):
        run_process(['gh', 'secret', 'set', 'RAILWAY_TOKEN', '--repo', self.repo], input=token)
        run_process(['gh', 'variable', 'set', 'RAILWAY_PUBLIC_URL', '--repo', self.repo], input=public_url)

    def clone(self, target):
        run_process(['gh', 'repo', 'clone', self.repo, str(target), '--',
                     '--branch', 'main', '--single-branch'])

    def restore_admin_protection(self, state):
        if state.data.get('admin_restore_required'):
            run_process(['gh', 'api', '--method', 'POST',
                         f'repos/{self.repo}/branches/main/protection/enforce_admins'])
            if not self.api('branches/main/protection/enforce_admins').get('enabled'):
                raise RuntimeError('Unable to confirm restored admin branch protection; restore it before proceeding')
            state.update(admin_restore_required=False)

    def setup_pr(self, state):
        return json.loads(run_process(['gh', 'pr', 'view', state.data['setup_pr_url'],
                                      '--json', 'state,headRefOid,mergeCommit']))

    def merge_setup_pr(self, state):
        if not self.allow_protected_bootstrap:
            raise ValueError('Merging setup requires --allow-protected-bootstrap')
        protection = self.api('branches/main/protection/enforce_admins')
        try:
            if protection.get('enabled'):
                # Persist recovery intent before opening even a brief bypass window.
                state.update(admin_restore_required=True)
                run_process(['gh', 'api', '--method', 'DELETE',
                             f'repos/{self.repo}/branches/main/protection/enforce_admins'])
            run_process(['gh', 'pr', 'merge', state.data['setup_pr_url'], '--squash',
                         '--admin', '--match-head-commit', state.data['setup_pr_head'],
                         '--subject', 'Seed Conquest and Railway deployment [skip ci]'])
        finally:
            self.restore_admin_protection(state)
        pr = self.setup_pr(state)
        if pr['state'] != 'MERGED' or not pr.get('mergeCommit', {}).get('oid'):
            raise RuntimeError('Setup pull request did not merge')
        state.update(commit=pr['mergeCommit']['oid'])

    def recover_setup(self, state):
        self.restore_admin_protection(state)
        if state.data.get('setup_pr_url') and not state.data.get('commit'):
            pr = self.setup_pr(state)
            if pr['headRefOid'] != state.data['setup_pr_head']:
                raise RuntimeError('Setup pull request changed; refusing an unexpected commit')
            if pr['state'] == 'MERGED':
                state.update(commit=pr['mergeCommit']['oid'])
            elif pr['state'] == 'OPEN':
                self.merge_setup_pr(state)
            else:
                raise RuntimeError('Setup pull request was closed without merging')

    def publish(self, state, checkout):
        if not self.protected:
            run_process(['git', 'push', 'origin', 'HEAD:main'], cwd=checkout)
            state.update(commit=state.data['pending_commit'])
            return
        branch = 'codex/conquest-setup-' + state.data['provisioning_id']
        remote = run_process(['git', 'ls-remote', 'origin', f'refs/heads/{branch}'], cwd=checkout)
        if remote:
            head = remote.split()[0]
            if head != state.data.get('setup_pr_head'):
                raise RuntimeError('Setup branch changed; refusing to overwrite it')
        else:
            head = state.data['pending_commit']
            state.update(setup_pr_head=head)
            run_process(['git', 'push', 'origin', f'HEAD:refs/heads/{branch}'], cwd=checkout)
        # Search the unique branch before creating a PR to recover lost responses.
        prs = json.loads(run_process(['gh', 'pr', 'list', '--repo', self.repo,
            '--head', branch, '--base', 'main', '--state', 'all', '--json', 'url']))
        if len(prs) > 1:
            raise RuntimeError('Multiple setup pull requests found; reconcile before proceeding')
        if prs:
            url = prs[0]['url']
        else:
            url = run_process(['gh', 'pr', 'create', '--repo', self.repo, '--base', 'main',
                '--head', branch, '--title', 'Seed Conquest and Railway deployment',
                '--body', 'Seed /conquest and its Railway deployment workflow. The project token is stored only in the repository Actions secret.'])
        state.update(setup_pr_url=url, setup_pr_head=head)
        print(f'Setup pull request: {url}', flush=True)
        self.merge_setup_pr(state)

    def find_run(self, identifier, revision):
        title = f'Conquest deploy {identifier}'
        runs = self.api(f'actions/workflows/{WORKFLOW}/runs?event=workflow_dispatch&per_page=100')['workflow_runs']
        run = next((run for run in runs if run['display_title'] == title), None)
        if run and run['head_sha'] != revision:
            raise RuntimeError(f'main moved before dispatch. The workflow revision guard rejected '
                               f'the unexpected release; inspect {run["html_url"]}')
        return run

    def deploy(self, state, timeout):
        revision = state.data['commit']
        identifier = state.data['provisioning_id']
        current = self.api('branches/main')['commit']['sha']
        if current != revision:
            raise RuntimeError('main changed after provisioning; refusing to deploy a different commit')
        # New workflows can take a short time to be registered after the push.
        deadline = time.monotonic() + timeout
        while True:
            try:
                self.api(f'actions/workflows/{WORKFLOW}')
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(5)
        run = self.find_run(identifier, revision)
        if not run and not state.data.get('dispatch_requested'):
            # Record the intent first. On ambiguous failures, rerun searches for
            # this unique title rather than automatically submitting a duplicate.
            state.update(dispatch_requested=True)
            run_process(['gh', 'workflow', 'run', WORKFLOW, '--repo', self.repo,
                         '--ref', 'main', '-f', f'provisioning_id={identifier}',
                         '-f', f'expected_revision={revision}'])
        print('Waiting for the initial GitHub Actions deployment...', flush=True)
        while time.monotonic() < deadline:
            run = self.find_run(identifier, revision)
            if run:
                state.update(run_id=run['id'], run_url=run['html_url'])
                if run['status'] == 'completed':
                    if run['conclusion'] != 'success':
                        raise RuntimeError(f'Deployment workflow {run["conclusion"]}: {run["html_url"]}')
                    return run
            time.sleep(10)
        raise RuntimeError('Workflow did not finish within the timeout. Resume with the same state; '
                           'if dispatch failed before acceptance, inspect Actions before clearing '
                           'dispatch_requested in the private state file')


class Railway:
    def __init__(self, token, workspace, region):
        self.token, self.workspace, self.region = token, workspace, region

    def query(self, query, variables=None):
        request = urllib.request.Request(API, data=json.dumps({'query': query, 'variables': variables or {}}).encode(),
            headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {self.token}',
                     'User-Agent': 'party-conquest-provisioner/1.0'})
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = json.load(response)
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            raise RuntimeError('Railway API request failed; inspect your credentials and network. '
                               'An interrupted mutation may have succeeded; resume using the same state.') from None
        if payload.get('errors') or not payload.get('data'):
            raise RuntimeError('Railway rejected an API operation; verify workspace access and API schema')
        return payload['data']

    def inventory(self, project, environment):
        return self.query('''query($project:String!,$environment:String!){
          project(id:$project){id workspaceId services(first:100){edges{node{id name}}}}
          environment(id:$environment,projectId:$project){
            volumeInstances(first:100){edges{node{volumeId serviceId mountPath region}}}
            serviceInstances(first:100){edges{node{serviceId latestDeployment{id status} domains{serviceDomains{id domain targetPort}}}}}
          }}''', {'project': project, 'environment': environment})

    def find_project(self, name):
        matches, after = [], None
        while True:
            page = self.query('''query($workspace:String!,$after:String){workspace(workspaceId:$workspace){
              projects(first:100,after:$after){pageInfo{hasNextPage endCursor}
                edges{node{id name environments(first:100){edges{node{id name}}}}}}}}''',
              {'workspace': self.workspace, 'after': after})['workspace']['projects']
            matches.extend(entry['node'] for entry in page['edges'] if entry['node']['name'] == name)
            if not page['pageInfo']['hasNextPage']:
                break
            after = page['pageInfo']['endCursor']
            if not after:
                raise RuntimeError('Railway returned an incomplete project inventory')
        if len(matches) > 1:
            raise RuntimeError('Multiple Railway projects match this checkpoint; inspect before proceeding')
        return matches[0] if matches else None

    def wait_database(self, state, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            inventory = self.inventory(state.data['project_id'], state.data['environment_id'])
            deployments = [edge['node']['latestDeployment'] for edge in inventory['environment']['serviceInstances']['edges']
                           if edge['node']['serviceId'] == state.data['services']['Postgres']]
            deployment = deployments[0] if deployments else None
            if deployment and deployment['status'] == 'SUCCESS':
                return
            if deployment and deployment['status'] in ('FAILED', 'CRASHED', 'REMOVED', 'SKIPPED', 'NEEDS_APPROVAL'):
                state.update(database_deploy_requested=False)
                raise RuntimeError('Postgres deployment failed. Inspect Railway logs, then resume with the same checkpoint')
            time.sleep(5)
        raise RuntimeError('Postgres deployment did not start successfully in time; resume with the same checkpoint')

    def provision(self, state, project_name):
        # Persist the unique identity before any create can succeed remotely.
        state.update()
        data = state.data
        if not data.get('project_id'):
            # This unique, persisted name permits recovery if projectCreate's
            # response is lost after Railway accepts it.
            # Railway enforces 32 characters, including our recovery suffix.
            name = f'{project_name[:23]}-{data["provisioning_id"][:8]}'
            project = self.find_project(name) or self.query('''mutation($input:ProjectCreateInput!){
              projectCreate(input:$input){id name environments(first:100){edges{node{id name}}}}}''',
              {'input': {'name': name, 'workspaceId': self.workspace,
                         'defaultEnvironmentName': 'production', 'isPublic': False}})['projectCreate']
            environments = [e['node'] for e in project['environments']['edges'] if e['node']['name'] == 'production']
            if len(environments) != 1:
                raise RuntimeError('Expected exactly one production environment')
            state.update(project_id=project['id'], environment_id=environments[0]['id'])
        project, environment = data['project_id'], data['environment_id']
        inventory = self.inventory(project, environment)
        if inventory['project']['workspaceId'] != self.workspace:
            raise ValueError('Checkpoint project belongs to a different Railway workspace')
        entries = [edge['node'] for edge in inventory['project']['services']['edges']]
        for name in ('Postgres', 'backend', 'frontend'):
            if sum(entry['name'] == name for entry in entries) > 1:
                raise RuntimeError(f'Multiple {name} services exist; refusing an ambiguous target')
        services = {entry['name']: entry['id'] for entry in entries}
        for name in ('Postgres', 'backend', 'frontend'):
            if name not in services:
                services[name] = self.query('''mutation($input:ServiceCreateInput!){serviceCreate(input:$input){id}}''',
                  {'input': {'projectId': project, 'environmentId': environment, 'name': name}})['serviceCreate']['id']
            state.update(services=services)
        database = services['Postgres']
        volumes = [e['node'] for e in inventory['environment']['volumeInstances']['edges'] if e['node']['serviceId'] == database]
        if volumes and (len(volumes) != 1 or volumes[0]['mountPath'] != '/var/lib/postgresql/data'
                        or volumes[0]['region'] != self.region):
            raise RuntimeError('Unexpected Postgres volume configuration; refusing to change existing storage')
        if not volumes:
            self.query('''mutation($input:VolumeCreateInput!){volumeCreate(input:$input){id}}''',
              {'input': {'projectId': project, 'environmentId': environment, 'serviceId': database,
                         'mountPath': '/var/lib/postgresql/data', 'region': self.region}})
        if not data.get('database_password'):
            state.update(database_password=secrets.token_hex(32))
        variables = {
          'Postgres': {'POSTGRES_DB': 'railway', 'POSTGRES_USER': 'postgres',
            'POSTGRES_PASSWORD': data['database_password'], 'PGDATA': '/var/lib/postgresql/data/pgdata',
            'PGDATABASE': '${{POSTGRES_DB}}', 'PGHOST': '${{RAILWAY_PRIVATE_DOMAIN}}',
            'PGPASSWORD': '${{POSTGRES_PASSWORD}}', 'PGPORT': '5432', 'PGUSER': '${{POSTGRES_USER}}',
            'DATABASE_URL': 'postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}',
            'SSL_CERT_DAYS': '820', 'RAILWAY_DEPLOYMENT_DRAINING_SECONDS': '60'},
          'backend': {'DATABASE_URL': '${{Postgres.DATABASE_URL}}', 'DB_SCHEMA': 'party_conquest',
            'PORT': '8000', 'APP_ENV': 'production', 'WORLD_OWNERSHIP': 'shared'},
          'frontend': {'PORT': '8080', 'BACKEND_UPSTREAM': 'http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:8000'},
        }
        for name, values in variables.items():
            self.query('''mutation($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}''',
              {'input': {'projectId': project, 'environmentId': environment, 'serviceId': services[name],
                         'variables': values, 'replace': False, 'skipDeploys': True}})
            settings = {'sleepApplication': False, 'numReplicas': 1, 'region': self.region}
            if name == 'Postgres':
                settings['source'] = {'image': 'ghcr.io/railwayapp-templates/postgres-ssl:18'}
            elif name == 'backend':
                settings.update(dockerfilePath='Dockerfile', preDeployCommand=['python -m app.migrate'],
                  startCommand="hypercorn app.main:app --bind '[::]:8000'", healthcheckPath='/readyz', healthcheckTimeout=120)
            else:
                settings.update(dockerfilePath='deploy/Dockerfile.frontend', healthcheckPath='/api/readyz', healthcheckTimeout=120)
            self.query('''mutation($service:String!,$environment:String!,$input:ServiceInstanceUpdateInput!){
              serviceInstanceUpdate(serviceId:$service,environmentId:$environment,input:$input)}''',
              {'service': services[name], 'environment': environment, 'input': settings})
        if not data.get('database_deploy_requested'):
            deployment_id = self.query('''mutation($service:String!,$environment:String!){
              serviceInstanceDeployV2(serviceId:$service,environmentId:$environment)}''',
              {'service': database, 'environment': environment})['serviceInstanceDeployV2']
            state.update(database_deploy_requested=True, database_deployment_id=deployment_id)
        self.wait_database(state)
        inventory = self.inventory(project, environment)
        domains = [domain for e in inventory['environment']['serviceInstances']['edges']
                   if e['node']['serviceId'] == services['frontend']
                   for domain in e['node']['domains']['serviceDomains']]
        if domains and (len(domains) != 1 or domains[0]['targetPort'] != 8080):
            raise RuntimeError('Unexpected frontend domain configuration; inspect before proceeding')
        domain = domains[0] if domains else self.query('''mutation($input:ServiceDomainCreateInput!){
          serviceDomainCreate(input:$input){id domain targetPort}}''',
          {'input': {'serviceId': services['frontend'], 'environmentId': environment, 'targetPort': 8080}})['serviceDomainCreate']
        state.update(public_url=f'https://{domain["domain"]}')
        if not data.get('project_token'):
            if data.get('token_request_pending'):
                raise RuntimeError('Token creation response was lost. Recover or revoke that token in Railway '
                                   'before clearing token_request_pending in the private checkpoint.')
            state.update(token_request_pending=True)
            token = self.query('''mutation($input:ProjectTokenCreateInput!){projectTokenCreate(input:$input)}''',
              {'input': {'projectId': project, 'environmentId': environment,
                         'name': f'party-conquest-{data["provisioning_id"][:8]}'}})['projectTokenCreate']
            if not token:
                raise RuntimeError('Railway did not return a project token')
            state.update(project_token=token, token_request_pending=False)


def reconcile_commit(github, state):
    if state.data.get('pending_commit') and not state.data.get('commit'):
        current = github.api('branches/main')['commit']['sha']
        if current == state.data['pending_commit']:
            state.update(commit=current)
        elif current != state.data['base_commit']:
            raise RuntimeError('main changed during an interrupted push; inspect the checkpoint before resuming')


def check_repository(source, checkout, *, replace=False):
    target = checkout / 'conquest'
    workflow = checkout / '.github/workflows' / WORKFLOW
    template = (source / 'deploy/github/railway.yml').read_text()
    if target.exists():
        if not replace:
            raise ValueError('/conquest already exists; use --replace-conquest only to replace this starter deliberately')
        if target.is_symlink():
            raise ValueError('/conquest must not be a symlink')
    if workflow.exists() and workflow.read_text() != template:
        raise ValueError('A different conquest-railway.yml already exists; refusing to overwrite it')
    if workflow.is_symlink() or workflow.parent.is_symlink() or (checkout / '.github').is_symlink():
        raise ValueError('GitHub workflow directories must not be symlinks')


def install_repository(source, checkout, public_url, *, replace=False):
    check_repository(source, checkout, replace=replace)
    target = checkout / 'conquest'
    workflow = checkout / '.github/workflows' / WORKFLOW
    if target.exists():
        shutil.rmtree(target)
    copy_starter(source, target)
    with (target / 'README.md').open('a') as stream:
        stream.write(f'\n## Your team\'s published game\n\n[Play Conquest]({public_url})\n')
    workflow.parent.mkdir(parents=True, exist_ok=True)
    workflow.write_text((source / 'deploy/github/railway.yml').read_text())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--org-id', help='Party organization UUID; resolve its ready managed repository')
    target.add_argument('--repo', help='Explicit GitHub OWNER/REPO instead of Party organization lookup')
    parser.add_argument('--config', type=Path, help='Private organizer config; default ~/.config/party-conquest/organizer.json')
    parser.add_argument('--workspace-id', help='Override the saved organizer Railway workspace ID')
    parser.add_argument('--state', type=Path, help='Override the private per-team resumable checkpoint')
    parser.add_argument('--source', type=Path, default=ROOT, help='Prepared local Conquest starter')
    parser.add_argument('--region', default='us-west2')
    parser.add_argument('--allow-protected-bootstrap', action='store_true',
                        help='Authorize a one-time admin bypass to merge the initial setup PR; restore protection immediately')
    parser.add_argument('--replace-conquest', action='store_true', help='Explicitly replace an existing /conquest starter')
    parser.add_argument('--timeout', type=int, default=1800, help='Seconds to wait for GitHub deployment')
    parser.add_argument('--dry-run', action='store_true', help='Print plan without writes or provisioning; org mode reads the Party binding')
    args = parser.parse_args(argv)
    if args.org_id:
        try:
            args.org_id = str(uuid.UUID(args.org_id))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Party organization ID must be a UUID') from None
    if args.timeout < 1:
        raise ValueError('--timeout must be positive')
    config_path = args.config or Path(os.environ.get('PARTY_CONQUEST_CONFIG') or
                                     Path.home() / '.config/party-conquest/organizer.json')
    config = read_organizer_config(config_path)
    args.workspace_id = (args.workspace_id or os.environ.get('RAILWAY_WORKSPACE_ID', '').strip()
                         or config.get('railway_workspace_id', '').strip())
    if not args.workspace_id:
        raise ValueError('Configure railway_workspace_id in the organizer config or pass --workspace-id')
    source = args.source.resolve()
    if Path(config_path).expanduser().resolve().is_relative_to(source):
        raise ValueError('Keep the organizer config outside the Conquest source directory')
    for required in ('README.md', 'backend/Dockerfile', 'deploy/Dockerfile.frontend',
                     'deploy/github/railway.yml', 'scripts/railway_deploy.py'):
        if not (source / required).is_file():
            raise ValueError(f'Starter is missing {required}')
    binding = lookup_party_org(args.org_id, config) if args.org_id else None
    if binding:
        args.repo = binding['repo']
    validate_repo(args.repo)
    if args.state is None:
        args.state = (Path.home() / '.local/state/party-conquest/teams' / f'{args.org_id}.json'
                      if args.org_id else Path.home() / '.local/state/party-conquest/repos' /
                      args.repo.split('/')[0] / f'{args.repo.split("/")[1]}.json')
    args.state = args.state.expanduser()
    if args.state.resolve().is_relative_to(source):
        raise ValueError('Keep the private state outside the Conquest source directory')
    source_hash = fingerprint(source)
    identity = ({'party_org_id': binding['org_id'], 'party_tenant_id': binding['tenant_id'],
                 'repository_id': binding['repository_id']} if binding else {})
    if args.dry_run:
        print(json.dumps({'repo': args.repo, 'workspace': args.workspace_id, 'source_sha256': source_hash,
                          'state': str(args.state), **identity,
                          **({'party_environment': 'conquest', 'party_profile': 'conquest'} if binding else {}),
                          'copy_to': '/conquest', 'workflow': f'.github/workflows/{WORKFLOW}',
                          'secret': 'RAILWAY_TOKEN', 'variable': 'RAILWAY_PUBLIC_URL',
                          'services': ['Postgres', 'backend', 'frontend'], 'region': args.region,
                          'initial_trigger': 'skip-ci push then one workflow_dispatch'}, indent=2))
        return
    if not shutil.which('gh') or not shutil.which('git'):
        raise ValueError('Install and authenticate the GitHub CLI; git is also required')
    token = os.environ.get('RAILWAY_API_TOKEN', '').strip() or config.get('railway_api_token', '').strip()
    if not token:
        raise ValueError('Supply the organizer workspace API token in the private config or as RAILWAY_API_TOKEN')
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    inside_git = subprocess.run(['git', '-C', str(args.state.parent), 'rev-parse', '--show-toplevel'], capture_output=True)
    if inside_git.returncode == 0:
        raise ValueError('Keep the private checkpoint outside Git repositories')
    lock_path = args.state.with_suffix(args.state.suffix + '.lock')
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another provisioning run is using this checkpoint') from None
        state = State(args.state, args.repo, args.workspace_id)
        for key, value in identity.items():
            if state.data.get(key, value) != value:
                raise ValueError('Party binding identity differs from this checkpoint; reconcile before resuming')
        if state.data.get('region', args.region) != args.region:
            raise ValueError('Region differs from this checkpoint; resume using the original region')
        github = GitHub(args.repo)
        github.allow_protected_bootstrap = args.allow_protected_bootstrap
        github.already_published = bool(state.data.get('commit'))
        github.restore_admin_protection(state)
        repository = github.preflight()
        if binding and (not repository or repository.get('id') != binding['repository_id']):
            raise ValueError('GitHub repository identity does not match the Party-managed binding')
        github.recover_setup(state)
        reconcile_commit(github, state)
        if state.data.get('source_hash', source_hash) != source_hash and not state.data.get('commit'):
            raise ValueError('Source changed during partial provisioning; use the original starter to resume')
        state.update(source_hash=state.data.get('source_hash', source_hash), region=args.region, **identity)
        party_environment = party_environment_for_org(binding, config) if binding else None
        if party_environment:
            # Read-only checks fail missing seeds or insufficient organizer
            # access before provisioning paid Railway resources.
            party_environment.inspect(state, binding)
        with tempfile.TemporaryDirectory(prefix='party-team-repo-') as temporary:
            checkout = Path(temporary) / 'repo'
            frozen = Path(temporary) / 'starter'
            copy_starter(source, frozen)
            if fingerprint(frozen) != source_hash:
                raise ValueError('Starter changed while being copied; rerun with a stable source')
            if not state.data.get('commit'):
                github.clone(checkout)
                # Fail before provisioning paid resources if existing team files conflict.
                check_repository(frozen, checkout, replace=args.replace_conquest)
                state.update(base_commit=run_process(['git', 'rev-parse', 'HEAD'], cwd=checkout))
            print('Provisioning team Railway services...', flush=True)
            Railway(token, args.workspace_id, args.region).provision(state, 'party-conquest-' + args.repo.split('/')[0].lower())
            github.set_deployment_credentials(state.data['project_token'], state.data['public_url'])
            if not state.data.get('commit'):
                install_repository(frozen, checkout, state.data['public_url'], replace=args.replace_conquest)
                run_process(['git', 'add', '--', 'conquest', f'.github/workflows/{WORKFLOW}'], cwd=checkout)
                run_process(['git', '-c', 'user.name=Party Provisioner', '-c', 'user.email=party-provisioner@users.noreply.github.com',
                  'commit', '-m', f'Provision Conquest {state.data["provisioning_id"]} [skip ci]'], cwd=checkout)
                commit = run_process(['git', 'rev-parse', 'HEAD'], cwd=checkout)
                # Persist commit before push so a lost push response can be reconciled.
                state.update(pending_commit=commit)
                github.publish(state, checkout)
            github.deploy(state, args.timeout)
            # Workflow success includes this check; verify the published URL again
            # at the organizer boundary before reporting a completed handoff.
            import railway_deploy
            railway_deploy.verify_release(state.data['public_url'], state.data['commit'], attempts=10)
            if party_environment:
                state.update(complete=False)
                print('Preparing and promoting the team Party conquest Environment...', flush=True)
                party_environment.configure(state, binding, timeout=args.timeout)
            state.update(complete=True)
            print(json.dumps({'repo': args.repo, 'project_id': state.data['project_id'],
              **identity,
              **({key: state.data[key] for key in ('party_environment_id', 'party_profile_id',
                    'party_environment_version', 'party_environment_build_id')} if party_environment else {}),
              'environment_id': state.data['environment_id'], 'public_url': state.data['public_url'],
              'workflow_url': state.data['run_url'], 'commit': state.data['commit']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, OSError) as error:
        print(f'Provisioning failed: {error}', file=sys.stderr)
        sys.exit(1)
