#!/usr/bin/env python3
"""Resolve a Party organization's persisted managed repository as an operator.

Database credentials remain inside the control-plane pod. This compatibility
adapter names the existing Kubernetes namespace and deployment explicitly; new
deployment identities may be selected through the operator's configuration.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import uuid


DEFAULT_CONTEXT = 'arn:aws:eks:us-west-2:381491909731:cluster/maitai-prod'
DEFAULT_NAMESPACE = 'skipper'
DEFAULT_DEPLOYMENT = 'skipper-skipper-control-plane'

# Only this program and the public organization UUID cross the exec boundary.
# The remote process reads its own database configuration and emits no secrets.
REMOTE_LOOKUP_SCRIPT = r'''
import json
import os
import sys
import uuid

try:
    import psycopg
    from psycopg.conninfo import make_conninfo
    org_id = str(uuid.UUID(sys.argv[1]))
    conninfo = os.environ.get('DATABASE_URL', '').strip()
    if not conninfo:
        values = {
            'host': os.environ.get('DB_HOST_MT', '').strip(),
            'port': os.environ.get('DB_PORT_MT', '5432').strip(),
            'dbname': os.environ.get('DB_NAME_MT', '').strip(),
            'user': os.environ.get('DB_USER_MT', '').strip(),
        }
        if not all(values[key] for key in ('host', 'dbname', 'user')):
            raise ValueError('missing database configuration')
        if 'DB_PASSWORD_MT' in os.environ:
            values['password'] = os.environ['DB_PASSWORD_MT']
        if os.environ.get('DB_SSLMODE'):
            values['sslmode'] = os.environ['DB_SSLMODE']
        conninfo = make_conninfo(**values)
    with psycopg.connect(conninfo, connect_timeout=5) as connection:
        connection.read_only = True
        connection.execute("SET LOCAL statement_timeout = '5000ms'")
        cursor = connection.execute("""
            SELECT o.id::text, ot.tenant_id::text, o.status,
                   mr.hosting_org, mr.repository_name, mr.repository_id,
                   mr.state, mr.actions_enabled
              FROM skipper_organizations o
              LEFT JOIN LATERAL (
                  SELECT tenant_id FROM skipper_org_tenants
                   WHERE org_id = o.id
                   ORDER BY is_default DESC, tenant_id LIMIT 1
              ) ot ON TRUE
              LEFT JOIN party_managed_repositories mr ON mr.tenant_id = ot.tenant_id
             WHERE o.id = %s::uuid
        """, (org_id,))
        row = cursor.fetchone()
        result = dict(zip(('org_id', 'tenant_id', 'org_status', 'hosting_org',
                           'repository_name', 'repository_id', 'state', 'actions_enabled'), row)) if row else {'error': 'not_found'}
except Exception:
    result = {'error': 'query_failed'}
print(json.dumps(result))
'''


def _uuid(value: str) -> str:
    try:
        normalized = str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        raise ValueError('Party organization ID must be a UUID.') from None
    if value.lower() != normalized:
        raise ValueError('Party organization ID must be a UUID in its standard format.')
    return normalized


def _resource_name(value: str) -> str:
    if not isinstance(value, str) or len(value) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', value):
        raise ValueError('The configured Kubernetes resource name is invalid.')
    return value


def resolve_org(org_id: str, *, context: str = DEFAULT_CONTEXT,
                namespace: str = DEFAULT_NAMESPACE,
                deployment: str = DEFAULT_DEPLOYMENT) -> dict:
    """Return the ready managed repository for an active organization's tenant."""
    org_id = _uuid(org_id)
    if not isinstance(context, str) or not context or context.startswith('-') or any(character.isspace() for character in context):
        raise ValueError('The configured Kubernetes context is invalid.')
    namespace, deployment = _resource_name(namespace), _resource_name(deployment)
    environment = {key: value for key, value in os.environ.items()
                   if key not in {'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN'}}
    command = ['kubectl', '--context', context, '--request-timeout=15s',
               '-n', namespace, 'exec', '-i', f'deployment/{deployment}',
               '--', 'python', '-', org_id]
    try:
        result = subprocess.run(command, input=REMOTE_LOOKUP_SCRIPT, text=True,
                                capture_output=True, env=environment, timeout=30)
    except (OSError, subprocess.SubprocessError):
        raise RuntimeError('Could not look up the Party repository through the configured Kubernetes context.') from None
    if result.returncode:
        raise RuntimeError('Could not look up the Party repository through the configured Kubernetes context.')
    try:
        binding = json.loads(result.stdout)
    except (ValueError, TypeError):
        raise RuntimeError('The Party repository lookup returned an unusable response.') from None
    if not isinstance(binding, dict) or binding.get('error'):
        raise RuntimeError('The Party organization was not found or its repository could not be looked up.')
    if binding.get('org_id') != org_id or binding.get('org_status') != 'active':
        raise ValueError('The requested Party organization is unavailable.')
    try:
        tenant_id = _uuid(binding.get('tenant_id'))
    except ValueError:
        raise ValueError('The Party organization has no usable default tenant.') from None
    hosting_org, name = binding.get('hosting_org'), binding.get('repository_name')
    if (not isinstance(hosting_org, str) or hosting_org.lower() != 'party-internal'
            or not isinstance(name, str)
            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', name)):
        raise ValueError('The Party organization does not have a managed repository in Party-Internal.')
    repository_id = binding.get('repository_id')
    if (binding.get('state') != 'ready' or type(repository_id) is not int
            or repository_id <= 0 or binding.get('actions_enabled') is not True):
        raise ValueError('The Party-managed repository is not ready with GitHub Actions enabled.')
    return {'org_id': org_id, 'tenant_id': tenant_id,
            'repo': f'{hosting_org}/{name}', 'repository_id': repository_id}
