# Spec Post-Save Workflow v1 Contract

This document locks the v1 durable post-save workflow contract introduced for persisted specs.

## Scope

Applies to:
- backend durable workflow storage and repair flows
- frontend workflow/readiness rendering
- Pi extension forge verification prompts

Does not redefine spec generation, pipeline execution, or future phase-2 enrichment stages.

## Exact v1 stage keys

The v1 registry is fixed to these stage keys, in order:
1. `context`
2. `enrich`
3. `matchSkills`
4. `memorySynthesis`

Current dependency graph:
- `enrich -> context`
- `matchSkills -> enrich`
- `memorySynthesis -> matchSkills`

Rules:
- `context` records caller-supplied or backfilled context capture state.
- `enrich` is the first queue-backed post-save stage.
- `matchSkills` may be skipped with `no_installed_skills` and still leave the spec runnable in degraded mode.
- `memorySynthesis` exists in the v1 graph but is policy-skippable.

## Exact preset ids

`backend/src/lib/post-save-policy.ts` defines these stable preset ids:
- `fast_import`
- `best_effort`
- `skill_first_strict`
- `enterprise_governed`
- `repair_only`

Field vocabulary is also locked for v1:
- `context`: `capture | skip`
- `enrich`: `enqueue | skip`
- `skills`: `match | skip`
- `memory`: `synthesize | skip`
- `onFailure`: `continue | fail`

## Exact top-level reason codes

`backend/src/reason-codes.ts` defines the public readiness/workflow reason-code registry.

Readiness reason codes:
- `missing_context`
- `context_backfilled`
- `post_save_pending`
- `no_installed_skills`
- `blocked_by_dependency`
- `stage_failed`
- `active_workflow_conflict`
- `active_pipeline_conflict`
- `policy_skipped`
- `run_anyway_override_used`

Workflow reason codes:
- `inspection_available`
- `ready_for_approval`
- `ready_for_run`
- `stage_state_missing`

Repair action/conflict reason codes currently surfaced by `POST /api/specs/:specId/repair` and `POST /api/specs/repair-batch`:
- `active_pipeline_run`
- `active_workflow_run`
- `dry_run`
- `generation_log_seeded`
- `generation_log_already_present`
- `context_summary_backfilled`
- `context_summary_already_present`
- `context_summary_seeded_with_generation_log`
- `stage_requeued`
- `stage_already_healthy`
- `stage_superseded`
- `stage_conflict_live_job`
- `stage_not_requested`
- `spec_file_missing`

## Exact route surfaces

Read-only inspection:
- `GET /api/specs/:specId/workflow?workspaceId=...`
- `GET /api/specs/:specId/readiness?workspaceId=...`
- `GET /api/specs/repair-candidates?workspaceId=...`

Mutation / recovery:
- `POST /api/specs/persist`
- `POST /api/specs/:specId/workflow/stages/:stageKey/retry`
- `POST /api/specs/:specId/repair`
- `POST /api/specs/repair-batch`
- `POST /api/specs/:specId/approve`
- `POST /api/pipeline/trigger`

Surface guarantees:
- workflow inspection returns exact v1 stage rows plus safe action hints
- readiness returns execution gate, blocking reasons, warnings, and available actions
- retry/repair responses echo `requestedPolicy`/policy metadata so callers can verify what was applied
- run/approve routes honor readiness gating and only use run-anyway through explicit override paths

## Compatibility guarantees

Legacy specs that only have `spec_generation_logs.context_summary_json.postSaveStages` remain supported.

v1 compatibility behavior:
- readiness can evaluate legacy generation-log state in `best_effort` mode
- retry/repair flows can materialize a durable workflow run and durable stage rows from legacy metadata
- duplicate retries/events must not create duplicate active workflows for the same workspace/spec/effective-policy tuple
- `no_installed_skills` is a warning/degraded state, not a hard execution block

## Non-goals for v1

Not part of the locked v1 contract:
- model suggestion stages
- retrieval/index rebuild stages
- graph/index side effects beyond the current durable post-save graph
- changing the meaning of existing preset ids
- widening the top-level reason-code registry without an explicit contract revision

## Phase-2 extension points

Future work may extend the registry, but must not silently rewrite v1 semantics.

Safe extension points:
- add new stage keys after `memorySynthesis` via a versioned stage registry update
- add new presets while keeping existing preset ids stable
- introduce new stage-local `reasonCode` values for new stages
- add new safe action hints and route surfaces for new stages

Rules for future additions:
- do not rename or repurpose the four v1 stage keys
- do not change the meaning of existing readiness/workflow reason codes
- keep v1 route payload fields backward compatible
- if a phase-2 stage is added, existing v1 clients must still be able to reason over the original four-stage contract without reinterpreting old data
