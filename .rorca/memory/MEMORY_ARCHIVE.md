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
