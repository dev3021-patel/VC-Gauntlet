"""Final Party Environment handoff against a controlled organization API."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location(
    'party_conquest_environment',
    Path(__file__).parents[2] / 'scripts/party_environment.py',
)
environment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(environment)

provision_spec = importlib.util.spec_from_file_location(
    'party_conquest_environment_state',
    Path(__file__).parents[2] / 'scripts/provision_team.py',
)
provision = importlib.util.module_from_spec(provision_spec)
provision_spec.loader.exec_module(provision)

ORG = '11111111-1111-4111-8111-111111111111'
TENANT = '22222222-2222-4222-8222-222222222222'
ENVIRONMENT = '33333333-3333-4333-8333-333333333333'
REPOSITORY = 'Party-Internal/party-team-repository'
BINDING = {'org_id': ORG, 'tenant_id': TENANT, 'repo': REPOSITORY, 'repository_id': 123}


def state(tmp_path):
    result = provision.State(tmp_path / 'private-state.json', REPOSITORY, 'railway-workspace')
    result.update(commit='a' * 40, party_org_id=ORG, party_tenant_id=TENANT, provisioning_id='fixture-setup',
                  project_token='team-project-secret', project_id='railway-project',
                  environment_id='railway-production', public_url='https://team.up.railway.app')
    return result


class OrganizationApi:
    def __init__(self, *, lost_response=None, build_status='SUCCEEDED', image_digest='sha256:' + 'b' * 64):
        self.environments = [{'id': ENVIRONMENT, 'name': 'Conquest', 'latestVersion': 'v1'}]
        self.manifest = {
            'id': ENVIRONMENT, 'schemaVersion': 1, 'name': 'conquest', 'version': 'v1',
            'description': 'Prepared local Conquest environment', 'repositories': [],
            'workspace': {'dependencies': [{'id': 'node', 'version': '24'}, {'id': 'python', 'version': '3.12'}]},
            'profiles': {'profileIds': ['seeded-profile'], 'overrides': {}},
            'services': [{'id': 'postgres', 'name': 'postgres'}],
            'lifecycle': [{'id': 'bootstrap', 'stage': 'start', 'command': 'python -m bootstrap'}],
            'network': {'egressPolicy': 'open', 'egressRules': []},
            'databases': [],
        }
        self.saved_versions = []
        self.save_receipts = {}
        self.builds = []
        self.build_receipts = {}
        self.promotions = []
        self.profiles = [{'id': 'seeded-profile', 'name': 'conquest', 'variables': [{'name': 'APP_ENV'}]}]
        self.profile_secrets = {'APP_ENV': 'development'}
        self.requests = []
        self.lost_response = lost_response
        self.build_status = build_status
        self.image_digest = image_digest
        self.on_build_poll = None

    def accepted(self, operation, response):
        if self.lost_response == operation:
            self.lost_response = None
            raise RuntimeError('accepted response lost')
        return copy.deepcopy(response)

    def request(self, method, path, body=None, *, query=None, headers=None):
        self.requests.append((method, path, copy.deepcopy(body), query, headers))
        if method == 'GET' and path == '/api/environments':
            return {'environments': copy.deepcopy(self.environments)}
        if method == 'GET' and path == '/api/environments/catalogs':
            return {'repositories': [{'fullName': REPOSITORY, 'access': 'write', 'defaultBranch': 'main'}]}
        if method == 'GET' and path == '/api/org/env_profiles':
            return {'profiles': copy.deepcopy(self.profiles)}
        prefix = f'/api/environments/{ENVIRONMENT}'
        if method == 'GET' and path == prefix:
            return {'manifest': copy.deepcopy(self.manifest)}
        if method == 'GET' and path == f'{prefix}/versions':
            return {'versions': [{'version': self.manifest['version']}]}
        if method == 'POST' and path == f'{prefix}/versions':
            receipt = body.get('draftRevision')
            assert receipt, 'A saved draft receipt must survive response loss'
            if receipt not in self.save_receipts:
                assert body['baseVersion'] == self.manifest['version']
                self.manifest = copy.deepcopy(body['manifest'])
                self.manifest.pop('draftRevision', None)
                self.manifest['version'] = 'v2'
                self.saved_versions.append(copy.deepcopy(self.manifest))
                self.save_receipts[receipt] = {'manifest': copy.deepcopy(self.manifest)}
                self.environments[0]['latestVersion'] = 'v2'
            return self.accepted('save', self.save_receipts[receipt])
        if method == 'POST' and path == f'{prefix}/builds':
            key = (headers or {}).get('Idempotency-Key')
            assert key, 'Build request must use its persisted idempotency key'
            if key not in self.build_receipts:
                identifier = 'team-build' if not self.builds else f'team-build-{len(self.builds) + 1}'
                build = {'id': identifier, 'version': body['version'], 'status': self.build_status,
                         'imageDigest': self.image_digest, 'imageReference': 'registry/image', 'promoted': False}
                self.builds.append(build)
                self.build_receipts[key] = build
            return self.accepted('build', {'build': self.build_receipts[key]})
        if method == 'GET' and path == f'{prefix}/builds':
            if self.on_build_poll:
                self.on_build_poll(self)
            return {'builds': copy.deepcopy(self.builds)}
        if method == 'POST' and path.startswith(f'{prefix}/builds/') and path.endswith('/promote'):
            identifier = path.split('/')[-2]
            build = next(build for build in self.builds if build['id'] == identifier)
            self.promotions.append(identifier)
            build['promoted'] = True
            self.environments[0]['promotedBuildId'] = identifier
            self.environments[0]['promotedVersion'] = build['version']
            return self.accepted('promote', {'ok': True})
        raise AssertionError(f'Unexpected API operation: {method} {path}')


def test_final_handoff_saves_managed_repo_and_preserves_seeded_dependencies_profiles_and_services(tmp_path):
    api = OrganizationApi()
    original = copy.deepcopy(api.manifest)
    checkpoint = state(tmp_path)
    environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    assert len(api.saved_versions) == len(api.builds) == len(api.promotions) == 1
    assert api.manifest['repositories'] == [{'fullName': REPOSITORY, 'defaultBranch': 'main', 'access': 'write',
                                            'setupCommand': ('cd conquest && python3 -c "import runpy; '
                                                             "runpy.run_path('scripts/dev.py')['bootstrap']()\"")}]
    for section in ('workspace', 'profiles', 'services', 'lifecycle', 'network', 'databases'):
        assert api.manifest[section] == original[section]
    assert checkpoint.data['party_environment_id'] == ENVIRONMENT
    assert checkpoint.data['party_environment_version'] == 'v2'
    assert checkpoint.data['party_environment_build_id'] == 'team-build'
    assert checkpoint.data['party_environment_complete'] is True
    assert api.profile_secrets == {'APP_ENV': 'development'}
    assert not any(path.startswith('/api/org/env_profiles/') and method != 'GET'
                   for method, path, *_ in api.requests)


def test_environment_handoff_needs_no_railway_credentials_and_leaves_runtime_profile_unchanged(tmp_path):
    api = OrganizationApi()
    checkpoint = state(tmp_path)
    for key in ('project_token', 'project_id', 'environment_id', 'public_url'):
        checkpoint.data.pop(key)
    checkpoint.update()
    environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    assert checkpoint.data['party_environment_complete'] is True
    assert api.profile_secrets == {'APP_ENV': 'development'}
    assert not any(path.startswith('/api/org/env_profiles/') and method != 'GET'
                   for method, path, *_ in api.requests)


def test_resuming_completed_handoff_does_not_duplicate_versions_builds_or_promotions(tmp_path):
    api = OrganizationApi()
    checkpoint = state(tmp_path)
    environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    resumed = provision.State(checkpoint.path, REPOSITORY, 'railway-workspace')
    environment.PartyEnvironment(api).configure(resumed, BINDING)
    assert len(api.saved_versions) == len(api.builds) == len(api.promotions) == 1


@pytest.mark.parametrize('lost_response', ['save', 'build', 'promote'])
def test_accepted_mutations_can_be_resumed_without_duplicate_version_build_or_promotion(tmp_path, lost_response):
    api = OrganizationApi(lost_response=lost_response)
    checkpoint = state(tmp_path)
    with pytest.raises(RuntimeError, match='response lost'):
        environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    resumed = provision.State(checkpoint.path, REPOSITORY, 'railway-workspace')
    environment.PartyEnvironment(api).configure(resumed, BINDING)
    assert len(api.saved_versions) == len(api.builds) == len(api.promotions) == 1
    assert resumed.data['party_environment_complete'] is True


@pytest.mark.parametrize('environments', [[], [{'id': ENVIRONMENT, 'name': 'conquest'}, {'id': 'other', 'name': 'CONQUEST'}]])
def test_missing_or_ambiguous_seeded_environment_fails_before_mutating(tmp_path, environments):
    api = OrganizationApi()
    api.environments = environments
    with pytest.raises(ValueError, match='exactly one'):
        environment.PartyEnvironment(api).configure(state(tmp_path), BINDING)
    assert not any(method == 'POST' for method, *_ in api.requests)


@pytest.mark.parametrize('status,digest', [('FAILED', 'sha256:' + 'b' * 64), ('CANCELLED', None), ('SUCCEEDED', None)])
def test_failed_or_unpublished_build_is_never_promoted(tmp_path, status, digest):
    api = OrganizationApi(build_status=status, image_digest=digest)
    checkpoint = state(tmp_path)
    with pytest.raises(RuntimeError, match='build'):
        environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    assert api.promotions == []
    assert not checkpoint.data.get('party_environment_complete')


def test_repository_already_in_seed_is_not_duplicated_and_setup_command_is_retained(tmp_path):
    api = OrganizationApi()
    api.manifest['repositories'] = [{'fullName': REPOSITORY, 'defaultBranch': 'main', 'access': 'write', 'setupCommand': 'custom bootstrap'}]
    environment.PartyEnvironment(api).configure(state(tmp_path), BINDING)
    assert api.saved_versions == []
    assert len(api.manifest['repositories']) == 1
    assert api.manifest['repositories'][0]['setupCommand'] == 'custom bootstrap'
    assert api.builds[0]['version'] == 'v1'


def test_checkpoint_for_another_org_is_rejected_before_any_party_request(tmp_path):
    api = OrganizationApi()
    checkpoint = state(tmp_path)
    checkpoint.update(party_tenant_id='another-tenant')
    with pytest.raises(ValueError, match='identity'):
        environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    assert api.requests == []


@pytest.mark.parametrize('profiles', [[], [{'id': 'seeded-profile', 'name': 'conquest'}, {'id': 'other-profile', 'name': 'CONQUEST'}]])
def test_missing_or_ambiguous_seeded_profile_fails_before_mutating(tmp_path, profiles):
    api = OrganizationApi()
    api.profiles = profiles
    with pytest.raises(ValueError, match='exactly one'):
        environment.PartyEnvironment(api).configure(state(tmp_path), BINDING)
    assert not any(method == 'POST' for method, *_ in api.requests)


def test_profile_must_already_be_attached_to_the_seeded_environment(tmp_path):
    api = OrganizationApi()
    api.manifest['profiles']['profileIds'] = ['other-profile']
    with pytest.raises(ValueError, match='attached'):
        environment.PartyEnvironment(api).configure(state(tmp_path), BINDING)
    assert not any(method == 'POST' for method, *_ in api.requests)


@pytest.mark.parametrize('terminal_status', ['FAILED', 'CANCELLED'])
def test_next_invocation_can_retry_failed_build_with_a_new_durable_key(tmp_path, terminal_status):
    api = OrganizationApi(build_status=terminal_status)
    checkpoint = state(tmp_path)
    with pytest.raises(RuntimeError, match='build'):
        environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    old_key = next(iter(api.build_receipts))
    assert not checkpoint.data.get('party_environment_build_id')
    assert not checkpoint.data.get('party_environment_build_key')
    assert len(api.builds) == 1, 'Do not retry a failed build within the same invocation'
    api.build_status = 'SUCCEEDED'
    resumed = provision.State(checkpoint.path, REPOSITORY, 'railway-workspace')
    environment.PartyEnvironment(api).configure(resumed, BINDING)
    assert resumed.data['party_environment_build_key'] != old_key
    assert len(api.saved_versions) == 1
    assert len(api.builds) == 2
    assert api.promotions == ['team-build-2']
    assert resumed.data['party_environment_complete'] is True


@pytest.mark.parametrize('advance', ['version', 'promotion'])
def test_external_environment_advance_during_build_is_never_rolled_back(tmp_path, advance):
    api = OrganizationApi()
    checkpoint = state(tmp_path)
    def advance_during_build(api):
        if advance == 'version':
            api.environments[0]['latestVersion'] = 'v3'
        else:
            api.environments[0]['promotedBuildId'] = 'newer-external-build'
            api.environments[0]['promotedVersion'] = 'v2'
    api.on_build_poll = advance_during_build
    with pytest.raises(RuntimeError, match='changed|advanced'):
        environment.PartyEnvironment(api).configure(checkpoint, BINDING)
    assert api.promotions == []
    assert not checkpoint.data.get('party_environment_complete')


class SignedInClient:
    def __init__(self):
        self.requests = []
        self.memberships = [{'org_id': ORG, 'org_slug': 'team-party', 'status': 'active', 'role': 'admin'}]
        self.me = {'gate': 'ready', 'org': {'id': ORG, 'slug': 'team-party'}, 'tenant_id': TENANT}

    def request(self, method, path, body=None, *, headers=None, query=None):
        self.requests.append((method, path, body, headers, query))
        if path == '/api/auth/organizations':
            return {'memberships': self.memberships}
        if path == '/api/auth/me':
            return self.me
        return {'ok': True}


def test_signed_in_user_scopes_requests_to_target_org_without_changing_saved_cli_organization():
    client = SignedInClient()
    scoped = environment.SignedInPartyClient(client, BINDING, org_header='legacy-org-header')
    scoped.request('POST', '/api/environments/env/builds', {'version': 'v1'}, headers={'Idempotency-Key': 'build-request'})
    assert client.requests[-1][3] == {'legacy-org-header': 'team-party', 'Idempotency-Key': 'build-request'}
    assert client.requests[1][3] == {'legacy-org-header': 'team-party'}


@pytest.mark.parametrize('change', ['not_member', 'member_role', 'wrong_org', 'wrong_tenant'])
def test_signed_in_user_cannot_use_a_different_org_tenant_or_insufficient_role(change):
    client = SignedInClient()
    if change == 'not_member':
        client.memberships = []
    elif change == 'member_role':
        client.memberships[0]['role'] = 'member'
    elif change == 'wrong_org':
        client.me['org']['id'] = 'other-org'
    else:
        client.me['tenant_id'] = 'other-tenant'
    with pytest.raises(ValueError):
        environment.SignedInPartyClient(client, BINDING, org_header='legacy-org-header')
    assert not any(method == 'POST' for method, *_ in client.requests)


@pytest.mark.parametrize('override', [None, 'https://public.party.example/'])
def test_api_origin_override_routes_organization_requests_without_changing_saved_cli_url_or_refresh(override, monkeypatch):
    saved = {'url': 'https://internal.party.example', 'org': {'slug': 'organizer-home'},
             'access_token': 'expired-private-token', 'refresh_token': 'private-refresh-token'}
    persisted = []
    class AuthenticatedClient(SignedInClient):
        def __init__(self):
            super().__init__()
            self.creds = copy.deepcopy(saved)
            self.destinations = []
        @property
        def url(self):
            return self.creds['url']
        def request(self, *args, **kwargs):
            if self.creds['access_token'] == 'expired-private-token':
                self.creds['access_token'] = 'refreshed-private-token'
                persisted.append(copy.deepcopy(self.creds))
            self.destinations.append(self.url)
            return super().request(*args, **kwargs)
    class CliError(Exception):
        category = 'server'
    party_api = SimpleNamespace(OrgClient=AuthenticatedClient, ORG_HEADER='legacy-org-header', CliError=CliError)
    monkeypatch.setattr(environment.importlib, 'import_module', lambda _: party_api)
    scoped = environment.signed_in_client(BINDING, api_url=override)
    scoped.request('GET', '/api/environments')
    expected = override.rstrip('/') if override else saved['url']
    assert scoped.client.destinations == [expected] * 3
    assert scoped.client.creds['url'] == persisted[0]['url'] == saved['url']
    assert scoped.client.creds['org'] == persisted[0]['org'] == saved['org']
    assert scoped.client.creds['access_token'] == 'refreshed-private-token'
    assert scoped.client.requests[1][3] == {'legacy-org-header': 'team-party'}


@pytest.mark.parametrize('origin', ['', None, 42, 'http://public.party.example',
                                    'https://user:password@public.party.example',
                                    'https://public.party.example/api',
                                    'https://public.party.example?query=private',
                                    'https://public.party.example#fragment',
                                    'https://public.party.example:invalid',
                                    'https://public.party.example:70000',
                                    'https://public.party.example\n', '//public.party.example'])
def test_invalid_party_api_origin_is_rejected(origin):
    with pytest.raises(ValueError, match='party_api_url'):
        environment.validate_api_origin(origin)


def test_managed_repository_uses_the_party_catalog_token(tmp_path):
    class ShortCatalog(OrganizationApi):
        def request(self, method, path, body=None, **kwargs):
            if method == 'GET' and path == '/api/environments/catalogs':
                return {'repositories': [{'fullName': REPOSITORY.split('/')[1], 'access': 'write', 'defaultBranch': 'main'}]}
            if method == 'POST' and path.endswith('/versions'):
                assert body['manifest']['repositories'][0]['fullName'] == REPOSITORY.split('/')[1]
            return super().request(method, path, body, **kwargs)
    api = ShortCatalog()
    environment.PartyEnvironment(api).configure(state(tmp_path), BINDING)
    assert api.manifest['repositories'][0]['fullName'] == REPOSITORY.split('/')[1]


def test_unavailable_managed_repository_stops_read_only_preflight(tmp_path):
    class MissingCatalog(OrganizationApi):
        def request(self, method, path, body=None, **kwargs):
            if method == 'GET' and path == '/api/environments/catalogs':
                return {'repositories': []}
            return super().request(method, path, body, **kwargs)
    api = MissingCatalog()
    with pytest.raises(ValueError, match='catalog'):
        environment.PartyEnvironment(api).inspect(state(tmp_path), BINDING)
    assert not any(method != 'GET' for method, *_ in api.requests)
