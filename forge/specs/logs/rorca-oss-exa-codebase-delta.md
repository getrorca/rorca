# Rorca OSS + Exa + Marketplace — Codebase Delta
**Spec**: rorca-oss-exa-marketplace
**Date**: 2026-03-02

---

## Summary

| Category | File Count | Estimated Lines |
|----------|-----------|-----------------|
| **Keep as-is** | ~120 files | ~28,000 lines untouched |
| **Modify** | 8 files | ~200 lines changed |
| **Add net new** | 15 files | ~1,800 lines added |

**Verdict**: ~93% of the codebase is untouched. This is a surface-area-minimal feature addition.

---

## KEEP AS-IS (zero changes)

### Core Execution Engine
| File | Why untouched |
|------|--------------|
| `backend/src/lib/execution-engine.ts` | Story execution not affected |
| `backend/src/lib/run-loop.ts` | Legacy loop unchanged |
| `backend/src/lib/sse-hub.ts` | SSE pub/sub unchanged |
| `backend/src/lib/direction-stack.ts` | Direction stack unchanged |
| `backend/src/lib/context-router.ts` | Context routing unchanged |
| `backend/src/lib/workspace-echolocation.ts` | Workspace scanning unchanged |
| `backend/src/lib/scheduler.ts` | Scheduler unchanged (just adds Exa purge job) |
| `backend/src/lib/mcp-http.ts` | Auto-generates tools from new routes automatically |

### All Existing Route Files (32 files)
Every existing route in `backend/src/routes/` is untouched:
- `specs.ts` — only the generate endpoint gets a pre-pass hook (see Modify section)
- `pipeline.ts`, `workspaces.ts`, `direction.ts`, `analytics.ts`, etc. — zero changes
- All 36 existing DB migrations — zero changes

### All Existing Frontend Panels (21 of 22 panels)
Every panel except `MarketplacePanel.tsx`:
- `ArchivePanel.tsx`, `ForgePanel.tsx`, `PipelineMonitorPanel.tsx`, etc.
- All contexts: `WorkspaceContext`, `AuthContext`, `ThemeContext`, `ToastContext`
- All shared components except Settings panel (see Modify)
- `Sidebar.tsx` — `marketplace` PanelId already exists, zero changes needed

### Database (all 41 existing migrations)
All existing tables untouched:
- `workspaces`, `pipeline_runs`, `story_results`, `wal_events`
- `direction_layers`, `spec_versions`, `spec_tag_assignments`
- `vault_keys` (reused as-is for Exa key storage)
- `billing` (modified in migration 047, not the migration file itself)
- All 41 existing SQL migration files unchanged

---

## MODIFY (existing files changed)

| File | What Changes | Lines Changed (est.) |
|------|-------------|---------------------|
| `backend/src/server.ts` | Mount 3 new routers: `/api/search`, `/api/exa`, `/api/marketplace` | +8 lines |
| `backend/src/routes/specs.ts` | Add research pre-pass call in `POST /api/specs/generate` handler | +25 lines |
| `backend/src/routes/health.ts` | Add `searchProvider`, `searxngReachable`, `exaKeyPresent` fields to health response | +20 lines |
| `backend/src/lib/scheduler.ts` | Add daily 03:00 job calling `purgeExpiredCache()` | +8 lines |
| `src/panels/MarketplacePanel.tsx` | Full redesign: 3 tabs (Discover, My Published, Popular), search + fork UI | ~300 lines rewritten (was ~150, becomes ~450) |
| `src/panels/SettingsPanel.tsx` (or equivalent) | Add search provider selector section in Model & Providers tab | +80 lines |
| `src/panels/ArchivePanel.tsx` | Add 'Publish to Community' button + publish modal in spec detail pane | +60 lines |
| `src/panels/ForgePanel.tsx` | Add Research Sources collapsible section below generated spec | +50 lines |

**Total lines modified: ~550**

### Key constraint: non-breaking changes only
- `specs.ts` pre-pass is behind `if (searchProvider === 'exa')` — zero behavior change for default users
- `health.ts` additions are additive — no existing fields removed
- `MarketplacePanel.tsx` was previously a templates list — full redesign but same PanelId, same mount point

---

## ADD NET NEW

### Backend Libraries
| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `backend/src/lib/exa-search.ts` | Search provider abstraction: Exa + SearXNG + DuckDuckGo + caching + fallback | ~220 |
| `backend/src/lib/spec-sanitizer.ts` | PII scrubbing before community publish | ~80 |
| `backend/src/lib/marketplace-indexer.ts` | Background FTS5 trigger management + Exa index sync | ~60 |

### Backend Routes
| File | Endpoints | Lines (est.) |
|------|-----------|-------------|
| `backend/src/routes/exa.ts` | POST /api/exa/test-connection, GET /api/exa/cache/stats, DELETE /api/exa/cache | ~90 |
| `backend/src/routes/search.ts` | GET /api/search/specs, GET /api/search/provider, PUT /api/search/provider | ~80 |
| `backend/src/routes/marketplace.ts` | POST /publish, POST /:id/fork, DELETE /:id, GET /popular, GET /search | ~180 |

### Database Migrations
| File | Creates | Lines (est.) |
|------|---------|-------------|
| `042_exa_cache.sql` | exa_cache table + 2 indexes | ~15 |
| `043_spec_research_cache.sql` | spec_research_cache table + 1 index | ~15 |
| `044_spec_publications.sql` | spec_publications table + 3 indexes | ~25 |
| `045_spec_fts.sql` | spec_fts FTS5 virtual table + 3 triggers | ~30 |
| `046_search_provider_config.sql` | search_provider_config table + default row | ~12 |
| `047_billing_tier.sql` | 4 new columns on billing (pragma check pattern) | ~15 |

### CLI
| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `bin/rorca.ts` | CLI entry point: rorca start, rorca init, rorca --version | ~80 |
| `bin/rorca-init.ts` | MCP global registration logic | ~60 |

### CI/CD & OSS Files
| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `.github/workflows/ci.yml` | GitHub Actions CI (typecheck + tests + lint) | ~60 |
| `Dockerfile` | Multi-stage build, frontend + backend in one image | ~40 |
| `docker-compose.yml` | Single-command local deployment with volume | ~25 |
| `LICENSE` | AGPLv3 full text | ~674 |
| `CONTRIBUTING.md` | Contribution guide | ~80 |
| `SECURITY.md` | Responsible disclosure | ~30 |
| `COMMERCIAL-LICENSE.md` | Dual license explanation | ~40 |

**Total net new lines: ~1,910**

---

## The 93% Number — Why It's Right

The Rorca codebase is ~30,000 lines. The execution engine, direction stack, WAL system, SSE hub, pipeline monitoring, all 21 non-Marketplace panels, all 32 existing routes — none of it is touched.

This feature set (OSS + Exa + marketplace) is an **additive layer** on top of the existing platform:

```
Existing Rorca (28,000 lines, untouched)
    +
New search abstraction layer (360 lines)
    +
New marketplace routes + sanitizer (350 lines)
    +
New migrations (112 lines)
    +
UI changes to 4 existing panels (490 lines)
    +
CLI + CI/CD + OSS files (1,009 lines)
```

The only meaningful rewrites are:
1. `MarketplacePanel.tsx` — was a template list, becomes a full community hub
2. `bin/` — new CLI entry point that didn't exist

Everything else is surgical additions. No architectural changes. No breaking changes to existing API contracts.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|---------|-----------|
| `spec_publications` FTS5 triggers slow down inserts | Low | Bench at 10K rows — FTS5 inserts are <1ms |
| Exa SDK adds bundle weight to backend | Low | exa-js is backend-only, not in frontend bundle |
| MarketplacePanel rewrite breaks existing template browsing | Medium | Templates route (`/api/templates`) unchanged — if needed, Templates tab can be added as 4th tab |
| `billing` ALTER TABLE migration fails on existing DB | Low | Uses `pragma table_info` check pattern — idempotent |
| Docker image > 500MB | Low | Alpine base + multi-stage build keeps it well under |
