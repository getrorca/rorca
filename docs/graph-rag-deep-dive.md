# Rorca Graph / RAG / CAG Deep Dive

Date: 2026-05-08
Scope: current backend memory stack + Pi extension integration

## Executive summary

Rorca now has the right *ingredients* for a strong memory system:

- **CAG**: hot-cache direction layers, recent memory, and skills
- **RAG**: hybrid full-text + embedding search over the `memories` table
- **Knowledge graph**: Apache AGE graph traversal for story/file/convention/memory relationships
- **DB-backed memories**: `memories` is now the primary source of truth, with `MEMORY.md` increasingly acting as a projection / compatibility surface

But the current implementation is **not yet state-of-the-art graph RAG**. The biggest reason is that the knowledge graph is mostly present as a *sidecar enrichment layer*, not as a first-class retrieval engine. In particular, the graph is not yet being fed accurate file-touch evidence, memory→file edges are sparse, graph token budgeting is not enforced, and some graph routes still operate on assumptions that no longer match the new DB storage model.

The Pi extension also amplifies the issue because it always runs with `includeGraph: true`, so any graph inefficiency or inaccuracy affects everyday Pi-driven runs.

---

## What the stack does today

### 1) CAG: cache-augmented generation

Primary implementation:
- `backend/src/lib/context-cache.ts`
- `backend/src/lib/direction-stack.ts`
- `backend/src/lib/memory-router.ts`

Behavior today:
- Caches direction layers (`L1/L2/L3`), schema snapshot, recent memories, installed skills, workspace config, and active agent profile.
- `retrieveContext()` pulls:
  - direction layers first
  - pinned memories from `memories`
  - recent cached memories
  - installed skills
- The cache is in-memory, TTL-based, and workspace-keyed for most domain data.

Strengths:
- Fast.
- Simple.
- Good for stable standards, conventions, and recent memory recall.

Current limitations:
- Cache hit accounting is global, not per request, so `cagHits`/tier metadata can be skewed under concurrency.
- Cache coverage is based only on cached memory content, not pinned memory content.
- The retrieval heuristic is simplistic and can miss short but important tokens.

---

### 2) RAG: retrieval-augmented generation

Primary implementation:
- `backend/src/lib/search.ts`
- `backend/src/routes/search.ts`
- `backend/src/lib/memory-router.ts`
- `backend/src/routes/recall.ts`

Behavior today:
- Hybrid search combines:
  - keyword search over `tsvector`
  - semantic search over `pgvector`
- Memory search is keyed off the `memories` table.
- Reciprocal Rank Fusion merges keyword and semantic hits.

Memory-specific path:
- `retrieveContext()` triggers RAG when cache coverage falls below 50% of extracted key phrases.
- `recall` uses `retrieveContext()` and then maps the retrieved memory texts back to DB rows.

Strengths:
- Better than plain recency.
- Hybrid keyword + semantic retrieval is a solid baseline.
- Memory rows now carry richer metadata (`source_type`, `source_spec_id`, `pinned`, `source`, `related_files`, `embedding`, `tsv`).

Current limitations / bugs:
- `hybridSearch()` always runs semantic search even in keyword-only mode.
- `mode=keyword` / `mode=semantic` is not actually respected as a performance short-circuit.
- `retrieveContext()` only uses `cachedMemory` for cache coverage, not pinned memories.
- `recall` matches `ctx.memory` against DB rows by exact `content` equality; RAG snippets can fail to map back cleanly.
- Key phrase extraction is very crude and drops short domain tokens like `API`, `SQL`, `JWT`, `SSE`, `AGE`, `RAG`, `CAG`, `pg`, etc.
- Search result provenance is lossy: some spec/archive hits are mislabeled, and the current search schema does not preserve enough structure for richer ranking.

---

### 3) Knowledge graph: Apache AGE traversal

Primary implementation:
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/lib/graph-context.ts`
- `backend/src/lib/graph-populator.ts`
- `backend/src/routes/graph.ts`
- `backend/src/routes/specs.ts` (`/:specId/knowledge-graph`)
- `backend/src/lib/execution-engine.ts` (graph injection at run time)

Behavior today:
- AGE graph availability is probed and cached.
- Graph nodes/edges are populated from WAL events and run/spec data.
- Graph context is injected into story prompts when `includeGraph` is enabled.
- The Pi extension always triggers runs with `includeGraph: true`.

Current graph surfaces:
- `graph-context.ts` looks for:
  - memories from stories that touched the same file
  - conventions applying to those files
  - file history / conflicting in-progress stories
- `querySpecKnowledgeGraph()` returns:
  - memories linked by `LEARNED_FROM`
  - conventions linked by `APPLIES_TO`
  - related stories

Strengths:
- The graph layer is already wired end-to-end.
- AGE availability degrades gracefully.
- There is a clear place to enrich prompts with graph context.

Current limitations / bugs:
- The graph is **not yet populated with real file-touch evidence** in the main run path.
- Run population currently stores commit SHAs as `File.path` nodes (`commit:<sha>`), which does not satisfy the file-path-based graph queries used by `graph-context.ts`.
- Many graph queries expect actual file paths, so they return little or nothing in practice.
- Manual memory creation does **not** emit the graph WAL event the populator listens for, so manually saved memories do not get linked into the graph.
- Spec-generated memories carry `source_spec_id`, but the graph populator currently ignores that and does not link them to specs/stories.
- `querySpecKnowledgeGraph()` comments mention `DEPENDS_ON`, but the implementation only queries touch-based relationships.
- `graph-context` caches by `storyId + predictedPaths hash`, but not `workspaceId`, which can cause cross-workspace cache collisions when IDs are reused.
- Graph token cost is not actually enforced in `retrieveContext()`; graph budget exists on paper but is not counted into `totalTokens`.
- `maxDepth > 2` traversal exists in `graph-context.ts`, but current callers do not use it, so the graph walk is shallower than the code suggests.

---

## Recent memory-storage changes and how they affect retrieval now

### DB-side changes that matter

The memory model has grown substantially:

- `source_type` was added to `memories`
- `source_spec_id` was added to `memories`
- `source` was added as a free-form origin tag
- `pinned` was added
- `tsv` was added for keyword search
- the system now backfills some historical `source_type` values
- `MEMORY.md` is increasingly derived from DB state rather than being the only store

Relevant files:
- `backend/src/db/pg-migrations/053_memories.sql`
- `backend/src/db/pg-migrations/054_memories_pinned.sql`
- `backend/src/db/pg-migrations/055_memories_source_spec_id.sql`
- `backend/src/db/pg-migrations/059_memories_source_type.sql`
- `backend/src/db/pg-migrations/060_memories_backfill_source_type.sql`
- `backend/src/db/pg-migrations/069_add_source_to_memories.sql`
- `backend/src/lib/memory-projection.ts`
- `backend/src/routes/memory.ts`
- `backend/src/lib/auto-memory.ts`
- `backend/src/lib/memory-router.ts`
- `backend/src/routes/recall.ts`

### DB write paths

There are now multiple memory write paths:

1. **Manual memory save**
   - `POST /api/memory`
   - writes to `MEMORY.md`
   - inserts into `memories`

2. **Story auto-memory synthesis**
   - `backend/src/lib/auto-memory.ts`
   - inserts into `memories`
   - emits WAL events

3. **Spec auto-memory synthesis**
   - `autoSynthesizeSpecMemory()`
   - inserts into `memories` with `source_spec_id`
   - emits WAL events

4. **Run-level synthesis**
   - `synthesizeRunMemory()`
   - inserts synthesized run memories into `memories`
   - emits WAL events

5. **DB → MEMORY.md projection**
   - `writeMemoryMd()` regenerates the file from the DB
   - called in the execution engine before / after runs

### Retrieval now

Read paths are split:

- **Legacy file-ledger views**:
  - `GET /api/memory`
  - `GET /api/memory/context`
  - `memory-ledger.ts`

- **DB-backed semantic retrieval**:
  - `retrieveContext()`
  - `hybridSearch()`
  - `recall`
  - `memory list` / item APIs

This means the system now has **two memory planes**:
- DB as the semantic / operational source of truth
- `MEMORY.md` as a projected compatibility/readability layer

That split is workable, but it is a consistency risk unless every mutation path keeps them synchronized.

---

## Biggest bottlenecks / misconfigurations / bugs

### 1) File-touch evidence in the graph is effectively broken

This is the biggest issue.

Current behavior:
- graph population stores `commit:<sha>` as file nodes
- graph traversal expects actual file paths
- result: file-based graph RAG mostly has nothing real to traverse

Impact:
- `getGraphContext()` cannot reliably answer “what touched this file before?”
- `queryImpact(filePath)` is much less useful than intended
- knowledge graph value is suppressed to conventions + story dependencies, not real file lineage

### 2) Manual memory saves do not feed the graph

`POST /api/memory` does not emit the same memory WAL event pattern as the auto-synth flows.

Impact:
- manually curated memories never become graph-linked evidence
- graph retrieval is missing an important class of high-signal knowledge

### 3) `source_spec_id` exists but is not graph-connected

This is a recent-model mismatch.

Impact:
- spec-generated memories are stored in DB but not linked into graph traversal
- `querySpecKnowledgeGraph()` and `graph-context` do not leverage this newer metadata

### 4) Graph budget is dead code in practice

`retrieveContext()` computes a graph budget ratio, but graph tokens are not actually budgeted or counted in the returned total.

Impact:
- prompts can grow beyond the intended token budget
- graph can silently bloat run/spec prompts

### 5) Graph cache is not workspace-scoped

`graph-context` cache keys do not include workspace ID.

Impact:
- cross-workspace contamination risk
- incorrect reuse when story IDs or path sets collide

### 6) Search modes are misleading

The `mode` parameter in `/api/search` suggests keyword/semantic/hybrid behavior, but the implementation still runs the semantic path even when it should be skipped.

Impact:
- extra latency
- misleading operator expectations
- semantic path cost even for “keyword-only” requests

### 7) Memory retrieval from `recall` can drop RAG hits

Because it maps retrieved text back to DB rows by exact `content`, snippets or title-based search results may not map back.

Impact:
- user asks for recall, but some relevant hits vanish from the returned memory list

### 8) CAG coverage heuristic is too shallow

Current key phrase extraction is based on long words and a stopword list.

Impact:
- short but crucial technical tokens are ignored
- RAG is triggered too often or not often enough
- recall quality drops on code-heavy prompts

### 9) DB/file divergence risk for memory edits

Manual create writes to both file and DB, but edit/delete/undelete flows are DB-centric.

Impact:
- the filesystem projection can drift from DB state
- `GET /api/memory` (file-backed) and DB-backed memory views can disagree until the next projection pass

### 10) `querySpecKnowledgeGraph()` does not actually implement its documented DEPENDS_ON story expansion

Impact:
- the endpoint is narrower than the docs promise
- related-story coverage is incomplete

---

## What to improve to become true state-of-the-art GraphRAG

### Priority 0 — fix graph evidence quality

1. **Store real file paths, not commit SHAs, for story touches**
   - parse diffs or capture touched file lists at run time
   - create `Story-[:TOUCHES]->File(path)` edges with actual paths

2. **Emit graph events for manual memory saves and edits**
   - link manual memories into the graph like auto-synthesized ones

3. **Connect spec memories through `source_spec_id`**
   - add spec-level graph edges for spec observations
   - allow traversal from spec → story → memory

4. **Populate `ABOUT` edges from `related_files`**
   - this will make memory-to-file traversal much richer

### Priority 1 — make graph retrieval real retrieval, not sidecar annotation

5. **Use graph candidates to expand and rerank RAG**
   - graph should propose candidate memories/files/stories before final prompt assembly
   - graph should influence ranking, not just append a markdown section

6. **Count graph tokens and budget them explicitly**
   - graph context should participate in budget enforcement

7. **Add workspace-aware cache keys and invalidation**
   - include workspace and optionally spec ID in `graph-context` cache keys

8. **Use deeper traversal selectively**
   - enable `maxDepth > 2` only when budget / query complexity justify it

### Priority 2 — improve semantic quality and latency

9. **Short-circuit search modes properly**
   - keyword-only should avoid embedding calls
   - semantic-only should avoid keyword ranking when appropriate

10. **Improve key phrase extraction**
    - preserve short domain tokens
    - add acronym handling and code-token detection

11. **Use pinned memories in cache-coverage calculations**
    - pinned memories should count toward coverage and dedupe logic

### Priority 3 — reduce memory-plane drift

12. **Make DB the single source of truth for user-facing memory edits**
    - render `MEMORY.md` as a projection only
    - refresh projection after DB mutations or deprecate the file-backed list view

13. **Add consistency tests**
    - manual memory save → DB row → graph link → recall visibility
    - spec memory save → `source_spec_id` → graph visibility
    - file-touch graph traversal with actual file paths

---

## Pi extension implications

Reviewed package:
- `packages/rorca-pi-extension`

Important points:
- the extension is thin and mostly delegates to the backend
- `/rorca-run`, `/rorca-forge-run`, and related commands always pass `includeGraph: true`
- therefore the backend graph quality directly affects the Pi operator experience
- `skills/rorca-forge/SKILL.md` correctly encourages deliberate retrieval, but it relies on backend retrieval quality being high

Conclusion:
- the extension is not the main problem
- it is faithfully exposing the current backend retrieval stack
- once backend graph retrieval improves, the extension will benefit immediately without much extension-side change

---

## Why using skills to validate memory retrieval is a genuinely strong idea

I agree with the premise: this is one of the most promising directions in the current architecture.

The key insight is that **skills are not just prompt content**. In a stronger system, skills become:

- **retrieval validators** — “is this memory actually relevant for this task?”
- **retrieval critics** — “what is noisy, stale, contradictory, or under-specified here?”
- **retrieval expanders** — “what additional evidence should be fetched before we trust this context?”
- **retrieval rerankers** — “which items are most actionable for this kind of work?”

That is much closer to state-of-the-art retrieval practice than naive “retrieve top-k and dump into prompt”.

### Why this fits Rorca especially well

Rorca already has the right building blocks:

- `skill-matcher.ts` already treats memory as a strong signal when selecting skills
- `execution-engine.ts` already records `active_skills`
- `graph-populator.ts` already writes `Skill-[:USED_IN]->Story`
- `querySkillEffectiveness()` and `querySkillPathAffinity()` already expose historical skill-performance signals
- the Pi extension and skills system already encourage active retrieval decisions instead of passive context stuffing

So the idea is not theoretical — **the repo already contains the first 40% of the machinery**.

### What “skills validate retrieval” should mean in practice

For each retrieval request:

1. **Candidate generation**
   - CAG / RAG / graph produce an initial candidate set of memories, conventions, stories, files, and skills.

2. **Skill-aware validation pass**
   - Relevant skills are asked:
     - which memories are truly applicable?
     - which retrieved items are stale or too generic?
     - what is missing?
     - what evidence would make this safe to act on?

3. **Structured reranking**
   - the system boosts items that are:
     - skill-supported
     - graph-supported
     - source-traceable
     - recent enough
     - tied to the same file/path/domain/subsystem

4. **Abstention / uncertainty**
   - if the skills disagree or evidence is weak, the retriever should say so explicitly and either fetch more or reduce confidence.

That is the real payoff: not “more context”, but **better trusted context**.

---

## How to make skills first-class retrieval validators

### 1) Introduce a retrieval-judge phase

Right now skills are injected into prompts and used for execution, but not formally used as a retrieval decision layer.

Add a lightweight structured stage:

- input:
  - task / story text
  - top N memory candidates
  - top N graph candidates
  - top N related files / stories
  - matched skills
- output:
  - `keep[]`
  - `drop[]`
  - `needs_more[]`
  - `conflicts[]`
  - `missing_queries[]`

This can be very small and cheap. It does not need full generative prose.

### 2) Let skills vote on relevance by category

Different skill categories should evaluate different evidence classes:

- **Security skills** validate auth/session/secret-related memories
- **Database skills** validate schema/migration/query memories
- **Frontend skills** validate component/state/theming memories
- **Testing skills** validate flaky test / tooling / harness memories
- **Workflow skills** validate CI/CD/release/build memories
- **Adversarial skills** challenge weak retrieval and spot false positives

That is much stronger than one general semantic score.

### 3) Require provenance-aware validation

Every retrieved memory should carry structured provenance:

- source type
- source story
- source run
- source spec
- related files
- graph support count
- recency
- confidence

Then skills can reject low-provenance memories even if they are semantically similar.

### 4) Add contradiction detection

A state-of-the-art retrieval system should detect when memories disagree.

Example:
- old memory says “use pattern A”
- new memory says “pattern A caused failures; use B”

Skills should be able to mark:
- `superseded_by`
- `contradicts`
- `needs_human_review`

### 5) Make skills generate follow-up retrieval queries

If the first pass is weak, the skill layer should ask for more evidence, e.g.:

- “fetch memories tied to `backend/src/routes/auth.ts`”
- “fetch stories that touched JWT/session code”
- “fetch only recent run-synthesis memories for auth failures”

This converts retrieval into a **closed-loop process**, not a one-shot search.

---

## State-of-the-art best practices Rorca should adopt

### A) Split retrieval into four explicit stages

Instead of one blended `retrieveContext()`, move toward:

1. **recall** — fast broad candidate fetch
2. **graph expansion** — neighborhood growth around files/stories/specs/skills
3. **skill validation / rerank** — domain-aware filtering
4. **budgeted assembly** — prompt packaging with explicit token accounting

This separation makes quality easier to measure and debug.

### B) Use hybrid scoring, not single-path scoring

Final ranking should combine:

- semantic similarity
- lexical match
- graph distance
- file/path overlap
- source provenance quality
- recency / freshness
- confidence
- skill-validator vote
- historical usefulness (e.g. was this memory helpful in successful runs?)

This is where Rorca can become much better than generic vector search.

### C) Prefer diversity-aware selection

Top-k often returns near-duplicates.

Use diversity / MMR-style selection so the final prompt contains:
- one or two highly relevant conventions
- one concrete prior bug / gotcha
- one nearby file-history clue
- one strong skill-specific rule
- one recent run-level synthesis insight

That produces better prompts than five semantically similar memory rows.

### D) Add retrieval evals and hard negatives

A serious GraphRAG system needs evaluation data.

Rorca should maintain a small benchmark set of:
- story text
- expected memory IDs
- expected irrelevant memory IDs
- expected files / skills / related stories

Then test:
- precision@k
- recall@k
- MRR / nDCG
- contradiction rate
- stale-memory rate
- downstream success lift

### E) Add online retrieval telemetry

For each run, log:
- retrieved memory IDs
- dropped memory IDs
- validator decisions
- graph nodes touched
- skills used to judge retrieval
- prompt token contribution by source
- whether the run succeeded

Then build learning loops from that data.

### F) Turn successful runs into relevance feedback

If a story succeeds and used memories X/Y/Z plus skills A/B, Rorca should learn:
- these memories were likely useful in this context
- these skill/path combinations are predictive
- these graph neighborhoods are worth reusing

This is where GraphRAG becomes a compounding system.

---

## Deeper risk-reduction recommendations

### 1) Stop treating memory text as the retrieval identity

Right now parts of the system still match by exact memory content.

Best practice:
- retrieve / rank by stable `memory_id`
- keep snippets as display only
- preserve provenance and score per candidate

This removes brittle exact-text joins.

### 2) Make memory metadata part of ranking

The new DB shape is strong, but current retrieval underuses it.

Ranking should explicitly use:
- `source_type`
- `source`
- `source_story_id`
- `source_run_id`
- `source_spec_id`
- `related_files`
- `pinned`
- `confidence`
- age / recency

### 3) Add temporal freshness rules

Not all old memories are equal.

Suggested policy:
- conventions decay slowly
- bug-fix memories decay medium
- run-synthesis memories decay faster unless repeatedly confirmed
- pinned memories bypass most decay

### 4) Add stale-memory detection

A memory should be demoted if:
- the files it references no longer exist
- the pattern it describes was superseded by later memories
- the spec/run/story lineage is too old and contradicted by newer evidence

### 5) Add graph edge confidence / evidence counts

Not all edges should be equal.

Store metadata like:
- edge origin
- observed_count
- last_seen_at
- derived_from (diff, WAL, skill match, manual curation)

Then graph traversal can prefer high-confidence edges.

### 6) Add explicit abstention behavior

The retrieval layer should be allowed to say:
- “graph evidence weak”
- “memory candidates conflict”
- “needs file-specific follow-up retrieval”

That is safer than pretending the first pass is authoritative.

---

## Concrete architecture I would move toward

### Near-term target: Retrieval Orchestrator + Validator loop

A stronger shape would be:

1. `retrieveCandidates(task)`
   - cache
   - DB search
   - graph neighbors
   - skill candidates

2. `validateCandidates(task, candidates, skills)`
   - structured validator output
   - conflict detection
   - abstention
   - suggested follow-up queries

3. `expandIfNeeded(...)`
   - fetch more file-specific / story-specific / spec-specific evidence

4. `assembleContext(...)`
   - token-budgeted final prompt pack
   - provenance attached
   - diversity-aware selection

### Longer-term target: memory/graph/skill tri-model

Think of the system as 3 cooperating retrieval views:

- **Memory view** — what was learned
- **Graph view** — where it connects
- **Skill view** — how to judge and apply it

The state-of-the-art move is to make the **skill view supervise the other two**.

---

## Best-practice changes I would make even before large architecture work

1. include `workspaceId` in graph-context cache keys
2. rank / return memory candidates by stable IDs, not raw text
3. enforce graph token budgets for real
4. make `/api/search` truly respect keyword/semantic mode
5. feed manual memories into WAL + graph population
6. feed `source_spec_id` and `related_files` into graph edges
7. add validator hooks so matched skills can score retrieval candidates
8. log retrieval decisions for later evaluation
9. add contradiction / supersession support for memories
10. add offline eval fixtures for memory relevance

---

## Recommended implementation order

If this were being hardened into a real GraphRAG system, I would do the work in this order:

1. Fix graph evidence capture for real file paths
2. Link manual + spec memories into the graph
3. Make graph token budgeting real
4. Fix search mode short-circuiting
5. Make cache keys workspace-aware
6. Add traversal/rerank logic so graph informs retrieval instead of just annotating it
7. Add tests around the new graph evidence paths and the DB/file projection boundary

---

## Three-phase implementation roadmap

This is the implementation plan I would use to deliver the upgrade in a way that is safe, self-auditing, and resilient.

### Execution method for all phases: autonomous implementation loop

For **every phase**, the work should be executed with the same autonomous loop:

1. Understand the requirements.
2. Create or update a concise implementation plan.
3. Make small, controlled code changes.
4. Run all relevant validation checks.
5. Inspect failures, fix bugs, and rerun checks.
6. Compare the result against the original requirements.
7. Update a compact progress log so the task can survive context compaction.
8. Continue until there are no known bugs, failing checks, or incomplete requirements.

The runner should be:
- **self-auditing** — it checks its own work after each batch
- **stateful** — it maintains a compact progress log and uses it as source of truth
- **resilient** — it survives context compaction and does not stop at partial implementation
- **validation-driven** — it never treats “code written” as “task complete”

For each phase, the runner should only mark completion when all of the following are true:
- implementation is complete
- relevant tests/checks pass
- no known bugs remain in scope
- the result matches the original requirements
- a final completion summary exists

The completion summary for each phase should include:
- what was built
- what files changed
- what tests/checks were run
- what passed or failed
- unresolved issues, if any
- a clear completion status

### Progress log format for all phases

Each phase should maintain a compact progress log with:
- completed work
- remaining work
- key decisions
- modified files
- validation results
- known issues / blockers

Recommended contents:
- `done:` short bullets
- `next:` short bullets
- `decisions:` short bullets
- `files:` changed file list
- `validation:` last commands + result
- `risks:` known remaining risks

That log should be reloaded before every major step.

---

### Phase 1 — Stabilize the current system and remove the highest-risk defects

#### Objective
Make the current memory / search / graph system trustworthy enough for day-to-day use before attempting deeper architecture changes.

#### Scope
1. Fix graph evidence capture so file-touch edges use real file paths.
2. Feed manual memories into WAL + graph population.
3. Connect spec memories via `source_spec_id`.
4. Include `related_files` as graph edges.
5. Make graph-context cache keys workspace-aware.
6. Make `/api/search` truly respect keyword / semantic / hybrid mode.
7. Enforce graph token budgets in `retrieveContext()`.
8. Stop matching retrieval results by raw text wherever feasible.

#### Likely files
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/lib/graph-context.ts`
- `backend/src/lib/graph-populator.ts`
- `backend/src/lib/memory-router.ts`
- `backend/src/lib/search.ts`
- `backend/src/routes/memory.ts`
- `backend/src/routes/recall.ts`
- `backend/src/lib/auto-memory.ts`
- tests under `backend/src/routes/__tests__/` and `backend/src/lib/__tests__/`

#### Phase 1 implementation loop
1. Start with the real file-touch path problem.
2. Make the smallest viable fix for one graph ingestion path.
3. Add tests that prove real file paths now appear in graph queries.
4. Validate retrieval still degrades cleanly when graph/AGE is unavailable.
5. Move to manual-memory graph linking.
6. Re-run tests.
7. Move to cache-key / budget / search-mode fixes one at a time.
8. Re-run tests after every batch.

#### Phase 1 validation
At minimum:
- graph route tests
- memory route tests
- recall tests
- targeted knowledge-graph / graph-context tests
- backend typecheck

#### Phase 1 completion bar
Phase 1 is only complete when:
- graph queries use real file evidence
- manual and spec memories can participate in graph context
- search mode semantics are correct
- graph token budgeting is real
- regression tests pass

---

### Phase 2 — Introduce skill-validated retrieval and better ranking

#### Objective
Turn skills from passive prompt content into active retrieval validators, judges, and rerankers.

#### Scope
1. Add a retrieval-candidate model with stable IDs and provenance.
2. Add a skill-aware validation / judge stage.
3. Let matched skills vote on keep/drop/needs-more for memory candidates.
4. Add contradiction / supersession detection for memories.
5. Add provenance-aware reranking using:
   - semantic score
   - lexical score
   - graph support
   - file/path overlap
   - recency
   - confidence
   - skill validator score
6. Add diversity-aware final selection (MMR-style).
7. Add explicit abstention behavior when evidence is weak.

#### Likely files
- `backend/src/lib/memory-router.ts`
- new retrieval-validator helper(s), likely under `backend/src/lib/`
- `backend/src/lib/skill-matcher.ts`
- `backend/src/lib/skill-registry.ts`
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/routes/recall.ts`
- possibly `backend/src/routes/specs.ts` for skill-matching enrichment
- new tests for candidate validation / reranking

#### Phase 2 implementation loop
1. Define the candidate schema first.
2. Add provenance fields without changing final prompt assembly yet.
3. Introduce a small validator path for one retrieval endpoint.
4. Verify that skills can score or reject candidates deterministically.
5. Add contradiction / abstention handling.
6. Switch final assembly to ranked candidates.
7. Re-run regression tests and add targeted eval fixtures.

#### Phase 2 validation
At minimum:
- all Phase 1 checks
- skill matching tests
- retrieval validator unit tests
- reranking tests
- contradiction-handling tests
- backend typecheck

#### Phase 2 completion bar
Phase 2 is only complete when:
- retrieval candidates have stable identity + provenance
- skill validators can influence ranking and filtering
- contradictions are surfaced instead of silently blended
- the system can abstain / request more retrieval when evidence is weak
- tests pass and retrieval quality is measurably improved on fixtures

---

### Phase 3 — Build true state-of-the-art GraphRAG with learning loops and evals

#### Objective
Convert the system from “retrieval with graph enrichment” into a compounding GraphRAG platform with evaluation, feedback, and continuous improvement.

#### Scope
1. Split retrieval into explicit stages:
   - recall
   - graph expansion
   - skill validation / rerank
   - budgeted assembly
2. Add retrieval telemetry for every run.
3. Add offline eval fixtures and benchmark suites.
4. Add online relevance feedback from successful runs.
5. Add graph edge confidence / evidence counts.
6. Add temporal freshness / decay policies.
7. Use successful run outcomes to improve future ranking.
8. Add dashboards or inspection surfaces for retrieval quality.

#### Likely files
- `backend/src/lib/memory-router.ts`
- new retrieval orchestration modules in `backend/src/lib/`
- `backend/src/lib/knowledge-graph.ts`
- `backend/src/lib/graph-context.ts`
- `backend/src/lib/auto-memory.ts`
- telemetry / analytics / WAL-related modules
- `backend/src/routes/recall.ts`
- `backend/src/routes/search.ts`
- `backend/src/routes/workspaces.ts` or analytics surfaces
- test/eval fixtures and benchmark harnesses

#### Phase 3 implementation loop
1. Establish eval fixtures before major ranking changes.
2. Add retrieval telemetry and prove it is stable.
3. Introduce stage-separated retrieval orchestration.
4. Add feedback loops from successful/failed runs.
5. Tune scoring with benchmark data rather than intuition.
6. Re-run offline evals and integration tests after each scoring change.
7. Iterate until quality gains are repeatable and measurable.

#### Phase 3 validation
At minimum:
- all Phase 1 and Phase 2 checks
- offline retrieval benchmark suite
- end-to-end recall / search / graph integration checks
- telemetry correctness tests
- regression tests for fallback / graceful degradation
- backend typecheck

#### Phase 3 completion bar
Phase 3 is only complete when:
- retrieval is stage-separated and measurable
- benchmark quality is tracked over time
- feedback from successful runs improves future retrieval
- graph edges carry confidence/evidence semantics
- the system has both offline and online quality signals
- no critical regressions exist in fallback behavior

---

## Bottom line

Rorca already has a promising multi-tier memory stack, but the **knowledge graph is not yet earning its keep** because the evidence feeding it is incomplete and some of the retrieval logic is still heuristic-only.

The fastest path to a genuinely state-of-the-art GraphRAG system is not a bigger model or more prompt text — it is:

- better graph construction
- better evidence linking
- better retrieval ranking
- proper budgeting
- and strict consistency between DB memories, file projections, and graph nodes
