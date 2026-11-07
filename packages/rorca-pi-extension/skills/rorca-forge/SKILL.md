---
name: rorca-forge
description: Create a canonical Rorca spec from a product brief, markdown file, or feature request through caller-owned skill-first drafting and explicit persistence.
---

# Rorca Forge

Turn one user brief into one canonical persisted Rorca spec. Pi owns the drafting; Rorca supplies governed context, validates the explicit draft, and persists it.

## Canonical workflow

1. Validate that `workspaceId` and a non-empty brief are present.
2. Call `rorca_specs_generation_context` with the exact workspace and brief. Preserve its returned `contextUsed`, `contextSummary`, and `exportKitContract`; do not reconstruct them.
3. Draft the title, slug, complete story set, and one complete `exportKit` input locally from the brief and returned context. The kit input must satisfy the returned schema and cover product intent, scope, requirements, design, delivery, and optional Genesis research references. Every story needs a stable ID, title, description, acceptance criteria, and explicit dependencies.
4. Call `rorca_create_spec` (or the compatibility alias `rorca_persist_spec`) with the caller-drafted stories, caller-drafted `exportKit`, and all of:
   - the original `brief`/`specBrief`;
   - the unchanged returned `contextUsed`;
   - the unchanged returned `contextSummary`;
   - `policyPresetId: skill_first_strict` (unless the user supplied another explicit reviewed post-save policy).
5. Require persistence to return an `exportKit` identity. Read `/api/specs/<slug>/export-kit` through the corresponding MCP tool when available and verify `status: current`, the same manifest hash, and all five artifacts.
6. Read the saved spec with `rorca_get_specs_by_specId`.
7. Inspect `rorca_spec_workflow` or `rorca_spec_readiness`.
8. Use `rorca_retry_spec_stage` or `rorca_repair_spec` only when the saved workflow reports a retryable post-save failure.
9. Return the saved slug, story summary, effective policy, exact export-kit manifest hash, readiness, and any real blocker.

## Scope and safety

- Normal authoring never calls `rorca_specs_forge` or legacy `rorca_generate_spec`; backend drafting is not this skill's path.
- Default to one spec. Do not invent lifecycle-authoring fields, preflight receipts, or human confirmations.
- Do not approve or run unless the launcher/user requested that separate action.
- Never use `readinessOverride` to force approval or execution.
- Do not claim success from a slug alone. Verify the saved spec and workflow/readiness state.
- Never claim persistence is complete when the export kit is missing, stale, tampered, or has a different manifest hash.
- If generation-context or explicit persistence is unavailable, stop with a capability blocker. Do not silently fall back to backend drafting.

## Output

Report:
- workspace ID
- saved spec slug
- effective policy
- short story summary
- export-kit state and manifest hash
- workflow/readiness state
- any capability, validation, confirmation, or retryable blocker
