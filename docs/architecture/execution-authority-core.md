<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Execution Authority core and rollout

- **Status:** Implemented behind an off-by-default workspace profile
- **Profile contract:** `rorca.execution-authority-profile.v1`
- **Policy contract:** `rorca.execution-authority-rollout.v1`
- **Default mutation provider adapters:** none
- **Default delivery:** `LocalReviewBundleAdapter`, isolated local branch, no external send

This document was written only after the disposable Rorca-owned fixture in `backend/src/lib/__tests__/fixtures/execution-authority-rollout-smoke.json` passed:

```sh
cd backend
node --import tsx --test src/lib/__tests__/execution-authority-rollout.node.test.ts
```

The smoke result covered disabled legacy bytes, six-class enablement evidence, enabled/no-provider waiting, authority-program branch isolation, disable revocation, and receipt/audit retention. It does not grant provider, merge, release, deployment, or production authority.

## Persistence schemas

Migration order is canonical and forward-only:

1. `20260821120000_execution_authority_core.sql`
   - `authority_provider_bindings`: versioned provider resource, generation, opaque secret reference, and fingerprint.
   - `operation_intents`: exact workspace/run/story principal and requested effect digest.
   - `authority_requests`: exact decision subject with independent wait expiry and maximum uses.
   - `authority_decisions`: append-only operator decision over the current request digest.
   - `authority_grants`: exact scope, expiry, maximum uses, fencing generation, and reference-only secret binding.
   - `credential_leases`: minimum-lifetime, fenced, reference-only lease.
   - `execution_attempts`: `reserved → running → uncertain → settled` effect durability.
   - `execution_receipts`: append-only redacted settlement and retention metadata.
2. `20260822120000_execution_authority_preflight.sql`
   - `authority_run_preflights`: exact spec, binding, environment, and policy revision batch.
   - `authority_preflight_requirements`: per-story typed requirements and wait outcome.
3. `20260823120000_execution_authority_secret_access.sql`
   - `authority_secret_access_audit`: append-only attributable resolution/revocation events.
4. `20260824120000_execution_authority_rollout.sql`
   - `execution_authority_profiles`: one disabled/enabled, monotonically generated profile per workspace.
   - `execution_authority_rollout_evidence`: append-only migration, API, UI, crash-recovery, redaction, and disposable-fixture results.

All provider credential fields are excluded. Durable rows use opaque `vault://` or `infisical://` references, SHA-256 fingerprints/digests, provider resource identifiers, bounded redacted JSON, and numbered PostgreSQL parameters. The migrations do not create, alter, or drop `pgboss.*` objects.

The profile migration backfills every existing workspace as `disabled` and creates disabled profiles for future workspaces. Database triggers reject profile enablement unless the latest evidence in all six classes is `passed`. Credential-lease insert and activation triggers reject every workspace whose profile is not enabled.

## Required capability and preflight contract

A story may declare `rorca.required-capability.v1` entries with:

- capability id;
- binding reference and exact positive generation;
- environment and provider-resource scope;
- requested operation mode;
- evidence requirements; and
- redacted constraints.

While the workspace profile is disabled, the pipeline does not parse or compile these declarations and does not add authority data to the job payload. Existing specs without declarations therefore retain the legacy planning and delivery bytes and continue through provider-neutral local review.

While enabled, enqueue compiles the runnable-story union. The initial rollout registers only `rorca.core.no-mutation-provider`, a preflight-only classifier. It has no lease, execute, reconcile, revoke, network, or external-send method. Known external-effect requirements become `WAITING_FOR_AUTHENTICATION`; story timeout remains stopped and the independent authority wait expiry remains durable. Unknown capabilities, malformed scopes, missing bindings, and stale generations still fail before publication.

## Operator API

Every endpoint is `admin` tier, includes `x-rorca-rationale`, declares `x-rorca-mcp: false`, and rejects internal execution principals. Mutations also require the local operator capability boundary.

| Method | Path | Contract |
| --- | --- | --- |
| `GET` | `/api/admin/execution-authority/workspaces/:workspaceId/profile` | Profile, current six-class evidence readiness, retained evidence count, and registered mutation adapter ids. |
| `PUT` | `/api/admin/execution-authority/workspaces/:workspaceId/profile` | Exact-generation enable/disable transition. |
| `POST` | `/api/admin/execution-authority/workspaces/:workspaceId/profile/evidence` | Idempotent append-only evidence attachment. |
| `POST` | `/api/admin/execution-authority/workspaces/:workspaceId/requests` | Create an exact request for an existing intent. |
| `GET` | `/api/admin/execution-authority/workspaces/:workspaceId/requests[/:requestId]` | List or inspect selected-workspace requests. |
| `POST` | `/api/admin/execution-authority/workspaces/:workspaceId/requests/:requestId/{approve,deny,cancel}` | Decide or cancel the current exact digest. |
| `GET` | `/api/admin/execution-authority/workspaces/:workspaceId/receipts[/:receiptId]` | List or inspect redacted append-only receipts. |

The canonical `REA-001` through `REA-008` stories cannot approve their own requests. UI and API projections pass centralized redaction before entering React state or response JSON.

## Operator ceremony

1. Select the exact workspace in Execution Authority.
2. Keep the profile disabled while migration, API, UI, crash-recovery, redaction, and disposable-fixture checks run against that source revision.
3. Append each result with its evidence kind, `passed|failed`, immutable artifact reference, SHA-256 digest, observation time, operator principal, and unique idempotency key.
4. Confirm the panel shows six current `Passed` results, the expected retained history count, and zero mutation adapters.
5. Enable with the displayed profile generation. A stale generation or any missing/latest-failed evidence is rejected.
6. Observe enabled runs preflight. With the initial adapter set, external-effect requirements wait for authentication and cannot mutate a provider.
7. Disable immediately if policy, binding, recovery, redaction, or fixture evidence becomes suspect.

No credential value may be pasted into evidence, constraints, request, decision, UI, logs, screenshots, or receipts.

## Program delivery policy

The canonical `rorca-execution-authority-program` spec and TaskManifest envelopes whose `sourceSpecId` identifies that program are pending. Dispatch permits only:

- `autoWorktree=true`;
- `autoMerge=false`; and
- `mergeStrategy=branch-only`.

`direct`, `pr`, and `draft-pr` are rejected before run publication or worktree mutation. The isolated run branch is preserved for local review. Protected-branch push, PR merge, release publication, deployment, and production effects remain unavailable until a separate accepted GitHub external-send policy and mutation adapter exist.

## Crash recovery and disable

Trusted effects reserve one idempotency key and fencing generation before execution. A crash before external acceptance retries under that key. A crash after possible acceptance moves to `uncertain`; restart performs adapter read-side reconciliation before any retry and settles one redacted receipt.

Disabling locks the exact profile generation and atomically:

1. cancels pending authority requests;
2. revokes active grants;
3. revokes prepared, active, exhausted, expired, or reconciliation-required credential leases; and
4. transitions the profile to a new disabled generation.

The database profile and lease triggers stop new leases and activation. There are initially no mutation adapters and therefore no provider-side live session to revoke. If a future accepted adapter introduces provider-side leases, its rollout must add explicit reconciliation/revocation completion to this ceremony before registration.

Disable does not update or delete execution receipts, secret-access audit, rollout evidence, decisions, attempts, or other historical authority rows. Legacy local planning and `LocalReviewBundleAdapter` delivery resume after the transition.

## Retention

Execution receipts are append-only and keep `standard`, `extended`, or `legal_hold` retention metadata. Settled receipt update/delete is rejected at the database boundary. Authority decisions, secret-access audit, and rollout evidence are append-only. Profile disable never shortens receipt retention or removes audit history. Normal workspace/data retention procedures may inspect metadata but must not bypass these guards.

## Rollout and forward-fix

Before applying migrations to a populated installation:

1. take and verify a PostgreSQL backup;
2. record the current `schema_migrations` set;
3. apply migrations through `runPgMigrations`, which wraps each file and schema marker atomically;
4. verify no `pgboss.*` relation changed;
5. run the disposable fixture plus migration/API/UI/recovery/redaction checks; and
6. attach exact evidence before enabling any workspace.

A failed migration transaction leaves no partial schema marker or authority object. Restore the verified backup if the enclosing upgrade must be abandoned. For a committed populated upgrade, do not write ad hoc down SQL and do not delete audit rows; ship the next numbered forward-fix migration, rerun the disposable fixture, attach replacement evidence, and only then re-enable.

## Non-goals

Execution Authority core does not introduce hosted authentication, tenants, SSO, billing, enterprise RBAC, generalized provider marketplaces, speculative provider adapters, or ambient credentials. Local single-user `authRequired=false` remains intentional; execution and operator principals remain distinct at the authority boundary.
