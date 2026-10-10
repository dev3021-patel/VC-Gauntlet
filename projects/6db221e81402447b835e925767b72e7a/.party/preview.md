# Venture Gauntlet preview

From `projects/6db221e81402447b835e925767b72e7a`:

```bash
npm ci
npm test
npm run dev -- --port <allocated-port> --strictPort
```

The dev server binds `127.0.0.1`. Set `VITE_HMR_CLIENT_PORT=443` when Party Preview proxies the app. `/api/provider-status` reports whether `OPENAI_API_KEY` is set. It never returns the key. No database or other service is required for the foundation UI.
