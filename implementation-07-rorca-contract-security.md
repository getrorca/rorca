# Implementation 07 — Rorca contract and recovery security

## Scope

Implemented service/auth/contract fixes only. No pipeline runs, data changes, pushes, or deployments were performed.

## Recovery authority

- Moved reconciliation to `POST /api/admin/recovery/checkpoints/reconcile`.
- Added explicit `admin` REST authorization plus OpenAPI `x-rorca-mcp: false`; it is omitted from generated MCP tools and aliases.
- Replaced caller-supplied validation prose with an opaque trusted attestation reference.
- Added immutable attestation and reconciliation-provenance migration tables.
- Reconciliation now checks the attestation's exact workspace/run/story/branch/full SHA/gate binding, exact current branch head, approved spec and dependency state.
- A transaction-scoped PostgreSQL advisory lock serializes reconciliation across processes. Identical provenance is idempotent; differing provenance, stale ancestor/head, deleted story, or a mutation race is rejected.

## Auth matrix

| Surface | REST policy | MCP policy |
| --- | --- | --- |
| `GET /api/pipeline/telemetry` | authenticated application route; bounded read projection | public generated read tool |
| `GET /api/pipeline/queue/health` | authenticated application route; bounded read projection | public generated read tool |
| `POST /api/admin/recovery/checkpoints/reconcile` | explicit platform-admin guard | never generated/callable |
| `POST /api/pipeline/task-manifests/trigger` | authenticated canonical execution bridge | existing generated tool, stable UUID idempotency |

## Public contract

- Version capabilities now advertise structured `recoveryTelemetry`, `checkpointReconciliation`, and `taskManifestExecution` objects.
- Telemetry v1 has `contractVersion`, `observedAt`, bounded numeric `runId` attribution, and worker `staleAfterSeconds`; it does not expose payloads, paths, environment, or raw logs.
- Added successful OpenAPI response schemas for telemetry and checkpoint reconciliation.
- Preserved task-manifest execution as the canonical retry bridge with its existing stable UUID idempotency contract.

## Execution secret handling

- Added opaque `secretReferences` to pg-boss run/retry payload schemas.
- Removed decrypted workspace/provider values and full `process.env` from queued retry payloads.
- Workers resolve referenced workspace/provider secrets only immediately before spawning execution.
- Worker job logs redact execution payload environments; pre-run hook output is redacted before writing run logs.

## Validation

Passed:

- Focused Jest suite (15 tests): recovery auth/discovery/telemetry/checkpoint forged-race-provenance/secret-redaction.
- `backend npx tsc --noEmit`.
- Task-manifest bridge and pg-boss schema focused tests passed.

Known baseline failures observed:

- Repository-wide backend lint has pre-existing unrelated lint errors across legacy files.
- `check:contract` cannot establish its required `1.0.0` bootstrap baseline from this branch's existing `4.0.0` snapshot.
- Existing QRW-010 trigger tests are blocked before queueing by the repository's spec-readiness gate (`SPEC_READINESS_BLOCKED`), unrelated to secret-reference behavior.
