# Memory Ledger

## 2026-02-27 [Architecture] Direction Stack 5-Layer Cascade
> Rule: Direction Stack layers cascade L1 (global) → L5 (story annotations). Lower layers override higher ones, like CSS specificity.
> Context: L1-L2 are global engineering/domain principles. L3+ are per-workspace. L4/L5 come from spec brief and story annotations.
> Source: CIE-003

## 2026-02-27 [Convention] Spec ID vs specName
> Rule: spec.id is the filename slug (use for API calls and path construction). spec.specName is the human-readable title (display only).
> Context: Confusing these causes file-not-found errors in pipeline trigger and archive panel.
> Source: v2-platform

## 2026-02-27 [Gotcha] better-sqlite3 is synchronous
> Rule: Never use async/await for better-sqlite3 DB calls. db.prepare().get() returns T|undefined, .all() returns T[], .run() returns RunResult.
> Context: Using async wrappers around synchronous calls adds unnecessary overhead and can cause subtle bugs.
> Source: v2-platform

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

## 2026-03-08 [Gotcha] Migration Files Must Not Use Conditional DDL
> Rule: SQLite lacks IF NOT EXISTS for ALTER TABLE ADD COLUMN — use pragma table_info checks in db/index.ts instead of migration files for conditional schema changes
> Context: This is already documented in CLAUDE.md SQLite Migration Pattern section, but worth reinforcing given 044 new migration files in this run. Prevents migration failures on re-runs.
> Source: PR-002 through PR-044

## 2026-03-08 [Decision] Feature Badges Use Semantic Versioning Gates
> Rule: New features get badges (e.g. 'New in v2.1') tied to semantic version checks — frontend shows prompts for features available in current version but not yet used
> Context: PR-052 implements upgrade prompts + feature badges. This creates a progressive disclosure UX where users discover features organically rather than via docs. Version gate prevents showing unavailable features.
> Source: PR-052

## 2026-03-08 [Convention] Plan Quotas Enforced via Middleware Not Route Logic
> Rule: Usage quotas (plan limits, token budgets) are enforced via requirePlan middleware attached to routes, not inline in route handlers
> Context: PR-051 creates plan_quotas table + requirePlan middleware. This centralizes enforcement logic and makes quota changes (free → paid tier) declarative. Route handlers stay clean.
> Source: PR-051
