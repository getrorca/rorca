---
name: rorca-forge-run
description: Create, verify, approve, and start a canonical Rorca spec through caller-owned skill-first drafting and governed execution.
---

# Rorca Forge Run

Own the end-to-end user path while preserving explicit-draft and execution authority boundaries.

## Workflow

1. Call `rorca_specs_generation_context` with the exact workspace and brief; preserve its `contextUsed`, `contextSummary`, and `exportKitContract` unchanged.
2. Draft the title, slug, complete story set, and complete `exportKit` input locally. The kit must satisfy the returned schema and cover product intent, scope, requirements, design, delivery, and optional Genesis research references. Every story needs a stable ID, title, description, acceptance criteria, and dependencies.
3. Persist with `rorca_create_spec` (or `rorca_persist_spec`) using the original brief, drafted stories, drafted `exportKit`, returned `contextUsed`/`contextSummary`, and explicit `policyPresetId: skill_first_strict` unless the user supplied another reviewed policy.
4. Require persistence to return an export-kit identity, then read the export-kit endpoint/tool and verify `status: current`, the same manifest hash, and all artifacts.
5. Verify the saved spec with `rorca_get_specs_by_specId`.
6. Inspect `rorca_spec_workflow` or `rorca_spec_readiness`; repair only retryable post-save stage failures.
7. Approve with `rorca_approve_spec` only because this composite workflow was explicitly requested by the user/launcher. Approval must return the same export-kit manifest plus a seal hash. If governed approval requests exact human authority, present the request and stop; never invent it.
8. Trigger with `rorca_trigger_run` only after the state sequence is exactly `persisted → kit current → approved → kit sealed → lifecycle compiled → trigger`, using:
   - `specPath: forge/specs/approved/<slug>.json`
   - `autoWorktree: true`
   - `autoMerge: false`
   - `mergeStrategy: branch-only`
   - `terminal_mode: ansi-html`
   - `forceSequential: true`
   - requested model/story target when provided
9. Return the canonical run ID and whether it is queued or active.

## Safety boundaries

- Never call `rorca_specs_forge` or legacy `rorca_generate_spec` for normal authoring.
- If generation-context or explicit persistence is unavailable, stop; do not silently route through backend drafting.
- Never use `readinessOverride`.
- Ordinary execution stops at an isolated local run branch: no push, PR, merge, deployment, or provider mutation.
- External draft-PR delivery is a separate TaskManifest-authorized workflow; do not broaden this run into it.
- Never invent lifecycle-authoring fields or human approval receipts.
- Never trigger when the export kit is missing, stale, tampered, unsealed, or bound to a different manifest.
- Do not claim launch unless the trigger returns a canonical run ID.

## Output

Report the workspace, saved slug, effective policy, export-kit manifest and seal hashes, readiness, approval result, run ID, queue/active state, story summary, and any real prerequisite.
