# Rorca Genesis — Project Intelligence from Idea to Execution

## Linear Document Draft

**Status:** Living draft (progress updated 2026-07-09)  
**Owner:** Product / Platform  
**Created:** 2026-06-28  
**Related platform work:** `rorca-context-intelligence-platform`  

## One-line summary

**Rorca Genesis** is the project-start workflow for turning a new idea, company, or repo into a living knowledge base, decision ledger, plan, specs, and executable work.

## Progress update (2026-07-09)

Genesis is now a working local product:
- Phase 1 standalone Local KB is complete.
- PGlite/pgvector + Genesis vault are canonical truth.
- Spec-ready package generation intentionally stops before creating a Rorca spec.
- The Genesis → Rorca explicit-draft bridge is implemented and validated locally.
- Path-based Genesis doctor readiness is implemented.
- Required build/typecheck/tests/E2Es passed locally.

## Product thesis

When starting a brand-new project — for example a peptide / GLP-1 company — the first bottleneck is not code. The bottleneck is collecting knowledge, doing structured research, making decisions, preserving evidence, and converting that into plans and execution.

Hilo is useful for codebase structure once a repo exists, but it is not the primary product for venture/project research. Rorca Genesis should sit above Rorca's memory, skills, context retrieval, and spec orchestration systems to support a full project intelligence loop.

The state-of-the-art version is not “one memory database.” It is a **knowledge operating system** that separates:

> evidence → extraction → review → memory → decisions → planning → execution → feedback

## Naming

Recommended name: **Rorca Genesis**

Meaning:

> start from zero → ingest knowledge → research → decide → plan → spec → execute.

Suggested naming stack:

- **Rorca Context Intelligence Platform** — the underlying infrastructure layer.
- **Rorca Genesis** — the product/workflow for starting a new project/company.
- **Genesis Workspace** — a project/company knowledge space.
- **Genesis Skills** — reusable deep-research workflows.
- **Genesis Ledger** — decisions, assumptions, evidence, risks.
- **Genesis Brief** — the seed prompt/idea that starts the workspace.
- **Genesis Curator** — scheduled/manual knowledge curation over chats, sources, files, and research runs.

## State-of-the-art reference architecture

```txt
                           ┌────────────────────────────┐
                           │        User / Pi UI         │
                           │  chat, upload, approve, run │
                           └─────────────┬──────────────┘
                                         │
                       ┌─────────────────▼─────────────────┐
                       │          Rorca Genesis              │
                       │  project intelligence workspace     │
                       └─────────────────┬─────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
┌───────▼────────┐              ┌────────▼────────┐              ┌────────▼────────┐
│ Source Library │              │ Research Runs   │              │ Skills/Agents   │
│ raw evidence   │              │ reproducible    │              │ Pi / Hermes     │
└───────┬────────┘              └────────┬────────┘              └────────┬────────┘
        │                                │                                │
        ▼                                ▼                                ▼
 filesystem/object store        run traces + citations          reusable workflows
 PDFs, pages, notes, docs       prompts, outputs, sources       market, legal, code
        │                                │                                │
        └──────────────────────┬─────────┴───────────────┬────────────────┘
                               │                         │
                    ┌──────────▼──────────┐    ┌─────────▼──────────┐
                    │ Extraction Pipeline │    │ Scheduled Curator  │
                    │ chunk, summarize,   │    │ Hermes/Pi cron     │
                    │ embed, entity parse │    │ every N hours      │
                    └──────────┬──────────┘    └─────────┬──────────┘
                               │                         │
                               └──────────┬──────────────┘
                                          ▼
                             ┌────────────────────────┐
                             │ Candidate Knowledge    │
                             │ facts, risks, claims,  │
                             │ decisions, tasks       │
                             └───────────┬────────────┘
                                         │ human/agent review
                                         ▼
                     ┌────────────────────────────────────────┐
                     │          Rorca Canonical Store          │
                     │                                        │
                     │  Memories   Decisions   Specs   Runs   │
                     │  Sources    Research    Provenance      │
                     └───────────────┬────────────────────────┘
                                     │
            ┌────────────────────────┼────────────────────────┐
            ▼                        ▼                        ▼
   ┌────────────────┐       ┌────────────────┐       ┌────────────────┐
   │ Vector / FTS   │       │ Knowledge Graph│       │ Code Graph      │
   │ semantic search│       │ entities/edges │       │ Hilo/repo map   │
   └────────────────┘       └────────────────┘       └────────────────┘
            │                        │                        │
            └────────────────────────┬────────────────────────┘
                                     ▼
                          ┌─────────────────────┐
                          │ Context Composer    │
                          │ rank, cite, budget, │
                          │ pack prompt context │
                          └─────────┬───────────┘
                                    ▼
                          ┌─────────────────────┐
                          │ Execution / Planning│
                          │ specs, tasks, runs  │
                          └─────────┬───────────┘
                                    ▼
                          ┌─────────────────────┐
                          │ Feedback / Learning │
                          │ outcomes → memory   │
                          └─────────────────────┘

                    Redis = cache only, never truth
```

## Architectural principles

1. **Do not store “memory” as one blob.** Separate evidence, interpretation, durable memory, decisions, plans, specs, runs, indexes, and cache.
2. **Raw evidence stays raw.** Sources must remain citeable and auditable.
3. **Research artifacts should be human-readable.** Markdown reports, decision memos, and plans should work in a filesystem/Obsidian-style vault.
4. **Rorca is the canonical operating system of record.** Rorca should own approved memories, decisions, specs, runs, provenance, review state, and context assembly.
5. **Indexes are rebuildable.** Vector search, full-text search, entity graphs, and code graphs accelerate retrieval but should not be the only truth.
6. **Redis is cache only.** Redis can store hot context, session state, retrieval caches, queue state, and rate limits, but the project must not forget if Redis is flushed.
7. **Autonomy proposes; humans commit high-risk decisions.** Especially in regulated domains like healthcare, peptides, supplements, finance, and legal.
8. **Skills are operators, not storage.** Skills do research, synthesis, review, planning, and execution over the underlying stores.
9. **Context must be explainable.** Every retrieved context bundle should show why sources/memories/decisions/specs were selected.
10. **Execution feeds learning.** Runs should create artifacts, outcomes, lessons, and candidate memories/decisions.

## Store and system-of-record model

Genesis should use four distinct storage classes.

### 1. Source store

Where raw evidence lives.

Examples:

```txt
genesis/sources/
  papers/
  competitor-pages/
  supplier-docs/
  transcripts/
  regulations/
  founder-notes/
```

This is the “court record.” It should be append-friendly, citeable, and resistant to accidental mutation.

Suitable backing stores:

- local filesystem
- Git-backed project vault
- object storage
- external document connectors
- URLs with snapshots

### 2. Artifact store

Human-readable outputs created by research and planning.

Examples:

```txt
genesis/research/
  market-landscape.md
  competitor-matrix.md
  regulatory-risk.md

genesis/decisions/
  DEC-001-positioning.md
  DEC-002-claims-policy.md

genesis/plans/
  launch-plan.md
  roadmap.md
```

This can mirror to Obsidian or any Markdown vault. It should be useful even without a database UI.

### 3. Canonical Rorca store

The durable operational truth.

Rorca should own:

- approved memories
- decisions
- specs
- pipeline runs
- source metadata
- research run metadata
- provenance and citations
- review queue state
- context traces
- execution feedback

This is what agents should trust when planning or executing.

### 4. Index/cache layer

Fast retrieval and working memory, never sole truth.

Includes:

- vector index
- full-text index
- entity/knowledge graph
- Hilo/codegraph when a repo exists
- Redis hot cache
- retrieval result cache
- prompt/context bundle cache

Redis, vector indexes, and graph caches should be rebuildable from canonical stores and source/artifact records.

## Practical operating model

Genesis should be a hybrid workflow, not a single monolithic database.

Recommended model:

> Filesystem stores raw sources and human-readable artifacts.  
> Rorca stores curated knowledge, decisions, specs, provenance, and execution state.  
> Skills operate across both.  
> Indexes accelerate retrieval.  
> Hilo only becomes relevant once code exists.  
> Redis is cache only.

### Interactive Pi mode

The most natural day-to-day Genesis experience starts in a Pi session.

Example user prompt:

> “I’m starting a GLP-1 / peptide company. Help me research the market, risks, suppliers, and first launch plan.”

Pi should act as the conversational operator:

1. create or select a Genesis Workspace
2. ask a small number of setup questions
3. create the initial filesystem workspace structure
4. run selected Genesis skills
5. write research artifacts to files
6. propose memory and decision candidates
7. save approved durable findings into Rorca
8. create Rorca specs when research becomes executable work

From the user’s perspective, they should be able to start by simply typing in Pi. Pi coordinates the work; Rorca remembers and orchestrates it.

### Hermes / full-autonomy mode

Full autonomy is useful for bounded research jobs, not for unbounded strategic delegation.

Good autonomous task:

> “Research GLP-1 telehealth competitors. Return a competitor matrix, citations, risks, and memory candidates. Do not make final strategic decisions.”

Bad autonomous task:

> “Go start the company for me.”

For regulated or high-risk domains, autonomous agents should produce:

- findings
- source citations
- proposed memories
- proposed decisions
- risks
- open questions
- follow-up tasks

Human approval should be required before promoting high-impact decisions or compliance-sensitive memories.

Recommended split:

- **Pi** = interactive strategist/operator
- **Hermes/full autonomy** = bounded background research worker
- **Rorca** = canonical memory, planning, and execution layer

### Scheduled Genesis Curator

The most important pattern to borrow from “Hermes cron builds my knowledge base” is the scheduled curator, not any one memory backend.

A Genesis Curator should run manually or every N hours:

1. scan recent Pi/Hermes chats
2. scan new source files and project artifacts
3. summarize new research outputs
4. extract candidate facts, risks, assumptions, claims, decisions, and tasks
5. detect contradictions and stale memories
6. write/update Markdown research artifacts
7. propose memories and decisions
8. queue candidates for review
9. promote approved items into Rorca
10. optionally export/mirror to Obsidian-style vaults

This makes Rorca Genesis continuously maintain the project knowledge base without silently committing unsafe conclusions.

### UI mode

The UI should eventually expose the same loop visually:

- create Genesis Workspace
- upload/link sources
- run research skills
- inspect research runs
- review candidate findings
- approve decisions
- generate plans/specs
- execute selected specs
- see context/provenance for every result

### UI-first deep research mode

Genesis should explicitly support a workflow where the user does the actual deep research in the best external UI first, then captures the results into the Genesis knowledge system.

Examples:

- Gemini UI
- ChatGPT UI
- Claude UI
- other best-in-class research UIs

Recommended pattern:

> external deep-research UI → capture/export/share → Genesis inbox/vault → Hermes scheduled curation → Obsidian and DuckBrain local updates + Rorca promotion

This means Genesis does not need to replace the best research UIs immediately. It should become the durable system that captures, curates, and reuses their outputs.

Two supported operating modes:

#### A. Local-first UI capture

Best when the user mainly wants a laptop-local Obsidian/DuckBrain workflow.

```txt
Gemini/ChatGPT UI
   ↓
Save/export/share locally
   ↓
Obsidian inbox folder + local DuckBrain store
   ↓
Local Hermes/collector on schedule
   ↓
summaries / notes / decisions / tags / memory candidates
```

This works well when:

- the laptop is usually on
- the user wants the simplest setup
- automation can pause when the laptop is off

#### B. Remote canonical + local mirrors

Best long-term when the laptop may be off but the user still wants local Obsidian and DuckBrain copies.

```txt
Gemini/ChatGPT UI
   ↓
Save/export/share to remote Genesis vault
   ↓
Hermes remote runs on schedule
   ↓
updates remote artifacts + Rorca canonical state
   ↓
Obsidian syncs to laptop automatically
   ↓
DuckBrain local store refreshes on laptop automatically
```

This works well when:

- the laptop may be off
- the user wants always-on automation
- the user wants a cleaner long-term architecture

Preferred UX direction:

- keep using the best UI for deep research
- add a simple capture layer such as export, share target, inbox folder, or “Save to Genesis” action
- let Hermes curate the captured outputs on a schedule
- write human-readable notes to Obsidian
- write machine-friendly/project-memory artifacts to DuckBrain locally on the laptop
- promote approved durable memories/decisions/specs into Rorca

Important caveat:

Hermes should not depend on scraping live web sessions if avoidable. The preferred model is explicit capture into a known inbox/vault path, then scheduled curation.

## Tool positioning

### Hilo / codegraph

Hilo is not the Genesis memory system. It is structural code intelligence.

Use Hilo when a workspace includes software and Rorca needs to know:

- dependencies
- impacted files
- entrypoints
- tests
- blast radius
- related code neighborhoods

For non-code venture research, Genesis needs a **domain knowledge graph**, not merely a codegraph.

### Redis

Redis is excellent for efficiency:

- hot context cache
- retrieval result cache
- embeddings/query cache
- session cache
- job state
- rate limits

But Redis should never be durable memory.

### DuckBrain

DuckBrain is optional inspiration or a possible backend experiment, not a required dependency.

It overlaps with Rorca memory. Genesis should not anchor on DuckBrain because Rorca already owns:

- workspaces
- memories
- decisions
- specs
- runs
- provenance
- context packing
- readiness
- execution

The valuable pattern is **scheduled knowledge curation**, not DuckBrain specifically.

### Obsidian / Markdown vault

Obsidian-style Markdown is useful as a human-readable mirror or artifact store.

Good fit for:

- research reports
- decision memos
- weekly summaries
- source notes
- plans
- roadmaps
- inbox capture from external deep-research UIs

Rorca should still own the canonical execution-aware state.

### DuckBrain local mirror/store

DuckBrain should be treated as an optional local machine-friendly mirror/store on the laptop, not the required canonical system.

Good fit for:

- local semantic recall over captured research artifacts
- local machine-readable memory/index for laptop workflows
- fast retrieval over curated notes and summaries
- personal/offline recall when synced artifacts already exist locally

Recommended positioning:

- **Rorca** = canonical durable system of record
- **Obsidian** = human-readable local mirror/vault
- **DuckBrain** = machine-friendly local mirror/index on the laptop

In the preferred UI-first workflow, Hermes or a local collector can update both Obsidian and DuckBrain on a schedule from captured research artifacts.

### Caveman and Ponytail

Caveman and Ponytail are skills/personas, not knowledge-base layers.

- **Caveman** = terse-output/token-compression skill.
- **Ponytail** = minimalism/anti-overengineering senior-dev skill.

They can improve agent behavior inside Genesis:

- Caveman for cheap extraction/summarization/log output.
- Ponytail for simplifying specs, plans, implementations, and avoiding overbuild.

They do not replace memory, sources, decisions, indexes, or Rorca.

## How this relates to the running `rorca-context-intelligence-platform` spec

The current `rorca-context-intelligence-platform` spec is the infrastructure layer Genesis needs.

It adds or strengthens:

- workspace hydration
- Hilo-backed structural context for repos
- brief-aware context retrieval
- memory and prior-spec retrieval
- explainable context ranking
- safe excerpts and token budgeting
- retrieval trace persistence
- spec-generation context bundles
- context preview before spec creation
- `rorca-capture remember`
- git/commit ingestion
- context event and candidate ingestion
- candidate review and promotion UI
- observability and diagnostics

This does not fully implement Genesis as a product experience, but it creates the nervous system for it.

## Bridge to existing Rorca Forge/spec creation

The detailed implementation bridge is tracked in:

- `docs/prds/rorca-genesis/linear-bridge-and-implementation-plan.md`

Core bridge decision:

> Genesis produces approved product intelligence. Rorca Forge consumes an explicit handoff and turns it into a canonical executable spec.

Minimal bridge:

```txt
genesis/handoffs/*.md
        ↓
/rorca-genesis-to-spec
        ↓
rorca_specs_generation_context
        ↓
Pi drafts canonical stories
        ↓
rorca_create_spec(contextUsed, contextSummary)
        ↓
Rorca validates/enriches/persists
        ↓
approve/run when ready
```

This uses existing Rorca surfaces first:

- `rorca_specs_generation_context`
- `rorca_create_spec` / `rorca_persist_spec`
- `rorca_get_specs_by_specId`
- `rorca_spec_workflow` / `rorca_spec_readiness`
- `rorca_save_memory`
- `rorca_put_direction`
- `rorca_approve_spec`
- `rorca_trigger_run`

No new backend crawler or Genesis database is required for v0. Pi can read explicit handoff/source paths and call existing Rorca MCP tools. Backend/UI import should be explicit and allowlisted rather than blindly crawling arbitrary folders.

## Preliminary filesystem-first version

Before the full Genesis product exists, the fastest useful version is a filesystem-first project workspace that Rorca can gradually import from.

Recommended structure:

```txt
genesis/
  brief.md
  sources/
    papers/
    competitor-pages/
    supplier-docs/
    regulations/
    transcripts/
  research/
    market-landscape.md
    competitor-matrix.md
    regulatory-risk.md
  decisions/
    DEC-001-positioning.md
    DEC-002-claims-policy.md
  memories/
    candidate-findings.jsonl
  plans/
    launch-plan.md
    roadmap.md
  specs/
```

Operating rule:

- raw docs stay in `sources/`
- research reports stay in `research/`
- durable insights become Rorca memories
- commitments become Rorca decisions
- execution plans become Rorca specs

This avoids prematurely stuffing every artifact into the database while still giving Rorca the curated durable layer.

## Product layers

Not every layer must be mandatory. Genesis should have a small required core and optional advanced layers.

### 1. Workspace

**Required.**

The container for a company/project/repo.

Examples:

- “GLP-1 company idea”
- “New peptide clinic rollout”
- “Real estate fund”
- “B2B SaaS product”

Contains:

- sources
- memories
- decisions
- specs
- research runs
- skills
- plans

### 2. Source Library

**Mostly required.**

Raw evidence and uploaded knowledge. This is not memory yet.

Examples:

- PDFs
- scientific papers
- FDA/FTC guidance
- web pages
- competitor pages
- notes
- transcripts
- supplier docs
- pricing sheets
- clinical studies
- legal/compliance memos

Purpose:

> preserve original evidence so research conclusions can be cited, audited, and revisited.

### 3. Memory / Knowledge Base

**Required.**

Curated knowledge extracted from sources and research.

Examples:

- facts
- findings
- assumptions
- gotchas
- patterns
- risks
- open questions
- reusable decisions

Purpose:

> answer “what have we learned?” across sessions and future work.

### 4. Decision Ledger

**Strongly recommended, optionally enabled at first.**

Tracks explicit decisions instead of letting projects drift on vibes.

Each decision should capture:

- decision
- context
- options considered
- evidence
- alternatives rejected
- risks
- confidence
- owner
- revisit date

Example:

> Decision: avoid direct “weight-loss cure” claims.  
> Evidence: FDA/FTC enforcement risk.  
> Confidence: high.  
> Revisit: after legal review.

### 5. Skills / Workflows

**Required for leverage.**

Skills are not the storage layer. They are reusable procedures that operate over the workspace, sources, memories, and decisions.

Example Genesis skills:

- `market-landscape-research`
- `competitor-matrix`
- `clinical-evidence-review`
- `regulatory-risk-review`
- `supplier-diligence`
- `pricing-strategy`
- `decision-memo`
- `launch-roadmap`
- `claims-review`
- `knowledge-curator`
- `source-ingestion-review`
- `assumption-map`
- `risk-register-builder`

A skill can:

1. read source documents
2. search memory
3. ask clarifying questions
4. generate a research report
5. propose decisions
6. save memories
7. create specs/tasks
8. update plans

### 6. Plans / Specs

**Required once the user wants action.**

Research should become executable artifacts:

- roadmap
- launch plan
- operating plan
- SOP
- product spec
- hiring plan
- compliance checklist
- execution backlog

This is where Rorca is already strong.

### 7. Ontology / Entity Graph

**Optional early, powerful later.**

Tracks important domain entities and relationships.

For a peptide / GLP-1 company, entities could include:

- compounds
- suppliers
- competitors
- regulations
- studies
- products
- claims
- jurisdictions
- risks
- customer segments

Purpose:

> turn a pile of notes into a navigable knowledge map.

### 8. Review Queue

**Optional, but very useful.**

Research outputs should not automatically become durable memory. Findings can first become candidates, then a user can review/promote/reject them.

Purpose:

> prevent garbage memory and preserve user control.

This maps well to the candidate ingestion/review work in `rorca-context-intelligence-platform`.

### 9. Deep Research Runs

**Optional as formal objects, but likely important for UI.**

Each research session should have:

- question
- sources used
- findings
- citations
- generated memories
- decisions proposed
- follow-up tasks
- confidence/risk notes

Purpose:

> make research reproducible and auditable.

### 10. Execution System

**Optional for pure research; required for building.**

Examples:

- build landing page
- create CRM automation
- draft SOP docs
- generate outreach sequences
- implement dashboard
- create investor materials
- launch internal tools

This is the handoff from Genesis back into Rorca specs/runs.

## SSDLC autonomy contracts for complete end-to-end execution

Genesis, Rorca, and Hermes should treat autonomous software delivery as a **contract-driven SSDLC loop** rather than as a long-running prompt. The operating principle is:

> Agents may spend tokens, but only validated contracts advance state.

This is especially important for high-token autonomous work. Token spend can be tolerated if progress is durable, resumable, auditable, and safely recoverable. The system should never rely on an agent's final message alone to decide that a story, branch, canary, or merge is complete.

### Why this is needed

Recent Rorca/Hermes runs exposed several state-ambiguity problems that this contract layer should eliminate:

1. **Retry scope drift.** A retry intended for `UCC-008` re-executed earlier UCC stories because copied `story_results` and approved-spec `passes` flags diverged. The system needs a pass-state reconciler before retries.
2. **Clean worktree misclassified as no-op.** In MCR, Pi committed story work itself, leaving the worktree clean. The old pass gate only inspected dirty files and failed the story as `no_code_changes`. The pass gate now checks commits since story start, but this should become a formal story-output contract.
3. **Agent success is not story pass.** A subprocess can exit successfully while changing only runtime metadata, failing validation, skipping integration, or leaving uncommitted work. Story pass must require evidence.
4. **Long-running stories are opaque.** Operators had to inspect WAL events, processes, story logs, git status, DB rows, and progress files to determine whether a 90-minute story was alive. Liveness and progress should be first-class.
5. **Run heartbeat was insufficient.** Token WAL events showed activity while `pipeline_runs.last_heartbeat` was empty. The supervisor should classify liveness from multiple signals and write canonical status.
6. **Reusable worktrees can go stale.** A retry was blocked because the feature worktree merge-base no longer matched workspace `HEAD`. Worktree freshness should be a preflight contract with a safe repair path.
7. **Validation failures require classification.** Several stories passed focused validation while broader repo checks failed due unrelated baseline errors. The system needs machine-readable validation evidence that distinguishes story-caused failures from known baseline failures.
8. **Checked-in runtime artifacts can drift.** Some UCC work required `.ts` and checked-in `.js` artifacts to stay synchronized. Artifact-sync checks should be deterministic contract checks.
9. **Sequential intent was not guaranteed.** `forceSequential` was not sufficient for some modular/merge-readiness work, so the DAG had to be linearized manually. The execution plan should be verified before run start.
10. **Canary and merge readiness remain human-dependent.** Local tests are not enough for live ChatOps readiness. Merge-to-main must require canary evidence and explicit approval when the integration is high risk.
11. **PTY visibility is not yet faithful.** Operators still need file/log inspection when the terminal view does not show the real live CLI session. Terminal evidence should be part of observability.

### Principal-level SSDLC contracts

#### 1. Spec contract

A spec is executable only when:

- the approved spec path, slug, workspace, and branch are unambiguous;
- every story has clear acceptance criteria;
- the story DAG is valid and intentionally ordered;
- high-risk or modular merge-readiness specs are linear unless explicitly parallel-safe;
- required skills and validation gates are known;
- stale `passes` flags have been reconciled against `story_results`, commits, and progress artifacts;
- readiness blockers are explicit and either resolved or intentionally overridden with audit evidence.

#### 2. Story contract

A story passes only when it produces a durable completion packet and pass-gate evidence. The packet should be machine-readable, for example:

```json
{
  "storyId": "UCC-008",
  "implemented": true,
  "acceptanceCriteriaEvidence": [
    { "criterion": "...", "evidence": "test/log/commit reference" }
  ],
  "filesChanged": ["..."],
  "commits": ["..."],
  "validation": [
    { "command": "npm test ...", "status": "pass", "scope": "focused" }
  ],
  "knownIssues": [
    { "issue": "...", "classification": "unrelated_baseline|story_blocker|follow_up" }
  ],
  "safeToCommit": true,
  "safeToPass": true,
  "nextRecommendedAction": "continue|retry|pause|request_approval"
}
```

The pass gate should verify:

- meaningful code, doc, migration, test, or configuration changes exist;
- committed story changes since story start count even when the worktree is clean;
- runtime-only metadata changes do not count as implementation;
- validation evidence exists and maps to acceptance criteria;
- progress files and completion packet agree;
- known issues are classified;
- the story was committed or intentionally left as a checkpoint with explicit reason.

#### 3. Integration contract

A branch is integration-ready only when:

- it merges cleanly with the target branch or has an explicit conflict-resolution plan;
- story-created commits are present and traceable to story IDs;
- repo-wide validation is green, or failures are classified as unrelated baseline with evidence;
- database migrations are idempotent, ordered, and brownfield-safe;
- generated/runtime artifacts are synchronized with source artifacts;
- no story has been marked passed merely because the agent exited successfully;
- pass-state has been reconciled back to the canonical approved spec after retries.

#### 4. Canary contract

A live or integration-heavy feature is merge-ready only when:

- the canary target, credentials, channel/environment, and rollback path are known;
- the canary is run in a safe mode first when possible;
- evidence is captured as logs, screenshots, API responses, or structured result objects;
- failures are classified as environment, credential, product, or regression issues;
- auto-merge remains disabled unless the spec explicitly permits it;
- final merge/deploy requires explicit human approval for high-risk integrations.

#### 5. Recovery contract

Every stalled or failed autonomous run should resolve to a safe next action:

- stale worktree → refresh while preserving commits, then retry the smallest safe scope;
- quota/rate limit → pause, switch approved model, or retry without losing progress;
- no token/log activity → snapshot state, preserve diff, classify stalled, then retry or cancel;
- no meaningful changes → inspect commits since story start before failing;
- validation failure → classify as story-caused, unrelated baseline, environment, or follow-up;
- unknown state → stop and request operator decision rather than guessing;
- passed previous stories → copy/reconcile pass state instead of rerunning them from scratch.

### Small deterministic skills that complete the loop

The system should prefer simple controller skills over giant autonomous prompts. Recommended skills:

| Skill | Purpose |
|---|---|
| `spec-readiness-skill` | Validate spec path, workspace, DAG, approval state, story order, and readiness blockers. |
| `pass-state-reconciler-skill` | Reconcile approved spec `passes` flags with `story_results`, commits, and progress packets before retries/runs. |
| `worktree-freshness-skill` | Detect stale reusable worktrees and safely merge/rebase target branch while preserving feature commits. |
| `story-runner-skill` | Execute exactly one story, maintain progress, and require a completion packet. |
| `story-validator-skill` | Run focused and broad checks, classify failures, and map validation to acceptance criteria. |
| `commit-checkpoint-skill` | Commit meaningful story work with canonical story commit messages and changed-file evidence. |
| `retry-planner-skill` | Choose the smallest safe retry scope and verify that the actual execution plan matches intent. |
| `merge-readiness-skill` | Decide whether a branch is PR-ready, merge-ready, blocked, or needs canary evidence. |
| `canary-skill` | Execute live or dry-run canaries and persist structured canary evidence. |
| `memory-writer-skill` | Save durable lessons, gotchas, decisions, and follow-ups after story/run completion. |
| `operator-report-skill` | Produce a concise human approval report from DB, WAL, git, logs, and completion packets. |

### Hermes supervisor loop

Hermes should act as the autonomous supervisor, not as the only coder. Its durable loop should be:

```txt
observe → classify → choose skill → execute → verify evidence → advance state
```

Example liveness policy:

```txt
If token/WAL/log activity is recent:
  classify as active and wait.
If no activity but process exists:
  inspect terminal/log/git/progress and classify active, stalled, or blocked.
If process is gone and story incomplete:
  preserve diff, write incident packet, and retry smallest safe scope.
If story passed but spec flags disagree:
  reconcile before scheduling the next run.
```

### End-to-end autonomous SSDLC flow

The intended complete flow is:

1. Forge or persist a spec.
2. Run spec-readiness and pass-state reconciliation.
3. Approve the spec.
4. Create or freshen the worktree.
5. Execute the next story only.
6. Write progress and a completion packet.
7. Validate focused checks, broad checks, migrations, artifact sync, and acceptance evidence.
8. Commit a checkpoint or verify agent-created commits.
9. Mark the story passed only after the contract passes.
10. Retry only the smallest failed scope when needed.
11. Reconcile pass state after retries.
12. Run merge-readiness checks.
13. Run canary checks when required.
14. Request explicit human approval for high-risk merge/deploy.
15. Merge/deploy only after evidence is complete.
16. Save memories, decisions, gotchas, and follow-up tasks.

### Implementation priority

Highest-leverage backlog items:

1. Add required story completion packets.
2. Add pass-state reconciler before retry/run scheduling.
3. Formalize worktree freshness and safe refresh as a skill/contract.
4. Upgrade retry planner to verify actual execution scope before starting.
5. Add merge-readiness and canary-evidence contracts.
6. Add canonical liveness/heartbeat classification from process, WAL, logs, terminal, DB, and git state.
7. Productize faithful interactive PTY evidence for live CLI visibility.
8. Auto-write memory/decision/follow-up candidates at run closeout.

## Practical Genesis flow

### 1. Ingest

User creates a Genesis workspace and uploads/links raw materials.

Input examples:

- “I want to start a peptide / GLP-1 company.”
- uploaded research papers
- competitor URLs
- supplier docs
- founder notes
- chat transcripts

Output:

- source library entries
- initial workspace brief
- suggested research skills
- initial candidate questions

### 2. Research

User or Hermes runs Genesis skills against the workspace.

Example skills:

- market landscape
- regulatory pathway
- claims risk
- competitor matrix
- supplier diligence

Output:

- research reports
- candidate findings
- citations
- open questions
- risks

### 3. Distill

User reviews candidate findings and promotes the useful ones.

Output:

- curated memories
- decisions
- assumptions
- risks
- entity records
- follow-up tasks

### 4. Plan

Rorca turns research into structured plans/specs.

Output:

- roadmap
- launch plan
- product spec
- compliance checklist
- operating plan
- backlog

### 5. Execute

Rorca executes selected specs or tasks.

Output:

- code/docs/work artifacts
- run logs
- new memories
- updated decisions
- updated plans

### 6. Feedback

Outcomes from execution and new research feed back into Genesis.

Output:

- candidate lessons
- stale-memory review
- decision updates
- revised plans/specs

## Clean operating loop

1. **User types in Pi**
   - ask questions
   - request research
   - upload/link sources
   - ask for decisions/plans/specs

2. **Pi or Hermes runs skills**
   - writes research artifacts
   - cites sources
   - proposes memories and decisions
   - creates follow-up tasks

3. **Review queue gates durable knowledge**
   - approve, reject, merge, or defer candidate findings
   - require stronger approval for regulated/high-risk decisions

4. **Rorca stores durable state**
   - approved memories
   - decisions
   - specs
   - execution state
   - provenance

5. **Rorca retrieves context later**
   - from memory
   - from sources
   - from decisions
   - from specs/runs
   - from entity graph
   - from Hilo/code graph when a repo exists

6. **Rorca executes**
   - specs become work
   - runs produce artifacts
   - outcomes feed back into memory and decisions

## MVP recommendation

### Required for MVP

- Workspace
- filesystem-first Source Library
- Memory / Knowledge Base
- Skills / Workflows
- Plans / Specs
- Review Queue for candidate findings
- Genesis handoff files
- `rorca-genesis-to-spec` bridge skill

### Strongly recommended for MVP

- Decision Ledger
- Genesis Curator scheduled/manual job
- source citations and provenance
- Markdown artifact vault

### Later / advanced

- formal ontology/entity graph
- formal deep research run objects
- team collaboration
- compliance/audit workflows
- advanced source connectors
- external web/deep-research integrations
- Obsidian export/mirror
- regulated-domain policy packs

## Key product principle

Genesis is not “just skills,” “just memory,” “just Redis,” or “just a codegraph.”

It is:

> source library + artifact vault + memory + decisions + skills + plans/specs + execution + feedback

Skills are how the system does work.  
Memory is how it learns.  
Sources are where evidence comes from.  
Decisions are how it commits.  
Specs are how it acts.  
Runs are how it learns from reality.  
Indexes make it fast.  
Redis makes it hot.  
Rorca makes it durable and executable.

## Open questions

1. Should Genesis be a new top-level panel or a mode inside existing Workspaces/Specs?
2. Should source uploads be stored in Rorca directly, via filesystem-backed workspace folders, or via pluggable object-storage backends?
3. Should decision ledger be a new first-class table/resource or an extension of memory categories?
4. Should Genesis skills be ordinary Pi/Rorca skills, or have a special manifest/type?
5. Should deep research runs be first-class durable objects?
6. Should source-library citations be mandatory for promoted memories?
7. How should Genesis handle regulated-domain guardrails, especially healthcare, supplements, peptides, and finance?
8. What approval rules should separate autonomous research from human-approved decisions?
9. How should Pi interactive sessions and Hermes autonomous jobs share the same workspace state?
10. What is the minimum filesystem convention Rorca should support before a full Genesis UI exists?
11. Should Obsidian/Markdown be a first-class export/mirror or simply a filesystem convention?
12. How should entity/knowledge graph reconstruction work from sources, memories, decisions, and specs?
13. How should context bundles explain why each source/memory/decision/spec was included?

## Initial backlog candidates

1. Define the `genesis/` filesystem convention and import contract.
2. Create Genesis workspace onboarding flow.
3. Add source library model and upload/link ingestion.
4. Add source search, citation extraction, and source provenance.
5. Add decision ledger resource and UI.
6. Add Genesis skill manifest type.
7. Add Pi interactive Genesis starter skill.
8. Add `rorca-genesis-to-spec` handoff bridge skill.
9. Add Hermes bounded deep-research job template.
10. Add Genesis Curator scheduled/manual job.
11. Add market landscape research skill.
12. Add regulatory/claims risk review skill.
13. Add competitor matrix skill.
14. Add supplier diligence skill.
15. Add knowledge curator skill.
16. Add research run object with provenance/citations.
17. Add candidate finding review and promotion flow.
18. Add contradiction/stale-memory detection for Genesis candidates.
19. Add Genesis plan/spec generator.
20. Add Genesis dashboard with sources, memories, decisions, plans, and next actions.
21. Add guardrails for regulated/high-risk domains and require approval for promoted decisions.
22. Add Markdown/Obsidian-style artifact export.
23. Add entity/knowledge graph extraction for domain entities.
24. Add context composer explanations for Genesis retrieval bundles.

## Positioning statement

**Rorca Genesis** is a project intelligence workspace for founders, operators, and builders who need to turn messy early-stage knowledge into evidence-backed decisions, plans, specs, execution, and continuous learning.
