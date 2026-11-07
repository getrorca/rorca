# Rorca Pi Extension — Store Listing Copy

## Title
Rorca Pi Extension

## Short tagline
Forge specs, run Pi-backed implementation flows, watch progress live, and access Rorca MCP tools — all from inside Pi.

## One-line description
A Pi-native extension for Rorca that lets you generate specs, approve them, trigger Pi runs, inspect status, retry failures, and bridge Rorca MCP tools directly into your Pi session.

## Hero description
The **Rorca Pi Extension** turns Pi into a powerful operator console for Rorca.

Instead of jumping between terminals, dashboards, scripts, and backend APIs, you can run core Rorca workflows directly inside a Pi session:
- generate specs from plain-English briefs
- approve specs
- trigger Pi-backed execution runs
- watch run progress live
- inspect recent run history
- retry failed stories
- load Rorca MCP tools directly into Pi when the backend bridge is healthy

This extension is built for teams and individuals who want the speed and ergonomics of Pi **without giving up Rorca’s orchestration, memory, retrieval, and run-tracking model**.

## Why users install it

Users install the Rorca Pi Extension because they want:
- a Pi-native way to operate Rorca
- fewer context switches between backend UI and CLI
- quick forge → approve → run workflows
- one-command single-story reruns
- real-time visibility into what a run is doing
- optional access to backend MCP tools in the same Pi session

## Key benefits

### 1. Pi-native workflow
Use slash commands instead of stitching together custom scripts or raw API calls.

### 2. Rorca remains the control plane
You keep Rorca’s strengths:
- run state
- memory persistence
- graph/retrieval context
- skill injection
- branch / PR / merge workflow tracking

### 3. Faster execution loop
Generate a spec, approve it, run it, and watch it from the same Pi session.

### 4. Live run visibility
The extension can watch active runs and update Pi widgets and status text in real time.

### 5. MCP bridge built in
When the backend MCP endpoint is available, the extension can register Rorca tools into Pi automatically.

## Core capabilities

### Forge specs from briefs
Generate specs from inline text or `@file` input.

Example:

```text
/rorca-forge @docs/brief.md --workspace rorca
```

### Forge and run in one step
Use a single command to generate, approve, and trigger a run.

Example:

```text
/rorca-forge-run @docs/brief.md --workspace rorca
```

### Trigger full-spec Pi runs
Run an approved spec using Pi as the execution backend.

Example:

```text
/rorca-run zz-my-spec --workspace rorca
```

### Trigger single-story Pi runs
Run only one story from a spec.

Example:

```text
/rorca-run zz-my-spec --workspace rorca --story US-001
```

### Watch live progress
Track a run directly in Pi.

Example:

```text
/rorca-watch 20260316000309
```

### Retry failed work
Retry a run or retry specific stories.

Example:

```text
/rorca-retry 20260316000301 US-001 US-003
```

### Bridge Rorca MCP tools into Pi
Check bridge health and tool availability.

Example:

```text
/rorca-mcp-status
```

## Command list

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

## How it works

The extension is intentionally designed around a clear separation of responsibilities:

### Rorca owns orchestration
Rorca is still responsible for:
- spec lifecycle
- task orchestration
- run persistence
- memory and graph context
- status tracking
- branch / PR / merge metadata

### Pi executes the work
Pi acts as the execution backend for Pi-triggered stories and runs.

### The extension provides the UX layer
This package gives Pi users a native interface for interacting with Rorca’s backend and optional MCP tool surface.

## Who this is for

This extension is a strong fit for:
- Rorca users who spend a lot of time in Pi
- operators who want faster spec/run workflows
- developers who want one conversational surface for orchestration and execution
- teams experimenting with Rorca + Pi as a daily workflow

## Installation

From the Rorca repo root:

```bash
pi install ./packages/rorca-pi-extension -l
```

For development or isolated testing:

```bash
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts
```

## Requirements

- Pi installed
- Rorca backend running
- Rorca worker running
- at least one registered Rorca workspace
- a working Pi model/provider setup

## Environment variables

Optional overrides:

- `RORCA_PI_API_URL`
- `RORCA_PI_MCP_URL`
- `RORCA_PI_MCP_TOKEN`
- `RORCA_PI_WORKSPACE_ID`
- `RORCA_PI_DEFAULT_MODEL`

## Example workflows

### Docs-only quick run

```text
/rorca-forge-run "Create a tiny docs-only story that updates README.md" --workspace rorca
```

### Single-story verification

```text
/rorca-run zz-my-spec --workspace rorca --story US-001
```

### Retry a partially failed run

```text
/rorca-retry 20260316000301
```

### Inspect run history

```text
/rorca-status rorca
```

## What makes this different

Unlike a thin wrapper around a backend CLI, this extension is designed as a real Pi integration:
- command parsing lives inside the extension
- state is persisted in Pi session entries
- run watch state can resume across session lifecycle events
- MCP tools can be registered directly into Pi
- slash commands go to Rorca’s REST API directly instead of shelling out to `rorca`

## Reliability notes

The extension has been validated against real end-to-end workflows including:
- forge
- approve
- Pi-backed run trigger
- status and watch flows
- MCP bridge tool loading
- memory persistence
- graph/retrieval context availability
- draft PR creation
- single-story exact-once execution on the patched path

## Troubleshooting summary

### Backend unavailable
Check:

```bash
curl http://127.0.0.1:3030/api/health
```

### MCP bridge unavailable
- verify MCP backend health
- verify token source
- use slash commands anyway; they do not require the MCP bridge

### Wrong workspace
Pass:

```text
--workspace <id>
```

### Model/provider mismatch
Verify:

```bash
pi --list-models
pi auth login
```

## FAQ

### Does this replace the Rorca app or TUI?
No. It complements them.

### Does this move orchestration into Pi?
No. Rorca remains the control plane.

### Does it require MCP to be healthy?
No. Slash commands are REST-first; MCP bridging is additive.

### Does it call the `rorca` CLI under the hood?
No. Normal runtime operations go directly to backend REST and MCP.

### Can I run a single story only?
Yes.

```text
/rorca-run <spec-slug> --story US-001
```

## Suggested screenshots for a store page

If you publish this in a store-like catalog, these are the most useful screenshots to include:

1. **Slash command help screen**
   - show `/rorca-help`
2. **Forge + run flow**
   - show `/rorca-forge-run @docs/brief.md`
3. **Active watch widget**
   - show a live run status widget in Pi
4. **MCP bridge success**
   - show `/rorca-mcp-status` reporting loaded tools
5. **Single-story run example**
   - show `/rorca-run <spec> --story US-001`

## Support positioning

Recommended store/support language:

> If you already use Rorca and Pi together, this extension is the cleanest way to operate that stack from inside Pi itself.

## Call to action

Install the Rorca Pi Extension to turn Pi into a first-class operating surface for Rorca workflows.
