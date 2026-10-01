#!/usr/bin/env bash
# ============================================================
#  xCloud subscriber-console - backend (Go API) startup
#  Linux / macOS / Git Bash launcher. The API service binds loopback
#  only, so the browser entry point stays the Nginx edge. The script
#  resolves its own directory; no absolute path is hard-coded.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================================"
echo "  xCloud subscriber-console - backend (Go API)"
echo "============================================================"
echo

require_numeric() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    return 0
}

# ---- 1. Locate the Go toolchain ----
if ! command -v go >/dev/null 2>&1; then
    echo "[ERROR] Go was not found in PATH."
    echo "        Install Go 1.24 or newer, then run this script again."
    exit 1
fi

GO_VERSION_RAW="$(go version)"
GO_VERSION="${GO_VERSION_RAW##*go}"
GO_VERSION="${GO_VERSION%% *}"
GO_MAJOR="${GO_VERSION%%.*}"
GO_MINOR="${GO_VERSION#*.}"
GO_MINOR="${GO_MINOR%%.*}"

if ! require_numeric "$GO_MAJOR" || ! require_numeric "$GO_MINOR"; then
    echo "[ERROR] Could not determine the Go version."
    exit 1
fi
if [ "$GO_MAJOR" -lt 1 ] || { [ "$GO_MAJOR" -eq 1 ] && [ "$GO_MINOR" -lt 24 ]; }; then
    echo "[ERROR] Go $GO_VERSION is too old. Go 1.24 or newer is required."
    exit 1
fi
echo "[1/4] Go $GO_VERSION"

# ---- 2. Load the repository environment ----
ENV_FILE="../.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "[ERROR] Environment file not found: $ENV_FILE"
    echo "        Copy .env.example to .env at the repository root and set JWT_SECRET."
    exit 1
fi

# The repository .env is a plain KEY=value file, so it can be sourced directly.
# Everything it defines is exported to the Go process.
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ -z "${JWT_SECRET:-}" ]; then
    echo "[ERROR] JWT_SECRET is not set in $ENV_FILE"
    echo "        The Go backend fails closed without a secret of at least 32 bytes."
    exit 1
fi
if [ "$JWT_SECRET" = "replace-with-64-hex-character-secret" ]; then
    echo "[ERROR] JWT_SECRET is still the placeholder value."
    echo "        Generate one with: openssl rand -hex 32"
    exit 1
fi
if [ "${#JWT_SECRET}" -lt 32 ]; then
    echo "[ERROR] JWT_SECRET must be at least 32 bytes, got ${#JWT_SECRET}."
    exit 1
fi
if [ -n "${HTTP_ADDR:-}" ] && [ "${HTTP_ADDR#127.0.0.1}" = "$HTTP_ADDR" ]; then
    echo "[ERROR] HTTP_ADDR must bind loopback. Got: $HTTP_ADDR"
    echo "        The Nginx edge is the only public origin."
    exit 1
fi
echo "[2/4] Environment loaded from $ENV_FILE"

# ---- 3. Resolve Go module dependencies ----
echo "[3/4] Resolving Go module dependencies..."
go mod download || { echo "[ERROR] go mod download failed."; exit 1; }

# ---- 4. Start the API service ----
DISPLAY_ADDR="${HTTP_ADDR:-127.0.0.1:18888}"

echo "[4/4] Starting the Go API service..."
echo
echo "  API service   : $DISPLAY_ADDR (loopback, internal only)"
echo "  Health probe  : http://$DISPLAY_ADDR/healthz"
echo "  Browser entry : http://localhost (Nginx edge)"
echo "  Stop with Ctrl+C"
echo
exec go run ./cmd/server
