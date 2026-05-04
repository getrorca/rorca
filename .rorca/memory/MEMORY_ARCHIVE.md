# Memory Archive

## 2026-03-17 [Bug Fix] SSE live stream 5-minute delay — root cause and fix
> Rule: GET /api/pipeline/stream started lastSeenId=0 every connection, replaying ALL historical WAL events at LIMIT 50/tick. Fix: initialize lastSeenId to MAX(id) FROM wal_events on connection open. Historical events served by REST GET /runs/:runId/wal-events. usePipelineSSE seeds from REST on mount, deduplicates live events by id.
> Context: pipeline.ts ~line 4332. WAL table had 5000+ events causing 5+ minute delay.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] Merge failure leaves passes:true — idempotency gap
> Rule: When sub-worktree merge fails, markStoryPassed() already wrote passes:true. Must call markStoryMergeFailed() to revert to passes:false in both merge failure paths (single-story ~line 3154, multi-story wave ~line 3219). Without this, next run skips the story but its code is not in the parent branch.
> Context: Caused run #10 to exit in 760ms — US-001 merge conflicted in run #9, passes:true remained, run #10 skipped all stories immediately.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] Worker premature auto-merge — status=done insufficient guard
> Rule: Before calling autoMergeAfterRun, read spec JSON and verify ALL stories have passes===true or excluded===true. A run can be done with 0 stories executed. allSpecStoriesPassed check prevents merging partial specs.
> Context: worker.ts around autoMergeAfterRun call.
> Source: debugging session 2026-03-17

## 2026-03-17 [Gotcha] Never kill backend while a run is active
> Rule: Execution engine sends WAL events via fetch to http://localhost:3030/api/wal. Killing the server mid-run silently drops those writes. Always check GET /api/pipeline/worker/health activeJobs=[] before killing backend.
> Context: Killed backend during run #20260316000012, interrupted wave parallel execution.
> Source: incident 2026-03-17

## 2026-03-17 [Gotcha] tsx module cache — new routes return 404 until full restart
> Rule: After adding a new route, tsx watch auto-restart may not invalidate the compiled module cache. Route returns 404 even though it's in source and neighboring routes work. Full kill+restart required: lsof -ti:3030 | xargs kill -9 && npm run dev.
> Context: GET /runs/:runId/wal-events returned 404 until full restart. touch did not fix it.
> Source: debugging session 2026-03-17

## 2026-03-10 [Gotcha] pg is async — always await DB calls
> Rule: All DB calls (query, queryOne, execute) are async via pg Pool. Always use `await`. Use `$1, $2, ...` numbered placeholders (NOT `?`).
> Context: Missing `await` returns a Promise instead of data. PostgreSQL uses numbered placeholders, not positional `?`.
> Source: rorca-postgres-migration PG-011

## 2026-02-27 [Gotcha] Backend requires restart after changes
> Rule: tsx has no hot-reload. Always kill port 3030 and restart after backend changes: lsof -ti:3030 | xargs kill -9 && npm run dev
> Context: Changes to backend code are not picked up automatically. Forgetting to restart causes stale behavior.
> Source: v2-platform

## 2026-03-01 [Gotcha] Wave-based execution blocks dependent stories on single failure
> Rule: When wave execution is enabled, a single story failure in wave 0 causes all dependent stories to skip with reason='blocked_by'
> Context: SM-001 failed in wave 0, causing SM-002, SM-004, and SM-006 to skip despite not being directly tested. This cascading failure pattern means early wave failures have exponential impact on run completion rate.
> Source: SM-001

## 2026-03-01 [Pattern] Marketplace UI components follow extract-then-enhance pattern
> Rule: When adding features to marketplace panels, first extract shared utilities (SM-003: renderMarkdown), then build new UI features (SM-005: category filters) on top of the shared foundation
> Context: SM-003 and SM-005 passed while SM-001 failed, suggesting the incremental approach of establishing shared utilities before complex features reduces integration risk.
> Source: SM-003

## 2026-03-08 [Decision] PostgreSQL Migration Supersedes SQLite Optimization
> Rule: When planning production infrastructure, choose PostgreSQL from day one rather than optimizing SQLite then migrating later
> Context: PR-049 and PR-050 (SQLite optimization + benchmarks) were superseded by the rorca-postgres-migration spec. This teaches us that production-grade DB decisions should be made upfront, not incrementally optimized from dev-grade solutions.
> Source: rorca-postgres-migration

## 2026-03-08 [Pattern] Production Hardening Follows Layered Security Model
> Rule: Production readiness requires CORS hardening (PR-NEW-2), rate limiting (PR-NEW-1), secrets management (vault_keys table), and health checks — implement all four layers, not just one
> Context: The production-ready spec shows these are interdependent: rate limiting without CORS leaves attack vectors open; health checks without secrets management can't validate encrypted data access.
> Source: rorca-production-ready

## 2026-03-08 [Pattern] Spec Queue Panel Uses Dual-Tab Architecture
> Rule: Queue-style panels (review queue, run queue) use a dual-tab pattern: 'pending' + 'history' tabs with shared data fetching and SSE subscriptions
> Context: PR-QUEUE-1 (Spec Review Queue Panel) establishes this pattern. Both tabs subscribe to the same SSE stream but filter differently. Prevents code duplication and ensures real-time consistency across views.
> Source: PR-QUEUE-1

## 2026-03-08 [Decision] Feature Badges Use Semantic Versioning Gates
> Rule: New features get badges (e.g. 'New in v2.1') tied to semantic version checks — frontend shows prompts for features available in current version but not yet used
> Context: PR-052 implements upgrade prompts + feature badges. This creates a progressive disclosure UX where users discover features organically rather than via docs. Version gate prevents showing unavailable features.
> Source: PR-052

## 2026-03-12 [Bug Fix] MCP rorca_list_specs and rorca_list_runs wrong response shape
> Rule: Both tools assumed wrong API response shapes. rorca_list_specs treated response as a bare array but API returns { items: [...] }. rorca_list_runs destructured { runs } but API returns { items: [...] }. Fixed by normalizing: Array.isArray(data) ? data : (data.items ?? []) for list_specs, and payload.runs ?? payload.items ?? [] for list_runs. Also fixed specName field: API uses specName not title — display as s.specName ?? s.title ?? s.id.
> Context: backend/src/mcp/server.ts lines 108-115 (list_specs) and 432-436 (list_runs). Errors were: "specs.map is not a function" and "Cannot read properties of undefined (reading 'length')"
> Source: debugging session 2026-03-11

## 2026-03-12 [Pattern] MCP tools vs prompts — tools are Claude-callable, prompts are user slash commands
> Rule: MCP tools (server.registerTool) are called by Claude automatically during conversation. MCP prompts (server.registerPrompt) become user-invocable slash commands: /mcp__rorca__<name> [args]. Prompts use argsSchema (ZodRawShape, same as inputSchema for tools) and return { messages: [{ role: 'user', content: { type: 'text', text: '...' } }] }. All 24 Rorca tools now have corresponding prompt slash commands in backend/src/mcp/server.ts. Exceptions: edit_story, update_direction, create_workspace, team_members left as tools-only (complex multi-line inputs awkward as CLI args). generate_spec added as both tool AND prompt — takes quoted args: /mcp__rorca__generate_spec "slug" "brief".
> Context: backend/src/mcp/server.ts — prompts section starts at ~line 1065 with DEFAULT_WORKSPACE = 'rorcha'. MCP server requires VS Code window reload to pick up file changes (stdio process does not hot-reload). /mcp command shows connection status but does NOT restart the process.
> Source: implementation session 2026-03-11

## 2026-03-12 [Decision] GitHub org is getrorca — repo is github.com/getrorca/rorca (private)
> Rule: The canonical remote for the Rorca codebase is https://github.com/getrorca/rorca (private repo). The old remote was sysgazer/rorcha — that is dead. All pushes go to getrorca/rorca. The repo is permanently closed source — never suggest open sourcing, BSL, or source-available licensing.
> Context: GitHub org 'getrorca' was created on 2026-03-12. Remote updated via git remote set-url origin https://github.com/getrorca/rorca.git. All 50 branches + full commit history pushed. Binary release assets on GitHub Releases are publicly downloadable even from a private repo — install scripts point to release URLs.
> Source: session-2026-03-12

## 2026-03-12 [Gotcha] Merging old SQLite-era branches with "take theirs" clobbers modern PostgreSQL files
> Rule: NEVER merge old pre-postgres-migration branches (rorca-convention-agents, rorca-frontend-routing, and any branch with timestamp ~1772...) using "git checkout --theirs" on code conflicts. These branches were built on SQLite and will revert db/index.ts to the SQLite version, revert App.tsx/Sidebar.tsx/routes.tsx to the old multi-panel UI, and truncate server.ts. Always restore from a known-good modern commit (e.g. git show <pre-merge-sha>:path/to/file) after any such merge.
> Context: On 2026-03-12, merging all unmerged branches caused: (1) db/index.ts reverted to better-sqlite3 import — backend crashed with MODULE_NOT_FOUND. (2) App.tsx, Sidebar.tsx, routes.tsx, main.tsx reverted to old ~30-panel UI. (3) server.ts lost 123 lines of route mounts. (4) knowledge-graph.ts lost 103 lines. Files restored from commit ee44b4f using git show. Critical file list to check after any old-branch merge: backend/src/db/index.ts, backend/src/server.ts, src/App.tsx, src/main.tsx, src/routes.tsx, src/components/Sidebar.tsx, src/panels/SpecsPanel.tsx, backend/src/lib/knowledge-graph.ts.
> Source: session-2026-03-12

## 2026-03-12 [Bug Fix] mod+shift+r hotkey hijacked browser hard refresh (Cmd+Shift+R)
> Rule: Do not bind mod+shift+r (Cmd+Shift+R) as a hotkey in the app — it is the browser's hard refresh shortcut on macOS. The hotkey was bound to navigate('/runs'), so every hard refresh silently redirected the user to the Runs page instead of refreshing. Fixed by removing the binding from the hotkeys array in App.tsx.
> Context: Discovered 2026-03-12. Symptom: user reported "hard refresh always takes me to Runs page." Root cause: src/App.tsx hotkeys array had { key: 'mod+shift+r', handler: () => handleNavigate('runs') } — the app intercepted the keydown before the browser could handle it. Fix: removed that entry. The r key alone still navigates to runs (when no input focused).
> Source: session-2026-03-12

## 2026-03-12 [Decision] rorca-ensure-postgres completed — zero-prereq Postgres provisioning in bin/rorca.ts
> Rule: bin/rorca.ts now includes a full ensurePostgres() function. On first run, it downloads Postgres 16 binaries from zonkyio/embedded-postgres-binaries, extracts, runs initdb, starts pg_ctl on port 5433, creates rorca user and database. No Docker required. DATABASE_URL env var bypasses this entirely (preserves Docker workflow). --no-postgres flag also skips it. Postgres is stopped on SIGINT/SIGTERM via stopManagedPostgres().
> Context: Spec rorca-ensure-postgres (5 stories, US-001–005) completed 2026-03-12. Constants: POSTGRES_VERSION='16.2.0', POSTGRES_PORT=5433, POSTGRES_HOME=~/.rorca/postgres. Platform detection maps darwin-arm64, darwin-amd64, linux-amd64, linux-arm64v8, windows-amd64 to zonkyio binary filenames. managedPostgresStarted flag prevents stopping a postgres that was already running before rorca started.
> Source: session-2026-03-12

## 2026-03-12 [Bug Fix] tsx watch restarts backend during parallel runs → resilient-post retries exhaust
> Rule: When a fast worktree run auto-merges into main, tsx watch detects the file changes and restarts the backend (5-10s TypeScript recompile). If resilient-post.ts retry window is shorter than the restart time, execution engine can't report story results and the run shows as failed. Fix: raise POST_MAX_RETRIES to 10 and POST_RETRY_DELAY_MS to 3000 (30s coverage) in backend/src/lib/resilient-post.ts.
> Context: Parallel worktree runs showing "failed" even though the agent completed work. Root cause: tsx watch restart (5-10s) > old retry window (3×1s = 3s). Execution engine survives as detached OS process but can't POST results back to dead backend. Long-term fix: use compiled backend (no tsx watch) or a merge queue so merges don't happen mid-run.
> Source: debugging session 2026-03-12

## 2026-03-12 [Decision] Distribution format: curl|sh for launch, native installers deferred
> Rule: Use `curl -fsSL https://get.rorca.app | sh` (macOS/Linux) + PowerShell equivalent (Windows) for launch distribution. Do NOT build .pkg (macOS) or .exe (Windows) installers yet — they require code signing certs (~$400/yr) and unsigned installers trigger OS security warnings (Gatekeeper, SmartScreen) which is worse UX than curl|sh. Native installers and Homebrew tap (`brew install getrorca/tap/rorca`) are deferred until there's user demand.
> Context: Discussed 2026-03-12. The target audience (developers using Claude/OpenCode/Codex) expects curl|sh — it's the standard for CLI tools (Rust, Deno, Bun). Binary is compiled via bun build --compile so source protection is identical regardless of delivery mechanism. The rorca-distribution spec (DIST-001–010, completed) already implements the curl|sh approach.
> Source: manual

## 2026-03-13 [Bug Fix] pgboss.archive column names are snake_case: retry_count, archived_on (NOT retrycount/archivedon)
> Rule: pgboss.archive uses snake_case column names: retry_count, retry_limit, archived_on. The production route GET /api/pipeline/runs/:id/dlq in pipeline.ts incorrectly uses retrycount and archivedon — these fail with "column does not exist". The .catch(()=>undefined) in the production route silently swallows the error, making it always return 404. Total attempts = retry_count + 1 (retry_count = retries consumed, not including initial attempt).
> Context: Discovered while writing pg-boss-dlq.test.ts (PG-018). The test confirmed the correct column names by querying information_schema.columns for pgboss schema.
> Source: pg-boss-dlq.test.ts implementation

## 2026-03-13 [Gotcha] Worktree spec runs don't auto-merge — manual merge required
> Rule: When a spec runs with autoWorktree:true, all story commits land on a feature branch (feat/&lt;slug&gt;-&lt;timestamp&gt;) and are NEVER automatically merged to main. The run shows "done" and stories show "pass" in the DB, but the code is not in main. Must manually: git merge --no-ff feat/&lt;branch&gt;. Resolve conflicts carefully — parallel main commits may have added migrations or modified the same files.
> Context: Discovered 2026-03-13: rorca-worker-production-ready ran on feat/rorca-worker-production-ready-1773414782894, all 10 stories passed, but worker-supervisor.ts and all WR fixes were missing from main for days. Kill button was broken, worker had no supervisor — all because the branch was never merged. This is a known process gap; auto-merge spec is not yet built.
> Source: debugging session 2026-03-13

## 2026-03-13 [Gotcha] Parallel feature branches cause duplicate migration numbers
> Rule: Migration runner keys on the numeric version extracted from the filename (e.g. 069 from 069_foo.sql). If two branches independently create a migration with the same number, the runner applies the first alphabetically and silently skips the second. Always check the highest migration number in schema_migrations before creating a new migration file. Fix: rename the conflicting file to the next available number and INSERT the new version into schema_migrations manually.
> Context: 2026-03-13: 069_add_source_to_memories.sql was in main; feature branch created 069_worker_heartbeat_active_jobs.sql. The active_jobs column was never added, causing worker heartbeat writes to fail on every startup. Renamed to 071, applied manually.
> Source: debugging session 2026-03-13

## 2026-03-13 [Bug Fix] pg-boss internal column is started_on not startedon
> Rule: When querying pgboss.job directly, the column name is started_on (with underscore), NOT startedon. Using startedon causes a DatabaseError that is caught and logged as a warning, making stale job recovery silently fail on every worker startup without crashing. Any direct pgboss.job queries must use started_on, completed_on, expire_in (not expirein), etc.
> Context: WR-004 (stale job recovery) passed acceptance criteria but had this typo in worker.ts line 643. Fixed 2026-03-13. The story passed because the error was non-fatal — a cautionary example of acceptance criteria not testing pg-boss internal schema column names.
> Source: debugging session 2026-03-13

## 2026-03-13 [Bug Fix] Kill button silent fail — activeProcesses map empty after worker restart
> Rule: The cancel route sends a pipeline:cancel pg-boss job to the worker, which looks up activeProcesses.get(runId). If the worker was restarted since the run started, activeProcesses is empty and no SIGTERM is sent — the HTTP call returns 200 but the process is never killed. WR-010 added a dead-PID fallback: when activeProcesses misses, fall back to the pid stored in pipeline_runs and kill directly. Now live in main.
> Context: Run 104 was stuck for 38+ minutes; kill button appeared to work (200 OK) but did nothing. Root cause identified 2026-03-13. Fix was in the unmerged WR branch — once merged, the cancel endpoint works correctly even after worker restarts.
> Source: debugging session 2026-03-13

## 2026-03-13 [Gotcha] 150+ unmerged feat/ branches accumulate — audit regularly
> Rule: Worktree spec runs create feat/ branches that never auto-merge. After several months of development, 150+ branches can accumulate. Most are stale (superseded by later runs of the same spec). When auditing: (1) check remote feat/ branches with commits not in main using `git branch -r | grep feat/ | while read b; do count=$(git log --oneline main.."$b" 2>/dev/null | wc -l | tr -d ' '); if [ "$count" -gt "0" ]; then echo "$count | $b"; fi; done`, (2) skip old pg-boss/scaffolding branches — their work is superseded by WR spec, (3) merge the most recent run of each spec (highest timestamp suffix = most complete), (4) skip convention-agents branches (old stubs, superseded by future spec).
> Context: 2026-03-13: Found 150 feat/ branches, 7 with unmerged commits. Merged: rorca-context-autohydrate (11 commits, US-005–010), rorca-context-usage-visibility (1 commit, tests). Skipped: rorca-pg-boss-job-queue (PG-002–005, superseded by WR code in main), rorca-convention-agents CA-001/005/018 (old stubs), older context-autohydrate partial run.
> Source: debugging session 2026-03-13

## 2026-03-13 [Bug Fix] completedon → completed_on in pgboss.job UPDATE queries
> Rule: pg-boss internal schema uses snake_case with underscores for ALL column names: started_on, completed_on, completed_after, expire_in. NOT startedon, completedon, etc. Affected reconcileState (Case B) and recoverStaleJobs — both silently failed on every 30s tick, leaving stale active pgboss.job rows that block new runs from being picked up. Fixed 2026-03-13 in worker.ts. When writing any direct pgboss.job or pgboss.archive queries, always use underscored column names.
> Context: Discovered during run 105: reconcileState was logging 'column completedon does not exist' every 30s but not crashing. Same class of bug as started_on typo from WR-004. Both bugs were in the WR feature branch that passed acceptance criteria without testing actual pg-boss column names.
> Source: debugging session 2026-03-13

## 2026-03-13 [Gotcha] Old execution-engine processes from test runs survive indefinitely
> Rule: Execution-engine subprocesses from old load test runs (WR-019, PG-020) and integration tests in temp paths can survive machine restarts and run for days, consuming CPU/memory. Check with: `ps aux | grep execution-engine | grep -v grep`. Kill PIDs associated with temp paths (/var/folders, /tmp) or old worktree paths. WR-007 graceful shutdown only helps for clean worker exits — kill -9 or machine crash still orphans children. Safe to kill any execution-engine with a temp path or a worktree path that no longer exists.
> Context: 2026-03-13: Found 3 zombie execution-engine processes from rorca-feat-rorca-production-ready-1772962191810 worktree running since Sunday (PIDs 95869, 95866, 57640). Were running against /var/folders temp paths from load tests. Killed manually with kill -9.
> Source: debugging session 2026-03-13

## 2026-03-13 [Decision] MCP-native generation: API as context+persistence layer, LLM work in caller's session
> Rule: Rorca's API should split LLM-heavy operations (spec generation, enrichment) into two phases: (1) context-fetch — API returns the synthesized direction stack, memory, schema, skills as a raw bundle with no LLM call; (2) save — API persists the result the caller's LLM already generated. The LLM reasoning happens IN the caller's MCP session (Claude Code, OpenCode CLI, Codex CLI), not in a server-spawned subprocess. This means: rorca_get_generation_context returns the context bundle, the calling LLM generates the spec JSON in-session using cached/warm context, then rorca_save_spec persists it. The existing server-side generation path (spawning claude --print) is kept as a fallback for browser UI users who have no MCP session. This is the correct long-term architecture for rorca_forge_and_run too — it should orchestrate tool calls that the caller's session handles, not block on a subprocess.
> Context:  
> Source: mcp-cli

## 2026-03-13 [Bug Fix] Model override UI renders object instead of string — Objects are not valid as React child
> Rule: In the story model override UI (SpecDetailSlideOver or SpecsPanel), a full model object {id, label, provider, providerType, costPer1kInput, costPer1kOutput, contextWindow, speedTier, costTier, recommended} is being rendered directly as a React child. Fix: render model.label or model.id instead of the raw object. One-line fix wherever `{selectedModel}` or `{model}` appears in JSX — must be `{selectedModel.label}`, `{selectedModel.id}`, etc.
> Context: Seen in Specs panel when opening model override for a story (US-003 from rorca-story-model-assignment, run #103 implemented this UI). The model object comes from GET /api/direction/models. Error: "Objects are not valid as a React child (found: object with keys {id, label, provider, providerType, costPer1kInput, costPer1kOutput, contextWindow, speedTier, costTier, recommended})". Surfaces as a full-panel error boundary in Specs. Not a backend issue.
> Source: debugging session 2026-03-13

## 2026-03-14 [Bug Fix] AGE search_path pool poisoning — intermittent "Workspace not found" 404s
> Rule: Any code that calls setupAgeSession() (LOAD 'age' + SET search_path = ag_catalog) MUST restore the search_path before releasing the pool connection: `await client.query('SET search_path = rorca, public')` in the finally block before `client.release()`. Without this, the pool connection retains ag_catalog as the first schema, causing subsequent queries to hit ag_catalog.workspaces (empty) instead of rorca.workspaces (real data) — producing intermittent "Workspace not found" 404s across all routes.
> Context: Root cause of 2+ hours of debugging "Workspace not found" errors on 2026-03-14. Three files were affected: knowledge-graph.ts, graph-context.ts, graph-drift-detector.ts. The bug was intermittent because only pool connections previously used for graph queries were poisoned — pool connection assignment is random across requests. Three schemas have a workspaces table: rorca.workspaces (app data), ag_catalog.workspaces (AGE system, empty), public.workspaces (legacy, empty). Additional safeguards added: pool on('connect') handler in db/index.ts sets search_path on every new connection; Express middleware disables ETags and sets Cache-Control: no-store to prevent browsers from caching error responses; ALTER ROLE rorca SET search_path TO rorca, public removed ag_catalog from the role default.
> Source: debugging session

## 2026-03-14 [Gotcha] PostgreSQL BIGINT returned as strings by pg driver — must coerce with Number()
> Rule: The node-pg driver returns BIGINT column values as JavaScript strings, not numbers. When comparing BIGINT values with parseInt() results (e.g. in Set.has() lookups), always coerce with Number(r.version) when building the Set. Without this, Set.has(1) won't match "1" and the migration runner would try to re-apply every migration on every startup.
> Context: Discovered when upgrading schema_migrations.version from INTEGER to BIGINT (migration 079). The runner's appliedVersions Set contained strings like "1", "69" but parseInt() returns numbers. Fixed in pg-index.ts: applied.map(r => Number(r.version)). This applies to ANY code that reads BIGINT columns and compares with JavaScript numbers.
> Source: debugging session — caught during timestamp migration implementation

## 2026-03-14 [Decision] Hybrid migration strategy — keep sequential 001-079, timestamps going forward
> Rule: Do NOT rename existing sequential migrations (001-079) to timestamp format. The hybrid approach is intentional: existing migrations keep their numbers, new migrations use YYYYMMDDHHMMSS. The runner's numeric sort naturally orders timestamps after sequential numbers (79 < 20260314150000). Renaming 79+ existing files and updating schema_migrations records is high-risk with no benefit — the old migrations are already applied and immutable.
> Context: The rorca-migration-timestamps spec (run 116) failed at US-003 (automated rename of existing files) because the rename logic was fragile and error-prone. The correct architectural decision is to draw a line at migration 079 and go forward with timestamps only. This follows Rails convention — when Rails added timestamps in 2007, it didn't rename existing migrations.
> Source: architectural decision — manual implementation after spec failure

## 2026-03-15 [Bug Fix] pipeline:cron backlog floods worker on restart — starves pipeline:run jobs
> Rule: When the worker is down, the scheduler (running in the API server) keeps queuing pipeline:cron meta-tick jobs — one per minute. On worker restart, hundreds of cron ticks flood the pipeline:cron queue (batchSize:10, fires every 2s). This saturates the worker's polling loop and can cause pipeline:run jobs to be picked up silently but die mid-process, ending up as stale 'active' jobs that recoverStaleJobs() then marks failed. Any pipeline:run job that was queued while the worker was down may need to be re-triggered after the worker restarts.
> Context: Observed 2026-03-15: Workspace workspace pipeline:run job queued for 10+ minutes while worker was running. Worker was flooded with 50+ pipeline:cron ticks from backlog. Job eventually went active but worker was killed before completing it. recoverStaleJobs() on next restart correctly failed it. Fix: rorca-queue-observability spec adds archiveCompletedAfterSeconds and deleteAfterDays settings that prevent unbounded cron job accumulation. Also: rorca-worker-concurrency-settings increases maxConcurrent so real pipeline jobs aren't starved.
> Source: debugging session 2026-03-15

## 2026-03-15 [Bug Fix] Worker never promoted queued runs — advanceQueue() missing from worker.ts
> Rule: advanceQueue() must be called after EVERY run completion path in worker.ts (main exit, spawn error, retry exit, retry spawn error, stale job recovery, orphan sweep, state reconciliation). Without it, queued runs sit forever until state_reconciliation kills them.
> Context: Run #126 failed because: (1) advanceQueue() only existed in pipeline.ts for quick-run and pre-hook-fail paths, never in worker.ts which handles 99% of runs. (2) reconcileState() Case A included 'queued' in its stuck-run check, but queued runs intentionally have no pg-boss job — they wait for promotion. Fixed by adding advanceQueue() to all 7 worker completion paths and changing reconcileState to only check status='running'. Files: backend/src/worker.ts, backend/src/lib/run-queue.ts
> Source: debugging session — run #126 rorca-run-view-streaming-fix killed after 59s

## 2026-03-15 [Bug Fix] reconcileState() killed legitimate queued runs — 'queued' removed from Case A query
> Rule: reconcileState() Case A must only check status='running' (not 'queued'). Queued runs intentionally have no pg-boss job — they are managed by advanceQueue() which promotes them when the active run completes. Including 'queued' in the NOT EXISTS check causes reconciliation to mark every queued run as failed after 60 seconds.
> Context: Root cause of run #126 failure. The queue code path (pipeline.ts lines 1296-1305) creates a pipeline_runs row with status='queued' but does NOT send a pg-boss job. The pg-boss job is only created when advanceQueue() calls POST /api/pipeline/trigger with queuedRunId. File: backend/src/worker.ts reconcileState() function.
> Source: debugging session — run #126 state_reconciliation false positive

## 2026-03-15 [Bug Fix] pipeline.ts merge conflicts resolved — queue-observability pickup latency kept
> Rule: The /api/pipeline/worker/health endpoint uses individual CountRow/AgeRow/QueueRow/LatencyRow queries (not a single QueueStatsRow IIFE). The pickup latency metrics (avg/p50/p95/max over 24h rolling window for pipeline:run + pipeline:retry) are part of the queue-observability spec and must be preserved in any future merge.
> Context: 7 merge conflicts in pipeline.ts between queue-observability (merged branch) and stashed deterministic worktree changes. Resolved by keeping the upstream (queue-observability) code which includes pickup latency classification (healthy/degraded/critical based on p95). Files: backend/src/routes/pipeline.ts worker/health endpoint around line 5400+.
> Source: merge conflict resolution — queue-observability branch merge to main

## 2026-03-16 [Bug Fix] payload::text LIKE queries cause pool exhaustion under wave parallelism
> Rule: Never use `payload::text LIKE '%"run_id":N%'` on wal_events. Always use `(payload->>'run_id')::int = $N` — JSONB accessor is 10x faster and doesn't cause full table scans. Critical under wave parallelism (18+ concurrent SSE connections each polling WAL).
> Context: Run #130 (rorca-go-to-market-v1, 70 stories, parallelism=18) caused repeated backend crashes. Each MiniTerminalPane opens an SSE connection to /api/pipeline/runs/:runId/stories/:storyId/log, which polled WAL every 500ms with payload::text LIKE. 18 stories × 2 queries × every 500ms = 72 queries/sec, each taking 7-10s = instant pool exhaustion (max 20 connections). Fixed by: (1) replacing all 8 payload::text LIKE queries in pipeline.ts with (payload->>'run_id')::int JSONB accessor, (2) increasing poll interval from 500ms to 3s, (3) wrapping polling queries in try-catch to prevent unhandled rejections from killing the process. Files: backend/src/routes/pipeline.ts lines ~2694, 2752, 3994, 4156, 4192, 4206, 4253, 4277, 4370, 4378.
> Source: debugging session 2026-03-16

## 2026-03-16 [Bug Fix] specs.ts u.name column does not exist — users table uses display_name
> Rule: The `users` table column is `display_name`, not `name`. Any JOIN query referencing `u.name` will crash with 'column u.name does not exist'. The go-to-market spec run introduced this bug in the spec_attachments query at specs.ts:9970.
> Context: Run #130 story wrote code that JOINed users as `u.name AS uploader_name` but the column is `display_name`. The unhandled DB error triggered the worker's unhandledRejection handler, which initiated graceful shutdown — killing both API and worker. Fixed to `u.display_name AS uploader_name`. File: backend/src/routes/specs.ts:9970.
> Source: debugging session 2026-03-16

## 2026-03-16 [Gotcha] unhandledRejection in server.ts kills entire process including API
> Rule: The worker's unhandledRejection handler triggers graceful shutdown of the entire Node process. When server.ts and worker code share a process (via `npm run dev` / concurrently), ANY unhandled promise rejection — even a transient DB connection timeout — kills the API server too. DB queries in setInterval callbacks MUST be wrapped in try-catch.
> Context: Two separate crashes in the same session: (1) u.name column error in specs.ts, (2) pool exhaustion timeouts in pipeline.ts polling loops. Both were unhandled rejections that triggered worker shutdown. The worker shutdown handler is aggressive — it deletes heartbeat row, stops pg-boss, and exits. Any code path that runs async DB queries outside of Express route error handling (timers, SSE polling) must have its own try-catch.
> Source: debugging session 2026-03-16

## 2026-03-16 [Bug Fix] worker.ts uses batchSize instead of teamSize — only 1 concurrent run despite max_concurrent_runs=3
> Rule: worker.ts line 2148 calls `boss.work('pipeline:run', { batchSize: currentMaxConcurrent }, handler)`. batchSize controls how many jobs to FETCH per poll, not how many run concurrently. teamSize is the correct pg-boss option for concurrent handler invocations. Fix: change to `{ teamSize: currentMaxConcurrent, batchSize: currentMaxConcurrent }`. Same bug on pipeline:retry at line 2149. Until fixed, only 1 pipeline run executes at a time regardless of max_concurrent_runs setting.
> Context: Confirmed 2026-03-16: user triggered rorca-billing-launch and rorca-test-ci-hardening simultaneously with autoWorktree=true. max_concurrent_runs=3 in worker_settings table. Second run stayed queued. Worker health showed only 1 activeJob despite batchSize:3. Root cause: wrong pg-boss option. Needs worker restart to take effect after fix.
> Source: debugging session 2026-03-16

## 2026-03-16 [Bug Fix] Wave parallel terminal blank — backend restart required after rorca-runs-panel-fixes merge
> Rule: rorca-runs-panel-fixes (run #133, all 5 stories) is merged to main. Fixes include: @refresh reset on RunViewPanel+PipelineMonitorPanel (US-001), usePipelineRuns shared hook (US-002), run_setup_started/run_setup_done WAL events from execution-engine (US-003), setup banner in RunViewPanel (US-004), concurrent story Running indicators (US-005). Backend must be manually restarted (plain tsx, no auto-reload) to activate US-003 (execution-engine WAL events). Cannot restart while runs are active — kills them. Restart after all active runs complete.
> Context: User saw blank terminal on run #134 (rorca-billing-launch) even after fixes were supposedly applied. Fixes are on main but backend was never restarted post-merge.
> Source: debugging session 2026-03-16

## 2026-03-16 [Decision] Wave parallel sub-terminals deferred — needs run_output_chunks story_id column
> Rule: Sub-terminals per wave story are architecturally impossible without adding story_id to run_output_chunks. All parallel stories write to the same (run_id, sequence, chunk) stream with no per-story segregation. MultiPaneTerminal component exists and is wired but cannot split the stream. Deferred to a separate spec. Short-term: concurrent Running indicators in story list (US-005, done) make parallelism visible without splitting the terminal.
> Context:  
> Source: mcp-cli

## 2026-03-16 [Decision] pipeline_runs.id widened to BIGINT, sequence restarted at 20260316000000
> Rule: Applied migration 20260316141659_pipeline_runs_seq_restart.sql on 2026-03-16. pipeline_runs.id and all child run_id columns (story_results, run_output_chunks, token_usage, memory_proposals) widened from INTEGER to BIGINT. pipeline_runs_id_seq widened AS BIGINT and restarted at 20260316000000. Old runs #1–#133 keep sequential IDs. New runs get timestamp-ish IDs (20260316000001, 20260316000002, ...). Mirrors the same "don't rename old, apply going forward" split used for migration filenames.
> Context:  
> Source: mcp-cli

## 2026-03-16 [Gotcha] Run ID numbering: old runs #1–#133 sequential, new runs 20260316000001+ timestamp-based
> Rule: pipeline_runs.id is BIGINT (was INTEGER). Old runs have sequential IDs (#1–#133). New runs triggered after 2026-03-16 get IDs starting at 20260316000001. This is intentional — sequence was restarted at 20260316000000 via migration 20260316141659. Do not be confused by the jump in IDs. All child tables (story_results, run_output_chunks, token_usage, memory_proposals) also use BIGINT run_id.
> Context: Migration applied directly via psql on 2026-03-16. Registered in schema_migrations so runner won't re-apply on restart.
> Source: manual migration 2026-03-16

## 2026-03-16 [Bug Fix] pg-boss v10 has no teamSize — concurrent runs need Promise.allSettled in handler
> Rule: pg-boss v10 WorkOptions only has batchSize (how many jobs fetched per poll) — there is no teamSize or concurrency option. The handler receives Job[] and the original code used `for (const job of jobs)` which processed them sequentially. Fix: wrap handler body in `await Promise.allSettled(jobs.map(async (job) => { ... }))` so all fetched jobs spawn child processes concurrently. Applied to both handlePipelineRun and handlePipelineRetry in worker.ts.
> Context: Root cause of "two specs queued but only one running" bug. batchSize:3 fetched 3 jobs but the for-loop awaited each child process to completion before starting the next. With Promise.allSettled, all jobs in the batch run their execution-engine subprocesses in parallel. Lines 637 and 948 in worker.ts.
> Source: debugging session 2026-03-16

## 2026-03-16 [Bug Fix] BIGINT run IDs break ::int casts in WAL queries — must use ::bigint
> Rule: After widening pipeline_runs.id to BIGINT and restarting the sequence at 20260316000000, all SQL queries that extract run_id from JSON payloads via (payload->>'run_id')::int will overflow INT4 (max 2147483647). Changed 13 occurrences in pipeline.ts and 3 in worker.ts from ::int to ::bigint. This affects per-story SSE endpoint, WAL event lookups, story output queries, and pg-boss job lookups.
> Context: Latent bug introduced by the BIGINT migration. Old runs (#1-#133) have small IDs that fit in INT4. New runs (20260316000001+) are 14-digit numbers that overflow. The ::int cast would either error or silently return wrong results. Files: backend/src/routes/pipeline.ts, backend/src/worker.ts.
> Source: debugging session 2026-03-16

## 2026-03-16 [Bug Fix] pg driver returns BIGINT as string — Zod schemas need z.coerce.number()
> Rule: PostgreSQL's pg driver returns BIGINT columns as JavaScript strings (not numbers) because JS Number can't represent all BIGINT values. After the pipeline_runs.id BIGINT migration, RETURNING id returns "20260316000003" (string). The Zod schema PipelineRunJobPayload used z.number().int().positive() which rejected strings. Fix: changed all runId validators to z.coerce.number().int().positive() in pg-boss-schemas.ts. This coerces string→number safely since our IDs (~2*10^13) are well within Number.MAX_SAFE_INTEGER (~9*10^15).
> Context: This caused worker to reject ALL pipeline:run jobs with "Invalid input: expected number, received string" after the BIGINT migration. Affected all 4 schemas: PipelineRunJobPayload, PipelineRetryJobPayload, PipelineCancelJobPayload, PipelineMergeJobPayload. File: backend/src/lib/pg-boss-schemas.ts.
> Source: debugging session 2026-03-16

## 2026-03-16 [Decision] Use Promise.allSettled for pg-boss concurrent job handling instead of teamSize
> Rule: pg-boss v10 removed the teamSize option that controlled concurrent handler invocations. The handler receives Job[] (batch) and must parallelize internally. We chose Promise.allSettled(jobs.map(...)) over Promise.all because allSettled allows individual job failures without failing the entire batch — critical since pipeline runs can take 45+ minutes and one failure shouldn't abort sibling runs.
> Context:  
> Source: mcp-cli

## 2026-03-16 [Bug Fix] worker.ts missing worktree args to execution engine
> Rule: worker.ts extracted worktreePath, branchName, workspacePath from the pg-boss job payload but never forwarded them as --worktree-path, --branch-name, --workspace-path CLI args to execution-engine.ts. This caused config.worktreePath to always be null, silently preventing auto-merge from ever firing. Fixed by adding the three pushes after the startFromStoryId block (worker.ts ~line 722).
> Context: Discovered while investigating worktree accumulation ("worktree hell"). The design in pipeline.ts was already correct — deterministic feat/<slug> branch name, reuse-if-exists, merge gate on all-pass — but the wiring between worker and engine was missing. Auto-merge had never actually run in production.
> Source: debugging session 2026-03-16

## 2026-03-17 [Bug Fix] Orphan sweep kills all runs — worker_id never set on pipeline_runs
> Rule: Both handlePipelineRun and handlePipelineRetry must include `worker_id = $2` in the UPDATE pipeline_runs SET status = 'running' statement. Without it, pr.worker_id IS NULL and the orphan sweep matches every active run, killing them after ~5 minutes.
> Context: Fixed in backend/src/worker.ts. The orphan sweep query: `WHERE (pr.worker_id IS NULL OR (pr.worker_id != $1 AND wh.worker_id IS NULL))`. If worker_id is never written, the first condition always matches. Both handlePipelineRun (~line 666) and handlePipelineRetry (~line 980) needed the fix.
> Source: debugging session 2026-03-17

## 2026-03-17 [Gotcha] BIGINT from pg driver breaks Map.has() — activeProcesses lookup silently fails
> Rule: The `pg` driver returns PostgreSQL BIGINT columns as JavaScript strings, not numbers. `activeProcesses` is `Map<number, ChildProcess>`, so `activeProcesses.has("20260316000008")` always returns false even if the key `20260316000008` (number) exists. Always coerce with `Number(run.id)` when using pg-returned IDs as Map keys.
> Context: Fixed in sweepOrphanProcesses in backend/src/worker.ts — changed `const { id: runId } = run` to `const runId = Number(run.id)`. This was the second half of the orphan sweep bug: even if worker_id had been set, the safety-net `activeProcesses.has(runId)` check would have silently passed because the key type didn't match. Also affects pg-boss-schemas.ts which uses `z.coerce.number()` for the same reason.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] DLQ endpoint throws 500 instead of 404 — throw inside try/catch
> Rule: In the DLQ route handler (GET /api/pipeline/runs/:id/dlq), do NOT throw NotFoundError inside the try/catch block. The local catch handler returns a 500. Instead use `res.status(404).json({ error: 'Run not in DLQ' }); return;` directly.
> Context: Fixed in backend/src/routes/pipeline.ts ~line 5063. Pattern applies to any route that has a local try/catch that catches all errors — throwing AppError subclasses inside those blocks won't reach the global error-handler.ts middleware.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] MultiPaneTerminal wave grouping broken — wave_index missing from story_started WAL events
> Rule: executeStory() must accept a `waveIndex?: number` parameter and include it in the story_started WAL event payload as `wave_index`. Without it, MultiPaneTerminal groups all stories under wave 0 (its fallback default), so all mini-panes pile into one wave header regardless of actual wave assignment.
> Context: Fixed in backend/src/lib/execution-engine.ts. Added `waveIndex?: number` as last param to executeStory(). In runParallel(), pass `wave.index` when calling executeStory(). In the story_started emitWalEvent call, spread `...(waveIndex != null ? { wave_index: waveIndex } : {})` into the payload. MultiPaneTerminal.tsx reads `payload.wave_index` to determine the wave row.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] WAL SSE delay: seed usePipelineSSE from REST before live stream
> Rule: usePipelineSSE now fetches GET /api/pipeline/runs/:runId/wal-events on runId change to immediately seed historical events. Without this, /api/pipeline/stream starts replaying from lastSeenId=0 at LIMIT 50/tick — causing a 5+ minute delay before story_started events for the current run arrive. Live SSE events are deduplicated against the seed by event id.
> Context: src/hooks/usePipelineSSE.ts — useEffect added that fetches the REST endpoint and merges historical events into state. backend/src/routes/pipeline.ts — new GET /runs/:runId/wal-events endpoint: SELECT from wal_events WHERE (payload->>'run_id')::bigint = $1 ORDER BY id ASC. Root cause: useWalSSE connects without query params so backend replays ALL history at 50/tick.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] Semantic log parser: tool_use is inside assistant.message.content[], not top-level
> Rule: Claude stream-json (--output-format stream-json) NEVER emits standalone {"type":"tool_use",...} events. Tool calls are embedded inside the assistant event at message.content[] as {type:"tool_use", name, input} blocks. The parser must iterate assistant.message.content[] — not look for top-level type=tool_use. parseLine() and all parse functions return SemanticStep[] (not SemanticStep|null).
> Context: backend/src/lib/semantic-log-parser.ts — rewrote parseStreamJsonLine to extract tool_use from obj.message.content[] when obj.type === 'assistant'. Added parseClaudeToolBlock() helper. Supports multiple tool calls per assistant event (each emits one SemanticStep). backend/src/routes/pipeline.ts emitSemanticSteps() updated to iterate SemanticStep[] with for..of. Verified against actual log files: forge/specs/logs/BL-001_2026-03-16T2115.log shows {type:assistant,message:{content:[{type:tool_use,...}]}}.
> Source: debugging session 2026-03-17

## 2026-03-17 [Bug Fix] Single-story wave merge fails on .rorca/run-state.json conflict — outer+inner worktree both write it
> Rule: When a run uses an outer worktree (auto-merge) + inner wave worktrees, `mergeStoryWorktree` pre-commits dirty files in the outer worktree (including `.rorca/run-state.json`), creating a divergence from the inner story worktree which also wrote `run-state.json`. Git cannot auto-merge JSON, so `git merge --no-ff` fails. US-001 (or any single-story wave) is added to `failedIds`, cascade-blocking all downstream stories. Fixed by auto-resolving conflicts on runtime-only files (`--ours`) before falling through to hard failure.
> Context: Fixed in `mergeStoryWorktree` in backend/src/lib/execution-engine.ts. After merge fails, run `git diff --name-only --diff-filter=U` to get conflicted files. If ALL conflicts are on `.rorca/run-state.json`, `forge/specs/`, or `.rorca/memory/`, resolve with `git checkout --ours`, commit, and return true. The spec JSON `passes:true` is safe to lose here because `markStoryPassed()` at line 3134 force-writes it after every successful merge. Multi-story waves already had this logic via `mergeWave`/`autoResolveConflicts` — single-story waves were missing it. Root cause confirmed by querying `run_output_chunks` for run #20260316000009 and inspecting `git show 6bb8e91`.
> Source: debugging session 2026-03-17
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

## 2026-03-17 [Decision] Remove hardcoded rorca.md injection from execution-engine.ts
> Rule: rorca.md must NOT be hardcoded-injected in buildPrompt(). It was previously always injected via readWorkspaceFile(.claude/skills/rorca.md) regardless of suggestedSkills. Removed in this session. Now rorca goes through normal loadMatchedSkills() like every other skill — only injected if in a story's suggestedSkills array, and tracked in active_skills for the Skills tab.
> Context: The Skills tab showed no skills because rorca was injected outside the activeSkillNames tracking path. The skip guard (lines 430-431) that prevented rorca from going through loadMatchedSkills was also removed. Files changed: backend/src/lib/execution-engine.ts
> Source: session-2026-03-17

## 2026-03-17 [Decision] GTM worktree branches US-018/031/036 — do NOT merge, let billing-launch redo
> Rule: Three unmerged GTM story worktrees (feat/rorca-go-to-market-v1-US-018, US-031, US-036) contain unique code not in main (github-token-validator.ts, github-review-requests.test.ts, license.ts). However they diverged from main at c9709e75 — well before 63 subsequent merges. Merging would clobber current main (~18k line deletions). These are failed story worktrees from the GTM run. The billing-launch spec will re-implement this work cleanly against current main. Delete worktrees, do not merge.
> Context: Verified via git merge-base --is-ancestor check. 60 of 63 worktrees were confirmed merged. 7 were not. GTM branches were the 3 failed stories split into billing-launch spec.
> Source: session-2026-03-17

## 2026-03-17 [Gotcha] git worktree merged check — use merge-base --is-ancestor SHA main, NOT git branch --merged
> Rule: To check if a worktree is merged into main, use: git merge-base --is-ancestor &lt;SHA&gt; main. Do NOT use git branch --merged main with shell pattern matching — it has zsh escaping bugs and gave wrong results (reported all 63 as merged when 7 were not). The merge-base approach checks the actual commit SHA from git worktree list against main's ancestry chain.
> Context: First check used a bash loop with grep pattern on branch names — zsh reported bad pattern errors but still printed merged=YES for all entries. Python script with subprocess was used to correctly identify 7 unmerged worktrees.
> Source: session-2026-03-17

## 2026-03-18 [Gotcha] Worktree auto-merge fails silently when concurrent specs touch overlapping files
> Rule: When two specs run concurrently in separate worktrees and edit the same files, the auto-merge of the second worktree fails with real merge conflicts. The run is left stuck as 'running' and implementation files remain stranded in the feature branch. Recovery requires: (1) manual git merge with conflict resolution, (2) restoring dropped files via `git show <sha>:path > file`, (3) manually marking the run as failed in the DB.
> Context: Happened with rorca-mcp-recall-tool and rorca-mini-terminal-db-output running concurrently — both touched recall.ts, server.ts, and mcp/server.ts. Merge conflict markers were committed into the codebase (<<<<<<< Updated upstream), causing TypeScript compilation failures. The run record (e.g. #20260316000021) stayed stuck as status='running'. Post-merge, the restored files still had conflict markers that had to be manually resolved for each file.
> Source: debugging session 2026-03-17
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

## 2026-03-23 [Gotcha] Singleton guard blocks worker restart — stale heartbeat survives process kill
> Rule: When a worker process is killed mid-run (e.g. by SIGKILL), its heartbeat row in worker_heartbeat persists for up to 90 seconds. The singleton guard in the new worker sees the heartbeat and exits with code 0. This cascades via concurrently --kill-others to kill the frontend and server too. Fix: pkill -9 -f "src/worker" to kill ALL worker processes (not just by port), then wait and restart.
> Context: Hit this multiple times during restart cycles in this session. The stale heartbeat window is 90s. Simply killing port 3030 does not kill the worker (it uses no port). Must kill by process name pattern.
> Source: session-2026-03-23

## 2026-03-23 [Gotcha] concurrently --kill-others kills everything when worker exits with code 0
> Rule: npm run dev uses concurrently with both --kill-others and --kill-others-on-fail. --kill-others kills ALL processes when ANY process exits, regardless of exit code. So when the worker exits cleanly (code 0) after graceful shutdown, it cascades to kill the frontend and server. This is why restarting the full stack after a worker crash requires killing all three separately.
> Context: Caused confusion because the worker exiting with code 0 (graceful shutdown after an active run was killed) still brought down the entire dev stack. --kill-others-on-fail alone would only trigger on non-zero exits.
> Source: session-2026-03-23

## 2026-03-24 [Gotcha] worker-supervisor.ts stale processes send SIGTERM to new workers — kills the whole dev stack
> Rule: Stale `worker-supervisor.ts` node processes (started by previous npm run dev sessions) survive after the session ends and send SIGTERM to any new worker that starts, causing cascading --kill-others shutdown of the entire dev stack. Fix: before restarting, run `pkill -9 -f "worker-supervisor" && pkill -9 -f "rorca/backend"` to kill ALL rorca backend processes, not just by port. Port kills alone (lsof -ti:3030) miss the worker and supervisor since they don't bind to a port.
> Context: Hit repeatedly during restart cycles in this session. The worker would start successfully, process one cron tick, then immediately receive SIGTERM from a stale supervisor. The singleton guard (90s heartbeat) and the worker-supervisor both contribute to restart failures when not fully cleaning up.
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

## 2026-03-25 [Bug Fix] Express 4 async error handler was broken — routes hung on thrown errors
> Rule: The Layer.prototype.handle_request patch in async-handler.ts wrapped the original function, but Express 4's original does `try { fn(req, res, next) } catch` WITHOUT returning the Promise. So `result` was always undefined and `.catch(next)` never fired. Any async route that threw (ValidationError, NotFoundError) would hang forever. Fix: replace handle_request entirely, call `this.handle` directly, catch the returned Promise. Affected all routers (memory, agents, etc.) — not just one route.
> Context: Discovered when MCP slash commands timed out on /rorca:get_memories. Root cause: GET /api/memory without workspaceId threw ValidationError but response never sent. Commit 6c8d3c5.
> Source: debugging session 2026-03-25

## 2026-03-25 [Bug Fix] Worker crashes on non-fatal AppError unhandledRejections
> Rule: worker.ts process.on('unhandledRejection') triggered full shutdown on ANY rejection, including ValidationError/NotFoundError from Express routes (statusCode < 500). These are expected business-logic errors, not fatal. Fix: check if reason is an AppError with statusCode < 500 — if so, log warning and return without shutdown. Only truly unexpected rejections trigger shutdown.
> Context: When the async handler fix started properly propagating errors, some leaked as unhandledRejections and crashed the worker. Commit 6c8d3c5.
> Source: debugging session 2026-03-25

## 2026-03-25 [Pattern] MCP HTTP server health: 397 tools, <20ms, fully functional
> Rule: MCP HTTP transport at http://localhost:3030/mcp is healthy. 397 auto-generated tools from OpenAPI spec. Initialize handshake returns session ID via Mcp-Session-Id header. tools/list and tools/call both return in <20ms. Registered in Claude Code as `rorca: http://localhost:3030/mcp (HTTP)`. To diagnose MCP issues: test with curl (Accept: application/json, text/event-stream header required), check backend logs, test specific tool via tools/call.
> Context: Verified 2026-03-25. If slash commands time out, the issue is likely a specific route hanging (check async error handling) or a heavy LLM-calling tool, not the MCP transport itself.
> Source: debugging session 2026-03-25

## 2026-03-25 [Pattern] rorca-memory-consolidation spec completed — 7/7 stories passed, auto-merged
> Rule: Run 20260316000066: all 7 stories passed (US-001 through US-007), auto-merged to main as commit dff68e5. Branch feat/rorca-memory-consolidation. 48min runtime, parallelism 3, Claude CLI engine. Stories: US-001 recall semantic leak fix, US-002 generateMemoryMd(), US-003 pre-run MEMORY.md generation, US-004 buildPrompt MCP instruction, US-005 proposed_memories.json handler, US-006 post-story MEMORY.md rebuild, US-007 integration test.
> Context: Memory consolidation makes DB memories the source of truth and projects them to MEMORY.md before each story run. Agents write memories via MCP tool (claude) or proposed_memories.json file (opencode/codex).
> Source: run-20260316000066

## 2026-03-25 [Bug Fix] MCP rorca_recall_memories returned 53 instead of 176 — was reading from file, not DB
> Rule: The MCP tool `rorca_recall_memories` was hitting `GET /api/memory` (file-based MEMORY.md, 53 entries) instead of `GET /api/memory/items` (PostgreSQL `memories` table, 176 entries). The file-based ledger falls behind because synthesis runs and some write paths only write to the DB. Fix: switched MCP tool to use `/api/memory/items` endpoint which matches what the UI MemoryPanel uses.
> Context: User saw 176 in Rorca UI but MCP tool returned only 53. Root cause: dual memory stores (file + DB) out of sync. File at `.rorca/memory/MEMORY.md` had 53 `##` entries. DB `memories` table had 176 non-deleted rows. The `fetchAll: true` param was correctly passed as `limit=9999` but the file-based endpoint's `recent()` function returned all 53 entries (slice(-9999) = everything in the file). Fix applied in `backend/src/mcp/server.ts`.
> Source: session-2026-03-25

## 2026-03-25 [Gotcha] Dual memory stores (file MEMORY.md vs DB memories table) drift out of sync
> Rule: Rorca maintains two parallel memory stores: (1) file-based `.rorca/memory/MEMORY.md` read by `memory-ledger.ts`, and (2) PostgreSQL `memories` table. Manual writes and `POST /api/memory` write to both, but synthesis runs and some automated paths only write to the DB. This causes the file to fall behind. The UI MemoryPanel reads from DB (`/api/memory/items`), showing the true count. Any tool reading from the file will see fewer memories. Always prefer DB-backed endpoints for memory retrieval.
> Context: Discovered when UI showed 176 memories but MCP tool returned 53. The file had exactly 53 `## ` header entries. DB had 176 non-deleted rows. The memory consolidation spec (US-002/US-003) added `generateMemoryMd()` to project DB into MEMORY.md format, but this only runs pre-pipeline — not on every write.
> Source: session-2026-03-25

## 2026-03-25 [Gotcha] MCP stdio processes must be killed after server.ts code changes — they run old code
> Rule: When editing `backend/src/mcp/server.ts`, restarting the backend API server (port 3030) is NOT sufficient if Claude Code spawned MCP stdio processes. Those processes (`tsx server.ts` via node) load the old source and keep running until killed. After code changes: `ps aux | grep 'mcp/server.ts' | grep -v grep` to find them, then `kill -9` the PIDs. Claude Code will auto-restart them with the new code.
> Context: After restarting backend on :3030, MCP tool calls still returned stale 53-count results. Found 4 MCP stdio processes (2 pairs of tsx wrapper + node child) from before the edit. Killing them allowed Claude Code to respawn with the new code, returning the correct 176 count.
> Source: session-2026-03-25

## 2026-03-30 [Decision] OVH VPS-3 production deployment (2026-03-30)
> Rule: Rorca is deployed on OVH VPS-3: IP 141.94.33.224, hostname vps-59964a0f.vps.ovh.net, SSH user ubuntu, key ~/.ssh/rorca-testing. Spec: 8 vCPU, 24GB RAM, 200GB NVMe, Ubuntu 24.04, ~$12.75/mo. Stack: Coolify 4.0.0-beta.470 (port 8000) → Docker Compose at /home/ubuntu/rorca/docker-compose.yml → PostgreSQL 16 + pgvector + AGE + Rorca API (port 3030) + Worker.
> Context: Ordered manually via OVH UI (EU catalog). OVH world/legacy account td459-ovh cannot use the eu/ca/us API token pages — must order through the browser UI. VPS-3 only available on EU/CA catalogs, not US.
> Source:  

## 2026-03-30 [Gotcha] OVH world/legacy account cannot use EU/CA/US API token pages
> Rule: OVH account td459-ovh is on ovh.com/world (legacy). The API token pages at eu.api.ovh.com, ca.api.ovh.com, and us.ovhcloud.com use a different auth system and reject the correct password. Must order VPS manually via OVH UI. The automated order-vps.sh script only works with EU/CA/US accounts, not world/legacy.
> Context: VPS-3 ($12.75/mo, 8vCPU/24GB/200GB NVMe) exists on EU and CA catalogs but NOT on the US catalog (US tops at 32GB with different naming). Use eu.api.ovh.com with subsidiary IE for EU orders.
> Source:  

## 2026-03-30 [Bug Fix] Cross-schema restore: ENUM types missing in public schema block migrations
> Rule: When restoring a pg_dump from the rorca schema into a fresh instance, migration 061 (spec_attachments) fails with "type attachment_storage_type does not exist". The migration's IF NOT EXISTS check finds the ENUM in the rorca schema (from the dump) and skips CREATE TYPE, but then CREATE TABLE runs with search_path=public and the type isn't there. Fix before first container start: CREATE TYPE public.attachment_storage_type AS ENUM ('database', 's3');
> Context: Same issue can affect any ENUM created by migrations if the dump already contains it in the rorca schema. The migration runner sets search_path=public for migration sessions but restores to rorca,public after. The IF NOT EXISTS pg_type check is schema-unaware.
> Source:  

## 2026-03-30 [Bug Fix] Cross-schema restore: missing unique constraint on spec_search_index blocks migration 057
> Rule: After restoring a dump from the rorca schema, migration 057 fails on ON CONFLICT because public.spec_search_index is missing the uq_spec_search_slug_workspace unique constraint (it only exists in rorca schema from the dump). Fix: ALTER TABLE public.spec_search_index ADD CONSTRAINT uq_spec_search_slug_workspace UNIQUE (spec_slug, workspace_id);
> Context: The migration runner creates tables in public schema but the restored dump put the constraint in rorca schema. The migration assumes the constraint exists because the table exists (from a prior migration), but the constraint was never created in public.
> Source:  

## 2026-03-30 [Bug Fix] pg_dump path hardcoded to macOS Homebrew — breaks Docker Alpine runtime
> Rule: backup.ts had pg_dump binary path hardcoded to /usr/local/opt/postgresql@16/bin/pg_dump (macOS Homebrew). This fails silently in Docker Alpine. Fixed two ways: (1) changed fallback to just 'pg_dump' (uses PATH); (2) added postgresql16-client to the Alpine runtime stage in Dockerfile so pg_dump is available. Set PG_DUMP_BIN env var to override.
> Context: The daily backup scheduler was silently failing on the VPS with ENOENT on every startup. Fix committed in 2283c80.
> Source:  

## 2026-03-30 [Bug Fix] HSTS + CSP upgrade-insecure-requests break plain-HTTP deployments
> Rule: Helmet was sending Strict-Transport-Security (max-age=31536000) and upgrade-insecure-requests in CSP unconditionally. On plain HTTP deployments (no TLS), the browser honors HSTS and upgrades all requests to HTTPS → ERR_SSL_PROTOCOL_ERROR for all assets. Fixed by gating both on HTTPS_ENABLED=1 env var in server.ts. Set HTTPS_ENABLED=1 when serving behind SSL/TLS to re-enable both headers.
> Context: Fix committed in f942e90. The browser also caches HSTS for max-age seconds after first visit — users who visited before the fix may need to clear HSTS cache in chrome://net-internals/#hsts.
> Source:  

## 2026-03-30 [Bug Fix] @rollup/rollup-darwin-arm64 in package.json breaks linux/x64 Docker builds
> Rule: Having @rollup/rollup-darwin-arm64 as a direct dependency in package.json causes EBADPLATFORM errors in Docker linux/x64 builds. It's a Mac M-series specific binary that npm refuses to install on linux/x64. Fix: remove it from package.json dependencies entirely and regenerate package-lock.json. It gets pulled in automatically when needed on Mac.
> Context: Never add platform-specific optional packages (@rollup/rollup-darwin-*, @rollup/rollup-linux-*, etc.) as direct dependencies. They are optionalDependencies managed by rollup itself.
> Source:  

## 2026-03-30 [Bug Fix] TypeScript test files included in Docker tsc build cause type errors
> Rule: backend/tsconfig.json was not excluding test files, so tsc during Docker build compiled __tests__ and *.test.ts files which had type errors (e.g. semantic-log-parser.test.ts). Fixed by adding to tsconfig exclude: ["src/db/bun-sqlite-shim.ts", "src/**/__tests__/**", "src/**/*.test.ts"]
> Context: Test files are compiled by Jest separately with its own tsconfig. The production tsc build should never include them.
> Source:  

## 2026-03-30 [Gotcha] Cross-schema restore procedure for rorca schema → fresh PostgreSQL
> Rule: When restoring a dump where data is in the rorca schema into a fresh instance that runs migrations in the public schema: (1) restore with --data-only --disable-triggers after truncating all public tables; (2) before first app start, manually create ENUMs in public schema that migrations would create (attachment_storage_type); (3) manually add unique constraints to public tables that the dump has in rorca schema (uq_spec_search_slug_workspace on spec_search_index); (4) update workspace paths in DB to match new server paths.
> Context: The migration runner uses search_path=public for migration sessions. IF NOT EXISTS checks are schema-unaware and find objects in rorca schema, skipping creation, then fail when referencing the type/constraint in public schema. The app pool uses search_path=rorca,public so data access works fine after migrations pass.
> Source:  

## 2026-03-30 [Decision] OVH VPS deployment — Docker Compose setup
> Rule: Rorca is deployed on OVH VPS-3 (141.94.33.224) via Docker Compose. Two services: rorca (app) and db (postgres). Worker service added manually to docker-compose.yml on VPS. Both rorca and worker containers mount /home/ubuntu/rorca:/home/ubuntu/rorca so workspace paths resolve correctly.
> Context: VPS hostname: vps-59964a0f-vps-ovh-net. Coolify 4.0.0-beta.470 used for orchestration. ubuntu user needed `sudo usermod -aG docker ubuntu && newgrp docker` to run docker commands without sudo.
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

## 2026-04-06 [Bug Fix] Worker crashes on pg DatabaseError — now non-fatal
> Rule: The unhandledRejection handler in worker.ts was triggering full shutdown on ANY unhandled rejection, including PostgreSQL errors (missing column, constraint violation). A single bad INSERT (e.g. missing reasoning_tokens column) would close the DB pool and kill the entire server. Fixed by adding isPgError check: if reason instanceof Error and has a string 'code' field (pg error codes like 42703), log and continue — do NOT call shutdown().
> Context: Root cause of repeated "connection lost" disconnections on 2026-04-05. The reasoning_tokens column was missing from token_usage table. Every time a run completed, recordTokenUsage() threw a DatabaseError → unhandledRejection → shutdown() → pool closed → concurrently killed frontend too.
> Source:  

## 2026-04-06 [Bug Fix] Missing migrations cause server crash — apply manually when health shows pending
> Rule: When health endpoint reports pending migrations, apply them manually before running specs. Missing columns cause unhandledRejection crashes. Apply via: node -e with Pool, run SQL, INSERT INTO schema_migrations (version, filename) VALUES (...) ON CONFLICT DO NOTHING. DB is postgres://rorca:rorca@localhost:5433/rorca (port 5433). On 2026-04-05: 5 migrations were unapplied (20260403000000 through 20260404000001) causing reasoning_tokens crash.
> Context: Migration runner only applies on startup. If a spec run adds a migration file but the server was already running, the column won't exist until next restart + migration run. Check health.components.migrations.pending before triggering runs.
> Source:  

## 2026-04-06 [Bug Fix] Kill button 409 after backend restart — use direct SIGTERM via PID
> Rule: After backend restarts, activeProcesses map is wiped. Kill button returns 409 "Process is no longer running" even when the execution engine subprocess is still alive. Workaround: get PID from DB (SELECT pid FROM pipeline_runs WHERE id=...) or ps aux | grep execution-engine, then kill -SIGTERM <pid> directly. The execution engine process survives backend restarts — it is completely independent.
> Context: Execution engine is spawned by the worker as a child process. Worker restart does not kill the engine. Backend restart does not kill the engine. Only SIGTERM to the engine PID stops it.
> Source:  

## 2026-04-06 [Gotcha] Server crashes from laptop logout — npm run dev dies on SIGHUP
> Rule: npm run dev uses concurrently. When macOS sends SIGHUP (screen lock, auto-logout timer), concurrently exits, taking frontend + backend + worker all down. Caffeine prevents display sleep but NOT auto-logout. Check System Settings → Privacy & Security → Advanced → "Log out automatically after X minutes". Permanent fix: run with nohup or launchd plist so server survives logouts. Execution engine subprocesses survive (separate processes) but the worker/backend/frontend die.
> Context: Caused repeated unexplained disconnections on 2026-04-05. DB pool errors in logs were symptoms (pool closed during shutdown), not root cause.
> Source:  

## 2026-04-06 [Bug Fix] Ghost passes — stories marked passed with zero code written
> Rule: Stories can pass with only spec JSON + progress.txt changes (no feature code). Fixed by adding empty-commit guard in execution-engine.ts: after agent exits 0, run git status --porcelain, filter out metadata-only changes (forge/specs/, progress.txt, .rorca/, MEMORY.md), if no meaningful files changed treat as failure and retry. Confirmed ghost pass on ask-workspace-journal-entries US-003 — only metadata committed, no dispatcher code. US-006 re-implemented the missing dispatcher as a side effect of writing tests.
> Context: Ghost passes happened because agent would update spec JSON to mark story done but write no implementation code. The gate check (type errors, lint) passed because nothing new was added.
> Source:  

## 2026-04-06 [Bug Fix] normalizeOpenCodeModel — two-phase fix for Claude version separators
> Rule: Three model ID formats exist: Rorca internal (claude-opus-4-6, hyphens), OpenRouter catalog (anthropic/claude-opus-4.6, dots), OpenCode CLI triple (openrouter/anthropic/claude-opus-4.6). normalizeOpenCodeModel() must do Phase 1 first: fix Claude version hyphens→dots anywhere in the string via regex replace(/(claude-[a-z]+-\d+)-(\d+)/, '$1.$2') — this catches escalation-built IDs like openrouter/anthropic/claude-sonnet-4-6. Phase 2: add provider prefix if missing. Cascade table in complexity-scorer.ts must use dot format: anthropic/claude-sonnet-4.6 not anthropic/claude-sonnet-4-6.
> Context: Old code checked openrouter/ prefix BEFORE fixing dots, so escalation-built IDs passed through broken. Cascade table used hyphens but OpenRouter API requires dots.
> Source:  

## 2026-04-06 [Gotcha] Claude CLI model guard — clear non-Claude models when agent=claude
> Rule: When agent is claude, only pass --model flag for valid claude-* IDs (no slashes). If spec JSON has model: "z-ai/glm-5" or any OpenRouter model from a previous run, Claude CLI will fail. Guard in pipeline.ts: if resolvedAgentType === 'claude' and finalAgentModel doesn't match /^claude-/ or contains '/', set finalAgentModel = null. Guard in execution-engine.ts: only pass --model arg if /^claude-/.test(agentModel) && !agentModel.includes('/').
> Context: User switched from OpenRouter/GLM-5 to Claude CLI but spec JSON still had model: z-ai/glm-5. The model resolution chain passed it through to Claude CLI which rejected it.
> Source:  

## 2026-04-06 [Bug Fix] Model escalation/cascade caused surprise OpenRouter charges
> Rule: The complexity-scorer cascading system in execution-engine.ts silently replaced the user's chosen model (e.g. openrouter/qwen/qwen3.6-plus:free) with paid models (e.g. openrouter/anthropic/claude-opus-4.6) whenever a story scored as "opus" tier. extractProvider("openrouter/qwen/...") returned "openrouter", cascade table mapped openrouter.opus → "anthropic/claude-opus-4.6", final model became "openrouter/anthropic/claude-opus-4.6" — billed to OpenRouter account. Entire escalation/cascade system removed (2026-04-06): ~540 lines across 7 files. DEFAULT_CASCADES, resolveModelId(), getNextEscalationTier(), EscalationState, escalationStates map, story_escalated WAL events, and all escalation retry logic deleted.
> Context: Discovered by user checking OpenRouter logs during a run using free Qwen model. Multiple rogue opencode processes running --model openrouter/anthropic/claude-opus-4.6 had to be killed (PIDs 19489, 25636, 26271, 26270, 25635). They kept respawning until the worker was stopped and the code fixed. Files changed: execution-engine.ts, complexity-scorer.ts, config.ts, routes/specs.ts, routes/config.ts, ProviderSettingsTab.tsx, complexity-scorer.test.ts.
> Source:  

## 2026-04-06 [Decision] Model resolution: story.model → spec.model → RORCA_MODEL env only
> Rule: Pipeline execution model resolution chain (as of 2026-04-06): 1) story.model (per-story field in spec JSON userStories), 2) spec.model (top-level spec JSON field, passed as --model CLI flag), 3) RORCA_MODEL env var (system default only). No workspace model, no cascading, no L3 preferred_model direction layer lookup, no workflow_configs.model, no agent_config.agent_model. Never add hidden DB/env fallbacks back into pipeline model resolution — the only valid overrides are spec.model and story.model. If a spec has no model field, the agent runs with RORCA_MODEL env or its own default.
> Context: Previously the chain was: RORCA_MODEL → specJson.model → L3 preferred_model → null (and on top of that, cascading could override to a different tier model entirely). All hidden layers removed after escalation bug caused unexpected charges. See Bug Fix: "Model escalation/cascade caused surprise OpenRouter charges".
> Source:  

## 2026-04-06 [Bug Fix] OpenCode sub-terminal JSON blobs — MiniTerminalPane had no event filtering
> Rule: MiniTerminalPane decoded base64 log chunks and passed them raw to the ANSI converter with zero JSON filtering. step_finish events (token counters + git snapshots) and tool_result events (full file contents as escaped JSON) rendered as walls of text. Fixed by adding line-by-line JSON parsing in the chunk handler — suppress step_finish, step_start, tool_result, system, user events before appending to pendingTextRef. The log file still receives all raw bytes (for debugging); only the display path is filtered.
> Context: The main terminal fix (spawnOpenCode process.stdout filtering) did NOT fix sub-terminals because sub-terminals read from the log file via the /log SSE endpoint, not from process.stdout. Two separate code paths required two separate fixes.
> Source:  

## 2026-04-06 [Bug Fix] OpenCode main terminal JSON blobs — spawnOpenCode dumped all stdout raw
> Rule: spawnOpenCode in execution-engine.ts did process.stdout.write(chunk) on every byte of OpenCode output without any filtering. step_finish events (contain token counters + git snapshot hashes) and tool_result events (contain full file contents as escaped JSON strings) rendered as giant JSON blobs in the Raw terminal view. Fixed by buffering stdout line-by-line and skipping step_finish, step_start, tool_result event types before forwarding to process.stdout. logStream.write(chunk) still receives everything for the raw log file.
> Context: The previous fix for Claude CLI stderr (skipping valid JSON diagnostic lines) only covered Claude's path. OpenCode stdout was an entirely different code path that had never been filtered.
> Source:  

## 2026-04-06 [Gotcha] Model routing UI still present after backend removal — must clean both sides
> Rule: After removing the model escalation/cascading system from the backend (2026-04-06), the frontend still had: ModelRoutingSection + ThresholdSlider in ProviderSettingsTab (router mode picker, complexity thresholds, task cascade inputs, token budget), escalation log + savings banner in FinOpsTab, story_escalated in UnifiedActivitySection event filter, capMismatchMode + isBlocked blocking behavior in TriggerPopover. Backend removal is not enough — always audit the frontend for corresponding UI.
> Context: The UI was removed in the same session. Files cleaned: ProviderSettingsTab.tsx, FinOpsTab.tsx, UnifiedActivitySection.tsx, TriggerPopover.tsx.
> Source:  

## 2026-04-06 [Bug Fix] OpenRouter billing leak — anthropic/ prefix caused auto-switch to OpenCode
> Rule: OPENCODE_PROVIDER_PREFIXES in pipeline.ts included 'anthropic/' which caused Claude models (anthropic/claude-sonnet-4-6, anthropic/claude-opus-4-6) to auto-switch to OpenCode → OpenRouter, billing API credits instead of using the Claude CLI subscription. Fix: removed 'anthropic/' from the prefix list and added !resolvedAgentModel.startsWith('anthropic/claude-') to the modelIsNonClaude check. When a user selects Claude CLI + Claude model, it stays on Claude CLI (subscription). When they explicitly select OpenCode + any model, it routes through OpenRouter (API key).
> Context:  
> Source:  

## 2026-04-06 [Bug Fix] ModelBadge story override — missing Content-Type header caused 400
> Rule: apiFetch() does NOT auto-set Content-Type: application/json. Any PUT/POST/PATCH call with JSON.stringify(body) MUST include headers: { 'Content-Type': 'application/json' } or Express won't parse the body and required fields like workspaceId will be undefined → 400 error. Also replaced the HTML select element (size attribute listbox) with clickable button list because select onChange doesn't fire when re-selecting the already-selected value.
> Context:  
> Source:  

## 2026-04-06 [Bug Fix] Spec JSON agentOverride leaked — rorca-reasoning-engine had agentOverride: opencode with Claude model
> Rule: Spec JSON files can have agentOverride field set by the SpecModelControlBar. If agentOverride is 'opencode' but the model is a Claude model (claude-sonnet-4-6), the run routes through OpenCode → OpenRouter → API credits instead of Claude CLI subscription. The auto-detection fix in pipeline.ts only prevents auto-switching, NOT explicit overrides. Always check spec JSON for stale agentOverride values before running specs with Claude models.
> Context:  
> Source:  
## 2026-04-06 [Gotcha] Disk full from orphaned worktree node_modules
> Rule: Worktrees created by wave-parallel runs each get their own node_modules (500MB+ frontend, 275MB+ backend). With 70+ prunable worktrees, this consumed 27GB+. Symptoms: ENOSPC errors, backend crashes, pg-boss can't write jobs. Fix: periodically run 'git worktree prune' and delete node_modules from inactive worktrees. Active worktrees can be identified with 'ps aux | grep execution-engine'.
> Context:  
> Source:  

## 2026-04-06 [Bug Fix] Pending migrations not tracked — manual psql apply skips schema_migrations row
> Rule: If migrations are applied manually via psql (outside pg-index.ts runner), the schema_migrations tracking row is never inserted. Backend reports status: degraded with N pending migrations. Fix: apply the SQL file via psql, then INSERT INTO rorca.schema_migrations (version, filename) VALUES (...) manually. Always apply migrations through the runner to avoid this.
> Context: Fixed 4 pending migrations (20260403170000–20260404000001) that were applied but untracked. Backend went from degraded to ok.
> Source:  

## 2026-04-07 [Bug Fix] Codex CLI invocation changed — --approval-mode no longer valid
> Rule: Codex CLI no longer accepts `--approval-mode auto-edit` as a top-level flag. Correct non-interactive invocation is `codex exec --dangerously-bypass-approvals-and-sandbox`. Model passed via `-m <model>`. Prompt via stdin (codex exec reads stdin when no prompt arg given).
> Context: execution-engine.ts spawnCodex() was failing with "unexpected argument '--approval-mode' found". Fixed by switching to `codex exec --dangerously-bypass-approvals-and-sandbox` subcommand pattern.
> Source:  

## 2026-04-07 [Bug Fix] API server must be restarted for new routes to register — tsx does not hot-reload
> Rule: The Express API server (src/server.ts) runs under plain `tsx` — NOT `tsx watch`. It does NOT auto-restart on file changes. New routes added to route files (e.g. config.ts) will return 404 until the server process is killed and restarted. Kill with `lsof -ti:3030 | xargs kill -9` then restart. The worker (src/worker.ts) has the same behavior.
> Context: Added GET /api/config/codex-models route but got 404 — server PID 42585 had been running since Monday 2AM and had not picked up the new route. Required manual kill + restart.
> Source:  

## 2026-04-07 [Bug Fix] OpenCode JSON blobs in terminals — two separate data paths require two fixes
> Rule: OpenCode `--format json` outputs newline-delimited JSON events. Two completely separate paths feed terminal output: (1) Main terminal: execution-engine.ts spawnOpenCode() writes to process.stdout → run_output_chunks → SSE. Fix: filter step_finish/step_start/tool_result before writing to process.stdout (logStream still gets raw). (2) Wave parallel sub-terminals: MiniTerminalPane.tsx reads from /stories/:storyId/log SSE. Fix: add line-by-line JSON filtering in the SSE chunk event handler. Fixing only one path leaves the other showing blobs.
> Context: Session 2026-04-06/07. Also filter stderr — Claude CLI writes diagnostic JSON metrics to stderr; skip valid JSON lines, only forward genuine errors.
> Source:  

## 2026-04-07 [Decision] Model escalation/cascade system fully removed — simplified to story→spec→env resolution
> Rule: The entire model escalation/cascading system (ModelRoutingSection, ThresholdSlider, RouterMode, TaskType, OrchestrationState, capMismatchMode, story_escalated WAL events, EscalationEntry in FinOps) was removed in sessions 2026-04-06/07. Canonical model resolution is now: story.model → spec.model → RORCA_MODEL env. No DB cascades, no complexity scorer tiers, no automatic model swapping. Reason: caused surprise OpenRouter charges (Qwen free → Claude Opus swap without user awareness).
> Context: UI remnants removed from: ProviderSettingsTab.tsx (ModelRoutingSection + ThresholdSlider ~370 lines), FinOpsTab.tsx (EscalationEntry, savings banner, escalation log), UnifiedActivitySection.tsx (story_escalated event), TriggerPopover.tsx (capMismatchMode, isBlocked logic).
> Source:  

## 2026-04-14 [Bug Fix] Specs with all passes=true blocked re-runs — forceRerun feature added
> Rule: When all stories in a spec had passes=true, the pipeline skipped them all and no new run could be triggered. This was a major blocker — user couldn't re-run completed specs. Fix: added forceRerun param to POST /api/pipeline/trigger (pipeline.ts PipelineTriggerSchema) which resets all passes=true to false in the spec JSON before executing. SpecDetailSlideOver.tsx shows a "Re-run from scratch" button (RotateCcw icon) when allPassed=true. Committed as fc773cc on main.
> Context:  
> Source:  

## 2026-04-14 [Bug Fix] CI TypeScript errors that pass locally but fail in GitHub Actions
> Rule: Three classes of TS errors slip through local dev but fail CI: (1) unused declared components left in JSX after removing their usage, (2) wrong re-export names in index.ts (e.g. `export type { Bank }` when the actual export is `BankInstitution`), (3) test mock type annotations too narrow (missing optional fields). CI runs `npx tsc --noEmit` from scratch with no incremental cache — local TS Language Server uses cached .tsbuildinfo and misses these. Always run `npx tsc --noEmit` from repo root before pushing.
> Context: workspace CI gate failed after merging feat/qa-bank-sync-continuous-e2e. Three errors: ProviderBadge unused, export type { Bank } nonexistent, ConnectionStatusCard test mock missing cooldown_active field. Fixed in commit 10808dc5.
> Source:  

## 2026-04-14 [Decision] Execution mode UI: segmented control instead of dual toggles
> Rule: Sequential vs Wave Parallel is a mode choice, not an on/off toggle. Use a segmented control (same pattern as Effort Low/Medium/High) — both options always visible, active = filled teal, inactive = outlined. Wave Parallel pill is disabled with "no parallel stories" label when spec has no independent stories. Wave breakdown (Wave 0/1/2 + story IDs) renders below the control when Wave Parallel is selected. Story count line renders below when Sequential is selected.
> Context: Original UI had two separate toggles (Wave Parallel + Sequential) which was confusing — looked like Sequential was "off" with no indication Wave Parallel existed. Fixed 2026-04-14 in TriggerPopover.tsx.
> Source:  
## 2026-04-14 [Decision] REASONING section removed from TriggerPopover — duplicate of Thinking
> Rule: The collapsible REASONING section in TriggerPopover (with "Enable reasoning for this run" checkbox + effort buttons) was redundant with the THINKING section (Effort segmented control + Extended thinking toggle). Removed REASONING entirely. ThinkingControls.tsx is the single place for thinking/reasoning controls. Also removed "Haiku only — not available" label from ThinkingControls header — not useful to show a disabled state label for a model tier users aren't on.
> Context: User flagged redundancy 2026-04-14. Both sections controlled the same underlying capability with different UI.
> Source:  

## 2026-04-14 [Bug Fix] Vite stale module cache causes SyntaxError on case-variant filenames
> Rule: On macOS (case-insensitive filesystem), Vite can cache a module under two different case variants (e.g. `ArAgingWidget.tsx` vs `ARAgingWidget.tsx`) from a previous HMR cycle. This produces `SyntaxError: Module does not provide export named X` even though the code and imports are correct. Fix: restart the Vite dev server (`lsof -ti:5173 | xargs kill -9 && npm run dev`). No code changes needed.
> Context: Happened on workspace localhost:5173 after merging bank-sync branch. ArAgingWidget vs ARAgingWidget casing conflict in Vite module cache. 2026-04-14.
> Source:  

## 2026-04-14 [Bug Fix] MCP auto-generated tools 30s timeout kills LLM-powered endpoints silently
> Rule: Auto-generated MCP HTTP tools in `backend/src/lib/mcp-http.ts` have a 30-second default timeout. Only paths in the `SLOW_PATHS` array get 5 minutes. LLM-powered endpoints like `/enrich`, `/match-skills`, `/suggest-skills`, `/add-stories`, `/knowledge-graph` were missing from this list — MCP calls timed out silently while the backend kept processing and completed successfully. The MCP client (Claude Code) reported "Tool timed out" but the operation actually finished with full results (e.g. 21 CAG hits). Fix: add all LLM-powered path fragments to SLOW_PATHS. When adding new LLM-powered API routes, remember to add them to SLOW_PATHS or they'll timeout at 30s via MCP.
> Context: Discovered 2026-04-14 when `mcp__rorca__rorca_specs_by_id_enrich` timed out but UI "Enrich with Context" button succeeded — both call the same backend endpoint, but MCP had 30s timeout vs UI's longer HTTP timeout. Fixed in mcp-http.ts line 272.
> Source:  

## 2026-04-14 [Gotcha] Two MCP tool paths for the same API: hand-written (stdio) vs auto-generated (HTTP)
> Rule: Rorca has TWO sets of MCP tools: (1) hand-written tools in `backend/src/mcp/server.ts` (24 tools, stdio transport, use `timedFetch` with 5-min default) and (2) auto-generated tools in `backend/src/lib/mcp-http.ts` (397+ tools from OpenAPI spec, HTTP transport on /mcp, use 30s default timeout). The auto-generated tools are named `rorca_{operation}` (e.g. `rorca_specs_by_id_enrich`) while hand-written ones use shorter names (e.g. `rorca_enrich_spec`). When debugging MCP issues, check WHICH tool was called — they have different timeouts and error handling.
> Context: Root cause of enrich timeout discrepancy between MCP and UI, 2026-04-14.
> Source:  

## 2026-04-14 [Bug Fix] spawnClaude: prompt must be piped via stdin, not positional arg
> Rule: execution-engine.ts spawnClaude() was passing the prompt as a positional CLI argument to `claude --print`. Large prompts (>~32KB, typical for context-routed stories) silently fail — claude exits 0 with zero output and empty log files. Stories appear to "pass" instantly with 0 tokens. Fix: pipe prompt via stdin (stdio: ['pipe', 'pipe', 'pipe'], child.stdin.write(prompt), child.stdin.end()). Never pass prompts as positional args to claude CLI.
> Context: Root cause of qa-accrual-missing-flows stories passing instantly with 0 tokens across runs 174-178. Discovered 2026-04-14. The 49KB prompt (8511 tokens of routed context + story + direction stack) exceeded the silent truncation threshold for CLI positional args.
> Source:  
## 2026-04-14 [Bug Fix] spawnClaude --mcp-config: HTTP URLs cause silent exit 0
> Rule: Claude CLI --mcp-config only supports stdio command/args format ({"command":"node","args":[...]}). Passing HTTP URLs ({"type":"http","url":"http://localhost:4041/mcp"}) causes claude to silently exit 0 with zero output. Fix: write stdio command/args format for known MCP servers (chrome-devtools, playwright). OpenCode uses {"type":"remote","url":...} in opencode.json (native HTTP support). Codex uses `codex mcp add --url` (native HTTP support). Only Claude CLI has this limitation.
> Context: The chrome-devtools-mcp binary path is stored in _chromeMcpCmd/_chromeMcpArgs module-level vars, resolved once by ensureChromeDevToolsMcpServer(), reused by spawnClaude() for writing stdio MCP configs.
> Source:  

## 2026-04-14 [Bug Fix] MCP server health-check: ensure functions must verify liveness every call
> Rule: ensureChromeDevToolsMcpServer() and ensurePlaywrightMcpServer() cached _chromeMcpReady/_playwrightMcpReady as true after first successful start, but never re-verified. If the MCP server process died between stories, subsequent stories got a stale URL pointing to a dead server. Fix: on every call when _ready=true, probe the HTTP endpoint. If probe fails, reset state and restart the server.
> Context:  
> Source:  

## 2026-04-14 [Gotcha] Journey mode bypass: "no code changes" gate must skip for mode=journey
> Rule: execution-engine.ts has a "no code changes" gate (git status --porcelain check) that treats exit-0-with-no-file-edits as failure. Journey mode specs browse the live app via Chrome DevTools MCP — they exit 0 with no file modifications by design. The gate must check `mode === 'journey'` and skip entirely.
> Context:  
> Source:  
## 2026-04-14 [Gotcha] ChromeMCP per-story log spam removed
> Rule: "Chrome DevTools tools active for story X" printed for every story in journey specs, cluttering the terminal. Removed — only the "unavailable" warning prints when Chrome is not running. One-time "Chrome ready" and "Proxy ready" on init are kept.
> Context:  
> Source:  
## 2026-04-15 [Pattern] Terminal session route preflights OpenCode availability
> Rule: Before creating an interactive terminal PTY session, check `detectOpenCode()` in `backend/src/routes/terminal.ts` and return a 422 `OPENCODE_NOT_INSTALLED` error with an install hint when the binary is missing.
> Context: This lets the frontend render a clear empty state instead of attempting terminal setup and showing a broken terminal surface.
> Source: OCT-015

## 2026-04-15 [Pattern] OpenCode PTY direction injection mirrors Codex marker restoration
> Rule: For OpenCode PTY sessions, write synthesized direction context to `.opencode/AGENTS.md` between Rorca markers and restore/delete it via an idempotent per-session cleanup hook on both explicit delete and PTY exit.
> Context: This keeps terminal sessions context-aware without permanently mutating workspace files or clobbering user-owned OpenCode config.
> Source: OCT-038
## 2026-04-15 [Pattern] Terminal PTY sessions support per-session model override
> Rule: When spawning OpenCode terminal sessions, accept an optional validated `model` in POST /api/terminal/sessions and inject it into that PTY env only via `OPENCODE_MODEL`/`RORCA_MODEL`; never mutate global provider settings.
> Context: Lets users experiment per terminal session without affecting pipeline runs or workspace-wide defaults.
> Source: OCT-037

## 2026-04-15 [Pattern] Terminal sessions support env-scoped model override
> Rule: Pass an optional `model` to `POST /api/terminal/sessions` and inject it only into the spawned PTY env (`OPENCODE_MODEL` and session-local `RORCA_MODEL`) without mutating workspace or global settings.
> Context: Lets terminal sessions choose a different OpenCode model than pipeline runs or provider settings while preserving the canonical global model resolution chain.
> Source: OCT-037

## 2026-04-15 [Pattern] Terminal install polling uses refs for timers
> Rule: When polling for external CLI installation in React, store interval IDs and elapsed counters in useRef, clear them on success, workspace changes, and unmount, and sequence any success flash before retrying the original action.
> Context: Avoids stale closure bugs and prevents orphaned polling loops in TerminalPanel's OpenCode auto-retry flow.
> Source: OCT-040

## 2026-04-16 [Bug Fix] Terminal WebSocket output dropped — session.outputSequence vs nextSequence
> Rule: server.ts used `session.outputSequence` but PtySession interface defines `nextSequence`. undefined += 1 → NaN → JSON null → frontend sequence check (null <= 0 === true) silently dropped every WebSocket output message. Keystrokes were sent to PTY but echoes never reached xterm. Fix: use session.nextSequence in server.ts WebSocket onData handler.
> Context: Root cause of "typing works only after refresh" bug. Scrollback REST endpoint worked (showed text on refresh) but live WebSocket output was completely silent.
> Source: OCT-001

## 2026-04-16 [Bug Fix] Terminal wsToken one-time-use breaks React StrictMode
> Rule: WebSocket connection tokens were deleted on first validation (one-time use). React StrictMode double-mounts effects: first mount consumes token, cleanup closes connection, second mount rejected. Fix: keep token in map until TTL expiry (60s) instead of deleting on first use. File: backend/src/routes/terminal.ts validateWsToken().
> Context: Combined with the outputSequence bug, this was a secondary cause of no live output. Even after fixing sequences, StrictMode would still kill the WebSocket on second mount.
> Source: OCT-021

## 2026-04-16 [Bug Fix] Terminal workspaces.domain vs domains column mismatch
> Rule: terminal-context-injector.ts queried `SELECT domain FROM workspaces` but the column is `domains` (JSONB array, not singular text). Fix: query `domains`, JSON.parse, extract first element for L2 direction layer lookup.
> Context:  
> Source: OCT-001

## 2026-04-16 [Bug Fix] Terminal route ordering — /sessions/history shadowed by /sessions/:sessionId
> Rule: Express matched GET /sessions/history as sessionId="history" because the :sessionId route was registered before the /history route. Fix: move /sessions/history routes before /sessions/:sessionId in terminal.ts.
> Context:  
> Source: OCT-001

## 2026-04-16 [Bug Fix] Terminal node-pty spawn-helper missing execute permission
> Rule: node-pty prebuilds/darwin-arm64/spawn-helper installed without +x permission → posix_spawnp failed, crashing the backend. Fix: chmod +x spawn-helper. npm rebuild node-pty also fixes this. Check after every npm install.
> Context:  
> Source: OCT-001

## 2026-04-16 [Bug Fix] Terminal infinite re-render loops — useTerminalSession unstable returns
> Rule: useTerminalSession hook returned plain functions (sendInput, sendResize, onData, etc.) — new refs every render. These were in TerminalPane's main useEffect deps → terminal torn down and recreated every render. Fix: wrap all returned functions in useCallback. Also: TerminalPanel callback props (onExit, onInput, onTitleChange, onBell) were inline arrows — captured via refs instead.
> Context: Multiple layers of unstable references: useTerminalSession functions, TerminalPanel inline arrow props, WorkspaceContext/ToastContext unmemoized values, loadModelPickerData activeSessionId dep. All fixed with useCallback + refs.
> Source: OCT-001

## 2026-04-16 [Bug Fix] WorkspaceContext and ToastContext provider values not memoized
> Rule: Both contexts created inline value objects without useMemo, causing all consumers to re-render on every provider render. WorkspaceContext.setWorkspaceId was also a plain function (not useCallback). Fix: useMemo on both context values, useCallback on setWorkspaceId and addWorkspace.
> Context: This was a pre-existing issue affecting all context consumers, not just the terminal. The terminal exposed it because of the many useEffect hooks with context-derived deps.
> Source: OCT-001

## 2026-04-16 [Decision] Terminal drawer hidden on /terminal route to prevent session mirroring
> Rule: TerminalDrawer returns null when location.pathname === '/terminal'. Both the panel and drawer share the same localStorage-persisted sessions, so rendering both simultaneously causes mirrored PTY output. The drawer (with handle bar) is available on all other routes.
> Context:  
> Source: OCT-001

## 2026-04-16 [Decision] Terminal drawer spans full viewport width (no sidebar offset)
> Rule: TerminalDrawer getSidebarOffset() returns '0px' for all breakpoints. Previously offset by sidebar width on desktop, leaving a gap. User requested it align with the content grid left edge.
> Context:  
> Source: OCT-001

## 2026-04-16 [Bug Fix] TerminalPanel always-mounted to preserve PTY sessions across navigation
> Rule: TerminalPanel is now always-mounted in AppLayout (outside the Outlet) to keep PTY sessions alive when navigating to Specs/Runs/etc. Visibility is CSS-only: `className={location.pathname === '/terminal' ? 'contents' : 'hidden'}`. The ActivePanel case 'terminal' returns null. Auto-session creation is gated on isActiveRouteRef.current so it only fires when actually on /terminal — prevents 422 errors when browsing other panels with a workspace that has no vault key.
> Context: Before this fix, navigating away from /terminal unmounted TerminalPanel entirely (React Router route unmount), destroying all in-memory PTY session state. On return, it would remount fresh and try to auto-create a new session.
> Source:  

## 2026-04-16 [Bug Fix] qa-accrual-missing-flows worktree spec was stale (10 stories vs 17 in main)
> Rule: The worktree at workspace-feat-qa-accrual-missing-flows had an old 10-story spec (AMF-001–010, all passes=False). The main repo had 17 stories (AMF-000–016) with 12 already passing. Engine read the spec from workspacePath (main), but the run's previously_passed skip logic also read from main — however the WAL had no record of AMF-013/014/015 because the worktree spec didn't contain them, causing state_reconciliation failure. Fixed by copying main spec into worktree and committing. Run 192 still failed due to stale worker (Tuesday night PID 17483 running alongside fresh concurrently worker from same day).
> Context: Remaining failing stories: AMF-002, AMF-003, AMF-013, AMF-014, AMF-015. Pattern: worktree spec diverges from main when stories are added to main after the worktree was created. Always sync worktree spec before re-running.
> Source:  

## 2026-04-16 [Gotcha] Multiple stale server/worker processes cause silent job failures
> Rule: When npm run dev is started multiple times (e.g. once manually, once via mprocs), you get duplicate server and worker processes on the same ports. The stale worker (old PID, old code) can claim pg-boss jobs before the fresh worker does. Runs appear to start (status=running) but the engine never spawns (pid=NULL, last_heartbeat=NULL) and state reconciliation marks them failed in ~30s. Always kill ALL node processes before starting: `lsof -ti:3030 | xargs kill -9; lsof -ti:5210 | xargs kill -9; ps aux | grep -E "(server|worker)\.ts" | grep -v grep | awk '{print $2}' | xargs kill -9`
> Context: Observed 2026-04-16: worker PID 17483 from Tuesday night still running alongside fresh worker from 1:17PM same day. The Tuesday worker had worker_id f5f831e1 in heartbeat table and was claiming jobs with stale code.
> Source:  

## 2026-04-16 [Decision] StoryCard Linear-style status treatment — dot icon + dimming, no colored ID or DONE badge
> Rule: Story cards now follow Linear's UX pattern: (1) story ID is always muted gray — never colored by status; (2) status dot left of title: Circle=not done, CheckCircle2=done (muted), MinusCircle=deferred; (3) done rows dim to opacity-50 + border-border/50 + title goes text-muted; (4) DONE text badge removed entirely. Done stories recede visually, unfinished stories demand attention.
> Context: Previous design: teal ID = not done, green DONE badge = done. This highlighted completed work and buried unfinished work — inverse of useful signal. 2026-04-16.
> Source:  

## 2026-04-16 [Bug Fix] Vite worktree process persists on port 5173 after killing main processes
> Rule: When a spec run creates a worktree (e.g. workspace-feat-qa-accrual-missing-flows), that worktree's Vite dev server may still be running independently. Killing the main workspace processes does not kill the worktree's Vite. Result: new mprocs Vite bumps to 5174, old browser tab on 5173 still works. Find with: `lsof -ti:5173 | xargs ps -p` then kill the worktree Vite PID separately.
> Context: Observed 2026-04-16: PID 31425 was node running vite from workspace-feat-qa-accrual-missing-flows/node_modules/.bin/vite --port 5173.
> Source:  

## 2026-04-21 [Bug Fix] Worker spec completion check gated behind exit code
> Rule: The worker's post-run merge/PR logic was gated on status === 'done', meaning if the engine exited non-zero (timeout, signal, crash) but all stories actually passed in the spec JSON, the merge strategy never fired. Fixed by reading spec JSON regardless of exit code. If allSpecStoriesPassed is true but status is 'failed', the run is promoted to 'done' in the DB and merge strategy proceeds. Ground truth is the spec file, not the exit code.
> Context: Discovered via qa-reports-basis-toggle-journeys spec on workspace — 24/24 stories passed across 3 incremental runs on the same worktree, but all 3 runs were marked 'failed' in DB. Branch was never merged or PR'd because the gate blocked it. Commit b2c5388.
> Source:  

## 2026-04-21 [Decision] Merge strategy is spec-level declarative, not path-based
> Rule: The merge strategy is a declarative property on the spec JSON (mergeStrategy field), workspace config, or per-run override. It is NOT based on analyzing file paths, migration detection, or risk scoring. Rorca remains a generic agnostic orchestration platform — it doesn't know or care what a "migration" is. The user or spec author declares the intent explicitly.
> Context: User explicitly rejected path-based risk detection as domain leakage. The right architecture is: spec.mergeStrategy > workspace pipeline_config.mergeStrategy > 'direct'. No magic, no guessing.
> Source:  

## 2026-04-21 [Gotcha] Coolify auto-deploy via GitHub webhook
> Rule: Rorca is deployed on Workspace VPS (141.94.33.224) via Coolify. GitHub webhook (Hook ID 606945335) fires on push to main, hits http://100.91.193.49:9876/deploy (Tailscale-only), runs /home/ubuntu/rorca-deploy.sh which does git pull + rsync + docker compose up --build. Service UUID: xbsf06ai9pfut49urigz0ezo. Rorca containers are accessible ONLY behind Tailscale (ports bound to 100.91.193.49). Deploy takes ~90 seconds.
> Context: docker-compose.override.yml binds rorca port to Tailscale IP only. Webhook listener is a Python systemd service running on ubuntu user. Secret: rorca-deploy-secret-2026.
> Source:  

## 2026-04-22 [Decision] Supabase CLI and app migrations stay separate
> Rule: Use `supabase db reset` only for `supabase/migrations/`; keep Rorca app schema migrations in `backend/src/db/pg-migrations/` under the `pg-index.ts` runner.
> Context: Avoids accidentally assuming Supabase CLI manages the application schema or that resetting Supabase will apply backend migrations.
> Source: MU-027

## 2026-04-22 [Pattern] Lazy Supabase backend clients keep local boot resilient
> Rule: For optional third-party backends in Rorca, log a single warning at import time and defer client construction until first use so the backend can still boot without those env vars.
> Context: Rorca runs primarily as a local tool with globally bypassed auth, so missing Supabase configuration must not block server startup.
> Source: MU-001

## 2026-04-22 [Gotcha] Supabase auth foreign keys must be conditional in local migrations
> Rule: When adding foreign keys to `auth.users(id)` in PostgreSQL migrations, guard them with an `IF EXISTS` check on the `auth` schema so local non-Supabase databases can still run migrations cleanly.
> Context: Rorca supports local PostgreSQL setups that may not have the Supabase-managed `auth` schema. Conditional FK creation keeps auth-linking migrations non-destructive and idempotent while preserving referential integrity on Supabase-backed deployments.
> Source: MU-003

## 2026-04-22 [Bug Fix] Supabase auth fallback users must use UUID ids
> Rule: When switching req.user.id to Supabase auth.users UUIDs, synthetic and fallback users must also use valid UUID-format ids and populate supabaseId to keep downstream consumers type-safe.
> Context: Rate limiting, route helpers, and auth-bypassed local mode all assume req.user.id is a stable string; mixing legacy non-UUID ids breaks consistency once Supabase-backed auth is introduced.
> Source: MU-002

## 2026-04-22 [Decision] CSRF uses bootstrap endpoint with HttpOnly double-submit cookie
> Rule: When auth is globally bypassed, issue CSRF tokens from `/api/auth/csrf-token`, store the cookie as HttpOnly, and have the frontend cache the returned token and retry one mutating request on `CSRF_INVALID`.
> Context: This preserves CSRF protection without server-side sessions and avoids reading the token from `document.cookie`.
> Source: MU-019

## 2026-04-22 [Decision] Legacy backend auth removed after Supabase cutover
> Rule: After Supabase auth middleware owns session flows, delete legacy auth routes and password-hash storage together, and keep only /api/auth/me plus token-encryption helpers needed by other modules.
> Context: Partial auth removal leaves dead Swagger paths, bcrypt dependencies, and schema drift between users and auth tables.
> Source: MU-020
## 2026-04-22 [Pattern] Foundation RLS starts at workspaces SELECT gate
> Rule: Enable RLS on `workspaces` first and define downstream visibility through `get_user_workspace_ids(auth.uid())`; other workspace-scoped tables can then safely chain access off workspace membership.
> Context: Workspace-scoped Supabase policies are easiest to reason about when `workspaces` is the canonical visibility boundary and the SECURITY DEFINER helper encapsulates membership lookup.
> Source: MU-010

## 2026-04-22 [Gotcha] Pooled RLS claims must use SET plus RESET
> Rule: When attaching JWT claims to a shared pg Pool client for PostgreSQL RLS, use session-level `SET request.jwt.claims = ...` and always `RESET request.jwt.claims` before `client.release()`; never rely on `SET LOCAL` in autocommit mode.
> Context: `SET LOCAL` evaporates immediately without an explicit transaction, while forgetting to RESET on a pooled connection can leak one user's claims into the next request and break data isolation.
> Source: MU-021

## 2026-04-22 [Bug Fix] Workspace creation must seed owner membership under RLS
> Rule: When workspaces are protected by membership-based RLS, the create route must insert the workspace through a user-scoped Supabase client and immediately add a matching `workspace_members` owner row for `req.user.supabaseId` in the same authenticated flow.
> Context: Without the membership row, `get_user_workspace_ids(auth.uid())` returns no workspaces and all workspace-scoped RLS policies hide the new workspace from its creator.
> Source: MU-028

## 2026-04-22 [Gotcha] Supabase RLS must follow actual legacy table names
> Rule: When adding Supabase RLS to existing Rorca tables, verify the real table and column names in migrations first; legacy tables may still be named `notifications`, `notification_preferences`, and `subscriptions` with local `user_id` FKs, requiring policies to join through `users.auth_id` instead of comparing `auth.uid()` to a nonexistent `user_auth_id` column.
> Context: The MU-015 acceptance text referenced `notification_subscriptions`, `notification_history`, and `billing`, but the live PostgreSQL schema currently uses legacy names and local user IDs.
> Source: MU-015

## 2026-04-22 [Gotcha] Team RLS scopes teams through workspace_access
> Rule: When writing Supabase RLS for teams in this schema, scope `teams` visibility through `workspace_access` joined to `get_user_workspace_ids(auth.uid())` because `teams.workspace_id` does not exist yet.
> Context: The legacy teams schema links teams to workspaces indirectly, so a direct `teams.workspace_id` policy would fail and drift from the live database model.
> Source: MU-013

## 2026-04-22 [Pattern] RLS on mixed-scope tables needs compound policies
> Rule: When a table mixes global rows with workspace-scoped rows, write SELECT as `(workspace_id IS NULL) OR workspace_id IN get_user_workspace_ids(auth.uid())` and gate global writes behind an admin helper such as `is_admin(auth.uid())`.
> Context: A workspace-only RLS policy on `direction_layers` would hide global L1/L2 rows from authenticated users and break direction synthesis.
> Source: MU-012

## 2026-04-22 [Gotcha] RLS story brief can drift from live schema
> Rule: Before writing Supabase RLS migrations, verify every target table and scoping column in the current migration set; if a table lacks the required workspace_id or join key, add the schema migration first instead of forcing an incorrect policy.
> Context: MU-016 requested RLS for spec_versions, story_comments, and agent_hook_invocations, but this branch's schema has no workspace_id on spec_versions, no run_id/workspace_id on story_comments, and no agent_hook_invocations table yet.
> Source: MU-016
## 2026-04-22 [Gotcha] RLS policies may need auth-id join on legacy user tables
> Rule: When enabling Supabase RLS on legacy tables keyed by users.id, map ownership via users.auth_id = auth.uid() instead of assuming a direct user_auth_id column exists.
> Context: Several existing tables still use user_id TEXT foreign keys to the local users table, so direct auth.uid() comparisons would fail or block valid rows.
> Source: MU-015

## 2026-04-22 [Decision] Supabase CLI config stays separate from app migrations
> Rule: Use `supabase/config.toml` and `supabase/migrations/` only for Supabase-managed local services, while keeping Rorca app schema migrations in `backend/src/db/pg-migrations/` under the `pg-index.ts` runner.
> Context: Avoids conflating Supabase local dev reset behavior with the backend's PostgreSQL migration system, which would otherwise lead to missing tables or false assumptions during setup.
> Source: MU-027

## 2026-04-22 [Decision] direction_layers RLS needs explicit admin helper for global writes
> Rule: When a table mixes global rows (`workspace_id IS NULL`) and workspace-scoped rows, write policies must split those cases: workspace members can mutate scoped rows, but global rows require an explicit admin helper such as `is_admin(auth.uid())`.
> Context: A single workspace-membership policy would either block all global mutations or accidentally allow non-admin users to change L1/L2 global direction layers.
> Source: MU-012

## 2026-04-22 [Bug Fix] Workspace creation must seed workspace_members owner row
> Rule: When creating a workspace under Supabase RLS, insert the workspace via a user-scoped client and immediately add a matching owner row in workspace_members for req.user.supabaseId.
> Context: Workspace-scoped RLS resolves membership through get_user_workspace_ids(auth.uid()); without the owner membership row, newly created workspaces disappear from all RLS-protected queries.
> Source: MU-028

## 2026-04-22 [Bug Fix] RLS request claims must use SET plus RESET
> Rule: When projecting JWT claims into PostgreSQL for RLS on a pooled pg client, use session-level `SET request.jwt.claims = $1` and always `RESET request.jwt.claims` before releasing the client back to the pool.
> Context: `SET LOCAL` is ineffective in autocommit mode and leaked session variables on pooled connections can expose one user's claims to the next borrower.
> Source: MU-021

## 2026-04-22 [Gotcha] Vault and GitHub RLS require workspace_id schema first
> Rule: Do not add workspace-scoped RLS policies to `api_key_vault` or `github_connections` until each row has a non-null `workspace_id`; fail the migration loudly instead of creating false security.
> Context: These legacy tables were user-scoped in the current branch, but the Supabase RLS model relies on `get_user_workspace_ids(auth.uid())` for workspace isolation.
> Source: MU-014

## 2026-04-22 [Decision] Legacy backend auth removed for Supabase cutover
> Rule: When migrating fully to Supabase auth, delete server-managed auth endpoints and password storage together: drop refresh/reset/verification tables, drop users.password_hash, keep only GET /api/auth/me plus shared token-encryption helpers used by other routes.
> Context: Prevents dead auth code from depending on removed schema and avoids mixed auth models after the Supabase JWT middleware rollout.
> Source: MU-020
## 2026-04-22 [Pattern] Supabase local dev uses dedicated CLI config
> Rule: Keep local Supabase CLI ports and env examples aligned across supabase/config.toml, frontend .env.local.example, backend/.env.example, and developer docs, and document that Supabase CLI migrations are separate from backend pg-index migrations.
> Context: Prevents auth callback mismatches, wrong local URLs, and confusion between Supabase-managed schema resets and Rorca application schema migrations.
> Source: MU-027

## 2026-04-22 [Bug Fix] Workspace RLS needs owner membership bootstrap
> Rule: When creating a workspace under Supabase RLS, insert the corresponding `workspace_members` owner row in the same user-scoped transaction immediately after the `workspaces` insert.
> Context: `get_user_workspace_ids()` reads from `workspace_members`, so a workspace row without a membership row becomes invisible to all workspace-scoped RLS policies, including the creator's own reads.
> Source: MU-028

## 2026-04-22 [Gotcha] Team RLS required schema backfill before policying
> Rule: If a workspace-scoped RLS policy is required for teams, ensure `teams.workspace_id` exists and is backfilled from existing `workspace_access` rows before enabling policies.
> Context: The story required workspace-scoped team visibility, but the current schema only related teams to workspaces indirectly via `workspace_access`.
> Source: MU-013

## 2026-04-22 [Bug Fix] Per-request Supabase clients must not reuse shared anon client session state
> Rule: When enforcing RLS from Express routes, create a fresh Supabase client per request with the bearer token in global Authorization headers instead of mutating a shared singleton with setSession().
> Context: A shared anon client can leak auth context across concurrent requests and cause incorrect RLS behavior on security-critical tables like vault keys.
> Source: MU-014

## 2026-04-22 [Bug Fix] RLS pool clients must RESET request.jwt.claims before release
> Rule: When setting PostgreSQL JWT claims on a pooled client for RLS, use session-level `SET request.jwt.claims = ...`, then always `RESET request.jwt.claims` in a finally block before `client.release()`.
> Context: `SET LOCAL` is ineffective in autocommit mode, and failing to RESET leaks one user's claims to the next borrower of the same pool connection.
> Source: MU-021

## 2026-04-22 [Decision] Legacy auth removal requires crypto helper extraction
> Rule: When removing old auth routes, move any shared token-encryption helpers into a lib module before deleting route logic so GitHub/vault integrations keep working.
> Context: The old auth router also owned decrypt/encrypt helpers used by GitHub and other integrations; removing routes without extracting helpers breaks unrelated features.
> Source: MU-020
## 2026-04-22 [Pattern] Local Supabase config stays separate from app migrations
> Rule: Use `supabase/config.toml` only for local Supabase service orchestration and keep Rorca application schema migrations in `backend/src/db/pg-migrations/`; do not assume `supabase db reset` applies app schema changes.
> Context: Rorca already has its own PostgreSQL migration runner (`pg-index.ts`). Mixing Supabase CLI migrations with app schema migrations causes local reset behavior to diverge from backend startup behavior.
> Source: MU-027

## 2026-04-22 [Gotcha] RLS migrations must match legacy table names
> Rule: When adding Supabase RLS to older Rorca tables, verify the live schema first: user settings are in `user_settings`, notification data is in `notifications` and `notification_preferences`, and billing is in `subscriptions`; bridge `auth.uid()` through `users.auth_id` when tables still store `user_id`.
> Context: The MU-015 brief used future-facing names like `notification_subscriptions`, `notification_history`, `billing`, and `user_auth_id`, but this branch still uses legacy table/column names. Writing policies against the brief alone would fail at migration time or protect the wrong tables.
> Source: MU-015

## 2026-04-22 [Bug Fix] Workspace creation must bootstrap workspace_members owner row
> Rule: When workspaces are created under RLS, insert the workspace row and the creator's owner membership in the same user-scoped transaction so get_user_workspace_ids(auth.uid()) immediately includes the new workspace.
> Context: workspace_members is the source of truth for workspace visibility. If the owner row is missing, all workspace-scoped RLS policies evaluate to zero rows for that user.
> Source: MU-028

## 2026-04-22 [Bug Fix] RLS claim scoping must use SET plus RESET
> Rule: When borrowing a pg pool client for request-scoped RLS, use session-level `SET request.jwt.claims = ...` before queries and always `RESET request.jwt.claims` before releasing the client back to the pool.
> Context: `SET LOCAL` is ineffective in autocommit mode and failing to reset claims leaks one user's auth context into the next pooled request, which is a severe data isolation vulnerability.
> Source: MU-021

## 2026-04-22 [Gotcha] MU-014 schema names differ from spec language
> Rule: When implementing Supabase RLS for secrets in this repo, secure the live tables `api_key_vault` and `workspace_github_webhooks`; `vault_keys` is described in product docs, but the current backend schema still uses the legacy table names.
> Context: Avoids patching non-existent tables and ensures the security fix lands on the actual secrets surfaces used by the app.
> Source: MU-014
## 2026-04-22 [Gotcha] RLS acceptance names may lag canonical table names
> Rule: Before writing Supabase RLS migrations, verify the actual PostgreSQL table and column names in migrations rather than assuming spec terminology matches the schema exactly.
> Context: This story asked for RLS on notification_subscriptions, notification_history, and billing, but the current schema uses notification_preferences, notifications, and subscriptions, with user linkage via users.auth_id rather than direct user_auth_id columns on those tables.
> Source: MU-015

## 2026-04-22 [Pattern] RLS request claims must reset before pool release
> Rule: When setting PostgreSQL request.jwt.claims on a pooled client, use session-level SET and always RESET request.jwt.claims in finally before client.release() to prevent JWT claim leakage across requests.
> Context: SET LOCAL is ineffective in pg autocommit mode, and leaked claims on reused pool connections create cross-user data isolation vulnerabilities worse than missing RLS.
> Source: MU-021

## 2026-04-22 [Pattern] Route-level RLS must use withUserClient for workspace-scoped reads and inserts
> Rule: When a backend route touches RLS-protected workspace-scoped tables, run the route DB access through withUserClient(req, fn) and keep all client queries inside that callback instead of mixing pool helpers.
> Context: Pool-level helpers bypass per-request JWT claims, so routes can silently defeat RLS even when table policies exist. The helper centralizes claim reset and client.release() to avoid leaked scoped sessions.
> Source: MU-022

## 2026-04-22 [Pattern] RLS integration tests must use Supabase user clients
> Rule: When validating Supabase RLS, perform assertions through @supabase/supabase-js clients authenticated as real users; use the raw pg pool only for setup and teardown that intentionally bypass RLS.
> Context: Direct Postgres connections run as the table owner/service context and can silently bypass RLS, producing false positives for cross-user isolation tests.
> Source: MU-025

## 2026-04-22 [Decision] Supabase CLI config stays separate from app schema migrations
> Rule: Use `supabase/config.toml` and `supabase/migrations/` only for Supabase-managed local services; keep Rorca app schema migrations in `backend/src/db/pg-migrations/` under the existing `pg-index.ts` runner.
> Context: Avoids conflating two migration systems during local auth setup and prevents developers from expecting `supabase db reset` to apply the app schema.
> Source: MU-027

## 2026-04-22 [Bug Fix] Workspace creation must seed workspace_members owner row
> Rule: When creating a workspace through an RLS-scoped route, insert the workspace_members owner membership in the same withUserClient() transaction as the workspace row so get_user_workspace_ids(auth.uid()) immediately returns the new workspace.
> Context: workspaces RLS depends on workspace_members as the membership source of truth; without the owner row, the creator loses visibility of the workspace they just created.
> Source: MU-028

## 2026-04-22 [Bug Fix] Invalid bearer tokens must not fall through to LOCAL_ADMIN
> Rule: In local fallback auth mode, if an Authorization bearer token is present but Supabase rejects it, return `401 AUTH_ERROR` instead of silently injecting the local admin user.
> Context: Falling back to local admin on invalid supplied tokens turns JWT manipulation into an auth bypass in mixed local/Supabase environments.
> Source: MU-029
## 2026-05-03 [Gotcha] Local auth fallback must reject invalid bearer tokens
> Rule: In local single-user mode, if an Authorization bearer token is present but cannot be resolved, return 401 AUTH_ERROR instead of silently falling back to LOCAL_ADMIN.
> Context: CLI and browser clients can carry stale Supabase sessions; silently accepting bad tokens masks auth bugs and violates routes that are expected to honor explicit bearer auth.
> Source: CLI-012

## 2026-05-03 [Pattern] TUI single-argument commands must preserve the raw remainder
> Rule: When parsing TUI command palette input, commands with exactly one argument should receive the literal remainder of the line after the command label, trimmed only at the ends.
> Context: Commands like `forge <brief>` need to preserve internal spaces and quotes instead of whitespace-tokenizing the brief.
> Source: CLI-013

## 2026-05-03 [Gotcha] Backend Jest setup currently depends on AGE schema availability
> Rule: When running backend Jest on this branch, expect global setup to fail before test execution if PostgreSQL lacks Apache AGE objects because migration 064 references ag_catalog.
> Context: Focused unit tests can be blocked by migration startup rather than the code under test, so verify the test database has AGE installed or isolate the run path before debugging Jest failures.
> Source: CLI-019

## 2026-05-03 [Gotcha] Spec graph route is not Apache AGE-backed
> Rule: Treat `GET /api/specs/:specId/graph` as the spec JSON dependency DAG and keep it available in Lite Mode; only `knowledge-graph` and graph-memory routes need AGE guards.
> Context: The route name is easy to misread during graph-related work, but guarding it would disable a non-AGE feature and break the spec dependency view unnecessarily.
> Source: CLI-039

## 2026-05-03 [Bug Fix] Track lite-skipped migrations explicitly for DB upgrades
> Rule: When Lite Mode skips extension-dependent migrations, record them in schema_migrations with skipped_in_lite_mode=true so a later native-to-Docker upgrade can delete and replay exactly those versions after AGE becomes available.
> Context: Without an explicit skip marker, upgrading from native Postgres to Docker+AGE preserves fake-applied migration rows and silently leaves graph features uninitialized after restore.
> Source: CLI-044

## 2026-05-03 [Pattern] CLI diagnostics need local preflight before API-backed checks
> Rule: For commands like `rorca doctor`, run local Docker/backend reachability checks before relying on backend endpoints, then use the API route for the richer in-process checks and JSON output.
> Context: If the backend is down, a doctor command that only calls `/api/doctor` cannot diagnose why startup failed. Local preflight preserves actionable offline diagnostics while keeping the backend endpoint as the canonical structured report.
> Source: CLI-024

## 2026-05-03 [Gotcha] MCP HTTP transport requires local bearer token
> Rule: Protect /mcp with requireMcpAuth and a bearer token loaded from ~/.rorca/mcp-token; invalid tokens must return 401 MCP_AUTH_INVALID and must never fall through to LOCAL_ADMIN.
> Context: The MCP HTTP bridge exposes hundreds of privileged tools, so localhost reachability alone is not a sufficient security boundary.
> Source: CLI-045

## 2026-05-03 [Gotcha] Worker heartbeat stale threshold must stay 90 seconds everywhere
> Rule: Use a single 90s worker-heartbeat staleness rule across supervisor restarts, health endpoints, and worker-monitoring code; do not mix 60s and 90s checks.
> Context: CLI-035 exposed a drift where the worker health route treated heartbeats as stale after 60s while the rest of the worker lifecycle used 90s, which can produce false unhealthy states and unnecessary restarts.
> Source: CLI-035

## 2026-05-03 [Pattern] CLI/backend version preflight belongs in shared fetch path with doctor bypass
> Rule: For API-backed CLI commands, run the backend compatibility handshake once in the shared request path and explicitly bypass it for diagnostics like doctor that must still run against mismatched backends.
> Context: This prevents silent corruption on normal commands while preserving doctor as the recovery tool when CLI and backend versions drift apart.
> Source: CLI-036

## 2026-05-03 [Gotcha] npm pack requires prepack, not prepublishOnly
> Rule: Use a prepack build hook for any npm tarball verification or assembly path; prepublishOnly alone does not build artifacts for npm pack.
> Context: Clean-clone tarball checks and local npm pack flows otherwise miss compiled dist assets even when publish itself would build them.
> Source: CLI-037

## 2026-05-03 [Bug Fix] Pi version detection must capture stderr-safe output
> Rule: When probing `pi --version`, capture both stdout and stderr via `spawnSync(..., { stdio: ['ignore', 'pipe', 'pipe'] })` and parse the combined output instead of relying on stdout-only `execSync`.
> Context: The Pi CLI can emit its version string in a way that bypasses stdout-only parsing, which both leaked raw output into `rorca doctor --json` and caused the detector to report a null version.
> Source: CLI-038

## 2026-05-03 [Gotcha] Jest mcp-auth imports must target TypeScript source explicitly
> Rule: In backend Jest tests, require `mcp-auth.ts` explicitly instead of `mcp-auth` when a sibling `mcp-auth.js` artifact exists, otherwise Jest may resolve the stale ESM .js file first and fail before running the test.
> Context: The backend test runner resolves extensionless requires to `mcp-auth.js` before `mcp-auth.ts`. That shadowed the live source and caused `Cannot use import statement outside a module` failures unrelated to the actual MCP auth logic.
> Source: CLI-046

## 2026-05-03 [Gotcha] MCP HTTP auth is Bearer-only; OAuth probes must return 501
> Rule: Do not ship placeholder OAuth handlers for /mcp. Rorca MCP uses Bearer token auth from ~/.rorca/mcp-token, and OAuth-related endpoints should return explicit 501 guidance instead of fake tokens.
> Context: A trivial OAuth shim can mislead reviewers into believing auth exists and can conflict with real Bearer enforcement.
> Source: CLI-050

## 2026-05-04 [Gotcha] Compiled CLI wrapper cannot be verified directly in repo checkout
> Rule: When verifying changes in `bin/rorca.ts`, prefer `npx tsx bin/rorca.ts ...` in the repo checkout because emitted `bin/rorca.js` imports backend source modules via extensionless ESM paths that Node cannot resolve directly here.
> Context: Direct `node bin/rorca.js ...` verification failed with `ERR_MODULE_NOT_FOUND` for `../backend/src/lib/mcp-auth`, so source-entry verification is the reliable path until the generated CLI wrapper's module resolution is fixed.
> Source: CLI-032
