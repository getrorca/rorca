<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Rorca MCP Integration (Hermes & external hosts)

This is the canonical guide for using Rorca from **Hermes** — Rorca's external
distribution channel for MCP-capable agent hosts. Today, Hermes is delivered as
the Pi extension package (`packages/rorca-pi-extension`) plus the bundled
skills, which register the Rorca MCP server and the brief → spec → run skills
into an external Pi session.

If you operate Rorca from its own app or TUI, you do not need this document.
This guide is for driving Rorca from *outside* its first-party surface.

## What Hermes is (and is not)

Hermes is an **external distribution channel**, not a second control plane.

- Hermes lets an external agent host discover and call Rorca's MCP tools and run
  the bundled skills.
- Rorca remains the source of truth for spec state, run state, approvals,
  memory, retrieval/graph context, provider/model resolution, and
  branch/PR/merge behavior.
- Hermes does **not** implement provider/model interoperability. It passes
  agent/model intent to Rorca; Rorca's execution engine and provider broker
  resolve execution through the first-class `claude`, `opencode`, `codex`, and
  `pi` paths.
- Hermes is **not** a replacement for the first-party Rorca app/TUI. The
  human-facing kanban, spec review UX, analytics, and settings live in Rorca
  itself. Hermes is the machine- and operator-facing path for getting work in
  and out of Rorca from another agent host.

When this guide says "Hermes", read it as "an external MCP host such as Pi,
running the Rorca extension and skills".

## Surfaces at a glance

| Surface | Audience | Role |
| --- | --- | --- |
| Rorca app / TUI | humans | first-party control + monitoring (canonical UX) |
| Hermes (Pi extension + skills) | external agent host | external operator/automation channel |
| Rorca MCP tools | machines | tool surface bridged into the host |

## 1. Register the Rorca MCP server

The Rorca backend exposes an HTTP MCP endpoint that mirrors the tier-filtered
OpenAPI surface (public + auth tiers only). `paid` and `admin` routes are never
MCP-exposed.

- **Endpoint**: `${RORCA_API_URL}/mcp` (default `http://127.0.0.1:3030/mcp`)
- **Transport**: HTTP MCP (streamable)
- **Protocol version**: `2025-03-26`
- **Accept header**: `application/json, text/event-stream`
- **Auth**: bearer token from `RORCA_PI_MCP_TOKEN`, otherwise
  `~/.rorca/mcp-admin-token`

The Pi extension registers this automatically on session start when the backend
health endpoint reports a healthy MCP transport. For a generic MCP host, point
its server config at the endpoint above and supply the bearer token.

Verify discovery from inside Pi with:

```text
/rorca-mcp-status
```

It reports the bridge URL and the number of bridged tools.

## 2. Discoverable tool surface

Hermes can discover the intended tools through the standard MCP `tools/list`
call. The canonical, current tool names for the core workflow are below. Each
canonical name has stable auto-generated and compatibility aliases that resolve
to the same route — prefer the canonical name in new automation.

| Capability | Canonical tool | Notable aliases |
| --- | --- | --- |
| Get project context (pre-draft) | `rorca_get_context` | — |
| Get generation-context bundle | `rorca_specs_generation_context` | — |
| Create / persist a spec | `rorca_create_spec` | `rorca_persist_spec`, `rorca_specs_persist` |
| Read a saved spec | `rorca_get_specs_by_specId` | — |
| Inspect spec workflow / readiness | `rorca_spec_workflow`, `rorca_spec_readiness` | `rorca_specs_by_specId_workflow`, `rorca_specs_by_specId_readiness` |
| List specs | `rorca_list_specs` | — |
| Approve a spec | `rorca_approve_spec` | `rorca_specs_by_specId_approve` |
| Trigger a pipeline run | `rorca_trigger_run` | `rorca_pipeline_trigger` |
| Trigger a bounded Hermes task manifest | `rorca_pipeline_task_manifests_trigger` | `rorca_trigger_task_manifest` |
| Pipeline status (recent runs) | `rorca_pipeline_status` | — |
| Single run status | `rorca_run_status` | `rorca_get_pipeline_runs_by_runId` |
| Retry failed stories | `rorca_retry_story` | `rorca_pipeline_runs_by_runId_retry` |
| List workspaces | `rorca_list_workspaces` | — |

These names are the source of truth in `backend/src/lib/mcp-http.ts`
(`MCP_FRIENDLY_ALIASES`) and the auto-generated OpenAPI tool names. Do not hard
code older names that are not present in that surface.

## 3. Install / update the Rorca skills

The skills live in `packages/rorca-pi-extension/skills/` and are packaged with
the extension. They are versioned together via the extension's
`package.json` `version` and `CHANGELOG.md`, so a given install corresponds to a
known release that can be validated and rolled back.

### Clean-environment install

```bash
# 1. ensure prerequisites: Pi installed, Rorca backend + worker running,
#    at least one registered workspace (see README "Prerequisites").

# 2. from the Rorca repo root, install the bundled extension + skills into Pi:
rorca pi install

# 3. if Pi was already open, reload it:
#    /reload   (inside Pi)  — or restart Pi if commands do not appear
```

Advanced/dev fallback (installs directly from the package directory):

```bash
pi install ./packages/rorca-pi-extension -l
```

### Updating to a new release

1. Pull the Rorca repo to the desired release.
2. Check `packages/rorca-pi-extension/CHANGELOG.md` for the version and changes.
3. Re-run `rorca pi install` (or `pi install ./packages/rorca-pi-extension -l`).
4. Run `/reload` inside Pi, then `/rorca-mcp-status` to confirm the bridge.

### Validate the installed version

The installed extension version is the `version` field in
`packages/rorca-pi-extension/package.json`. Match it against the top entry of
`CHANGELOG.md` to confirm what you are running.

### Roll back

Because each release is versioned in `package.json` + `CHANGELOG.md`:

1. Check out the previous release tag/commit of the Rorca repo.
2. Re-run `rorca pi install` against that checkout.
3. `/reload` Pi and re-verify with `/rorca-mcp-status`.

Rolling back the repo to a prior version rolls back the skills and extension
together — there is no partial-version skew between the skills and the
extension that ships them.

## 4. The intended workflow: brief → spec → review → approve → run → inspect

The skills teach this exact loop. Hermes should not collapse or skip steps.

1. **Brief** — start from a product brief, markdown file, or feature request.
2. **Spec** — `/rorca-create-spec` dispatches `/skill:rorca-forge`. The skill
   does the reasoning, fetches `rorca_specs_generation_context`, drafts the
   spec, and persists it with `rorca_create_spec` carrying `contextUsed` +
   `contextSummary` and explicit policy intent.
3. **Review** — read the saved spec (`rorca_get_specs_by_specId`) and inspect
   `rorca_spec_workflow` / `rorca_spec_readiness`. Classify story skill state as
   `present`, `pending`, `skipped:no_installed_skills`, or
   `failed:<retryable_reason>` — never assume slug creation means enrichment
   succeeded.
4. **Approve** — `/rorca-approve <slug>` → `rorca_approve_spec`.
5. **Run** — `/rorca-run <slug>` → `rorca_trigger_run` against
   `forge/specs/approved/<slug>.json`.
6. **Inspect** — `/rorca-status` / `/rorca-watch` use `rorca_pipeline_status`
   and `rorca_run_status`; retry with `/rorca-retry` → `rorca_retry_story`.

`/rorca-create-spec --approve --run` runs the whole loop in one shot via
`/skill:rorca-forge-run`, but the underlying steps and verification are the
same.

## 5. Two execution lanes: full specs vs Hermes task manifests

Rorca is the canonical source of truth in both lanes. The difference is the
shape of the work admitted into the broker.

| Lane | Use when | Flow | Canonical entry point |
| --- | --- | --- | --- |
| **Mode A — Rorca delegated execution** | A product brief, new feature, architecture change, or anything that needs durable spec review. | brief → spec → approve → Rorca run → PR/evidence/memory | `rorca_create_spec` → `rorca_approve_spec` → `rorca_trigger_run` |
| **Mode B — Hermes task-manifest execution via Rorca broker** | A bounded, already-scoped Hermes/HRC repair can be represented as a typed manifest with explicit context refs, target paths, validation, and safe policy defaults. | Rorca spec/context → Hermes task manifest/`tasks.md` → Rorca provider broker → PR/evidence/memory | `POST /api/pipeline/task-manifests/trigger` / `rorca_trigger_task_manifest` |

Mode B is **not** a separate Hermes execution engine. Hermes may propose
`agentOverride`, `modelOverride`, or effort/terminal intent, but it does not own
provider/model routing or compatibility. Rorca validates the manifest, creates a
synthetic internal execution envelope, and resolves the final provider/model via
its broker and execution engine (`claude`, `opencode`, `codex`, `pi`).

### Safe defaults for Mode B

Task-manifest execution is intentionally narrower than a normal spec run. Use
these defaults verbatim when preparing or reviewing a Hermes manifest:

- `dry-run` support
- branch/PR-only
- `autoMerge=false`
- no deploys
- no credential copying
- no production DB writes
- no secret mutation

Rorca enforces the typed manifest shape, rejects `autoMerge=true` and direct
merge strategies, and preserves manifest artifacts. Operators are still
responsible for keeping the bounded task content aligned with the last three
items above; do not encode production database writes, secret rotation, or raw
credential handling as a task-manifest repair.

### Canonical API/tool contract

- **REST endpoint**: `POST /api/pipeline/task-manifests/trigger`
- **Generated MCP tool**: `rorca_pipeline_task_manifests_trigger`
- **Friendly MCP alias**: `rorca_trigger_task_manifest`
- **Swagger exposure**: `x-rorca-tier: public`, `x-rorca-public-api: true`
- **Swagger rationale**: "Stable local task-manifest execution is safe for MCP/CLI because the route validates bounded Hermes manifests, requires workspaceId and idempotencyKey, rejects autoMerge=true and mergeStrategy=direct, and the manifest policy forbids deploys and credential-copying before any pg-boss job is inserted."

Request summary:

- Required: `workspaceId`, `manifest` (TaskManifest v1 JSON), and
  `idempotencyKey` matching `manifest.idempotencyKey`.
- Optional: `dryRun`, `autoWorktree`, `mergeStrategy` (`pr`, `draft-pr`, or
  `branch-only`), `agentOverride`, `modelOverride`, effort/terminal settings,
  and execution-environment hints when supported.
- Unsafe: `autoMerge=true` and `mergeStrategy=direct` are rejected.

Response summary:

- `200` — dry-run plan, idempotent replay, or active-run conflict summary.
- `201` — run accepted and delegated to the existing Rorca pipeline broker.
- `202` — queued response when the caller explicitly queues the manifest.
- `400` / `409` / `422` — invalid manifest/source authority, active conflict,
  or unsafe execution policy.

### Manifest JSON vs `tasks.md`

`manifest.json` is canonical. `tasks.md` is a deterministic, human-readable
projection for operators and agents; it is useful context, not durable state.
Treat it the same way you treat synthesized direction-stack output: readable and
reviewable, but not the source of truth.

Safe manifest excerpt (no secrets, no raw logs, no model API keys):

```json
{
  "manifestVersion": 1,
  "manifestId": "33333333-3333-4333-8333-333333333333",
  "idempotencyKey": "44444444-4444-4444-8444-444444444444",
  "workspaceId": "ws-hermes",
  "source": {
    "rorca": {
      "specId": "rorca-task-manifest-execution-bridge-for-hermes",
      "runId": "20260316000440",
      "storyId": "TMB-008"
    },
    "operator": {
      "intentId": "hrc-repair-intent-008",
      "summary": "Run a bounded bridge repair with PR-only review."
    }
  },
  "routeDecision": {
    "route": "hermes.hrc.task-manifest",
    "reason": "Bounded repair fits the task-manifest bridge."
  },
  "objective": "Validate the task-manifest bridge without live external side effects.",
  "boundedScope": {
    "summary": "Modify only bridge route tests and fixtures.",
    "allowedPaths": ["backend/src/routes/pipeline.ts"],
    "forbiddenPaths": ["backend/src/db/pg-migrations"]
  },
  "tasks": [
    {
      "taskId": "TMB-008-HRC-route-contract",
      "title": "Cover HRC manifest routing",
      "targetPaths": ["backend/src/routes/__tests__/pipeline-hermes-manifest-bridge.test.ts"],
      "acceptanceCriteria": ["Route accepts typed manifests", "Legacy repair metadata is rejected"]
    }
  ],
  "context": {
    "summary": "Context refs point to bounded artifacts; raw prompt bundles stay outside Rorca.",
    "tasksMdProjection": {
      "path": "tasks.md",
      "generatedFrom": "manifest",
      "durableSourceOfTruth": false
    }
  },
  "policy": {
    "dryRun": true,
    "branchPrOnly": true,
    "autoMerge": false,
    "deploysAllowed": false,
    "credentialCopyingAllowed": false
  },
  "execution": {
    "agentOverride": "opencode",
    "modelOverride": "anthropic/claude-sonnet-4-5-20250929",
    "mergeStrategy": "draft-pr"
  },
  "validation": {
    "requiredCommands": ["cd backend && npx tsc --noEmit"],
    "successCriteria": ["Typecheck passes"]
  },
  "evidence": []
}
```

Corresponding `tasks.md` projection excerpt:

```md
# Task Manifest Projection

> Deterministic projection for operator and agent readability only.
> `manifest.json` is the durable source of truth.

## Manifest ID
33333333-3333-4333-8333-333333333333

## Guardrails

### Policy
- Dry Run: true
- Branch PR Only: true
- Auto Merge: false
- Deploys Allowed: false
- Credential Copying Allowed: false

## Tasks

### TMB-008-HRC-route-contract — Cover HRC manifest routing
- Target Paths:
  - backend/src/routes/__tests__/pipeline-hermes-manifest-bridge.test.ts
- Acceptance Criteria:
  - Route accepts typed manifests
  - Legacy repair metadata is rejected
```

### When Mode B must fall back to Mode A

Use a normal Rorca spec/run instead of the task-manifest bridge when any of
these are true:

| Condition | Required route |
| --- | --- |
| New feature | Mode A — draft/review/approve a full Rorca spec |
| Broad architecture change | Mode A |
| High-risk security/data/ops work | Mode A |
| Ambiguous scope | Mode A |
| Missing context or weak provenance refs | Mode A |
| Policy mismatch with the safe defaults above | Mode A |
| Scope expansion beyond the manifest's bounded paths/tasks | Stop Mode B and route back to Mode A |

## 6. Graph Lite and BYOP — what to expect

Hermes must stay truthful about Rorca's database and graph capabilities, which
depend on how the connected workspace's database is configured.

### Graph mode

Rorca reports a `graphMode` of `full`, `lite`, or `disabled` on
`GET /api/health` (and in the redacted database-capability contract).

- **Full Graph** requires Apache AGE to be installed and enabled. AGE-backed
  graph traversal and full graph visualisation are available.
- **Graph Lite** is the honest fallback when AGE is not available. The relevance
  graph uses semantic and telemetry evidence instead of AGE graph paths.
  AGE-only admin/graph-traversal operations are unavailable until AGE is
  enabled. This is expected behavior, not an error.

Skills and automation must not promise AGE-only graph behavior when the
workspace is in Graph Lite. When a skill requests graph/retrieval context, treat
the result as possibly Graph-Lite-shaped and degrade gracefully.

### BYOP (Bring Your Own Postgres)

Rorca supports three database modes: `native`, `docker`, and `byop`.

- **BYOP** connects a hosted Postgres instance (e.g. Supabase, Neon, Railway, or
  self-hosted Postgres). The `DATABASE_URL` is stored outside the repo and only
  redacted host/database details are surfaced.
- Hosted Postgres usually runs in **Graph Lite** unless AGE is already installed
  on that instance. Do not assume Full Graph on a BYOP connection.

Hermes can read `dbMode` and `graphMode` from `GET /api/health` to adapt its
messaging instead of guessing.

For human setup of each database path, see
[`../README.md`](../README.md#database-modes--graph-capability),
[`../QUICKSTART.md`](../QUICKSTART.md), and the BYOP walkthrough in
[`supabase-setup.md`](supabase-setup.md).

## 7. Do not overclaim

To keep Hermes honest:

- Do not claim Full Graph features when `graphMode` is `lite` or `disabled`.
- Do not claim a spec was enriched unless workflow/readiness reads confirm it.
- Do not claim a run was triggered without a canonical run id.
- Do not treat backend context-summary backfill as the normal creation
  contract — it is a repair-only fallback.
- Do not present Hermes as a replacement for the first-party Rorca app/TUI.
- Do not claim Hermes owns provider/model routing or interoperability; it passes
  intent to Rorca.
- Do not treat `tasks.md` as canonical state; the manifest JSON is canonical.
- Do not use the task-manifest bridge for broad, high-risk, or expanding work
  that belongs in a reviewed Rorca spec/run.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| `Rorca API: unavailable` | `curl ${RORCA_API_URL}/api/health` |
| MCP tools not loaded | backend `/api/health` MCP info; `RORCA_PI_MCP_URL`; token file |
| `/rorca-mcp-status` fails | bearer token (`RORCA_PI_MCP_TOKEN` / `~/.rorca/mcp-admin-token`) |
| Commands missing after install | re-run `rorca pi install`, `/reload`, then restart Pi |
| Graph features missing | confirm `graphMode` on `/api/health`; Graph Lite is expected without AGE |

See also: `packages/rorca-pi-extension/README.md` for the full slash-command
reference and `packages/rorca-pi-extension/CHANGELOG.md` for release history.
