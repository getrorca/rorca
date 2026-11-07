#!/bin/bash
# monitor-run-journey.sh — SSDLC journey watcher for a single pipeline run.
# Polls run/story/WAL/ledger state every 60s and appends one compact line per
# observed transition to the state log. Idempotent; safe to run repeatedly.
set -u
RUN_ID="${1:?usage: monitor-run-journey.sh <runId>}"
# Connection string must come from the environment; never embed credentials in
# a tracked script. Use the same URL the backend runs with, e.g.
#   export RORCA_DATABASE_URL="postgres://rorca_runtime:***@localhost:5432/rorca"
DB_URL="${RORCA_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "monitor-run-journey.sh: set RORCA_DATABASE_URL (or DATABASE_URL) to the Rorca database connection string" >&2
  exit 64
fi
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUT="${RORCA_JOURNEY_LOG:-$REPO_ROOT/.rorca/run-journey-${RUN_ID}.log}"
mkdir -p "$(dirname "$OUT")"
touch "$OUT"
identity=$(psql "$DB_URL" -Atc "SELECT workspace_id||'|'||regexp_replace(regexp_replace(spec_path, '^.*/', ''), '\.json$', '') FROM rorca.pipeline_runs WHERE id=${RUN_ID}" 2>/dev/null)
WORKSPACE_ID="${identity%%|*}"
SPEC_ID="${identity#*|}"
if [ -z "$WORKSPACE_ID" ] || [ -z "$SPEC_ID" ] || [ "$WORKSPACE_ID" = "$SPEC_ID" ]; then
  echo "unable to resolve workspace/spec identity for run ${RUN_ID}" >&2
  exit 2
fi


seen_stories=""
seen_events=""
last_status=""
last_lifecycle=""
last_story_result=""
last_ssdlc=""
last_evidence=""
last_decisions=""
last_integrations=""

while true; do
  status=$(psql "$DB_URL" -Atc "SELECT status FROM rorca.pipeline_runs WHERE id=${RUN_ID}" 2>/dev/null)
  lifecycle=$(psql "$DB_URL" -Atc "SELECT COALESCE(lifecycle_status,'-') FROM rorca.pipeline_runs WHERE id=${RUN_ID}" 2>/dev/null)
  stories=$(psql "$DB_URL" -Atc "SELECT COALESCE(string_agg(story_id||':'||status, ',' ORDER BY id),'') FROM rorca.story_results WHERE run_id=${RUN_ID}" 2>/dev/null)
  events=$(psql "$DB_URL" -Atc "SELECT COALESCE(string_agg(event_type||'('||COALESCE(story_id,'-')||')', ',' ORDER BY id),'') FROM rorca.wal_events WHERE canonical_run_id=${RUN_ID}" 2>/dev/null)
  chunks=$(psql "$DB_URL" -Atc "SELECT count(*) FROM rorca.story_output_chunks WHERE run_id=${RUN_ID}" 2>/dev/null)
  ssdlc=$(curl -sS --max-time 15 "http://127.0.0.1:3030/api/lifecycle/specs/${SPEC_ID}?workspaceId=${WORKSPACE_ID}" 2>/dev/null | jq -r '[("overall:"+.overallReadiness.status+":"+((.overallReadiness.completionRate*100)|floor|tostring)+"%"),("assurance:"+.readiness.assurance.status+":"+((.readiness.assurance.coverage*100)|floor|tostring)+"%"),("delivery:"+.readiness.delivery.status),([.phaseTimeline[] | .phaseId+":"+.status] | join(","))] | join(";")' 2>/dev/null)
  evidence=$(psql "$DB_URL" -Atc "SELECT COALESCE(string_agg(COALESCE(story_id,'-')||':'||evidence_type||':'||evidence_status||':'||n, ',' ORDER BY story_id,evidence_type,evidence_status),'') FROM (SELECT story_id,evidence_type,evidence_status,count(*)::text AS n FROM rorca.ssdlc_lifecycle_evidence WHERE run_id=${RUN_ID} GROUP BY story_id,evidence_type,evidence_status) e" 2>/dev/null)
  decisions=$(psql "$DB_URL" -Atc "SELECT COALESCE(string_agg(COALESCE(story_id,'-')||':'||COALESCE(phase_id,'-')||':'||COALESCE(gate_id,'-')||':'||decision_type, ',' ORDER BY id),'') FROM rorca.ssdlc_lifecycle_decisions WHERE run_id=${RUN_ID}" 2>/dev/null)
  integrations=$(psql "$DB_URL" -Atc "SELECT COALESCE(string_agg(story_id||':'||state||':'||COALESCE(resulting_head,'-'), ',' ORDER BY integration_order),'') FROM rorca.story_integration_ledger WHERE run_id=${RUN_ID}" 2>/dev/null)
  [ -z "$ssdlc" ] && ssdlc="$last_ssdlc"
  [ -z "$evidence" ] && [ -n "$last_evidence" ] && evidence="$last_evidence"
  [ -z "$decisions" ] && [ -n "$last_decisions" ] && decisions="$last_decisions"
  [ -z "$integrations" ] && [ -n "$last_integrations" ] && integrations="$last_integrations"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  transition=""
  [ "$status" != "$last_status" ] && transition="$transition status:$last_status->$status"
  [ "$lifecycle" != "$last_lifecycle" ] && transition="$transition lifecycle:$last_lifecycle->$lifecycle"
  [ "$stories" != "$last_story_result" ] && transition="$transition stories:[$stories]"
  [ "$ssdlc" != "$last_ssdlc" ] && transition="$transition ssdlc:[$ssdlc]"
  [ "$evidence" != "$last_evidence" ] && transition="$transition evidence:[$evidence]"
  [ "$decisions" != "$last_decisions" ] && transition="$transition decisions:[$decisions]"
  [ "$integrations" != "$last_integrations" ] && transition="$transition integrations:[$integrations]"
  if [ "$events" != "$seen_events" ]; then
    new=$(comm -13 <(echo "$seen_events" | tr ',' '\n' | sort) <(echo "$events" | tr ',' '\n' | sort) | tr '\n' ',')
    [ -n "$new" ] && transition="$transition new_events:$new"
  fi

  if [ -n "$transition" ]; then
    echo "$now RUN=${RUN_ID}${transition} chunks=$chunks" >> "$OUT"
  fi
  last_status="$status"; last_lifecycle="$lifecycle"; last_story_result="$stories"; seen_events="$events"
  last_ssdlc="$ssdlc"; last_evidence="$evidence"; last_decisions="$decisions"; last_integrations="$integrations"

  if [ "$status" = "failed" ] || [ "$status" = "done" ] || [ "$status" = "cancelled" ]; then
    echo "$now RUN=${RUN_ID} TERMINAL status=$status lifecycle=$lifecycle final_stories=[$stories] final_ssdlc=[$ssdlc] final_evidence=[$evidence] final_decisions=[$decisions] final_integrations=[$integrations]" >> "$OUT"
    exit 0
  fi
  sleep 60
done
