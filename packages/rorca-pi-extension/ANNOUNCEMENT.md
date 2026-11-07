# Introducing the Rorca Pi Extension

## Short launch post

Today we’re shipping the **Rorca Pi Extension**: a Pi-native way to operate Rorca from directly inside a Pi session.

With the extension installed, you can:
- generate specs from briefs
- approve specs
- trigger Pi-backed runs
- watch run progress live
- retry failed stories
- inspect recent runs
- load Rorca MCP tools into Pi automatically when the backend bridge is healthy

This is not a toy wrapper and it is not a replacement for Rorca’s orchestration model.

Rorca still remains the control plane for:
- orchestration
- memory
- graph/retrieval context
- run state
- branch/PR/merge tracking

Pi remains the execution backend.

The extension gives you a clean, Pi-native UX on top of that architecture.

Install from the repo root:

```bash
pi install ./packages/rorca-pi-extension -l
```

Then start with:

```text
/rorca-help
```

---

## Full announcement / docs landing page copy

# The Rorca Pi Extension

Operate Rorca from inside Pi — without losing Rorca’s orchestration, memory, or run-tracking model.

## Why we built this

A lot of the power in the Rorca + Pi workflow was already there, but the user experience still made people bounce between surfaces:
- backend API
- CLI
- app/TUI
- custom scripts
- manual run inspection

That works for internal power users, but it is not the experience you want to hand to a larger audience.

We built the **Rorca Pi Extension** to solve that.

Now, from inside Pi, you can move through the most common Rorca workflows directly:
- forge specs
- approve them
- run them on Pi
- watch them live
- retry failures
- inspect status
- access Rorca MCP tools when available

## What it is

The Rorca Pi Extension is a **Pi-native operator interface** for Rorca.

It is best understood as the middle layer between:
- **Rorca**, which orchestrates and persists state
- **Pi**, which executes work
- **You**, the operator who wants a fast, unified workflow

## What it is not

It is not:
- a replacement for the Rorca app
- a replacement for the Rorca TUI
- a replacement for Rorca MCP itself
- a transfer of orchestration from Rorca into Pi

That distinction matters.

The architecture stays clean:
- **Rorca orchestrates**
- **Pi executes**
- **the extension provides UX**

## What you can do with it

### Generate specs from a brief

```text
/rorca-forge @docs/brief.md --workspace rorca
```

### Generate, approve, and run in one step

```text
/rorca-forge-run @docs/brief.md --workspace rorca
```

### Run an approved spec on Pi

```text
/rorca-run zz-my-spec --workspace rorca
```

### Run only one story

```text
/rorca-run zz-my-spec --workspace rorca --story US-001
```

### Watch live run progress

```text
/rorca-watch 20260316000309
```

### Retry failures

```text
/rorca-retry 20260316000301
```

### Confirm MCP bridge health

```text
/rorca-mcp-status
```

## Why this matters

The value is not just fewer commands.

The real value is that the extension gives you a Pi-native surface **without flattening away the things Rorca is good at**:
- persistent run history
- retrieval and graph context
- spec lifecycle
- memory capture
- PR/merge metadata
- deterministic backend ownership of execution state

That makes the workflow more usable **and** more trustworthy.

## Under the hood

The extension is:
- **REST-first** for slash-command workflows
- **MCP-enabled** when the backend bridge is healthy
- **stateful** using Pi session entries
- **watch-aware** using Pi UI widgets/status updates

It does not rely on shelling out to the `rorca` CLI for its day-to-day runtime actions.

## Reliability and validation

This extension was validated with real runs, not only unit tests.

That validation included:
- extension-driven forge
- extension-driven approve
- extension-driven Pi runs
- MCP tool bridging
- live run watching
- memory/spec-memory persistence
- graph/retrieval checks
- PR creation
- sandbox merge behavior
- exact-once single-story execution on the patched path

## Who should install it

Install this if:
- you already use Rorca and want to spend more time inside Pi
- you prefer conversational/operator workflows over juggling multiple terminals
- you want a clean bridge between orchestration and execution
- you want to access Rorca MCP tools from inside Pi without doing manual transport setup

## Installation

From the Rorca repo root:

```bash
pi install ./packages/rorca-pi-extension -l
```

Then start with:

```text
/rorca-help
```

## Learn more

- user guide: `packages/rorca-pi-extension/README.md`
- publishing/maintainer guide: `packages/rorca-pi-extension/PUBLISHING.md`
- store listing copy: `packages/rorca-pi-extension/STORE-LISTING.md`

## Closing line

If Rorca is your control plane and Pi is your execution engine, the Rorca Pi Extension is the UX layer that makes the whole stack feel cohesive.
