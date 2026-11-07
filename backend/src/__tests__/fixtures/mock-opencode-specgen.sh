#!/bin/bash
# Mock opencode binary that outputs a valid spec JSON for spec generation tests.
# Used to test the SDK fallback path when this mock fails.
#
# Set MOCK_OPENCODE_FAIL_SPECGEN=1 to simulate spec generation failure.

set -e

EXIT_CODE="${MOCK_OPENCODE_EXIT_CODE:-0}"

if [ "$1" = "--version" ]; then
  echo "opencode v0.2.0"
  exit 0
fi

if [ "$1" = "run" ]; then
  shift
  # Consume flags
  while [ $# -gt 0 ]; do
    case "$1" in
      --format|--model|--attach) shift 2 ;;
      *) shift ;;
    esac
  done

  # Read stdin
  cat > /dev/null

  if [ "${MOCK_OPENCODE_FAIL_SPECGEN:-0}" = "1" ]; then
    echo "Error: simulated spec generation failure" >&2
    exit 1
  fi

  # Emit a valid spec JSON wrapped in assistant event
  cat <<'EVENTS'
{"type":"status","status":"starting","timestamp":"2026-02-27T00:00:00.000Z"}
{"type":"assistant","content":"Exploring codebase...","timestamp":"2026-02-27T00:00:01.000Z"}
{"type":"tool_call","tool":"read","args":{"file_path":"CLAUDE.md"},"timestamp":"2026-02-27T00:00:02.000Z"}
{"type":"tool_result","content":"# Project docs","timestamp":"2026-02-27T00:00:03.000Z"}
{"type":"assistant","content":"{\"stories\":[{\"id\":\"TS-001\",\"title\":\"Test Story One\",\"description\":\"Implement feature one\",\"acceptanceCriteria\":[\"Criterion A\",\"Criterion B\"],\"dependsOn\":[],\"complexity\":2},{\"id\":\"TS-002\",\"title\":\"Test Story Two\",\"description\":\"Implement feature two\",\"acceptanceCriteria\":[\"Criterion C\"],\"dependsOn\":[\"TS-001\"],\"complexity\":3}]}","timestamp":"2026-02-27T00:00:04.000Z"}
{"type":"completion","content":"Spec generation complete.","exitCode":0,"timestamp":"2026-02-27T00:00:05.000Z"}
EVENTS

  exit "$EXIT_CODE"
fi

echo "mock-opencode: unknown command $1" >&2
exit 1
