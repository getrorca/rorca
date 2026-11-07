#!/usr/bin/env bash
# Hermetic fake omp binary for the W5-007 OmpManagedExecutor fixture tests.
# Emits the `pi --mode rpc` JSONL-RPC handshake contract that omp v17+ carries
# natively, so the managed bridge can be exercised without a real provider.
#
# Modes (via .rorca/fake-omp-control in the spawn cwd, or env for compat):
#   crash        -> exit 1 immediately (startup failure)
#   hang         -> never answer RPC commands (launch ack timeout)
#   stay         -> stay alive after the handshake (live child)
#   ignore-term  -> ignore SIGTERM and stay alive (death-evidence fixture)
#   events       -> emit an instrumented real JSONL-RPC event vocabulary
#   default      -> answer new_session/get_state, then exit 0
set -euo pipefail

FAKE_MODE=""
if [ -f .rorca/fake-omp-control ]; then
  FAKE_MODE=$(tr -d '[:space:]' < .rorca/fake-omp-control)
fi
if [ -z "$FAKE_MODE" ]; then
  FAKE_MODE="${RORCA_FAKE_OMP_MODE:-}"
fi

if [ "$FAKE_MODE" = "crash" ]; then
  echo "fake omp startup failure" >&2
  exit 1
fi

if [ "$FAKE_MODE" = "hang" ]; then
  while read -r _line; do :; done
  exit 0
fi

if [ "$FAKE_MODE" = "ignore-term" ]; then
  trap '' TERM
fi

for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    echo "omp/17.0.9"
    exit 0
  fi
done

id_of() {
  printf '%s' "$1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'
}

respond() {
  local line="$1" id
  id=$(id_of "$line")
  case "$line" in
    *'"type":"new_session"'*)
      printf '{"type":"response","id":"%s","success":true,"data":{"sessionId":"fake-omp-session"}}\n' "$id"
      ;;
    *'"type":"get_state"'*)
      printf '{"type":"response","id":"%s","success":true,"data":{"sessionId":"fake-omp-session","state":{}}}\n' "$id"
      if [ "$FAKE_MODE" = "events" ]; then
        printf '{"type":"agent_start","eventId":"omp:event:1","agentId":"omp:agent:root"}\n'
        printf '{"type":"turn_start","eventId":"omp:event:2","parentEventId":"omp:event:1","agentId":"omp:agent:root","taskId":"omp:task:1"}\n'
        printf '{"type":"message_update","eventId":"omp:event:3","parentEventId":"omp:event:2","agentId":"omp:agent:root","assistantMessageEvent":{"type":"text_delta","delta":"instrumented output"}}\n'
        printf '{"type":"future_omp_signal","eventId":"omp:event:4","parentEventId":"omp:event:3","detail":"retained"}\n'
        printf '{"type":"agent_settled","eventId":"omp:event:5","parentEventId":"omp:event:2","agentId":"omp:agent:root","reason":"story_complete"}\n'
        sleep 0.1
        exit 0
      fi
      if [ "$FAKE_MODE" != "stay" ] && [ "$FAKE_MODE" != "ignore-term" ]; then
        if [ "${RORCA_FAKE_OMP_STAY:-}" != "1" ]; then
          sleep 0.1
          exit 0
        fi
      fi
      ;;
    *'"type":"prompt"'*)
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      printf '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"fake omp story output"}}\n'
      printf '{"type":"turn_end","message":{"usage":{"input":10,"output":5,"cost":{"total":0.0001}}}}\n'
      printf '{"type":"agent_settled","reason":"story_complete"}\n'
      exit 0
      ;;
    *'"type":"abort"'*)
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      exit 0
      ;;
    *)
      printf '{"type":"response","id":"%s","success":true}\n' "$id"
      ;;
  esac
}

while IFS= read -r line; do
  if [ -n "$line" ]; then respond "$line"; fi
done
exit 0
