# Lifecycle read API

`LFC-013` exposes evaluated, workspace-scoped lifecycle read models under `/api/lifecycle`. Clients must not join phase state from other APIs or submit phase status as input.

## Routes

| Route | Purpose | Tier |
|---|---|---|
| `GET /api/lifecycle` | Paginated portfolio and KPI aggregate | `auth` |
| `GET /api/lifecycle/specs/:specId` | Plan, readiness, traceability, run, and snapshot detail | `auth` |
| `GET /api/lifecycle/specs/:specId/phases/:phaseId` | One phase and paginated evidence | `auth` |
| `GET /api/lifecycle/evidence/:evidenceId` | Sanitized evidence metadata and raw-reference permission | `auth` |
| `GET /api/lifecycle/operations` | Bounded rollout/backfill progress and redacted 24-hour health counters | `admin` |

Every request requires `workspaceId`. Detail requests may send the prior `snapshotId`; a mismatch returns `409 CONFLICT` with `details.type = "refresh_required"`, the current snapshot identity, and evidence/decision high-water marks. The operations route is intentionally not a stable public/MCP contract: it exposes workspace-wide operator metadata, performs no mutation, and returns no raw evidence payload.

## Bounds and ordering

- Portfolio page: default 25, maximum 100 specs; one workspace view is capped at 500 candidates.
- Operations report: maximum 500 canonical specs, 50 unresolved compile failures/actions, a 100-spec blocked-phase inspection marked `truncated` when incomplete, and a fixed 24-hour event window.
- Phase evidence page: default 25, maximum 100.
- Evaluator input: latest 500 evidence and 200 decision records per spec.
- Traceability collections: maximum 200 entries with `total` and `truncated` metadata.
- Evidence order: `observed_at DESC, id DESC`.
- Decision order: `created_at DESC, id DESC`.
- Traceability ties: stable reference ID ascending.
- Portfolio sorts: `current_view`, `updated_desc`, `title_asc`, `risk_desc`, `readiness_desc`, and `owner_asc`, always tied by spec slug.

Evidence explicitly marked `revision_mismatch` remains inspectable but is excluded from gate satisfaction. Historical plans remain visible with stale state. Specs without a usable plan return `needs_compilation` and a safe compile route instead of failing.

## Traceability and evidence inspection

The spec detail response is the canonical bounded traceability view for its `snapshotId`. Each requirement includes mapped architecture decisions and stories, required gates, eligible current evidence, and retained historical/ineligible evidence. `blockers` records identify missing requirement→story, story→gate, gate→evidence, revision-lineage, and QA/merge/production coherence links with an exact remediation. The response also carries the bound plan/spec revision and the typed `spec_hash → commit_sha → artifact_digest → deployment_id` lineage. Missing and not-applicable lineage nodes are explicit and never receive synthesized identifiers.

QA, merge, and production bindings are evaluated from gate-eligible evidence for the same snapshot. A commit or artifact mismatch is release-blocking and prior evidence remains audit-visible. `graphContext` is optional enrichment only: the relational plan/evidence/decision ledger remains complete in Graph Lite, unavailable, and relational-only modes.

Evidence detail requests must send the snapshot that opened the inspector. Ledger changes return `409 refresh_required`; clients retain the audited item and offer an explicit refresh rather than silently replacing it. Detail payloads are normalized/redacted, bounded in the UI, and never include the raw source payload. `rawReference` is a server-classified descriptor: only existing run/log/PTY destinations, strict `https://github.com` check URLs, and bounded GitReins identities are allowlisted. Unknown schemes, provider lookalike hosts, filesystem references without an authorized run, and attachments remain copy-only.

## Portfolio KPI and view-state contract

`GET /api/lifecycle` computes KPI totals over the complete filtered result set, not only the current page. Alongside phase coverage it returns `activeSpecs`, `blockedSpecs`, `missingGates`, `readyForQa`, `waitingApprovals`, and `recentPhaseTransitions`. Recent transitions are phase-scoped `lifecycle_changed` WAL events from the last 24 hours; they remain derived audit data rather than mutable phase state.

Lifecycle Control keeps search, status, phase, risk, owner, blocked-only, sort, and pagination in URL query state. Filter changes reset to page one, and only search text is debounced. Compact mode and the last blocked-only choice are local display preferences. Saved views are a bounded, versioned local envelope containing only validated filters plus compact/page-size presentation values; evidence, approvals, and other lifecycle truth are never persisted in a view. Refreshes preserve the last readable snapshot and current URL selection while a replacement request is pending or fails.

## Local CI performance profile

The local CI profile is PostgreSQL 16 on loopback, Node 22, the canonical seeded 50-spec dataset (11 phases/spec), no response cache, one warm-up request, then 20 serial measured requests. Portfolio and phase-detail p95 must remain at or below 500 ms. The read path uses bulk snapshot queries and the indexes in `20260715180000_lifecycle_read_indexes.sql`; optimize query plans before introducing caching.
