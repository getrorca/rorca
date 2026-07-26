---
name: rorca-forge
description: Create a canonical Rorca spec from a product brief, markdown file, or feature request through the shared no-guessing forge workflow.
---

# Rorca Forge

Turn one user brief into one canonical persisted Rorca spec without exposing lifecycle-authoring internals to the user.

## Canonical workflow

1. Validate that `workspaceId` and a non-empty brief are present.
2. Call `rorca_specs_forge` once with the workspace, brief, and any explicit model/story-count options.
3. If forge returns a bounded clarification or human-confirmation request, show it exactly and stop. Never invent missing fields or claim to be the confirming human.
4. Read the saved spec with `rorca_get_specs_by_specId`.
5. Inspect `rorca_spec_workflow` or `rorca_spec_readiness`.
6. Use `rorca_retry_spec_stage` or `rorca_repair_spec` only when the saved workflow reports a retryable post-save failure.
7. Return the saved slug, story summary, effective policy, readiness, and any real blocker.

## Why this path is mandatory

The backend owns the current versioned lifecycle-authoring schema, deterministic preflight, bounded revisions, context collection, enrichment, and persistence. Until MCP projects that complete schema directly, agents must not reconstruct `authoringPreflight`, `plannerInput`, or lifecycle evidence payloads by guessing fields.

Do not use the low-level `rorca_create_spec` / `rorca_persist_spec` path unless a future launcher explicitly confirms that the complete backend-derived authoring schema is available and validated.

## Scope and safety

- Default to one spec. Multi-spec or high-risk authoring requires the explicit human confirmation returned by forge.
- Do not approve or run unless the launcher/user requested that separate action.
- Never use `readinessOverride` to force approval or execution.
- Do not call legacy `rorca_generate_spec`; use `rorca_specs_forge`.
- Do not claim success from a slug alone. Verify the saved spec and workflow/readiness state.

## Output

Report:
- workspace ID
- saved spec slug
- effective policy if returned
- short story summary
- workflow/readiness state
- confirmation, clarification, or retryable blocker if any
