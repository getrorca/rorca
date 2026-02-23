# AGENTS.md — scripts/

Shell scripts and Ralph Loop orchestration. The main entry point for running specs.

## run-loop.sh

The Ralph Loop — iterates over user stories in a JSON spec, runs `claude --print` per story, handles retries and logging.

### Usage
```bash
./scripts/run-loop.sh                                   # Run pending (prd-implement.json)
./scripts/run-loop.sh --json prd-qa.json                # QA test-writing mode
./scripts/run-loop.sh --json ralph/specs/approved/slug.json  # Specific approved spec
./scripts/run-loop.sh --story US-005                    # Run one specific story
./scripts/run-loop.sh --dry-run                         # Preview what would run next
./scripts/run-loop.sh --json /absolute/path/spec.json   # Absolute path supported
```

### JSON Format Support
Two formats auto-detected (Python helper normalizes both to flat story list):
- **Implementation**: `{ "userStories": [{ "id": "US-001", ... }] }`
- **QA**: `{ "phases": [{ "stories": [{ "id": "QA-001", ... }] }] }`

### Context File Discovery (Auto-loaded per run)
run-loop.sh reads these files from the working directory and injects them into each Claude invocation:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Architecture reference, gotchas, critical patterns |
| `.claude/skills/rorcha.md` | Skill prompt (falls back to `dimitri.md`) |
| `AGENTS.md` | Directory-specific gotchas for files being modified |
| `progress.txt` | Resume checkpoint — which stories are done/in-progress |

### Retry Logic
- Up to 3 retries per story before skip
- `story_results` table updated: `status='retry'` during retry, `status='fail'` after max retries
- `status='skip'` if max retries exceeded and `--skip-on-failure` flag set

### Logging
- Live logs: `scripts/ralph/logs/<runId>-<storyId>.log`
- Archived on completion: `scripts/ralph/logs/archive/`
- Error logs: `scripts/ralph/logs/<runId>-<storyId>.err`

### Process Isolation (CRITICAL)
```bash
# run-loop.sh unsets all 4 Claude Code env vars before each claude invocation:
env -u CLAUDECODE \
    -u CLAUDE_CODE_ENTRYPOINT \
    -u CLAUDE_AGENT_SDK_VERSION \
    -u CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING \
    gtimeout --foreground 600 claude --print "..."
```

**`gtimeout --foreground` is REQUIRED**: Without `--foreground`, the child process enters a new process group that isn't the terminal's foreground → `SIGTTOU` → `T` (stopped) state → 0-byte logs, loop appears stuck.

### Absolute Path Support for --json
One-line fix applied (backward-compatible):
```bash
# If path starts with /, use as-is. Otherwise prefix with $SCRIPT_DIR.
--json) if [[ "$2" = /* ]]; then JSON_FILE="$2"; else JSON_FILE="$SCRIPT_DIR/$2"; fi; shift 2 ;;
```
This allows the pipeline trigger endpoint to pass absolute spec paths.

## Other Scripts

| Script | Purpose |
|--------|---------|
| `scripts/ralph/run-all-pipelines.sh` | Full pipeline: journeys + UX feedback |
| `scripts/ralph/measure-performance.sh` | Measure API SLOs vs budget-manifest.json |
| `scripts/ralph/verify-ai-traps.sh` | Verify AI catches seeded anomalies |
| `scripts/demo-seed/seed-*.ts` | Demo workspace seeder scripts |

## Common Mistakes

- **stdin pipe produces 0-byte output**: `cat file | claude --print` silently fails. Use positional arg: `claude --print "$(cat file)"`.
- **Reusing a terminal after hard kill**: Process group state can persist. Always use a fresh terminal window after `kill -9` on a stuck loop.
- **Only 1 Claude env var unset**: Must unset ALL 4. Unsetting only `CLAUDECODE` is not enough.
- **Missing `--foreground` on gtimeout**: Without it, the child process gets `SIGTTOU` and enters stopped state.
- **run-loop.sh lives in the TARGET workspace**: Rorcha finds it at `workspace.path/scripts/run-loop.sh` — NOT in Rorcha's own repo. Each project has its own copy.
