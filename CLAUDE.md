# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Rorca**: AI spec orchestration and pipeline management for autonomous software development.

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
bash -c "cd /Users/dimitriteravanessian/rorca && npx tsc --noEmit; echo FRONTEND:\$?" && bash -c "cd /Users/dimitriteravanessian/rorca/backend && npx tsc --noEmit; echo BACKEND:\$?"

# Kill & restart backend (no hot-reload)
lsof -ti:3030 | xargs kill -9 && cd backend && npm run dev

# Self-hosting (register rorca/ as its own workspace)
npm run self-register
```

## Architecture

**Rorca** is a spec-driven development platform. It turns a plain-English brief into a structured spec (N user stories), then executes each story as an isolated subprocess with the full tool set — no context limits, resumable, runs to completion autonomously.

```
Browser (React :5210)  ←→  Express API (:3030)  ←→  SQLite (WAL)
                                    ↓
                            Execution Engine (per-story subprocess)
                            ├── claude --print      (Claude subscription)
                            └── opencode run        (75+ providers via API key)

Landing Page: Next.js 14 + Tailwind v4 + Framer Motion (:3002)
```

**Stack**:
- Frontend: React 18 + TypeScript + Vite + Tailwind CSS + xterm.js
- Backend: Express.js + TypeScript + SQLite (`better-sqlite3`, WAL mode, FK on)
- Execution: `claude --print` (Claude sub) OR `opencode run --format json --attach` (OpenCode, any provider)
- Spec generation: OpenCode (autonomous codebase exploration) OR SDK fallback (`SPEC_PROVIDER` env var)
- MCP: 5 tools exposing Rorca to Claude Code sessions

**Ports**: Frontend 5210, Backend 3030, FinOps sim 5200

## Execution Engine — Core Identity

Every story runs as a fresh isolated subprocess with the full tool set. No context limits. A spec can run forever.

```
Spec (N stories)
  └── Story 1  →  fresh agent subprocess  →  edit, bash, read, write, glob, grep  →  commit
  └── Story 2  →  fresh agent subprocess  →  edit, bash, read, write, glob, grep  →  commit
  └── Story N  →  ...
```

### Two execution paths — both first-class

**Claude subscription** (Pro / Max / Max 5x):
- Binary: `claude --print`
- Advantages: prompt caching on tool round trips (~10x lower latency after turn 1), surgical diff edits (~150 tokens vs ~3000 for full rewrites), persistent bash shell state across tool calls, CLAUDE.md auto-injection, hierarchical subagents (Task tool), fine-tuned for agentic coding loops
- Subscription tier affects rate limits only — Pro may throttle on 64+ story specs, Max/Max5x recommended for production

**OpenCode** (API key: any provider):
- Binary: `opencode run --model <provider>/<model> --format json --attach`
- Supports: OpenAI (GPT-4o, o3), Google (Gemini 2.0), Anthropic API, OpenRouter (75+ models), GitHub Copilot subscription, local Ollama (free)
- Same tool set: `edit` (surgical), `bash`, `read`, `write`, `glob`, `grep`, `webfetch`, `websearch`
- `--format json` outputs structured events → semantic log view gets structured data for free (no xterm parsing)
- `--attach` reuses a warm server across stories → no cold-start overhead per story
- Configured via `RORCA_AGENT=opencode` + `RORCA_MODEL=openai/gpt-4o`

**No raw SDK agent path for execution.** OpenCode IS the multi-model execution path. A raw `openai.chat.completions.create()` call cannot replace it — no persistent bash state, no surgical edits, no CLAUDE.md injection.

### OpenCode for spec generation
OpenCode also handles spec generation (not just execution). Spec gen benefits from tools: `glob` existing specs, `read` CLAUDE.md, `grep` codebase patterns, `webfetch` library docs. This makes specs dramatically more context-aware than a blind API call and replaces the manual context extraction step.

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

Spec files live in the **project workspace** (not Rorca):
- Pending: `<workspace>/forge/specs/pending/<slug>.json`
- Approved: `<workspace>/forge/specs/approved/<slug>.json`

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

### The Ralph Loop (`backend/src/lib/run-loop.ts` → `execution-engine.ts`)
The current primary engine is `backend/src/lib/run-loop.ts` — TypeScript, cross-platform, spawned by `pipeline.ts` via `npx tsx`. The legacy `forge/run-loop.sh` (in each project workspace) is a fallback — `pipeline.ts` checks for `run-loop.sh` first; if absent, uses the TS version. **The `rorca-opencode-integration` spec (OC-004) replaces both with `backend/src/lib/execution-engine.ts`**, which adds multi-agent switching (claude / opencode / codex). After that spec runs, edit `execution-engine.ts` for all execution behavior — `run-loop.ts` becomes dead code.

**Flags**: `--json <path>` (spec file), `--cwd <path>` (workspace root), `--run-id <number>` (required for WAL events), `--story <ID>` (single story), `--dry-run` (preview only), `--port <number>` (default 3030)

**Modes** (auto-detected from JSON structure):
- Implementation (`impl`): `{ userStories: [...] }` — injects `.claude/skills/rorca.md`, `feat:` commits
- QA (`qa`): `{ phases: [{ stories: [...] }] }` — test-writing prompt, `test:` commits
- Journey (`journey`): `{ mode: "journey", ... }` — user simulation prompt, `journey:` commits

**What `run-loop.ts` does per story**:
1. `emitWalEvent('story_started')` via `fetch` to `/api/wal`
2. Spawns `claude --dangerously-skip-permissions --print --verbose --output-format stream-json` with clean env (4 Claude vars stripped)
3. Timeout via SIGTERM → SIGKILL after 10s (replaces `gtimeout`)
4. On exit 0: `markStoryPassed()` (writes spec JSON), `gitCommitStory()`, `emitWalEvent('story_passed')`, POST to `/api/pipeline/story-result`
5. On exit 124 (timeout): `markStorySkipped()`, `emitWalEvent('story_failed', { reason: 'timeout' })`
6. On non-zero: retry up to `MAX_RETRIES=3`, then skip with `emitWalEvent('story_failed', { reason: 'max_retries' })`

**Context injected** by `buildPrompt()` from the workspace `cwd`:
- `.claude/skills/rorca.md` — workflow skill (falls back to `dimitri.md`)
- `spec.playbook` field — optional playbook file path read into QA/journey prompts
- `CLAUDE.md` is injected automatically by `claude --print` (not manually by run-loop.ts)

## Directory Structure

```
rorca/
├── src/                      # React frontend
│   ├── panels/               # 22 panel components (one per sidebar nav item)
│   ├── components/           # Shared UI (Shell, Sidebar, RunTerminal, CommandPalette, etc.)
│   ├── contexts/             # WorkspaceContext, AuthContext, ThemeContext,
│   │                         # ToastContext, NotificationContext, HelpTipsContext
│   ├── hooks/                # usePipelineSSE, useHotkeys
│   ├── lib/                  # apiFetch
│   └── styles/               # Global CSS
├── backend/
│   └── src/
│       ├── routes/           # Express route handlers (32 route files)
│       ├── lib/              # Core services (sse-hub, direction-stack, llm-client,
│       │                     # errors, scheduler, agent-hook-runner, etc.)
│       ├── mcp/              # MCP stdio server (5 tools)
│       └── db/
│           ├── index.ts      # DB connection + schema bootstrapper
│           └── migrations/   # SQL migration files (001–036)
├── forge/
│   ├── run-loop.sh           # Ralph Loop execution engine
│   ├── self-register.ts      # Self-hosting bootstrap
│   └── specs/                # Spec JSON files + logs
│       ├── pending/          # Generated, awaiting approval
│       └── approved/         # Approved, ready to run
└── backend/rorca.db         # SQLite database (auto-created)
```

### Sidebar Navigation Sections (defined in `src/components/Sidebar.tsx`)
The `PanelId` type and `NAV_SECTIONS` array are the canonical source of truth for which panels exist and how they're organized:

| Section | Panels (PanelId) |
|---------|-----------------|
| Specs | `forge`, `queue`, `archive`, `marketplace` |
| Pipeline | `pipeline`, `worktrees`, `compare` |
| Direction | `stack`, `team-direction` |
| Analytics | `usage`, `costs`, `models`, `velocity`, `completion`, `roi`, `health` |
| System | `audit-log`, `activity`, `github`, `workspace-settings`, `settings` |

## Database Tables

36 migrations (`backend/src/db/migrations/001–036`). Key tables:

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
| `users` | Auth users; `refresh_tokens` for JWT session management |
| `github_connections` | OAuth tokens + installation IDs per workspace |
| `teams` + `team_members` | Multi-user team management |
| `spec_tags` + `spec_tag_assignments` | Tagging specs |
| `pipeline_hooks` | Pre/post run webhook triggers |
| `pipeline_schedules` | Cron-based scheduled runs |
| `workspace_env_vars` | Per-workspace environment variable injection |
| `story_commits` | Git SHAs committed per story |
| `story_comments` | Comments on individual stories |
| `team_direction_layers` | Team-scoped direction stack entries |
| `marketplace_templates` | Shared template marketplace |
| `token_usage` | Per-run/story LLM token consumption |
| `budget_config` | Workspace spending limits |
| `vault_keys` | AES-256-GCM encrypted API keys |
| `onboarding_state` | Tracks onboarding wizard progress |
| `agent_hooks` + `agent_hook_invocations` | Pre/post story lifecycle hooks |
| `agent_profiles` | Named agent configurations (model, temperature, etc.) |
| `notification_subscriptions` + `notification_history` | In-app/email/webhook notifications |
| `user_settings` | Per-user preferences |
| `billing` | Stripe subscription tracking |
| `provider_defaults` | Default model configs per provider |

**WAL event types**: `generate`, `spec_approved`, `spec_rejected`, `run_started`, `story_started`, `story_passed`, `story_failed`, `story_skipped`, `run_finished`, `worktree_created`, `worktree_merged`, `run_blocked` (HITL pause), `context_file_changed` (CIE file watcher), `story_escalated` (CIE model escalation)

WAL mode + FK constraints are enabled on every DB connection in `backend/src/db/index.ts`.

## API Routes

Key routes (see `backend/src/server.ts` for full mount list):

**Specs & Direction**
| Route | Purpose |
|-------|---------|
| `POST /api/specs/generate` | Generate spec via LLM |
| `GET /api/specs` | List specs (pending/approved/all) |
| `GET /api/specs/archive` | Archive with search + pagination |
| `POST /api/specs/:id/approve` | Move to approved/ |
| `POST /api/specs/:id/reject` | Delete + preserve in wal_events |
| `POST /api/specs/:id/add-stories` | Generate additional stories |
| `GET /api/specs/:id/versions` + `.../diff` | Version history + structured diff |
| `GET/PUT /api/direction` | Get/upsert direction layers |
| `GET /api/direction/models` | List supported LLM models |

**Pipeline**
| Route | Purpose |
|-------|---------|
| `POST /api/pipeline/trigger` | Spawn run-loop.sh |
| `GET /api/pipeline/runs/:id/output` | SSE: raw terminal (xterm.js) |
| `GET /api/pipeline/stream` | SSE: WAL events (story progress) |
| `GET /api/pipeline/hooks` | Pipeline lifecycle webhooks |
| `GET /api/pipeline/schedules` | Cron-scheduled runs |

**Workspaces & Teams**
| Route | Purpose |
|-------|---------|
| `GET/POST /api/workspaces` | List / register workspaces |
| `GET /api/workspaces/:id/env-vars` | Workspace environment variables |
| `GET /api/workspaces/:id/budget` | Workspace spending limits |
| `GET /api/workspaces/:id/agent-hooks` | Agent lifecycle hooks |
| `GET /api/workspaces/:id/agent-profiles` | Named agent configurations |
| `GET /api/workspaces/:id/github` | GitHub integration per workspace |
| `GET /api/teams` | Team management |
| `GET /api/invites` | Team invite management |

**Analytics & Observability**
| Route | Purpose |
|-------|---------|
| `GET /api/analytics` | Token usage, costs, velocity |
| `GET /api/activity` | Activity feed |
| `GET /api/wal` | Query WAL event log |
| `GET /api/worktrees` | List git worktrees |
| `POST /api/worktrees/merge` | Merge worktree branch |

**Auth & Users**
| Route | Purpose |
|-------|---------|
| `POST /api/auth/login` | JWT login |
| `POST /api/auth/register` | Register user |
| `POST /api/auth/refresh` | Refresh JWT |
| `POST /api/auth/logout` | Invalidate refresh token |
| `POST /api/auth/forgot-password` | Initiate password reset |
| `GET /api/users` | User management |
| `GET /api/notifications` | Notification preferences + history |
| `GET /api/settings` | User settings |
| `GET /api/billing` | Stripe subscription |

**Other**
| Route | Purpose |
|-------|---------|
| `GET /api/templates` | Spec templates + marketplace |
| `GET /api/vault/keys` | Encrypted API key vault |
| `POST /api/context/extract` | Context extraction |
| `POST /api/webhooks` | GitHub webhook receiver |
| `GET /api/github/checks` | GitHub check runs |
| `GET /api/docs` | Swagger UI (OpenAPI spec at `/api/docs/openapi.json`) |
| `GET /api/health` | Health check |
| `GET /api/admin` | Backups |

## Backend Infrastructure

Key `backend/src/lib/` modules beyond `llm-client` and `direction-stack`:

- **`sse-hub.ts`** — Centralized pub/sub for WAL events. `broadcastAll(event)` fans out to all subscribers. `attachSSE(res)` wires an Express response. `subscribe(fn)` is used by `agent-hook-runner` and `notification-dispatcher` too — not just HTTP clients.
- **`errors.ts`** — `AppError` class hierarchy: `ValidationError` (400), `AuthError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `UnprocessableError` (422). Throw these from route handlers; `error-handler.ts` catches and serializes to `{ error, code, details }`.
- **`scheduler.ts`** — Cron job runner for `pipeline_schedules`. Calls pipeline trigger internally.
- **`agent-hook-runner.ts`** — Subscribes to SSE hub; fires agent hooks on WAL events matching configured patterns.
- **`notification-dispatcher.ts`** — Subscribes to SSE hub; routes WAL events to email/webhook/in-app notification channels.
- **`rate-limiter.ts`** — IP-based Express middleware. Applied to public routes with a tighter limit, and all routes after auth.
- **`paginate.ts`** — Standard `{ items, total, page, pageSize }` helper for paginated routes.
- **`swagger.ts`** — Auto-generates OpenAPI spec from JSDoc `@swagger` annotations. Served at `/api/docs`.

### Static Serving (Self-Hosted)
When `RORCA_SERVE_STATIC=1` + `RORCA_STATIC_DIR=<path>`, Express serves the built frontend and handles SPA fallback. This is the `rorca start` CLI mode — frontend and backend served from the same process on port 3030.

## Critical Gotchas

### Top 5
1. **`chatComplete` returns `ChatResult { text, usage }`** — always use `.text` accessor. Never treat result as a string.
2. **better-sqlite3 is synchronous** — never use async in DB calls. `db.prepare(sql).get()` returns T|undefined, `.all()` returns T[], `.run()` returns RunResult.
3. **spec `id` ≠ spec `specName`** — `id` is the filename slug (`rorca-feature-enhancements`), `specName` is the human title. Use `spec.id` to construct file paths.
4. **run-loop.sh lives in the PROJECT workspace** — Rorca finds it at `workspace.path/forge/run-loop.sh`, not in Rorca's own repo.
5. **Backend requires restart** — `tsx` has no hot-reload. Always `lsof -ti:3030 | xargs kill -9 && npm run dev` after any backend changes.

### Auth Middleware — Intentionally Bypassed
`app.use(authRequired)` in `backend/src/server.ts` line ~78 is **commented out**. This is intentional — Rorca is a local single-user tool and the login wall blocks workspaces API causing onboarding to show incorrectly. Do NOT re-enable globally. Auth routes (`/api/auth/*`) still work for the registered user (`admin@rorca.local` / `rorca123`). If authRequired reappears as a global middleware, comment it out again.

### Spec Path Construction
```typescript
// WRONG — wrong subdirectory, uses specName (title) not slug
specPath: `specs/approved/${spec.specName}.json`
// CORRECT
specPath: `forge/specs/approved/${spec.id}.json`
// Backend resolves full path:
const absSpecPath = path.join(workspace.path, specPath);
// → workspace.path/forge/specs/approved/slug.json ✓
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
`rorca_get_context` | `rorca_generate_spec` | `rorca_list_specs` | `rorca_approve_spec` | `rorca_pipeline_status`

Setup: `claude mcp add rorca -- npx tsx /absolute/path/to/rorca/backend/src/mcp/server.ts`

### Multi-Workspace Support
`workspaces.path` stores the absolute filesystem path of each project. Backend uses this to:
- Find `forge/run-loop.sh` for pipeline trigger
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
# Current (pre-opencode-integration spec)
SPEC_PROVIDER=claude          # Options: claude (default), anthropic, openrouter
ANTHROPIC_API_KEY=sk-ant-...  # Required if SPEC_PROVIDER=anthropic
OPENROUTER_API_KEY=sk-or-...  # Required if SPEC_PROVIDER=openrouter
PORT=3030                     # Optional override
DB_PATH=./rorca.db           # Optional override

# Added by rorca-opencode-integration spec (OC-001 to OC-007)
RORCA_AGENT=opencode         # Options: claude (default), opencode
RORCA_MODEL=openai/gpt-4o   # OpenCode model string (provider/model)
OPENCODE_BIN=/path/to/opencode  # Auto-detected if in PATH
```
When `RORCA_AGENT=claude` (default), uses `claude --print` via `~/.claude/` auth — no API key needed.
When `RORCA_AGENT=opencode`, uses `opencode run --format json --attach --model $RORCA_MODEL`.

**OpenCode minimum version**: `0.1.0` (enforced at startup via `backend/src/lib/opencode-detector.ts`). Backend exits with code 1 if `RORCA_AGENT=opencode` and binary is missing or below minimum version. Health endpoint (`GET /api/health`) returns `{ opencodeInstalled, opencodeVersion }` when `agentType=opencode`.

## Performance Targets
- Spec generation: < 60s (LLM call)
- Archive search: < 100ms (SQLite full-text scan)
- SSE heartbeat: 15s
- WAL poll: 3s
- Story timeout: 45 min (gtimeout --foreground)

## CI
E2E tests: `npm run test:e2e` (Playwright — configured in `rorca-e2e-testing` spec, not yet built).
Unit/integration: `npm run typecheck && cd backend && npm test`.

## Model Usage Guide

### Manual model selection
- **Opus 4-6** (`claude-opus-4-6`): Use for implementation specs — architecture decisions, complex reasoning
- **Sonnet 4-6** (`claude-sonnet-4-6`): Use for QA/test-writing specs — faster, cheaper on Claude sub, sufficient for test generation
- Set `"model"` field in spec JSON before triggering, or set workspace L3 `preferred_model`

### Model Cascading (added by rorca-opencode-integration OC-019–OC-020)
When OpenCode is the execution engine, a Story Complexity Scorer automatically assigns ModelTier before each subprocess spawn:

```
ModelTier assignment (scored from story metadata):
  Haiku   → simple CRUD, UI copy, config tweaks, low dependsOn depth
  Sonnet  → standard features, moderate file count, some business logic
  Opus    → architecture, security, payments, high dependsOn depth

Escalation cascade on failure:
  Haiku fails 2×  →  retry with Sonnet
  Sonnet fails 2× →  retry with Opus
  Opus fails      →  mark story_failed, notify user
```

**API arbitrage**: Cascading saves ~40–60% vs all-Opus baseline. FinOps dashboard (OC-023) shows realized savings per run and trend chart.

**Claude subscription path**: Cascading not applicable — `claude --print` uses the same subscription regardless of story complexity. Quality difference is negligible for most stories; Opus is the recommended tier for all implementation runs.

## Spec Pipeline — Run Order
`rorca-v2-platform` complete (113/117 stories — V2-089–092 excluded). Pending specs in `forge/specs/pending/`:

1. `rorca-ui-redesign` (65 stories) — **approve now**, Opus 4-6
2. `rorca-opencode-integration` (24 stories) — OpenCode execution path + Codex CLI (ChatGPT sub) + spec gen + story complexity scorer + model cascading (Haiku→Sonnet→Opus) + FinOps dashboard, Opus 4-6
3. `rorca-context-intent-engine` (18 stories) — .rorca/ directory, virtual context routing, episodic memory, file watchers, scaffold gen, Opus 4-6
4. `rorca-e2e-testing` (58 stories) — Playwright E2E, finds AND fixes bugs, Sonnet 4-6
5. `rorca-integrations` (52 stories) — GitHub first (launch blocker), Linear/Vercel/Slack post-launch, Opus 4-6

**Why this order**: OpenCode before context engine (context engine uses OpenCode for synthesis + scaffold gen). Context engine before E2E so Playwright tests the complete system including routing engine. GitHub only launch blocker in integrations.

**Why V2-089–092 excluded**: Superseded by `rorca-ui-redesign` which covers all panel redesigns plus the navigation shell. Running both creates throwaway work.

## UI Redesign Architecture (rorca-ui-redesign)
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

## Context/Intent Engine Architecture (rorca-context-intent-engine)

**Philosophical split**: Context = "The Is" (what the codebase IS — CLAUDE.md, file structure, patterns). Intent = "The Ought" (what should be built — spec JSON, direction stack, story goals). Rorca bridges both.

```
Is (Context/Ontology)          Ought (Intent/Teleology)
──────────────────────         ──────────────────────────
CLAUDE.md                      Spec JSON (userStories)
.rorca/config.json            Direction Stack (L1–L5)
AGENTS.md (file governance)    Story annotations (L5)
run-state.json                 Brief → spec pipeline
MEMORY.md (ledger)
```

### .rorca/ directory (introduced by CIE spec)
```
.rorca/
├── config.json          # Orchestration config (routing, cascades, wave parallelism)
├── MEMORY.md            # Episodic ledger — timestamped structured rules (NOT prose)
├── AGENTS.md            # Soft governance: file ownership, behavioral rules per area
└── skills/              # Skill library (reusable rorca.md snippets)
```

### Key CIE concepts
- **Virtual context routing**: `config.json` routing table with path glob scoping. `micromatch`-based path prediction assigns right context slices to right stories. No file scatter.
- **Episodic MEMORY.md ledger**: Structured timestamped rule entries, not prose. Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha. Post-run synthesis adds entries automatically.
- **AGENTS.md as soft governance**: File ownership + behavioral rules injected into prompts. NOT hard filesystem RBAC (too complex for v1).
- **run-state.json**: Typed event ledger replacing `progress.txt`. Atomic writes, deterministic resume across compaction.
- **"Eject to Config"**: Progressive disclosure — `.rorca/config.json` generated on demand for advanced users who want to customize routing, thresholds, or cascades.
- **Chokidar file watchers**: Real-time filesystem → UI sync when users edit context files externally. Bi-directional Direction Stack ↔ CLAUDE.md sync with approval.
- **Trojan horse strategy**: Rorca's filesystem-native output (CLAUDE.md, MEMORY.md, AGENTS.md) makes ALL other AI tools (Cursor, Copilot, raw Claude Code) smarter. Ambient dependency = sticky retention without lock-in.

## Integration Roadmap (rorca-integrations)
**Launch blocker**: GitHub only. All others are post-launch additions.

| Integration | Priority | Key value |
|---|---|---|
| GitHub | **Launch** | Issue → spec, auto PR on completion, commit status checks per story |
| Linear | Post-launch | Issue → spec import, story pass → sub-issue done, run complete → parent update |
| Vercel | Post-launch | Auto-deploy on run complete, preview URL in Run View, production promote button |
| Slack | Post-launch | Run notifications, spec approval via interactive buttons, failure alerts |

All tokens stored AES-256-GCM encrypted in `integration_credentials` table.

## Platform Distribution Roadmap

```
Phase 1 — Self-hosted CLI (NOW)
  npm i -g rorca && rorca start
  Domain: rorca.app (primary) + rorca.ai (redirect)
  GitHub integration (launch blocker)
  Claude subscription OR OpenCode (any model via API key)
  Trademark "Rorca" at USPTO (~$350) before public announcement

Phase 2 — Marketing Website + VS Code Extension
  rorca.app landing page — "Generate specs with any model. Ship them with Claude."
  VS Code extension: React frontend as WebviewPanel, ~200 lines glue code
    Status bar item (● N/M stories), ⌘⇧P "Rorca: New Spec", sidebar icon
    Publish to VS Code Marketplace
  No new backend — same Express :3030

Phase 3 — Cloud Hosting (Railway)
  Prerequisite for all phases below
  PostgreSQL migration (SQLite → Postgres for multi-user concurrent writes)
  Anthropic SDK execution path (no local claude CLI in cloud)
  Multi-user auth + billing ($15/$30/mo)
  OpenCode path handles non-Claude users in cloud

Phase 4 — PWA
  manifest.json + service worker — no App Store approval needed
  Quick win after cloud is live, instant "install" from browser

Phase 5 — Tauri Desktop (after PMF)
  Only after users request it 3+ times
  ~20MB vs Electron ~150MB
  Rust layer is thin system glue: window, tray, menus only
  Express backend runs as Tauri sidecar process — zero backend code changes

Phase 6 — React Native Mobile (after cloud)
  Mobile needs a server to connect to — cannot launch before Phase 3
```

**Domain strategy**: `rorca.app` as primary (echoes `linear.app`, `railway.app` — the tier Rorca targets). Grab `rorca.ai` defensively and redirect to `.app`. Note: double-check spelling is `rorca` not `rorca` before purchasing.

## Business Model & Licensing
- **Commercial** (not open source initially) — source-available via BSL or Commons Clause
- **Register "Rorca" trademark** at USPTO before launch (~$350) — protects name even if code is inspectable
- **Pricing**: Free (spec generation only, no pipeline execution) → $15/month (full execution, 3 workspaces) → $30/month (unlimited workspaces, team)
- **Cloud vs self-hosted**: self-hosted free forever, cloud version paid
- **BYOB**: Rorca never pays for inference — users bring their own Claude sub or API key

## Competitive Positioning
- **vs ChatPRD**: "ChatPRD writes the plan. Rorca ships it." ChatPRD outputs a document, Rorca executes code.
- **vs Devin**: Task-oriented ($500/mo), no spec concept, no direction stack, no pipeline monitoring
- **vs MetaGPT**: Academic research project, no UI, no production pipeline
- **vs Cursor/Windsurf**: IDE assistants, not spec orchestrators — no pipeline, no direction stack, no autonomous multi-story execution
- **"Spec-driven development"** is unclaimed terminology — no Google results, blue ocean category to own

**Core moat (3 layers):**
1. Direction stack — persistent context cascade across all stories (L1–L5)
2. Per-story subprocess isolation — infinite effective context, runs to completion
3. Dual execution engine — `claude --print` (Claude sub) + `opencode run` (75+ providers) — same tool set, same quality, user chooses their model

**The brand statement**: "Every story runs as a fresh isolated subprocess with the full tool set — bash, edit, read, write, glob, grep. No context limits. A spec can run forever. That's the Rorca engine."

## Wave-Based Parallel Execution (Future Roadmap)

**Status**: Not built. Sequential execution is default for V1. Wave = opt-in V2 feature.

**The idea**: Instead of running stories one-by-one, compile the `dependsOn` DAG into topological wave groups. Each wave runs its stories in parallel git worktrees, then auto-merges before the next wave starts.

```
Wave 0 (no deps):  US-001, US-002, US-003 → 3 parallel worktrees → merge
Wave 1 (deps on wave 0): US-004, US-005 → 2 parallel worktrees → merge
Wave 2: US-006 → 1 worktree → merge → done
Sequential: 40 min total  →  Wave parallel: ~12 min (3.3x speedup on 3-wave spec)
```

**What needs to be built** (future `rorca-wave-execution` spec):
1. Wave compiler — topological sort of `dependsOn` DAG into wave groups (~50 lines)
2. Wave orchestrator — spawn N parallel subprocesses, one per story per wave
3. File-touch predictor — pre-analyze stories to detect shared-file conflicts before wave starts
4. Auto-merge sequence — merge each wave's worktrees in sequence; use Haiku to resolve conflicts
5. `.rorca/config.json` toggle: `execution.waveParallelism: false` (default) → `true` to enable

**Why not V1**: Shared filesystem race conditions. Two stories editing the same file simultaneously cause merge conflicts. The file-touch predictor + auto-merge resolves most, but adds complexity. Sequential is safer and simpler for initial launch. Wave stays opt-in.

**Trigger**: Build this spec after `rorca-integrations` ships. Requires worktrees (already built) + file-touch predictor (new). Infrastructure is 80% there.
