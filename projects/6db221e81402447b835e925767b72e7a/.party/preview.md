# Venture Gauntlet preview

From `projects/6db221e81402447b835e925767b72e7a`:

```bash
export XDG_CACHE_HOME="$PWD/.skipper/cache"
npm ci
npm test
npm run dev -- --port <allocated-port> --strictPort
```

The dev server binds `127.0.0.1`. Set `VITE_HMR_CLIENT_PORT=443` when Party Preview proxies the app. `/api/provider-status` reports whether `OPENAI_API_KEY` is set. It never returns the key. No database or other service is required for the foundation UI.

Project checks are committed in `.party/checks.json`. Builds honor `PARTY_OUTPUT_DIR` (default `dist`); npm and Vite use project-specific subdirectories of `XDG_CACHE_HOME`. Keep that cache path inside this project for local work, as shown above.
