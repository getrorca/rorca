#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rorca: MEMORY.md ledger guard — state-reactive invariant
#
# Native on macOS (launchd) and Linux (systemd / docker compose) via
# scripts/lib/rorca-platform.sh. Enforces, every run, forever:
#   - MEMORY.md is read-only (chmod 444) while any workspace run is active —
#     stateless protection, no polling race; the engine's write fails EACCES
#     and the ledger can never be truncated.
#   - If truncated anyway (run started before guard install), restored from
#     git HEAD (stub backed up first).
#   - When idle AND the worker runs PRE-GUARD code (pid not recorded as
#     reloaded), the worker is reloaded (launchctl kickstart / systemctl
#     restart) — only when idle, never killing a live engine.
#   - MEMORY.md relaxes to writable ONLY in the same tick a fixed-worker
#     reload was confirmed; perms are otherwise never toggled (no race).
#
# Install: scripts/install-ledger-guard.sh   (launchd agent / systemd timer)
# Logs:   $WORKTREE/.rorca/ledger-guard.log
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/rorca-platform.sh
source "$SCRIPT_DIR/lib/rorca-platform.sh"

WORKSPACE_ID="${RORCA_WORKSPACE_ID:-categoric}"
if [ -z "${RORCA_RUN_WORKTREE:-}" ]; then
  echo "$(basename "$0"): set RORCA_RUN_WORKTREE to the workspace worktree this run targets" >&2
  exit 64
fi
WORKTREE="$RORCA_RUN_WORKTREE"
LEDGER="$WORKTREE/MEMORY.md"
MIN_LEDGER_LINES=10
LOG_FILE="${RORCA_GUARD_LOG:-$WORKTREE/.rorca/ledger-guard.log}"
STATE_FILE="${RORCA_GUARD_STATE:-$WORKTREE/.rorca/ledger-guard.state}"
mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG_FILE"; }

# ── Active-run branch: protect + verify ledger ───────────────────────────────
COUNT="$(active_run_count "$WORKSPACE_ID")"
if [[ "$COUNT" == "unknown" ]]; then
  log "warning: cannot query DB — leaving MEMORY.md untouched"
  exit 0
fi
if [[ "$COUNT" != "0" ]]; then
  if [[ -f "$LEDGER" ]]; then
    chmod 444 "$LEDGER" 2>/dev/null || true
    LINES="$(wc -l < "$LEDGER" | tr -d ' ')"
    if (( LINES < MIN_LEDGER_LINES )); then
      cp "$LEDGER" "$LEDGER.truncated-$(date +%s).bak" 2>/dev/null || true
      if git -C "$WORKTREE" checkout -- MEMORY.md 2>>"$LOG_FILE"; then
        chmod 444 "$LEDGER"
        log "active run ($COUNT): MEMORY.md was truncated ($LINES lines) — restored + read-only"
      else
        chmod 444 "$LEDGER"
        log "active run ($COUNT): MEMORY.md truncated ($LINES lines) but git restore FAILED — kept read-only (see log)"
      fi
    else
      log "active run ($COUNT): MEMORY.md ok ($LINES lines, read-only)"
    fi
  fi
  exit 0
fi

# ── Idle branch: reload pre-guard worker, then (and only then) relax perms ──
PID="$(worker_pid)"
if [[ -z "$PID" || "$PID" == "0" ]]; then
  log "idle: worker not running — nothing to reload"
  exit 0
fi
RECORDED="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
if [[ "$RECORDED" != "$PID" ]]; then
  log "idle: worker pid $PID not recorded as guard-reloaded (recorded=$RECORDED) — reloading"
  worker_reload
  sleep 3
  NEW_PID="$(worker_pid)"
  if [[ -n "$NEW_PID" && "$NEW_PID" != "0" ]]; then
    printf '%s' "$NEW_PID" > "$STATE_FILE"
    # New worker confirmed: it runs the guard code, so the ledger may be
    # writable again without any truncation risk.
    chmod 644 "$LEDGER" 2>/dev/null || true
    log "idle: worker reloaded (old=$PID new=$NEW_PID) — ledger writable, recorded"
  else
    log "idle: worker reload requested but new pid unreadable (old=$PID) — keeping ledger read-only"
  fi
else
  log "idle: worker pid $PID already guard-reloaded — ledger stays as-is (no toggle)"
fi
exit 0
