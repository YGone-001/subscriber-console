#!/bin/sh
# Operator-run installation of the narrow local process-evidence publisher.
# This script never controls an NF or stops the console runtime.
set -eu
if [ "$(id -u)" != 0 ] || [ "$#" != 1 ]; then
  echo "Usage (root): sh deploy/process-evidence/install.sh /absolute/path/to/process-evidence" >&2
  exit 1
fi
case "$1" in /*) ;; *) echo "Binary path must be absolute" >&2; exit 1 ;; esac
test -f "$1"
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="/var/backups/xcloud-process-evidence/$stamp"
for target in /usr/local/libexec/xcloud-process-evidence /etc/xcloud-process-evidence.json /etc/systemd/system/xcloud-process-evidence.service /etc/systemd/system/xcloud-process-evidence.timer; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    install -d -m 0700 "$backup"
    cp -pP -- "$target" "$backup/$(basename -- "$target")"
  fi
done
install -d -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$1" /usr/local/libexec/xcloud-process-evidence
# Existing policy is operator-owned and is never silently broadened.
if [ ! -e /etc/xcloud-process-evidence.json ]; then
  install -o root -g root -m 0644 "$repo/deploy/examples/process-evidence.json" /etc/xcloud-process-evidence.json
fi
install -o root -g root -m 0644 "$repo/deploy/systemd/xcloud-process-evidence.service" /etc/systemd/system/xcloud-process-evidence.service
install -o root -g root -m 0644 "$repo/deploy/systemd/xcloud-process-evidence.timer" /etc/systemd/system/xcloud-process-evidence.timer
systemd-analyze verify /etc/systemd/system/xcloud-process-evidence.service /etc/systemd/system/xcloud-process-evidence.timer
systemctl daemon-reload
systemctl start xcloud-process-evidence.service
systemctl enable --now xcloud-process-evidence.timer
stat -c 'snapshot owner=%U mode=%a bytes=%s' /run/xcloud-process-evidence/latest.json
echo "Process evidence publisher installed; no NF or console process was restarted."
