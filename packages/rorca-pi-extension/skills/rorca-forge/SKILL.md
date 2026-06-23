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
- `rorca_specs_generation_context` when available, so you can fetch the canonical skill-first forge context bundle (`prompt`, `contextUsed`, `contextSummary`, `postSaveDefaults`) before persisting

### Mutation and persistence
Use structured operations for:
- `rorca_create_spec` as the canonical explicit create-spec path when available
- `rorca_persist_spec` as a compatibility alias for the same persistence contract
- `rorca_get_specs_by_specId` to verify the saved stories and inspect story-level `suggestedSkills`
- `rorca_spec_workflow` / `rorca_specs_by_specId_workflow` and `rorca_spec_readiness` / `rorca_specs_by_specId_readiness` to verify durable post-save state after persistence
- `rorca_retry_spec_stage` or `rorca_repair_spec` when verification shows a retryable post-save failure
- `rorca_approve_spec` / `rorca_specs_by_specId_approve` if approval was requested
- `rorca_trigger_run` / `rorca_pipeline_trigger` only when the launcher explicitly requested auto-run
- patch stories if needed before approval

### MCP vs internal adapters vs REST
- prefer MCP when running in an environment where MCP is the primary structured tool surface
- internal backend adapters are equally acceptable when the workflow is backend-owned rather than public-MCP-owned
- use REST fallback only if the launcher explicitly permits it and no better structured path is available
- treat backend/server context-summary backfill as recovery-grade fallback only; it does not replace true caller-observed drafting context

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

Do not treat the first retrieval result as authoritative.
State clearly when evidence is weak, stale, or contradictory.
If retrieval is weak, narrow the question and fetch again before drafting.

### Use retrieval deliberately
You may need to decide between:
- simple recall
- CAG-style context
- RAG-style retrieval
- GraphRAG / graph-adjacent context
- related approved spec examples

Do not blindly accept the first retrieval result set.
Reject noisy or stale context when appropriate.

### Graph context may be Graph Lite
Graph/retrieval context depends on the workspace's database configuration.
When the workspace runs in **Graph Lite** (no Apache AGE, common for BYOP/hosted
Postgres such as Supabase or Neon), relevance comes from semantic and telemetry
evidence rather than AGE graph traversal. Treat graph results as possibly
Graph-Lite-shaped, degrade gracefully, and do not promise AGE-only graph
behavior. You can read `graphMode` / `dbMode` from the backend health surface to
know which mode is active.

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
1. if `rorca_specs_generation_context` is available, fetch it before persisting; do not skip that call and rely on server backfill instead
2. carry its `contextUsed` and `contextSummary` through the persist call so the saved spec and Context tab preserve what context informed the draft
3. make the persist payload explicitly policy-aware: pass either `policyPresetId` when a preset is known or an effective `postSavePolicy` object derived from the bundle/defaults; do not hide policy choice behind vague success copy
4. persist it using `rorca_create_spec` when available, otherwise `rorca_persist_spec`
5. keep post-save enrich and matchSkills enabled unless the launcher or user explicitly asked for an opt-out; server-side context backfill is repair-only fallback, not the normal creation contract
6. read the saved spec back via `rorca_get_specs_by_specId`
7. verify that a real slug/id exists and that the saved story set broadly matches the draft
8. inspect `rorca_spec_workflow` or `rorca_spec_readiness` after save and classify each story's skill-injection state honestly:
   - `present` — the saved story already has the expected `suggestedSkills` outcome
   - `pending` — the match-skills stage is still pending/queued/running
   - `skipped:no_installed_skills` — the stage was skipped because no installed skills were available
   - `failed:<retryable_reason>` — the workflow/readiness surface shows a retryable failure or dependency block
9. if verification shows `failed:<retryable_reason>`, explain the retryable reason and point to `rorca_retry_spec_stage` / `rorca_repair_spec` rather than pretending persistence fully succeeded
10. if `autoApprove` is true, approve via `rorca_approve_spec`
11. if `autoRun` is true, trigger via `rorca_trigger_run` or `rorca_pipeline_trigger` using the canonical approved spec path

Do not claim the spec was saved or enriched unless structured reads confirm both persistence and the relevant workflow/readiness state.

## Output contract

At the end, provide:
- saved spec slug
- workspace id
- short summary of the spec
- short story list summary
- policy used (`policyPresetId` or the effective `postSavePolicy` you sent)
- story-level skill verification summary using `present`, `pending`, `skipped:no_installed_skills`, or `failed:<retryable_reason>`
- assumptions or caveats that materially matter
- whether approval/run should happen next

## Final reminder

You are not calling Rorca to think for you.
You are thinking in Pi, using retrieval tools deliberately, then handing the draft to Rorca so it can enrich and persist the canonical result.
