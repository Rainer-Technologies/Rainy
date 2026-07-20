#!/bin/sh
set -eu

# Set up or migrate the schema before Gunicorn accepts requests.
attempt=1
max_attempts="${DATABASE_INIT_MAX_ATTEMPTS:-30}"
while ! python -c '
import sys
from app import init_app

try:
    init_app()
except Exception as err:
    print(f"Database initialization error: {err}", file=sys.stderr)
    sys.exit(1)
'; do
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "Database initialization failed after ${max_attempts} attempts." >&2
    exit 1
  fi

  echo "Database is not ready; retrying in 2 seconds (${attempt}/${max_attempts})..." >&2
  attempt=$((attempt + 1))
  sleep 2
done

exec "$@"
