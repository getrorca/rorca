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

## 2026-03-18 [Bug Fix] StoryLogFollower never fires from live WAL subscription — JSONB payload parsed as object not string
> Rule: StoryLogFollower.onStoryStarted and onStoryFinished called JSON.parse(event.payload) but wal_events.payload is JSONB — pg returns it as a JS object, not a string. JSON.parse on an object calls .toString() → "[object Object]" → SyntaxError → catch returns silently. Fix: check typeof event.payload === 'string' before parsing, otherwise use the object directly. recover() was unaffected because it casts payload::text in SQL.
> Context: Root cause of mini-terminals never showing prose output from live subscription. recover() worked on restart but live subscription path always silently dropped story_started events. Fixed in backend/src/lib/story-log-follower.ts onStoryStarted + onStoryFinished. Discovered 2026-03-18 by confirming 0 chunks despite valid log file content and correct DB schema.
> Source: debugging session

## 2026-03-18 [Gotcha] continue inside Promise.allSettled map() is a compile error — use return
> Rule: handlePipelineRun uses Promise.allSettled(jobs.map(async (job) => { ... })). Using continue inside an async arrow function in .map() is invalid — esbuild throws "Cannot use continue here". Use return instead to skip to the next job in the batch.
> Context: Introduced by US-003 of rorca-pipeline-queueing-and-worktrees merge. Caught at backend startup (esbuild transform error). Fixed by replacing continue with return at worker.ts line 676.
> Source: debugging session

## 2026-03-18 [Gotcha] auto_merge is false on retry runs — set it manually if needed
> Rule: Retry runs created via /api/pipeline/runs/:id/retry always set auto_merge = false. If the original run had auto_merge = true but failed before merging, the retry will NOT auto-merge on completion. Workaround: manually UPDATE pipeline_runs SET auto_merge = true WHERE id = &lt;retryRunId&gt; while the retry is in-flight.
> Context: Discovered 2026-03-18 when retrying US-012 of rorca-pipeline-queueing-and-worktrees. The worktree branch was not merged after the retry completed. Had to manually set auto_merge and then do the git merge ourselves.
> Source: debugging session

## 2026-03-19 [Bug Fix] tsx ENOENT when worker spawns execution engine
> Rule: Worker spawns execution-engine via `path.join(__dirname, '..', 'node_modules', '.bin', 'tsx')` — fails with ENOENT when tsx not in backend/node_modules. Root cause: root postinstall runs `cd backend && npm install --production --ignore-scripts` which skips devDependencies (tsx is a devDep). Fix: added `findTsxBin()` helper in worker.ts — tries local path first, falls back to `which tsx`. Also run `cd backend && npm install` to install all deps. Symptom: run fails in <100ms with "spawn ... tsx ENOENT".
> Context: Discovered 2026-03-19 when debugging instant run failure. The old worker had survived since before the --production flag took effect; restarting the worker exposed the bug. Files: backend/src/worker.ts (findTsxBin function added at top, used in two spawn locations).
> Source: debugging session 2026-03-19

## 2026-03-19 [Bug Fix] Silent terminal — execution-engine block.text missing trailing newline
> Rule: execution-engine.ts wrote `process.stdout.write(block.text)` without a trailing `\n`. RunTerminal.tsx uses a line-buffer pattern: `parts.pop()` keeps any "incomplete last line" (one without `\n`) in `lineBufferRef` indefinitely — it never reaches `displayLines` and is never rendered. Fix: `process.stdout.write(block.text.endsWith('\n') ? block.text : block.text + '\n')` at the point where claude stream-json assistant blocks are emitted to stdout (execution-engine.ts ~line 744). Non-JSON fallback already had `+ '\n'` and worked correctly.
> Context: Discovered 2026-03-19 — terminal showed no output for 1.5+ minutes even though 14 chunks were confirmed in run_output_chunks DB. Chunks arrived via SSE but text sat in lineBufferRef forever because no \n was written. Files: backend/src/lib/execution-engine.ts (stream-json assistant block output path).
> Source: debugging session 2026-03-19

## 2026-03-19 [Gotcha] run_output_chunks schema: column is "chunk" not "data", DB port is 5433
> Rule: run_output_chunks table columns: `(id, run_id, chunk BYTEA, sequence INT, created_at)`. Column is `chunk`, NOT `data`. Also: DATABASE_URL uses port 5433 not default 5432 — `postgres://rorca:rorca@localhost:5433/rorca`. pg-boss table uses `created_on` not `createdon`. Always read backend/.env before writing raw SQL queries.
> Context: Hit multiple wrong-column-name errors during 2026-03-19 debugging session when querying run_output_chunks directly.
> Source: debugging session 2026-03-19

## 2026-03-19 [Decision] Task-Monitor pattern: pg-boss jobs complete immediately, reconcileState is the watchdog
> Rule: pg-boss jobs must NOT stay active for the lifetime of an execution engine subprocess. The job spawns the engine and returns immediately (fire-and-forget). Engine liveness is monitored via IPC heartbeats (every 60s) written to pipeline_runs.last_heartbeat. reconcileState() runs every 60s as the watchdog: if last_heartbeat > 2 min stale AND PID is dead → mark run failed. expireInSeconds should be 300s (not hours).
> Context: Root cause: pg-boss expireInSeconds=7200 caused reconcileState to kill runs after exactly 2 hours even when the engine was still alive. Files: worker.ts, execution-engine.ts, migration 20260319200000.
> Source: debugging session

## 2026-03-19 [Decision] DB-based per-workspace concurrency lock replaces in-memory activeTriggeredVia
> Rule: Concurrency uses SELECT COUNT(*) FROM pipeline_runs WHERE workspace_id=$1 AND status='running' before spawning. The old in-memory activeTriggeredVia map was removed. Worktree runs bypass the lock. DB is the single source of truth, supports horizontal scaling.
> Context: Task-Monitor pattern freed pg-boss jobs immediately so the queue no longer acted as a concurrency lock. Files: worker.ts handlePipelineRun.
> Source: debugging session

## 2026-03-19 [Gotcha] Never have workers kill each other — fix process management instead
> Rule: Worker singleton guard must NEVER SIGTERM/SIGKILL other worker PIDs. In distributed environments, workers would assassinate each other. The zombie child problem is a process management issue — use --kill-others on concurrently or proper supervisor signal propagation.
> Context: concurrently failed to propagate SIGTERM to children, leaving zombie worker. Fix: package.json --kill-others --kill-others-on-fail. Files: package.json, worker.ts singleton guard.
> Source: debugging session

## 2026-03-20 [Bug Fix] GitHub OAuth 503 — tsx/esbuild module-level env var capture
> Rule: Module-level constants like `const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || ''` capture empty strings because tsx/esbuild hoists all require() calls before dotenv.config() runs. Fix: use lazy getter functions that call process.env at request time: `function githubClientId() { return process.env.GITHUB_CLIENT_ID || ''; }`
> Context: backend/src/routes/auth.ts — applies to ANY module-level env var constant in the backend that is needed at request time (not just startup). The dotenv.config() position in server.ts does NOT help due to esbuild hoisting.
> Source: session-2026-03-20

## 2026-03-20 [Bug Fix] Migration runner poisoning pool search_path (pg-index.ts)
> Rule: pg-index.ts runPgMigrations() sets `SET search_path TO public` but never restores it before releasing the pool connection. This poisons the reused connection — subsequent code (e.g. seedWorkerSettings) runs with search_path=public and cannot see rorca.* tables. Fix: in the `finally` block, run `SET search_path TO rorca, public` before client.release(). Same class of bug as AGE pool poisoning.
> Context: backend/src/db/pg-index.ts finally block (line ~201). Fixed 2026-03-20 by adding `try { await client.query('SET search_path TO rorca, public'); } catch {}` before client.release().
> Source: session-2026-03-20

## 2026-03-20 [Bug Fix] Two schema_migrations tables — public vs rorca schema split
> Rule: There are TWO schema_migrations tables: `public.schema_migrations` (used by migration runner after search_path fix) and `rorca.schema_migrations` (used before the fix). Migrations applied before the fix are only in `rorca.schema_migrations`. On fresh server starts, the runner tries to re-run them and fails on non-idempotent ones (e.g. 057). Fix applied 2026-03-20: upgraded public.schema_migrations.version to BIGINT and copied all missing rows from rorca.schema_migrations. Also: public.schema_migrations was INTEGER not BIGINT — had to ALTER COLUMN before copying timestamp versions (20260316+).
> Context: Symptoms: "[pg-migrate] FAILED: 057_spec_search_auto_index.sql" on every server start, server crashes. Root cause: public.schema_migrations missing versions 57+. One-time repair SQL: ALTER TABLE public.schema_migrations ALTER COLUMN version TYPE BIGINT; INSERT INTO public.schema_migrations SELECT r.version, r.applied_at, r.filename FROM rorca.schema_migrations r WHERE NOT EXISTS (SELECT 1 FROM public.schema_migrations p WHERE p.version = r.version);
> Source: session-2026-03-20

## 2026-03-20 [Bug Fix] GitHub account endpoint always returning connected:false (LIMIT 1 on users)
> Rule: workspace-github.ts GET /account used `SELECT id FROM users LIMIT 1` to find the "current user", which always returns admin@rorca.local (created first by migration seed). The GitHub-authenticated user (dteravan@gmail.com) is a different row and has the github_connections entry. Fix: query github_connections directly without going through users first: `SELECT gc.*, u.avatar_url FROM github_connections gc JOIN users u ON gc.user_id = u.id ORDER BY gc.created_at DESC LIMIT 1`
> Context: backend/src/routes/workspace-github.ts GET /account handler (~line 412). admin@rorca.local is always first in users table because it's seeded by initDb(). The GitHub OAuth user is created second.
> Source: session-2026-03-20

## 2026-03-20 [Pattern] sessionStorage return URL for OAuth flows
> Rule: Before triggering any full-page OAuth redirect, store the return destination in sessionStorage: `sessionStorage.setItem('github_oauth_return', '/settings/github')`. In the callback page, read it: `const returnTo = sessionStorage.getItem('github_oauth_return') || '/'; sessionStorage.removeItem('github_oauth_return'); navigate(returnTo, { replace: true })`. Without this, OAuth callbacks always land on '/' which React Router maps to /specs.
> Context: src/panels/GitHubSettingsPanel.tsx (Connect button onClick) + src/pages/GitHubCallbackPage.tsx (token storage + navigation). Also: in-memory oauthStateCache in auth.ts is ephemeral — server restarts during OAuth flow cause invalid_state errors (known limitation, not fixed).
> Source: session-2026-03-20

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

## 2026-03-23 [Gotcha] Singleton guard blocks worker restart — stale heartbeat survives process kill
> Rule: When a worker process is killed mid-run (e.g. by SIGKILL), its heartbeat row in worker_heartbeat persists for up to 90 seconds. The singleton guard in the new worker sees the heartbeat and exits with code 0. This cascades via concurrently --kill-others to kill the frontend and server too. Fix: pkill -9 -f "src/worker" to kill ALL worker processes (not just by port), then wait and restart.
> Context: Hit this multiple times during restart cycles in this session. The stale heartbeat window is 90s. Simply killing port 3030 does not kill the worker (it uses no port). Must kill by process name pattern.
> Source: session-2026-03-23

## 2026-03-23 [Gotcha] concurrently --kill-others kills everything when worker exits with code 0
> Rule: npm run dev uses concurrently with both --kill-others and --kill-others-on-fail. --kill-others kills ALL processes when ANY process exits, regardless of exit code. So when the worker exits cleanly (code 0) after graceful shutdown, it cascades to kill the frontend and server. This is why restarting the full stack after a worker crash requires killing all three separately.
> Context: Caused confusion because the worker exiting with code 0 (graceful shutdown after an active run was killed) still brought down the entire dev stack. --kill-others-on-fail alone would only trigger on non-zero exits.
> Source: session-2026-03-23

## 2026-03-23 [Convention] Three distinct knowledge layers: CLAUDE.md (IS), MEMORY.md (Learned), AGENTS.md (Rules), DB memories (Indexed)
> Rule: CLAUDE.md = declarative handbook of how the system IS built (stack, API routes, gotchas, architecture). MEMORY.md = episodic ledger of what was learned during runs (timestamped, categorized, actionable rules). AGENTS.md = governance of who owns what files and behavioral rules per zone. DB memories table = same content as MEMORY.md but structured, vector-searchable, scored, with embeddings and dedup. Each serves a different injection point and audience.
> Context: These are often conflated. The key distinction: CLAUDE.md answers "what IS this codebase?", MEMORY.md answers "what did we learn?", AGENTS.md answers "whose rules apply here?", DB memories answers "what's most relevant to this specific story right now?"
> Source: session-2026-03-23

## 2026-03-24 [Gotcha] worker-supervisor.ts stale processes send SIGTERM to new workers — kills the whole dev stack
> Rule: Stale `worker-supervisor.ts` node processes (started by previous npm run dev sessions) survive after the session ends and send SIGTERM to any new worker that starts, causing cascading --kill-others shutdown of the entire dev stack. Fix: before restarting, run `pkill -9 -f "worker-supervisor" && pkill -9 -f "rorca/backend"` to kill ALL rorca backend processes, not just by port. Port kills alone (lsof -ti:3030) miss the worker and supervisor since they don't bind to a port.
> Context: Hit repeatedly during restart cycles in this session. The worker would start successfully, process one cron tick, then immediately receive SIGTERM from a stale supervisor. The singleton guard (90s heartbeat) and the worker-supervisor both contribute to restart failures when not fully cleaning up.
> Source: session-2026-03-23

## 2026-03-24 [Convention] Full clean restart procedure for dev stack
> Rule: To fully restart the dev stack after crashes or stale process buildup: (1) `pkill -9 -f "rorca/backend"` — kills all tsx server/worker/supervisor processes, (2) `pkill -9 -f "worker-supervisor"` — kills supervisor, (3) `lsof -ti:3030 -ti:5210 | xargs kill -9` — clears ports, (4) wait 3s for heartbeat table to go stale (or wait 90s for full expiry), (5) `npm run dev`. Do NOT rely on port-only kills — the worker and supervisor have no bound port.
> Context: Developed from multiple failed restart attempts in this session. The key insight is that the worker process and worker-supervisor process do not bind to any port, so lsof-based port kills cannot reach them.
> Source: session-2026-03-23

## 2026-03-24 [Bug Fix] Run Pipeline button silent — TriggerPopover gated by !isFreePlan
> Rule: The "Run in Pipeline" button in SpecDetailSlideOver calls setShowTriggerPopover(true), but the TriggerPopover only renders when !isFreePlan. If user.plan is 'free' or unset, the button does nothing visibly. Fixed: button now calls handleRun(isolateInBranch) directly when isFreePlan, bypassing the popover.
> Context: SpecDetailSlideOver.tsx line 774. Introduced by rorca-pipeline-queueing-and-worktrees spec. Broke when billing-launch spec had not yet run (admin user defaults to free plan). The popover is for advanced options (forceSequential, queue, autoMerge) — free plan users should just run with defaults.
> Source: debugging session 2026-03-23

## 2026-03-24 [Bug Fix] Premature plan_required check in pipeline.ts blocking all trigger calls
> Rule: pipeline.ts had inline plan enforcement blocks at the trigger and retry routes that threw ForbiddenError('plan_required') for free-plan users. Since local-admin defaults to plan='free' and billing-launch spec hasn't run, this blocked all pipeline runs. Removed both blocks — plan enforcement belongs in requirePlan middleware, not inline in route handlers.
> Context: Lines ~1040-1049 and ~1933-1942 in pipeline.ts. Added by rorca-pipeline-queueing-and-worktrees spec. Did not manifest immediately because worker had old code cached in memory. Broke after worker restart loaded the new code. Fix: removed both blocks, left comment "Plan enforcement is handled by requirePlan middleware once billing-launch spec is complete."
> Source: debugging session 2026-03-23

## 2026-03-24 [Gotcha] local-admin user defaults to plan='free' — must be set to 'pro' manually
> Rule: The default admin user (id='local-admin', email='admin@rorca.local') has plan='free' in the DB. Any plan gate will block it. Until billing-launch spec runs and sets up proper subscription records, manually set: UPDATE users SET plan='pro' WHERE id='local-admin';
> Context: Discovered 2026-03-23 when pipeline trigger started returning 403 plan_required. getEffectiveUser() falls back to first user in DB (local-admin) when auth is bypassed globally. That user's plan='free' tripped the inline plan check added by rorca-pipeline-queueing-and-worktrees.
> Source: debugging session 2026-03-23

## 2026-03-24 [Bug Fix] Wave-parallel stale skipped flags — stories array and freshSpec were separate refs
> Rule: In execution-engine.ts, stale flag clearing read a freshSpec from disk and cleared flags on freshSpec.userStories, but the stories array passed to runParallel() was loaded earlier and not updated. Since getStories() returns spec.userStories by reference, clearing must be done directly on the stories array (same object). Fixed by deleting skipped/blocked flags on stories[] directly and writing spec (not freshSpec) back to disk.
> Context: Commit 11db1bc. Manifested as wave-parallel runs completing in 0.5s with "No executable stories" — all stories had stale skipped:true from a prior failed run. The freshSpec read was a different object entirely so clearing it had no effect on the stories array used for execution.
> Source: debugging session 2026-03-23

## 2026-03-25 [Architecture] hetzner-coolify-infra skill installed
> Rule: Skill hetzner-coolify-infra.md installed at .rorca/skills/ and .claude/skills/. Covers: Hetzner hcloud CLI, VM sizing (CX31 default), private network 10.0.0.0/16, floating IP for stable DNS, Coolify install, Postgres via Coolify, Rorca Docker deployment, worker as separate service, forge/ volume mount, AGE extension caveat. Pre-prod cost ~€19/mo.
> Context: User wants to deploy Rorca to Hetzner + Coolify for pre-prod testing. Skill created 2026-03-24.
> Source: manual
