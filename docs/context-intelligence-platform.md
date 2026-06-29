# Rorca Context Intelligence Platform — Architecture Contract & Wave Plan

> **Spec:** `rorca-context-intelligence-platform` · **Story:** US-001 (Architecture contract and wave plan)
> **Status:** Canonical design doc. Every other story in this spec (US-002 … US-042) treats the
> subsystem boundaries, source-of-truth rules, exclusions, and shared contracts defined here as fixed.
> If a later story needs to change one of these contracts, it must update this doc in the same change.

This document is the single source of truth for **what the Context Intelligence Platform is, what it is
not, where durable truth lives, and how the 42 implementation stories may be executed in wave-parallel
fashion**. It is intentionally prescriptive: it exists so that a contributor (human or agent) implementing
any later story can do so without re-deriving the architecture.

---

## 1. Purpose

Rorca's spec quality is bounded by the quality of the **context** it assembles before a brief becomes a
spec and before a story becomes a run. Today that context comes from the Direction Stack, the memory
ledger, hybrid search, and the Apache AGE knowledge graph (see `docs/context-injection.md` and
`docs/graph-rag-deep-dive.md`). The knowledge graph, however, is not yet fed accurate code-structure
evidence, and there is no reviewed, governed path for capturing knowledge from outside a Rorca run.

The Context Intelligence Platform closes those gaps with five cooperating subsystems that:

1. **Hydrate** a workspace's real code structure into rebuildable graph metadata (via **Hilo**).
2. **Retrieve and rank** the most relevant files, docs, and memories for a given brief, explainably.
3. **Compose** that retrieval output into a bounded, cited, prompt-ready context bundle for spec creation.
4. **Capture** knowledge from outside Rorca runs (commits, manual notes, VM/server repos) via an offline-tolerant **sidecar**.
5. **Govern** captured knowledge through human review before it is ever allowed to influence retrieval.

The platform is **graph-first, offline-tolerant, review-gated, and adapter-free** in this spec.

---

## 2. Subsystems

The platform has exactly five subsystems. Every story in this spec belongs to one of them (plus a
cross-cutting "Foundations" group). The canonical names below are used throughout the codebase, the wave
map, and the operator docs.

### 2.1 Hilo Hydration
**Stories:** US-006 → US-012 (config, runner, normalization, staleness, APIs, background execution, health UI).

Hilo is an external **codegraph** provider. Hydration runs Hilo over a workspace checkout and normalizes
its edge/classification output into Rorca's `GraphEdge` / `GraphFileNode` shapes: file nodes, imports,
reverse importers, tests/tested_by, roles, and relation counts (US-008). Hydration is **graph-only** — no
FUSE, no xattrs, no inotify triggers, no remote backend is required (US-006). Hydration status, freshness
(keyed to git SHA), counts, duration, and errors are tracked in a dedicated table (US-003), staleness is
detected against the current SHA (US-009), and execution is bounded, coalesced, and observable
(US-011, US-012).

### 2.2 Retrieval / Ranking
**Stories:** US-013 → US-019 (seed retrieval, graph expansion, ranker, excerpts/budget, trace, retrieval API).

Given a brief, retrieval produces candidate files, docs, and memories through three signals: brief-to-seed
file/doc retrieval (US-013), memory and prior-spec seeds (US-014), and **Hilo graph neighborhood
expansion** around the seeds (US-015). An **explainable, deterministic ranker** (US-016) blends
keyword/semantic signal, graph distance, relation type, file role, tests/entrypoints, git recency, memory
relevance, and trust/authority — every candidate carries a normalized score **and a per-signal breakdown**.
Ranked items become **bounded, redacted, provenance-tagged excerpts** under section-level token budgets
(US-017). Every retrieval is persisted as a replayable **trace** (US-018) and exposed through a single
brief-aware retrieval API (US-019).

### 2.3 Context Composition
**Stories:** US-020 → US-024 (bundle schema, composer service, spec wiring, preview UI, diff awareness).

Composition turns retrieval output into a versioned, prompt-facing **`SpecContextBundle`** (US-020):
ordered sections for directions, memories, docs, source files, tests, graph summary, current branch diff,
risks/gotchas, token accounting, and trace IDs — with provenance/reason/confidence/trust on every item.
The composer service (US-021) is deterministic, budget-aware, and degrades cleanly when Hilo is absent. It
is wired into spec generation and explicit-draft persistence **without breaking existing create/persist/
readiness contracts** (US-022), surfaced as a pre-creation preview (US-023), and enriched with current
branch diff awareness (US-024).

### 2.4 Capture Sidecar
**Stories:** US-025 → US-031 (CLI skeleton, API client + queue, remember, commit metadata, ingest, git hook, daemon).

`rorca-capture` is a **local/VM sidecar CLI** that submits context events and memory candidates to Rorca
over its public ingestion APIs (US-025, US-032). It never writes to the Rorca DB directly. It tolerates
being offline: submissions fall back to a **local JSONL queue** with idempotency keys and are flushed when
connectivity returns (US-026). It supports a `remember` command (US-027), git commit metadata extraction
(US-028), `ingest-commit` / `ingest-git` (US-029), a safe, reversible git hook installer (US-030), and a
bounded **VM/server daemon reconciliation mode** for repos that live where Rorca runs (US-031).

### 2.5 Candidate Governance
**Stories:** US-032 → US-037 (ingestion routes, list/detail, review actions, retrieval gating, review UI, provenance).

Captured knowledge enters as **reviewable memory candidates**, never as durable memory. Ingestion routes
(US-032) validate, sanitize, redact, and de-duplicate via idempotency. Reviewers list/filter/inspect
candidates (US-033) and take review actions — approve, edit-and-approve, reject, duplicate, supersede,
revisit (US-034). **The governance gate is absolute:** pending/rejected/duplicate/superseded candidates
**never** enter default retrieval or prompt composition; only an approved candidate promoted through the
existing durable memory path becomes retrievable (US-035). A review UI (US-036) and provenance/related-file
previews (US-037) make review safe and auditable.

### 2.6 Foundations (cross-cutting)
**Stories:** US-002 (shared TS contracts), US-003/US-004 (DB schema), US-005 (safety primitives),
US-038 (observability), US-039 (limits/concurrency/cache), US-040 (E2E fixtures), US-041 (docs),
US-042 (final validation).

These are shared by all five subsystems and define the contracts the wave map depends on.

---

## 3. Source-of-Truth Boundaries

The platform stores state in four places. **Each store has exactly one role, and those roles do not
overlap.** This is the most important invariant in the spec; violating it is a correctness bug, not a
style choice.

| Store | Role | Durable truth? | Rebuildable? |
|---|---|---|---|
| **Hilo graph** | Rebuildable **codegraph data** | **No** | **Yes — always** |
| **Rorca DB (PostgreSQL)** | Durable **reviewed state** | **Yes — system of record** | No (must be backed up) |
| **Local queue (JSONL)** | **Offline buffer** for the capture sidecar | No | N/A (drained, then truth lives in DB) |
| **Redis** | **Cache only** | **No** | **Yes — always** |

The four binding statements:

1. **The Hilo graph is rebuildable codegraph data.** It is a derived projection of the source tree at a
   given git SHA. It may be deleted and re-hydrated at any time with no loss of durable state. Nothing
   may treat the Hilo graph as a system of record. Hydration freshness is keyed to git SHA so a stale
   graph is detectable and re-buildable (US-003, US-009).

2. **The Rorca DB stores durable, reviewed state.** Hydration status, context events, memory candidates,
   review decisions, retrieval traces, and promoted durable memories live here (US-003, US-004, US-018,
   US-034). The DB is the **only** system of record. External tools (the capture sidecar included) must
   write through Rorca APIs, **never** by direct DB writes (US-032).

3. **The local queue is an offline buffer.** The capture sidecar's JSONL queue exists solely to survive
   API downtime. It holds versioned, redacted, idempotency-keyed payloads, and is **idempotently flushed**
   into the DB through ingestion routes; once flushed, the DB is the truth and the queue entry is disposable
   (US-026, US-031). The queue is never read by retrieval or composition.

4. **Redis is cache-only.** Any value placed in Redis (hydration results, retrieval candidates, composed
   bundles, status rollups) must be **reconstructable from the DB and/or a fresh Hilo hydration**. Cache
   keys include workspace + git SHA / file hash + brief hash + retrieval policy and are invalidated on
   staleness (US-039). Losing Redis entirely degrades performance only — never correctness, never durable
   state. Redis must never be the only home of any reviewed or captured datum.

**Practical consequence for implementers:** if you are about to persist something that a human reviewed or
approved, it goes in the **Rorca DB**. If you are about to persist something derived from code structure, it
goes in the **Hilo graph** (or a Redis cache of it). If you are buffering a sidecar submission while offline,
it goes in the **local queue**. If you are speeding up a read, it goes in **Redis** — and only Redis.

---

## 4. Explicitly Excluded Adapters

This spec is **deliberately adapter-free**. The following integrations are **out of scope** and **must not
be built, imported, or assumed** by any story in `rorca-context-intelligence-platform`:

- **Hermes** — Hermes is an external distribution channel for Rorca skills/MCP (see
  `docs/alexis-hermes-integration-addendum.md`). It is **not** a context source for this platform and is
  excluded here.
- **DuckBrain** — DuckBrain informs OSS hygiene/release discipline only (see
  `docs/duckbrain-gap-analysis.md`); its product design is **not** copied or integrated. Excluded.
- **GitHub** — no GitHub API, webhook, app, or OAuth-based context ingestion. Git evidence in this spec
  comes from the **local** git repository via the capture sidecar (US-028, US-029), not from GitHub.
- **Linear** — no Linear issues, projects, or comments as a context source. Excluded.
- **Slack / Sentry / incident adapters** — no chat, error-tracking, alerting, or incident-management
  ingestion. Excluded.

**Why exclude them now:** these adapters would each introduce networked dependencies, auth surfaces, and
trust/provenance questions that the candidate-governance model is not yet sized for. The capture sidecar is
the **single, narrow, offline-tolerant** ingestion path for this spec. Adapters are a future spec that would
plug into the same `context_events` / `memory_candidates` governance pipeline defined here — but they are
not part of US-001 … US-042. Any PR that adds one of the excluded integrations to this spec is out of scope
and should be rejected.

---

## 5. Data Flow (end to end)

```
            ┌─────────────────────────── CAPTURE PLANE (review-gated) ──────────────────────────┐
 commits ─▶ rorca-capture ─▶ (offline? ─▶ local JSONL queue) ─▶ POST /ingestion ─▶ context_events
 manual ─▶  (sidecar CLI)                                         (US-032)          memory_candidates
 notes                                                                                   │ (PENDING)
                                                                                         ▼
                                                              candidate review: approve / edit / reject
                                                                 / duplicate / supersede  (US-034)
                                                                                         │ approve
                                                                                         ▼
                                                              promote → DURABLE MEMORY (existing path)
                                                                                         │
            ┌──────────────────────────── RETRIEVAL PLANE ──────────────────────────────┘
            ▼
 brief ─▶ seed retrieval (files/docs US-013, memory/prior-spec US-014)
            │                                  ▲ approved durable memory only (US-035 gate)
            ▼
        Hilo graph expansion (US-015)  ◀── Hilo hydration (US-007/008), freshness by git SHA (US-009)
            ▼
        explainable ranker (US-016) ─▶ bounded excerpts + token budget (US-017) ─▶ retrieval trace (US-018)
            ▼
        brief-aware retrieval API (US-019)
            ▼
        SpecContextBundle composition (US-020/021) ─▶ wired into spec generate/persist (US-022)
            ▼
        Rorca spec creation  +  context preview UI (US-023)

 Caches (Redis): hydration results, retrieval candidates, composed bundles — keyed by git SHA / file /
 brief hash, invalidated on staleness (US-039). Never a source of truth.
```

The **governance gate (US-035)** is the membrane between the capture plane and the retrieval plane: nothing
captured influences retrieval until a human approves it and it is promoted to durable memory.

---

## 6. Shared Contracts

These are the artifacts that cross story boundaries. They are the reason the wave map works: once a shared
contract is delivered, every dependent story can be implemented against it in parallel. Changing one of
these after delivery is a breaking change that must update all consumers.

| Contract | Owner story | Consumers |
|---|---|---|
| **Shared TS validators/types** (hydration, graph metadata, retrieval candidates/traces, context bundles, context events, memory candidates, trust tiers, review actions; all version-stamped) | **US-002** | backend, frontend, CLI — nearly every story |
| **Workspace hydration schema** (`hydration` table + helpers) | **US-003** | US-006, US-009, US-010, US-038 |
| **Context event + memory candidate schema** (`context_events`, `memory_candidates`) | **US-004** | US-014, US-026, US-032, US-034, US-035 |
| **Safety primitives** (path normalization/traversal protection, ignore rules, size caps, hashing, secret redaction) | **US-005** | virtually every store/compose/capture story |
| **`SpecContextBundle`** prompt-facing schema (versioned, provenance on every item, `context_summary_json`-compatible) | **US-020** | US-021, US-022, US-023 |
| **Ingestion API** (`POST` event / `POST` candidate; sidecar-facing, idempotent, redacted) | **US-032** | US-026, US-031, US-033, US-038 |
| **Brief-aware retrieval API** (sections, trace ID, freshness, token estimates, degradation flags) | **US-019** | US-020, US-023, US-038, US-039 |

All shared contracts carry an explicit **schema version** field (US-002) so consumers can evolve safely.
All new HTTP routes carry Swagger `x-rorca-tier` + `x-rorca-rationale` annotations per `AGENTS.md`, throw
`AppError` subclasses, and use the async DB helpers with numbered placeholders.

---

## 7. Wave Map

The wave map is computed from the spec's real `dependsOn` graph. **Wave _N_ contains every story whose
dependencies are all satisfied by waves `0 … N-1`.** All stories in the same wave have no dependency on one
another and **may be executed in parallel** (e.g. in parallel worktrees). A story may always start later
than its wave if capacity is constrained; the wave number is the *earliest* it can start.

Max parallel width is **5** (Wave 2). The plan has **16 waves (0–15)** because the retrieval→composition→
E2E chain is intentionally sequential to keep the ranking/composition contracts stable.

| Wave | Stories (parallelizable) | Subsystem(s) | Shared contracts produced / consumed |
|---|---|---|---|
| **0** | US-001 | Foundations | **Produces this design doc** (the contract every wave depends on) |
| **1** | US-002, US-003, US-004, US-005 | Foundations | **Produces** TS contracts, hydration schema, event/candidate schema, safety primitives |
| **2** | US-006, US-013, US-014, US-025, US-032 | Hilo · Retrieval · Capture · Governance | Consumes US-002/003/004/005; **produces** ingestion API (US-032) |
| **3** | US-007, US-026, US-028, US-033 | Hilo · Capture · Governance | Hilo runner; sidecar client+queue; commit metadata; candidate list/detail |
| **4** | US-008, US-027, US-029, US-034 | Hilo · Capture · Governance | Graph normalization; `remember`; `ingest-*`; **review actions (US-034)** |
| **5** | US-009, US-030, US-035, US-036 | Hilo · Capture · Governance | Staleness; git hook; **retrieval gating (US-035)**; review UI |
| **6** | US-010, US-015, US-031, US-037 | Hilo · Retrieval · Capture · Governance | Hydration APIs; graph expansion; daemon; provenance previews |
| **7** | US-011, US-012, US-016 | Hilo · Retrieval | Background hydration; health UI; **explainable ranker (US-016)** |
| **8** | US-017 | Retrieval | Excerpts + token budget allocator |
| **9** | US-018 | Retrieval | Retrieval trace persistence |
| **10** | US-019 | Retrieval | **Brief-aware retrieval API (US-019)** |
| **11** | US-020, US-038, US-039 | Composition · Foundations | **`SpecContextBundle` (US-020)**; observability; limits/concurrency/cache |
| **12** | US-021, US-023, US-041 | Composition · Foundations | Composer service; preview UI; operator/security/rollout docs |
| **13** | US-022, US-024 | Composition | Wire composer into generate/persist; current-branch diff awareness |
| **14** | US-040 | Foundations | End-to-end external-repo fixtures + regression tests |
| **15** | US-042 | Foundations | Full validation + contract preservation |

### 7.1 Critical Path

```
US-001 → US-002 → US-006 → US-007 → US-008 → US-009 → US-015 → US-016
       → US-017 → US-018 → US-019 → US-020 → US-021 → US-022 → US-040 → US-042
```

This 16-story chain (Hilo hydration → graph expansion → ranking → excerpting → retrieval API →
composition → spec wiring → E2E → final validation) is the longest dependency chain and therefore the
schedule's lower bound. Capture/governance stories (US-025 … US-037) form a **mostly independent branch**
that converges only at observability (US-038), gating (US-035), and the E2E fixtures (US-040) — so they can
be staffed in parallel with the critical path from Wave 2 onward.

### 7.2 How to use this map for wave-parallel execution

- **Pick a wave, run its stories in parallel worktrees.** Stories in the same row never touch one another's
  contracts as a hard dependency.
- **Do not start a story before its wave.** Its shared contracts (Section 6) will not exist yet.
- **The two independent branches** (critical/retrieval-composition vs. capture/governance) can each have a
  dedicated track of agents; they only synchronize at US-035, US-038, and US-040.
- **Foundations first.** Wave 1 (US-002 … US-005) unblocks the widest fan-out; prioritize it.

---

## 8. Acceptance-Criteria Traceability (US-001)

| Acceptance criterion | Where satisfied |
|---|---|
| Covers Hilo hydration, retrieval/ranking, context composition, capture sidecar, candidate governance | §2.1–§2.5 |
| Hilo graph = rebuildable codegraph data; Rorca DB = durable reviewed state; local queue = offline buffer; Redis = cache-only | §3 (table + four binding statements) |
| Explicitly excludes Hermes, DuckBrain, GitHub, Linear, Slack/Sentry/incident adapters | §4 |
| Wave map of parallelizable stories + shared contracts | §6 (contracts) + §7 (waves, critical path) |

---

## 9. Related Docs

- `docs/context-intelligence-operator-guide.md` — operator/security guide (US-041): Hilo setup & fork
  strategy, hydration, preview, grounded spec creation, the `rorca-capture` sidecar (ingest/queue/hooks/
  daemon), candidate review, redaction/ignores/limits, and troubleshooting.
- `docs/context-injection.md` — how context layers are injected into each story subprocess today.
- `docs/graph-rag-deep-dive.md` — current memory/RAG/graph stack and its known gaps (the motivation).
- `docs/alexis-hermes-integration-addendum.md` — Hermes is a distribution channel (excluded here, §4).
- `docs/duckbrain-gap-analysis.md` — DuckBrain informs OSS hygiene only (excluded here, §4).
- `AGENTS.md` — route/DB/lib ownership rules and Swagger tier annotations every story must honor.
