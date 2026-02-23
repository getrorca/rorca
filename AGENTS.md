# AGENTS.md — Rorcha Root

## Project Overview
Rorcha is an AI spec orchestration dashboard. Frontend: React 18 + Vite + Tailwind on :5210. Backend: Express.js + SQLite on :3030. LLM via `claude --print` (subscription, no API key).

## Key Architecture Decisions
- **No hot-reload on backend**: Every backend change requires `lsof -ti:3030 | xargs kill -9 && cd backend && npm run dev`
- **better-sqlite3 is synchronous**: Never use async/await for DB operations. `.get()` → T|undefined, `.all()` → T[], `.run()` → RunResult
- **WAL events are the event bus**: Every state change (spec approved, run started, story passed) must emit a `wal_events` row — this drives the SSE pipeline monitor
- **Workspaces store filesystem paths**: `workspaces.path` is an absolute path to the project repo (e.g. `/Users/dimitriteravanessian/rorcha`). Backend uses this to find run-loop.sh and spec files
- **run-loop.sh lives in the PROJECT workspace**: Rorcha finds it at `workspace.path/scripts/run-loop.sh` — NOT in Rorcha's own repo

## Critical Gotchas

### Spec Path Construction (CRITICAL — has caused bugs)
```typescript
// WRONG — wrong subdir and uses specName (title) not slug
specPath: `specs/approved/${spec.specName}.json`
// CORRECT
specPath: `ralph/specs/approved/${spec.id}.json`
// Backend resolves: path.join(workspace.path, 'scripts', specPath)
// → workspace.path/scripts/ralph/specs/approved/slug.json ✓
```

### spec.id vs spec.specName
- `spec.id` = filename slug (e.g. `rorcha-feature-enhancements`) — use for API calls and path construction
- `spec.specName` = human-readable title (e.g. "Rorcha Feature Enhancements") — display only

### chatComplete Return Type
`chatComplete()` returns `ChatResult { text: string; usage: TokenUsage }`. **Always use `.text`** — never treat the result as a string directly.

### Claude Env Vars for Nested Invocation
When spawning `claude` as a child process, unset ALL 4 vars:
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`
Unsetting only CLAUDECODE is not enough.

### CLAUDE_BIN Full Path Required
NVM PATH isn't inherited by Node child processes. Always resolve the full claude path via `CLAUDE_BIN` env var or hardcoded fallback in `llm-client.ts`.

### Stale Pipeline Runs
Runs stay `status='running'` after backend restart even though their processes are dead. Diagnose:
```sql
SELECT id, pid, status FROM pipeline_runs WHERE status='running';
```
Fix: `UPDATE pipeline_runs SET status='failed', finished_at=datetime('now') WHERE id=?`

### xterm.js Package Name
Use `@xterm/xterm` and `@xterm/addon-fit` (the new scoped packages), NOT the old `xterm` package.

## Dev Commands
```bash
npm run dev                           # Start frontend + backend
lsof -ti:3030 | xargs kill -9        # Kill backend
cd backend && npm run dev             # Restart backend
bash -c "cd /Users/dimitriteravanessian/rorcha && npx tsc --noEmit" && bash -c "cd /Users/dimitriteravanessian/rorcha/backend && npx tsc --noEmit"
```

## Database (SQLite at backend/rorcha.db)
Tables: `workspaces` | `direction_layers` | `pipeline_runs` | `story_results` | `wal_events` | `workspace_context` | `spec_versions` | `templates`

WAL mode + FK constraints enabled on every connection (see `backend/src/db/index.ts`).

## Implemented Features (as of Feb 2026)
- Spec Forge: generate → Review Queue → approve/reject → Archive
- Direction Stack: 5-layer context cascade (L1 global brain → L5 story annotations)
- Spec Versions: `spec_versions` table, diff endpoint, auto-version on regenerate
- Template Library: workspace-agnostic reusable spec structures
- LLM Model Selection: ChatResult type, SUPPORTED_MODELS, model resolution chain
- Pipeline Trigger UI: "Run in Pipeline" button in Archive → actually spawns run-loop.sh
- Conflict Detection: active run → prompt for worktree → autoWorktree option
- Worktree Merge: "Merge to main" button in Worktrees panel
- xterm.js Terminal: live subprocess stdout/stderr in Pipeline Monitor Terminal tab
- Add More Stories: POST /api/specs/:id/add-stories generates N more with correct numbering
- Archive Badges: repoName + branchName badges on spec cards
