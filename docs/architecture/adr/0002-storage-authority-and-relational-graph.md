<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# ADR 0002: Storage authority stays relational; Apache AGE is replaced; DuckBrain is deferred

- **Status:** Proposed
- **Proposed:** 2026-08-21
- **Supersedes:** none
- **Program:** [`../../storage-architecture-phased-program.md`](../../storage-architecture-phased-program.md)

## Context

On 2026-08-21 a seven-run fleet failed at the infrastructure boundary: 42 stories failed, every
first story ended `engine_interrupted`, and every remaining story ended `engine_exit_incomplete`.
The canonical tally of observed failure modes is recorded in the program document. Two conclusions
follow directly from that evidence:

1. **PostgreSQL was not the exhausted resource.** It was capped at 100 connections at first and
   later raised to 300; observed usage was ~55. Rorca's own processes exhausted their own pools:
   row-per-PTY-repaint writes, AGE Cypher fan-out from graph/drift subscribers, embedding and
   memory-dedup work sharing the API pool, duplicate API processes, and restart coupling that
   skipped pg-boss initialization.

2. **AGE contributes load without contributing irreplaceable capability.** Retrieval fidelity comes
   from the typed relationship model (Story–File, Story–Spec, Memory–Story, Convention–File,
   co-modification) and the scoring contract (semantic + proximity + recency + usefulness), not from
   the Cypher query engine. The same model is expressible in relational tables with bounded
   recursive CTEs.

Separately, DuckBrain (JSONL + Git + DuckDB) was evaluated as a possible replacement for memory,
embeddings, or the entire database. It is strong for Git-versioned agent memory and semantic
retrieval, but it does not provide transactional primitives for lifecycle state, leases, queue
claims, idempotency, or authority consumption, and it does not natively reproduce the typed
structural retrieval that AGE currently supplies.

## Decision

1. **PostgreSQL remains the canonical transactional authority**, together with pg-boss for durable
   dispatch. Runs, stories, lifecycle state, leases, heartbeats, idempotency, queue claims,
   authority records, and the transactional outbox stay in PostgreSQL.

2. **Apache AGE is removed.** Graph data is materialized as ordinary relational edge tables
   (`knowledge_nodes`, `knowledge_edges`, `story_file_touches`, `story_spec_membership`,
   `memory_story_sources`, `convention_file_applicability`, `file_co_modifications`). Traversal is
   implemented with indexed joins and bounded recursive CTEs under the existing workspace/spec/story
   scoping, depth limits, and the 10-predicted-path cap.

3. **Retrieval fidelity is preserved by proof, not assertion.** Before AGE is removed, the existing
   retrieval benchmarks (`ranking-benchmark-phase2.json`, `graph-context.test.ts`,
   `retrieval-pipeline.test.ts`) become a parity suite. The relational implementation must select
   identical memories in identical order under differential testing.

4. **DuckBrain adoption is deferred** behind two gates: (a) a confirmed product requirement for
   Git-native, branch-aware memory, and (b) evidence that DuckBrain replaces more Rorca code than it
   adds. Until then, memory and embeddings remain in PostgreSQL/pgvector.

5. **Control-plane defects are fixed independently of storage changes**: a single canonical API
   process, per-consumer bounded pools, PTY output moved to append-only files, bounded subscriber
   concurrency, idempotent trigger responses, and restart-safe pg-boss initialization. None of these
   depend on the graph or memory decisions.

## Consequences

- AGE extension, Cypher, `parseAgtype`, and graph-specific migrations are deleted code after the
  cutover phase.
- Graph-proximity reranking survives with unchanged semantics, verified against the parity suite.
- Operational risk from the 2026-08-21 failure class is reduced by pool isolation and output
  extraction regardless of whether DuckBrain is ever adopted.
- If the product requirement for Git-native memory is later confirmed, DuckBrain enters as a memory
  store under the retrieval parity suite, not as lifecycle authority.
- PostgreSQL remains a single operational database of record; no second authoritative store is
  introduced.
