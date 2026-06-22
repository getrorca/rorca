---
name: rorca-forge-run
description: Draft a canonical Rorca spec from a brief, persist it, approve it, and trigger a Rorca run. Use when the user wants to go from brief to execution kickoff in one skill-first workflow.
---

# Rorca Forge Run

You own the end-to-end forge-to-run workflow.

Use the same reasoning quality bar as `rorca-forge`, but continue beyond draft creation into approval and execution kickoff.

## Critical architecture rule

Do not delegate spec generation back to a backend generation endpoint by default.
You are the reasoning layer.
Rorca is the validation, enrichment, persistence, and orchestration layer.

## Workflow

1. understand the brief
2. gather and validate context using structured retrieval
3. draft the spec yourself
4. persist the spec canonically in Rorca with explicit policy metadata
5. verify that the saved spec exists and that workflow/readiness state matches expectations
6. approve it when instructed or implied by the launcher
7. trigger a canonical Rorca run
8. return the saved slug, policy used, and run id

## Retrieval behavior

Follow the same retrieval principle as `rorca-forge`:
- decide what context is needed
- fetch it using tools/internal operations
- evaluate whether it is actually relevant
- fetch more if needed
- when `rorca_specs_generation_context` is available, fetch that canonical bundle before persisting and carry its `contextUsed` + `contextSummary` forward
- treat any server-side context backfill as repair-only fallback, never as the normal creation contract

Use retrieval to improve the draft, not just to decorate it.

## Approval and run behavior

Before triggering a run:
- confirm the saved spec exists
- confirm the persist call sent either `policyPresetId` or an effective `postSavePolicy`, then surface which policy was used
- inspect `getSpec` / `rorca_get_specs_by_specId` plus `rorca_spec_workflow` or `rorca_spec_readiness`
- classify story-level skill state as `present`, `pending`, `skipped:no_installed_skills`, or `failed:<retryable_reason>` rather than assuming the persist response means enrichment finished
- if skill state is `failed:<retryable_reason>`, explain the retryable reason and use `rorca_retry_spec_stage` / `rorca_repair_spec` before claiming success
- confirm approval succeeded if approval is required
- resolve or honor the requested execution model if applicable
- honor story-specific targeting if present
- make sure the run trigger returns a canonical run id
- prefer `rorca_approve_spec` then `rorca_trigger_run` / `rorca_pipeline_trigger`
- if the trigger tool expects `specPath`, use `forge/specs/approved/<slug>.json`

Do not claim a run was triggered unless a canonical run id or equivalent confirmed result was returned.

## Tool policy

- prefer structured mutation and retrieval operations
- prefer MCP where that is the primary structured tool surface
- internal backend adapters are acceptable when this workflow is launched from backend-owned flows
- use REST only as explicit fallback when allowed by the launcher
- backend/server context backfill is recovery-grade fallback only, never a substitute for true caller-observed drafting context
- preferred tool sequence: `rorca_specs_generation_context` -> draft -> `rorca_create_spec` -> `getSpec` -> `rorca_spec_workflow` or `rorca_spec_readiness` -> verify story skill state -> `rorca_approve_spec` -> `rorca_trigger_run`

## Output contract

At the end, provide:
- spec slug
- workspace id
- policy used (`policyPresetId` or the effective `postSavePolicy` you sent)
- story-level skill verification summary using `present`, `pending`, `skipped:no_installed_skills`, or `failed:<retryable_reason>`
- run id
- whether the run is queued or active if known
- short summary of drafted stories
- key caveats or assumptions
- if `watchAfterLaunch` was requested, explicitly suggest `/rorca-watch <runId>` once you know the run id

## Final reminder

This workflow is skill-first for cognition and backend-owned for canonical state.
