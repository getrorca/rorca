# Hilo + Rorca GitHub Repo Hydration Architecture

## Linear-ready title

Use Hilo as Rorca’s GitHub repo hydration and structural context layer

## Summary

Hilo should be treated as more than a “git hydrator,” but less than an event-memory system. It is a repo map: a DB-light/DB-less structural context layer that can scan a connected GitHub repository and expose file inventory, dependencies, entrypoints, test relationships, impact radius, and related-file graph queries without requiring the agent to read the entire codebase.

For Rorca, Hilo can become the first-pass repo hydration layer when a user connects GitHub. Rorca keeps specs, execution history, memories, and SSDLC workflow state. Hilo provides the structural map of the repository that improves context selection before specs and runs.

## Core distinction

- **Hilo tells Rorca what the repo is.**
  - Files
  - Dependencies
  - Entrypoints
  - Tests
  - File roles
  - Blast radius
  - Related files

- **Rorca tells the agent what should happen next.**
  - Specs
  - Stories
  - Acceptance criteria
  - SSDLC phase gates
  - Pipeline runs
  - Approval/review state

- **Rorca memory tells the agent what happened before.**
  - Prior run failures
  - Architectural decisions
  - Bug fixes
  - Gotchas
  - Conventions
  - Security findings

Hilo is therefore not a replacement for Rorca memory. It is a structural substrate that makes Rorca’s memory and spec retrieval more accurate.

## Why this matters

A connected GitHub repo is not automatically useful to an agent. Without hydration, the agent still has to spend tokens discovering structure by reading files, grepping imports, and guessing where tests or entrypoints live.

Hilo can precompute that map before the agent asks.

This makes Rorca’s context cascade stronger:

1. **CAG / cached context** — direction stack, repo summary, current spec, stable conventions.
2. **RAG / semantic memory** — prior specs, run results, bug fixes, decisions, lessons learned.
3. **GraphRAG / structural relationships** — Hilo repo graph plus Rorca spec/story/run/memory graph.

Graph hits may be sparse, but when Hilo can answer “what depends on this file?” or “what tests cover this area?”, those hits are high-signal.

## Proposed integration flow

### 1. User connects GitHub repo

Rorca already has or can extend GitHub connection flow:

```text
User connects GitHub repo
  → Rorca clones/fetches repo into workspace
  → Rorca runs Hilo hydration
  → Rorca stores Hilo-derived repo context snapshot
  → Specs and runs can consume the snapshot
```

### 2. Run Hilo hydration

On connect, and periodically after major changes, Rorca runs:

```bash
hilo init
hilo graph discover
hilo classify
```

Optional queries:

```bash
hilo graph stats
hilo graph impact <file> --max-depth 3
hilo graph related <file> --relation imports
```

### 3. Persist a Rorca repo context snapshot

Rorca should not treat Hilo output as “memory events” by default. Instead, it should store a versioned repo context snapshot:

```text
.rorca/repo-context/
  hilo-summary.json
  file-inventory.jsonl
  dependency-edges.jsonl
  file-classification.jsonl
  generated-at.json
```

This snapshot becomes CAG/GraphRAG input, not human-authored memory.

### 4. Ingest selected graph edges into Rorca knowledge graph

Rorca can optionally ingest Hilo edges into its knowledge graph as structural edges:

```text
FILE imports FILE
FILE depends_on FILE
FILE tested_by FILE
FILE role entrypoint|test|library|config
FILE impacts FILE
```

These should be distinguished from event/memory edges:

```text
STORY changed FILE
RUN failed_on STORY
MEMORY about FILE
DECISION affects FILE
BUG_FIX resolved FAILURE
```

This keeps structural truth separate from historical truth.

### 5. Use Hilo during spec generation and execution

When drafting or running a spec, Rorca can ask:

- Which files are likely relevant to this story?
- Which tests cover those files?
- What is the blast radius of modifying this component?
- Are there entrypoints or config files nearby?
- Which files are related structurally but not semantically obvious?

The result should be injected as bounded context, for example:

```text
Repo Map Context
- Likely files: src/auth/session.ts, src/auth/middleware.ts
- Tests: tests/auth/session.test.ts
- Entrypoints: src/server.ts
- Impact radius: 14 files, primarily auth and API middleware
- Structural warning: auth middleware is imported by billing routes
```

## Where Hilo fits in the Rorca architecture

```text
GitHub Repo
   ↓
Hilo Hydration
   ↓
Repo Context Snapshot / Structural Graph
   ↓
Rorca Context Router
   ├── CAG: direction stack + repo summary
   ├── RAG: memories + prior specs + run history
   └── GraphRAG: Hilo file graph + Rorca execution graph
   ↓
Spec generation / approval / execution
   ↓
Run results become Rorca memory/events
```

## What Hilo is not

Hilo should not be treated as the full memory system.

It does not primarily answer:

- What happened in the last run?
- Why did we make this architecture decision?
- What bug did we already fix?
- Which acceptance criterion failed?
- What did the agent try before?

Those are Rorca memory, DuckBrain, or Conscience-style concerns.

Hilo answers:

- What is in the repo?
- How is it connected?
- What would be impacted if this changes?
- Which files are structurally related?

## Product value for Rorca

Using Hilo on GitHub connect gives Rorca an immediate repo understanding layer before any spec is written.

Benefits:

- Faster onboarding for brownfield repos
- Better initial L3 workspace direction/context
- Better spec drafting because Rorca knows repo shape
- Better execution prompts because agents get relevant files/tests upfront
- Better GraphRAG precision from real dependency edges
- Less token waste on repo discovery
- No need for a heavy always-on database just to map code structure

## Open design questions

1. Should Hilo output live inside `.rorca/repo-context/`, `.hilo/`, or both?
2. Should Rorca ingest all Hilo edges into Postgres/graph storage, or query Hilo on demand?
3. Should repo hydration run synchronously on GitHub connect or asynchronously as a background job?
4. How often should hydration refresh after pipeline runs or git pulls?
5. Should Hilo-derived structural summaries become memories, or remain separate cached context?
6. Can Hilo help generate the initial Rorca L3 workspace direction for brownfield repos?

## Recommended first implementation

Start with a lightweight integration:

1. Add a `hydrate repo` backend job after GitHub connect.
2. Run Hilo CLI against the workspace path.
3. Store a bounded `hilo-summary.json` in `.rorca/repo-context/`.
4. Add the summary to Rorca context routing as cached repo context.
5. Do not ingest every edge into Rorca’s DB yet.
6. Later, add selective graph ingestion for files touched by specs/runs.

This gives Rorca immediate value without overcommitting to a deep graph migration.

## Acceptance criteria

- When a user connects a GitHub repo, Rorca can trigger a Hilo hydration job.
- Rorca stores a repo context snapshot separate from memory events.
- Spec generation can include a bounded repo map summary.
- Pipeline execution can include likely files, tests, entrypoints, and impact radius when available.
- Hilo structural graph data is clearly distinguished from Rorca historical memory.
- The integration remains optional and does not block users who do not have Hilo installed.

## Strategic framing

DuckBrain/Conscience are portable memory substrates.

Hilo is a portable repo-map substrate.

Rorca is the spec-native orchestration layer that can combine both:

```text
Hilo = what the repo is
Memory = what happened before
Specs = what should happen next
Rorca = the loop that connects them
```
