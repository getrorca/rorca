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

## 2026-04-06 [Architecture] Two separate terminal data paths — process.stdout vs log file
> Rule: Main terminal (RunTerminal) reads from run_output_chunks table which is populated from the execution-engine subprocess stdout via the worker. Sub-terminals in wave parallel (MiniTerminalPane) read from per-story log files via /api/pipeline/runs/:runId/stories/:storyId/log SSE endpoint. Any fix to process.stdout filtering does NOT affect sub-terminals. Any fix must be applied independently to both paths.
> Context: RunTerminal also has formatStreamJsonForDisplay() which filters on the frontend, but MiniTerminalPane had no equivalent — it just ran everything through the ANSI converter directly.
> Source:  

## 2026-04-06 [Convention] Agent routing rule — Claude models must stay on Claude CLI
> Rule: When resolving agent type in pipeline.ts: (1) Explicit agentOverride from request or spec JSON takes priority. (2) Auto-detection only switches to OpenCode for non-Claude provider prefixes (openrouter/, openai/, google/, ollama/, github/, bedrock/, vertex/). (3) anthropic/claude-* models must NEVER auto-switch to OpenCode — they use Claude CLI subscription. (4) Bare provider/model strings (e.g. z-ai/glm-5) get openrouter/ prefix added when running on OpenCode.
> Context:  
> Source:  

## 2026-04-07 [Architecture] Codex model selection — reads from ~/.codex/models_cache.json
> Rule: Codex model picker fetches from GET /api/config/codex-models, which reads ~/.codex/models_cache.json and returns only visibility=list models sorted by priority. Falls back to hardcoded list if cache missing. Model passed to execution-engine as agentModel, forwarded to codex exec via -m flag. Do NOT hardcode GPT model lists — the cache reflects the user's actual Codex version and updates automatically.
> Context: Initial implementation hardcoded o3/o4-mini/gpt-4o/gpt-4.1 — wrong. Real models from Codex 0.118.0 cache: gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, gpt-5.1-codex-max, gpt-5.1-codex-mini. All support reasoning levels low/medium/high/xhigh.
> Source:  

## 2026-04-07 [Architecture] EngineSelector greyed pills = inactive state, not disabled — all three are always clickable
> Rule: EngineSelector (Claude Sub / OpenCode API / Codex Sub) uses text-[var(--text-muted)] for inactive pills which appears grey. This is intentional inactive styling — all buttons are always clickable regardless of availability dot color. The availability dot (green/grey) reflects whether the binary is installed, but does NOT disable the button. ModelPickerPopover shows opacity-50 cursor-not-allowed only when engine===codex AND no model selection supported (now removed — Codex supports full GPT model selection).
> Context: User asked why Codex appeared greyed out. Was normal inactive state. Separately identified that ModelPickerPopover was incorrectly disabled for Codex — fixed by adding full model selection support.
> Source:  

## 2026-04-14 [Architecture] rorca-ci-autofix spec — 5-story CI feedback loop
> Rule: New spec `rorca-ci-autofix` (CAF-001–005) approved and ready to run. Implements: (1) CAF-001 — `check_run` webhook handler parsing CI failure annotations into WAL event `ci_check_failed`; (2) CAF-002 — fix-orchestrator subscribes to WAL, generates single-story fix spec, enqueues pipeline run, max 2 attempts per SHA guard; (3) CAF-003 — `ci_autofix_runs` migration table + `ci_autofix_enabled` boolean on workspaces (opt-in, default false) + GET/PATCH `/api/workspaces/:id/ci-autofix` endpoints; (4) CAF-004 — Settings > GitHub tab UI: enable toggle + run history table; (5) CAF-005 — post GitHub commit status back on run completion. Uses `onGithubEvent()` registry + `subscribe()` from sse-hub. Only fires on check runs named `CI Gate*`.
> Context: Generated 2026-04-14 using exhaustive-specification skill. Model: claude-opus-4-6. No existing spec covered GitHub CI integration — rorca-integrations only had Linear/Vercel/Slack.
> Source:  

## 2026-04-15 [Architecture] node-pty graceful degradation — try/catch at module load, not import time
> Rule: When integrating native N-API modules like node-pty, wrap require() in a try/catch at module load (not dynamic import()). Set a module-scoped PTY_AVAILABLE boolean. Check this flag before calling native module functions and throw structured errors ({ code, message }) that routes can catch and convert to 503 Service Unavailable. This allows the server to start successfully even when the native module is not built, with the feature gracefully disabled.
> Context: Native modules like node-pty require platform-specific compiled binaries and cannot be bundled with bun build --compile. The terminal feature is server-only and requires users to run npm rebuild node-pty after install. Graceful degradation ensures the entire backend doesn't crash when the native module is missing.
> Source: OCT-024

## 2026-04-15 [Architecture] Terminal drawer is the sole OpenCode entry point
> Rule: Use `TerminalDrawerContext` plus the always-mounted `TerminalDrawer` in `App.tsx` for terminal access; do not add sidebar navigation items for OpenCode terminal access.
> Context: Keeps navigation at six items while preserving terminal sessions across route changes and supporting desktop handle/FAB access patterns.
> Source: OCT-036

## 2026-04-15 [Architecture] OpenCode terminal access is drawer-only
> Rule: Expose the OpenCode terminal exclusively through the global TerminalDrawer overlay, not a sidebar nav item, with desktop handle bar and mobile FAB entry points.
> Context: Keeps primary navigation at six items while preserving persistent terminal sessions across route changes.
> Source: OCT-036

## 2026-04-21 [Architecture] Merge Strategy — 4-way post-run routing
> Rule: Worktree runs support 4 merge strategies: direct (merge+push main), pr (push branch+create PR), draft-pr (push branch+create draft PR), branch-only (push branch, no PR/merge). Resolved from: per-run trigger override > spec JSON mergeStrategy field > workspace pipeline_config.mergeStrategy > 'direct' fallback. Implemented in worker.ts switch statement, pg-boss-schemas.ts MergeStrategyEnum, pipeline.ts trigger route, and TriggerPopover.tsx dropdown UI.
> Context: Replaces the old binary autoMerge toggle. The dropdown in TriggerPopover loads the workspace default on mount. Settings > Pipeline has a persistent workspace-level dropdown. gh CLI fallback gracefully degrades pr/draft-pr to branch-only if GitHub API isn't configured.
> Source:  

## 2026-04-21 [Architecture] LLM-synthesized diff summary in auto-PR bodies
> Rule: github-pr-creator.ts now runs git diff main...branch through chatComplete to generate a truthful bullet-point summary of what was actually built (not what the spec planned). The synthesized summary replaces spec.brief as the primary PR summary. Spec brief is shown as a blockquote for context. Diff is truncated to 50k chars for LLM context limits. Falls back to spec brief if synthesis fails. Template variable is {{run.diffSummary}}.
> Context: Solves the "aspirational vs reality" problem — PR descriptions used to describe what was planned, not what was actually changed. The synthesis runs once after all stories pass, costs a few cents of LLM time, and produces a permanent truthful receipt of the code changes.
> Source:  

## 2026-04-22 [Architecture] Supabase workspace RLS dependency chain
> Rule: Create workspace_members and get_user_workspace_ids(auth_id) in the same migration that adds users.auth_id so workspace RLS policies never depend on objects created later.
> Context: MU-010 workspace RLS calls get_user_workspace_ids() at runtime, so the join table and helper function must exist atomically before policies are enabled.
> Source: MU-003

## 2026-04-22 [Convention] Supabase local dev docs must separate migration systems
> Rule: When documenting local Supabase setup, explicitly note that `supabase db reset` only runs `supabase/migrations/` and does not apply app schema migrations from `backend/src/db/pg-migrations/`.
> Context: Rorca uses pg-index.ts for application schema migrations while Supabase CLI manages its own local stack lifecycle and migration directory.
> Source: MU-027

## 2026-04-22 [Architecture] Team RLS needs direct workspace scoping
> Rule: When applying workspace-based RLS to `teams`, add and backfill a direct `workspace_id` on `teams` instead of inferring scope indirectly through joins.
> Context: The requested `teams SELECT` policy depends on `workspace_id IN get_user_workspace_ids(auth.uid())`; the legacy schema lacked that column, so the prerequisite schema change is required before correct Supabase RLS can be expressed.
> Source: MU-013

## 2026-04-22 [Architecture] Failure Registry replaces failedIds Set (CP-002)
> Rule: execution-engine.ts uses `failureRegistry: Map<string, FailureRecord>` (from failure-registry.ts) instead of `failedIds: Set<string>`. Use `markFailed()`, `isFailed()`, `getFailureRecord()`, `removeFailure()` helpers. `computeBlockedStories()` accepts FailureRegistryMap and extracts keys via `failedIdSet()`. FailureRecord tracks: storyId, waveIndex, failedAt, reason, recoveryClass, recoveryAttempts, lastRecoveryAt, recoveryInFlight, conflictingFiles?, stderrTail?.
> Context: CP-002 foundational data-structure change for cascade prevention. Every subsequent CP story builds on this registry. Removal from registry on recovery success is the mechanism for unblocking dependants.
> Source: CP-002

## 2026-05-03 [Convention] Backend Ink TUI must use CommonJS-compatible Ink packages
> Rule: In the backend package, pin Ink to the CommonJS-compatible line (`ink@3.x` with matching `react` and `@types/react`) unless the backend module system is intentionally migrated away from CommonJS.
> Context: The backend tsx/tsconfig setup currently compiles as CommonJS. Newer Ink releases are ESM-oriented and caused runtime failures when launching the Forge TUI.
> Source: CLI-008

## 2026-05-03 [Architecture] Pi provider is encoded in token_usage.model
> Rule: For Pi FinOps and analytics, derive the provider from token_usage.model using the pi/<provider>/<model> format rather than expecting a dedicated provider column.
> Context: Pi multiplexes multiple upstream providers inside one run, and the persisted provider identity currently lives in the model string. Analytics code should parse it consistently to avoid schema drift assumptions.
> Source: CLI-030

## 2026-05-03 [Architecture] CLI loads backend DB helpers at runtime across separate builds
> Rule: When bin/rorca.ts needs backend-only helpers, load backend/dist modules at runtime and fall back to backend/src under tsx instead of adding static cross-package TS imports.
> Context: The root CLI and backend compile independently; static imports from bin/ to backend/src create fragile build coupling and can emit files into the wrong tree.
> Source: CLI-033

## 2026-05-03 [Architecture] Pi MCP integration must use a generated extension bridge
> Rule: Do not assume Pi supports a native --mcp-server flag. For Rorca integration, verify Pi capabilities first and expose Rorca MCP tools by generating a temporary Pi extension that performs the MCP HTTP handshake and registers tools at session start.
> Context: Pi's CLI help and upstream README state there is no built-in MCP transport. Native Rorca tool access in Pi therefore depends on extension-based bridging, not direct CLI flag wiring.
> Source: CLI-029

## 2026-05-03 [Architecture] Forge TUI must treat SSE loss as detach, not run termination
> Rule: When Forge loses its WAL or output SSE while a pipeline run is still active, clear the foreground attachment, keep the backend-owned run alive, and recover background state by polling GET /api/pipeline/runs.
> Context: The TUI is only a view over a worker-owned run. Stream disconnects or Ctrl+C in the TUI must never imply that the pi subprocess should stop.
> Source: CLI-027

## 2026-05-03 [Architecture] HTTP MCP and stdio MCP are separate exposure surfaces
> Rule: When changing MCP security or route exposure, audit both the OpenAPI-generated HTTP bridge in backend/src/lib/mcp-http.ts and the legacy hand-registered stdio server in backend/src/mcp/server.ts.
> Context: Patching only the HTTP /mcp path can leave the offline stdio fallback with older exposure behavior, creating a partial security rollout.
> Source: CLI-047

## 2026-05-03 [Architecture] Admin MCP exposure needs explicit x-mcp-tier override
> Rule: Keep x-rorca-tier: admin routes excluded from MCP by default, and only expose an admin route to MCP when the OpenAPI operation also declares x-mcp-tier: admin.
> Context: This preserves the default-deny admin posture while still allowing narrow forensic or operator tools to be callable through the authenticated MCP HTTP bridge.
> Source: CLI-051

## 2026-05-03 [Convention] Paid tier routes need explicit capability annotations
> Rule: Any route annotated with x-rorca-tier: paid must also declare x-rorca-capability with a valid PlanCapabilities key, and the HTTP plan gate enforces that capability against the resolved user plan.
> Context: The paid/admin/public/auth tier system alone is too coarse for commercial enforcement; capability names are now part of the stable annotation contract and lint fails if a paid route omits them.
> Source: CLI-053

## 2026-05-03 [Architecture] Contract tooling must target a fresh live tsx server
> Rule: For OpenAPI contract generation in this repo, fetch /api/docs/openapi.json from a fresh tsx-backed server instance, not an older long-running build, because stale servers can omit newly added vendor extensions and collapse the public-route snapshot to zero.
> Context: CLI-054 depends on x-rorca-public-api from the live OpenAPI payload. An already-running older server on :3030 returned a spec without the current vendor extensions, producing an empty contract snapshot until a fresh server was started on a different port.
> Source: CLI-054

## 2026-05-04 [Convention] New Postgres migrations use timestamp prefixes
> Rule: Add new backend SQL migrations as YYYYMMDDHHMMSS_description.sql so parallel branches cannot collide on numeric prefixes.
> Context: The pg migration runner supports both legacy sequential files and new timestamp-based migrations; new job-tracking tables should follow the timestamp convention.
> Source: CLI-057

## 2026-05-04 [Architecture] Spec long-runners should share pure job handlers behind pg-boss queues
> Rule: For long-running spec operations, keep the LLM/filesystem logic in reusable lib handlers and let the worker own pg-boss queue pickup, spec_jobs status transitions, and throttled progress writes.
> Context: This avoids duplicating route logic inside the worker, survives backend restarts, and prevents progress updates from hammering the database.
> Source: CLI-058

## 2026-05-04 [Architecture] sse-hub is process-local, not cross-process
> Rule: Do not rely on `broadcastAll()` or in-memory topic subscribers to deliver worker events to Express routes when the worker runs as a separate process; pair them with a DB-backed or polling fallback.
> Context: CLI-059 async spec job streaming needed a polling fallback because spec job handlers run in the standalone worker while SSE clients connect to the API process.
> Source: CLI-059

## 2026-05-04 [Architecture] MCP spec enrichment and skill tools must use async job endpoints
> Rule: When exposing long-running spec operations over MCP, call the `/async` variant first and poll `/api/spec-jobs/:jobId` server-side until terminal status instead of holding the synchronous LLM HTTP request open.
> Context: Anthropic-side HTTP timeouts can kill MCP tool calls even though the MCP session itself supports long-running operations. Decoupling the job from the tool transport preserves the MCP call while the backend job continues independently.
> Source: CLI-060
