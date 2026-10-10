"""Finish the team handoff through Party's authenticated organization API.

The organizer's own CLI sign-in supplies authentication. The seeded conquest
Profile keeps local runtime defaults; Railway deployment credentials belong in
the repository's GitHub Actions secrets.
"""
from __future__ import annotations

import copy
import importlib
from pathlib import Path
import sys
import time
import urllib.parse
import uuid


SETUP_COMMAND = ('cd conquest && python3 -c "import runpy; '
                 "runpy.run_path('scripts/dev.py')['bootstrap']()\"")


def _q(value):
    return urllib.parse.quote(str(value), safe='')


def validate_api_origin(value):
    """Accept a trusted HTTPS origin without credential-bearing URL components."""
    message = 'party_api_url must be a nonempty HTTPS origin without credentials, path, query, or fragment'
    if (not isinstance(value, str) or not value or any(character.isspace() for character in value)
            or any(character in value for character in ('\\', '?', '#'))):
        raise ValueError(message)
    try:
        parsed = urllib.parse.urlsplit(value)
        valid = (parsed.scheme == 'https' and parsed.hostname
                 and parsed.username is None and parsed.password is None
                 and parsed.path in ('', '/') and not parsed.query and not parsed.fragment
                 and parsed.port != 0 and not parsed.netloc.endswith(':'))
    except ValueError:
        valid = False
    if not valid:
        raise ValueError(message)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))


def signed_in_client(binding, *, cli_source=None, api_url=None):
    """Reuse the installed CLI or an explicitly configured CLI source checkout."""
    origin = validate_api_origin(api_url) if api_url is not None else None
    if cli_source:
        path = Path(cli_source).expanduser().resolve()
        if not (path / 'skipper_cli/org_api.py').is_file():
            raise ValueError('party_cli_source must contain the Party CLI package')
        sys.path.insert(0, str(path))
    try:
        # Existing module name is the Party CLI's compatibility boundary.
        party_api = importlib.import_module('skipper_cli.org_api')
    except ImportError:
        raise ValueError('Install the Party CLI or configure party_cli_source; sign in with party login') from None
    class PartyDeploymentClient(party_api.OrgClient):
        @property
        def url(self):
            # OrgClient retains its saved credentials and normal refresh path.
            # Only this instance's destination changes for the target deployment.
            return origin or super().url
    try:
        return SignedInPartyClient(PartyDeploymentClient(), binding,
                                   org_header=party_api.ORG_HEADER, cli_error=party_api.CliError)
    except party_api.CliError as error:
        raise RuntimeError(f'Party sign-in or access failed ({error.category}); run party login as the organizer') from None


class SignedInPartyClient:
    """Scope requests without changing the CLI's saved organization selection."""
    def __init__(self, client, binding, *, org_header, cli_error=()):
        self.client, self.org_header, self.cli_error = client, org_header, cli_error
        memberships = client.request('GET', '/api/auth/organizations').get('memberships') or []
        matches = [item for item in memberships if item.get('org_id') == binding['org_id']
                   and item.get('status', 'active') == 'active']
        if len(matches) != 1 or matches[0].get('role') not in ('owner', 'admin'):
            raise ValueError('The signed-in organizer must be an active owner or admin of the target Party org')
        self.slug = matches[0].get('org_slug')
        if not self.slug:
            raise ValueError('Party returned an unusable target organization identity')
        me = self.request('GET', '/api/auth/me')
        if (me.get('gate') != 'ready' or me.get('org', {}).get('id') != binding['org_id']
                or me.get('org', {}).get('slug') != self.slug
                or me.get('tenant_id') != binding['tenant_id']):
            raise ValueError('Party authenticated organization/tenant identity differs from the managed repository binding')

    def request(self, method, path, body=None, *, query=None, headers=None):
        # The CLI provides this existing organization-selection header. Its
        # token refresh and the server's current-role checks remain authoritative.
        scoped_headers = dict(headers or {})
        scoped_headers[self.org_header] = self.slug
        try:
            return self.client.request(method, path, body, query=query, headers=scoped_headers)
        except self.cli_error as error:
            # Keep authenticated API error details out of provisioning output.
            raise RuntimeError(f'Party API operation failed ({error.category}): {method} {path}; '
                               'check sign-in, organization permissions, validation, and build logs') from None


class PartyEnvironment:
    def __init__(self, client):
        self.client = client

    def _identity(self, state, binding):
        if (state.data.get('party_org_id') != binding['org_id']
                or state.data.get('party_tenant_id') != binding['tenant_id']
                or state.data.get('repo') != binding['repo']):
            raise ValueError('Party binding identity differs from the Environment checkpoint')

    def inspect(self, state, binding):
        """Read-only validation of the seeded Environment and its Profile."""
        self._identity(state, binding)
        catalog = self.client.request('GET', '/api/environments/catalogs').get('repositories') or []
        # Party's managed repository catalog uses its short persisted name.
        # GitHub operations still use the authoritative owner/repo binding.
        tokens = {binding['repo'].casefold(), binding['repo'].split('/')[-1].casefold()}
        available = [row for row in catalog if str(row.get('fullName') or '').casefold() in tokens]
        if (len(available) != 1 or available[0].get('unavailable')
                or available[0].get('access') != 'write'
                or available[0].get('defaultBranch') != 'main'):
            raise ValueError('The managed repository is unavailable or not writable on main in the Party Environment catalog')
        self.repository_token = available[0]['fullName']
        rows = self.client.request('GET', '/api/environments').get('environments') or []
        matches = [row for row in rows if str(row.get('name') or '').casefold() == 'conquest']
        if len(matches) != 1:
            raise ValueError('Expected exactly one seeded conquest Party Environment in the target org')
        selected = matches[0]
        environment_id = selected.get('id')
        if not environment_id or state.data.get('party_environment_id', environment_id) != environment_id:
            raise ValueError('Seeded Party Environment identity differs from the checkpoint')
        versions = self.client.request('GET', f'/api/environments/{_q(environment_id)}/versions').get('versions') or []
        if not versions:
            raise ValueError('The seeded conquest Party Environment needs a saved version')
        version = versions[0]['version']
        manifest = self.client.request('GET', f'/api/environments/{_q(environment_id)}',
                                       query={'version': version}).get('manifest') or {}
        if manifest.get('id') != environment_id or manifest.get('version') != version:
            raise ValueError('Party returned an inconsistent Environment version')
        if manifest.get('draftRevision'):
            raise ValueError('The seeded conquest Environment has an unsaved draft; reconcile it before provisioning')
        profiles = self.client.request('GET', '/api/org/env_profiles').get('profiles') or []
        matches = [profile for profile in profiles if str(profile.get('name') or '').casefold() == 'conquest']
        if len(matches) != 1:
            raise ValueError('Expected exactly one seeded conquest Profile in the target org')
        profile_id = matches[0].get('id')
        if not profile_id or state.data.get('party_profile_id', profile_id) != profile_id:
            raise ValueError('Seeded conquest Profile identity differs from the checkpoint')
        if profile_id not in (manifest.get('profiles') or {}).get('profileIds', []):
            raise ValueError('The seeded conquest Profile must already be attached to the conquest Environment')
        return selected, manifest, profile_id

    def _save_repository(self, state, binding, manifest):
        if state.data.get('party_environment_version'):
            return state.data['party_environment_version']
        if not state.data.get('party_environment_save_manifest'):
            candidate = copy.deepcopy(manifest)
            repositories = candidate.setdefault('repositories', [])
            matches = [row for row in repositories
                       if str(row.get('fullName') or '').casefold() in
                       {binding['repo'].casefold(), self.repository_token.casefold()}]
            if len(matches) > 1:
                raise ValueError('The managed repository is duplicated in the conquest Environment')
            if matches:
                # Existing repo bootstrap belongs to the org; preserve it.
                matches[0].update(fullName=self.repository_token, defaultBranch='main', access='write')
            else:
                repositories.append({'fullName': self.repository_token, 'defaultBranch': 'main',
                                     'access': 'write', 'setupCommand': SETUP_COMMAND})
            if candidate == manifest:
                state.update(party_environment_version=manifest['version'])
                return manifest['version']
            # A source-draft receipt makes version save idempotent, even if the
            # response is lost after the server creates the immutable version.
            state.update(party_environment_save_manifest=candidate,
                         party_environment_base_version=manifest['version'],
                         party_environment_save_receipt=str(uuid.uuid4()))
        saved = self.client.request('POST', f'/api/environments/{_q(manifest["id"])}/versions', {
            'manifest': state.data['party_environment_save_manifest'],
            'baseVersion': state.data['party_environment_base_version'],
            'draftRevision': state.data['party_environment_save_receipt'],
        }).get('manifest') or {}
        if saved.get('id') != manifest['id'] or not saved.get('version'):
            raise RuntimeError('Party did not return the saved conquest Environment version')
        state.update(party_environment_version=saved['version'], party_environment_save_manifest=None)
        return saved['version']

    def _build(self, environment_id, build_id):
        builds = self.client.request('GET', f'/api/environments/{_q(environment_id)}/builds').get('builds') or []
        matches = [build for build in builds if build.get('id') == build_id]
        if len(matches) != 1:
            raise RuntimeError('The checkpoint Party Environment build was not found; inspect before resuming')
        return matches[0]

    def _promotion_guard(self, state):
        """Fail observed concurrent edits instead of replacing their live build."""
        rows = self.client.request('GET', '/api/environments').get('environments') or []
        matches = [row for row in rows if row.get('id') == state.data['party_environment_id']]
        if len(matches) != 1:
            raise RuntimeError('The Party conquest Environment changed while provisioning; reconcile before resuming')
        current = matches[0]
        if current.get('latestVersion') != state.data['party_environment_version']:
            raise RuntimeError('The latest Party Environment version advanced while provisioning; reconcile before promotion')
        if current.get('promotedBuildId') not in (
                state.data['party_environment_initial_promoted_build'],
                state.data.get('party_environment_build_id')):
            raise RuntimeError('The promoted Party Environment build changed while provisioning; reconcile before promotion')

    def configure(self, state, binding, *, timeout=1800):
        selected, manifest, profile_id = self.inspect(state, binding)
        environment_id = selected['id']
        state.update(party_environment_id=environment_id, party_profile_id=profile_id)
        if 'party_environment_initial_promoted_build' not in state.data:
            state.update(party_environment_initial_promoted_build=selected.get('promotedBuildId'))
        version = self._save_repository(state, binding, manifest)
        self._promotion_guard(state)
        if not state.data.get('party_environment_build_id'):
            if not state.data.get('party_environment_build_key'):
                state.update(party_environment_build_key=str(uuid.uuid4()))
            build = self.client.request('POST', f'/api/environments/{_q(environment_id)}/builds',
                                        {'version': version},
                                        headers={'Idempotency-Key': state.data['party_environment_build_key']}).get('build') or {}
            if not build.get('id') or build.get('version') != version:
                raise RuntimeError('Party returned an inconsistent Environment build')
            state.update(party_environment_build_id=build['id'])
        deadline = time.monotonic() + timeout
        while True:
            build = self._build(environment_id, state.data['party_environment_build_id'])
            if build.get('version') != version:
                raise RuntimeError('The Party Environment build targets another version')
            status = build.get('status')
            if status == 'SUCCEEDED':
                if not build.get('imageDigest') or not build.get('imageReference'):
                    raise RuntimeError('The Party Environment build has no published image; refusing promotion')
                break
            if status in ('FAILED', 'CANCELLED', 'CANCELED'):
                if not state.data.get('party_environment_complete'):
                    history = list(state.data.get('party_environment_failed_builds', []))
                    history.append({'id': build['id'], 'status': status})
                    # The next organizer invocation retries once with a new
                    # durable key. Never retry automatically inside this wait.
                    state.update(party_environment_failed_builds=history,
                                 party_environment_build_id=None, party_environment_build_key=None)
                raise RuntimeError(f'The Party conquest Environment build {status}; '
                                   'inspect Party build logs, repair the cause, then rerun to retry')
            if time.monotonic() >= deadline:
                raise RuntimeError('The Party Environment build did not finish within the timeout; resume with the same checkpoint')
            time.sleep(min(5, max(0, deadline - time.monotonic())))
        if state.data.get('party_environment_complete') and not build.get('promoted'):
            raise RuntimeError('The promoted Party Environment changed after handoff; reconcile before resuming')
        # Building can take minutes. Recheck immediately before promotion so
        # changes observed during the wait cannot roll a newer Environment back.
        self._promotion_guard(state)
        if not build.get('promoted'):
            self.client.request('POST', f'/api/environments/{_q(environment_id)}/builds/{_q(build["id"])}/promote')
        # Verify the server's exact promoted build, rather than treating a
        # successful enqueue or image build as a finished handoff.
        current = self._build(environment_id, build['id'])
        if not current.get('promoted'):
            raise RuntimeError('Party did not confirm the promoted conquest Environment build')
        state.update(party_environment_complete=True)
