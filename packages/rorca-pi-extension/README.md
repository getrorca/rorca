# Rorca Pi Extension

Pi-native extension package for operating Rorca from inside a Pi session.

> **Hermes.** This package *is* Hermes — Rorca's external distribution channel for
> MCP-capable agent hosts. "Hermes" is how the project refers to driving Rorca
> from outside its first-party app/TUI; concretely it is this Pi extension plus
> the bundled skills, which register the Rorca MCP server and the brief → spec →
> run skills into an external Pi session. Hermes is an external channel, **not** a
> replacement for the first-party Rorca UX. For the canonical MCP integration,
> tool surface, install/update flow, and Graph Lite / BYOP behavior, see
> [`docs/mcp-integration.md`](../../docs/mcp-integration.md).

This package gives you:
- slash commands for forge / approve / run / retry / status workflows
- optional live run watching inside Pi widgets/status bars
- automatic bridging of Rorca MCP tools into Pi when the backend MCP endpoint is healthy
- persisted extension session state for last workspace, last spec, last run, and active watch

## What this extension is

The Pi extension is the **Pi-native operator UX** for Rorca.

It is **not** the orchestrator.
Rorca remains the control plane and source of truth for:
- spec generation and approval
- run state
- task history
- memory persistence
- graph / retrieval context
- branch / PR / merge behavior

Pi acts as the execution agent, and this extension makes that flow pleasant to use from inside Pi.

## Architecture at a glance

There are 3 distinct surfaces:

1. **Rorca app / TUI**
   - human-facing control and monitoring surface
2. **Pi extension**
   - Pi-native slash-command interface
3. **Rorca MCP tools**
   - machine-facing tool surface bridged into Pi when available

This extension uses:
- **Rorca REST API** for stateful command operations such as spec lookup, approval, runs, retry, and watch flows
- **Rorca HTTP MCP** for tool bridging and skill-first structured persistence
- **Pi session entries** for lightweight local state persistence

It does **not** shell out to the `rorca` CLI for normal runtime operations.

## Prerequisites

Before installing the extension, make sure:

- Pi is installed and working
- the Rorca backend is running
- the Rorca worker is running
- at least one Rorca workspace is registered
- Pi can access a working model, typically `openai-codex/gpt-5.4`

Typical local setup:

```bash
# repo root
npm run dev

# separate shell
cd backend
npm run dev:worker
```

## Install into Pi

The easiest install path from the Rorca repo root is:

```bash
rorca pi install
```

That installs the bundled extension into the current Pi project.

Advanced/dev fallback:

```bash
pi install ./packages/rorca-pi-extension -l
```

If Pi was already open when you installed the extension, run `/reload`. If the commands still do not appear, restart Pi.

If you are testing the extension entry directly during development, you can also run:

```bash
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts
```

## Update and rollback

The extension and the bundled skills are versioned together via this package's
`version` field in `package.json` and the release notes in `CHANGELOG.md`. A
given install therefore corresponds to a known release that can be validated and
rolled back as a unit — there is no version skew between the skills and the
extension that ships them.

Update flow:

1. Pull the Rorca repo to the desired release.
2. Read `CHANGELOG.md` for the new version and what changed.
3. Re-run `rorca pi install` (or `pi install ./packages/rorca-pi-extension -l`).
4. Run `/reload` inside Pi, then `/rorca-mcp-status` to confirm the bridge.

Validate the installed version by matching `package.json` `version` against the
top entry of `CHANGELOG.md`.

Roll back by checking out the previous release of the Rorca repo and re-running
`rorca pi install` against that checkout, then `/reload`.

A clean-environment install/update walkthrough also lives in
[`docs/mcp-integration.md`](../../docs/mcp-integration.md).

## Environment variables

The extension works out of the box for standard local development, but you can override its endpoints.

- `RORCA_PI_API_URL`
  - default: `http://127.0.0.1:3030`
- `RORCA_PI_MCP_URL`
  - default: `${RORCA_PI_API_URL}/mcp`
- `RORCA_PI_MCP_TOKEN`
  - optional explicit MCP token
  - falls back to `~/.rorca/mcp-admin-token`
- `RORCA_PI_WORKSPACE_ID`
  - default workspace to use when multiple workspaces exist
- `RORCA_PI_DEFAULT_MODEL`
  - default Pi model when the spec’s saved model is unavailable
  - default fallback in code is `openai-codex/gpt-5.4`

## Session behavior

On Pi session start, the extension:

1. checks the Rorca backend health endpoint
2. sets a Pi status line for backend availability
3. attempts to bridge Rorca MCP tools into Pi
4. restores previous extension state from session entries
5. resumes watching the last active run if one was being watched

Persisted state includes:
- last workspace id
- last spec slug
- last run id
- currently watched run id

## Slash commands

## `/rorca-help`
Show the available Rorca commands and their usage.

Example:

```text
/rorca-help
```

The help output now centers the current command surface: `/rorca-create-spec`, `/rorca-approve`, `/rorca-run`, `/rorca-status`, `/rorca-watch`, `/rorca-retry`, and `/rorca-mcp-status`.

## `/rorca-create-spec`
Create a Rorca spec through the skill-first path.

Usage:

```text
/rorca-create-spec <brief|@file> [--workspace <id>] [--approve] [--run] [--queue] [--model <model>]
```

Behavior:
- prefers dispatching `/skill:rorca-forge` (or `/skill:rorca-forge-run` when both `--approve` and `--run` are requested)
- the skill-first forge path is only used when the MCP surface exposes generation-context retrieval, deterministic authoring preflight/confirmation, canonical one-or-batch persistence, saved-spec reads, and workflow/readiness verification tools
- Pi/skill performs the drafting, validates the versioned `lifecycleAuthoring` bundle, proposes an explicit one-versus-many plan, submits the complete draft set to deterministic preflight, and performs at most three bounded diagnostic-driven revisions
- multi-spec or high-risk plans require a separately recorded human confirmation receipt after the user inspects exact boundaries, requirement ownership, dependency DAG, capabilities, and revisions; model output can never imply confirmation
- accepted persistence forwards `contextUsed` + `contextSummary` plus the accepted authoring plan/preflight identity and explicit post-save policy via `policyPresetId` or effective `postSavePolicy`
- post-persist verification is expected to read the saved spec plus workflow/readiness surfaces and classify story skill state as `present`, `pending`, `skipped:no_installed_skills`, or `failed:<retryable_reason>` rather than assuming persist success implies enrichment success
- if that MCP forge bundle is unavailable, the extension falls back to the shared backend `/api/specs/forge` workflow as a recovery path only
- backend/server context backfill is a repair-only fallback, not the normal creation contract and not a substitute for true caller-observed drafting context
- this is the preferred explicit and reliable create-spec command in Pi

Examples:

```text
/rorca-create-spec Add a docs-only story that updates the README
/rorca-create-spec @docs/brief.md --workspace rorca --approve --run
/rorca-create-spec "Create a tiny docs-only spec" --approve --run --model openai-codex/gpt-5.4
```

## Deprecated compatibility aliases

The old slash commands below still exist only as compatibility aliases:

- `/rorca-forge` → now forwards to `/rorca-create-spec`
- `/rorca-forge-run` → now forwards to `/rorca-create-spec --approve --run`

They are no longer the public first-class path. Prefer `/rorca-create-spec` for all new workflows.

## `/rorca-approve`
Approve the specified spec, or the last generated spec if omitted from local state.

Behavior:
- prefers dispatching `/skill:rorca-approve`
- falls back to direct REST approval if the MCP bridge is unavailable

Usage:

```text
/rorca-approve <spec-slug> [--workspace <id>]
```

Examples:

```text
/rorca-approve zz-my-spec --workspace rorca
```

## `/rorca-run`
Trigger an approved spec with Pi.

Usage:

```text
/rorca-run <spec-slug> [--workspace <id>] [--story <id>] [--queue] [--model <model>] [--sequential] [--no-watch]
```

Behavior:
- prefers dispatching `/skill:rorca-run-operator`
- skill path passes workspace/spec scope, optional story targeting, queue mode, graph inclusion, and model override into the workflow prompt
- if the MCP bridge is unavailable, falls back to direct REST triggering with `agentOverride: "pi"`
- fallback defaults `includeGraph` to `true`
- if `--story <id>` is provided, the trigger uses the single-story path
- if `--sequential` is provided, the fallback sends `forceSequential: true`
- if `--model` is omitted during fallback, the extension chooses a preferred local Pi model

Examples:

```text
/rorca-run zz-my-spec --workspace rorca
/rorca-run zz-my-spec --workspace rorca --story US-001
/rorca-run zz-my-spec --workspace rorca --queue
/rorca-run zz-my-spec --workspace rorca --model openai-codex/gpt-5.4
/rorca-run zz-my-spec --workspace rorca --sequential
```

## `/rorca-status`
Show a run detail view or recent runs for a workspace.

Usage:

```text
/rorca-status [runId|workspaceId] [--workspace <id>]
```

Examples:

```text
/rorca-status
/rorca-status 20260316000309
/rorca-status rorca
/rorca-status --workspace mcp-merge-sandbox
```

## `/rorca-watch`
Start watching the latest known run or an explicit run id.

Usage:

```text
/rorca-watch [runId]
```

Examples:

```text
/rorca-watch
/rorca-watch 20260316000309
```

## `/rorca-attach`
Alias for `/rorca-watch`.

Usage:

```text
/rorca-attach [runId]
```

## `/rorca-retry`
Retry a run, optionally limited to specific story ids.

Behavior:
- prefers dispatching `/skill:rorca-retry-planner`
- falls back to direct REST retry if the MCP bridge is unavailable

Usage:

```text
/rorca-retry <runId> [storyId...] [--sequential] [--no-watch]
```

Examples:

```text
/rorca-retry 20260316000301
/rorca-retry 20260316000301 US-001 US-003
/rorca-retry 20260316000301 --sequential
```

## `/rorca-mcp-status`
Check that the Rorca MCP bridge is healthy and report the number of bridged tools.

Example:

```text
/rorca-mcp-status
```

## Watch mode and Pi UI integration

When watch mode is active, the extension:
- updates a Pi widget named `rorca-run`
- updates Pi status text for the run
- notifies on status transitions
- stops automatically when a run reaches a terminal state

The extension also surfaces run progress that points back to Rorca’s persistent progress logs under:

```text
.rorca/progress/run-<runId>/
```

Those logs are useful when Pi-side execution was autonomous and you want the story-by-story context preserved outside the live session.

## Model selection behavior

The extension tries to avoid selecting unusable models.

Run model selection order:
1. explicit `--model`
2. spec model, if it matches a discovered local Pi model
3. preferred Codex fallback, typically `openai-codex/gpt-5.4`
4. first available Codex model
5. first available Pi model
6. hard fallback from `RORCA_PI_DEFAULT_MODEL` or `openai-codex/gpt-5.4`

If the extension has to override the spec’s saved model, it notifies the user.

## MCP bridging behavior

If the backend MCP endpoint is healthy, the extension auto-registers bridged tools into Pi.

Bridge details:
- transport: HTTP MCP
- protocol version: `2025-03-26`
- accept header: `application/json, text/event-stream`
- auth: bearer token from `RORCA_PI_MCP_TOKEN` or `~/.rorca/mcp-admin-token`

Important:
- slash commands continue to work even if MCP bridging is unavailable
- MCP bridging is additive, not required for the command UX

### Discoverable Rorca MCP tools

Once bridged, these are the canonical, current tool names for the core
brief → spec → review → approve → run → inspect loop (each also resolves through
stable aliases — prefer the canonical name):

- get project context: `rorca_get_context`, generation bundle `rorca_specs_generation_context`
- preflight/confirm authoring: `rorca_specs_authoring_preflight`, `rorca_specs_authoring_preflight_confirm`
- create/persist one or many specs: `rorca_create_spec`, `rorca_specs_persist_batch`
- read a spec: `rorca_get_specs_by_specId`
- inspect workflow/readiness: `rorca_spec_workflow`, `rorca_spec_readiness`
- list specs: `rorca_list_specs`
- approve a spec: `rorca_approve_spec`
- trigger a run: `rorca_trigger_run`
- trigger a bounded Hermes task manifest through Rorca's broker: `rorca_pipeline_task_manifests_trigger` (alias `rorca_trigger_task_manifest`)
- pipeline/run status: `rorca_pipeline_status`, `rorca_run_status`
- retry stories: `rorca_retry_story`

The authoritative source is `backend/src/lib/mcp-http.ts`. Do not hard code older
names that are not present in that surface. Hermes does not implement
provider/model interoperability; task-manifest calls pass agent/model intent to
Rorca, and Rorca resolves the final execution path. See
[`docs/mcp-integration.md`](../../docs/mcp-integration.md) for the full table,
two-lane operating model, and registration details.

## Graph Lite and BYOP behavior

Rorca's database and graph capabilities depend on how the connected workspace's
database is configured, and this extension stays honest about that:

- **DB modes** — Rorca supports `native`, `docker`, and `byop` (Bring Your Own
  Postgres, e.g. Supabase / Neon / Railway). BYOP connection strings are stored
  outside the repo and only redacted host/database details are surfaced.
- **Graph modes** — `GET /api/health` reports `graphMode` as `full`, `lite`, or
  `disabled`. Full Graph requires Apache AGE; without it Rorca runs in **Graph
  Lite**, where the relevance graph uses semantic and telemetry evidence instead
  of AGE graph paths. Hosted/BYOP Postgres usually runs in Graph Lite unless AGE
  is already installed there.

Do not assume Full Graph features when a workspace is in Graph Lite. Read
`dbMode` / `graphMode` from `/api/health` to adapt messaging. Details:
[`docs/mcp-integration.md`](../../docs/mcp-integration.md).

## Typical workflows

### 1. Skill-first create and run from a brief

```text
/rorca-create-spec @docs/brief.md --workspace rorca --approve --run
```

### 2. Approve then run a spec

```text
/rorca-approve zz-my-spec --workspace rorca
/rorca-run zz-my-spec --workspace rorca
```

### 3. Run a single story only

```text
/rorca-run zz-my-spec --workspace rorca --story US-001
```

### 4. Retry failed stories in a run

```text
/rorca-retry 20260316000301
```

### 6. Watch a run from a fresh Pi session

```text
/rorca-watch 20260316000309
```

## Troubleshooting

## Backend unavailable

Symptom:
- Pi shows `Rorca API: unavailable`
- slash commands fail immediately

Check:

```bash
curl http://127.0.0.1:3030/api/health
```

Or if you are using another port:

```bash
export RORCA_PI_API_URL=http://127.0.0.1:3130
```

## MCP bridge unavailable

Symptom:
- slash commands work
- MCP tools are not loaded
- `/rorca-mcp-status` fails

Check:
- backend `/api/health` includes healthy MCP info
- `RORCA_PI_MCP_URL` points to the right endpoint
- `~/.rorca/mcp-admin-token` exists or `RORCA_PI_MCP_TOKEN` is set

## Wrong workspace selected

Symptom:
- commands affect the wrong repo/workspace

Fix:
- pass `--workspace <id>` explicitly
- or export `RORCA_PI_WORKSPACE_ID=<id>`

## Pi model/auth problems

Symptom:
- run starts but Pi fails because the selected provider/model is unavailable

Fix:
- verify models with `pi --list-models`
- verify provider auth with `pi auth login` for the provider you plan to use
- pass `--model openai-codex/gpt-5.4` explicitly if needed

## Existing Pi session does not pick up the extension

Symptom:
- command names are missing after install

Fix:
- run `rorca pi install` again if needed
- run `/reload` inside Pi if the session was already open
- restart Pi if the commands still do not appear

## Development notes

For isolated development of this extension, prefer:

```bash
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts
```

That avoids interference from other globally or project-installed extensions.

## Package layout

```text
packages/rorca-pi-extension/
  README.md
  package.json
  tsconfig.json
  vitest.config.ts
  extensions/rorca/
    index.ts        # extension entrypoint
    commands.ts     # slash command registration and handlers
    args.ts         # CLI-style argument parsing
    api.ts          # REST client to the Rorca backend
    bridge.ts       # HTTP MCP bridge into Pi tools
    watch.ts        # run watch controller / widget updates
    state.ts        # Pi session state persistence
    types.ts        # shared types
```

## Additional docs

- store-style listing copy: `packages/rorca-pi-extension/STORE-LISTING.md`
- pre-submission metadata pack: `packages/rorca-pi-extension/STORE-SUBMISSION-DRAFT.md`
- package metadata draft: `packages/rorca-pi-extension/PACKAGE-METADATA-DRAFT.md`
- screenshot capture checklist: `packages/rorca-pi-extension/SCREENSHOT-CAPTURE-CHECKLIST.md`
- screenshot + marketing asset plan: `packages/rorca-pi-extension/SCREENSHOT-AND-MARKETING-ASSETS.md`
- launch / announcement copy: `packages/rorca-pi-extension/ANNOUNCEMENT.md`
- maintainer / publishing guide: `packages/rorca-pi-extension/PUBLISHING.md`
- release history: `packages/rorca-pi-extension/CHANGELOG.md`

## Publishing status

This package is currently marked private in `package.json` and is intended for in-repo use.

If you want to publish it externally, see:
- `packages/rorca-pi-extension/PUBLISHING.md`

## License

Apache-2.0
