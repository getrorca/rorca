# AGENTS.md — Rorca Root

File governance, behavioral rules, and agent persona zones for the Rorca codebase.

## Project Overview
Rorca is an AI spec orchestration and pipeline management platform for autonomous software development.
- **Dashboard** (`/src`): React 18 + Vite + Tailwind on :5210
- **Backend** (`/backend`): Express.js + PostgreSQL 16 on :3030
- **Execution Engine**: `claude --print` (Claude sub), `opencode run` (75+ providers), `codex` (ChatGPT sub)

## File Ownership Zones

### Frontend (`src/`)
- **Owner**: Frontend specialist
- **Rules**:
  - All API calls through `src/lib/apiFetch` — never raw `fetch`
  - Panel components in `src/panels/` (one per sidebar nav item)
  - Shared UI in `src/components/` (Shell, Sidebar, SlideOver, RunTerminal, CommandPalette, etc.)
  - State via React Context (`src/contexts/`) — WorkspaceContext, AuthContext, ThemeContext, ToastContext
  - CSS custom properties for theming — no hardcoded hex, use tokens from `src/styles/tokens.css`
  - `PanelId` type in `Sidebar.tsx` is canonical source of truth for navigation
  - Context-aware sidebars: `SettingsSidebar` renders for settings/analytics panels, main `Sidebar` for everything else


## Workspace & Memory Conventions (agents — read before acting)
- **Select the canonical workspace first.** Call `rorca_select_workspace` with the
  workspace you intend to operate in before using any session-scoped memory or
  run tool. Do NOT create or invent new workspaces for one-off work — reuse an
  existing workspace (platform knowledge belongs in `rorca`; per-project work
  belongs in that project's existing workspace).
- **Workspaces are related by domain.** Every workspace carries a `domains`
  array (visible via `rorca_list_workspaces` / `rorca_get_workspaces`).
  Workspaces sharing a domain are a family: posting a memory to any member
  **automatically shares it with every other member** — no explicit linking
  needed. When creating a workspace, set its domains so its family linking
  works from day one.
- **Platform knowledge goes in `rorca` (or lands there automatically).** The
  rorca-family workspaces (`rorca`, `rorca-universal-assurance`, `rorca-bounty`,
  `hermes`) share the `rorca-platform` domain, so any operational issue, bug
  fix, decision, or gotcha posted from one of them is automatically retrievable
  from the canonical `rorca` workspace.
- **Memory sharing is additive visibility.** A shared memory is retrievable
  from the target workspace (retrieval unions `memory_workspace_shares`) but
  the owning workspace stays authoritative — never duplicate rows by posting
  the same memory twice.
- **Prefer the explicit-draft persistence path for specs** (`rorca_create_spec`
  / `rorca_persist_spec` with `contextUsed` + `contextSummary`) over backend
  generation, per the Spec Creation Contract below.

### Backend Routes (`backend/src/routes/`)
- **Owner**: Backend specialist
- **Rules**:
  - One file per resource (specs.ts, pipeline.ts, workspaces.ts, run-queue.ts, etc.)
  - JSDoc `@swagger` annotations on every public endpoint (feeds `/api/docs`)
  - Add `x-rorca-tier` on every `@swagger` operation. Valid tiers: `public | auth | paid | admin`. Omitted tier defaults to denied and is never MCP-exposed.
  - Any non-denied tier must include `x-rorca-rationale` explaining why that exposure level is correct.
  - `x-rorca-public-api: true` is only valid on `public` routes and marks the stable open-source CLI contract surface.
  - Throw `AppError` subclasses — never raw `Error` or manual `res.status().json()` for errors
  - Use `paginate()` for list endpoints
  - Validate input at route boundary, trust internal code after
  - Kanban API (`GET /api/specs/kanban`) returns `activeRunStatus` and `queuePosition` per spec — frontend derives running vs queued visual state from these fields

### Route Author Guide
Use this annotation shape for every exposed route:
```typescript
/**
 * @swagger
 * /api/specs:
 *   get:
 *     summary: List specs
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only spec listing — stable local/MCP surface with no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     responses:
 *       200: { description: OK }
 */
```

Choose tiers this way:
- `public`: safe local automation and CLI/MCP use, no write or operator-only side effects
- `auth`: user-owned local settings or profile data, still MCP-callable
- `paid`: non-OSS gated product surface, never MCP-callable
- `admin`: local operator-only maintenance, never MCP-callable

### Backend Libs (`backend/src/lib/`)
- **Owner**: Architect
- **Rules**:
  - `sse-hub.ts` — pub/sub hub, never bypass with direct `res.write()` for SSE
  - `direction-stack.ts` — `synthesize()` merges L1→L5, L4/L5 from spec not DB
  - `llm-client.ts` — `chatComplete()` returns `ChatResult { text, usage }` — NEVER treat as string
  - `errors.ts` — hierarchy: ValidationError(400), AuthError(401), ForbiddenError(403), NotFoundError(404), ConflictError(409), UnprocessableError(422)

### Database (`backend/src/db/`)
- **Owner**: Database specialist
- **Rules**:
  - PostgreSQL 16 via `pg` Pool — all DB calls are **async** (always `await`)
  - `query<T>()` → `T[]`, `queryOne<T>()` → `T | undefined`, `execute()` → `{ rowCount }`
  - Migrations are SQL in `pg-migrations/`, numbered sequentially (001–062+), tracked via `schema_migrations` table
  - Use `$1, $2, ...` numbered placeholders (NOT `?`)
  - FK constraints always on, connection pooling (max 20)
  - **pgboss schema is NOT hand-managed** — `pgboss.*` tables (job, archive, subscription, version) are created and upgraded automatically by `boss.start()`. Never write migrations that touch `pgboss.*`. Migration 062 is a no-op placeholder that documents this.
  - **pg-boss v10 requires explicit queue creation** — `boss.work('queue:name', handler)` does NOT create the queue or its partition table. You MUST call `await boss.createQueue('queue:name')` before calling `boss.send('queue:name', ...)`, otherwise `send()` returns `null` silently. The `job` table is partitioned by queue name (one partition per queue). In tests, call `createQueue` in `beforeAll` after `boss.start()`.
  - **pg-boss job `id` must be a valid UUID** — passing an integer string (e.g., `String(runId)`) to the `id` option of `boss.send()` causes a PostgreSQL UUID cast error. Use auto-generated UUIDs (omit the `id` option) and embed `runId` in the job's data payload for correlation.

### Execution Engine (`backend/src/lib/execution-engine.ts`)
- **Owner**: Architect
- **Criticality**: HIGH — core pipeline, changes require extra scrutiny
- **Rules**:
  - Never modify env var stripping (4 Claude vars) without understanding why
  - `buildPrompt()` is the single place where story context is assembled — persona overlays inject here (future)
  - Three execution paths (claude/opencode/codex) must stay symmetrical — same tool set, same output contract
  - Story timeout, retry logic, WAL event emission are safety-critical
  - `run-loop.ts` is legacy — `execution-engine.ts` is the canonical engine

### Styles (`src/styles/`)
- **Owner**: Frontend / UX Designer
- **Rules**:
  - `tokens.css` — CSS custom properties (colors, spacing, radii)
  - `index.css` — global styles, animations, utility classes
  - Theme switching via CSS variable swap — no Tailwind `dark:` prefix
  - `tailwind.config.ts` maps CSS variables to utility classes

## Spec Creation Contract

For agents/CLIs that create Rorca specs, the canonical path is:
- draft the spec in the caller when possible
- persist it through `rorca_create_spec` / `rorca_persist_spec` or `POST /api/specs/persist`
- treat `rorca_generate_spec` / `POST /api/specs/generate` as legacy/fallback backend drafting

If the user explicitly asks to create a Rorca spec and a structured tool surface is available, prefer the explicit-draft persistence path over backend generation.

## Critical Gotchas

### Spec Path Construction (CRITICAL — has caused bugs)
```typescript
// WRONG — wrong subdir, uses specName (title) not slug
specPath: `specs/approved/${spec.specName}.json`
// CORRECT
specPath: `forge/specs/approved/${spec.id}.json`
// Backend resolves: path.join(workspace.path, specPath)
```

### spec.id vs spec.specName
- `spec.id` = filename slug (`rorca-feature-enhancements`) — use for API calls and paths
- `spec.specName` = human title ("Rorca Feature Enhancements") — display only

### chatComplete Return Type
`chatComplete()` returns `ChatResult { text: string; usage: TokenUsage }`. **Always use `.text`**.

### Claude Env Vars for Nested Invocation
When spawning `claude` as child process, strip ALL 4:
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`

### CLAUDE_BIN Full Path Required
NVM PATH isn't inherited by Node child processes. Resolve full path via `CLAUDE_BIN` env var.

### Stale Pipeline Runs
```sql
SELECT id, pid, status FROM pipeline_runs WHERE status='running';
-- Fix: UPDATE pipeline_runs SET status='failed', finished_at=NOW() WHERE id=<id>;
```

### Auth Middleware — Intentionally Bypassed
`authRequired` in `server.ts` is **commented out** on purpose. Rorca is local single-user. Do NOT re-enable.

### xterm.js Package Name
Use `@xterm/xterm` + `@xterm/addon-fit` (scoped packages), NOT old `xterm`.

### SlideOver Navigation Pattern
Run View and Spec Review use `SlideOver` component (portal-rendered modal), not full-page panels. Hash-based deep linking: `#/run/:runId`. Navigation via hash change, not panel switch.

## Dev Commands
```bash
npm run dev                           # Start frontend + backend concurrently
lsof -ti:3030 | xargs kill -9        # Kill backend (no hot-reload)
cd backend && npm run dev             # Restart backend
cd backend && npm test                # Jest test suite
npx vitest run                        # Frontend tests (Vitest, not Jest)
npx tsc --noEmit                      # Frontend type check
cd backend && npx tsc --noEmit        # Backend type check
```

## Agent Persona Zones (Future — rorca-agent-personas spec)

When the persona system is built, ownership zones map to persona assignments:

| Zone | Primary Persona | Adversarial Reviewers |
|------|----------------|----------------------|
| `src/` | Frontend | UX Designer, Best Practices |
| `backend/src/routes/` | Backend | Security, Red Team |
| `backend/src/db/` | Database | Security, Assumption Buster |
| `backend/src/lib/execution-engine.ts` | Architect | Red Team, Devil's Advocate |
| `src/styles/` | UX Designer | Best Practices |
| `forge/specs/` | Spec Writer | Spec Verifier, Assumption Buster |

### Persona Categories
- **Primary** (1–5 orchestrators): Architect, PM, Lead Dev
- **Adversarial** (challengers): Red Team, Assumption Buster ("the idiot in the room"), Devil's Advocate
- **Specialist** (domain experts): Frontend, Backend, Database, Security, SRE, UX Designer, QA
- **Review** (quality gates): Spec Writer, Spec Verifier, Best Practices

Persona definitions will live in `.rorca/personas/` with `_primary/`, `_adversarial/`, `_specialist/`, `_review/` subdirectories. Each persona is a markdown file injected into `buildPrompt()` as a direction layer overlay.

## Convention System (Future — rorca-convention-packs spec)

### Greenfield Flow
Convention pack → scaffolds project + CLAUDE.md + `.rorca/` + Direction Stack (L0-L3) → then write brief → spec gen has full context.

### Brownfield Flow
Add workspace → automatic context extraction → generates L3 + CLAUDE.md (if missing) + AGENTS.md → human reviews → then write brief.

### Convention Drift
`rorca conventions check` compares code against declared conventions. Pre-execution hook candidate.
