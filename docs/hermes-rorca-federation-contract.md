<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Hermes ↔ Rorca Federation Contract

This contract defines how Hermes/HRC work is admitted into Rorca without
creating a second execution control plane. It complements
[`mcp-integration.md`](mcp-integration.md) and uses the same terminology:
Hermes is a distribution/operator channel; Rorca remains canonical.

## Authority boundaries

- **Rorca is canonical** for specs, approvals, run state, provider/model
  resolution, branch/PR behavior, evidence, and memory.
- **Hermes does not implement provider/model interoperability.** Hermes may pass
  `agentOverride`, `modelOverride`, effort, terminal, or execution-environment
  intent, but Rorca's provider broker and execution engine resolve the final
  `claude`, `opencode`, `codex`, or `pi` lane.
- **Task manifests are bounded inputs**, not Rorca specs. They are admitted only
  when their scope, context refs, tasks, validation, and policy are explicit.
- **`tasks.md` is a projection.** The JSON task manifest is the durable source
  of truth; `tasks.md` exists for human/agent readability and must not contain
  secrets, raw logs, or model API keys.

## Two execution lanes

| Mode | Name | When to use | Flow |
| --- | --- | --- | --- |
| A | Rorca delegated execution | New features, broad architecture, or any work needing durable spec review and approval. | brief → spec → approve → Rorca run → PR/evidence/memory |
| B | Hermes task-manifest execution via Rorca broker | Bounded Hermes/HRC repair with known context refs, target paths, validation, and safe policy. | Rorca spec/context → Hermes task manifest/`tasks.md` → Rorca provider broker → PR/evidence/memory |

Mode B is narrower than the older "bounded direct repair" wording: the repair may
be bounded, but execution is not direct and not Hermes-owned. It is a typed
manifest routed through Rorca's broker.

## Canonical API and MCP tool

- REST endpoint: `POST /api/pipeline/task-manifests/trigger`
- Generated MCP tool: `rorca_pipeline_task_manifests_trigger`
- Friendly MCP alias: `rorca_trigger_task_manifest`
- Swagger/OpenAPI exposure: `x-rorca-tier: public`, `x-rorca-public-api: true`
- Route rationale: "Stable local task-manifest execution is safe for MCP/CLI because the route validates bounded Hermes manifests, requires workspaceId and idempotencyKey, rejects autoMerge=true and mergeStrategy=direct, and the manifest policy forbids deploys and credential-copying before any pg-boss job is inserted."

Request summary:

- Required body fields: `workspaceId`, `manifest` (TaskManifest v1 JSON),
  `idempotencyKey`.
- `workspaceId` and `idempotencyKey` must match the manifest authority fields.
- Optional intent fields include `dryRun`, `autoWorktree`, `mergeStrategy`,
  `agentOverride`, `modelOverride`, effort/terminal settings, and supported
  execution-environment hints.
- `autoMerge=true` and `mergeStrategy=direct` are rejected.

Response summary:

- `200`: dry-run estimate, idempotent replay, or active-run conflict response.
- `201`: manifest accepted and delegated to the existing Rorca pipeline broker.
- `202`: queued manifest response when `queue=true`.
- `400`/`409`/`422`: invalid manifest/source authority, conflict, or unsafe
  execution policy.

## Safe defaults

Every Mode B manifest must preserve these safe defaults:

- `dry-run` support
- branch/PR-only
- `autoMerge=false`
- no deploys
- no credential copying
- no production DB writes
- no secret mutation

These defaults mirror Rorca's broader MCP/security posture: public MCP surfaces
are tiered, operator-only routes stay denied, and execution strips sensitive
nested-invocation environment state rather than copying credentials forward.

## Manifest JSON vs `tasks.md`

The JSON manifest is canonical. Rorca writes `manifest.json`, `tasks.md`, and an
internal synthetic spec under `forge/task-manifests/{manifestId}/`; downstream
state should reference the manifest id/hash and artifact refs, not treat
`tasks.md` edits as durable state.

Safe manifest excerpt:

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
    }
  },
  "routeDecision": { "route": "hermes.hrc.task-manifest" },
  "objective": "Run a bounded bridge repair with PR-only review.",
  "boundedScope": {
    "summary": "Update only route tests and fixtures.",
    "allowedPaths": ["backend/src/routes/__tests__/pipeline-hermes-manifest-bridge.test.ts"],
    "forbiddenPaths": ["backend/src/db/pg-migrations"]
  },
  "tasks": [
    {
      "taskId": "TMB-008-HRC-route-contract",
      "title": "Cover HRC manifest routing",
      "acceptanceCriteria": ["Typed manifest is accepted", "Legacy repair metadata is rejected"]
    }
  ],
  "context": {
    "summary": "References only; no raw logs or prompt bundles.",
    "tasksMdProjection": { "path": "tasks.md", "generatedFrom": "manifest", "durableSourceOfTruth": false }
  },
  "policy": {
    "dryRun": true,
    "branchPrOnly": true,
    "autoMerge": false,
    "deploysAllowed": false,
    "credentialCopyingAllowed": false
  },
  "execution": { "agentOverride": "opencode", "mergeStrategy": "draft-pr" },
  "validation": { "requiredCommands": ["cd backend && npx tsc --noEmit"] },
  "evidence": []
}
```

Projection excerpt:

```md
# Task Manifest Projection

> Deterministic projection for operator and agent readability only.
> `manifest.json` is the durable source of truth.

## Guardrails

### Policy
- Dry Run: true
- Branch PR Only: true
- Auto Merge: false
- Deploys Allowed: false
- Credential Copying Allowed: false

## Tasks

### TMB-008-HRC-route-contract — Cover HRC manifest routing
- Acceptance Criteria:
  - Typed manifest is accepted
  - Legacy repair metadata is rejected
```

## Fallback to normal Rorca spec/run

Mode B must stop and route back to Mode A when any criterion applies:

| Criterion | Required action |
| --- | --- |
| New feature | Draft/review/approve a Rorca spec, then run it. |
| Broad architecture | Draft/review/approve a Rorca spec. |
| High-risk security/data/ops | Use normal Rorca spec/run with human review. |
| Ambiguous scope | Clarify scope through a Rorca spec before execution. |
| Missing context | Fetch/author canonical Rorca context and spec material first. |
| Policy mismatch | Do not use Mode B unless the safe defaults can hold. |
| Scope expansion | Stop the manifest route and promote the work to Mode A. |

## Documentation and testing notes

- Keep `docs/mcp-integration.md`, this contract, and the route Swagger summary
  aligned on endpoint/tool names.
- If the public/MCP route changes, update Swagger `x-rorca-tier` and
  `x-rorca-rationale` first, then refresh any MCP/public-contract snapshots that
  assert tool names or route counts.
- Existing route/MCP tests already assert exposure of
  `rorca_pipeline_task_manifests_trigger` and `rorca_trigger_task_manifest`;
  update those tests if the canonical names change.
