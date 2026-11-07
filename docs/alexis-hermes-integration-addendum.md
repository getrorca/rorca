# Alexis Hermes Integration Addendum

Date: 2026-06-19

This addendum supplements the broader Alexis PR / launch-readiness handoff.
It focuses specifically on **Hermes integration** for Rorca and the skill-distribution story.

---

## Goal

Make Rorca first-class in Hermes without replacing first-party Rorca surfaces.

Rorca should work as:

- a source of MCP tools that Hermes can call
- a set of Hermes-installable skills that teach Hermes when/how to use those tools
- a documented, verifiable integration path that is launch-ready

---

## What Hermes integration should include

### 1) Skill packaging

Package Rorca skill docs so they can be installed in Hermes as ordinary skills.

Recommended skills:

- `rorca-spec-orchestration`
- `rorca-memory-retrieval`
- `rorca-spec-templates`

Each skill should:

- point to the correct MCP server
- use the correct current tool names
- describe the intended workflow in Hermes language
- stay aligned with Rorca’s real tiered MCP contract

### 2) Publish/install workflow

Document and/or automate the expected Hermes workflow:

```bash
hermes skills install rorca-spec-orchestration
hermes skills install rorca-memory-retrieval
hermes skills install rorca-spec-templates
```

If publishing is part of the plan, include a verified path for:

- local skill testing
- publish to a hub or release channel
- version bumps
- update/reinstall behavior

### 3) MCP registration and verification

Hermes must be able to register Rorca’s MCP server and discover tools.

Minimum verification:

```bash
hermes mcp add rorca --url http://localhost:3030/mcp
hermes mcp test rorca
```

Hermes should confirm discovery of the intended public/auth tools, especially:

- `rorca_create_spec`
- `rorca_get_context`
- `rorca_list_specs`
- `rorca_approve_spec`
- `rorca_pipeline_trigger`
- `rorca_pipeline_status`

### 4) Launch-ready skill behavior

The skills should teach Hermes to:

- create specs with `rorca_create_spec`
- approve only when review-ready
- use `rorca_get_context` before drafting/running
- trigger pipelines only after approval
- inspect run status after launch
- avoid legacy `generate` flow unless explicitly needed

### 5) Truth-aligned docs

Hermes-facing docs must avoid overclaiming.

They should say:

- Rorca exposes tier-gated MCP tools, not a literal unrestricted full API surface
- Hermes is an external distribution channel, not a replacement for first-party Rorca UX
- Supabase/BYOP is a database option, not a graph-parity guarantee
- Graph Lite exists when AGE is unavailable

---

## What should be added to the handoff

Include a small Hermes section with:

### A. Install path

- how to install skills
- how to register MCP
- how to test discovery

### B. Expected workflow

- brief → spec → review → approve → run → inspect

### C. Failure modes

- missing MCP server
- missing/incorrect tool names
- tier mismatch
- skills pointing to stale docs
- install path succeeds but discovery fails

### D. Acceptance criteria

- Hermes can discover Rorca tools
- Hermes can create a spec from a brief using the skill
- Hermes can approve/run/status a spec using the skill
- the skill docs match the current Rorca contract

---

## Suggested Hermes-facing implementation checklist

1. Verify current MCP tool names in docs and generated OpenAPI.
2. Verify skills reference the exact tool names and URLs.
3. Verify Hermes registration commands work in a clean environment.
4. Verify skill install/update workflow works from the repo and/or release channel.
5. Verify the skills are not promising unsupported features.
6. Add a quick smoke test or documented validation step.
7. If publishing externally, create versioned skill releases and changelog notes.

---

## Non-goals

- Do not replace Pi or first-party Rorca surfaces.
- Do not build a separate Hermes marketplace.
- Do not couple Hermes support to the SQLite/PGlite discussion.
- Do not change Miguel’s DB setup work to force Hermes support.

---

## Bottom line

Hermes support should be treated as:

> **Rorca skills + MCP discovery + honest docs + publishable install path**

That is enough for launch readiness if the skills are aligned to the real Rorca tool surface and validated end-to-end.
