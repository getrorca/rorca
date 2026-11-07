# Cross-CLI Rorca Spec Creation Plan

## Goal

Make Rorca spec creation reliable across Claude Code, Codex, OpenCode, Pi, and any MCP-capable client by separating:

- **guaranteed explicit path**
- **best-effort natural-language auto-routing**

The guaranteed path is the only surface we should call fully reliable.

## Canonical contract

### Preferred explicit mutation
- MCP: `rorca_create_spec`
- Compatibility MCP alias: `rorca_persist_spec`
- REST: `POST /api/specs/persist`

### Legacy/fallback path
- MCP: `rorca_generate_spec`
- REST: `POST /api/specs/generate`

### Core rule
Callers should draft the spec when possible and hand the explicit draft to Rorca for validation, normalization, persistence, enrichment, and follow-on indexing.

## Reliability model

### 100% reliable
An explicit command/tool/action such as:
- `/rorca-create-spec`
- `/skill:rorca-forge`
- `rorca_create_spec`

### High-confidence but not guaranteed
Freeform prompts like:
- "create a Rorca spec for this"
- "spec this out"
- "turn this PRD into a spec"

These depend on client prompting, tool selection, and model behavior.

## Client matrix

| Client | Guaranteed path | Auto-route path | Current repo-controlled status | Remaining gap |
|---|---|---|---|---|
| Claude Code | `rorca_create_spec` via MCP, plus project skill guidance in `.claude/skills/rorca-spec-creation.md` | freeform prompt + skill/tool selection | backend contract implemented; project-local Claude skill added | cannot force global Claude Code default from this repo alone |
| Codex | `rorca_create_spec` via MCP | freeform prompt + MCP tool selection | backend contract implemented | no repo-local Codex wrapper/settings surface found to force default |
| OpenCode | `rorca_create_spec` via MCP; root `AGENTS.md` guidance | freeform prompt + MCP tool selection | backend contract implemented; root agent guidance updated | no stable project-local wrapper command found here for forced default |
| Pi | `/rorca-create-spec` explicit command dispatching `/skill:rorca-forge`; bridged MCP `rorca_create_spec` | freeform prompt or `/skill:rorca-forge` directly | implemented in extension package | still depends on skill availability/MCP bridge health for the skill-first path |
| Any MCP-capable client | `rorca_create_spec` | client-specific routing/prompting | implemented | explicit invocation still needed for full reliability |

## What was implemented in this slice

1. Added canonical MCP alias `rorca_create_spec` mapped to explicit spec persistence.
2. Kept `rorca_persist_spec` as compatibility alias.
3. Updated MCP docs/catalog to present `rorca_create_spec` as the canonical cross-client name.
4. Updated root `AGENTS.md` so agentic CLIs that read it see the preferred explicit contract.
5. Added project-local Claude skill guidance in `.claude/skills/rorca-spec-creation.md`.
6. Added Pi explicit command `/rorca-create-spec` that dispatches `/skill:rorca-forge` with structured launcher input.
7. Kept `/rorca-forge` and `/rorca-forge-run` as legacy/fallback backend-generation flows for compatibility.

## Recommended default UX by client

### Claude Code
- Preferred explicit user action: ask Claude to use `rorca_create_spec`, or use project skill guidance when the task is clearly spec creation.
- Good future enhancement: repo-local command/snippet or stronger MCP tool-selection system prompt.

### Codex
- Preferred explicit user action: instruct Codex to use `rorca_create_spec`.
- Good future enhancement: Codex project config that maps spec-intent prompts to explicit tool use.

### OpenCode
- Preferred explicit user action: instruct OpenCode to use `rorca_create_spec`.
- Good future enhancement: project OpenCode config/agents that route spec-intent prompts to the explicit tool.

### Pi
- Preferred explicit user action: `/rorca-create-spec ...`
- Convenience option: `/skill:rorca-forge ...`
- Legacy fallback: `/rorca-forge ...`

## Remaining roadmap

### Phase 1 — explicit path everywhere
- done for backend/MCP
- partially done for Pi
- partially done for Claude Code via project skill guidance
- not yet enforced for Codex/OpenCode wrappers

### Phase 2 — intent routers
- add client-specific prompt/router config so high-confidence spec-intent prompts call the explicit path automatically
- ask a clarification question when intent is ambiguous

### Phase 3 — measured reliability
- record how spec creation was invoked: explicit command, skill command, auto-route, fallback generation
- measure save success, overwrite/conflict rate, approval/run follow-through, and fallback frequency

## Definition of done

This initiative is fully done only when:
1. every supported client has an explicit guaranteed create-spec action
2. that action routes to explicit draft persistence, not backend generation
3. backend generation is clearly fallback/legacy
4. client docs match runtime behavior
5. validation exists for backend contract and any in-repo wrapper integrations

## Known limitations

- Freeform prompting across third-party CLIs can never be guaranteed 100% reliable.
- This repo does not currently expose a project-local Codex wrapper surface I can patch equivalently to Pi.
- OpenCode-specific project routing beyond shared agent guidance remains future work unless a stronger config surface is added here.
