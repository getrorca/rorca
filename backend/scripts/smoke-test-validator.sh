#!/usr/bin/env bash
# Smoke test for rorca-spec-validator endpoints
# Tests all 6 new spec validation endpoints + pipeline queue
# Exits 0 if all pass, 1 if any fail

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3030}"
SPEC_ID="rorca-spec-validator"
PASS=0
FAIL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ok() { echo -e "${GREEN}PASS${NC} $1"; ((PASS++)) || true; }
fail() { echo -e "${RED}FAIL${NC} $1: $2"; ((FAIL++)) || true; }

check_field() {
  local label="$1"
  local url="$2"
  local method="$3"
  local field="$4"
  local field_type="$5"

  local response
  local http_code

  if [[ "$method" == "GET" ]]; then
    response=$(curl -s -w '\n%{http_code}' "$url")
  else
    response=$(curl -s -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$url")
  fi

  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [[ "$http_code" != "200" ]]; then
    fail "$label" "expected HTTP 200, got $http_code. Body: ${body:0:200}"
    return
  fi

  # Check field exists and has correct type
  local type_check
  if [[ "$field_type" == "boolean" ]]; then
    type_check=$(echo "$body" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const val = d['$field'];
      process.exit(typeof val === 'boolean' ? 0 : 1);
    " 2>/dev/null && echo "ok" || echo "fail")
  elif [[ "$field_type" == "number" ]]; then
    type_check=$(echo "$body" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const val = d['$field'];
      process.exit(typeof val === 'number' ? 0 : 1);
    " 2>/dev/null && echo "ok" || echo "fail")
  elif [[ "$field_type" == "object" ]]; then
    type_check=$(echo "$body" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const val = d['$field'];
      process.exit(val !== null && typeof val === 'object' && !Array.isArray(val) ? 0 : 1);
    " 2>/dev/null && echo "ok" || echo "fail")
  elif [[ "$field_type" == "array" ]]; then
    type_check=$(echo "$body" | node -e "
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const val = d['$field'];
      process.exit(Array.isArray(val) ? 0 : 1);
    " 2>/dev/null && echo "ok" || echo "fail")
  fi

  if [[ "$type_check" == "ok" ]]; then
    ok "$label ($method $url) → {$field: $field_type}"
  else
    fail "$label" "field '$field' missing or wrong type (expected $field_type). Body: ${body:0:200}"
  fi
}

echo "=== Rorca Spec Validator Smoke Tests ==="
echo "Base URL: $BASE_URL"
echo "Spec ID:  $SPEC_ID"
echo ""

# 1. GET /api/specs/:id/check → {valid: boolean}
check_field "check" \
  "$BASE_URL/api/specs/$SPEC_ID/check" \
  "GET" "valid" "boolean"

# 2. GET /api/specs/:id/score → {score: number, breakdown: object}
check_field "score (score field)" \
  "$BASE_URL/api/specs/$SPEC_ID/score" \
  "GET" "score" "number"

check_field "score (breakdown field)" \
  "$BASE_URL/api/specs/$SPEC_ID/score" \
  "GET" "breakdown" "object"

# 3. POST /api/specs/:id/validate → {errors: array}
check_field "validate" \
  "$BASE_URL/api/specs/$SPEC_ID/validate" \
  "POST" "errors" "array"

# 4. POST /api/specs/:id/suggest-skills → {skills: array}
check_field "suggest-skills" \
  "$BASE_URL/api/specs/$SPEC_ID/suggest-skills" \
  "POST" "skills" "array"

# 5. POST /api/specs/:id/fix → {fixed: boolean}
check_field "fix" \
  "$BASE_URL/api/specs/$SPEC_ID/fix" \
  "POST" "fixed" "boolean"

# 6. POST /api/pipeline/queue → {queued: boolean}
check_field "pipeline/queue" \
  "$BASE_URL/api/pipeline/queue" \
  "POST" "queued" "boolean"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
