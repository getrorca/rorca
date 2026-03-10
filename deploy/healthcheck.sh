#!/usr/bin/env bash
# Rorca Production Health Check Script
# Usage: ./healthcheck.sh [--json] [--quiet]
# Exit codes: 0 = healthy, 1 = degraded, 2 = critical
#
# Checks: database connectivity (via API), disk space, backend process
# Designed for use with monitoring systems (Nagios, Datadog, uptime checks).

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
BACKEND_URL="${RORCA_API_URL:-http://localhost:3030}"
HEALTH_ENDPOINT="${BACKEND_URL}/api/health/detailed"
DISK_WARN_PERCENT=85
DISK_CRIT_PERCENT=95
CURL_TIMEOUT=5

# ─── Flags ────────────────────────────────────────────────────────────────────
JSON_OUTPUT=false
QUIET=false
for arg in "$@"; do
    case "$arg" in
        --json)  JSON_OUTPUT=true ;;
        --quiet) QUIET=true ;;
    esac
done

# ─── State ────────────────────────────────────────────────────────────────────
EXIT_CODE=0
CHECKS=()

log() {
    if [ "$QUIET" = false ]; then
        echo "$1"
    fi
}

add_check() {
    local name="$1" status="$2" detail="$3"
    CHECKS+=("{\"name\":\"${name}\",\"status\":\"${status}\",\"detail\":\"${detail}\"}")

    if [ "$status" = "critical" ] && [ "$EXIT_CODE" -lt 2 ]; then
        EXIT_CODE=2
    elif [ "$status" = "warning" ] && [ "$EXIT_CODE" -lt 1 ]; then
        EXIT_CODE=1
    fi
}

# ─── Check 1: Backend API Health ──────────────────────────────────────────────
log "Checking backend API..."
HEALTH_RESPONSE=$(curl -sf --max-time "$CURL_TIMEOUT" "$HEALTH_ENDPOINT" 2>/dev/null || echo "")

if [ -z "$HEALTH_RESPONSE" ]; then
    add_check "backend_api" "critical" "Backend unreachable at ${HEALTH_ENDPOINT}"
    log "  CRITICAL: Backend unreachable"
else
    API_STATUS=$(echo "$HEALTH_RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    DB_CONNECTED=$(echo "$HEALTH_RESPONSE" | grep -o '"db_connected":[a-z]*' | head -1 | cut -d: -f2)

    if [ "$DB_CONNECTED" = "true" ]; then
        add_check "database" "ok" "PostgreSQL connected and responsive"
        log "  OK: PostgreSQL connected"
    else
        add_check "database" "critical" "PostgreSQL connection failed"
        log "  CRITICAL: PostgreSQL not connected"
    fi

    if [ "$API_STATUS" = "healthy" ]; then
        add_check "backend_api" "ok" "Responding normally"
        log "  OK: Backend healthy"
    else
        add_check "backend_api" "warning" "Status: ${API_STATUS}"
        log "  WARNING: Backend status: ${API_STATUS}"
    fi
fi

# ─── Check 2: Disk Space ─────────────────────────────────────────────────────
log "Checking disk space..."

# Get disk usage percentage (works on Linux and macOS)
DISK_PERCENT=$(df "/" 2>/dev/null | tail -1 | awk '{gsub(/%/,""); print $5}')

if [ -n "$DISK_PERCENT" ]; then
    if [ "$DISK_PERCENT" -ge "$DISK_CRIT_PERCENT" ]; then
        add_check "disk_space" "critical" "${DISK_PERCENT}% used (threshold: ${DISK_CRIT_PERCENT}%)"
        log "  CRITICAL: Disk at ${DISK_PERCENT}%"
    elif [ "$DISK_PERCENT" -ge "$DISK_WARN_PERCENT" ]; then
        add_check "disk_space" "warning" "${DISK_PERCENT}% used (threshold: ${DISK_WARN_PERCENT}%)"
        log "  WARNING: Disk at ${DISK_PERCENT}%"
    else
        add_check "disk_space" "ok" "${DISK_PERCENT}% used"
        log "  OK: Disk at ${DISK_PERCENT}%"
    fi
else
    add_check "disk_space" "warning" "Could not determine disk usage"
    log "  WARNING: Could not check disk"
fi

# ─── Check 3: Backend Process ─────────────────────────────────────────────────
log "Checking backend process..."
BACKEND_PORT="${PORT:-3030}"
if command -v lsof &>/dev/null; then
    BACKEND_PID=$(lsof -ti:"$BACKEND_PORT" 2>/dev/null | head -1 || echo "")
elif command -v ss &>/dev/null; then
    BACKEND_PID=$(ss -tlnp "sport = :$BACKEND_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || echo "")
else
    BACKEND_PID=""
fi

if [ -n "$BACKEND_PID" ]; then
    add_check "backend_process" "ok" "PID ${BACKEND_PID} listening on port ${BACKEND_PORT}"
    log "  OK: Backend PID ${BACKEND_PID}"
else
    add_check "backend_process" "critical" "No process listening on port ${BACKEND_PORT}"
    log "  CRITICAL: No process on port ${BACKEND_PORT}"
fi

# ─── Check 4: Stale Pipeline Runs ────────────────────────────────────────────
if [ -n "$HEALTH_RESPONSE" ]; then
    ACTIVE_RUNS=$(echo "$HEALTH_RESPONSE" | grep -o '"active_runs":[0-9]*' | head -1 | cut -d: -f2)
    if [ -n "$ACTIVE_RUNS" ] && [ "$ACTIVE_RUNS" -gt 0 ]; then
        add_check "pipeline_runs" "ok" "${ACTIVE_RUNS} active run(s)"
        log "  INFO: ${ACTIVE_RUNS} active pipeline run(s)"
    else
        add_check "pipeline_runs" "ok" "No active runs"
    fi
fi

# ─── Output ───────────────────────────────────────────────────────────────────
if [ "$JSON_OUTPUT" = true ]; then
    OVERALL="healthy"
    [ "$EXIT_CODE" -eq 1 ] && OVERALL="degraded"
    [ "$EXIT_CODE" -eq 2 ] && OVERALL="critical"

    CHECKS_JSON=$(IFS=,; echo "${CHECKS[*]}")
    echo "{\"status\":\"${OVERALL}\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"checks\":[${CHECKS_JSON}]}"
else
    echo ""
    case "$EXIT_CODE" in
        0) log "Overall: HEALTHY" ;;
        1) log "Overall: DEGRADED" ;;
        2) log "Overall: CRITICAL" ;;
    esac
fi

exit "$EXIT_CODE"
