# Rorca Launch Handoff Master

Date: 2026-06-19

This document consolidates the complete handoff so Alexis’s Hermes can finish the work end-to-end without re-deriving context.

---

## 0) What this handoff is for

Finish Rorca so it is **launch-ready** across three database paths:

1. **Local/native Postgres with AGE** → full graph
2. **Docker Postgres with AGE** → full graph
3. **BYOP hosted Postgres** (Supabase/Neon/etc.) → Graph Lite

Do this **without breaking Miguel’s setup work**.

Also finish the Hermes distribution story so Rorca skills are usable and truthful.

---

## 1) Executive summary

### What not to do

- Do **not** replace Rorca’s core architecture with SQLite.
- Do **not** replace Rorca’s core architecture with PGlite right now.
- Do **not** replace AGE-backed graph with a hosted-provider claim that promises full parity.
- Do **not** rewrite Miguel’s DB setup/bootstrap work unless a tiny adapter is truly required.

### What to do

- Add explicit DB mode selection for:
  - native/local Postgres
  - Docker Postgres with AGE
  - BYOP hosted Postgres
- Add canonical capability detection:
  - db mode
  - provider
  - extension support
  - graph mode
- Add **Graph Lite** for hosted Postgres providers that do not support Apache AGE.
- Update Knowledge Graph / memory / relevance UI to be honest in lite mode.
- Truth-fix Alexis’s install/docs/package/deploy story.
- Finish Hermes skill packaging and MCP verification.
- Treat BYOP connection strings as secrets: validate, persist safely, and redact in logs/API/UI.

### Core principle

> Keep full-graph local/Docker setup reliable, and add a capability-aware BYOP + Graph Lite layer above it.

---

## 2) Alexis PR — what it is and what to keep

Alexis’s PR is mostly **OSS onboarding / distribution / docs / packaging** work.

### Good parts

- multi-path install story (`npm`, `curl`, `Docker`, `Helm`)
- Supabase BYOP docs
- Hermes skill docs
- MCP integration docs
- README / Quickstart refresh
- migration / CI hygiene fixes

### Not ready as-is

- Docker install path is broken/incomplete
- Helm chart is incomplete
- Supabase compose override is invalid
- README / Quickstart overclaim in places
- It does **not** implement Graph Lite, DB mode UX, or capability detection

### What to keep

- CI/runtime fixes
- README/Quickstart direction (after accuracy pass)
- MCP integration docs (after truth alignment)
- Hermes skills distribution idea
- Supabase BYOP documentation (as optional path)

---

## 3) Miguel work — what it is and how it fits

Miguel’s work is **setup reliability / first-run / full-graph local+Docker** work.

### Key alignment

Miguel improved the full graph path by hardening DB setup:

- Docker Postgres image pinned to a Rorca-built image:
  - `rorca-postgres:pg16-age`
- Docker DB sidecar now builds/ensures the correct image
- stale/wrong container handling improved
- workspace default path detection added
- Pi detection/setup improved
- workspace creation defaults improved

### Why it matters

Miguel is making the **full graph** path reliable:

- local/native Postgres with AGE
- Docker Postgres with AGE

### Important boundary

Do **not** touch Miguel-owned setup internals unless absolutely needed.

Miguel owns:

> “Can Rorca reliably start local/Docker Postgres with AGE?”

You own:

> “Can Rorca understand which DB mode it is in, support BYOP/Supabase, and degrade graph UX honestly?”

---

## 4) Unified product direction

The product should support three clear DB experiences:

| Mode | Meaning | Graph |
|---|---|---|
| `native` | Rorca-managed local Postgres | Full Graph |
| `docker` | Docker Postgres with AGE | Full Graph |
| `byop` | User-provided hosted Postgres (Supabase/Neon/etc.) | Graph Lite |

---

## 5) The four focus areas

### A. Supabase/BYOP handling

- Accept and persist external `DATABASE_URL`
- Treat remote DBs as `byop`
- Support Supabase, Neon, RDS, Cloud SQL, etc.
- Do not depend on local DB bootstrap for BYOP
- Redact credentials in every API response, log line, toast, and UI field
- Validate connection health without printing passwords or tokens
- Be explicit that Supabase/Neon may require direct DB connections for some worker/listener behavior; pooler mode should be documented and tested where practical

### B. Graph Lite

Introduce a graph capability model:

```ts
graphMode: 'full' | 'lite' | 'disabled'
```

Rules:

- `full` = AGE available
- `lite` = Postgres available, AGE missing
- `disabled` = neither graph path is usable

Graph Lite should use:

- relational tables
- recursive SQL / bounded traversal
- semantic fallback
- not AGE/Cypher

### C. Knowledge Graph UI fallback

UI should:

- show **Full Graph** for local/Docker+AGE
- show **Graph Lite** for Supabase/BYOP
- never present scary opaque failures when AGE is missing
- explain clearly what’s missing and how to get full graph back

### D. Explicit DB-mode selection UX

Add a user-facing chooser:

- Local managed Postgres
- Docker Postgres with AGE
- BYOP hosted Postgres

This should show:

- mode
- graph capability
- tradeoffs
- connection status
- saved choice

---

## 6) Backend changes needed

### 6.1 Canonical capability model

Add a single source of truth for:

- dbMode
- provider
- extension support
- graphMode

Example shape:

```ts
{
  dbMode: 'native' | 'docker' | 'byop',
  provider: 'local' | 'docker' | 'supabase' | 'neon' | 'unknown',
  extensions: {
    vector: true,
    age: false
  },
  graphMode: 'full' | 'lite' | 'disabled',
  warnings: []
}
```

### 6.2 Capability API

Expose the capability model in a health/status endpoint so the frontend and operator surfaces can use it.

Suggested surface:

- `GET /api/database/status` or a capability block inside existing `/api/health`
- optional `POST /api/database/configure` for DB mode changes if this is not already covered by an existing config route

The response must redact connection strings. If a URL must be shown, show only provider/host/database metadata, never password/user secrets.

### 6.3 Graph abstraction

Split graph behavior by provider/capability:

- `age-graph-provider.ts`
- `relational-graph-provider.ts`
- `graph-capabilities.ts`

### 6.4 AGE-only admin routes stay gated

Some routes can remain AGE-only:

- graph backfill
- graph stats
- other admin maintenance paths

But product-facing graph surfaces should degrade gracefully.

### 6.5 Likely backend file targets

Use these as orientation, not as a hard mandate:

- `backend/src/lib/db-strategy.ts` — existing DB mode detection; avoid rewriting Miguel’s setup behavior
- `backend/src/lib/age-guard.ts` — existing AGE availability guard; promote capability information without making all product routes hard-fail
- `backend/src/routes/health.ts` — existing health response already reports extension status; extend or reuse for graph mode
- `backend/src/routes/config.ts` or a new conservative database route — DB mode/config/status surface
- `backend/src/lib/knowledge-graph.ts` — AGE-backed graph behavior
- `backend/src/lib/memory-graph.ts` — memory graph fallback candidate
- `backend/src/lib/spec-relevance-graph.ts` — spec/context relevance fallback candidate
- `backend/src/routes/spec-relevance-graph.ts` and `backend/src/routes/memory.ts` — product-facing graph routes that should degrade cleanly

Do not rewrite `backend/src/lib/db-sidecar.ts`, native Postgres bootstrap, or Miguel’s Docker image lifecycle unless the integration absolutely requires a tiny adapter.

---

## 7) UI behavior by DB mode

| Feature | Local/Docker with AGE | Supabase/BYOP without AGE |
|---|---|---|
| Specs | Full | Full |
| Runs | Full | Full |
| Memory ledger | Full | Full |
| Story dependency graph | Full | Full |
| Retrieval | Full | Mostly full |
| Memory graph | Full | Lite |
| Spec relevance graph | Full | Semantic/Lite |
| AGE knowledge graph | Full | Unavailable / Lite fallback |
| Graph backfill admin | Enabled | Disabled |
| Graph stats admin | Enabled | Disabled or Lite stats |

### UI copy guidance

For Supabase/BYOP:

> Graph Lite: Apache AGE is unavailable. Rorca is using table-backed graph traversal.

For local/Docker AGE:

> Full Graph enabled. Apache AGE and pgvector are available.

---

## 8) What to change in Knowledge Graph UI

Rorca has multiple graph-related surfaces; not all are AGE-dependent.

### A. Story dependency graph

This is **not AGE-dependent**.
It comes from spec story dependencies and should remain normal on all DB modes.

### B. Memory ontology graph

This can be mostly **Graph Lite** when AGE is unavailable.
Use relational storage and bounded traversal.

### C. Spec relevance graph / context graph

Should degrade to semantic/relational-lite graph rather than fail hard.

### D. AGE knowledge graph tab

When AGE is missing:

- do not show a scary opaque error
- show a Graph Lite banner
- explain what is unavailable
- offer guidance for getting Full Graph back

### E. Likely frontend file targets

Use these as orientation:

- `src/panels/WorkspaceSettingsPanel.tsx` or related settings panels — DB mode/capability display and selector placement
- `src/panels/settings/KnowledgeGraphSection.tsx` — full/lite/disabled graph capability messaging
- `src/components/RelevanceGraphView.tsx` — existing semantic-only/fallback messaging can become official Graph Lite UX
- `src/components/SpecRelevanceGraph.tsx` / `src/components/PreFlightGraph.tsx` — graph fallback and empty-state messaging
- `src/panels/HealthDashboardPanel.tsx` — surface graph capability in health/analytics context
- shared API/types modules — add typed `graphMode` and capability response types

Keep all API calls through `src/lib/apiFetch`.

---

## 9) What to avoid touching

Avoid these unless a thin adapter is absolutely required:

- `db-sidecar`
- native bootstrap
- Pi detection
- workspace defaults
- Docker image build/start logic
- Miguel’s setup branch/files

---

## 10) Hermes integration plan

Hermes support should be treated as:

> Rorca skills + MCP discovery + honest docs + publishable install path

### Skills to package

- `rorca-spec-orchestration`
- `rorca-memory-retrieval`
- `rorca-spec-templates`

Each skill should:

- reference the correct MCP server
- use the exact current tool names
- match Rorca’s tiered MCP contract
- describe the workflow in Hermes language

### MCP verification

Hermes must be able to register and discover Rorca tools:

```bash
hermes mcp add rorca --url http://localhost:3030/mcp
hermes mcp test rorca
```

Minimum discovery target:

- `rorca_create_spec`
- `rorca_get_context`
- `rorca_list_specs`
- `rorca_approve_spec`
- `rorca_pipeline_trigger`
- `rorca_trigger_task_manifest`
- `rorca_pipeline_status`

### Hermes workflow

Rorca owns two execution lanes:

- **Mode A — Rorca delegated execution:** brief → spec → approve → Rorca run → PR/evidence/memory.
- **Mode B — Hermes task-manifest execution via Rorca broker:** Rorca spec/context → Hermes task manifest/`tasks.md` → Rorca provider broker → PR/evidence/memory.

Operational rules:

- use `rorca_create_spec` for explicit spec creation
- use `rorca_get_context` before drafting/running
- use `POST /api/pipeline/task-manifests/trigger` / `rorca_trigger_task_manifest` only for bounded manifests with branch/PR-only, `autoMerge=false`, dry-run support, no deploys, no credential copying, no production DB writes, and no secret mutation
- avoid legacy generate flow unless explicitly needed
- route new features, broad architecture, high-risk security/data/ops, ambiguous scope, missing context, policy mismatch, or scope expansion back to normal Rorca spec/run

### Hermes non-goals

- do not replace Pi or first-party Rorca surfaces
- do not duplicate provider/model interoperability; Hermes passes agent/model intent to Rorca
- do not build a separate Hermes marketplace
- do not couple Hermes support to SQLite/PGlite decisions
- do not change Miguel’s DB setup work to force Hermes support

---

## 11) Alexis Hermes addendum — what it should cover

The Hermes addendum should include:

### Install path

- how to install skills
- how to register MCP
- how to test discovery

### Expected workflow

- Mode A: brief → spec → review → approve → run → inspect
- Mode B: Rorca spec/context → Hermes task manifest/`tasks.md` → Rorca broker → PR/evidence/memory

### Failure modes

- missing MCP server
- missing/incorrect tool names
- tier mismatch
- stale skill docs
- install path succeeds but discovery fails

### Acceptance criteria

- Hermes can discover Rorca tools
- Hermes can create a spec from a brief using the skill
- Hermes can approve/run/status a spec using the skill
- skill docs match the current Rorca contract

---

## 12) What to do about Alexis’s PR artifacts

### Merge/cherry-pick immediately

- migration timestamp fix
- Jest DB mode fix
- CI `DATABASE_URL_TEST`
- verify-pack fix
- shebang/license fixes

### Merge after truth-alignment edits

- README rewrite
- QUICKSTART
- MCP integration guide
- Supabase setup guide
- Hermes skills docs/examples

### Do not merge as-is

- `install.sh`
- Docker one-liner docs
- `docker-compose.supabase.yml`
- Helm chart

### Spin out into separate RFC/spike

- PGlite experimental mode
- SQLite backend
- Helm production deployment hardening

Graph Lite is **not** a separate future spike for this launch handoff; it is in scope for `database-mode-selection-byop-supabase-graph-lite-fallback`.

---

## 13) Current active spec to finish

The focused spec created for this direction is:

**`database-mode-selection-byop-supabase-graph-lite-fallback`**

It covers:

- Supabase/BYOP handling
- Graph Lite fallback
- Knowledge Graph UI fallback
- explicit DB-mode selection UX
- tests/compatibility
- with clear non-goals around Miguel’s setup work

---

## 14) Existing policy-driven orchestration graph restart

The previously approved spec that was restarted is:

**`policy-driven-post-save-orchestration-graph`**

Fresh run:

- `20260316000397`
- sequential
- `pi`
- `openai-codex/gpt-5.4`
- worktree: `/Users/dimitriteravanessian/rorca-feat-policy-driven-post-save-orchestration-graph`

---

## 15) Recommended implementation order

1. Add/centralize the DB capability model.
2. Expose capability status via backend API with redacted BYOP metadata.
3. Add BYOP/Supabase/Neon configuration and validation flow.
4. Add graph provider/fallback selection from `graphMode`.
5. Convert product-facing graph routes to graceful full/lite/disabled responses.
6. Add DB mode selector and capability badges in settings/onboarding.
7. Update Knowledge Graph, memory graph, and relevance graph UI fallback states.
8. Verify Hermes skill docs/tool names/MCP discovery.
9. Truth-fix README, Quickstart, Supabase, MCP, and Hermes docs.
10. Run regression tests against Miguel’s local/Docker setup path.

---

## 16) PR split recommendation

Prefer split PRs over one giant PR:

1. **Miguel setup PR hardening** — Docker/native full-graph setup reliability only.
2. **Capability/BYOP backend PR** — capability model, redacted status/config APIs, BYOP validation.
3. **Graph Lite PR** — backend graph provider/fallback behavior and route contracts.
4. **UI PR** — DB selector, graph mode badges, Knowledge Graph fallback states.
5. **Hermes/docs PR** — skills, MCP verification docs, README/Quickstart truth alignment.

If Alexis’s Hermes is finishing everything in one branch, keep commits grouped according to this split.

---

## 17) Validation commands and checks

Minimum checks before calling it launch-ready:

```bash
npm run typecheck
cd backend && npx tsc --noEmit
npx vitest run
cd backend && npm test
```

Manual smoke checks:

- local/native DB mode starts and reports Full Graph when AGE is present
- Docker DB mode starts and reports Full Graph when AGE is present
- BYOP Supabase-like URL validates and reports Graph Lite when AGE is absent
- Knowledge Graph UI does not hard-error in Graph Lite
- story dependency graph still works in every mode
- memory/relevance graph surfaces show fallback/lite messaging when applicable
- Hermes can register MCP and discover intended tools

For Alexis PR artifacts specifically:

```bash
bash -n install.sh
SUPABASE_DB_URL='postgresql://user:pass@example.supabase.co:6543/postgres' \
  docker compose -f docker-compose.yml -f docker-compose.supabase.yml config
helm lint helm/rorca
```

These should pass or the corresponding install/deploy path should be removed from launch docs until fixed.

---

## 18) Launch-ready definition

Rorca is launch-ready when:

### Full graph paths

- Local/native Postgres with AGE works
- Docker Postgres with AGE works

### BYOP paths

- Supabase/Neon/etc. connect via `DATABASE_URL`
- Graph Lite works instead of hard failing

### UI

- DB mode is explicit
- graph capability is visible
- knowledge graph screens degrade gracefully

### Docs

- README/Quickstart are truthful
- install paths match reality
- Supabase is documented as BYOP
- Helm/Docker are valid or removed until valid

### Tests

- mode detection tests
- AGE present/absent tests
- Graph Lite fallback tests
- UI fallback tests
- no regression to Miguel’s setup work

---

## 19) One-line direction for Hermes

> Finish Rorca’s DB-mode layer above Miguel’s setup work: support native/Docker full-graph and BYOP Supabase/Neon lite-graph, add explicit mode selection and honest UI fallback, truth-fix Alexis’s install/docs, and verify Hermes skill distribution end-to-end.
