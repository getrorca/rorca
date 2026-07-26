---
name: rorca-forge-run
description: Create, verify, approve, and start a canonical Rorca spec through the simple governed workflow.
---

# Rorca Forge Run

Own the end-to-end user path while keeping internal lifecycle contracts hidden.

## Workflow

1. Call `rorca_specs_forge` with the supplied brief and workspace.
2. If forge requests clarification or explicit human confirmation, present it exactly and stop.
3. Verify the saved spec with `rorca_get_specs_by_specId`.
4. Inspect `rorca_spec_workflow` or `rorca_spec_readiness`; repair only retryable post-save stage failures.
5. Approve with `rorca_approve_spec` only because this composite workflow was explicitly requested by the user/launcher.
6. Trigger with `rorca_trigger_run` using:
   - `specPath: forge/specs/approved/<slug>.json`
   - `autoWorktree: true`
   - `autoMerge: false`
   - `mergeStrategy: branch-only`
   - `terminal_mode: ansi-html`
   - `forceSequential: true`
   - requested model/story target when provided
7. Return the canonical run ID and whether it is queued or active.

## Safety boundaries

- Never use `readinessOverride`.
- Ordinary execution stops at an isolated local run branch: no push, PR, merge, deployment, or provider mutation.
- External draft-PR delivery is a separate TaskManifest-authorized workflow; do not broaden this run into it.
- Never invent lifecycle-authoring fields or human approval receipts.
- Do not claim launch unless the trigger returns a canonical run ID.

## Output

Report the workspace, saved slug, readiness, approval result, run ID, queue/active state, story summary, and any real prerequisite.
