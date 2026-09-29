#!/bin/sh
set -eu

# YouTube breaks old yt-dlp versions every few weeks: pull the latest on
# every container start (the app also re-checks every 12h while running).
# Set RAINY_YTDLP_AUTO_UPDATE=0 to pin the version baked into the image.
if [ "${RAINY_YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  pip install --quiet --upgrade --disable-pip-version-check 'yt-dlp[default]'     || echo "yt-dlp update failed; continuing with the installed version." >&2
fi

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
