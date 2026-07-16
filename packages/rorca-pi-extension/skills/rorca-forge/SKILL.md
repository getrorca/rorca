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

1. understand the brief and validate workspace/scope
2. fetch `rorca_specs_generation_context` and validate its versioned `lifecycleAuthoring` section before drafting
3. gather and evaluate just enough relevant context
4. propose the authoring plan (explicit one-versus-many decision, boundaries, requirement ownership, and dependency DAG)
5. draft the complete canonical spec set with lifecycle story annotations
6. call deterministic authoring preflight, revise only from diagnostics, and stop after at most 3 total attempts
7. if multi-spec/high-risk confirmation is required, show the exact inspection payload and obtain a separate explicit human confirmation receipt
8. persist one spec through `rorca_create_spec`, or the complete validated set through the existing batch/persist surface
9. verify canonical saves, post-save workflow/readiness, and authoritative lifecycle compiler identity
10. summarize saved slugs, preflight attempts, policy, and unresolved caveats

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
- `rorca_specs_generation_context` before drafting, so you can fetch the canonical skill-first forge context bundle (`prompt`, `contextUsed`, `contextSummary`, `postSaveDefaults`, `lifecycleAuthoring`)
- `rorca_specs_authoring_preflight` / `rorca_preflight_spec_authoring` for deterministic plan + complete draft-set validation
- `rorca_specs_authoring_preflight_confirm` / `rorca_confirm_spec_authoring_plan` only after the user explicitly confirms the exact inspection payload

### Mutation and persistence
Use structured operations for:
- `rorca_create_spec` as the canonical explicit create-spec path when available
- `rorca_persist_spec` as a compatibility alias for the same persistence contract
- `rorca_persist_spec_batch` / `rorca_specs_persist_batch` for a validated multi-spec set sharing one parent authoring-plan identity
- `rorca_get_specs_by_specId` to verify the saved stories and inspect story-level `suggestedSkills`
- `rorca_spec_workflow` / `rorca_specs_by_specId_workflow` and `rorca_spec_readiness` / `rorca_specs_by_specId_readiness` to verify durable post-save state after persistence
- `rorca_retry_spec_stage` or `rorca_repair_spec` when verification shows a retryable post-save failure
- patch stories if needed before handoff to approval; any material patch requires a new preflight

This forge skill ends at canonical specs plus lifecycle annotations and compiler verification. It never dispatches a run, selects wave/PTY behavior, authorizes retry/merge/deploy, or treats an authored QA/Journey story as completion evidence. Composite skills may begin a separate approve/run workflow only after forge has returned successfully.

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

## Lifecycle authoring and bounded revision contract

Before writing stories, validate that `lifecycleAuthoring.status` is `ready`, its `profileVersion` and planner version are supported, and it contains normalized intent identity, decomposition policy, phase obligations, required story capabilities, evidence expectations, wording rules, authority prohibitions, and preflight metadata.

If the section is missing or invalid:
- return `authoring_profile_unavailable` when policy permits a clearly degraded legacy review draft
- return `authoring_profile_required` and do not imply phase-aware authoring when policy requires preflight
- never synthesize a successful profile from model prose

Submit the caller-proposed planner input and **all** draft specs to deterministic preflight. On each rejected attempt:
- record attempt number, diagnostic categories, amendments applied, and material revisions
- preserve readable model-authored titles/descriptions/criteria; change structure or prose only where diagnostics require it
- never remove required coverage, weaken a gate, invent evidence, or alter normalized intent merely to pass
- stop after 3 total attempts by default and return `authoring_preflight_blocked` plus unresolved blockers/clarification questions

Before multi-spec or high-risk persistence, show the returned inspection object verbatim: exact spec count, boundaries, requirement ownership, dependency DAG, required capabilities, and material revisions. Confirmation must be a distinct human action through the confirmation operation; never infer it from model output or set `actor.type: human` yourself.

## Persistence contract behavior

Once deterministic preflight accepts the complete draft set:
1. carry `contextUsed`, `contextSummary`, the accepted plan/hash, complete preflight spec set/hash, authoritative `preflightReceiptId`, attempt summaries, caller surface, and model through persistence as `authoringPreflight`
2. make persistence explicitly policy-aware via `policyPresetId` or effective `postSavePolicy`
3. for one spec, use `rorca_create_spec` (or `rorca_persist_spec`) with the stable boundary slug
4. for multiple specs, use the existing bounded batch/persist operation with one parent identity; preserve stable slugs/cross-spec links and report per-spec persisted/reused/failed outcomes for resume
5. keep post-save enrich and matchSkills enabled unless explicitly opted out; context backfill remains repair-only
6. read every saved spec back and verify its authoring state is `validated`, accepted preflight hash matches, and authoritative `lifecyclePlan` compiler identity is present; `needs_authoring_preflight` and `stale_authoring_preflight` are incomplete review states, not success
7. inspect workflow/readiness and classify each story's skill-injection state honestly:
   - `present` — the saved story already has the expected `suggestedSkills` outcome
   - `pending` — the match-skills stage is still pending/queued/running
   - `skipped:no_installed_skills` — the stage was skipped because no installed skills were available
   - `failed:<retryable_reason>` — the workflow/readiness surface shows a retryable failure or dependency block
8. if verification shows `failed:<retryable_reason>`, explain the retryable reason and point to `rorca_retry_spec_stage` / `rorca_repair_spec` rather than pretending persistence fully succeeded

Do not approve or run from this skill, and do not claim the spec was saved, enriched, or lifecycle-current unless structured reads confirm those states.

## Output contract

At the end, provide:
- saved spec slug(s) and parent authoring-plan/preflight hashes
- workspace id
- short summary of the spec
- explicit one-versus-many decision, boundaries, dependency summary, and short story list
- policy used (`policyPresetId` or the effective `postSavePolicy` you sent)
- story-level skill verification summary using `present`, `pending`, `skipped:no_installed_skills`, or `failed:<retryable_reason>`
- preflight attempt summaries and any unresolved blockers/clarification questions
- assumptions or caveats that materially matter
- whether separate approval/run workflows should happen next

## Final reminder

You are not calling Rorca to think for you.
You are thinking in Pi, using retrieval tools deliberately, then handing the draft to Rorca so it can enrich and persist the canonical result.
