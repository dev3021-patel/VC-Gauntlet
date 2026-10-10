# Venture Gauntlet Railway delivery

The public app is one Node process. It serves the built frontend and the `/api` routes. There is no separate frontend service and no database.

## Targets

- Workspace: Party
- Project: Bev! (`e76ec05c-5e83-4654-a492-883de6a01945`)
- Environment: production (`d74e12e8-7a31-48b3-a72e-6ac2fd4a0681`)
- Service: venture-gauntlet (`328ccd44-ef8c-498e-b87b-65503d5e41c8`)
- URL: https://venture-gauntlet-production.up.railway.app
- Health: `GET /api/provider-status`

The attached `RAILWAY_TOKEN` is a project token for Bev!. It cannot create a different Railway project. Do not deploy other services in that project from this workflow.

## Secrets

- `RAILWAY_TOKEN` — Party secret and GitHub Actions secret. Never print or commit it. The workflow passes `secrets.RAILWAY_TOKEN` only into the deploy step environment.
- `OPENAI_API_KEY` — server-side runtime credential. It is not attached to this session and is not set on the Railway service. `/api/provider-status` stays honest (`configured: false`). Debate generation returns `missing_credentials` instead of sample output. Set it with `railway variable set OPENAI_API_KEY=... --service venture-gauntlet` from a secret store, then redeploy. Optional: `OPENAI_BASE_URL`, `GAUNTLET_MODEL`.

## Build and start

From `projects/6db221e81402447b835e925767b72e7a`:

- Install: `npm ci`
- Test: `npm test`
- Build: `npm run build` with `PARTY_OUTPUT_DIR` and `XDG_CACHE_HOME`
- Start: `node scripts/start.mjs` (Railway `PORT`, `HOST=0.0.0.0`)

The image is `Dockerfile` in that directory. Railway config is `railway.json`. CLI version in CI is `@railway/cli@5.64.2`.

## When it deploys

`.github/workflows/venture-gauntlet-railway.yml` runs install, tests, and the production build on relevant pull requests and on `main`. Production deploy runs only after those checks succeed on a `main` push. The deploy job refuses to upload if `HEAD` is no longer `origin/main`. Concurrency group `venture-gauntlet-railway-refs/heads/main` cancels an older in-progress run so it cannot finish over a newer revision.

Unrelated project paths do not trigger this workflow, so they do not become pending checks.

## Database

Runs and Chair chat live in process memory. A restart or new deploy drops them. Do not add a database only for delivery.

If persistence is added later:

1. Add the existing migration command to the deploy job, after checks and before traffic shifts.
2. Point it at the already provisioned Railway database URL. Do not recreate or wipe that database on deploy.
3. Keep the migration idempotent. Fail the release if it fails.

## Recovery

1. Open the failed GitHub Actions run for `Venture Gauntlet Railway`. A failed check blocks deploy.
2. If deploy failed, the previous Railway deployment remains until a successful upload replaces it.
3. Roll back with `railway deployment list --service venture-gauntlet --environment production` and redeploy the last good deployment from the Railway dashboard or CLI. Do not delete the service or its volume-less data store; there is no database to restore.
4. Confirm `GET /api/provider-status` and `POST /api/debate/start` on the public URL. A page response alone is not enough.
