"""Provisioning decisions against a durable, controlled Railway API boundary.

These tests prove recovery and resource ordering, not Railway's live schema.
"""
from collections import Counter
import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    'party_conquest_team_resources',
    Path(__file__).parents[2] / 'scripts/provision_team.py',
)
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ControlledRailway(provision.Railway):
    """Keep accepted mutations even when their HTTP response is lost."""

    def __init__(self, *, database_status='SUCCESS', lose_response=None):
        super().__init__('organizer-only-secret', 'workspace', 'us-west2')
        self.database_status = database_status
        self.lose_response = lose_response
        self.projects = []
        self.services = {}
        self.volumes = []
        self.domains = []
        self.variables = {}
        self.deployments = {}
        self.created = Counter()
        self.calls = []

    def accepted(self, operation, result):
        if self.lose_response == operation:
            self.lose_response = None
            raise RuntimeError('Accepted mutation response was lost')
        return result

    def query(self, query, variables=None):
        variables = variables or {}
        if 'volumeInstances' in query:
            self.calls.append(('inventory', variables))
            return {
                'project': {
                    'id': variables['project'],
                    'workspaceId': self.workspace,
                    'services': {'edges': [
                        {'node': {'id': identifier, 'name': name}}
                        for name, identifier in self.services.items()
                    ]},
                },
                'environment': {
                    'volumeInstances': {'edges': [{'node': volume} for volume in self.volumes]},
                    'serviceInstances': {'edges': [
                        {'node': {
                            'serviceId': identifier,
                            'latestDeployment': self.deployments.get(identifier),
                            'domains': {'serviceDomains': self.domains if name == 'frontend' else []},
                        }}
                        for name, identifier in self.services.items()
                    ]},
                },
            }
        if 'projects(first:100,after:' in query:
            # One project per page ensures response-loss recovery really pages.
            self.calls.append(('project_page', variables))
            index = int(variables.get('after') or '0')
            page = self.projects[index:index + 1]
            more = index + 1 < len(self.projects)
            return {'workspace': {'projects': {
                'edges': [{'node': project} for project in page],
                'pageInfo': {'hasNextPage': more, 'endCursor': str(index + 1) if more else None},
            }}}
        operation = next((name for name in (
            'projectCreate', 'serviceCreate', 'volumeCreate',
            'variableCollectionUpsert', 'serviceInstanceUpdate',
            'serviceInstanceDeployV2', 'serviceDomainCreate', 'projectTokenCreate',
        ) if f'{name}(' in query), None)
        if operation is None:
            raise AssertionError(f'Unexpected GraphQL operation: {query}')
        self.calls.append((operation, variables))
        values = variables.get('input', {})
        if operation == 'projectCreate':
            self.created['project'] += 1
            project = {
                'id': 'team-project', 'name': values['name'],
                'environments': {'edges': [{'node': {'id': 'production-env', 'name': 'production'}}]},
            }
            self.projects.append(project)
            return self.accepted(operation, {operation: project})
        if operation == 'serviceCreate':
            self.created['service'] += 1
            identifier = f'service-{values["name"]}'
            self.services[values['name']] = identifier
            return self.accepted(operation, {operation: {'id': identifier}})
        if operation == 'volumeCreate':
            self.created['volume'] += 1
            self.volumes.append({
                'volumeId': 'database-volume', 'serviceId': values['serviceId'],
                'mountPath': values['mountPath'], 'region': values['region'],
            })
            return self.accepted(operation, {operation: {'id': 'database-volume'}})
        if operation == 'variableCollectionUpsert':
            self.variables[values['serviceId']] = values['variables']
            return {operation: True}
        if operation == 'serviceInstanceUpdate':
            return {operation: True}
        if operation == 'serviceInstanceDeployV2':
            self.created['database_deployment'] += 1
            self.deployments[variables['service']] = {
                'id': 'database-deployment', 'status': self.database_status,
            }
            return {operation: 'database-deployment'}
        if operation == 'serviceDomainCreate':
            self.created['domain'] += 1
            domain = {'id': 'public-domain', 'domain': 'team.up.railway.app', 'targetPort': values['targetPort']}
            self.domains.append(domain)
            return self.accepted(operation, {operation: domain})
        if operation == 'projectTokenCreate':
            self.created['token'] += 1
            return self.accepted(operation, {operation: 'project-scoped-secret'})
        raise AssertionError(operation)


def checkpoint(tmp_path):
    return provision.State(tmp_path / 'team-state.json', 'team/party-managed', 'workspace')


def reload_checkpoint(state):
    return provision.State(state.path, 'team/party-managed', 'workspace')


def test_resuming_provisioning_creates_one_project_and_each_team_resource_once(tmp_path):
    railway = ControlledRailway()
    state = checkpoint(tmp_path)
    railway.provision(state, 'party-conquest-team')
    resumed = reload_checkpoint(state)
    railway.provision(resumed, 'party-conquest-team')
    assert railway.created == {
        'project': 1, 'service': 3, 'volume': 1,
        'database_deployment': 1, 'domain': 1, 'token': 1,
    }
    assert resumed.data['services'] == {
        'Postgres': 'service-Postgres', 'backend': 'service-backend', 'frontend': 'service-frontend',
    }
    assert resumed.data['public_url'] == 'https://team.up.railway.app'


def test_long_organization_names_fit_railways_project_name_limit(tmp_path):
    railway = ControlledRailway()
    state = checkpoint(tmp_path)
    railway.provision(state, 'party-conquest-' + 'long-organization-name' * 3)
    name = railway.projects[0]['name']
    assert 1 <= len(name) <= 32
    assert name.endswith('-' + state.data['provisioning_id'][:8])


def test_postgres_persistent_storage_and_credentials_precede_image_deployment(tmp_path):
    railway = ControlledRailway()
    railway.provision(checkpoint(tmp_path), 'party-conquest-team')
    mutations = railway.calls
    volume = next(i for i, (operation, _) in enumerate(mutations) if operation == 'volumeCreate')
    credentials = next(i for i, (operation, variables) in enumerate(mutations)
                       if operation == 'variableCollectionUpsert'
                       and variables['input']['serviceId'] == 'service-Postgres')
    image = next(i for i, (operation, variables) in enumerate(mutations)
                 if operation == 'serviceInstanceUpdate' and 'source' in variables['input'])
    deploy = next(i for i, (operation, _) in enumerate(mutations) if operation == 'serviceInstanceDeployV2')
    assert volume < image < deploy
    assert credentials < image
    assert railway.volumes[0]['mountPath'] == '/var/lib/postgresql/data'
    assert railway.variables['service-Postgres']['PGDATA'] == '/var/lib/postgresql/data/pgdata'
    assert railway.variables['service-backend']['DATABASE_URL'] == '${{Postgres.DATABASE_URL}}'


def test_only_the_production_project_token_is_handed_to_the_team(tmp_path, monkeypatch):
    railway = ControlledRailway()
    state = checkpoint(tmp_path)
    railway.provision(state, 'party-conquest-team')
    token_request = next(values['input'] for operation, values in railway.calls if operation == 'projectTokenCreate')
    assert token_request['projectId'] == state.data['project_id']
    assert token_request['environmentId'] == state.data['environment_id']
    github_calls = []
    monkeypatch.setattr(provision, 'run_process', lambda command, **options: github_calls.append((command, options)))
    provision.GitHub('team/party-managed').set_deployment_credentials(state.data['project_token'], state.data['public_url'])
    assert github_calls[0][1]['input'] == 'project-scoped-secret'
    assert railway.token != github_calls[0][1]['input']
    assert railway.token not in state.path.read_text()


def test_lost_project_creation_response_is_found_on_a_later_inventory_page(tmp_path):
    railway = ControlledRailway(lose_response='projectCreate')
    railway.projects.append({'id': 'other-project', 'name': 'unrelated', 'environments': {'edges': []}})
    state = checkpoint(tmp_path)
    with pytest.raises(RuntimeError, match='response was lost'):
        railway.provision(state, 'party-conquest-team')
    assert 'project_id' not in state.data
    railway.provision(reload_checkpoint(state), 'party-conquest-team')
    assert railway.created['project'] == 1
    assert any(operation == 'project_page' and values['after'] == '1' for operation, values in railway.calls)


@pytest.mark.parametrize('operation', ['serviceCreate', 'volumeCreate', 'serviceDomainCreate'])
def test_accepted_resource_mutations_are_recovered_without_duplicate_resources(tmp_path, operation):
    railway = ControlledRailway(lose_response=operation)
    state = checkpoint(tmp_path)
    with pytest.raises(RuntimeError, match='response was lost'):
        railway.provision(state, 'party-conquest-team')
    railway.provision(reload_checkpoint(state), 'party-conquest-team')
    assert railway.created == {
        'project': 1, 'service': 3, 'volume': 1,
        'database_deployment': 1, 'domain': 1, 'token': 1,
    }


def test_failed_database_blocks_project_token_handout_and_is_retryable(tmp_path):
    railway = ControlledRailway(database_status='FAILED')
    state = checkpoint(tmp_path)
    with pytest.raises(RuntimeError, match='Postgres deployment failed'):
        railway.provision(state, 'party-conquest-team')
    assert railway.created['token'] == 0
    assert railway.created['domain'] == 0
    assert 'project_token' not in state.data
    assert state.data['database_deploy_requested'] is False
    railway.database_status = 'SUCCESS'
    railway.provision(reload_checkpoint(state), 'party-conquest-team')
    assert railway.created['project'] == 1
    assert railway.created['service'] == 3
    assert railway.created['volume'] == 1
    assert railway.created['database_deployment'] == 2
    assert railway.created['token'] == 1


def test_ambiguous_token_creation_requires_recovery_instead_of_minting_another(tmp_path):
    railway = ControlledRailway(lose_response='projectTokenCreate')
    state = checkpoint(tmp_path)
    with pytest.raises(RuntimeError, match='response was lost'):
        railway.provision(state, 'party-conquest-team')
    assert state.data['token_request_pending'] is True
    assert 'project_token' not in state.data
    with pytest.raises(RuntimeError, match='Recover or revoke'):
        railway.provision(reload_checkpoint(state), 'party-conquest-team')
    assert railway.created['token'] == 1
