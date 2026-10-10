# Local Preview

Conquest keeps its own instructions in `conquest/.party/preview.md`.
Venture Gauntlet lives in `projects/6db221e81402447b835e925767b72e7a`.

## Venture Gauntlet

Install and check from that project directory:

```bash
npm ci
npm test
npm run build
```

Start the dev server on a Party-allocated port:

```bash
VITE_HMR_CLIENT_PORT=443 npm run dev -- --port <port> --host 127.0.0.1 --strictPort
```

No database is required. `OPENAI_API_KEY` is optional and read only by the server. `/api/provider-status` reports whether it is set and never returns the value. `GAUNTLET_MODEL` and `OPENAI_BASE_URL` are optional. The app binds localhost only.
