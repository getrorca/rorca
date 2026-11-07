<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Storage Architecture Phased Program

- **Status:** Proposed
- **Dated:** 2026-08-21
- **ADR:** [`architecture/adr/0002-storage-authority-and-relational-graph.md`](architecture/adr/0002-storage-authority-and-relational-graph.md)
- **Motivating incident:** 2026-08-21 seven-run fleet failure (7 failed runs, 42 failed stories)

## Evidence: observed failure-mode tally

Seventeen distinct failure modes were observed during the 2026-08-21 fleet incident. "Solved by
DuckBrain" is judged against the mode's root cause, not its symptom.

| # | Observed mode | Layer | DuckBrain solves |
|---|---|---|---|
| 1 | PostgreSQL capped at 100 connections; API/worker/engine/pg-boss pools saturated it | Capacity/config | Partially |
| 2 | API started with `PG_POOL_SIZE=30`, overriding checked-in value 4 | Process config | No |
| 3 | API pool of 4 produced timeouts while PostgreSQL had spare capacity | App pool sizing | No |
| 4 | `StoryLogFollower` inserted every PTY repaint/escape chunk as an individual row | Write amplification | No (design bug) |
| 5 | Individual `story_output_chunks` writes took ~0.9s, pinning connections | Hot-path latency | Mostly, if logs move to files |
| 6 | Graph populator/drift ran large Cypher fan-out per changed file | AGE fan-out | Yes |
| 7 | Embedding pipeline shared the API pool and retried in a loop | Shared pool | Yes |
| 8 | Memory dedup shared the API pool | Shared pool | Yes |
| 9 | Forgejo/check/WAL subscribers competed with HTTP requests | Subscriber fan-out | No |
| 10 | pg-boss holds its own schema and connections | Queue infra | No |
| 11 | Disabling background runtime also skipped pg-boss init → deterministic trigger 500s | Lifecycle coupling | No |
| 12 | OrbStack `localhost:5432` forward accepted then dropped connections | Network forwarding | Partially |
| 13 | `max_connections` in `postgresql.auto.conf` needed a restart to take effect | PG semantics | No |
| 14 | PG restart killed pg-boss connections; API crash-looped during recovery | Restart coupling | No |
| 15 | Two API processes ran (3030/3031) with separate pools | Process topology | No |
| 16 | Trigger 500s occurred after durable runs were created → duplicate runs, stale worktrees | Tx/API boundary | No |
| 17 | Pool starvation broke lease heartbeats → engines interrupted, orphaned `running` states | Control-plane starvation | No |

Result: **3 directly solved, 1 mostly solved, 3 partially reduced, 10 unsolved** by DuckBrain.
Conclusion: DuckBrain materially helps the graph/embedding/memory load but does not address the
control-plane defects that destroyed the fleet.

## Phase 0 — Stabilize the control plane (no storage changes)

1. Allow canary run `20260316000142` to reach a terminal state; preserve its worktree/branch either way.
2. Run exactly one canonical API process; terminate the duplicate (port 3031).
3. Give each consumer its own bounded pool: API, worker, pg-boss, runner callbacks.
4. Move PTY/terminal output to append-only files; PostgreSQL stores metadata, offsets, hashes only.
5. Bound every background subscriber (graph, drift, embeddings, memory-dedup) with queue caps and backpressure.
6. Make trigger responses idempotent: a 500 must never follow a created run.
7. Restart-safe startup: pg-boss initialized before dispatch is accepted (request-only mode patch already applied).

**Exit:** seven-run fleet completes with zero pool timeouts, zero orphaned `running` states, clean API toasts.

## Phase 1 — Freeze retrieval truth

1. Promote existing fixtures to a golden parity suite: `ranking-benchmark-phase2.json`,
   `graph-context.test.ts`, `graph-context-scope.test.ts`, `retrieval-pipeline.test.ts` reranking cases.
2. Record representative real queries with their selected memory IDs and orderings.
3. Freeze the scoring contract: `final = w_s·semantic + w_g·proximity + w_r·recency + w_u·usefulness`.

**Exit:** a parity suite that fails when structural selection or ordering changes.

## Phase 2 — Replace AGE with relational edges

1. Add tables: `knowledge_nodes`, `knowledge_edges`, `story_file_touches`,
   `story_spec_membership`, `memory_story_sources`, `convention_file_applicability`,
   `file_co_modifications`.
2. Reimplement traversal with indexed joins + bounded recursive CTEs under existing workspace/spec/story
   scoping, depth limits, and `MAX_GRAPH_CONTEXT_PREDICTED_PATHS`.
3. Backfill from AGE (or re-derive from WAL/story results).
4. Differential testing: identical memories, identical ordering vs AGE.

**Exit:** parity suite green on the relational backend.

## Phase 3 — Cut over and delete AGE

1. Switch `graph-context`, `graph-drift-detector`, `graph-populator`, blast-radius, sibling discovery.
2. Remove Cypher, AGE extension, AGE migrations, `parseAgtype`, graph extension configuration.
3. Remove now-dead connection pressure and cleanup jobs.

**Exit:** AGE fully removed; parity suite green; pool pressure measurably lower.

## Phase 4 — Memory subsystem decision gate

Decision, not work:

- **Keep pgvector + PostgreSQL memory** unless both hold:
  1. Git-native, branch-aware memory is a confirmed product requirement.
  2. DuckBrain would delete more Rorca code than it adds.
- **Exit:** a recorded decision. "No" ends the program here, single-database and AGE-free.

## Phase 5 — DuckBrain memory pilot (only if Phase 4 passes)

1. Run DuckBrain locally for synthesized memories, recall, and embedding cache.
2. Dual-write memory; compare retrieval against the parity suite.
3. Measure under real concurrent runs (synthesis, dedup, recall spikes).

**Exit:** parity suite green via DuckBrain path; PostgreSQL embedding/memory load demonstrably removable.

## Phase 6 — Memory cutover and cleanup

1. DuckBrain becomes memory authority; remove pgvector tables, embedding pipeline, memory-dedup SQL.
2. Graph proximity stays relational (DuckBrain does not reproduce typed structural retrieval).
3. Document the two-store boundary: memory store vs transactional authority.

**Exit:** net code deleted; backup/recovery for Git-versioned memory documented.

## Explicit non-goals

- No removal of PostgreSQL.
- No replacement of pg-boss (keep, isolate).
- No reintroduction of a graph database.
- No DuckBrain for runs, leases, queues, or authority.

## Sequencing rule

Every phase preserves the previous phase's correctness proof. Phases 1–3 carry the real risk
(parity of graph proximity). Phases 5–6 are optional and gated. Phase 0 proceeds immediately and
independently.
