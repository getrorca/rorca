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

## 2026-03-17 [Gotcha] execSync merge errors: log err.stderr not err.message — "Command failed" is useless
> Rule: When `execSync` throws on a failed git command, `err.message` only contains "Command failed: git merge ..." — the actual git error (conflict details, stderr output) is in `err.stderr` as a Buffer. Always log `err.stderr?.toString().trim()` first, fall back to `err.message`. Cast as `Error & { stderr?: Buffer }` for TypeScript.
> Context: Fixed in `mergeStoryWorktree` in execution-engine.ts. Was the reason merge failures were impossible to diagnose from logs — the full git conflict detail was silently discarded. Discovered when diagnosing run #20260316000009 where the logged error was "Command failed: git merge --no-ff ..." with no indication of which files conflicted.
> Source: debugging session 2026-03-17

## 2026-03-17 [Pattern] Diagnose run failures: query run_output_chunks + grep msg field from JSON logs
> Rule: To see the full execution log for any run (including errors scrolled off in the terminal), query: `psql postgres://rorca:rorca@localhost:5433/rorca -t -c "SELECT encode(chunk,'escape') FROM run_output_chunks WHERE run_id = <id> ORDER BY sequence" | grep -o '"msg":"[^"]*"' | sed 's/"msg":"//;s/"$//'`. The column is `chunk` (bytea), not `data`. Port is 5433, database is `rorca`.
> Context: Used to confirm root cause of run #20260316000009 failure. The terminal UI only shows a scrollable window — actual merge error messages and full cascade-block details are in run_output_chunks. This query reconstructs the full execution log from the DB.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] SSE live stream 5-minute delay — root cause and fix
> Rule: GET /api/pipeline/stream started lastSeenId=0 every connection, replaying ALL historical WAL events at LIMIT 50/tick. With 5000+ events this caused 5+ minute delay before live events appeared. Fix: initialize lastSeenId to MAX(id) FROM wal_events on connection open. Historical events served instantly by new REST endpoint GET /runs/:runId/wal-events. Combined: usePipelineSSE seeds history from REST (immediate), SSE stream delivers only new events (within 3s).
> Context: pipeline.ts line ~4332. The fix is a one-liner before the setInterval: `const maxWalRow = await queryOne('SELECT COALESCE(MAX(id), 0) AS max_id FROM wal_events'); let lastSeenId = maxWalRow?.max_id ?? 0;`. The REST endpoint uses `WHERE (payload->>'run_id')::bigint = $1 ORDER BY id ASC`. usePipelineSSE.ts seeds on runId change and deduplicates by event id.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] Merge failure leaves passes:true — idempotency gap causes next run to skip story with no code
> Rule: When a sub-worktree merge fails, markStoryPassed() had already written passes:true to the spec JSON. The failure path added the story to failedIds and emitted story_failed WAL event, but never reverted passes:true. Next run sees passes:true, skips the story, but the code is not in the parent branch. Fix: call markStoryMergeFailed() in both merge failure paths (single-story wave at line ~3154, multi-story wave failures at line ~3219). markStoryMergeFailed() sets passes:false, clears skipped, adds a note.
> Context: This was the exact bug that caused run #10 to exit in 760ms — US-001 merge conflicted in run #9, passes:true remained, run #10 pre-skipped US-001 and all downstream blocked stories immediately finished. markStoryMergeFailed() is try/catch wrapped so it never crashes the engine.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] Worker premature auto-merge — status=done without all stories passing triggered merge
> Rule: worker.ts was merging the parent worktree into main when status==='done' regardless of whether all spec stories passed. A run can be 'done' with 0 stories executed (immediate exit). Fix: before calling autoMergeAfterRun, read the spec JSON and verify every story has passes===true or excluded===true. Only merge if allSpecStoriesPassed is true.
> Context: In worker.ts around the autoMergeAfterRun call: read absSpecPath, parse JSON, check specJson.userStories.every(s => s.passes === true || s.excluded === true). Log warning and skip merge if not all passed. This ensures worktrees persist across multiple run IDs until the spec is fully complete.
> Source: debugging session 2026-03-17

## 2026-03-17 [Gotcha] tsx module cache causes routes to return 404 after file edits — fresh restart required
> Rule: After adding a new route to pipeline.ts, the route returned 404 despite being in the source and other routes in the same file working. tsx watch auto-restarts do not always invalidate the compiled module cache. `touch` on the file does not fix it. A full kill+restart (lsof -ti:3030 | xargs kill -9, then npm run dev) forces tsx to recompile from scratch and register all routes. Never diagnose a 404 for a route that exists in source without first doing a full restart.
> Context: Observed with GET /runs/:runId/wal-events route in pipeline.ts. Routes before and after it (skills, commits) returned 200. After kill+restart the route returned 200 immediately. The server must have been loaded from a stale tsx compilation cache.
> Source: debugging session 2026-03-17

## 2026-03-17 [Architecture] WAL event streaming architecture — two-track design for instant history + live events
> Rule: Two endpoints work together: (1) REST GET /api/pipeline/runs/:runId/wal-events returns all past WAL events for a run instantly via direct DB query. (2) SSE GET /api/pipeline/stream delivers live events only (starts at MAX WAL id). usePipelineSSE.ts: on runId change, immediately seeds from REST then deduplicates live SSE events by id. useWalSSE singleton: single EventSource shared across all components (avoids Chrome 6-connection limit). Never use SSE alone for historical data — always pair with REST seed.
> Context: The WAL table has 5000+ events. Starting SSE from id=0 caused 5+ minute delay. Starting from MAX(id) means SSE only delivers events created after the connection opens. The REST seed fills the gap for the current run's history instantly. Dedup by event.id in setEvents() prevents duplicates if live events arrive during the REST fetch.
> Source: architecture decision 2026-03-17

## 2026-03-17 [Gotcha] Never kill backend while a run is active — execution engine WAL writes will fail
> Rule: The execution engine (child of worker, not of server) sends WAL events via fetch to http://localhost:3030/api/wal. If the server is killed mid-run, those WAL writes fail silently and events are lost. The run continues but story progress disappears from the UI. The run stays stuck as status=running in the DB with no finished_at. Always confirm no active runs (GET /api/pipeline/worker/health activeJobs=[]) before killing the backend.
> Context: Killed backend during run #20260316000012 while US-003, US-004, US-005, US-006, US-007, US-008 were running in wave parallel. Run was interrupted. The worker process (separate PID) survived but the engine's WAL event writes started failing.
> Source: incident 2026-03-17

## 2026-03-17 [Gotcha] Worker process must be manually restarted after worker.ts changes
> Rule: Plain `tsx` (not `tsx watch`) is used for the worker — it does NOT hot-reload on file changes. Any change to `backend/src/worker.ts` requires killing the worker process and restarting it. The backend (Express) auto-restarts via tsx watch, but the worker is completely separate. Always verify worker PID start time vs file modification time before assuming a fix is live.
> Context: Root cause of run #20260316000017 not streaming output after the immediate-flush fix was applied: the fix was written to worker.ts at 13:38 but the worker had been running since March 16 15:59 and never picked it up. Kill with `kill <pid>` then `npm run worker` in backend/. Check: `ps aux | grep worker` for PID, `ls -la backend/src/worker.ts` for mod time.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] handlePipelineRetry also had the 4KB buffer bug — now fixed
> Rule: The immediate-flush fix (write every data event directly instead of buffering to 4KB) was only applied to `handlePipelineRun` initially. `handlePipelineRetry` (around line 1079) still had the old accumulating buffer. Both handlers now call `writeBufferAsChunks(runId, data, sequenceRef)` directly in `handleData` with no pending buffer accumulation.
> Context: Retry runs (POST /api/pipeline/runs/:id/retry) use handlePipelineRetry, not handlePipelineRun. Had the same 4KB buffer delay. Fixed 2026-03-17 in the same session where the worker was restarted.
> Source: debugging session 2026-03-17

## 2026-03-17 [Architecture] Wave parallel mini-terminal silence fixed by rorca-mini-terminal-db-output spec
> Rule: Wave parallel runs show no per-story output in mini-terminals because `run_output_chunks` has no `story_id` column — all stories write to the same table keyed by `run_id` only. The approved spec `rorca-mini-terminal-db-output` (7 stories) fixes this by: (1) adding a separate `story_output_chunks` table, (2) a `StoryLogFollower` WAL subscriber that fans out per-story, (3) a new SSE endpoint `GET /api/pipeline/runs/:runId/stories/:storyId/stream`, (4) US-007 validates wave parallel mini-terminals show prose. Sequential runs already stream fine after the immediate-flush worker fix.
> Context: Confirmed 2026-03-17: sequential runs now stream within ~10 seconds. Wave parallel mini-terminals still silent. rorca-mini-terminal-db-output is in forge/specs/approved/ and ready to run.
> Source: debugging session 2026-03-17

## 2026-03-17 [Decision] Remove hardcoded rorca.md injection from execution-engine.ts
> Rule: rorca.md must NOT be hardcoded-injected in buildPrompt(). It was previously always injected via readWorkspaceFile(.claude/skills/rorca.md) regardless of suggestedSkills. Removed in this session. Now rorca goes through normal loadMatchedSkills() like every other skill — only injected if in a story's suggestedSkills array, and tracked in active_skills for the Skills tab.
> Context: The Skills tab showed no skills because rorca was injected outside the activeSkillNames tracking path. The skip guard (lines 430-431) that prevented rorca from going through loadMatchedSkills was also removed. Files changed: backend/src/lib/execution-engine.ts
> Source: session-2026-03-17

## 2026-03-17 [Architecture] rorca-terminal-sse-overhaul spec — 10 stories, run AFTER rorca-mini-terminal-db-output
> Rule: Spec rorca-terminal-sse-overhaul replaces xterm.js with ansi-to-html + pre tag (RunTerminal + MiniTerminalPane) and WAL polling with Postgres LISTEN/NOTIFY. Must run AFTER rorca-mini-terminal-db-output because US-009 connects MiniTerminalPane to /stream endpoint (created by mini-terminal spec). Migration timestamp: 20260317100000 (avoids collision with mini-terminal's 20260317000001). RunTerminal must preserve RunTerminalHandle type with scrollToStory() and writeMarker() via useImperativeHandle — RunViewPanel depends on these. WAL polling side effects (recordTokenUsage, story_results token updates) must be migrated into LISTEN/NOTIFY handler in US-003.
> Context: Spec is in forge/specs/pending/rorca-terminal-sse-overhaul.json. Dependency on mini-terminal spec discovered after deep audit of MiniTerminalPane.tsx xterm usage and WAL polling side effects.
> Source: session-2026-03-17

## 2026-03-17 [Decision] GTM worktree branches US-018/031/036 — do NOT merge, let billing-launch redo
> Rule: Three unmerged GTM story worktrees (feat/rorca-go-to-market-v1-US-018, US-031, US-036) contain unique code not in main (github-token-validator.ts, github-review-requests.test.ts, license.ts). However they diverged from main at c9709e75 — well before 63 subsequent merges. Merging would clobber current main (~18k line deletions). These are failed story worktrees from the GTM run. The billing-launch spec will re-implement this work cleanly against current main. Delete worktrees, do not merge.
> Context: Verified via git merge-base --is-ancestor check. 60 of 63 worktrees were confirmed merged. 7 were not. GTM branches were the 3 failed stories split into billing-launch spec.
> Source: session-2026-03-17

## 2026-03-17 [Gotcha] git worktree merged check — use merge-base --is-ancestor SHA main, NOT git branch --merged
> Rule: To check if a worktree is merged into main, use: git merge-base --is-ancestor &lt;SHA&gt; main. Do NOT use git branch --merged main with shell pattern matching — it has zsh escaping bugs and gave wrong results (reported all 63 as merged when 7 were not). The merge-base approach checks the actual commit SHA from git worktree list against main's ancestry chain.
> Context: First check used a bash loop with grep pattern on branch names — zsh reported bad pattern errors but still printed merged=YES for all entries. Python script with subprocess was used to correctly identify 7 unmerged worktrees.
> Source: session-2026-03-17

## 2026-03-17 [Architecture] rorca-mcp-recall-tool spec complete — all 13 stories on main
> Rule: rorca-mcp-recall-tool (13 stories) fully merged to main as of 2026-03-17. Run #20260316000019 (32 min, 1 pass / 12 skip / 0 fail). Auto-merge completed (merge_commit_sha: 75d44d9). The 12 skips were already-implemented stories from prior runs 17+18. US-013 (rorca_dump MCP tool + GET /api/recall/dump) was the only story that ran. All code on main, no stale worktrees.
> Context: Spec implemented GET /api/recall/dump route (recall.ts), DumpResponse types (recall-types.ts), rorca_dump MCP tool in server.ts, and Jest tests (recall.test.ts).
> Source: session-2026-03-17

## 2026-03-17 [Architecture] rorca-mini-terminal-db-output spec — run BEFORE rorca-terminal-sse-overhaul
> Rule: rorca-mini-terminal-db-output (7 stories after US-006 deletion) creates story_output_chunks table, story-log-follower WAL subscriber (filters stream-json → prose, writes to DB), and GET /api/pipeline/runs/:runId/stories/:storyId/stream SSE endpoint. This fixes raw stream-json in wave parallel mini-terminals. Must run BEFORE rorca-terminal-sse-overhaul because US-009 of overhaul spec connects MiniTerminalPane to /stream. US-006 (MiniTerminalPane → /stream xterm update) was deleted from this spec to avoid conflict with overhaul's US-009 rewrite.
> Context: The two specs solve different problems: mini-terminal fixes server-side stream-json filtering; overhaul fixes client-side rendering (xterm → ansi-to-html). ansi-to-html alone does NOT fix raw JSON — it only renders ANSI colors. Both specs are needed.
> Source: session-2026-03-17

## 2026-03-18 [Gotcha] Worktree auto-merge fails silently when concurrent specs touch overlapping files
> Rule: When two specs run concurrently in separate worktrees and edit the same files, the auto-merge of the second worktree fails with real merge conflicts. The run is left stuck as 'running' and implementation files remain stranded in the feature branch. Recovery requires: (1) manual git merge with conflict resolution, (2) restoring dropped files via `git show <sha>:path > file`, (3) manually marking the run as failed in the DB.
> Context: Happened with rorca-mcp-recall-tool and rorca-mini-terminal-db-output running concurrently — both touched recall.ts, server.ts, and mcp/server.ts. Merge conflict markers were committed into the codebase (<<<<<<< Updated upstream), causing TypeScript compilation failures. The run record (e.g. #20260316000021) stayed stuck as status='running'. Post-merge, the restored files still had conflict markers that had to be manually resolved for each file.
> Source: debugging session 2026-03-17

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
