#!/bin/bash
# Mock opencode binary for integration tests.
# Supports two modes:
#   1. `mock-opencode --version` → prints version string
#   2. `mock-opencode server --socket <path>` → creates socket file, stays alive
#   3. `mock-opencode run [--format json] [--model <m>] [--attach <s>]` → reads stdin, emits JSON events, exits 0
#
# Set MOCK_OPENCODE_EXIT_CODE to override exit code (default: 0).
# Set MOCK_OPENCODE_STDERR to inject stderr output.
# Set MOCK_OPENCODE_DELAY_MS to add delay before exiting (simulates work).

set -e

EXIT_CODE="${MOCK_OPENCODE_EXIT_CODE:-0}"
STDERR_MSG="${MOCK_OPENCODE_STDERR:-}"
DELAY_MS="${MOCK_OPENCODE_DELAY_MS:-0}"

if [ "$1" = "--version" ]; then
  echo "opencode v0.2.0"
  exit 0
fi

if [ "$1" = "server" ]; then
  # Parse --socket flag
  SOCKET_PATH=""
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --socket) SOCKET_PATH="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [ -n "$SOCKET_PATH" ]; then
    # Create the socket file to signal readiness
    touch "$SOCKET_PATH"
    # Stay alive until killed
    trap "rm -f '$SOCKET_PATH'; exit 0" TERM INT
    while true; do sleep 1; done
  fi
  exit 1
fi

if [ "$1" = "run" ]; then
  # Parse flags
  FORMAT=""
  MODEL=""
  ATTACH=""
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --format) FORMAT="$2"; shift 2 ;;
      --model) MODEL="$2"; shift 2 ;;
      --attach) ATTACH="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  # Read stdin (the prompt) — consume it so pipe doesn't break
  PROMPT=$(cat)

  # Simulate work delay
  if [ "$DELAY_MS" -gt 0 ] 2>/dev/null; then
    sleep "$(echo "scale=3; $DELAY_MS / 1000" | bc)"
  fi

  # Emit stderr if requested
  if [ -n "$STDERR_MSG" ]; then
    echo "$STDERR_MSG" >&2
  fi

  # Emit JSON events to stdout (simulating a successful story run)
  if [ "$FORMAT" = "json" ]; then
    cat <<'EVENTS'
{"type":"status","status":"starting","timestamp":"2026-02-27T00:00:00.000Z"}
{"type":"assistant","content":"I will implement the requested changes.","timestamp":"2026-02-27T00:00:01.000Z"}
{"type":"tool_call","tool":"read","args":{"file_path":"CLAUDE.md"},"timestamp":"2026-02-27T00:00:02.000Z"}
{"type":"tool_result","content":"# CLAUDE.md contents...","timestamp":"2026-02-27T00:00:03.000Z"}
{"type":"tool_call","tool":"edit","args":{"file_path":"src/index.ts","old_string":"old","new_string":"new"},"timestamp":"2026-02-27T00:00:04.000Z"}
{"type":"tool_result","content":"File edited successfully","timestamp":"2026-02-27T00:00:05.000Z"}
{"type":"tool_call","tool":"bash","args":{"command":"npm test","description":"Run tests"},"timestamp":"2026-02-27T00:00:06.000Z"}
{"type":"tool_result","content":"All tests passed","timestamp":"2026-02-27T00:00:07.000Z"}
{"type":"completion","content":"Implementation complete. All tests pass.","exitCode":0,"timestamp":"2026-02-27T00:00:08.000Z"}
EVENTS
  else
    echo "Implementation complete."
  fi

  exit "$EXIT_CODE"
fi

# Unknown command
echo "mock-opencode: unknown command $1" >&2
exit 1
