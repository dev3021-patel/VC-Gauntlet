#!/usr/bin/env bash
# Run just the backend against an explicit DATABASE_URL or DB_* connection.
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-all}" in
  all|migrate|serve) ;;
  *) echo "Usage: backend/run-local.sh [all|migrate|serve]" >&2; exit 2 ;;
esac
export DB_SCHEMA="${DB_SCHEMA:-party_conquest}"
python="${PYTHON:-python3}"
if [[ ! -x .venv/bin/python ]]; then
  "$python" -m venv .venv
  .venv/bin/python -m pip install -r requirements-dev.txt
fi
.venv/bin/python -c 'from app.db import load_db_config; load_db_config()'
if [[ "${1:-all}" != serve ]]; then
  .venv/bin/python -m app.migrate
fi
[[ "${1:-all}" == migrate ]] && exit 0
exec .venv/bin/python -m hypercorn app.main:app --bind "${BACKEND_HOST:-127.0.0.1}:${PORT:-8000}" --access-logfile - --error-logfile -
