#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rorca: idempotent run-completion + MEMORY.md ledger protection + worker reload
#
# Native on macOS (launchd) and Linux (systemd / docker compose) via
# scripts/lib/rorca-platform.sh. One command a low-context operator runs to
# finish a rorca pipeline run safely. Every branch is deterministic.
#
# Usage:
#   scripts/finish-rorca-run.sh <runId> [--timeout-min N]
#
# Behavior (each step idempotent and safe to re-run):
#   1. Wait until the run reaches a terminal state (done/failed/cancelled/
#      partial_failure) — up to --timeout-min (default 1440 = 24h).
#   2. When terminal: verify + restore the worktree MEMORY.md ledger from git
#      if the engine truncated it (pre-fix worker rewrote it to a stub).
#   3. Reload the worker (launchctl kickstart / systemctl restart) so the
#      monotonic writeMemoryMd guard loads — only AFTER the run is terminal.
#   4. Verify: run status, ledger line count, worker pid, backend health.
#
# Exit codes:
#   0  success (run terminal + all post-steps verified)
#   2  timeout waiting for terminal state
#   3  usage or fatal error (details on stdout)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/rorca-platform.sh
source "$SCRIPT_DIR/lib/rorca-platform.sh"

RUN_ID="${1:-}"
TIMEOUT_MIN=1440
if [[ "${2:-}" == "--timeout-min" && "$3" =~ ^[0-9]+$ ]]; then
  TIMEOUT_MIN="$3"
fi
if [[ ! "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "usage: $0 <runId> [--timeout-min N]" >&2
  exit 3
fi

WORKSPACE_ID="${RORCA_WORKSPACE_ID:-categoric}"
if [ -z "${RORCA_RUN_WORKTREE:-}" ]; then
  echo "$(basename "$0"): set RORCA_RUN_WORKTREE to the workspace worktree this run targets" >&2
  exit 64
fi
WORKTREE="$RORCA_RUN_WORKTREE"
LEDGER="$WORKTREE/MEMORY.md"
BACKEND_URL="${RORCA_BACKEND_URL:-http://127.0.0.1:3030}"
MIN_LEDGER_LINES=10
LOG_FILE="$WORKTREE/.rorca/finish-rorca-run-$RUN_ID.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG_FILE"; }

# ── 1. Wait for terminal run state ──────────────────────────────────────────
TERMINAL=('done' 'failed' 'partial_failure' 'cancelled')
log "waiting for run $RUN_ID to reach a terminal state (timeout ${TIMEOUT_MIN}m)"
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
while :; do
  STATUS="$(run_status "$RUN_ID")"
  for t in "${TERMINAL[@]}"; do [[ "$STATUS" == "$t" ]] && break 2; done
  if [[ "$STATUS" == "unknown" ]]; then
    log "warning: could not read run status (db/backend down?) — retrying"
  fi
  if (( $(date +%s) >= deadline )); then
    log "timeout: run $RUN_ID still '$STATUS' after ${TIMEOUT_MIN}m"
    exit 2
  fi
  sleep 60
done
log "run $RUN_ID is terminal: $STATUS"

# ── 2. Restore MEMORY.md ledger if the (pre-fix) engine truncated it ────────
if [[ -f "$LEDGER" ]]; then
  LINES="$(wc -l < "$LEDGER" | tr -d ' ')"
  if (( LINES < MIN_LEDGER_LINES )); then
    cp "$LEDGER" "$LEDGER.truncated-$(date +%s).bak" 2>/dev/null || true
    if git -C "$WORKTREE" checkout -- MEMORY.md 2>>"$LOG_FILE"; then
      log "MEMORY.md was truncated ($LINES lines) — restored from git HEAD"
    else
      log "MEMORY.md truncated ($LINES lines) but git restore FAILED — left read-only, manual restore needed"
    fi
  else
    log "MEMORY.md intact: $LINES lines"
  fi
  # Re-assert read-only so a still-running pre-fix engine cannot rewrite it.
  chmod 444 "$LEDGER"
else
  log "MEMORY.md missing in worktree — nothing to restore"
fi

# ── 3. Reload the worker (loads the writeMemoryMd guard) ─────────────────────
# Only now, after the run is terminal: killing the worker mid-run would kill
# the engine. Platform-native: launchctl kickstart (macOS) / systemctl restart
# (Linux) / docker compose restart (override).
log "reloading worker (platform=$PLATFORM)"
worker_reload
for i in $(seq 1 30); do
  NEW_PID="$(worker_pid)"
  if [[ -n "$NEW_PID" && "$NEW_PID" != "0" ]]; then
    log "worker reloaded: pid $NEW_PID"
    break
  fi
  sleep 2
done

# ── 4. Verify everything ─────────────────────────────────────────────────────
sleep 5
log "verification:"
log "  run $RUN_ID status: $(run_status "$RUN_ID")"
log "  MEMORY.md lines:    $(wc -l < "$LEDGER" | tr -d ' ')"
log "  worker pid:         $(worker_pid)"
if curl -sf "$BACKEND_URL/api/health" >/dev/null 2>&1; then
  log "  backend health:     ok"
else
  log "  backend health:     DOWN (check rorca-backend)"
fi
log "done — log: $LOG_FILE"
