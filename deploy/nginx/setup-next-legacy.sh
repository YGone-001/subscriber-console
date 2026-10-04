#!/bin/bash
# TEMPORARY
# LOCAL DEVELOPMENT / EXPLICIT ROLLBACK ONLY
# NOT PRODUCTION ARCHITECTURE AUTHORITY
# REMOVE UPON SUBSEQUENT RETIREMENT
#
# Setup Nginx edge router for xCloud with legacy Next.js UI upstream
# Usage: sudo ./deploy/nginx/setup-next-legacy.sh [listen_port]
# Requires: nginx installed (apt install nginx)
#
# Ownership model installed by this script:
#   API upstream: http://127.0.0.1:18888 (Go)
#   UI upstream:  http://127.0.0.1:13333 (Next.js - legacy/rollback)
#   HMR upstream: http://127.0.0.1:13333 (Next.js HMR)

set -euo pipefail

echo "WARNING: This configuration is TEMPORARY for local development or explicit rollback only."
echo "         It is NOT the authoritative production architecture."

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NGINX_CONF="$SCRIPT_DIR/xcloud-next-legacy.conf"
SITES_AVAILABLE="/etc/nginx/sites-available/xcloud"
SITES_ENABLED="/etc/nginx/sites-enabled/xcloud"
LISTEN_PORT="${1:-80}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo)."
  exit 1
fi

if ! command -v nginx &>/dev/null; then
  echo "Error: Nginx is not installed. Run: apt install nginx"
  exit 1
fi

sed "s|^    listen 80;|    listen ${LISTEN_PORT};|" "$NGINX_CONF" > "$SITES_AVAILABLE"

rm -f /etc/nginx/sites-enabled/default
ln -sf "$SITES_AVAILABLE" "$SITES_ENABLED"

nginx -t

if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi

echo "Nginx edge router configured with legacy Next.js upstream"
echo "  Config:       $SITES_AVAILABLE"
echo "  Listen:       ${LISTEN_PORT}"
echo "  API upstream: http://127.0.0.1:18888 (Go)"
echo "  UI upstream:  http://127.0.0.1:13333 (Next.js)"
