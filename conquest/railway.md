# Deploy your team's Conquest game

Your organizer has already set up a Railway project with PostgreSQL, a backend,
and a frontend. Changes merged into `main` deploy through GitHub Actions using
the project token stored in your repository's secret. Your public game URL is
recorded in the README and linked from successful deployment job summaries.
When launching a Party session, select your team's `conquest` Environment for
the prepared local tools and runtime defaults.

The frontend serves the game and proxies HTTP and WebSocket API traffic to the
backend. Hosted game data lives in your team's PostgreSQL database.

GitHub is not required for a manual deployment. The deployment script uploads
local source with the Railway CLI; Railway builds and hosts the app. Local
setup and gameplay instructions are in [README.md](README.md).

## Deploy local source

Manual deployment is optional and requires a project token supplied securely by
the organizer as `RAILWAY_TOKEN`. Party sessions and the `conquest` Profile do
not supply Railway credentials. Automatic deployments from `main` are already
configured and require no token setup by your team.

Requires Python 3.12+ and Node.js 22.12+ (or a newer supported release).
Install the official Railway CLI (`npm install -g @railway/cli@5.64.2`). With
`RAILWAY_TOKEN` already supplied securely in the environment, run from `conquest/`:

```bash
GITHUB_SHA=<full-40-character-source-commit-sha> \
RAILWAY_PUBLIC_URL=https://your-team.up.railway.app \
python3 scripts/railway_deploy.py
```

The script discovers project/environment IDs from the token, uploads the backend
and frontend, and checks their published version and backend readiness before
reporting success. `GITHUB_SHA` is the release identifier even for local runs.
The source can include the local starter adaptations; this deployment does not
push or require a GitHub commit.

## Automatic deployments from main

Once the organizer installs the workflow and configures its repository secret
and public URL, changes merged into `main` trigger a deployment. Open the
repository's **Actions** tab and select **Deploy Conquest to Railway** to follow
progress. The successful job summary includes your game's public link.

Manual deployment, the initial GitHub Actions deployment, and automatic deployment
after a push to `main` using only the project token were verified on 2026-10-10.
The workflow validates both app
components before publishing and checking the live release.

## Find your game and troubleshoot

Use the `RAILWAY_PUBLIC_URL` supplied by your organizer or the team URL recorded
in your README. You do not need Railway dashboard access to play or deploy.

The deploy script prints the URL after both services publish the expected
revision and readiness passes. In GitHub Actions, it also writes a clickable link
to the job summary, and the production environment links to the same URL.

Useful public checks:

| Endpoint | Expected result |
|---|---|
| `/` | Game loads and reaches **Synced** after joining |
| `/version.json` | Frontend `version` equals the release SHA |
| `/api/healthz` | Backend `version` equals the same SHA |
| `/api/readyz` | `status` is `ok` |

If deployment fails, inspect the build logs linked by the CLI or the GitHub
Actions job output. Ask the organizer to inspect Railway service logs if you do
not have dashboard access. A queued CLI upload alone does not mean the app is
healthy.

- **Token rejected:** for manual deployment, check that the separately supplied
  `RAILWAY_TOKEN` is the team's project token. For GitHub Actions failures, ask
  the organizer to check the repository secret and environment scope.
- **Backend migration or readiness failure:** inspect deployment logs for
  migration errors. Ask the organizer to check database connectivity and service
  configuration if the failure is unrelated to your changes.
- **Frontend 502 or WebSocket failure:** check `/api/readyz` and your backend
  changes. Use the public frontend URL for both gameplay and API traffic. Ask
  the organizer to check private networking if the backend cannot be reached.
- **Version mismatch:** compare the latest successful deployments of both app
  services. Check build logs and rerun the deploy command after resolving the
  failure. Deployments are sequential uploads, not an atomic two-service release.

The upload staging excludes `.git`, `.aws`, `.ssh`, `.codex`, `.env*`, `.venv`,
`.local`, `node_modules`, `dist`, common Python/test caches, and symlinks. Keep any other credentials or
private files outside the source directory as well. Hosted game data lives in
Railway PostgreSQL; the local development database is not uploaded.
