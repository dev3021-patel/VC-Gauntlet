"""Operator lookup boundaries and canonical ownership against disposable PostgreSQL."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import uuid

import pytest


spec = importlib.util.spec_from_file_location(
    'party_conquest_org_repository',
    Path(__file__).parents[2] / 'scripts/party_org_repository.py',
)
lookup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lookup)

ORG = '11111111-1111-4111-8111-111111111111'
TENANT = '22222222-2222-4222-8222-222222222222'


def binding(**overrides):
    result = dict(org_id=ORG, tenant_id=TENANT, org_status='active',
                  hosting_org='Party-Internal', repository_name='party-persisted-name',
                  repository_id=123, state='ready', actions_enabled=True)
    result.update(overrides)
    return result


def mock_response(monkeypatch, payload, returncode=0):
    calls = []
    def run(command, **options):
        calls.append((command, options))
        return SimpleNamespace(returncode=returncode, stdout=json.dumps(payload),
                               stderr='postgresql://private-user:private-secret@private-db')
    monkeypatch.setattr(lookup.subprocess, 'run', run)
    return calls


def test_lookup_returns_canonical_repo_without_exposing_internal_or_secret_fields(monkeypatch):
    calls = mock_response(monkeypatch, binding(database_url='private-secret', installation_id=999))
    monkeypatch.setenv('RAILWAY_API_TOKEN', 'organizer-secret')
    monkeypatch.setenv('RAILWAY_TOKEN', 'project-secret')
    result = lookup.resolve_org(ORG)
    assert result == {'org_id': ORG, 'tenant_id': TENANT,
                      'repo': 'Party-Internal/party-persisted-name', 'repository_id': 123}
    command, options = calls[0]
    assert command[:3] == ['kubectl', '--context', lookup.DEFAULT_CONTEXT]
    assert 'deployment/skipper-skipper-control-plane' in command
    assert command[-3:] == ['python', '-', ORG]
    assert options['input'] == lookup.REMOTE_LOOKUP_SCRIPT
    assert options['capture_output'] and options['timeout'] <= 30
    assert 'RAILWAY_API_TOKEN' not in options['env']
    assert 'RAILWAY_TOKEN' not in options['env']
    assert 'organizer-secret' not in json.dumps(result)


@pytest.mark.parametrize('org_id', ['a-name', '11111111111141118111111111111111',
                                  '--context=other', ORG + "'; SELECT 1"])
def test_invalid_org_is_rejected_before_running_kubectl(monkeypatch, org_id):
    calls = mock_response(monkeypatch, binding())
    with pytest.raises(ValueError, match='UUID'):
        lookup.resolve_org(org_id)
    assert not calls


@pytest.mark.parametrize('values', [
    {'org_id': '33333333-3333-4333-8333-333333333333'},
    {'tenant_id': None}, {'org_status': 'inactive'}, {'hosting_org': 'Other-Org'},
    {'state': 'migrated'}, {'state': 'provisioning'}, {'repository_id': None},
    {'repository_id': True}, {'actions_enabled': False},
    {'repository_name': '../private-secret'},
])
def test_lookup_refuses_an_unavailable_or_wrongly_scoped_repository(monkeypatch, values):
    mock_response(monkeypatch, binding(**values))
    with pytest.raises((ValueError, RuntimeError)):
        lookup.resolve_org(ORG)


@pytest.mark.parametrize('payload', [None, [], {'error': 'query_failed'}, {'error': 'not_found'}])
def test_unusable_lookup_response_is_reported_safely(monkeypatch, payload):
    mock_response(monkeypatch, payload)
    with pytest.raises(RuntimeError) as error:
        lookup.resolve_org(ORG)
    assert 'private-secret' not in str(error.value)


def test_kubectl_failure_does_not_echo_credentials(monkeypatch):
    mock_response(monkeypatch, binding(database_url='private-secret'), returncode=1)
    with pytest.raises(RuntimeError) as error:
        lookup.resolve_org(ORG)
    assert 'private-secret' not in str(error.value)


def test_process_timeout_is_reported_without_output(monkeypatch):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 30, output='private-secret', stderr='private-secret')
    monkeypatch.setattr(lookup.subprocess, 'run', timeout)
    with pytest.raises(RuntimeError) as error:
        lookup.resolve_org(ORG)
    assert 'private-secret' not in str(error.value)


def test_explicit_operator_cluster_overrides_are_respected(monkeypatch):
    calls = mock_response(monkeypatch, binding())
    lookup.resolve_org(ORG, namespace='party-test', deployment='party-control-plane', context='test-context')
    command = calls[0][0]
    assert command[command.index('--context') + 1] == 'test-context'
    assert command[command.index('-n') + 1] == 'party-test'
    assert 'deployment/party-control-plane' in command


@pytest.fixture
def postgres_lookup_schema():
    url = os.environ.get('PARTY_ORG_LOOKUP_TEST_DATABASE_URL') or os.environ.get('TEST_DATABASE_URL')
    if not url:
        pytest.skip('PARTY_ORG_LOOKUP_TEST_DATABASE_URL or TEST_DATABASE_URL must identify disposable PostgreSQL')
    psycopg = pytest.importorskip('psycopg')
    schema = 'party_lookup_' + uuid.uuid4().hex
    from psycopg import sql
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
        connection.execute(sql.SQL('SET search_path TO {}').format(sql.Identifier(schema)))
        connection.execute('CREATE TABLE skipper_organizations (id uuid PRIMARY KEY, status text NOT NULL)')
        connection.execute('CREATE TABLE skipper_org_tenants (org_id uuid, tenant_id uuid, is_default boolean)')
        connection.execute('CREATE TABLE party_managed_repositories (tenant_id uuid PRIMARY KEY, hosting_org text, repository_name text, repository_id bigint, state text, actions_enabled boolean)')
        connection.execute('INSERT INTO skipper_organizations VALUES (%s, %s)', (ORG, 'active'))
        connection.execute('INSERT INTO skipper_org_tenants VALUES (%s, %s, TRUE), (%s, %s, FALSE)',
                           (ORG, TENANT, ORG, '00000000-0000-4000-8000-000000000000'))
        connection.execute('INSERT INTO party_managed_repositories VALUES (%s, %s, %s, %s, %s, %s), (%s, %s, %s, %s, %s, %s)',
                           (TENANT, 'Party-Internal', 'party-persisted-name', 123, 'ready', True,
                            '00000000-0000-4000-8000-000000000000', 'Other-Org', 'wrong-repo', 456, 'ready', True))
        from psycopg.conninfo import make_conninfo
        scoped = make_conninfo(url, options=f'-c search_path={schema}')
        try:
            yield scoped, connection
        finally:
            connection.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def run_remote(url, script=None, org_id=ORG):
    environment = os.environ.copy()
    environment['DATABASE_URL'] = url
    result = subprocess.run([sys.executable, '-', org_id],
                            input=script or lookup.REMOTE_LOOKUP_SCRIPT,
                            env=environment, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_real_sql_selects_the_persisted_default_tenant_binding(postgres_lookup_schema):
    url, _ = postgres_lookup_schema
    assert run_remote(url) == binding()
    assert run_remote(url, org_id='33333333-3333-4333-8333-333333333333') == {'error': 'not_found'}


def test_real_database_transaction_cannot_write(postgres_lookup_schema):
    url, connection = postgres_lookup_schema
    script = lookup.REMOTE_LOOKUP_SCRIPT.replace(
        'SELECT o.id::text',
        "WITH changed AS (UPDATE skipper_organizations SET status = 'inactive' RETURNING id) SELECT o.id::text",
        1,
    )
    assert script != lookup.REMOTE_LOOKUP_SCRIPT
    assert run_remote(url, script=script) == {'error': 'query_failed'}
    assert connection.execute('SELECT status FROM skipper_organizations WHERE id = %s', (ORG,)).fetchone()[0] == 'active'
