#!/usr/bin/env bash
# ============================================================
#  xCloud subscriber-console - frontend (Next.js UI) startup
#  Linux / macOS / Git Bash launcher. The UI service binds loopback
#  only, so the browser entry point stays the Nginx edge. The script
#  resolves its own directory; no absolute path is hard-coded.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================================"
echo "  xCloud subscriber-console - frontend (Next.js UI)"
echo "============================================================"
echo

require_numeric() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    return 0
}

# ---- 1. Locate the Node.js toolchain ----
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js was not found in PATH."
    echo "        Install Node.js 20.19.0 or newer, then run this script again."
    exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm was not found in PATH."
    echo "        Install Node.js 20.19.0 or newer, then run this script again."
    exit 1
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_MINOR%%.*}"

if ! require_numeric "$NODE_MAJOR" || ! require_numeric "$NODE_MINOR"; then
    echo "[ERROR] Could not determine the Node.js version."
    exit 1
fi
if [ "$NODE_MAJOR" -lt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -lt 19 ]; }; then
    echo "[ERROR] Node.js $NODE_VERSION is too old. 20.19.0 or newer is required."
    exit 1
fi
echo "[1/4] Node.js $NODE_VERSION"

# ---- 2. Ensure frontend dependencies ----
if [ -d node_modules ]; then
    echo "[2/4] Dependencies already installed"
else
    echo "[2/4] Installing frontend dependencies..."
    if [ -f package-lock.json ]; then
        npm ci || { echo "[ERROR] Dependency installation failed."; exit 1; }
    else
        npm install || { echo "[ERROR] Dependency installation failed."; exit 1; }
    fi
fi

# ---- 3. Local environment file ----
if [ -f .env ]; then
    echo "[3/4] .env already present"
elif [ -f ../.env ]; then
    cp ../.env .env
    echo "[3/4] .env created from the repository root .env"
else
    echo "[3/4] No .env found, the UI keeps its built-in defaults"
fi

# ---- 4. Start the development server ----
echo "[4/4] Starting the Next.js development server..."
echo
echo "  UI service    : 127.0.0.1:13333 (loopback, internal only)"
echo "  Browser entry : http://localhost (Nginx edge)"
echo "  Stop with Ctrl+C"
echo
exec npm run dev
