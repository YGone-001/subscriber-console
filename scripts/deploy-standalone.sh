#!/bin/bash
# Deploy standalone Next.js build
# Usage: ./scripts/deploy-standalone.sh [port]
# After npm run build, copies public/ and .next/static/ into .next/standalone/
# then starts the standalone server.

set -euo pipefail

PORT="${1:-3000}"
STANDALONE_DIR=".next/standalone"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [ ! -f "$STANDALONE_DIR/server.js" ]; then
  echo "Error: $STANDALONE_DIR/server.js not found. Run 'npm run build' first."
  exit 1
fi

echo "[1/3] Copying public/ → $STANDALONE_DIR/public/"
rm -rf "$STANDALONE_DIR/public"
cp -r public "$STANDALONE_DIR/public"

echo "[2/3] Copying .next/static/ → $STANDALONE_DIR/.next/static/"
rm -rf "$STANDALONE_DIR/.next/static"
cp -r .next/static "$STANDALONE_DIR/.next/static"

echo "[3/3] Starting standalone server on port $PORT..."
export PORT
exec node "$STANDALONE_DIR/server.js"
