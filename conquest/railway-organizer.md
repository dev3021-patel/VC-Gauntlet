# Railway setup for hackathon organizers

Complete this setup before handing a team its Conquest starter. The team's
project token is installed as repository secret `RAILWAY_TOKEN`; the public URL
is recorded in its README and repository variable `RAILWAY_PUBLIC_URL`. Teams
can deploy through GitHub Actions without handling either an organizer API token
or a project token. Their deployment instructions are in
[railway.md](railway.md).

Provisioning, local deployment, the initial GitHub Actions deployment, and
automatic deployment from `main` were verified on 2026-10-10.

## Run the provisioning script

Use `scripts/provision_team.py` from the prepared starter. It copies this local
setup into the target Party-managed repository at `/conquest`, provisions the
team's Railway services, installs the root GitHub Actions workflow, sets its
project-token secret and public URL variable, and waits for the initial deployment.
In org mode it then adds that managed repository to the seeded `conquest` Party
Environment, builds its image, and promotes the successful build for new sessions.
Its attached `conquest` Profile keeps only local runtime defaults.

Once the organizer profile is configured, supply the Party org ID. For Party-managed repos, explicitly authorize the initial protected-branch setup:

```bash
python3 conquest/scripts/provision_team.py --org-id PARTY_ORG_UUID --allow-protected-bootstrap
```

The script looks up the org's default tenant and authoritative repository binding
through the Party control plane. It requires an active org, a ready managed
repository binding, and a GitHub repository whose ID matches that binding. It
does not infer a repository from its name or create a replacement repository.

The target org must already contain exactly one saved Environment named
`conquest` and one Profile named `conquest`, with that Profile attached to the
Environment. Seed both from the organizer's prepared Conquest base when creating
the orgs. Missing or ambiguous seeds stop provisioning before paid resources are
created. Dependencies, local runtime defaults, other Profiles, and custom steps
from the seed remain intact.

Requires Python 3.12+, `git`, authenticated `gh`, `kubectl`, and working AWS/EKS
credentials on macOS or Linux. The organizer needs permission to execute a
read-only repository lookup in the Party control-plane pod. These credentials
stay on the organizer's machine; teams do not need cluster access.
The final Environment step uses the organizer's own authenticated Party CLI
sign-in and Party's API. Sign in to the Party deployment that serves the target
orgs with `party login`; the organizer must be an active owner or admin in each
target org. The script selects each authorized org per request and verifies its
tenant without changing the CLI's saved organization selection. API permission
failures stop the script; Environment writes do not fall back to cluster access.
The target repository must already exist, have `main` as its default branch,
and allow GitHub Actions. The GitHub identity needs permission to publish to `main`,
write workflow files, set repository Actions secrets and variables, and dispatch
and read workflow runs. Party-managed repos require a PR and `party/acceptance`, including for admins.
`--allow-protected-bootstrap` authorizes the initial setup only: create a setup
PR, briefly disable admin enforcement, merge its exact head, and restore admin
enforcement in a `finally` block. Other protection settings stay intact. GitHub
admin access is required. Without this flag, a protected target stops before
Railway resources are created. A checkpoint records restoration intent before
the bypass; after an interrupted process, rerun immediately to restore protection.
Later team changes continue through the normal Party acceptance flow. A completed
checkpoint can be resumed without the flag. Rulesets or environment approval rules
may still require repository-specific setup.

The script reads the organizer profile from
`~/.config/party-conquest/organizer.json`. Keep this file private, with mode `0600`,
outside any Git repository. It contains:

```json
{
  "railway_workspace_id": "YOUR_RAILWAY_WORKSPACE_ID",
  "railway_api_token": "YOUR_ORGANIZER_WORKSPACE_API_TOKEN"
}
```

Create a workspace API token in Railway's account token settings, selecting the
workspace where team projects belong. This token can provision projects and mint
their project tokens, so keep it with the organizer. Each repository receives
its own production-scoped project token as an Actions secret. The script does
not print either token.

Use `--config PATH` or `PARTY_CONQUEST_CONFIG` for another private profile.
`RAILWAY_API_TOKEN` overrides the profile's token; `--workspace-id` or
`RAILWAY_WORKSPACE_ID` overrides its workspace ID. The optional profile fields
`party_kube_context`, `party_namespace`, and `party_deployment` select a different
Party control plane. The defaults target the existing production EKS context
`arn:aws:eks:us-west-2:381491909731:cluster/maitai-prod`, namespace `skipper`, and
deployment `skipper-skipper-control-plane`. Those existing names are legacy
compatibility boundaries. Each lookup explicitly selects the context rather
than relying on the current kubectl context.

The Party CLI package must be available to the Python interpreter running the
script. If using a Party source checkout instead of an installed CLI, set the
optional private profile field `party_cli_source` to the absolute path of its
`worker` directory. The script reuses the CLI's private saved sign-in; do not add
a Party access token to the organizer JSON or starter files.

The optional `party_api_url` selects the API origin for the target orgs when it
differs from the CLI's saved deployment. For public hackathon orgs, set it to
`https://app.party.build`. It must be a nonempty HTTPS origin with no embedded
credentials, path, query, or fragment, and must use the same authentication realm
as the saved CLI sign-in. The script routes only its own API client through this
origin; the CLI's saved URL, selected organization, and token refresh remain
unchanged. If omitted, it uses the CLI's saved API URL.

The per-org checkpoint defaults to
`~/.local/state/party-conquest/teams/PARTY_ORG_UUID.json`. `--state PATH` can override
it. The checkpoint binds the org and its resolved repository to the Railway
workspace and provisioning resources; a later lookup that resolves differently
requires reconciliation before resuming.

For standalone repositories and tests, the original explicit repository mode
is also supported:

```bash
python3 conquest/scripts/provision_team.py \
  --repo TARGET_ORG/PARTY_MANAGED_REPO \
  --workspace-id YOUR_RAILWAY_WORKSPACE_ID \
  --state "$HOME/.party-provisioning/TARGET_ORG-team.json"
```

Add `--dry-run` to inspect the plan without writing files, creating resources, or
deploying. Explicit repository mode provisions Railway and GitHub only; it does
not modify a Party Environment or Profile. Org mode performs the read-only Party
repository lookup; explicit repository mode can inspect the plan offline.
`--source` selects another prepared starter; the default is the `conquest`
directory containing the script. `--region` defaults to `us-west2` and must stay
the same when resuming.

The script refuses to replace an existing `/conquest`. Use `--replace-conquest`
only when deliberately replacing that starter; unrelated repository files stay
intact. A conflicting root `conquest-railway.yml` is always rejected.

The initial commit includes `[skip ci]`, then the script explicitly dispatches
one workflow with a unique setup identifier and expected commit. Subsequent
ordinary pushes to `main` deploy automatically. The workflow validates the
frontend and backend against a disposable PostgreSQL database before deploying
with the team's project token. Successful output includes the public game URL,
workflow link, project/environment IDs, and commit; tokens are never printed.

After that public release is verified, org mode preserves the seeded Profile's
local runtime defaults and adds the managed repository to the Environment. It
does not put Railway tokens, IDs, or the public URL in that Profile. GitHub Actions
uses the production-scoped project token from the repository secret; the
organizer workspace token stays local. The new Environment repository setup runs the
existing Conquest dependency bootstrap under `/conquest` without starting game
servers. A build must succeed with a published image before it is promoted.

The private checkpoint contains the project token and database password and is
written with mode `0600`. Keep it outside Git repositories and back it up in your
organizer secret store. Use a different checkpoint per team. Rerun the same
command and checkpoint to resume after a failure; already-published team code is
not replaced. Resources remain available for inspection after failures.

If a token-creation response is lost, the script stops rather than minting more
tokens. Inspect Railway, revoke the orphan token, then clear
`token_request_pending` in the private checkpoint before resuming. If workflow
dispatch fails ambiguously, inspect Actions for the stored setup identifier;
only clear `dispatch_requested` after confirming no run was accepted. If `main`
moves during setup, the workflow's revision guard prevents deploying an
unexpected commit and the script stops for reconciliation.

Interrupted Party version saves and build requests reuse persisted receipt and
idempotency keys. A failed or cancelled Environment build stops that invocation;
after inspecting its logs and repairing the cause, rerun the same command to
request one new build. Queued or running builds are resumed instead of duplicated.
The script checks the latest version and promoted build again before promotion.
If another administrator changes either during setup, reconcile that change
before resuming so their newer Environment is not replaced.

Automated provisioning/deployment tests cover controlled-API recovery, repository
binding validation, and a real temporary Git repository. A live run created a fresh project,
minted its project token, installed the repository secret and workflow, and
published the app from GitHub Actions. Repeating the same command reused the
project, services, token, commit, and successful workflow run.

The live run below used explicit repository mode. Org lookup is checked against
Party's authoritative binding and covered by automated tests; it has not yet
provisioned a live team's managed repository. This script does not create Party
orgs or change their Pro plan or credits. It does not add Railway values to Party
Profiles. Org mode includes the final Environment build/promotion while
preserving the seeded Profile; the additional step is covered by controlled API
tests until a live team run verifies it.

## Provision a team project

The organizer first creates one Railway project per team, with a `production`
environment and these services:

| Service | Configuration |
|---|---|
| `Postgres` | Railway PostgreSQL template with a persistent volume; keep its default generated credentials |
| `backend` | Dockerfile `Dockerfile`, port 8000, pre-deploy `python -m app.migrate`, start `hypercorn app.main:app --bind '[::]:8000'`, healthcheck `/readyz` |
| `frontend` | Dockerfile `deploy/Dockerfile.frontend`, port 8080, healthcheck `/api/readyz`, generated public domain |

Set backend variables `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
`DB_SCHEMA=party_conquest`, `PORT=8000`, `APP_ENV=production`, and
`WORLD_OWNERSHIP=shared`. Set frontend variables
`BACKEND_UPSTREAM=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:8000` and `PORT=8080`.
Run one replica per app service and disable service sleeping. Shared world
ownership allows deployment overlap; the default exclusive mode would block a
new backend from becoming ready while the previous process owns the world.

Only the frontend needs a public domain. It serves the game and proxies `/api`
HTTP and WebSocket traffic to the private backend. PostgreSQL stays private.

## Create the project token

An organizer **workspace API token** can create the team's project token using
`projectTokenCreate`, with the project's ID, production environment ID, and a
name. This was verified against the live API. Project tokens and the CLI OAuth
session tested here cannot mint project tokens. Store the resulting
production-scoped token as repository Actions secret `RAILWAY_TOKEN`; keep the
workspace token with the organizer.

The verified API endpoint is `https://backboard.railway.com/graphql/v2`.
Send this GraphQL mutation with `Authorization: Bearer <organizer-workspace-token>`,
`Content-Type: application/json`, and a descriptive `User-Agent` such as
`party-conquest-provisioner/1.0`:

```graphql
mutation CreateTeamToken($input: ProjectTokenCreateInput!) {
  projectTokenCreate(input: $input)
}
```

Variables:

```json
{
  "input": {
    "projectId": "<team-project-id>",
    "environmentId": "<production-environment-id>",
    "name": "party-conquest-team-deploy"
  }
}
```

`data.projectTokenCreate` is the token itself. Store it directly in your secret
store; do not print the response into logs or commit it to the repository.
For subsequent API calls using this project token, use the header
`Project-Access-Token: <project-token>`. The deployment script uses this to query
`projectToken { projectId environmentId }` and selects the correct deployment target.

Project provisioning needs organizer access. The team token is sufficient for
deploying to its configured environment after the services exist. The deploy
script does not create a project, services, database, or token.

## Configure automatic deployments and hand off

Install `deploy/github/railway.yml` at the team repository root as
`.github/workflows/conquest-railway.yml`. It assumes the starter is under
`/conquest`. Set the repository secret `RAILWAY_TOKEN` to the team's project token
and repository variable `RAILWAY_PUBLIC_URL` to its generated frontend HTTPS URL.
A Party environment Profile holds local runtime defaults; GitHub Actions uses
its separately configured repository secret. For optional manual deployments,
the organizer must supply a project token securely to that process separately.

The provisioning script runs the initial GitHub deployment. For manual setup,
run the local deployment commands in [railway.md](railway.md).
Record the team's public URL in its README. Verify readiness, matching release
versions, and gameplay before handoff. The workflow runs on pushes to `main` and
manual dispatch. Its initial deployment was verified against a fresh private
repository, with 286 frontend tests and 205 backend/deployment tests passing.

## Configuration compatibility

The included `railway.json` files currently work, but Railway marks this format
deprecated and reports support ending on 2026-12-01. Use the equivalent service
settings above, or migrate to Railway Infrastructure as Code before that date.

## Verified test deployment

The starter based on upstream `6e8f78c8b65b5c2f540952e0d7ae0e99c15a6dbc`
was uploaded locally using its project token into `party-conquest-provisioning-test`.
All 38 migrations ran. Public version/readiness checks, registration, movement,
snapshot persistence, WebSocket replay, browser synchronization, and respawn passed.

Test game: **https://frontend-production-c246.up.railway.app**.
This is the organizer's verification deployment, not a team's assigned project.
Each team's provisioning result should record its own generated URL in the
team's README and `RAILWAY_PUBLIC_URL` variable.

The full provisioning run was also verified using
[Maitai-Inc/party-conquest-railway-e2e-test](https://github.com/Maitai-Inc/party-conquest-railway-e2e-test).
The [initial GitHub Actions run](https://github.com/Maitai-Inc/party-conquest-railway-e2e-test/actions/runs/38053847705)
published `c61942d48074100495e17c234b96ca005d6f665f` to
<https://frontend-production-c1067.up.railway.app>. Both public versions matched
that commit, backend readiness passed, and rerunning provisioning did not create
duplicate resources or dispatch another workflow.

An ordinary push to `main` then triggered
[the automatic deployment run](https://github.com/Maitai-Inc/party-conquest-railway-e2e-test/actions/runs/38054453963).
It passed the same 286 frontend and 205 backend/deployment tests and published
`7758859ca9f5024fcf7f700748f9cae863baee05` at the same URL. The organizer's
temporary workspace token had already been revoked; this deployment used only
the team's project token. Both public versions matched the new commit and all
three services remained healthy.

