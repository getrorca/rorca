# Memory Ledger

## 2026-02-27 [Architecture] Direction Stack 5-Layer Cascade
> Rule: Direction Stack layers cascade L1 (global) → L5 (story annotations). Lower layers override higher ones, like CSS specificity.
> Context: L1-L2 are global engineering/domain principles. L3+ are per-workspace. L4/L5 come from spec brief and story annotations.
> Source: CIE-003

## 2026-02-27 [Convention] Spec ID vs specName
> Rule: spec.id is the filename slug (use for API calls and path construction). spec.specName is the human-readable title (display only).
> Context: Confusing these causes file-not-found errors in pipeline trigger and archive panel.
> Source: v2-platform

## 2026-02-27 [Convention] chatComplete returns ChatResult
> Rule: chatComplete() returns ChatResult { text, usage } — always use .text accessor, never treat result as a string.
> Context: The return type was changed from string to ChatResult in US-003 (model selection). All callers must use .text.
> Source: US-003

## 2026-02-28 [Architecture] Context Router uses virtual file assembly
> Rule: Context is assembled virtually at runtime — no physical file scatter. Path-based scoping + tag injection + token budget enforcement.
> Context: .rorca/config.json routing section defines globals, scopes, and tags. micromatch handles glob matching.
> Source: CIE-004

## 2026-02-28 [Architecture] Episodic Memory is structured Markdown
> Rule: MEMORY.md entries follow format: ## YYYY-MM-DD [Category] Title / > Rule: / > Context: / > Source: story-id
> Context: Machine-readable, human-editable. Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha.
> Source: CIE-005

## 2026-03-01 [Convention] TypeScript typecheck failures require immediate resolution
> Rule: Stories must pass `npx tsc --noEmit` validation before being marked as passed, even if runtime behavior appears correct
> Context: SM-001 failed with reason='typecheck' despite potentially working at runtime. The execution engine enforces strict type safety as a quality gate. Always verify both frontend and backend type checks before committing.
> Source: SM-001

## 2026-03-08 [Convention] Rate Limiter Configuration Uses Database Table
> Rule: Rate limits are stored in the `rate_limits` DB table with 30s cache; defaults are 100 req/min authenticated, 20 req/min unauthenticated
> Context: To change limits: UPDATE rate_limits table then call invalidateRateLimitCache() or restart backend. Skipped in NODE_ENV=test unless RATE_LIMIT_ENABLED=true. Implemented in rate-limiter.ts.
> Source: PR-NEW-1

## 2026-03-08 [Architecture] Docker Compose as Primary Self-Hosted Distribution
> Rule: Self-hosted distribution uses Docker Compose with Postgres 16 + pgvector + Apache AGE + Rorca backend — single `docker compose up` command
> Context: PR-003 establishes Docker Compose as the canonical self-hosted deployment method. This supersedes manual npm install flows and ensures consistent environments across installations.
> Source: PR-003

## 2026-03-08 [Convention] Health Checks Return Structured Component Breakdown
> Rule: Health endpoints must return both aggregate score and per-component status (CLAUDE.md 30pt, AGENTS.md 20pt, config.json 20pt, MEMORY.md 15pt, skills 15pt)
> Context: Implemented via workspace-echolocation.ts echolocate() function. Penalties apply: CLAUDE.md < 10 lines = half credit, < 50 lines = 75% credit. This structured breakdown enables actionable remediation.
> Source: CIE workspace health

## 2026-03-10 [Convention] PostgreSQL Migration Pattern
> Rule: Migrations live in `backend/src/db/pg-migrations/` as numbered SQL files. Tracked via `schema_migrations` table (not filesystem). Use `IF NOT EXISTS` / `IF EXISTS` guards freely — PostgreSQL supports them natively.
> Context: Supersedes the old SQLite pragma table_info workaround. PostgreSQL supports `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.
> Source: rorca-postgres-migration PG-011

## 2026-03-08 [Convention] Plan Quotas Enforced via Middleware Not Route Logic
> Rule: Usage quotas (plan limits, token budgets) are enforced via requirePlan middleware attached to routes, not inline in route handlers
> Context: PR-051 creates plan_quotas table + requirePlan middleware. This centralizes enforcement logic and makes quota changes (free → paid tier) declarative. Route handlers stay clean.
> Source: PR-051

## 2026-03-13 [Architecture] All three CLI coding assistants support MCP — Rorca tools work from any of them
> Rule: Claude Code, OpenCode CLI, and Codex CLI all support MCP servers. A user working in any of these three can call Rorca MCP tools (rorca_generate_spec, rorca_trigger_run, etc.) from their active session. The only path that does NOT support MCP is the browser UI. This means the MCP-native generation architecture benefits all CLI users regardless of which assistant they use: Claude Code (Claude model), OpenCode CLI (any provider — GPT-4o, Gemini, etc.), Codex CLI (ChatGPT model). Architecture principle: Rorca API = context + persistence. LLM reasoning = caller's session. Browser UI = server-side subprocess fallback only.
> Context: Discovered during discussion of MCP-native generation architecture 2026-03-13. Initially assumed Claude Code was the only MCP-capable assistant, but user confirmed Codex CLI also supports MCP. OpenCode CLI MCP support was already known. This means the in-session generation spec (rorca-mcp-native-generation, not yet written) benefits a wider audience than initially thought — all CLI users, not just Claude Code users. Relevant spec to write: split rorca_generate_spec into rorca_get_generation_context + rorca_save_spec, update rorca_forge_and_run to use the new tools internally.
> Source: architecture discussion

## 2026-03-14 [Convention] New migrations MUST use YYYYMMDDHHMMSS timestamp format
> Rule: All new database migrations must use 14-digit timestamp prefixes (YYYYMMDDHHMMSS_description.sql), not sequential numbers. Example: 20260314150000_add_user_preferences.sql. Sequential numbers (001-079) stay as-is — the runner supports both formats indefinitely via numeric sort. Timestamps are structurally unique and eliminate the collision class caused by parallel worktree branches creating the same migration number.
> Context: Rorca's worktree-per-spec architecture means multiple branches create migrations simultaneously. Sequential numbers collided repeatedly (069, 072, 074 all had duplicates from parallel branches). pg-index.ts now has checkDuplicatePrefixes() that fails loudly at startup, numeric sort instead of lexicographic, and BIGINT version column (migration 079) to store 14-digit timestamps. The pg driver returns BIGINT as strings — Number() coercion is required when comparing applied versions.
> Source: debugging session — migration-timestamps spec + manual implementation

## 2026-03-15 [Architecture] Run queue lifecycle: queued runs have NO pg-boss job until promoted
> Rule: When a run is queued (queue:true in trigger body while another run is active), pipeline.ts creates a pipeline_runs row with status='queued' and queue_position but does NOT call boss.send(). The pg-boss job is only created later when advanceQueue() fires POST /api/pipeline/trigger with queuedRunId, which promotes the existing row and sends the boss job. Any code that checks for 'stuck' runs must account for this: queued runs without pg-boss jobs are normal, not orphaned.
> Context: Three-step queue lifecycle: (1) Trigger with active run → pipeline_runs row created with status='queued', no pg-boss job. (2) Active run completes → advanceQueue() called → HTTP POST to /api/pipeline/trigger with queuedRunId → promotes row to 'running' + sends boss.send(). (3) Worker picks up the pg-boss job. Files: backend/src/routes/pipeline.ts (trigger), backend/src/lib/run-queue.ts (advanceQueue), backend/src/worker.ts (completion hooks).
> Source: debugging session — run queue architecture clarification

## 2026-03-16 [Architecture] Worktree lifecycle design — one worktree per spec, not per run
> Rule: Branch name is feat/<slug> (no timestamp) — deterministic per spec. On trigger: reuse existing worktree dir if it exists (skip git worktree add). On all stories pass: auto-merge to main + git worktree remove --force. On partial/full fail: leave worktree intact for retry. Retry reuses the same directory and skips already-passing stories. Merge gate: only merges to main when every non-excluded story has passed.
> Context: The timestamp-based naming (feat/<slug>-<timestamp>) was the old pattern — all 62 stale worktrees are from that era. The deterministic naming was already implemented in pipeline.ts but the auto-merge was broken by the missing arg wiring in worker.ts. Now both are correct.
> Source: design review 2026-03-16

## 2026-03-16 [Convention] Landing page page names: /memory and /execution (not /engine and /compute)
> Rule: Landing page deep-dive pages were renamed: /engine → /memory (covers Memory Retrieval Cascade, Virtual Context Routing, Skills Injection), /compute → /execution (covers Three Execution Engines, Model Cascading, Wave-Parallel). Nav labels, metadata keys, directory names, and client component names all updated. Page h1: "The Context Memory." and "Three engines. Zero lock-in."
> Context: Renamed because the content better matches the new names — /memory leads with the memory retrieval cascade as hero section, /execution accurately describes what the page covers. Files: landing-page/src/app/memory/MemoryClient.tsx, landing-page/src/app/execution/ExecutionClient.tsx.
> Source: session 2026-03-16

## 2026-03-17 [Architecture] WAL event streaming architecture — two-track design for instant history + live events
> Rule: Two endpoints work together: (1) REST GET /api/pipeline/runs/:runId/wal-events returns all past WAL events for a run instantly via direct DB query. (2) SSE GET /api/pipeline/stream delivers live events only (starts at MAX WAL id). usePipelineSSE.ts: on runId change, immediately seeds from REST then deduplicates live SSE events by id. useWalSSE singleton: single EventSource shared across all components (avoids Chrome 6-connection limit). Never use SSE alone for historical data — always pair with REST seed.
> Context: The WAL table has 5000+ events. Starting SSE from id=0 caused 5+ minute delay. Starting from MAX(id) means SSE only delivers events created after the connection opens. The REST seed fills the gap for the current run's history instantly. Dedup by event.id in setEvents() prevents duplicates if live events arrive during the REST fetch.
> Source: architecture decision 2026-03-17

## 2026-03-17 [Architecture] Wave parallel mini-terminal silence fixed by rorca-mini-terminal-db-output spec
> Rule: Wave parallel runs show no per-story output in mini-terminals because `run_output_chunks` has no `story_id` column — all stories write to the same table keyed by `run_id` only. The approved spec `rorca-mini-terminal-db-output` (7 stories) fixes this by: (1) adding a separate `story_output_chunks` table, (2) a `StoryLogFollower` WAL subscriber that fans out per-story, (3) a new SSE endpoint `GET /api/pipeline/runs/:runId/stories/:storyId/stream`, (4) US-007 validates wave parallel mini-terminals show prose. Sequential runs already stream fine after the immediate-flush worker fix.
> Context: Confirmed 2026-03-17: sequential runs now stream within ~10 seconds. Wave parallel mini-terminals still silent. rorca-mini-terminal-db-output is in forge/specs/approved/ and ready to run.
> Source: debugging session 2026-03-17

## 2026-03-17 [Architecture] rorca-terminal-sse-overhaul spec — 10 stories, run AFTER rorca-mini-terminal-db-output
> Rule: Spec rorca-terminal-sse-overhaul replaces xterm.js with ansi-to-html + pre tag (RunTerminal + MiniTerminalPane) and WAL polling with Postgres LISTEN/NOTIFY. Must run AFTER rorca-mini-terminal-db-output because US-009 connects MiniTerminalPane to /stream endpoint (created by mini-terminal spec). Migration timestamp: 20260317100000 (avoids collision with mini-terminal's 20260317000001). RunTerminal must preserve RunTerminalHandle type with scrollToStory() and writeMarker() via useImperativeHandle — RunViewPanel depends on these. WAL polling side effects (recordTokenUsage, story_results token updates) must be migrated into LISTEN/NOTIFY handler in US-003.
> Context: Spec is in forge/specs/pending/rorca-terminal-sse-overhaul.json. Dependency on mini-terminal spec discovered after deep audit of MiniTerminalPane.tsx xterm usage and WAL polling side effects.
> Source: session-2026-03-17

## 2026-03-17 [Architecture] rorca-mcp-recall-tool spec complete — all 13 stories on main
> Rule: rorca-mcp-recall-tool (13 stories) fully merged to main as of 2026-03-17. Run #20260316000019 (32 min, 1 pass / 12 skip / 0 fail). Auto-merge completed (merge_commit_sha: 75d44d9). The 12 skips were already-implemented stories from prior runs 17+18. US-013 (rorca_dump MCP tool + GET /api/recall/dump) was the only story that ran. All code on main, no stale worktrees.
> Context: Spec implemented GET /api/recall/dump route (recall.ts), DumpResponse types (recall-types.ts), rorca_dump MCP tool in server.ts, and Jest tests (recall.test.ts).
> Source: session-2026-03-17

## 2026-03-17 [Architecture] rorca-mini-terminal-db-output spec — run BEFORE rorca-terminal-sse-overhaul
> Rule: rorca-mini-terminal-db-output (7 stories after US-006 deletion) creates story_output_chunks table, story-log-follower WAL subscriber (filters stream-json → prose, writes to DB), and GET /api/pipeline/runs/:runId/stories/:storyId/stream SSE endpoint. This fixes raw stream-json in wave parallel mini-terminals. Must run BEFORE rorca-terminal-sse-overhaul because US-009 of overhaul spec connects MiniTerminalPane to /stream. US-006 (MiniTerminalPane → /stream xterm update) was deleted from this spec to avoid conflict with overhaul's US-009 rewrite.
> Context: The two specs solve different problems: mini-terminal fixes server-side stream-json filtering; overhaul fixes client-side rendering (xterm → ansi-to-html). ansi-to-html alone does NOT fix raw JSON — it only renders ANSI colors. Both specs are needed.
> Source: session-2026-03-17

## 2026-03-18 [Architecture] Memory consolidation: DB is source of truth, MEMORY.md is optional projection
> Rule: DB memories table is the single source of truth. MEMORY.md is a generated read-only projection rebuilt pre/post run — never written by agents directly. rorca_recall and rorca_get_memories (with fetchAll:true) both read from DB. rorca_dump is deprecated. MEMORY.md is only worth keeping if the workspace is used outside Rorca (Cursor, Copilot, raw Claude Code) — it is redundant in a Rorca-only workflow.
> Context: Diagnosed split-brain architecture where MEMORY.md and memories DB table drifted independently. Spec rorca-memory-consolidation (7 stories) fixes this. Critical trap: never parse MEMORY.md back into DB — LLM-edited Markdown is not reliably parseable. Claude agents use rorca_save_memory MCP tool; opencode/codex write to .rorca/proposed_memories.json which execution-engine INSERTs post-run. Two-tool MCP namespace enforced: rorca_recall (full context) + rorca_get_memories (paginated + fetchAll param). No rorca_get_memories_all — parameter overloading not tool sprawl.
> Source: session-2026-03-18

## 2026-03-18 [Architecture] Simultaneous spec runs require autoWorktree
> Rule: Running multiple specs simultaneously (sequential OR wave-parallel) requires autoWorktree: true on each run. Without a worktree, the conflict detection in pipeline.ts blocks any new run if another is already running in the same workspace. With autoWorktree, up to run_now_max_concurrent (default 3) runs can coexist, each in an isolated git worktree branch.
> Context: Implemented by rorca-pipeline-queueing-and-worktrees spec (run 20260316000033/34, merged 2026-03-18). Non-worktree runs still hard-block at pipeline.ts line 1316. Wave-parallel within a single spec also requires a worktree for the sub-story isolation.
> Source: debugging session

## 2026-03-23 [Architecture] CLAUDE.md is never written by the pipeline — only read
> Rule: The pipeline (execution-engine.ts, pipeline.ts) never writes to CLAUDE.md. It is only written by: manual edits, POST /api/workspaces/:id/scan-direction (brownfield extraction), POST /api/workspaces/:id/apply-conventions (if missing), and monorepo discover/apply (appends section). Do not expect pipeline runs to update CLAUDE.md.
> Context: Common misconception when reasoning about how Rorca maintains project context. CLAUDE.md is the static developer handbook — declarative, rarely changes. The DB memories table is the dynamic episodic store that gets written during runs.
> Source: session-2026-03-23

## 2026-03-23 [Architecture] AGENTS.md is a temporary write target for Codex only — reverted after run
> Rule: writeCodexAgentsMd() in pipeline.ts appends a fenced direction stack section (between RORCA DIRECTION START/END markers) to AGENTS.md before a Codex run, then removeCodexAgentsMd() restores the original (or deletes the file if Rorca created it) after the run completes. For claude and opencode agents, AGENTS.md is never touched by the pipeline.
> Context: The "trojan horse" claim about Rorca writing to AGENTS.md is weaker than it sounds — nothing accumulates there between runs. It is only a per-run injection mechanism for Codex CLI's auto-discovery behavior.
> Source: session-2026-03-23

## 2026-03-23 [Architecture] .md files should be optional projections — DB is the core, files are the export format
> Rule: Rorca's core loop should be: DB → prompt injection (pipeline) and DB → MCP tools (CLI). .md files (MEMORY.md, CLAUDE.md, AGENTS.md) are output projections for ambient third-party tool benefit — not core dependencies. The consolidation spec already moves MEMORY.md to a generated projection. CLAUDE.md and AGENTS.md should be treated the same way long-term.
> Context: Emerged from discussion about whether Rorca should be a DB-only project. The trojan horse value for Cursor/Copilot is real but passive — those tools require explicit @file references, unlike claude --print which auto-injects CLAUDE.md. The DB-only path already works for all three execution engines via buildPrompt() injection.
> Source: session-2026-03-23

## 2026-03-23 [Convention] Three distinct knowledge layers: CLAUDE.md (IS), MEMORY.md (Learned), AGENTS.md (Rules), DB memories (Indexed)
> Rule: CLAUDE.md = declarative handbook of how the system IS built (stack, API routes, gotchas, architecture). MEMORY.md = episodic ledger of what was learned during runs (timestamped, categorized, actionable rules). AGENTS.md = governance of who owns what files and behavioral rules per zone. DB memories table = same content as MEMORY.md but structured, vector-searchable, scored, with embeddings and dedup. Each serves a different injection point and audience.
> Context: These are often conflated. The key distinction: CLAUDE.md answers "what IS this codebase?", MEMORY.md answers "what did we learn?", AGENTS.md answers "whose rules apply here?", DB memories answers "what's most relevant to this specific story right now?"
> Source: session-2026-03-23

## 2026-03-24 [Convention] Full clean restart procedure for dev stack
> Rule: To fully restart the dev stack after crashes or stale process buildup: (1) `pkill -9 -f "rorca/backend"` — kills all tsx server/worker/supervisor processes, (2) `pkill -9 -f "worker-supervisor"` — kills supervisor, (3) `lsof -ti:3030 -ti:5210 | xargs kill -9` — clears ports, (4) wait 3s for heartbeat table to go stale (or wait 90s for full expiry), (5) `npm run dev`. Do NOT rely on port-only kills — the worker and supervisor have no bound port.
> Context: Developed from multiple failed restart attempts in this session. The key insight is that the worker process and worker-supervisor process do not bind to any port, so lsof-based port kills cannot reach them.
> Source: session-2026-03-23

## 2026-03-25 [Architecture] hetzner-coolify-infra skill installed
> Rule: Skill hetzner-coolify-infra.md installed at .rorca/skills/ and .claude/skills/. Covers: Hetzner hcloud CLI, VM sizing (CX31 default), private network 10.0.0.0/16, floating IP for stable DNS, Coolify install, Postgres via Coolify, Rorca Docker deployment, worker as separate service, forge/ volume mount, AGE extension caveat. Pre-prod cost ~€19/mo.
> Context: User wants to deploy Rorca to Hetzner + Coolify for pre-prod testing. Skill created 2026-03-24.
> Source: manual

## 2026-03-25 [Architecture] MCP tools auto-inject workspaceId when not provided
> Rule: In mcp-http.ts, workspaceId is marked optional in Zod schema (so MCP SDK doesn't reject) and executeApiCall() auto-injects the default workspace ID (fetched from GET /api/workspaces?limit=1, cached 1 min). This makes all MCP tools work without users needing to know or specify the workspace ID. The cachedDefaultWorkspaceId + cacheExpiry pattern avoids a DB query on every tool call.
> Context: Users calling MCP slash commands like /rorca:get_memories didn't know to pass workspaceId. Zod validation rejected before handler ran. Now tools "just work" for single-workspace setups. Commit 6c8d3c5.
> Source: debugging session 2026-03-25

## 2026-03-25 [Architecture] MCP /mcp endpoint has scoped CORS separate from /api/* CORS
> Rule: server.ts has two CORS layers: (1) Global at line ~171 — origin: 'localhost:5210', credentials: true, for browser /api/* routes. (2) MCP-specific mcpCors at line ~218 — origin: true (reflect any), credentials: false, allows Mcp-Session-Id header, scoped to POST/GET/DELETE /mcp only. MCP clients (Claude Code, IDE extensions) connect without browser origin headers so they need the permissive config.
> Context: MCP endpoint previously used the restrictive /api/* CORS which worked but didn't expose Mcp-Session-Id header properly. Commit 6c8d3c5.
> Source: debugging session 2026-03-25

## 2026-03-25 [Architecture] rorca_recall_memories now supports 3 retrieval modes: full dump, recent 100, semantic
> Rule: The MCP `rorca_recall_memories` tool now supports three modes: (1) Full dump (`fetchAll: true`) — returns ALL memories from DB with no limit, (2) Recent (default) — returns last 100 memories ordered by pinned-first then newest (was 20), (3) Semantic (`currentTask` provided) — hits `/api/recall` which triggers the full CAG → RAG → Knowledge Graph cascade and returns top 30 semantically ranked results (was 10). The `currentTask` param is new — it maps to `storyText` on the recall endpoint.
> Context: Previously the tool only had modes 1 and 2, both reading from the stale file-based ledger. Mode 3 (semantic) existed in `rorca_recall_workspace` via `currentTask` param but was not exposed on `rorca_recall_memories`. Now both tools share the same retrieval infrastructure. Files changed: `backend/src/mcp/server.ts` (MCP tool rewrite), `backend/src/routes/recall.ts` (fetchMemories limits: LIMIT 20→100, slice 10→30).
> Source: session-2026-03-25

## 2026-03-25 [Architecture] Memory retrieval cascade: CAG → RAG → Knowledge Graph (memory-router.ts)
> Rule: Semantic memory retrieval uses a 3-tier cascade in `backend/src/lib/memory-router.ts`: (1) CAG — cache-first via `context-cache.ts`, pinned memories always included, (2) RAG — hybrid full-text search via `search.ts` using `tsv @@ plainto_tsquery`, triggered when cache coverage < 50% of key phrases, (3) Graph — Apache AGE knowledge graph via `knowledge-graph.ts` + `graph-context.ts`, traverses file touches and story dependencies. Token budgets: 60% memory, 25% skills, 15% graph (with underflow redistribution). Key phrase extraction uses stopword filtering on words > 4 chars.
> Context: The cascade is fully implemented and wired into `/api/recall` endpoint. The `rorca_recall_memories` tool now exposes it via the `currentTask` parameter. Previously this was only available through `rorca_recall_workspace`'s `currentTask` param. PG-022 added pinned memories (always included regardless of budget).
> Source: session-2026-03-25

## 2026-03-30 [Architecture] Docker Compose production setup on VPS
> Rule: Three services in /home/ubuntu/rorca/docker-compose.yml: (1) db — postgres:pgvector image, port 5433:5432, volume rorca_pgdata; (2) rorca — API+frontend on port 3030:3030, CMD node cli.js start --no-open; (3) worker — same image, CMD node backend/dist/worker.js. All env vars in /home/ubuntu/rorca/.env. Worker was NOT in the original compose file and had to be added manually.
> Context: Repo cloned to /home/ubuntu/rorca. Rorca workspace DB path updated to /home/ubuntu/rorca. Coolify manages the stack but docker compose commands run directly as sudo docker compose.
> Source:  

## 2026-03-30 [Bug Fix] Cross-schema restore breaks migrations — attachment_storage_type enum
> Rule: When restoring a pg_dump taken from the rorca schema into a fresh DB, the ENUM types land in the rorca schema but migrations run in public schema. Migration 061 IF NOT EXISTS check finds the ENUM in rorca schema, skips CREATE TYPE, then CREATE TABLE fails because search_path=public. Fix: run `CREATE TYPE public.attachment_storage_type AS ENUM ('database', 's3');` directly on the DB before first container start after a restore.
> Context: Also: migration 057 ON CONFLICT failed because public.spec_search_index was missing the uq_spec_search_slug_workspace unique constraint. Fix: ALTER TABLE public.spec_search_index ADD CONSTRAINT uq_spec_search_slug_workspace UNIQUE (spec_slug, workspace_id);
> Source:  

## 2026-03-30 [Gotcha] HTTPS_ENABLED=1 required to enable HSTS and CSP upgrade-insecure-requests
> Rule: Helmet sends HSTS and CSP upgrade-insecure-requests conditionally based on HTTPS_ENABLED=1 env var. Without it on a plain HTTP deployment, the browser caches HSTS and forces HTTPS on all subsequent requests causing ERR_SSL_PROTOCOL_ERROR. Never set HTTPS_ENABLED=1 unless TLS is actually terminated (nginx/Coolify proxy in front).
> Context: Fixed in backend/src/server.ts: `const httpsEnabled = process.env.HTTPS_ENABLED === '1'` gates both hsts and upgradeInsecureRequests directives.
> Source:  

## 2026-03-30 [Bug Fix] Static files must be served before authRequired middleware
> Rule: express.static and the SPA catch-all (app.get('*')) must be mounted BEFORE the authRequired middleware block in server.ts. If mounted after, all static assets (JS chunks, CSS, favicon.ico) return 401 Unauthorized to unauthenticated users, breaking the login page entirely. Order: public routes → MCP tools → static files → auth middleware → protected API routes.
> Context: Fixed in server.ts around line 240. The duplicate static block that was at line ~334 was removed.
> Source:  

## 2026-03-30 [Bug Fix] AuthGate must check isAuthenticated to show login page
> Rule: The AuthGate component in App.tsx originally had `void isAuthenticated` — deliberately bypassed for local single-user mode. When AUTH_REQUIRED=true on the backend, the frontend still rendered the onboarding wizard and made API calls that all 401'd. Fixed by adding `if (!isAuthenticated)` check that renders LoginPage/RegisterPage/ForgotPasswordPage. LoginPage and RegisterPage added as module-level lazy imports (not inline inside the function body).
> Context: Commit 216b363. The GitHubCallbackPage and PublicReviewPage checks remain before the isAuthenticated check so they work without auth.
> Source:  

## 2026-03-30 [Bug Fix] GitHub OAuth unconfigured — redirect not JSON
> Rule: When GITHUB_CLIENT_ID/SECRET are not set, GET /api/auth/github must redirect to /auth/github/callback?error=github_not_configured (relative URL) rather than returning JSON. Browser navigates directly to this URL so JSON renders raw. Use a relative redirect so it works on any host without hardcoding localhost. The frontend GitHubCallbackPage handles the error param and shows a friendly message.
> Context: Commit f4a5583 + 3b86f56. Also added github_not_configured to the error messages map in GitHubCallbackPage.tsx. SPA catch-all also updated to exclude /mcp paths.
> Source:  

## 2026-03-30 [Decision] Single-user deployment — registration disabled, GitHub OAuth hidden
> Rule: VPS deployment is single-user only. POST /api/auth/register returns 403 unless REGISTRATION_DISABLED=false is explicitly set in env. LoginPage no longer shows "Create one" or "Sign in with GitHub" buttons — email/password only. Workspaces have no user_id scoping (all users see all workspaces) so blocking new signups is the only isolation mechanism until proper multi-user workspace scoping is built.
> Context: Commit 83a4c12. Default creds: dteravan@gmail.com / rorca123 and admin@rorca.local / rorca123 — both should be changed. Change via Settings > Account or via bcryptjs hash update in DB.
> Source:  

## 2026-03-30 [Gotcha] NetworkBanner hardcoded localhost:3030 caused private network CORS errors
> Rule: NetworkBanner.tsx had `const HEALTH_URL = 'http://localhost:3030/api/health'` hardcoded. On the VPS, the browser blocked this as a private network access CORS violation (cross-origin from 141.94.33.224:3030 to localhost:3030). Fixed by importing BASE_URL from lib/apiFetch and using `${BASE_URL}/api/health`. BASE_URL is empty string in production builds (relative URL) so health checks go to the same origin.
> Context: Any hardcoded localhost URLs in frontend code will break on VPS/cloud deployments. Always use BASE_URL from apiFetch or relative paths.
> Source:  

## 2026-03-30 [Gotcha] Pending migration blocks pipeline trigger — include_graph column
> Rule: If pipeline trigger hangs indefinitely (curl times out, UI stuck on "Starting..."), check for pending migrations first via GET /api/health — look for `"migrations":{"status":"degraded","pending":N}`. A missing column on pipeline_runs causes the INSERT to fail silently and the backend connection to hang. Fix: apply the migration manually then restart the backend. Root cause: migrations only run on backend startup, so new migrations added while backend is running are never applied until restart.
> Context: Specifically hit with 20260325100000_add_include_graph_to_pipeline_runs.sql — added include_graph BOOLEAN column. Applied manually via ALTER TABLE + INSERT INTO schema_migrations. Also: stale worker (running since Tuesday) was the first suspect but restarting it wasn't enough — the pending migration was the real blocker.
> Source:  

## 2026-04-03 [Bug Fix] Wave parallel broken by two separate issues: ArchivePanel options drop + waveParallelism config
> Rule: Wave parallel execution requires two things to be correct simultaneously: (1) ArchivePanel.handleRun must forward all TriggerPopover options (forceSequential, autoMerge, includeGraph) to the pipeline trigger API — since ULT-007, the options parameter was silently dropped, so forceSequential was never sent and backend defaulted to sequential; (2) the target workspace's .rorca/config.json must have waveParallelism: true in the execution block — workspace had it hardcoded to false, blocking wave parallel regardless of UI toggle. Both must be correct or parallelism stays at 1.
> Context: Diagnosed by checking all finops-generator-engine runs via MCP and confirming parallelism: 1 on every run. ArchivePanel fix: handleRun now accepts options?: { forceSequential?, autoMerge?, includeGraph? } and spreads them into the fetch body. Config fix: .rorca/config.json waveParallelism changed from false to true.
> Source:  

## 2026-04-03 [Gotcha] Model picker must filter by engine type
> Rule: When engine is OpenCode (API), the model picker must NOT show Anthropic subscription models (Opus, Sonnet, Haiku). Filter by `m.provider !== 'Anthropic'` on the `/api/direction/models` response. Only OpenRouter models should appear. OpenRouter section should also start expanded (not collapsed) when OpenCode is selected.
> Context:  
> Source: MP-005

## 2026-04-03 [Gotcha] Effort level 'max' is Opus-only
> Rule: Claude CLI supports 4 effort levels: low, medium, high, max. However 'max' is only available for Opus models. When Sonnet is selected, the ThinkingControls component must hide the Max button (only show Low/Medium/High). If effort was set to 'max' and user switches to Sonnet, clamp down to 'high'.
> Context:  
> Source: MP-006

## 2026-04-03 [Gotcha] No --thinking-budget CLI flag — budget slider removed
> Rule: Claude Code CLI has `--thinking` (on/off toggle) and `--effort` (low/medium/high/max) but NO `--thinking-budget` flag. The thinking budget slider was removed from ThinkingControls. The `thinkingBudget` field is kept in the data model for backward compat but the UI no longer renders a slider for it. Extended thinking is just an on/off toggle.
> Context:  
> Source: MP-006

## 2026-04-03 [Bug Fix] Model picker merge left conflict markers in 3 files
> Rule: The feat/rorca-spec-model-picker merge with stash/restore left `<<<<<<< Updated upstream` conflict markers in SpecDetailSlideOver.tsx, TriggerPopover.tsx, and WorktreesPanel.tsx. Blindly taking one side of conflict resolution caused missing variable definitions (hasStoryOverride, isSpecLevel, specModelFields). Fix was to restore from the last working commit (aef070f) rather than manual conflict patching.
> Context: 
> Source: MP-008
