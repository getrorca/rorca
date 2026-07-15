# Lifecycle read API

`LFC-013` exposes evaluated, workspace-scoped lifecycle read models under `/api/lifecycle`. Clients must not join phase state from other APIs or submit phase status as input.

## Routes

| Route | Purpose | Tier |
|---|---|---|
| `GET /api/lifecycle` | Paginated portfolio and KPI aggregate | `auth` |
| `GET /api/lifecycle/specs/:specId` | Plan, readiness, traceability, run, and snapshot detail | `auth` |
| `GET /api/lifecycle/specs/:specId/phases/:phaseId` | One phase and paginated evidence | `auth` |
| `GET /api/lifecycle/evidence/:evidenceId` | Sanitized evidence metadata and raw-reference permission | `auth` |

Every request requires `workspaceId`. Detail requests may send the prior `snapshotId`; a mismatch returns `409 CONFLICT` with `details.type = "refresh_required"`, the current snapshot identity, and evidence/decision high-water marks.

## Bounds and ordering

- Portfolio page: default 25, maximum 100 specs; one workspace view is capped at 500 candidates.
- Phase evidence page: default 25, maximum 100.
- Evaluator input: latest 500 evidence and 200 decision records per spec.
- Traceability collections: maximum 200 entries with `total` and `truncated` metadata.
- Evidence order: `observed_at DESC, id DESC`.
- Decision order: `created_at DESC, id DESC`.
- Traceability ties: stable reference ID ascending.
- Portfolio sorts: `current_view`, `updated_desc`, `title_asc`, `risk_desc`, `readiness_desc`, and `owner_asc`, always tied by spec slug.

Evidence explicitly marked `revision_mismatch` remains inspectable but is excluded from gate satisfaction. Historical plans remain visible with stale state. Specs without a usable plan return `needs_compilation` and a safe compile route instead of failing.

## Local CI performance profile

The local CI profile is PostgreSQL 16 on loopback, Node 22, the canonical seeded 50-spec dataset (11 phases/spec), no response cache, one warm-up request, then 20 serial measured requests. Portfolio and phase-detail p95 must remain at or below 500 ms. The read path uses bulk snapshot queries and the indexes in `20260715180000_lifecycle_read_indexes.sql`; optimize query plans before introducing caching.
