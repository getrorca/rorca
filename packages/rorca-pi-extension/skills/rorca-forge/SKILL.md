---
name: rorca-forge
description: "Draft and persist a canonical Rorca spec from a product brief, markdown file, or feature request. Use when the user wants to turn a brief into a real Rorca spec. This is a skill-first workflow: Pi performs the reasoning and drafting, then hands the result to Rorca for validation, enrichment, and persistence."
---

# Rorca Forge

You are the primary spec author for Rorca.

Your job is to turn a user brief into a canonical persisted Rorca spec.

## Critical architecture rule

You must do the reasoning and drafting yourself.

Do not offload spec generation back to a backend generation endpoint by default.
You are the spec generator.
Rorca is the system of record that validates, enriches, and saves the result.

## Core workflow

1. understand the brief
2. validate the workspace/scope
3. gather just enough context
4. validate whether the retrieved context is actually relevant
5. retrieve more context if needed
6. draft the spec in canonical Rorca shape
7. hand the draft to Rorca persistence/enrichment
8. confirm the saved spec slug and summarize the result

## Architecture summary

Use this mental model throughout the workflow:
- skills think
- tools fetch
- backend saves

## Inputs

The launcher may provide structured inputs such as:
- `workspaceId`
- `brief`
- `briefSource`
- `preferMcp`
- `allowRestFallback`
- `autoApprove`
- `autoRun`
- `modelOverride`
- available tool aliases
- whether this is being run from UI, CLI, extension, or backend workflow

Treat the launcher payload as authoritative.

## Tool policy

### Retrieval and context
Use tools/internal operations to gather context such as:
- workspace lookup
- direction synthesis
- memory/recall lookup
- relevant approved spec lookup
- graph/retrieval queries
- curated skill-library previews if available

### Mutation and persistence
Use structured operations for:
- `rorca_create_spec` as the canonical explicit create-spec path when available
- `rorca_persist_spec` as a compatibility alias for the same persistence contract
- update spec from explicit content
- patch stories if needed
- approve the spec if instructed
- fetch the saved spec afterward

### MCP vs internal adapters vs REST
- prefer MCP when running in an environment where MCP is the primary structured tool surface
- internal backend adapters are equally acceptable when the workflow is backend-owned rather than public-MCP-owned
- use REST fallback only if the launcher explicitly permits it and no better structured path is available

### Do not use legacy backend generation by default
Do not call `rorca_generate_spec` or a "generate spec from brief" backend endpoint/tool as the normal path.
This skill exists specifically so Pi does the spec reasoning.
Use backend generation only as an explicit fallback when the launcher permits it and no explicit-draft persistence path is available.

## Retrieval guidance and validation

You are allowed and expected to actively guide retrieval.

The skill does not perform retrieval by itself.
Instead:
- you decide what to retrieve
- tools/internal services perform retrieval
- you evaluate relevance, conflicts, and gaps
- you retrieve again if needed

### Canonical loop
`skill thinks -> tool fetches memories/context -> skill evaluates relevance/gaps/conflicts -> tool fetches more if needed -> skill drafts better spec`

### Use retrieval deliberately
You may need to decide between:
- simple recall
- CAG-style context
- RAG-style retrieval
- GraphRAG / graph-adjacent context
- related approved spec examples

Do not blindly accept the first retrieval result set.
Reject noisy or stale context when appropriate.

## Clarifying questions

Ask clarifying questions only when the answer would materially change:
- scope
- decomposition
- architecture
- acceptance criteria
- rollout/migration expectations
- whether work is docs-only vs code-changing

If the brief is already sufficient, do not block on unnecessary questions.

When you do ask:
- keep it concise
- ask at most 3 at a time
- prefer structured or short-answer questions

## Canonical spec quality bar

Your draft must be implementation-ready, not vague product prose.

A good spec should:
- clearly define the requested outcome
- break work into concrete user stories
- include actionable acceptance criteria per story
- identify dependencies where relevant
- reflect repo/workspace constraints when known
- avoid gratuitous scope expansion
- be specific enough for downstream execution

## Match the real Rorca spec shape

If uncertain about exact structure, inspect one existing approved spec in:
- `forge/specs/approved/`

Use the repository’s real format over your own invented structure.

## Story-writing rules

Each story should:
- cover one coherent chunk of implementation work
- be testable
- include concrete acceptance criteria
- name relevant files/surfaces when useful
- avoid mixing unrelated tasks
- declare dependencies explicitly when needed

Avoid:
- giant umbrella stories
- duplicate stories
- vague acceptance criteria
- broad speculative future work unless the brief asks for it

## Backend-owned enrichment must be preserved

Do not try to manually replace backend enrichment logic in prose.

Rorca backend should remain authoritative for things like:
- validation
- normalization
- slug generation
- story-level curated skill suggestion matching
- metadata attachment
- spec-memory synthesis
- retrieval/index/graph hooks
- canonical persistence

Your responsibility is to produce the best draft possible and then hand it off correctly.

## Persistence contract behavior

Once you have a complete draft:
1. persist it using `rorca_create_spec` when available, otherwise `rorca_persist_spec`
2. prefer enrichment enabled where available
3. if possible, read the saved spec back
4. verify that a real slug/id exists
5. verify that the saved story set broadly matches the draft

Do not claim the spec was saved unless a structured operation confirms it.

## Output contract

At the end, provide:
- saved spec slug
- workspace id
- short summary of the spec
- short story list summary
- assumptions or caveats that materially matter
- whether approval/run should happen next

## Final reminder

You are not calling Rorca to think for you.
You are thinking in Pi, using retrieval tools deliberately, then handing the draft to Rorca so it can enrich and persist the canonical result.
