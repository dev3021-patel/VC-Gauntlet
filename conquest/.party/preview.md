# Team-local Preview

Run `PREVIEW_PORT=<allocated-port> VITE_HMR_CLIENT_PORT=443 ./scripts/dev.sh`
from `conquest/` for a Party HTTPS Preview. The frontend proxies `/api` HTTP and
WebSocket requests to the local backend. For direct localhost access, omit the
HMR override. See `../README.md` for installation and persistence details.

Each team uses its own PostgreSQL database. Never attach original production
credentials or point this starter at the original game's database/API. The
launcher accepts `DATABASE_URL` for a team-owned connection; otherwise it starts
native PostgreSQL or Docker locally. No AWS or Redis is used.
