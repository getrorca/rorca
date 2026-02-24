# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

AI spec orchestration and pipeline management for autonomous Claude Code development.

## Build & Dev Commands

```bash
# Start everything (recommended)
npm run dev                # Frontend :5210 + Backend :3030 concurrently

# Frontend (root)
npm run dev                # Vite dev server (:5210)
npm run build              # TypeScript + Vite production build
npm run lint               # ESLint
npx tsc --noEmit           # Frontend type check

# Backend (backend/)
cd backend && npm run dev  # Express server (:3030) — NO hot-reload, requires restart
cd backend && npm run mcp  # Run MCP server standalone (for debugging)
cd backend && npm test     # Jest test suite
cd backend && npx tsc --noEmit   # Backend type check
cd backend && npx jest --testPathPattern=<name>  # Single test file

# Frontend tests (Vitest, not Jest)
npx vitest run             # Run all frontend tests once
npx vitest                 # Watch mode

# Type check both (run from root)
bash -c "cd /Users/dimitriteravanessian/rorcha && npx tsc --noEmit; echo FRONTEND:\$?" && bash -c "cd /Users/dimitriteravanessian/rorcha/backend && npx tsc --noEmit; echo BACKEND:\$?"

# Kill & restart backend (no hot-reload)
lsof -ti:3030 | xargs kill -9 && cd backend && npm run dev

# Self-hosting (register rorcha/ as its own workspace)
npm run self-register
```

## Architecture

**Rorcha** is an AI spec orchestration dashboard. It turns a plain-English brief into a validated, structured spec via Claude, tracks approval/execution, and provides live pipeline monitoring.

```
Browser (React :5210)  ←→  Express API (:3030)  ←→  SQLite (WAL)
                                    ↓
                            claude --print (Claude subscription)
                            run-loop.sh (spawned in project workspace)
```

**Stack**:
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS + xterm.js
- Backend: Express.js + TypeScript + SQLite (`better-sqlite3`, WAL mode, FK on)
- LLM: multi-provider via `SPEC_PROVIDER` env var (`claude` → claude --print, `anthropic` → SDK, `openrouter` → OpenRouter)
- MCP: 5 tools exposing Rorcha to Claude Code sessions

**Ports**: Frontend 5210, Backend 3030, FinOps sim 5200

## Key Concepts

### Direction Stack (5-layer context cascade)
| Layer | Scope | Content |
|-------|-------|---------|
| L1 | Global (all workspaces) | Engineering principles, preferred libraries |
| L2 | Domain (e.g. "saas") | Auth patterns, API conventions |
| L3 | Project (one workspace) | Stack, architecture, key constraints |
| L4 | Spec brief | What this feature is and why |
| L5 | Story annotations | Edge cases, reviewer notes |

Lower layers override higher ones (like CSS specificity). L1–L2 are globals; L3+ are per-workspace.

### Spec Lifecycle
`Spec Forge → Review Queue → Approved → Pipeline Run → Archive`

Spec files live in the **project workspace** (not Rorcha):
- Pending: `<workspace>/scripts/ralph/specs/pending/<slug>.json`
- Approved: `<workspace>/scripts/ralph/specs/approved/<slug>.json`

### Spec JSON format
```json
{
  "title": "my-spec-slug",
  "userStories": [
    {
      "id": "US-001",
      "title": "...",
      "description": "...",
      "acceptanceCriteria": ["..."],
      "dependsOn": [],
      "passes": false
    }
  ],
  "model": "claude-sonnet-4-5-20250929",
  "generatedAt": "2026-02-23T..."
}
```
⚠️ Key field is `userStories` (NOT `stories`). `id` is always the slug (filename without `.json`), NOT the human-readable title.

### The Ralph Loop (`run-loop.sh`)
`run-loop.sh` lives in the **project workspace** (e.g. CashflowAI), NOT in Rorcha. Rorcha's backend finds it at `workspace.path/scripts/run-loop.sh` and spawns it with `bash`.

**Flags**: `--json <file>` (use different spec), `--story <ID>` (run single story), `--dry-run` (preview only)

**Modes** (auto-detected from JSON structure):
- Implementation: `{ userStories: [...] }` — uses `rorcha.md` skill, `feat:` commits
- QA: `{ phases: [{ stories: [...] }] }` — test-writing prompt, `test:` commits

**Context auto-read** by run-loop.sh from the project working directory:
- `CLAUDE.md` — architecture + gotchas injected into every story prompt
- `.claude/skills/rorcha.md` — workflow skill (falls back to `dimitri.md`)
- `AGENTS.md` — referenced in skill; agents read directory-level AGENTS.md before touching code
- `progress.txt` — resume state across compactions

## Directory Structure

```
rorcha/
├── src/                      # React frontend
│   ├── panels/               # 7 main panel components
│   ├── components/           # Shared UI (Shell, Sidebar, RunTerminal, etc.)
│   ├── contexts/             # WorkspaceContext
│   ├── hooks/                # usePipelineSSE
│   ├── lib/                  # apiFetch
│   └── styles/               # Global CSS
├── backend/
│   └── src/
│       ├── routes/           # Express route handlers
│       ├── lib/              # Core services
│       ├── mcp/              # MCP stdio server (5 tools)
│       └── db/
│           ├── index.ts      # DB connection + schema bootstrapper
│           └── migrations/   # SQL migration files (001–006)
├── scripts/
│   ├── run-loop.sh           # Ralph Loop execution engine
│   ├── self-register.ts      # Self-hosting bootstrap
│   └── ralph/                # Spec JSON files + logs
│       └── specs/
│           ├── pending/      # Generated, awaiting approval
│           └── approved/     # Approved, ready to run
└── backend/rorcha.db         # SQLite database (auto-created)
```

## Database Tables

| Table | Purpose |
|-------|---------|
| `workspaces` | Registered git repositories (`id`, `label`, `path`, `domain`) |
| `direction_layers` | Direction Stack content per layer/workspace/domain |
| `pipeline_runs` | Ralph Loop execution records (`spec_path`, `status`, `pid`, `started_at`, `finished_at`) |
| `story_results` | Per-story pass/fail/skip outcomes per run |
| `wal_events` | Append-only event log (`event_type`, `spec_id`, `workspace_id`, `payload` JSON) |
| `workspace_context` | Cached git memory + schema snapshots |
| `spec_versions` | Versioned spec snapshots (for version comparison + rejection preservation) |
| `templates` | Reusable spec structures (workspace-agnostic) |

**WAL event types**: `generate`, `spec_approved`, `spec_rejected`, `run_started`, `story_started`, `story_passed`, `story_failed`, `story_skipped`, `run_finished`, `worktree_created`, `worktree_merged`

WAL mode + FK constraints are enabled on every DB connection in `backend/src/db/index.ts`.

## API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/specs/generate` | Generate spec via LLM |
| `GET /api/specs` | List specs (pending/approved/all) |
| `GET /api/specs/archive` | Archive with search + pagination |
| `GET /api/specs/:id` | Get spec detail |
| `POST /api/specs/:id/approve` | Move to approved/ |
| `POST /api/specs/:id/reject` | Delete + preserve in wal_events |
| `POST /api/specs/:id/add-stories` | Generate additional stories for existing spec |
| `GET /api/specs/:id/versions` | List historical versions |
| `GET /api/specs/:id/diff?v1=N&v2=M` | Structured diff between versions |
| `GET /api/direction` | Get direction layers |
| `PUT /api/direction` | Upsert direction layer |
| `GET /api/direction/models` | List supported LLM models |
| `POST /api/pipeline/trigger` | Spawn run-loop.sh (actual execution) |
| `GET /api/pipeline/runs` | List pipeline runs |
| `GET /api/pipeline/runs/:id` | Get run + story results |
| `GET /api/pipeline/runs/:id/output` | SSE stream of raw terminal output (xterm.js) |
| `GET /api/pipeline/stream` | SSE stream of WAL events (story progress) |
| `POST /api/context/extract` | Multi-source context extraction (paste/file/URL/Q&A) |
| `GET /api/wal` | Query WAL event log |
| `GET /api/worktrees` | List git worktrees |
| `POST /api/worktrees/merge` | Merge worktree branch to main |
| `GET /api/workspaces` | List registered workspaces |
| `POST /api/workspaces` | Register a new workspace |
| `GET /api/templates` | List spec templates |
| `POST /api/templates` | Create template from approved spec |
| `GET /api/templates/:id` | Get template detail |
| `DELETE /api/templates/:id` | Delete template |
| `GET /api/health` | Health check |

## Critical Gotchas

### Top 5
1. **`chatComplete` returns `ChatResult { text, usage }`** — always use `.text` accessor. Never treat result as a string.
2. **better-sqlite3 is synchronous** — never use async in DB calls. `db.prepare(sql).get()` returns T|undefined, `.all()` returns T[], `.run()` returns RunResult.
3. **spec `id` ≠ spec `specName`** — `id` is the filename slug (`rorcha-feature-enhancements`), `specName` is the human title. Use `spec.id` to construct file paths.
4. **run-loop.sh lives in the PROJECT workspace** — Rorcha finds it at `workspace.path/scripts/run-loop.sh`, not in Rorcha's own repo.
5. **Backend requires restart** — `tsx` has no hot-reload. Always `lsof -ti:3030 | xargs kill -9 && npm run dev` after any backend changes.

### Auth Middleware — Intentionally Bypassed
`app.use(authRequired)` in `backend/src/server.ts` line ~78 is **commented out**. This is intentional — Rorcha is a local single-user tool and the login wall blocks workspaces API causing onboarding to show incorrectly. Do NOT re-enable globally. Auth routes (`/api/auth/*`) still work for the registered user (`admin@rorcha.local` / `rorcha123`). If authRequired reappears as a global middleware, comment it out again.

### Spec Path Construction
```typescript
// WRONG — wrong subdirectory, uses specName (title) not slug
specPath: `specs/approved/${spec.specName}.json`
// CORRECT
specPath: `ralph/specs/approved/${spec.id}.json`
// Backend resolves full path:
const absSpecPath = path.join(workspace.path, 'scripts', specPath);
// → workspace.path/scripts/ralph/specs/approved/slug.json ✓
```

### Pipeline Trigger (POST /api/pipeline/trigger)
- Checks for active runs (conflict detection) — returns `{ conflict: true, activeRunId }` if running
- On `autoWorktree: true` — creates git worktree branch `feat/<slug>-<timestamp>`, runs loop there
- Strips 4 Claude env vars before spawning: `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`
- `CLAUDE_BIN` full path required — NVM PATH isn't inherited by Node child processes
- Captures stdout/stderr into in-memory buffer keyed by `runId` → streamed to xterm.js via SSE

### xterm.js Terminal Output
- `GET /api/pipeline/runs/:runId/output` SSE endpoint streams raw bytes (base64-encoded) to frontend
- `RunTerminal.tsx` uses `@xterm/xterm` (NOT the old `xterm` package) + `@xterm/addon-fit`
- Late-joiners receive full buffer replay from process start
- Buffer is in-memory — lost on backend restart (old runs show "run not found or already completed")
- Cleanup: buffer auto-deleted 30 min after process exit

### Stale Pipeline Runs
Runs marked `status='running'` survive backend restarts but their processes are dead. On startup (or at diagnosis time):
```sql
-- Check via DB
SELECT id, pid, status FROM pipeline_runs WHERE status='running';
-- Fix
UPDATE pipeline_runs SET status='failed', finished_at=datetime('now') WHERE status='running' AND id=<id>;
```

### WAL Events Drive UI
The Pipeline Monitor (`/api/pipeline/stream` SSE) polls `wal_events` every 3s. Story progress only appears after `run-loop.sh` writes `story_started`/`story_passed` events to the WAL (via its own Python scripts). The Terminal tab shows raw output independently of WAL events.

### Direction Stack Synthesis
`synthesize()` in `backend/src/lib/direction-stack.ts` merges L1→L5 into a single context string. L4/L5 come from the spec brief and story annotations — not stored in `direction_layers`.

### LLM Model Resolution Chain (Spec Generation)
1. Explicit `model` param in request
2. Workspace L3 `preferred_model` column
3. `DEFAULT_MODEL` in `llm-client.ts`

`SUPPORTED_MODELS` list is authoritative — validate before passing to `chatComplete`.

### SQLite Migration Pattern
Migrations are SQL files in `backend/src/db/migrations/`. They run in numeric order on first startup. For column additions (SQLite lacks `ADD COLUMN IF NOT EXISTS`), use `pragma table_info` check in `db/index.ts` instead of a migration file.

### MCP Tools (5 total)
`rorcha_get_context` | `rorcha_generate_spec` | `rorcha_list_specs` | `rorcha_approve_spec` | `rorcha_pipeline_status`

Setup: `claude mcp add rorcha -- npx tsx /absolute/path/to/rorcha/backend/src/mcp/server.ts`

### Multi-Workspace Support
`workspaces.path` stores the absolute filesystem path of each project. Backend uses this to:
- Find `scripts/run-loop.sh` for pipeline trigger
- Resolve spec JSON absolute paths
- Create git worktrees in the correct repo

Multiple workspaces can run simultaneously. Same-workspace parallel runs require worktrees (conflict detection enforced).

### Archive Panel Spec ID vs. Name
- `spec.id` = filename slug = use for API calls and path construction
- `spec.specName` = human-readable title = display only
- `spec.repoName` = `path.basename(workspace.path)` = shown as badge on card
- `spec.branchName` = git worktree branch (if run in worktree) = shown with `GitBranch` icon

## Environment

**Frontend** (`.env.local`, root): No required env vars — backend is always `http://localhost:3030`

**Backend** (`backend/.env`):
```bash
SPEC_PROVIDER=claude          # Options: claude (default), anthropic, openrouter
ANTHROPIC_API_KEY=sk-ant-...  # Required if SPEC_PROVIDER=anthropic
OPENROUTER_API_KEY=sk-or-...  # Required if SPEC_PROVIDER=openrouter
PORT=3030                     # Optional override
DB_PATH=./rorcha.db           # Optional override
```
When `SPEC_PROVIDER=claude` (default), no API key is needed — uses `claude --print` via `~/.claude/` auth.

## Performance Targets
- Spec generation: < 60s (LLM call)
- Archive search: < 100ms (SQLite full-text scan)
- SSE heartbeat: 15s
- WAL poll: 3s
- Story timeout: 45 min (gtimeout --foreground)

## CI
E2E tests: `npm run test:e2e` (Playwright — configured in `rorcha-e2e-testing` spec, not yet built).
Unit/integration: `npm run typecheck && cd backend && npm test`.

## Model Usage Guide
- **Opus 4-6** (`claude-opus-4-6`): Use for implementation specs — architecture decisions, complex reasoning
- **Sonnet 4-6** (`claude-sonnet-4-6`): Use for QA/test-writing specs — faster, cheaper on Claude sub, sufficient for test generation
- Set `"model"` field in spec JSON before triggering, or set workspace L3 `preferred_model`

## Spec Pipeline — Run Order
After `rorcha-v2-platform` finishes (113 stories — V2-089–092 excluded):
1. `rorcha-ui-redesign` (64 stories) — new navigation shell, Hub, Run View, Forge, Graph, Command Palette
2. `rorcha-integrations` (51 stories) — Linear, GitHub deeper, Vercel, Slack
3. `rorcha-e2e-testing` (58 stories) — Playwright E2E, finds and fixes bugs

All three specs are in `scripts/ralph/specs/pending/`. Approve via Hub when ready.

**Why V2-089–092 excluded**: Stories V2-089 (Forge redesign), V2-090 (Spec detail), V2-091 (Pipeline DAG), V2-092 (Dashboard) are superseded by `rorcha-ui-redesign` which does all of this plus the navigation shell. Running both would create throwaway work.

## UI Redesign Architecture (rorcha-ui-redesign)
The redesign replaces the 10-icon sidebar with a 4-screen architecture:

```
4 nav icons: + (New), Hub (grid), Forge (hammer), Settings (gear)

Hub (default)    → Active run card + Pending reviews + Recent runs
Run View         → Full-screen: terminal (60%) + story list (40%) + Graph tab
Forge            → Brief input + direction stack sidebar + inline approve
Settings         → Direction Stack / Model / GitHub / Account / Billing tabs
```

Key components:
- **Command palette**: `cmdk` library, ⌘K trigger, context-aware
- **Graph view**: D3.js or React Flow DAG from `dependsOn` fields — NO graph DB needed. Nodes = stories, edges = dependsOn. Colors: grey/blue-pulse/green/red by status from `story_results` + SSE
- **HITL blocked state**: Amber banner when run-loop is stuck, textarea to inject context, resume without kill
- **Semantic logging**: Parse xterm output for `[Read]`, `[Write]`, `[Planning]`, `[Executing]`, `[Commit]` prefixes — toggle raw/semantic

## Integration Roadmap (rorcha-integrations)
Priority order: Linear → GitHub deeper → Vercel → Slack

| Integration | Key value |
|---|---|
| Linear | Issue → spec import, story pass → sub-issue done, run complete → parent issue update |
| GitHub | Issue → spec, auto PR on completion, commit status checks per story, Actions trigger |
| Vercel | Auto-deploy on run complete, preview URL in Run View, production promote button |
| Slack | Run notifications, spec approval via interactive buttons, consecutive failure alert |

All tokens stored AES-256-GCM encrypted in `integration_credentials` table.

## Platform Distribution Roadmap
```
Phase 1 (now)       npm package (V2-108) — rorcha start
                    VS Code extension — embed React frontend as WebviewPanel (~200 lines glue)
Phase 2 (cloud)     Railway deployment, Anthropic SDK path (V2-114), auth + billing
Phase 3 (desktop)   PWA (manifest.json + service worker, no App Store needed)
                    Tauri — after PMF, when users ask for it
Phase 4 (mobile)    React Native — AFTER cloud is live (mobile needs a server to connect to)
```

**VS Code extension**: Reuses existing React frontend as a VS Code WebviewPanel. Adds status bar item (● N/M), command palette entries (⌘⇧P "Rorcha: New Spec"), sidebar icon. Publish to VS Code Marketplace. ~200 lines of extension glue code.

**Tauri vs Electron**: Use Tauri (~20MB). Rust layer is thin system glue (window, tray, menus). All LLM integrations, Express backend, TypeScript — unchanged. Express runs as Tauri sidecar process.

## Business Model & Licensing
- **Commercial** (not open source initially) — source-available via BSL or Commons Clause
- **Register "Rorcha" trademark** at USPTO before launch (~$350) — protects name even if code is inspectable
- **Pricing**: Free (spec generation only, no pipeline execution) → $15/month (full execution, 3 workspaces) → $30/month (unlimited workspaces, team)
- **Cloud vs self-hosted**: self-hosted free forever, cloud version paid
- **BYOB**: Rorcha never pays for inference — users bring their own Claude sub or API key

## Competitive Positioning
- **vs ChatPRD**: "ChatPRD writes the plan. Rorcha ships it." ChatPRD outputs a document, Rorcha executes code.
- **vs Devin**: Task-oriented ($500/mo), no spec concept, no direction stack, no pipeline monitoring
- **vs MetaGPT**: Academic research project, no UI, no production pipeline
- **"Spec-driven development"** is unclaimed terminology — no Google results, blue ocean category to own
- Core moat: direction stack (persistent context cascade) + per-story isolated execution + live DAG visualization
