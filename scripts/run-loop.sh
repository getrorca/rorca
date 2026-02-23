#!/bin/bash
# Ralph Loop — Bash-native implementation
# Runs Claude Code per story with fresh context each time.
# Live output, no context degradation.
#
# Usage:
#   ./scripts/ralph/run-loop.sh                              # Run pending (default: prd-implement.json)
#   ./scripts/ralph/run-loop.sh --json prd-qa.json           # Use a different task file
#   ./scripts/ralph/run-loop.sh --dry-run                    # Preview next story without executing
#   ./scripts/ralph/run-loop.sh --story QA-002               # Run a specific story
#   ./scripts/ralph/run-loop.sh --json prd-qa.json --story QA-002
#
# Stop: Ctrl+C (current story finishes, loop exits)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON_FILE="$SCRIPT_DIR/prd-implement.json"
LOG_DIR="$SCRIPT_DIR/logs"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
DRY_RUN=false
SPECIFIC_STORY=""
MAX_RETRIES=3  # Retry failed stories up to N times before skipping

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --story) SPECIFIC_STORY="$2"; shift 2 ;;
    --json) if [[ "$2" = /* ]]; then JSON_FILE="$2"; else JSON_FILE="$SCRIPT_DIR/$2"; fi; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# Validate JSON file exists
if [ ! -f "$JSON_FILE" ]; then
  echo "Error: JSON file not found: $JSON_FILE"
  exit 1
fi

# Create log directory
mkdir -p "$LOG_DIR"

# Trap Ctrl+C for clean exit
trap 'echo ""; echo "⏹  Loop stopped by user."; exit 0' INT

# Helper: normalize both JSON schemas into a flat story list
# Supports: { userStories: [...] } (prd-implement.json)
#       and { phases: [{ stories: [...] }] } (prd-qa.json)
NORMALIZE_PY='
def get_stories(d):
    if "userStories" in d:
        return d["userStories"]
    stories = []
    for phase in d.get("phases", []):
        for s in phase.get("stories", []):
            stories.append(s)
    return stories

def is_passed(s):
    if "passes" in s:
        return bool(s["passes"])
    return s.get("status") == "passed"

def get_acceptance(s):
    """Get acceptance criteria as string from either JSON format."""
    # prd-qa.json uses "acceptance" (string)
    if "acceptance" in s:
        return s["acceptance"]
    # prd-implement.json uses "acceptanceCriteria" (array)
    ac = s.get("acceptanceCriteria", [])
    if ac:
        return chr(10).join(f"- {a}" for a in ac)
    return ""

def is_qa_mode(d):
    """Detect QA mode from JSON structure (phases = QA, userStories = impl)."""
    return "phases" in d

def get_playbook(d):
    """Get playbook path if present in JSON."""
    return d.get("playbook", "")
'

# Detect mode (QA vs implementation) from JSON structure
MODE=$(python3 -c "
import json
with open('$JSON_FILE') as f:
    d = json.load(f)
explicit = d.get('mode', '')
if explicit:
    print(explicit)
elif 'phases' in d:
    print('qa')
else:
    print('impl')
")
PLAYBOOK=$(python3 -c "
import json
with open('$JSON_FILE') as f:
    d = json.load(f)
print(d.get('playbook', ''))
")

# Find next pending story (respects dependsOn)
get_next_story() {
  python3 -c "
import json, sys

$NORMALIZE_PY

with open('$JSON_FILE') as f:
    d = json.load(f)

stories = get_stories(d)
passed_ids = {s['id'] for s in stories if is_passed(s)}

for s in sorted(stories, key=lambda x: x.get('priority', 999)):
    if is_passed(s):
        continue
    # Skip permanently failed stories (marked skipped after max retries)
    if s.get('skipped'):
        continue
    # Skip deferred stories (excluded by user in Rorcha UI)
    if s.get('excluded'):
        continue
    # Check dependencies
    deps = s.get('dependsOn', [])
    if all(dep in passed_ids for dep in deps):
        ac = get_acceptance(s).replace(chr(10), '  ')
        desc = s['description'].replace(chr(10), ' ')
        print(f\"{s['id']}|||{s['title']}|||{desc}|||{ac}\")
        sys.exit(0)

print('DONE')
"
}

# Mark story as passed in JSON
mark_story_passed() {
  local story_id="$1"
  python3 -c "
import json

$NORMALIZE_PY

with open('$JSON_FILE', 'r') as f:
    d = json.load(f)

for s in get_stories(d):
    if s['id'] == '$story_id':
        if 'passes' in s or 'userStories' in d:
            s['passes'] = True
            s['notes'] = 'Completed by ralph loop'
        else:
            s['status'] = 'passed'
        break

with open('$JSON_FILE', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')

print('Marked $story_id as passed')
"
}

# Mark story as skipped (permanent — get_next_story will ignore it)
mark_story_skipped() {
  local story_id="$1"
  python3 -c "
import json

$NORMALIZE_PY

with open('$JSON_FILE', 'r') as f:
    d = json.load(f)

for s in get_stories(d):
    if s['id'] == '$story_id':
        s['skipped'] = True
        s['notes'] = 'Skipped after max retries — fix manually and re-run with --story $story_id'
        break

with open('$JSON_FILE', 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')

print('Marked $story_id as skipped')
"
}

# Count progress
get_progress() {
  python3 -c "
import json

$NORMALIZE_PY

with open('$JSON_FILE') as f:
    d = json.load(f)
stories = get_stories(d)
total = len(stories)
passed = sum(1 for s in stories if is_passed(s))
print(f'{passed}/{total}')
"
}

MODE_LABEL="Implementation"
[ "$MODE" = "qa" ] && MODE_LABEL="QA Testing"
[ "$MODE" = "journey" ] && MODE_LABEL="User Journey"

echo "╔══════════════════════════════════════════╗"
echo "║         Ralph Loop — $MODE_LABEL"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Progress: $(get_progress)"
echo "JSON: $JSON_FILE"
[ -n "$PLAYBOOK" ] && echo "Playbook: $PLAYBOOK"
echo ""

ITERATION=0

while true; do
  ITERATION=$((ITERATION + 1))

  # Get next story
  if [ -n "$SPECIFIC_STORY" ]; then
    RESULT=$(python3 -c "
import json, sys

$NORMALIZE_PY

with open('$JSON_FILE') as f:
    d = json.load(f)
for s in get_stories(d):
    if s['id'] == '$SPECIFIC_STORY':
        ac = get_acceptance(s).replace(chr(10), '  ')
        desc = s['description'].replace(chr(10), ' ')
        print(f\"{s['id']}|||{s['title']}|||{desc}|||{ac}\")
        sys.exit(0)
print('NOT_FOUND')
")
    if [ "$RESULT" = "NOT_FOUND" ]; then
      echo "Story $SPECIFIC_STORY not found!"
      exit 1
    fi
  else
    RESULT=$(get_next_story)
  fi

  # Check if done
  if [ "$RESULT" = "DONE" ]; then
    echo ""
    echo "✅ All stories complete! $(get_progress)"
    exit 0
  fi

  # Parse story fields (||| delimiter)
  STORY_ID=$(echo "$RESULT" | awk -F'\\|\\|\\|' '{print $1}')
  STORY_TITLE=$(echo "$RESULT" | awk -F'\\|\\|\\|' '{print $2}')
  STORY_DESC=$(echo "$RESULT" | awk -F'\\|\\|\\|' '{print $3}')
  STORY_AC=$(echo "$RESULT" | awk -F'\\|\\|\\|' '{print $4}')
  LOG_FILE="$LOG_DIR/${STORY_ID}_$(date +%Y%m%d_%H%M%S).log"

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "▶ [$MODE] Iteration $ITERATION | $STORY_ID: $STORY_TITLE"
  echo "  Progress: $(get_progress)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  if [ "$DRY_RUN" = true ]; then
    echo "  [DRY RUN] Would execute: $STORY_ID"
    echo "  Description: $STORY_DESC"
    [ -n "$STORY_AC" ] && echo "  Acceptance: $STORY_AC"
    echo ""
    exit 0
  fi

  # Build the prompt file — piped via stdin to avoid CLI arg length limits
  PROMPT_FILE="$LOG_DIR/${STORY_ID}_prompt.txt"

  if [ "$MODE" = "journey" ]; then
    # Journey mode: navigate + fix + commit. Reads user-journey.md playbook.
    JOURNEY_SKILL=$(cat "$PLAYBOOK" 2>/dev/null || echo "")
    AC_SECTION=""
    if [ -n "$STORY_AC" ]; then
      AC_SECTION="
Acceptance Criteria:
$STORY_AC"
    fi
    cat > "$PROMPT_FILE" <<PROMPT_EOF
You are simulating real users navigating CashflowAI. Read CLAUDE.md for architecture.

$JOURNEY_SKILL

---

Your task ($STORY_ID): $STORY_TITLE

$STORY_DESC
$AC_SECTION
PROMPT_EOF
  elif [ "$MODE" = "qa" ]; then
    # QA mode: test-writing focused prompt, reference playbook
    PLAYBOOK_INSTRUCTION=""
    if [ -n "$PLAYBOOK" ] && [ -f "$PLAYBOOK" ]; then
      PLAYBOOK_INSTRUCTION="IMPORTANT: Read $PLAYBOOK first for test patterns, conventions, and section references mentioned in the description."
    fi
    cat > "$PROMPT_FILE" <<PROMPT_EOF
You are writing tests for CashflowAI. Read CLAUDE.md for architecture and gotchas.

$PLAYBOOK_INSTRUCTION

## Workflow
1. Read the relevant AGENTS.md in each directory you'll modify
2. Read any referenced docs (Playbook sections, PRDs, SDDs)
3. Write the tests described below
4. Run the tests and fix failures until all pass
5. Run type checks: npx tsc --noEmit (frontend) and cd backend && npx tsc --noEmit (backend)
6. Run npm run build to verify build succeeds

## Do NOT:
- Implement features or modify production code (only test files)
- Skip running the tests — every test must actually execute and pass
- Write placeholder/todo tests — all tests must have real assertions

---

Your task ($STORY_ID): $STORY_TITLE

$STORY_DESC

Acceptance Criteria:
$STORY_AC
PROMPT_EOF
  else
    # Implementation mode: use rorcha.md skill (falls back to dimitri.md for legacy projects)
    SKILL_CONTENT=$(cat .claude/skills/rorcha.md 2>/dev/null || cat .claude/skills/dimitri.md 2>/dev/null || echo "")
    AC_SECTION=""
    if [ -n "$STORY_AC" ]; then
      AC_SECTION="
Acceptance Criteria:
$STORY_AC"
    fi
    cat > "$PROMPT_FILE" <<PROMPT_EOF
Follow this workflow for implementation:

$SKILL_CONTENT

---

Your task ($STORY_ID):
$STORY_DESC
$AC_SECTION
PROMPT_EOF
  fi

  # Run Claude Code with fresh context (skip permissions for autonomous operation)
  # Uses stream-json for live progress, filtered through Python formatter.
  # TIMEOUT_CMD is a bash array — correct quoting, no word-split issues.
  # gtimeout/timeout exit 124 on kill → PIPESTATUS[0]=124 → retry logic fires.
  # No perl fallback — broken when stored in a variable. Install coreutils instead.
  STORY_TIMEOUT=2700  # 45 minutes
  # claude is baked into the array so it's never empty — avoids set -u "unbound variable"
  # on empty arrays. gtimeout/timeout wrap it; fallback runs claude directly (no timeout).
  if command -v gtimeout &>/dev/null; then
    # --foreground keeps claude in the terminal's foreground process group.
    # Without this, gtimeout creates a new process group and claude gets SIGTTOU
    # (background write to terminal) → immediately suspended (T state).
    CLAUDE_CMD=(gtimeout --foreground "$STORY_TIMEOUT" claude)
  elif command -v timeout &>/dev/null; then
    CLAUDE_CMD=(timeout --foreground "$STORY_TIMEOUT" claude)
  else
    echo "⚠️  No timeout command (gtimeout/timeout). Install: brew install coreutils" >&2
    CLAUDE_CMD=(claude)
  fi
  echo ""
  PROMPT_CONTENT="$(cat "$PROMPT_FILE")"
  # set +e: prevents set -eo pipefail from aborting the script before EXIT_CODE
  # is read from PIPESTATUS. Without this, any non-zero claude exit kills the
  # entire loop before the retry logic can run.
  set +e
  # Unset ALL Claude Code env vars — unsetting only CLAUDECODE is not enough.
  # All 4 must be cleared or claude detects a nested session and refuses to run.
  env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING "${CLAUDE_CMD[@]}" --dangerously-skip-permissions --print --verbose --output-format stream-json "$PROMPT_CONTENT" 2>"$LOG_DIR/${STORY_ID}_debug.log" | python3 -u -c "
import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        print(line, flush=True)
        continue
    t = msg.get('type', '')
    if t == 'assistant':
        # Extract text blocks from assistant messages
        content = msg.get('message', {}).get('content', [])
        for block in content:
            if block.get('type') == 'text':
                text = block.get('text', '')
                if text.strip():
                    print(text, flush=True)
            elif block.get('type') == 'tool_use':
                name = block.get('name', '?')
                inp = block.get('input', {})
                if name == 'Read':
                    print(f'  📖 Read: {inp.get(\"file_path\", \"?\")}'.rstrip(), flush=True)
                elif name == 'Write':
                    print(f'  ✏️  Write: {inp.get(\"file_path\", \"?\")}'.rstrip(), flush=True)
                elif name == 'Edit':
                    print(f'  ✏️  Edit: {inp.get(\"file_path\", \"?\")}'.rstrip(), flush=True)
                elif name == 'Bash':
                    cmd = inp.get('command', '?')
                    if len(cmd) > 80:
                        cmd = cmd[:77] + '...'
                    print(f'  🔧 Bash: {cmd}'.rstrip(), flush=True)
                elif name == 'Glob':
                    print(f'  🔍 Glob: {inp.get(\"pattern\", \"?\")}'.rstrip(), flush=True)
                elif name == 'Grep':
                    print(f'  🔍 Grep: {inp.get(\"pattern\", \"?\")}'.rstrip(), flush=True)
                elif name == 'TodoWrite':
                    todos = inp.get('todos', [])
                    active = [t for t in todos if t.get('status') == 'in_progress']
                    if active:
                        print(f'  📋 {active[0].get(\"activeForm\", \"Working...\")}'.rstrip(), flush=True)
                else:
                    print(f'  🔧 {name}'.rstrip(), flush=True)
    elif t == 'result':
        result = msg.get('result', '')
        if result:
            print(result, flush=True)
" | tee "$LOG_FILE"
  EXIT_CODE=${PIPESTATUS[0]}
  set -e

  echo ""

  if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ $STORY_ID completed (exit 0)"
    mark_story_passed "$STORY_ID"
    unset "RETRY_COUNT_${STORY_ID//-/_}" 2>/dev/null || true

    # Auto-commit and push
    echo "📦 Committing $STORY_ID..."
    COMMIT_PREFIX="feat"
    [ "$MODE" = "qa" ] && COMMIT_PREFIX="test"
    [ "$MODE" = "journey" ] && COMMIT_PREFIX="journey"
    git add -A
    git commit -m "$COMMIT_PREFIX($STORY_ID): $STORY_TITLE

Automated by ralph loop.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>" || true
    git push origin HEAD || echo "⚠️  Push failed (will retry next iteration)"
  else
    # Track retries per story
    RETRY_VAR="RETRY_COUNT_${STORY_ID//-/_}"
    CURRENT_RETRIES=${!RETRY_VAR:-0}
    CURRENT_RETRIES=$((CURRENT_RETRIES + 1))
    export "$RETRY_VAR=$CURRENT_RETRIES"

    if [ $CURRENT_RETRIES -ge $MAX_RETRIES ]; then
      echo "❌ $STORY_ID failed after $MAX_RETRIES attempts. Skipping."
      echo "   Log: $LOG_FILE"
      echo "   Fix manually, then re-run with: ./scripts/ralph/run-loop.sh --story $STORY_ID"
      mark_story_skipped "$STORY_ID"
    else
      echo "⚠️  $STORY_ID failed (attempt $CURRENT_RETRIES/$MAX_RETRIES)"
      echo "   Log: $LOG_FILE"
      echo "   Will retry..."
    fi
  fi

  # If running a specific story, exit after one run
  if [ -n "$SPECIFIC_STORY" ]; then
    exit $EXIT_CODE
  fi

  echo ""
  sleep 3
done
