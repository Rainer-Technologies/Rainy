#!/usr/bin/env bash

# Prevent execution if sourced to protect the parent shell
if [ -n "${BASH_SOURCE[0]}" ] && [ "${BASH_SOURCE[0]}" != "$0" ]; then
    echo "[ERROR] start.sh should be executed, not sourced. Run: ./start.sh"
    return 1 2>/dev/null || exit 1
fi

# Set terminal window/tab title if interactive
if [ -t 1 ]; then
    printf '\033]0;%s\007' "Rainy Music Server"
fi

echo "=============================================="
echo "  Rainy Music Server Launcher"
echo "=============================================="
echo ""

# Resolve project root directory
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$ROOT" || {
    echo "[ERROR] Failed to change directory to project root: $ROOT"
    exit 1
}

VENV_DIR="$ROOT/.venv"
VENV_PY="$VENV_DIR/bin/python"
VENV_PIP="$VENV_DIR/bin/pip"

check_python_version() {
    "$1" -c 'import sys; exit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1
}

resolve_system_python() {
    # If PYTHON environment variable was set by user, honor it
    if [ -n "$PYTHON" ] && command -v "$PYTHON" >/dev/null 2>&1; then
        if check_python_version "$PYTHON"; then
            echo "$PYTHON"
            return 0
        fi
    fi

    # Check candidates for Python >= 3.11 (prefer 3.12/3.11 for ML/binary wheel stability)
    for candidate in python3.12 python3.11 python3.13 python3 python; do
        if command -v "$candidate" >/dev/null 2>&1; then
            if check_python_version "$candidate"; then
                echo "$candidate"
                return 0
            fi
        fi
    done

    return 1
}

# Check for .venv directory
if [ ! -d "$VENV_DIR" ]; then
    echo "[INFO] Virtual environment not found. Creating .venv..."
    SYSTEM_PY="$(resolve_system_python)"
    if [ $? -ne 0 ] || [ -z "$SYSTEM_PY" ]; then
        echo "[ERROR] Python 3.11+ not found. Install Python 3.11+ and add it to PATH."
        for cmd in python3 python; do
            if command -v "$cmd" >/dev/null 2>&1; then
                echo "        Found $($cmd --version 2>&1) at $(command -v "$cmd")."
                break
            fi
        done
        echo "        macOS: brew install python"
        echo "        Linux (Debian/Ubuntu): sudo apt update && sudo apt install python3 python3-venv python3-pip"
        echo "        Download: https://www.python.org/downloads/"
        exit 1
    fi

    "$SYSTEM_PY" -m venv "$VENV_DIR"
    if [ $? -ne 0 ] || [ ! -x "$VENV_PY" ]; then
        echo "[ERROR] Failed to create virtual environment."
        echo "        Make sure Python 3.11+ is installed with the venv module."
        echo "        On Debian/Ubuntu systems, you may need: sudo apt install python3-venv"
        exit 1
    fi
    echo "[INFO] Virtual environment created successfully."
    echo ""
elif [ ! -x "$VENV_PY" ] || ! check_python_version "$VENV_PY"; then
    echo "[WARNING] Existing .venv is invalid, non-executable, or Python < 3.11."
    echo "[INFO] Recreating .venv for Linux/macOS..."
    rm -rf "$VENV_DIR"
    SYSTEM_PY="$(resolve_system_python)"
    if [ $? -ne 0 ] || [ -z "$SYSTEM_PY" ]; then
        echo "[ERROR] Python 3.11+ not found. Install Python 3.11+ and add it to PATH."
        exit 1
    fi

    "$SYSTEM_PY" -m venv "$VENV_DIR"
    if [ $? -ne 0 ] || [ ! -x "$VENV_PY" ]; then
        echo "[ERROR] Failed to create virtual environment."
        exit 1
    fi
    echo "[INFO] Virtual environment created successfully."
    echo ""
fi

# Keep dependencies in sync (fast no-op when already satisfied)
echo "[INFO] Checking requirements..."
"$VENV_PY" -m pip install -q -r requirements.txt
if [ $? -ne 0 ]; then
    echo "[ERROR] Failed to install requirements."
    echo "        Try running manually: \"$VENV_PY\" -m pip install -r requirements.txt"
    exit 1
fi

# Check for .env file, copy from .env.example if missing
if [ ! -f "$ROOT/.env" ]; then
    if [ ! -f "$ROOT/.env.example" ]; then
        echo "[WARNING] Neither .env nor .env.example found!"
    else
        echo "[INFO] .env file not found. Copying from .env.example..."
        cp "$ROOT/.env.example" "$ROOT/.env"
        chmod 600 "$ROOT/.env" 2>/dev/null || true
    fi
fi

# Ensure FLASK_SECRET_KEY in .env is initialized with a secure random key
if [ -f "$ROOT/.env" ]; then
    "$VENV_PY" -c '
import re, secrets
env_path = ".env"
try:
    with open(env_path, "r") as f:
        content = f.read()
    match = re.search(r"^FLASK_SECRET_KEY=(.*)$", content, re.M)
    weak = {"", "dev-secret-key-change-in-production", "change-this-to-a-long-random-value"}
    if not match or match.group(1).strip() in weak or len(match.group(1).strip()) < 32:
        new_key = secrets.token_hex(32)
        if match:
            new_content = re.sub(r"^FLASK_SECRET_KEY=.*$", f"FLASK_SECRET_KEY={new_key}", content, flags=re.M)
        else:
            new_content = content + f"\nFLASK_SECRET_KEY={new_key}\n"
        with open(env_path, "w") as f:
            f.write(new_content)
        print("[INFO] Generated secure FLASK_SECRET_KEY in .env")
except Exception:
    pass
'
fi

# Launch server
if [ "${RAINY_USE_GUNICORN:-0}" = "1" ] || [ "${1:-}" = "--gunicorn" ]; then
    if [ "${1:-}" = "--gunicorn" ]; then
        shift
    fi
    echo "[INFO] Initializing application database..."
    "$VENV_PY" -c 'from app import init_app; init_app()'
    echo "[INFO] Starting Rainy Music Server with Gunicorn..."
    echo ""
    PORT="${RAINY_HTTP_PORT:-${RAINY_PORT:-6969}}"
    WORKERS="${RAINY_GUNICORN_WORKERS:-2}"
    # Every Rainy Connect device holds one request open (its command stream),
    # on top of the audio streams, so a handful per worker is not enough.
    THREADS="${RAINY_GUNICORN_THREADS:-16}"
    TIMEOUT="${RAINY_GUNICORN_TIMEOUT:-120}"
    exec "$VENV_DIR/bin/gunicorn" --bind "0.0.0.0:${PORT}" --workers "${WORKERS}" --threads "${THREADS}" --timeout "${TIMEOUT}" "app:app" "$@"
else
    echo "[INFO] Starting Rainy Music Server..."
    echo ""
    exec "$VENV_PY" app.py "$@"
fi

echo "[ERROR] Failed to start server." >&2
exit 1
