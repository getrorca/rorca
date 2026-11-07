#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rorca-platform.sh — cross-platform environment resolution (sourced, not run)
#
# Resolves the platform-specific bits shared by ledger-guard.sh and
# finish-rorca-run.sh so the same scripts work natively on:
#   macOS (Darwin) — launchd supervision, docker exec DB
#   Linux VM       — systemd unit / docker compose supervision
#
# Override everything via env for exotic setups:
#   RORCA_PLATFORM              darwin|linux (default: uname -s)
#   RORCA_DB_STATUS_CMD         full command; $1 = run id (echoes status)
#   RORCA_DB_ACTIVE_CMD         full command; $1 = workspace id (echoes count)
#   RORCA_WORKER_PID_CMD        full command (echoes worker pid)
#   RORCA_WORKER_RELOAD_CMD     full command (no args)
#   RORCA_WORKER_LABEL          darwin launchd label
#   RORCA_WORKER_UNIT           linux systemd unit name
#   RORCA_DB_CONTAINER          darwin docker container (default rorca-dev-db)
#   RORCA_DB_SERVICE            linux compose db service (default db)
#   RORCA_DB_USER               psql role (default rorca_bootstrap)
# ─────────────────────────────────────────────────────────────────────────────

RORCA_PLATFORM="${RORCA_PLATFORM:-$(uname -s)}"
case "$RORCA_PLATFORM" in
  Darwin|darwin)  PLATFORM="darwin" ;;
  Linux|linux)    PLATFORM="linux" ;;
  *)
    echo "[rorca-platform] unsupported platform: $RORCA_PLATFORM (expected darwin|linux)" >&2
    return 1
    ;;
esac

WORKER_LABEL="${RORCA_WORKER_LABEL:-com.rorca.worker.rorca-wave-parallel-merge-ready}"
WORKER_UNIT="${RORCA_WORKER_UNIT:-rorca-worker}"
DB_CONTAINER="${RORCA_DB_CONTAINER:-rorca-dev-db}"
DB_SERVICE="${RORCA_DB_SERVICE:-db}"
DB_USER="${RORCA_DB_USER:-rorca_bootstrap}"

# launchd/systemd timers run with a minimal PATH — resolve docker absolutely.
# Prefer an explicit override, then PATH, then platform defaults.
if [[ -n "${RORCA_DOCKER_BIN:-}" ]]; then
  DOCKER_BIN="$RORCA_DOCKER_BIN"
elif command -v docker >/dev/null 2>&1; then
  DOCKER_BIN="$(command -v docker)"
elif [[ "$PLATFORM" == "darwin" ]]; then
  DOCKER_BIN="/usr/local/bin/docker"   # Homebrew symlink
else
  DOCKER_BIN="/usr/bin/docker"
fi

db_status_cmd() {
  if [[ -n "${RORCA_DB_STATUS_CMD:-}" ]]; then
    printf '%s' "$RORCA_DB_STATUS_CMD"
    return
  fi
  if [[ "$PLATFORM" == "darwin" ]]; then
    printf '%s exec %s psql -U %s -d rorca -tAc' "$DOCKER_BIN" "$DB_CONTAINER" "$DB_USER"
  else
    printf '%s compose exec -T %s psql -U %s -d rorca -tAc' "$DOCKER_BIN" "$DB_SERVICE" "$DB_USER"
  fi
}

db_active_cmd() {
  if [[ -n "${RORCA_DB_ACTIVE_CMD:-}" ]]; then
    printf '%s' "$RORCA_DB_ACTIVE_CMD"
    return
  fi
  if [[ "$PLATFORM" == "darwin" ]]; then
    printf '%s exec %s psql -U %s -d rorca -tAc' "$DOCKER_BIN" "$DB_CONTAINER" "$DB_USER"
  else
    printf '%s compose exec -T %s psql -U %s -d rorca -tAc' "$DOCKER_BIN" "$DB_SERVICE" "$DB_USER"
  fi
}

# Echo the run status for $1 (run id); "unknown" on failure.
run_status() {
  local run_id="$1"
  local cmd
  cmd="$(db_status_cmd)"
  # shellcheck disable=SC2086
  $cmd "SELECT status FROM rorca.pipeline_runs WHERE id=$run_id" 2>/dev/null || echo "unknown"
}

# Echo count of active (running/queued) runs for $1 (workspace id).
active_run_count() {
  local workspace_id="$1"
  local cmd
  cmd="$(db_active_cmd)"
  # shellcheck disable=SC2086
  $cmd "SELECT count(*) FROM rorca.pipeline_runs WHERE workspace_id='$workspace_id' AND status IN ('running','queued')" 2>/dev/null || echo "unknown"
}

# Echo the worker process pid ("" if not running).
worker_pid() {
  if [[ -n "${RORCA_WORKER_PID_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    ${RORCA_WORKER_PID_CMD} 2>/dev/null || echo ""
    return
  fi
  if [[ "$PLATFORM" == "darwin" ]]; then
    launchctl print "gui/$(id -u)/$WORKER_LABEL" 2>/dev/null | awk '/^[[:space:]]*pid =/{print $3; exit}' || echo ""
  else
    systemctl show -p MainPID --value "$WORKER_UNIT" 2>/dev/null || echo ""
  fi
}

# Reload the worker (only ever called when no run is active).
worker_reload() {
  if [[ -n "${RORCA_WORKER_RELOAD_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    ${RORCA_WORKER_RELOAD_CMD}
    return
  fi
  if [[ "$PLATFORM" == "darwin" ]]; then
    launchctl kickstart -k "gui/$(id -u)/$WORKER_LABEL"
  else
    systemctl restart "$WORKER_UNIT"
  fi
}
