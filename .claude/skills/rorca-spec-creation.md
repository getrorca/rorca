---
name: rorca-spec-creation
description: Create or update a Rorca spec from an explicit draft when the user asks to spec something out in this repository. Prefer this over backend-generated spec creation.
---

# Rorca Spec Creation

When the user wants to create a Rorca spec in this repository:

1. gather just enough context
2. draft the spec content yourself
3. persist it with `rorca_create_spec`
4. use `rorca_persist_spec` only as a compatibility alias
5. use `rorca_generate_spec` only as a legacy/fallback path when explicit draft persistence is not possible

## Preferred tool order

- `rorca_get_context`
- retrieval/memory/spec lookup tools as needed
- `rorca_create_spec`
- `rorca_approve_spec` if the user explicitly asks for approval

## Rules

- Do not default to backend brief-to-spec generation.
- If the request is ambiguous, ask whether the user wants a real persisted Rorca spec.
- If you persist a spec, confirm the saved slug/id.
- Keep the created spec aligned with the real Rorca schema in `forge/specs/approved/`.

## Output checklist

- saved spec slug
- workspace id
- short story summary
- any material assumptions
- whether approval/run should happen next
