#!/usr/bin/env bash
# DIST-010: Smoke test for compiled Rorca binary.
#
# Verifies end-to-end: build → version check → start server → health check →
# frontend serves → DB connected → clean shutdown → cleanup.
#
# Usage:
#   bash scripts/smoke-test.sh
#
# Exit code 0 on all passes, non-zero on any failure.

set -euo pipefail

# ── Config ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$ROOT_DIR/build"
BINARY="$BUILD_DIR/rorca-test"
# Isolate from real ~/.rorca by using a fake HOME
REAL_HOME="$HOME"
FAKE_HOME="$(mktemp -d "${TMPDIR:-/tmp}/rorca-smoke-XXXXXX")"
RORCA_DATA="$FAKE_HOME/.rorca"
# Use a random high port to avoid conflicts
SMOKE_PORT=$((49152 + RANDOM % 16384))
HEALTH_TIMEOUT=120  # seconds — includes Postgres download on first CI run
PID_FILE="$FAKE_HOME/.smoke-pid"
LOG_FILE="$FAKE_HOME/smoke.log"

# ── Colors ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo -e "  ${RED}✗${NC} $1"
  if [ "${2:-}" != "" ]; then
    echo -e "    ${RED}$2${NC}"
  fi
}

info() {
  echo -e "  ${YELLOW}→${NC} $1"
}

cleanup() {
  echo ""
  echo "── Cleanup ──"

  # Kill server if still running
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      info "Stopping server (PID $pid)..."
      kill "$pid" 2>/dev/null || true
      # Wait up to 10s for clean shutdown
      for i in $(seq 1 10); do
        if ! kill -0 "$pid" 2>/dev/null; then
          break
        fi
        sleep 1
      done
      # Force kill if still alive
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi

  # Restore real HOME
  export HOME="$REAL_HOME"

  # Clean up test artifacts
  if [ -f "$BINARY" ]; then
    rm -f "$BINARY"
    info "Removed test binary"
  fi

  if [ -d "$FAKE_HOME" ]; then
    rm -rf "$FAKE_HOME"
    info "Removed $FAKE_HOME"
  fi

  echo ""
  echo "── Results: ${PASS_COUNT} passed, ${FAIL_COUNT} failed ──"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo -e "${RED}SMOKE TEST FAILED${NC}"
    exit 1
  else
    echo -e "${GREEN}SMOKE TEST PASSED${NC}"
    exit 0
  fi
}

# Always clean up on exit
trap cleanup EXIT

# ── Preflight ──
echo "═══════════════════════════════════════════"
echo " Rorca Binary Smoke Test (DIST-010)"
echo "═══════════════════════════════════════════"
echo ""

# Check bun is available
if ! command -v bun &>/dev/null; then
  echo -e "${RED}Error: bun is not installed. Install from https://bun.sh${NC}"
  exit 1
fi

# Create test directories
mkdir -p "$FAKE_HOME"
mkdir -p "$BUILD_DIR"

# ── Step 1: Build binary ──
echo "── Step 1: Build binary ──"
info "Building binary via bun run bin/build-binary.ts..."

cd "$ROOT_DIR"

# build-binary.ts handles: frontend build → embedded assets → bun compile
# It outputs to ./rorca in the project root
bun run bin/build-binary.ts 2>&1 | tail -10

# Move compiled binary to our test location
if [ -f "$ROOT_DIR/rorca" ]; then
  mv "$ROOT_DIR/rorca" "$BINARY"
  chmod +x "$BINARY"
  SIZE_MB=$(du -m "$BINARY" | cut -f1)
  pass "Binary built ($SIZE_MB MB)"
else
  fail "Binary not found after build (expected $ROOT_DIR/rorca)"
  exit 1
fi

# ── Step 2: Version check ──
echo ""
echo "── Step 2: Version check ──"
EXPECTED_VERSION=$(node -p "require('$ROOT_DIR/package.json').version")
ACTUAL_VERSION=$("$BINARY" --version 2>&1 || true)

if [ "$ACTUAL_VERSION" = "$EXPECTED_VERSION" ]; then
  pass "Version matches: $ACTUAL_VERSION"
else
  fail "Version mismatch" "Expected: $EXPECTED_VERSION, Got: $ACTUAL_VERSION"
fi

# ── Step 3: Start server ──
echo ""
echo "── Step 3: Start server (port $SMOKE_PORT) ──"

# Override HOME so the binary's homedir() returns our isolated directory.
# This makes ~/.rorca/ resolve to $FAKE_HOME/.rorca/ instead of the real home.
export HOME="$FAKE_HOME"

"$BINARY" start --port "$SMOKE_PORT" --no-open \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

if kill -0 "$SERVER_PID" 2>/dev/null; then
  pass "Server started (PID $SERVER_PID)"
else
  fail "Server failed to start"
  if [ -f "$LOG_FILE" ]; then
    echo "  Last 20 lines of log:"
    tail -20 "$LOG_FILE" | sed 's/^/    /'
  fi
  exit 1
fi

# ── Step 4: Wait for health check ──
echo ""
echo "── Step 4: Wait for health (timeout ${HEALTH_TIMEOUT}s) ──"

HEALTH_URL="http://localhost:${SMOKE_PORT}/api/health"
STARTED=false
ELAPSED=0

while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    STARTED=true
    break
  fi

  # Check server is still alive
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "Server process died while waiting for health"
    if [ -f "$LOG_FILE" ]; then
      echo "  Last 30 lines of log:"
      tail -30 "$LOG_FILE" | sed 's/^/    /'
    fi
    exit 1
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))

  # Progress every 10s
  if [ $((ELAPSED % 10)) -eq 0 ]; then
    info "Still waiting... (${ELAPSED}s)"
  fi
done

if [ "$STARTED" = true ]; then
  pass "Health endpoint responsive after ${ELAPSED}s"
else
  fail "Health check timed out after ${HEALTH_TIMEOUT}s"
  if [ -f "$LOG_FILE" ]; then
    echo "  Last 30 lines of log:"
    tail -30 "$LOG_FILE" | sed 's/^/    /'
  fi
  exit 1
fi

# ── Step 5: Verify health response ──
echo ""
echo "── Step 5: Verify health response ──"

HEALTH_RESPONSE=$(curl -sf "$HEALTH_URL" 2>&1 || echo "CURL_FAILED")

if echo "$HEALTH_RESPONSE" | grep -q '"status"'; then
  HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).status" 2>/dev/null || echo "PARSE_FAILED")
  if [ "$HEALTH_STATUS" = "healthy" ]; then
    pass "Health status: healthy"
  else
    fail "Health status: $HEALTH_STATUS (expected 'healthy')"
  fi

  DB_CONNECTED=$(echo "$HEALTH_RESPONSE" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).db_connected" 2>/dev/null || echo "PARSE_FAILED")
  if [ "$DB_CONNECTED" = "true" ]; then
    pass "Database connected"
  else
    fail "Database not connected" "db_connected=$DB_CONNECTED"
  fi
else
  fail "Health response invalid" "$HEALTH_RESPONSE"
fi

# ── Step 6: Verify frontend serves ──
echo ""
echo "── Step 6: Verify frontend serves ──"

FRONTEND_RESPONSE=$(curl -sf "http://localhost:${SMOKE_PORT}/" 2>&1 || echo "CURL_FAILED")

if echo "$FRONTEND_RESPONSE" | grep -q '<div id="root"'; then
  pass "Frontend serves HTML with <div id=\"root\">"
else
  # Check for any HTML
  if echo "$FRONTEND_RESPONSE" | grep -qi '<!doctype\|<html'; then
    fail "Frontend serves HTML but missing <div id=\"root\">"
  else
    fail "Frontend did not serve HTML" "$(echo "$FRONTEND_RESPONSE" | head -3)"
  fi
fi

# ── Step 7: Verify workspaces endpoint (DB connected) ──
echo ""
echo "── Step 7: Verify workspaces endpoint ──"

WORKSPACES_RESPONSE=$(curl -s -w "\n%{http_code}" "http://localhost:${SMOKE_PORT}/api/workspaces" 2>&1 || echo "CURL_FAILED")
WORKSPACES_HTTP_CODE=$(echo "$WORKSPACES_RESPONSE" | tail -1)
WORKSPACES_BODY=$(echo "$WORKSPACES_RESPONSE" | sed '$d')

if [ "$WORKSPACES_HTTP_CODE" = "200" ]; then
  # Verify it's a JSON array (could be empty on fresh install)
  IS_ARRAY=$(echo "$WORKSPACES_BODY" | node -p "Array.isArray(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')))" 2>/dev/null || echo "false")
  if [ "$IS_ARRAY" = "true" ]; then
    pass "Workspaces endpoint returns 200 with JSON array"
  else
    fail "Workspaces endpoint returns 200 but not a JSON array" "$WORKSPACES_BODY"
  fi
else
  fail "Workspaces endpoint returned HTTP $WORKSPACES_HTTP_CODE"
fi

# ── Step 8: Clean shutdown ──
echo ""
echo "── Step 8: Clean shutdown ──"

if kill -0 "$SERVER_PID" 2>/dev/null; then
  kill "$SERVER_PID" 2>/dev/null
  SHUTDOWN_WAIT=0
  while [ "$SHUTDOWN_WAIT" -lt 15 ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
    SHUTDOWN_WAIT=$((SHUTDOWN_WAIT + 1))
  done

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    pass "Server shut down cleanly after SIGTERM (${SHUTDOWN_WAIT}s)"
    rm -f "$PID_FILE"
  else
    fail "Server did not shut down within 15s after SIGTERM"
    kill -9 "$SERVER_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
else
  fail "Server was already dead before shutdown test"
fi

# ── Step 9: Verify data directory was created ──
echo ""
echo "── Step 9: Verify data directory ──"

if [ -d "$RORCA_DATA" ]; then
  pass "Data directory exists: $RORCA_DATA"
else
  fail "Data directory not found: $RORCA_DATA"
fi

# Step 10 (cleanup) runs via the EXIT trap

echo ""
echo "── Step 10: Cleanup (via EXIT trap) ──"
# The trap handler will run cleanup and print results
