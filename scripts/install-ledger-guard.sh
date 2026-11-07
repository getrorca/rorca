#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rorca: install/uninstall the ledger-guard supervisor
#
# Native on macOS and Linux:
#   macOS: launchd LaunchAgent com.rorca.ledger-guard (StartInterval 60s)
#   Linux: systemd unit rorca-ledger-guard.service + .timer (OnUnitActive 60s)
#
# Usage:
#   scripts/install-ledger-guard.sh [install|uninstall|status]
#   (default: install)
#
# Idempotent: install twice is a no-op (reloads), uninstall twice is a no-op.
# Override paths with the same env vars as ledger-guard.sh:
#   RORCA_RUN_WORKTREE, RORCA_WORKSPACE_ID, RORCA_GUARD_LOG, RORCA_GUARD_STATE,
#   RORCA_WORKER_LABEL, RORCA_WORKER_UNIT
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/rorca-platform.sh
source "$SCRIPT_DIR/lib/rorca-platform.sh"

ACTION="${1:-install}"
GUARD_SCRIPT="$SCRIPT_DIR/ledger-guard.sh"
if [ -z "${RORCA_RUN_WORKTREE:-}" ]; then
  echo "$(basename "$0"): set RORCA_RUN_WORKTREE to the workspace worktree this run targets" >&2
  exit 64
fi
WORKTREE="$RORCA_RUN_WORKTREE"

install_darwin() {
  local plist="$HOME/Library/LaunchAgents/com.rorca.ledger-guard.plist"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.rorca.ledger-guard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$GUARD_SCRIPT</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$WORKTREE/.rorca/ledger-guard.launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$WORKTREE/.rorca/ledger-guard.launchd.err.log</string>
</dict>
</plist>
EOF
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "[install-ledger-guard] launchd agent loaded: com.rorca.ledger-guard"
}

uninstall_darwin() {
  local plist="$HOME/Library/LaunchAgents/com.rorca.ledger-guard.plist"
  launchctl unload "$plist" 2>/dev/null || true
  rm -f "$plist"
  echo "[install-ledger-guard] launchd agent removed"
}

install_linux() {
  local unit="/etc/systemd/system/rorca-ledger-guard.service"
  local timer="/etc/systemd/system/rorca-ledger-guard.timer"
  if [[ $EUID -ne 0 ]]; then
    echo "[install-ledger-guard] systemd install requires root — re-run with sudo" >&2
    exit 3
  fi
  cat > "$unit" <<EOF
[Unit]
Description=Rorca MEMORY.md ledger guard (monotonic protection + worker reload)
After=network.target docker.service

[Service]
Type=oneshot
ExecStart=$GUARD_SCRIPT
Environment=RORCA_RUN_WORKTREE=$WORKTREE

[Install]
WantedBy=multi-user.target
EOF
  cat > "$timer" <<EOF
[Unit]
Description=Run rorca ledger guard every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now rorca-ledger-guard.timer
  echo "[install-ledger-guard] systemd timer enabled: rorca-ledger-guard.timer"
}

uninstall_linux() {
  if [[ $EUID -ne 0 ]]; then
    echo "[install-ledger-guard] systemd uninstall requires root — re-run with sudo" >&2
    exit 3
  fi
  systemctl disable --now rorca-ledger-guard.timer 2>/dev/null || true
  rm -f /etc/systemd/system/rorca-ledger-guard.service /etc/systemd/system/rorca-ledger-guard.timer
  systemctl daemon-reload
  echo "[install-ledger-guard] systemd timer removed"
}

status() {
  if [[ "$PLATFORM" == "darwin" ]]; then
    launchctl print "gui/$(id -u)/com.rorca.ledger-guard" 2>/dev/null | grep -E 'state =|last exit' | head -3 \
      || echo "not installed"
  else
    systemctl status rorca-ledger-guard.timer --no-pager 2>/dev/null | head -6 \
      || echo "not installed"
  fi
}

case "$ACTION" in
  install)   if [[ "$PLATFORM" == "darwin" ]]; then install_darwin; else install_linux; fi ;;
  uninstall) if [[ "$PLATFORM" == "darwin" ]]; then uninstall_darwin; else uninstall_linux; fi ;;
  status)    status ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 3 ;;
esac
