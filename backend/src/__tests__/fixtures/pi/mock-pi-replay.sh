#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIXTURE_PATH="$SCRIPT_DIR/pi-parity.jsonl"

case "${1:-}" in
  --version)
    printf 'pi 0.67.0\n'
    ;;
  --list-models)
    cat <<'EOF'
provider      model    context  max-out  thinking  images
openai-codex  gpt-5.4  272K     128K     yes       yes
EOF
    ;;
  run)
    cat "$FIXTURE_PATH"
    ;;
  *)
    printf 'mock-pi-replay: unsupported args: %s\n' "$*" >&2
    exit 1
    ;;
esac
