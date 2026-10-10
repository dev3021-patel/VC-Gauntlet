# Venture Gauntlet preview and local runtime

Run commands from `projects/6db221e81402447b835e925767b72e7a` with Node 22.12+ or Node 24 (matching package engines):

```bash
export XDG_CACHE_HOME="$PWD/.skipper/cache"
npm ci
npm test
npm run dev -- --port <allocated-port> --strictPort
```

The dev server binds `127.0.0.1`. Set `VITE_HMR_CLIENT_PORT=443` when Party Preview proxies Vite. No database is required. `/api/provider-status` reports server configuration without exposing the key.

The approved five-screen mock demo is the default entry (`/?mode=demo`). `/?mode=live` opens the real API workflow with independent openings, debate recovery, assessment reports, and post-verdict Chair chat. The experience navigation identifies sample versus live data. The demo never calls the debate API.

For the built application, the same API handler runs in a project-local Node server:

```bash
export PARTY_OUTPUT_DIR="$PWD/.skipper/build"
npm run build
PORT=<allocated-port> npm start
```

`build` writes frontend files under `$PARTY_OUTPUT_DIR/client` and the server bundle at `$PARTY_OUTPUT_DIR/server.mjs`. Without `PARTY_OUTPUT_DIR`, it uses `dist`. `start` must use the same output variable as the build. It binds localhost only. Party Preview can run `env PORT=<port> PARTY_OUTPUT_DIR=<project-output-path> XDG_CACHE_HOME=<project-cache-path> npm start` after building. Use `party preview start` for that command change, then `party preview ensure` for later refreshes. Never expose a port through another tunnel.

`OPENAI_API_KEY` stays server-side. `OPENAI_BASE_URL` and `GAUNTLET_MODEL` are optional. Missing credentials and provider errors remain explicit retryable failures; no sample debate is substituted. Runs and separate Chair chat histories are stored in server memory and reset when that server restarts. This runtime is locally verified; no cloud deployment is part of this change.

Project checks are committed in `.party/checks.json`. npm and Vite use project-specific subdirectories of `XDG_CACHE_HOME`; set it inside this project for local work as shown above.
