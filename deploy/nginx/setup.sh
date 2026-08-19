#!/bin/bash
# Setup Nginx reverse proxy for xCloud
# Usage: sudo ./deploy/nginx/setup.sh
# Requires: nginx installed (apt install nginx)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NGINX_CONF="$SCRIPT_DIR/xcloud.conf"
SITES_AVAILABLE="/etc/nginx/sites-available/xcloud"
SITES_ENABLED="/etc/nginx/sites-enabled/xcloud"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: This script must be run as root (sudo)."
  exit 1
fi

if ! command -v nginx &>/dev/null; then
  echo "Error: Nginx is not installed. Run: apt install nginx"
  exit 1
fi

# Update alias paths in config to match actual project location
sed "s|/usr/local/src/claudeWorkSpace/subscriber-console|$PROJECT_DIR|g" \
  "$NGINX_CONF" > "$SITES_AVAILABLE"

# Disable default site, enable xcloud
rm -f /etc/nginx/sites-enabled/default
ln -sf "$SITES_AVAILABLE" "$SITES_ENABLED"

# Test and reload
nginx -t
systemctl reload nginx

echo "✓ Nginx reverse proxy configured for xCloud"
echo "  Project: $PROJECT_DIR"
echo "  Config:  $SITES_AVAILABLE"
echo "  Access:  http://$(hostname -I | awk '{print $1}')"
