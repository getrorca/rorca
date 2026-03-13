# Memory Ledger

## 2026-02-27 [Architecture] Direction Stack 5-Layer Cascade
> Rule: Direction Stack layers cascade L1 (global) → L5 (story annotations). Lower layers override higher ones, like CSS specificity.
> Context: L1-L2 are global engineering/domain principles. L3+ are per-workspace. L4/L5 come from spec brief and story annotations.
> Source: CIE-003

## 2026-02-27 [Convention] Spec ID vs specName
> Rule: spec.id is the filename slug (use for API calls and path construction). spec.specName is the human-readable title (display only).
> Context: Confusing these causes file-not-found errors in pipeline trigger and archive panel.
> Source: v2-platform

## 2026-03-10 [Gotcha] pg is async — always await DB calls
> Rule: All DB calls (query, queryOne, execute) are async via pg Pool. Always use `await`. Use `$1, $2, ...` numbered placeholders (NOT `?`).
> Context: Missing `await` returns a Promise instead of data. PostgreSQL uses numbered placeholders, not positional `?`.
> Source: rorca-postgres-migration PG-011

## 2026-02-27 [Convention] chatComplete returns ChatResult
> Rule: chatComplete() returns ChatResult { text, usage } — always use .text accessor, never treat result as a string.
> Context: The return type was changed from string to ChatResult in US-003 (model selection). All callers must use .text.
> Source: US-003

## 2026-02-27 [Gotcha] Backend requires restart after changes
> Rule: tsx has no hot-reload. Always kill port 3030 and restart after backend changes: lsof -ti:3030 | xargs kill -9 && npm run dev
> Context: Changes to backend code are not picked up automatically. Forgetting to restart causes stale behavior.
> Source: v2-platform

## 2026-02-28 [Architecture] Context Router uses virtual file assembly
> Rule: Context is assembled virtually at runtime — no physical file scatter. Path-based scoping + tag injection + token budget enforcement.
> Context: .rorca/config.json routing section defines globals, scopes, and tags. micromatch handles glob matching.
> Source: CIE-004

## 2026-02-28 [Architecture] Episodic Memory is structured Markdown
> Rule: MEMORY.md entries follow format: ## YYYY-MM-DD [Category] Title / > Rule: / > Context: / > Source: story-id
> Context: Machine-readable, human-editable. Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha.
> Source: CIE-005

## 2026-03-01 [Gotcha] Wave-based execution blocks dependent stories on single failure
> Rule: When wave execution is enabled, a single story failure in wave 0 causes all dependent stories to skip with reason='blocked_by'
> Context: SM-001 failed in wave 0, causing SM-002, SM-004, and SM-006 to skip despite not being directly tested. This cascading failure pattern means early wave failures have exponential impact on run completion rate.
> Source: SM-001

## 2026-03-01 [Convention] TypeScript typecheck failures require immediate resolution
> Rule: Stories must pass `npx tsc --noEmit` validation before being marked as passed, even if runtime behavior appears correct
> Context: SM-001 failed with reason='typecheck' despite potentially working at runtime. The execution engine enforces strict type safety as a quality gate. Always verify both frontend and backend type checks before committing.
> Source: SM-001

## 2026-03-01 [Pattern] Marketplace UI components follow extract-then-enhance pattern
> Rule: When adding features to marketplace panels, first extract shared utilities (SM-003: renderMarkdown), then build new UI features (SM-005: category filters) on top of the shared foundation
> Context: SM-003 and SM-005 passed while SM-001 failed, suggesting the incremental approach of establishing shared utilities before complex features reduces integration risk.
> Source: SM-003

## 2026-03-08 [Decision] PostgreSQL Migration Supersedes SQLite Optimization
> Rule: When planning production infrastructure, choose PostgreSQL from day one rather than optimizing SQLite then migrating later
> Context: PR-049 and PR-050 (SQLite optimization + benchmarks) were superseded by the rorca-postgres-migration spec. This teaches us that production-grade DB decisions should be made upfront, not incrementally optimized from dev-grade solutions.
> Source: rorca-postgres-migration

## 2026-03-08 [Convention] Rate Limiter Configuration Uses Database Table
> Rule: Rate limits are stored in the `rate_limits` DB table with 30s cache; defaults are 100 req/min authenticated, 20 req/min unauthenticated
> Context: To change limits: UPDATE rate_limits table then call invalidateRateLimitCache() or restart backend. Skipped in NODE_ENV=test unless RATE_LIMIT_ENABLED=true. Implemented in rate-limiter.ts.
> Source: PR-NEW-1

## 2026-03-08 [Pattern] Production Hardening Follows Layered Security Model
> Rule: Production readiness requires CORS hardening (PR-NEW-2), rate limiting (PR-NEW-1), secrets management (vault_keys table), and health checks — implement all four layers, not just one
> Context: The production-ready spec shows these are interdependent: rate limiting without CORS leaves attack vectors open; health checks without secrets management can't validate encrypted data access.
> Source: rorca-production-ready

## 2026-03-08 [Architecture] Docker Compose as Primary Self-Hosted Distribution
> Rule: Self-hosted distribution uses Docker Compose with Postgres 16 + pgvector + Apache AGE + Rorca backend — single `docker compose up` command
> Context: PR-003 establishes Docker Compose as the canonical self-hosted deployment method. This supersedes manual npm install flows and ensures consistent environments across installations.
> Source: PR-003

## 2026-03-08 [Convention] Health Checks Return Structured Component Breakdown
> Rule: Health endpoints must return both aggregate score and per-component status (CLAUDE.md 30pt, AGENTS.md 20pt, config.json 20pt, MEMORY.md 15pt, skills 15pt)
> Context: Implemented via workspace-echolocation.ts echolocate() function. Penalties apply: CLAUDE.md < 10 lines = half credit, < 50 lines = 75% credit. This structured breakdown enables actionable remediation.
> Source: CIE workspace health

## 2026-03-08 [Pattern] Spec Queue Panel Uses Dual-Tab Architecture
> Rule: Queue-style panels (review queue, run queue) use a dual-tab pattern: 'pending' + 'history' tabs with shared data fetching and SSE subscriptions
> Context: PR-QUEUE-1 (Spec Review Queue Panel) establishes this pattern. Both tabs subscribe to the same SSE stream but filter differently. Prevents code duplication and ensures real-time consistency across views.
> Source: PR-QUEUE-1

## 2026-03-10 [Convention] PostgreSQL Migration Pattern
> Rule: Migrations live in `backend/src/db/pg-migrations/` as numbered SQL files. Tracked via `schema_migrations` table (not filesystem). Use `IF NOT EXISTS` / `IF EXISTS` guards freely — PostgreSQL supports them natively.
> Context: Supersedes the old SQLite pragma table_info workaround. PostgreSQL supports `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.
> Source: rorca-postgres-migration PG-011

## 2026-03-08 [Decision] Feature Badges Use Semantic Versioning Gates
> Rule: New features get badges (e.g. 'New in v2.1') tied to semantic version checks — frontend shows prompts for features available in current version but not yet used
> Context: PR-052 implements upgrade prompts + feature badges. This creates a progressive disclosure UX where users discover features organically rather than via docs. Version gate prevents showing unavailable features.
> Source: PR-052

## 2026-03-08 [Convention] Plan Quotas Enforced via Middleware Not Route Logic
> Rule: Usage quotas (plan limits, token budgets) are enforced via requirePlan middleware attached to routes, not inline in route handlers
> Context: PR-051 creates plan_quotas table + requirePlan middleware. This centralizes enforcement logic and makes quota changes (free → paid tier) declarative. Route handlers stay clean.
> Source: PR-051

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
