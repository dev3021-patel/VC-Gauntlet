# Venture Gauntlet preview and local runtime

Run commands from `projects/6db221e81402447b835e925767b72e7a` with Node 22.12+ or Node 24 (matching package engines):

```bash
export XDG_CACHE_HOME="$PWD/.skipper/cache"
npm ci
npm test
npm run dev -- --port <allocated-port> --strictPort
```

The dev server binds `127.0.0.1`. Set `VITE_HMR_CLIENT_PORT=443` when Party Preview proxies Vite. No database is required. `/api/provider-status` reports server configuration without exposing the key.

The five-screen committee UI is the default entry (`/`). It runs a live `/api/debate/*` debate by default and only shows sample data after the user presses **Use demo data**; a live failure never falls back to demo data. `/?mode=console` (alias `/?mode=live`) opens the single-page live transcript console with independent openings, debate recovery, assessment reports, and post-verdict Chair chat. The experience navigation identifies both entries.

For the built application, the same API handler runs in a project-local Node server:

```bash
export PARTY_OUTPUT_DIR="$PWD/.skipper/build"
npm run build
PORT=<allocated-port> npm start
```

`build` writes frontend files under `$PARTY_OUTPUT_DIR/client` and the server bundle at `$PARTY_OUTPUT_DIR/server.mjs`. Without `PARTY_OUTPUT_DIR`, it uses `dist`. `start` must use the same output variable as the build. It binds localhost only. Party Preview can run `env PORT=<port> PARTY_OUTPUT_DIR=<project-output-path> XDG_CACHE_HOME=<project-cache-path> npm start` after building. To pass the provider key, never let the calling shell expand it into the preview command, because `party preview status` echoes the stored command verbatim; wrap it so expansion happens inside the child process: `party preview start --port <port> -- sh -c 'OPENAI_API_KEY="$SECRET_OPENAI_API_KEY" PORT=<port> PARTY_OUTPUT_DIR=<path> XDG_CACHE_HOME=<path> npm start'` (single quotes). Use `party preview start` for that command change, then `party preview ensure` for later refreshes. Never expose a port through another tunnel.

`OPENAI_API_KEY` stays server-side. `OPENAI_BASE_URL` and `GAUNTLET_MODEL` are optional. Missing credentials and provider errors remain explicit retryable failures; no sample debate is substituted. Runs and separate Chair chat histories are stored in server memory and reset when that server restarts. This runtime is locally verified; no cloud deployment is part of this change.

Project checks are committed in `.party/checks.json`. npm and Vite use project-specific subdirectories of `XDG_CACHE_HOME`; set it inside this project for local work as shown above.
