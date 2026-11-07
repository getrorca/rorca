# Rorca GraphRAG Implementation Backlog

Date: 2026-05-08
Source: `docs/graph-rag-deep-dive.md`

This document turns the Graph / RAG / CAG analysis into an executable backlog.

It is designed for fast delivery using **parallel subagent lanes** plus a **single autonomous implementation loop** that keeps working until each phase is fully implemented, validated, and free of known bugs.

---

## Operating model

### Non-negotiable autonomous loop

For **every phase**, the implementation runner must repeatedly:

1. Understand the requirements.
2. Create or update a concise implementation plan.
3. Make small, controlled code changes.
4. Run all relevant validation checks.
5. Inspect failures, fix bugs, and rerun checks.
6. Compare the result against the original requirements.
7. Update a compact progress log so the task can survive context compaction.
8. Continue until there are no known bugs, failing checks, or incomplete requirements.

It must be:
- self-auditing
- stateful
- resilient to context compaction
- validation-driven
- unwilling to declare completion early

### Required completion summary for every phase

Do not mark a phase done until you can report:
- what was built
- what files changed
- what tests/checks were run
- what passed or failed
- unresolved issues, if any
- a clear completion status

### Compact progress log format

Maintain this minimal state file for the runner:

- `done:` completed work
- `next:` remaining work
- `decisions:` key design decisions
- `files:` modified files
- `validation:` latest command/results
- `risks:` open issues or blockers

Reload it before each major step.

---

## Subagent lane model

Use parallel lanes where possible. The goal is to keep each lane narrow and merge only at phase boundaries.

### Lane A — Graph ingestion / data model
Owns:
- file touches
- memory-to-file edges
- spec-to-memory linkage
- graph population correctness
- WAL event coverage

### Lane B — Retrieval core
Owns:
- CAG / RAG / graph orchestration
- token budgeting
- cache keys
- search mode semantics
- candidate ranking

### Lane C — Skills as validators
Owns:
- skill-aware retrieval judging
- retrieval reranking
- contradiction detection
- abstention / follow-up retrieval

### Lane D — Validation / eval / telemetry
Owns:
- tests
- fixtures
- retrieval benchmarks
- runtime telemetry
- regression detection

### Lane E — Documentation / rollout
Owns:
- phase docs
- operator notes
- rollout / migration guidance
- completion summaries

> In practice, a single orchestrator can fan work out to these lanes in parallel, then merge results, validate, and continue the loop.

---

## Phase 1 — Stabilize the current system and remove the highest-risk defects

### Objective
Make the current memory / search / graph stack trustworthy enough for everyday use.

### Phase 1 backlog

#### 1.1 Fix graph evidence capture
- Replace `commit:<sha>` pseudo-file nodes with real file-path evidence.
- Ensure `Story-[:TOUCHES]->File` edges reflect actual touched paths.
- Prefer real diff/file extraction over commit proxies.

#### 1.2 Feed all memory write paths into graph population
- Make manual memory saves emit the graph WAL path.
- Ensure auto-memory, spec-memory, and run-memory all reach the graph consistently.
- Link `source_spec_id` memories into spec/story graph edges.
- Add `related_files` → `ABOUT` edges where appropriate.

#### 1.3 Make graph retrieval safe and budgeted
- Include `workspaceId` in graph-context cache keys.
- Count graph tokens in real prompt budget accounting.
- Keep graph retrieval bounded and predictable.

#### 1.4 Fix search mode semantics
- Make `/api/search` actually short-circuit keyword-only and semantic-only modes.
- Avoid unnecessary embedding calls when mode says not to use them.

#### 1.5 Remove brittle text-identity assumptions
- Stop relying on exact memory text equality where stable IDs are available.
- Preserve provenance and use it in joins / ranking.

### Likely files
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/lib/graph-context.ts`
- `backend/src/lib/graph-populator.ts`
- `backend/src/lib/memory-router.ts`
- `backend/src/lib/search.ts`
- `backend/src/routes/memory.ts`
- `backend/src/routes/recall.ts`
- `backend/src/lib/auto-memory.ts`
- tests under `backend/src/routes/__tests__/` and `backend/src/lib/__tests__/`

### Phase 1 subagent split

#### Lane A
- fix graph ingestion model
- add edges for manual/spec memory writes
- make file-path evidence real

#### Lane B
- enforce graph budgets
- fix search mode behavior
- improve cache scoping

#### Lane D
- add regression tests for graph queries and memory retrieval
- add graceful-degradation tests
- add typecheck / integration validation

### Phase 1 validation
Minimum checks:
- graph route tests
- memory route tests
- recall tests
- backend typecheck

### Phase 1 completion criteria
- graph queries use real file evidence
- manual and spec memories participate in graph context
- search modes behave correctly
- graph token budget is enforced
- regression tests pass

### Phase 1 execution loop
Run the autonomous loop in small batches:
1. fix one ingestion path
2. validate
3. fix one retrieval/budget issue
4. validate
5. repeat until green

---

## Phase 2 — Introduce skill-validated retrieval and better ranking

### Objective
Turn skills into active validators, rerankers, and critics for retrieval quality.

### Phase 2 backlog

#### 2.1 Introduce a retrieval candidate model
- Add stable IDs for retrieved memories, conventions, files, stories, and skills.
- Attach provenance fields to every candidate.

#### 2.2 Add a skill-validation pass
- Let matched skills score candidate relevance.
- Support keep/drop/needs-more/conflict decisions.
- Make the validator domain-aware by skill category.

#### 2.3 Add contradiction and supersession handling
- Detect when a newer memory supersedes an older one.
- Surface conflict instead of blending contradictory evidence.

#### 2.4 Add better reranking
Combine signals such as:
- semantic similarity
- lexical match
- graph support
- file/path overlap
- recency
- confidence
- skill validator score
- historical usefulness

#### 2.5 Add diversity-aware assembly
- Use MMR-style or similar diversity-aware selection.
- Avoid near-duplicate memory dumps.

### Likely files
- `backend/src/lib/memory-router.ts`
- `backend/src/lib/skill-matcher.ts`
- `backend/src/lib/skill-registry.ts`
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/routes/recall.ts`
- possibly new helper modules in `backend/src/lib/`
- new tests / fixtures

### Phase 2 subagent split

#### Lane B
- design candidate schema
- integrate ranking signals
- wire retrieval stages together

#### Lane C
- build skill validator logic
- add contradiction / abstention rules
- implement follow-up retrieval requests

#### Lane D
- write validation fixtures for good/bad retrieval
- add reranking tests
- add contradiction tests

### Phase 2 validation
Minimum checks:
- all Phase 1 checks
- skill matching tests
- retrieval validator tests
- reranking tests
- contradiction handling tests
- backend typecheck

### Phase 2 completion criteria
- retrieval candidates are provenance-aware
- skills influence ranking/filtering
- contradictions are surfaced
- the system can abstain and ask for more evidence
- tests pass on fixtures and regression cases

### Phase 2 execution loop
1. define candidate schema
2. add validator for one path
3. validate
4. expand to reranking
5. validate
6. iterate until the validator materially improves retrieval quality

---

## Phase 3 — Build true state-of-the-art GraphRAG with feedback systems and evals

### Objective
Make Rorca a compounding retrieval system that learns from real usage.

### Phase 3 backlog

#### 3.1 Split retrieval into explicit stages
- recall
- graph expansion
- skill validation / rerank
- budgeted assembly

#### 3.2 Add retrieval telemetry
- log candidate sets, dropped items, validator decisions, graph touches, and prompt cost.

#### 3.3 Build offline evals
- benchmark fixtures for retrieval relevance
- precision / recall / MRR / nDCG measurement
- contradiction and stale-memory detection tests

#### 3.4 Add feedback systems
- learn from successful runs
- boost memory / graph / skill combinations that repeatedly help
- demote stale or contradicted items

#### 3.5 Add graph confidence semantics
- edge evidence counts
- last-seen timestamps
- source metadata for graph edges

#### 3.6 Add freshness / decay policies
- conventions decay slowly
- bug-fix memories decay faster
- pinned memories bypass most decay

### Likely files
- `backend/src/lib/memory-router.ts`
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/lib/graph-context.ts`
- `backend/src/lib/auto-memory.ts`
- `backend/src/routes/recall.ts`
- `backend/src/routes/search.ts`
- telemetry / analytics helpers
- benchmark fixtures and regression suites

### Phase 3 subagent split

#### Lane B
- orchestrate retrieval stages
- implement budgeted assembly
- wire learning hooks into ranking

#### Lane C
- tune skill supervisor behavior
- make validator output actionable for ranking

#### Lane D
- build benchmark suite
- add telemetry assertions
- validate fallback behavior and regression risk

#### Lane E
- document rollout guidance and quality gates

### Phase 3 validation
Minimum checks:
- all Phase 1 and Phase 2 checks
- offline retrieval benchmark suite
- integration / end-to-end recall tests
- telemetry correctness tests
- fallback and graceful degradation tests
- backend typecheck

### Phase 3 completion criteria
- retrieval is stage-separated and measurable
- benchmark quality is tracked over time
- feedback from successful runs improves future retrieval
- graph edges carry confidence/evidence semantics
- no critical regression in fallback behavior

### Phase 3 execution loop
1. establish eval fixtures first
2. add telemetry
3. introduce staged orchestration
4. validate
5. add feedback systems
6. tune scoring against benchmarks
7. repeat until quality gains are reproducible

---

## Phase sequencing recommendation

If execution time is tight, do it in this order:

1. **Phase 1** — remove the biggest risk and correctness gaps
2. **Phase 2** — make skills supervise retrieval quality
3. **Phase 3** — add evals, telemetry, and feedback systems

---

## Suggested deliverables per phase

### Phase 1 deliverables
- code fixes
- regression tests
- validation log
- completion summary

### Phase 2 deliverables
- validator layer
- reranking logic
- contradiction handling
- retrieval quality fixtures
- completion summary

### Phase 3 deliverables
- staged retrieval orchestration
- telemetry
- offline benchmarks
- feedback system plumbing
- completion summary

---

## Completion checklist template

Each phase should close with:

- What was built
- What files changed
- What tests/checks were run
- What passed or failed
- Any unresolved issues
- A clear completion status

---

## Bottom line

The fastest path to a strong GraphRAG system in Rorca is:

- fix the graph evidence layer first
- make skills active retrieval judges second
- add telemetry, evals, and feedback systems third

That keeps the work safe, measurable, and compounding.
