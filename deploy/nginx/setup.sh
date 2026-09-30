#!/bin/bash
# Setup Nginx edge router for xCloud
# Usage: sudo ./deploy/nginx/setup.sh [listen_port]
# Requires: nginx installed (apt install nginx)
#
# Ownership model installed by this script:
#   /api and /api/*  -> Go backend   (127.0.0.1:18888)
#   everything else  -> Next.js UI   (127.0.0.1:13333)
# The configuration is portable: it contains no developer-machine absolute paths.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NGINX_CONF="$SCRIPT_DIR/xcloud.conf"
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

# Optional listen-port override for the internal network.
sed "s|^    listen 80;|    listen ${LISTEN_PORT};|" "$NGINX_CONF" > "$SITES_AVAILABLE"

# Disable default site, enable xcloud
rm -f /etc/nginx/sites-enabled/default
ln -sf "$SITES_AVAILABLE" "$SITES_ENABLED"

# Validate and reload
nginx -t
systemctl reload nginx

echo "Nginx edge router configured for xCloud"
echo "  Config:       $SITES_AVAILABLE"
echo "  Listen:       ${LISTEN_PORT}"
echo "  API upstream: http://127.0.0.1:18888 (Go)"
echo "  UI upstream:  http://127.0.0.1:13333 (Next.js)"
