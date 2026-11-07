# Rorca Pi Extension — Pre-Submission Store Draft

> Status: **Internal draft only**
>
> This document is a preparation pack for a future extension-store submission.
> It is intentionally written as high-quality marketing/editorial copy, but it is **not** a commitment to publish yet.

---

## 1. Listing identity

### Extension name
**Rorca Pi Extension**

### Package name
`@rorca/pi-extension`

### Internal version target
`0.1.0`

### Short tagline options
1. **Operate Rorca from inside Pi.**
2. **Forge specs, run Pi-backed workflows, and watch Rorca live in Pi.**
3. **A Pi-native operator console for Rorca.**
4. **Run Rorca workflows without leaving Pi.**

### Recommended final tagline
**Forge specs, trigger Pi-backed runs, and watch Rorca live — directly inside Pi.**

---

## 2. Store descriptions

### 40–60 character short description options
1. `Operate Rorca directly from inside Pi`
2. `Pi-native workflow layer for Rorca`
3. `Run Rorca forge and Pi flows in Pi`
4. `Rorca slash commands and MCP tools for Pi`

### Recommended short description
**Operate Rorca directly from inside Pi**

### Medium description (~140 chars)
**Generate specs, approve them, trigger Pi-backed Rorca runs, watch progress live, and bridge Rorca MCP tools into Pi.**

### Long description
The **Rorca Pi Extension** is a Pi-native interface for operating Rorca without bouncing between terminals, backend APIs, and dashboards.

From inside a Pi session, you can:
- generate specs from plain-English briefs
- approve specs
- trigger Pi-backed execution runs
- run a single story only
- watch active runs live
- inspect recent runs and run details
- retry failed stories
- automatically load Rorca MCP tools into Pi when the backend MCP bridge is healthy

This extension is designed around a clean architecture:
- **Rorca remains the orchestrator and source of truth**
- **Pi acts as the execution backend**
- **the extension provides a Pi-native user experience**

That means you keep the benefits of Rorca’s control plane:
- run state and task history
- memory persistence
- graph and retrieval context
- skill injection
- branch / PR / merge tracking

while gaining a fast, conversational Pi workflow on top.

The extension is **REST-first** for command UX and **MCP-enabled** when the backend bridge is available. Slash commands continue to work even if MCP bridging is temporarily unavailable.

It is ideal for users who already rely on Rorca and want a cleaner, more powerful way to operate it from Pi.

---

## 3. Categories and keywords

### Possible categories
- Developer Tools
- AI Workflow
- Agent Orchestration
- Productivity
- MCP / Tooling

### Recommended primary category
**Developer Tools**

### Recommended secondary category
**AI Workflow**

### Keywords
- rorca
- pi
- orchestration
- spec generation
- agent workflows
- mcp
- developer tools
- autonomous coding
- run monitoring
- pipeline execution
- ai extension
- codex
- slash commands

### Recommended keyword set
`rorca, pi, orchestration, spec generation, ai workflow, mcp, slash commands, run monitoring, autonomous coding, developer tools`

---

## 4. Audience definition

### Primary audience
Developers and operators already using Rorca who want a Pi-native way to forge specs, trigger runs, monitor progress, and inspect execution outcomes.

### Secondary audience
Teams experimenting with:
- spec-driven development
- agentic execution loops
- Rorca + Pi workflows
- MCP-assisted development environments

### Not the primary audience
- users who do not run Rorca at all
- users looking for a standalone coding agent unrelated to backend orchestration
- users expecting Pi to replace Rorca’s orchestration model

---

## 5. Core value propositions

### Primary value proposition
**Use Rorca from inside Pi without losing Rorca’s orchestration, memory, and run-tracking strengths.**

### Supporting points
1. **Fewer context switches**
   - operate forge / approve / run / retry flows from one conversational surface
2. **Live operational visibility**
   - watch runs directly in Pi widgets and status bars
3. **Single-story precision**
   - trigger exact story reruns from Pi
4. **Optional MCP power-up**
   - bridge Rorca tools into Pi automatically when available
5. **Control-plane integrity**
   - Rorca still owns the state that matters

---

## 6. Feature bullets for a store page

### Short bullet version
- Forge specs from briefs or files
- Approve and trigger Pi-backed runs
- Run one story or a whole spec
- Watch live status directly in Pi
- Retry failed runs or stories
- Auto-bridge Rorca MCP tools into Pi

### Expanded bullet version
- **Forge specs from inline text or `@file` briefs**
- **Approve specs without leaving Pi**
- **Trigger full-spec or single-story Pi-backed runs**
- **Watch run progress live using Pi widgets and session status**
- **Retry failed runs or target specific stories**
- **Resolve to a working local Pi model when a saved spec model is unavailable**
- **Automatically register Rorca MCP tools into Pi when backend MCP is healthy**
- **Persist local extension state for last workspace, run, and active watch**

---

## 7. Supported commands section

### Command list for store page
- `/rorca-help`
- `/rorca-forge`
- `/rorca-forge-run`
- `/rorca-approve`
- `/rorca-run`
- `/rorca-status`
- `/rorca-watch`
- `/rorca-attach`
- `/rorca-retry`
- `/rorca-mcp-status`

### Recommended wording
The extension exposes a focused command set for day-to-day Rorca operations:

- generate a spec from a brief
- approve it
- run it on Pi
- watch it live
- retry failures
- inspect MCP bridge health

---

## 8. Example workflows section

### Example 1 — Generate and run from a brief
```text
/rorca-forge-run @docs/brief.md --workspace rorca
```

### Example 2 — Run a specific story only
```text
/rorca-run zz-my-spec --workspace rorca --story US-001
```

### Example 3 — Watch a run live
```text
/rorca-watch 20260316000309
```

### Example 4 — Retry failed stories
```text
/rorca-retry 20260316000301 US-001 US-003
```

---

## 9. Install copy

### Repo-local install
```bash
pi install ./packages/rorca-pi-extension -l
```

### Development/isolation mode
```bash
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts
```

### Suggested store wording
Install the extension into your Pi environment, point it at a running Rorca backend, and start with `/rorca-help`.

---

## 10. Requirements section

### Requirements copy
This extension is intended for users who already run Rorca.

Requirements:
- Pi installed and working
- a running Rorca backend
- a running Rorca worker
- at least one registered Rorca workspace
- a valid Pi model/provider setup

### Environment variables
Optional overrides:
- `RORCA_PI_API_URL`
- `RORCA_PI_MCP_URL`
- `RORCA_PI_MCP_TOKEN`
- `RORCA_PI_WORKSPACE_ID`
- `RORCA_PI_DEFAULT_MODEL`

---

## 11. Architecture / “How it works” section

### Store-safe architecture copy
The extension is designed around a clear separation of responsibilities:

- **Rorca orchestrates** the workflow and persists the authoritative run state
- **Pi executes** story-level work as the coding/execution agent
- **The extension provides the user interface layer inside Pi**

This keeps the UX fast without collapsing orchestration into the client session.

---

## 12. Differentiation section

### “What makes this different?”
Unlike a thin wrapper around shell commands, the Rorca Pi Extension is a real Pi integration:
- commands call the Rorca backend directly
- run watch state is persisted in Pi session entries
- MCP tools can be registered into Pi automatically
- model selection is adapted for real local Pi environments
- Rorca remains the control plane for run state, memory, and graph context

---

## 13. Trust / validation section

### Validation copy
The extension has been validated against real end-to-end flows, including:
- extension-driven forge
- approve and Pi-backed run trigger
- live status/watch behavior
- memory and spec-memory persistence
- graph/retrieval visibility
- draft PR creation
- sandbox merge flow
- exact-once single-story execution on the patched path

### Important wording note
Do **not** overstate this as a generalized public SaaS-grade guarantee unless the team wants that support burden. Keep wording around “validated in live internal/runtime verification.”

---

## 14. FAQ draft

### Does this replace the Rorca app or TUI?
No. It complements them. The extension is the Pi-native operator surface; the app/TUI remain valuable monitoring and control surfaces.

### Does this move orchestration into Pi?
No. Rorca remains the orchestrator and system of record.

### Does it require MCP to be healthy?
No. Slash commands are REST-first. MCP bridging is an optional power-up.

### Does it call the `rorca` CLI under the hood?
Not for normal runtime operations. It talks directly to backend REST and HTTP MCP.

### Can I run just one story?
Yes. Use:

```text
/rorca-run <spec-slug> --story US-001
```

### What if the saved spec model is unavailable in my local Pi setup?
The extension tries to pick a working local Pi model automatically, typically preferring a Codex-family model such as `openai-codex/gpt-5.4`.

---

## 15. Suggested support/contact placeholders

Use placeholders until the project decides what public support looks like.

### Support URL placeholder
`https://github.com/<org>/<repo>/issues`

### Docs URL placeholder
`https://docs.<your-domain>/pi-extension`

### Homepage placeholder
`https://<your-domain>`

### Contact copy
For installation issues, backend connectivity problems, or MCP bridge questions, consult the extension README and troubleshooting guide first.

---

## 16. Pre-submission warning notes

Before public submission, double-check:
- package privacy/publication settings
- backend compatibility statement
- license language
- support links
- screenshot polish
- exact wording around guarantees and production readiness

### Specifically verify
- the extension package is no longer `private: true` if publishing publicly
- README/store copy matches current command surface
- Pi peer dependency instructions are accurate
- the support burden is acceptable

---

## 17. Recommended “not yet submitting” internal note

Suggested internal note to keep with this file:

> This draft is meant to accelerate future submission work, not force immediate publication. It should be treated as product/marketing scaffolding until package metadata, support policy, and release strategy are finalized.
