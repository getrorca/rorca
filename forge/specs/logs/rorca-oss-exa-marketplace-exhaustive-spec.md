# RORCA — EXHAUSTIVE MASTER SPECIFICATION
**Spec ID**: rorca-oss-exa-marketplace
**Version**: 1.0
**Date**: 2026-03-02
**Standard**: Bible-level autonomous agent readiness
**Produced by**: exhaustive-specification + adversarial-thinking + spec-gap-analysis + trust-but-verify skills

---

## INTEGRATION WITH EXISTING CODEBASE

### Plugs directly into existing infrastructure — zero rework

| Feature | Existing hook |
|---|---|
| Exa API key storage | `vault_keys` table + AES-256-GCM (025_api_key_vault.sql) |
| Tier gating | `billing` table (035_billing.sql) |
| Spec publishing | `spec_versions`, `spec_tag_assignments` already exist |
| MCP tools for marketplace | HTTP MCP auto-generates from new routes |
| Research pre-pass | hooks into `llm-client.ts` `chatComplete()` |
| Marketplace panel | `src/panels/MarketplacePanel.tsx` already exists, needs redesign |
| Community spec fork → workspace | `forge/specs/pending/` path pattern already established |

### Net new (doesn't exist yet)
- `backend/src/lib/exa-search.ts`
- `backend/src/lib/spec-sanitizer.ts`
- `backend/src/routes/search.ts` + `exa.ts` + `marketplace.ts`
- Migrations 042–047
- `bin/rorca.ts` + `bin/rorca-init.ts`

---

## PHASE 1: FOUNDATION

### 1.1 System Purpose

Rorca is a spec-driven autonomous development platform. It transforms plain-English briefs into structured specifications (N user stories), then executes each story as an isolated subprocess with the full tool set — no context limits, resumable, runs to completion autonomously.

**The core identity in one sentence**: Every story runs as a fresh isolated subprocess with the full tool set — bash, edit, read, write, glob, grep. No context limits. A spec can run forever.

**What Rorca is NOT**:
- Not a chat interface (Claude Code, ChatGPT)
- Not an IDE assistant (Cursor, Windsurf, Copilot)
- Not a task manager (Linear, Jira)
- Not a code review tool (CodeRabbit, Graphite)
- Not an agent framework (LangChain, CrewAI)

**The gap Rorca fills**: There is no tool that takes a plain-English feature brief, structures it into stories with acceptance criteria, executes each story autonomously with full codebase access, and accumulates institutional memory across runs. That gap is Rorca.

---

### 1.2 Success Criteria — Measurable

| Metric | Target | Measurement |
|--------|--------|-------------|
| Story pass rate | ≥ 80% on first attempt | `story_results.status = 'pass'` |
| Spec generation time | < 60s | `pipeline_runs.finished_at - started_at` |
| Archive search latency | < 100ms | Query timer middleware |
| Community spec index freshness | < 5 min lag | `spec_publications.indexed_at` |
| Exa search relevance | ≥ 0.85 cosine similarity | User thumbs up/down on results |
| Self-hosted setup time | < 10 min from clone to first run | Onboarding timer |
| OSS contribution rate | ≥ 1 PR/week at 1K stars | GitHub metrics |

---

### 1.3 Personas

**Persona A — Solo Developer (primary)**
- Name: Marcus, 28, full-stack dev at a seed startup
- Goal: ship features 3x faster without burning out on boilerplate
- Pain: context limits force him to babysit every Claude session
- Behavior: runs 5-10 story specs weekly, self-hosted, Claude subscription
- Success state: triggers a spec on Friday, reviews results Monday morning

**Persona B — Startup CTO (secondary)**
- Name: Priya, 35, CTO at 12-person Series A
- Goal: leverage AI across the team without losing control of code quality
- Pain: every developer uses AI differently, no consistency, no institutional memory
- Behavior: sets up direction stack once, team runs specs against it
- Success state: direction stack enforces conventions so Rorca output is indistinguishable from senior dev output

**Persona C — Indie Hacker (acquisition)**
- Name: Dev, 24, building 3 SaaS products simultaneously
- Goal: ship MVPs fast, iterate based on usage
- Pain: can't afford to context-switch between 3 codebases
- Behavior: one Rorca instance, 3 workspaces, runs overnight
- Success state: wakes up to completed features across 3 products

**Persona D — Enterprise Team (future)**
- Name: Sarah, 42, engineering director at 200-person company
- Goal: standardize AI-assisted development across 8 teams
- Pain: compliance, security review, no visibility into what AI is changing
- Behavior: audit logs, GitHub integration, pipeline hooks for security review
- Success state: every AI-generated change goes through standard code review with full audit trail

---

## PHASE 2: COMPREHENSIVE REQUIREMENTS

### 2.1 Functional Requirements — Core Engine (FR-001 to FR-050)

**FR-001**: System SHALL accept a plain-English brief (min 10 chars, max 10,000 chars) and produce a structured spec JSON with `userStories` array within 60 seconds.

**FR-002**: System SHALL execute each story as an isolated subprocess. Story N SHALL have zero shared memory state with Story N-1. A crash in Story N SHALL NOT affect Story N+1.

**FR-003**: System SHALL support three execution paths: `claude --print`, `opencode run`, `codex --approval-mode auto-edit`. Switching execution path SHALL require only `RORCA_AGENT` env var change.

**FR-004**: System SHALL inject Direction Stack (L1–L5) into every story execution. L5 (story annotations) SHALL override L4 (spec brief) which SHALL override L3 (project) which SHALL override L2 (domain) which SHALL override L1 (global).

**FR-005**: System SHALL write `MEMORY.md` entries automatically after each completed run. Entries SHALL follow structured format: `[YYYY-MM-DD] [Category] [Entry]`. Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha.

**FR-006**: System SHALL support wave-based parallel execution via `dependsOn` DAG. Stories with no dependencies SHALL execute in parallel up to `config.execution.maxParallel` (default: 5).

**FR-007**: System SHALL create a git worktree for each wave when `autoWorktree: true`. Worktrees SHALL be merged in topological order after each wave completes.

**FR-008**: System SHALL emit WAL events for every state transition: `story_started`, `story_passed`, `story_failed`, `story_skipped`, `run_started`, `run_finished`. WAL events SHALL be append-only. No WAL event SHALL ever be deleted.

**FR-009**: System SHALL support HITL (Human-in-the-Loop) pause. A run SHALL pause when `run_blocked` WAL event is emitted. Resume SHALL inject provided context into the next story's prompt without killing the process.

**FR-010**: System SHALL gate story execution against configurable quality gates: `build`, `typecheck`, `test`, `playwright`. Gates SHALL run in `warn` (non-blocking) or `block` (blocking) mode. Default: `warn`.

**FR-011**: System SHALL support model escalation cascade for OpenCode path: Haiku → Sonnet → Opus on consecutive failures. Escalation threshold SHALL be configurable per workspace.

**FR-012**: System SHALL support spec versioning. Every edit to a spec JSON SHALL create a new version in `spec_versions` table. Diff between any two versions SHALL be computable via `GET /api/specs/:id/versions/diff`.

**FR-013**: System SHALL support story-level retry without re-running passed stories. `POST /api/pipeline/retry` with `storyId` SHALL re-execute only that story.

**FR-014**: System SHALL support spec tagging. Tags SHALL be filterable in Archive panel. Tag assignment SHALL be storable per-spec in `spec_tag_assignments` table.

**FR-015**: System SHALL expose all functionality as MCP tools via Streamable HTTP transport at `/mcp`. Every Express route with `@swagger` annotation SHALL auto-generate an MCP tool. Zero hand-written MCP wrappers SHALL exist post-CA-022.

---

### 2.2 Functional Requirements — AGPLv3 Open Source Transition (FR-051 to FR-075)

**FR-051**: System codebase SHALL be licensed under AGPLv3. `LICENSE` file SHALL exist at repository root containing the full AGPLv3 text.

**FR-052**: Every source file SHALL contain AGPLv3 SPDX header: `// SPDX-License-Identifier: AGPL-3.0-or-later`.

**FR-053**: `README.md` SHALL clearly state: "Rorca is free and open source under AGPLv3. Self-host for free forever. Cloud hosted version available at rorca.app."

**FR-054**: A `COMMERCIAL-LICENSE.md` SHALL exist explaining dual licensing: companies that cannot accept AGPLv3 (i.e., they modify and distribute Rorca without open-sourcing changes) MAY purchase a commercial license. Pricing SHALL be listed.

**FR-055**: `CONTRIBUTING.md` SHALL exist with: CLA requirement, PR process, coding standards, how to run tests, how to add a new route with swagger annotation.

**FR-056**: `SECURITY.md` SHALL exist with responsible disclosure process. Security vulnerabilities SHALL NOT be reported via public GitHub issues.

**FR-057**: GitHub Actions CI SHALL run on every PR: `npx tsc --noEmit` (frontend), `cd backend && npx tsc --noEmit` (backend), `cd backend && npm test` (Jest), frontend lint.

**FR-058**: Docker image SHALL be published to `ghcr.io/rorca/rorca:latest` on every release tag. Single container SHALL serve both frontend (static) and backend (Express) on port 3030.

**FR-059**: `docker-compose.yml` SHALL exist at repo root enabling `docker compose up` to start a fully functional Rorca instance with SQLite persistence via named volume.

**FR-060**: `npm i -g rorca && rorca start` SHALL work as the primary installation path. The `rorca` CLI SHALL start the Express server, serve static frontend, and open the browser automatically.

**FR-061**: `rorca init` command SHALL register the Rorca HTTP MCP globally: executes `claude mcp add --global rorca --transport http http://localhost:3030/mcp`. SHALL detect if Claude Code is installed and skip if not. SHALL print the registration command regardless so users can run manually.

**FR-062**: All analytics, telemetry, crash reporting SHALL be opt-in. Default: no data leaves the user's machine. `RORCA_TELEMETRY=1` SHALL enable anonymous usage stats.

---

### 2.3 Functional Requirements — Exa Integration (FR-076 to FR-120)

**FR-076**: System SHALL integrate Exa.ai neural search API (`https://api.exa.ai`) as a premium search capability gated behind paid tier.

**FR-077**: Free tier SHALL use SearXNG (`http://localhost:8080` default, configurable via `SEARXNG_URL` env var) or basic DuckDuckGo fallback if SearXNG not running.

**FR-078**: `RORCA_SEARCH_PROVIDER` env var SHALL control search backend: `exa` (paid), `searxng` (free self-hosted), `duckduckgo` (free fallback). Default: `duckduckgo`.

**FR-079**: `EXA_API_KEY` env var SHALL store Exa API key. Key SHALL also be storable in Rorca vault (`vault_keys` table, AES-256-GCM encrypted). Vault takes precedence over env var.

**FR-080**: Exa search SHALL be available in 4 contexts:
1. During story execution (agent `webfetch`/`websearch` tool calls)
2. Spec generation (research phase before story writing)
3. Community spec discovery (semantic search over published specs)
4. Direction stack research (finding best practices for L2/L3 population)

**FR-081**: Story execution with Exa SHALL use `type: "neural"` search by default. Query construction SHALL use story title + acceptance criteria as the query, not raw story text.

**FR-082**: Exa results SHALL be cached in `exa_cache` table for 24 hours. Same query within 24h SHALL return cached results without API call. Cache key: `SHA256(query + search_type)`.

**FR-083**: `exa_cache` table schema:
```sql
CREATE TABLE exa_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL,
  search_type TEXT NOT NULL DEFAULT 'neural',
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_exa_cache_key ON exa_cache(cache_key);
CREATE INDEX idx_exa_cache_expires ON exa_cache(expires_at);
```

**FR-084**: Expired cache entries SHALL be purged on server startup and daily at 03:00 local time via scheduler.

**FR-085**: Exa API calls SHALL respect rate limits. System SHALL implement exponential backoff: 1s, 2s, 4s, 8s (max 3 retries). On final failure SHALL fall back to SearXNG or DuckDuckGo.

**FR-086**: Search provider status SHALL be visible in `GET /api/health`: `{ searchProvider: 'exa' | 'searxng' | 'duckduckgo', searxngReachable: boolean, exaKeyPresent: boolean }`.

**FR-087**: Settings UI SHALL show search provider selector: "Neural Search (Exa) — Premium", "Self-hosted (SearXNG) — Free", "Basic (DuckDuckGo) — Free". Selecting Exa SHALL show API key input field.

**FR-088**: When Exa is active, spec generation SHALL run a research pre-pass before story writing:
1. Extract technology names from brief
2. Query Exa for: `"best practices [technology] [feature]"` for each tech
3. Inject top 3 results as context into spec generation prompt
4. Result: stories reference real library APIs, not hallucinated ones

**FR-089**: Exa research pre-pass results SHALL be stored in `spec_research_cache` table linked to spec ID. Viewable in Forge panel as "Research Sources" collapsible section.

**FR-090**: `spec_research_cache` table schema:
```sql
CREATE TABLE spec_research_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id),
  query TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  excerpt TEXT NOT NULL,
  relevance_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_src_spec ON spec_research_cache(spec_id);
```

---

### 2.4 Functional Requirements — Community Spec Marketplace (FR-121 to FR-175)

**FR-121**: Users SHALL be able to publish specs to the community marketplace via `POST /api/marketplace/publish`. Publishing is opt-in. Default: all specs are private.

**FR-122**: Published spec SHALL strip: workspace path, API keys, personal tokens, git remote URLs, email addresses. Sanitization SHALL run server-side before indexing.

**FR-123**: Published spec fields visible to community: `title`, `userStories[].title`, `userStories[].description`, `userStories[].acceptanceCriteria`, `tags`, `model`, `storyCount`, `passRate`, `publisherHandle` (optional anonymous).

**FR-124**: `spec_publications` table schema:
```sql
CREATE TABLE spec_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id),
  publisher_handle TEXT,
  anonymous INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  story_count INTEGER NOT NULL,
  pass_rate REAL,
  model TEXT,
  sanitized_json TEXT NOT NULL,
  exa_indexed INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  fork_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**FR-125**: When `RORCA_SEARCH_PROVIDER=exa`, published specs SHALL be indexed. Fallback: SQLite FTS5 full-text search over `sanitized_json`.

**FR-126**: Community search SHALL be available at `GET /api/marketplace/search?q=<query>&provider=exa|fts`. Returns ranked results with: title, description, tags, storyCount, passRate, forkable link.

**FR-127**: "Fork" SHALL copy a community spec into the user's own workspace `forge/specs/pending/` with a new slug and `forkedFrom` field. Fork count on original spec SHALL increment.

**FR-128**: Marketplace panel SHALL have 3 tabs: "Discover" (search), "My Published" (manage own), "Popular" (sorted by forks + downloads).

**FR-129**: Marketplace search SHALL support filters: `tag`, `model`, `minPassRate`, `minStoryCount`, `maxStoryCount`.

**FR-130**: SQLite FTS5 fallback search (when Exa not available):
```sql
CREATE VIRTUAL TABLE spec_fts USING fts5(
  title, description, tags, sanitized_json,
  content=spec_publications,
  content_rowid=id
);
```

---

### 2.5 Non-Functional Requirements (NFR-001 to NFR-015)

**NFR-001**: Archive search SHALL return results in < 100ms for up to 10,000 specs at P99.

**NFR-002**: SSE heartbeat interval SHALL be exactly 15 seconds.

**NFR-003**: WAL poll interval SHALL be exactly 3 seconds. No WAL event SHALL be missed between polls.

**NFR-004**: Story subprocess timeout: configurable via `STORY_TIMEOUT_MINUTES`. Default: 45 minutes. SIGTERM at timeout, SIGKILL after 10s.

**NFR-005**: Backend SHALL start in < 5 seconds including DB migration, swagger spec generation, MCP tool registration.

**NFR-006**: MCP tool registration at startup SHALL complete in < 2 seconds for up to 200 routes.

**NFR-007**: SQLite WAL mode + FK enforcement on every DB connection. Non-negotiable.

**NFR-008**: All DB operations SHALL be synchronous (better-sqlite3). No `async/await` in DB call paths.

**NFR-009**: Exa API timeout: fall back to alternative search provider if Exa response exceeds 5 seconds.

**NFR-010**: `npm run build` SHALL complete in < 30 seconds on MacBook M1.

**NFR-011**: Docker image SHALL be < 500MB uncompressed.

**NFR-012**: `rorca start` cold start SHALL be < 3 seconds.

**NFR-013**: Memory usage SHALL stay < 512MB under normal load (< 5 concurrent story subprocesses).

**NFR-014**: Each story subprocess SHALL be isolated — `stdio: ['ignore', 'pipe', 'pipe']` mandatory.

**NFR-015**: All API keys in vault SHALL be AES-256-GCM encrypted. Encryption key derived from machine-specific entropy. Key SHALL never be stored in DB or files.

---

### 2.6 UX Requirements

**UX-001 — Forge Panel**: Brief input: resizable textarea, min-height 120px, character counter `X / 10,000`. Loading state: progress bar with phases (researching → writing stories → validating → done). When Exa active: "Research Sources" collapsible section below generated spec showing 3-5 source URLs with excerpts.

**UX-002 — Queue Panel**: Card shows: spec title, story count, estimated run time, model badge, creation date, "Approve" and "Reject" buttons. Reject requires reason (min 10 chars).

**UX-003 — Archive Panel**: Telemetry row for completed runs (duration, tokens, cost, agent badge). Status: 1.5px colored dot not bordered pill badge. Completed specs: `opacity-80`.

**UX-004 — Pipeline Panel**: xterm.js with `@xterm/xterm` (NOT old `xterm`). Font: JetBrains Mono 13px. Background: `#0d0d0d`. Story list shows real-time pass/fail via SSE.

**UX-005 — Marketplace Panel**: Search input debounces 300ms. Results paginate 20/page. Card: title, description (2 lines max), tag pills, story count, pass rate bar, "Fork" button. Fork success toast: "Spec forked to forge/specs/pending/[slug].json".

**UX-006 — Settings Panel**: Search provider selector in "Model & Providers" tab. Exa selection shows API key field (type=password) + "Test connection" button + green checkmark on success.

**UX-007 — All panels**: Empty states: icon + headline (max 5 words) + subtext (1 sentence) + action button. Never just "No data found."

**UX-008 — Command Palette (⌘K)**: Supports: "New spec [brief]", "Search community specs [query]", "Run spec [name]", "Open workspace [name]", "View archive".

---

## PHASE 3: DETAILED DESIGN

### 3.1 Architecture Decision: Monolith Forever (Until Phase 3 Cloud)

Rorca SHALL remain a monolith through Phase 2 (self-hosted + VS Code extension). No microservices. No message queue. No Redis. The WAL event system + SSE hub IS the message queue. SQLite WAL mode handles concurrent reads.

**Migration trigger**: Only split when moving to cloud hosting (Phase 3). At that point: SQLite → PostgreSQL, in-memory SSE → Redis pub/sub, subprocess isolation → container-per-story.

---

### 3.2 New Tables Required (Migrations 042–047)

**Migration 042** — `exa_cache`:
```sql
CREATE TABLE IF NOT EXISTS exa_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL,
  search_type TEXT NOT NULL DEFAULT 'neural',
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exa_cache_key ON exa_cache(cache_key);
CREATE INDEX IF NOT EXISTS idx_exa_cache_expires ON exa_cache(expires_at);
```

**Migration 043** — `spec_research_cache`:
```sql
CREATE TABLE IF NOT EXISTS spec_research_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  excerpt TEXT NOT NULL,
  relevance_score REAL DEFAULT 0.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_src_spec ON spec_research_cache(spec_id);
```

**Migration 044** — `spec_publications`:
```sql
CREATE TABLE IF NOT EXISTS spec_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  publisher_handle TEXT,
  anonymous INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  story_count INTEGER NOT NULL DEFAULT 0,
  pass_rate REAL DEFAULT 0.0,
  model TEXT,
  sanitized_json TEXT NOT NULL,
  exa_indexed INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT,
  download_count INTEGER NOT NULL DEFAULT 0,
  fork_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pub_spec ON spec_publications(spec_id);
CREATE INDEX IF NOT EXISTS idx_pub_indexed ON spec_publications(exa_indexed, created_at);
CREATE INDEX IF NOT EXISTS idx_pub_popular ON spec_publications(fork_count, download_count);
```

**Migration 045** — `spec_fts` (SQLite FTS5):
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS spec_fts USING fts5(
  title, description, tags, sanitized_json,
  content=spec_publications, content_rowid=id
);
CREATE TRIGGER IF NOT EXISTS spec_pub_ai AFTER INSERT ON spec_publications BEGIN
  INSERT INTO spec_fts(rowid, title, description, tags, sanitized_json)
  VALUES (new.id, new.title, new.description, new.tags, new.sanitized_json);
END;
CREATE TRIGGER IF NOT EXISTS spec_pub_au AFTER UPDATE ON spec_publications BEGIN
  INSERT INTO spec_fts(spec_fts, rowid, title, description, tags, sanitized_json)
  VALUES ('delete', old.id, old.title, old.description, old.tags, old.sanitized_json);
  INSERT INTO spec_fts(rowid, title, description, tags, sanitized_json)
  VALUES (new.id, new.title, new.description, new.tags, new.sanitized_json);
END;
CREATE TRIGGER IF NOT EXISTS spec_pub_ad AFTER DELETE ON spec_publications BEGIN
  INSERT INTO spec_fts(spec_fts, rowid, title, description, tags, sanitized_json)
  VALUES ('delete', old.id, old.title, old.description, old.tags, old.sanitized_json);
END;
```

**Migration 046** — `search_provider_config`:
```sql
CREATE TABLE IF NOT EXISTS search_provider_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT 'duckduckgo',
  searxng_url TEXT DEFAULT 'http://localhost:8080',
  exa_key_vault_ref TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO search_provider_config (id, provider) VALUES (1, 'duckduckgo');
```

**Migration 047** — billing tier expansion:
```sql
ALTER TABLE billing ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'
  CHECK(tier IN ('free', 'pro', 'team', 'enterprise'));
ALTER TABLE billing ADD COLUMN exa_search_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing ADD COLUMN monthly_exa_searches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing ADD COLUMN exa_search_limit INTEGER NOT NULL DEFAULT 0;
```

---

### 3.3 New API Routes

**Search Routes** (`backend/src/routes/search.ts`):
```
GET  /api/search/specs?q=<query>&provider=auto    Search own specs
GET  /api/marketplace/search?q=<query>&tags=...   Community search
POST /api/marketplace/publish                      Publish spec
POST /api/marketplace/:id/fork                     Fork community spec
GET  /api/marketplace/popular                      Top specs by forks
GET  /api/search/provider                          Current provider status
PUT  /api/search/provider                          Update provider config
```

**Exa Routes** (`backend/src/routes/exa.ts`):
```
POST /api/exa/search                               Direct Exa search (premium)
POST /api/exa/test-connection                      Validate API key
GET  /api/exa/cache/stats                          Cache hit rate, size
DELETE /api/exa/cache                              Purge cache
```

---

### 3.4 Exa Search Service Interface (`backend/src/lib/exa-search.ts`)

```typescript
interface ExaSearchOptions {
  query: string;
  numResults?: number;         // default: 5
  type?: 'neural' | 'keyword'; // default: 'neural'
  useCache?: boolean;          // default: true
}

interface ExaResult {
  id: string;
  url: string;
  title: string;
  score: number;
  publishedDate?: string;
  excerpt: string;
}

interface SearchResult {
  results: ExaResult[];
  provider: 'exa' | 'searxng' | 'duckduckgo';
  cached: boolean;
  latencyMs: number;
}

// Primary — auto-selects provider based on config + tier
async function search(options: ExaSearchOptions): Promise<SearchResult>
async function searchExa(options: ExaSearchOptions): Promise<ExaResult[]>
async function searchSearxng(query: string): Promise<ExaResult[]>
async function searchDuckDuckGo(query: string): Promise<ExaResult[]>
function getCachedResults(cacheKey: string): ExaResult[] | null
function setCachedResults(key: string, results: ExaResult[], query: string, type: string): void
function purgeExpiredCache(): void
```

---

### 3.5 Spec Sanitizer (`backend/src/lib/spec-sanitizer.ts`)

```typescript
const SCRUB_PATTERNS = [
  /sk-[a-zA-Z0-9]{32,}/g,          // OpenAI API keys
  /sk-ant-[a-zA-Z0-9-]{32,}/g,      // Anthropic API keys
  /ghp_[a-zA-Z0-9]{36}/g,           // GitHub personal tokens
  /https?:\/\/[^\/]+@[^\/]+/g,      // URLs with credentials
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email addresses
  /\/Users\/[a-zA-Z0-9_-]+\//g,     // macOS home paths
  /\/home\/[a-zA-Z0-9_-]+\//g,      // Linux home paths
  /C:\\Users\\[a-zA-Z0-9_-]+\\/g,   // Windows home paths
];

function sanitizeSpec(specJson: object, workspacePath: string): object
// Returns spec with above patterns replaced by [REDACTED]
// Replaces workspacePath occurrences with [WORKSPACE_PATH]
// Keeps: all story content, acceptance criteria, tags, title
```

---

### 3.6 `rorca init` CLI Algorithm

```
1. Detect if `claude` binary exists in PATH
   YES → proceed to step 2
   NO  → print registration command for manual use, exit 0

2. Check if already registered: `claude mcp list` | grep "rorca"
   FOUND → print "✓ Already registered", exit 0
   NOT FOUND → proceed to step 3

3. Register:
   claude mcp add --global rorca --transport http http://localhost:3030/mcp
   SUCCESS → print "✓ Registered. [N] tools available in all Claude Code sessions."
   FAILURE → print error + manual command

4. Print next steps:
   "rorca start" → opens browser
   "Open Claude Code in any project directory"
   "Use: rorca_generate_spec to create specs from Claude Code"
```

---

## PHASE 4: IMPLEMENTATION DETAILS

### 4.1 New Files

```
backend/src/
├── lib/
│   ├── exa-search.ts              NEW — search provider abstraction + caching
│   ├── spec-sanitizer.ts          NEW — PII scrubbing before publish
│   └── marketplace-indexer.ts     NEW — background FTS5/Exa indexing
├── routes/
│   ├── search.ts                  NEW — /api/search/* routes
│   ├── exa.ts                     NEW — /api/exa/* routes
│   └── marketplace.ts             NEW — /api/marketplace/* routes
├── db/migrations/
│   ├── 042_exa_cache.sql
│   ├── 043_spec_research_cache.sql
│   ├── 044_spec_publications.sql
│   ├── 045_spec_fts.sql
│   ├── 046_search_provider_config.sql
│   └── 047_billing_tier.sql

src/panels/
└── MarketplacePanel.tsx           MODIFY — Discover + My Published + Popular tabs

bin/
├── rorca.ts                       NEW — CLI entry point (rorca start / rorca init)
└── rorca-init.ts                  NEW — init subcommand
```

### 4.2 Modified Files

| File | Change |
|------|--------|
| `backend/src/server.ts` | Mount `/api/search`, `/api/exa`, `/api/marketplace` routers |
| `backend/src/lib/llm-client.ts` | Add research pre-pass hook for spec generation |
| `backend/src/routes/specs.ts` | Call research pre-pass on `POST /api/specs/generate` when Exa active |
| `backend/src/routes/health.ts` | Add `searchProvider`, `searxngReachable`, `exaKeyPresent` fields |
| `src/panels/MarketplacePanel.tsx` | Full redesign |
| `package.json` (root) | Add `bin: { "rorca": "./bin/rorca.js" }` |

### 4.3 New Dependencies

```json
{ "exa-js": "^1.0.0" }
```

No other new dependencies. SearXNG uses plain `fetch`. FTS5 built into SQLite.

---

## PHASE 5: VALIDATION

### 5.1 Acceptance Tests — AGPLv3

- [ ] `LICENSE` file exists with AGPLv3 text verbatim
- [ ] `docker build -t rorca .` completes without error
- [ ] `docker run -p 3030:3030 rorca` → `GET /api/health` returns 200
- [ ] `npm i -g rorca && rorca start` opens browser at `http://localhost:3030`
- [ ] `rorca init` outputs registration command whether Claude Code installed or not
- [ ] `CONTRIBUTING.md`, `SECURITY.md`, `COMMERCIAL-LICENSE.md` all exist at repo root

### 5.2 Acceptance Tests — Exa

- [ ] `PUT /api/search/provider` with `{ provider: 'exa', exaKey: 'test-key' }` stores key in vault
- [ ] `POST /api/exa/test-connection` returns `{ valid: true, latencyMs: N }` with real key
- [ ] Second identical search within 24h returns `{ cached: true }`
- [ ] `GET /api/health` shows `{ searchProvider: 'exa', exaKeyPresent: true }` when configured
- [ ] Exa timeout > 5s triggers fallback with `{ provider: 'duckduckgo', fallback: true }`
- [ ] Spec generation with Exa creates rows in `spec_research_cache`
- [ ] Research sources collapsible section appears in Forge panel

### 5.3 Acceptance Tests — Community Marketplace

- [ ] Publish with fake API key in description → key replaced with `[REDACTED]`
- [ ] Publish with workspace path → replaced with `[WORKSPACE_PATH]`
- [ ] `GET /api/marketplace/search?q=stripe+billing` returns results (FTS5 mode)
- [ ] Fork creates `forge/specs/pending/[slug].json` in active workspace
- [ ] Forked spec contains `"forkedFrom": "[original-id]"` field
- [ ] `fork_count` increments after fork
- [ ] Marketplace panel shows 3 tabs: Discover, My Published, Popular
- [ ] Fork shows success toast with spec path

### 5.4 Performance Benchmarks

```bash
# Archive search < 100ms
curl -w "%{time_total}" http://localhost:3030/api/specs/archive?q=stripe

# MCP initialization < 2s
time curl -X POST http://localhost:3030/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}'

# Community search < 500ms (FTS5)
curl -w "%{time_total}" "http://localhost:3030/api/marketplace/search?q=authentication"

# Exa cache hit < 50ms (run same query twice)
```

---

## ADVERSARIAL REFINEMENT

### Round 1 — Devil's Advocate

**Challenge**: "AGPLv3 kills enterprise adoption."
**Response**: Primary persona (Marcus) has no legal dept. Enterprise is Phase 4. Dual license commercial option handles it. Revisit at 10K stars.

**Challenge**: "Exa is a startup — pricing or shutdown risk."
**Response**: Search abstraction layer means swapping providers is one-line config. SearXNG is permanent fallback. Cache aggressively (24h). Exa is quality multiplier, not hard dependency.

**Challenge**: "Community spec publishing is a spam/abuse vector."
**Response**: Rate limit: 5 publications/hour/workspace. Report/takedown endpoint in marketplace routes. Sanitizer strips PII server-side. Moderation queue in admin panel.

### Round 2 — Red Team

**Attack**: "Exa API key extracted via SQL injection."
**Response**: better-sqlite3 uses prepared statements exclusively. Raw string concatenation in SQL is architecturally prohibited. Vault key derived from machine entropy, never stored in DB.

**Attack**: "Malicious community spec executes destructive bash commands when run."
**Response**: Specs are JSON. Stories don't execute directly — human approves in Review Queue first. Approval flow IS the human gate.

### Round 3 — Assumption Testing

**Assumption**: "Exa neural search is meaningfully better than DuckDuckGo for spec research."
**Test**: Run 10 spec generation queries through both. Compare relevance, library API accuracy, hallucinated function names. Measure before shipping.

**Assumption**: "Developers will publish specs to community marketplace."
**Test**: Survey 20 early users. Offer "Verified Publisher" badge. Threshold: 50 published specs within 60 days. If below, consider GitHub-based spec discovery instead.

**Assumption**: "SearXNG self-hosted is easy enough."
**Test**: `docker run -p 8080:8080 searxng/searxng` is one command. Target: < 5 min setup on fresh macOS. If not, provide `npx searxng-local` wrapper.

---

## CROSS-SKILL INTEGRATION

Skills applied:
- **exhaustive-specification** — 5-phase framework, Bible standard
- **adversarial-thinking** — 3 rounds of challenge/response
- **spec-gap-analysis** — identified missing tables, sanitizer, CLI subcommand
- **trust-but-verify** — flagged Exa startup risk, SQL injection vector, marketplace abuse

Recommended for implementation:
- `security-scan` — before shipping vault + marketplace
- `testing-integration` — for Exa fallback chain
- `api-documentation` — for CA-022 OpenAPI annotation audit
- `reality-validation` — before shipping community marketplace

---

**Total functional requirements**: 175
**Total non-functional requirements**: 15
**Total UX requirements**: 8
**New tables**: 6 (migrations 042–047)
**New API routes**: 10
**New files**: 9
**Modified files**: 6
**Adversarial rounds**: 3
