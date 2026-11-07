<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Wave 2 governed Mission Control implementation

This note describes the implemented Wave 2 control-plane boundary. It is not an approval or completion record. PostgreSQL canonical state, exact Git identity, existing provider-human SSDLC decisions, and explicit policy authority remain controlling. Memory, MCP, terminal output, process exit, events, and completion candidates are advisory or observational only.

## Sources and generated contracts

- Source schemas: `backend/src/lib/governed-contracts/`
- Generated JSON Schema manifest: `packages/rorca-public-contract/schemas/governed-execution/manifest.json`
- Public TypeScript exports: `packages/rorca-public-contract/src/index.ts`
- Transactional services: `backend/src/lib/governed-mission-service.ts`
- REST boundary: `backend/src/routes/mission-control.ts`, mounted at `/api/mission-control/v1`
- PostgreSQL migrations: `20260729131000`, `20260729132000`, `20260729133000`, and `20260729134000`

All governed mutation request and replay identities are server-computed with domain-separated LP1 hashing. Caller-supplied `contentHash` and `payloadHash` fields remain lineage inputs, not sufficient replay proof.

## Persistence and lock order

The service uses the canonical transaction helper and PostgreSQL database time. Stable mission rows point to immutable mission versions. Mutable work-package and policy-activation state uses CAS heads over immutable revisions. Lease operations lock the execution slot before the lease row; context scope operations lock their scope head; ordered event ingestion locks one attempt/generation stream head.

An exact idempotency key is scoped by workspace, principal, operation, and hashed key. Exact replay returns a bounded persisted response. A changed request under the same scope writes replay-conflict and audit evidence, then returns a stable conflict. Business failures roll back the mutation and are separately audit-attempted without replacing the original error.

Policy activation revocation is represented by a new immutable activation revision plus a mutable scope head. Renewal, checkpointing, dispatch authorization/consumption, and closeout eligibility require the lease activation hash to remain the current active head. Existing immutable artifacts remain reviewable but are ineligible for new authority-bearing use.

## Context continuation

Required context and advisory memory are separate arrays in `ContextBundleV1`. Advisory memory cannot satisfy required context, evidence, closeout, policy, or lifecycle state. Receipts preserve ordered, same-class source identities and explicit token accounting. Delta reuse requires all stable-scope, base-integrity, version, redaction, chain-depth, allowed-difference, descendant-Git/path, target-byte, and target-hash checks; every uncertainty returns a full-bundle requirement.

One shared PostgreSQL retry budget serializes actors. Permanent identity/hash/version/secret conflicts do not spend retries. Exhaustion creates one quarantine. Continuation authorization verifies the lease first; consumption locks and verifies it again, checks current activation, and consumes the continuation key once. Consumption creates an outbox row atomically. A transport claim is recovery ownership, never send authority: the sender must obtain a five-second server authorization under the exact dispatch→outbox→lease→activation lock hierarchy, use the immutable delivery key as the provider idempotency key, and return that authorization at settlement. Cancellation/revocation before authorization blocks send; a provider acceptance discovered after authority changed is recorded as `unknown`/quarantined rather than relabeled sent.

`ContextEpoch` has no authority table or writer. The compatibility route computes one non-authoritative read projection from a canonical bundle, records bounded read telemetry, and excludes raw content. Non-GET attempts are rejected and recorded without retaining their payload. Retirement evaluation derives release age/count, zero-use, and client migration status from PostgreSQL and requires fixture, break-marker, release-note, next-major, and independent-review evidence fields before it can record eligibility.

## Events, evidence, and closeout

Runtime events bind continuation identities, three order domains, typed compaction/retry/completion-candidate material, trust, redaction, and restricted-reference metadata. Runtime generation must match the immutable execution attempt. Duplicate event bytes are idempotent; changed replay, gaps, regressions, stale generation, and runtime substitution are permanent conflict records.

Evidence binds explicit mission/work-package/spec/story/attempt/lease/fence/activation/checkpoint/repository/worktree lineage. Observer identity and maximum trust are server-bound. Runtime evidence is stored as agent-proposed observation and cannot make closeout eligible. Host-observed or stronger evidence still must match the exact leased subject and server-computed envelope hash.

Closeout evaluation resolves an immutable work-package evidence-obligation set, then recomputes missing kinds, conflicting evidence, minimum trust, and required status from canonical rows rather than the caller's selection. It records eligible, blocked, failed, cancelled, expired, conflicted, stale, or reconciliation-required outcomes with `establishesStoryCompletion=false`. Only an existing accepted `StoryCloseoutDecision` can establish story completion; this implementation does not create a competing authority.

Cancellation immediately revokes the exact active lease under fence/state CAS. Requests and acknowledgements are append-only. Accepted, duplicate, late, wrong-runtime, wrong-fence, and contradictory acknowledgement classifications are preserved and cannot revive execution. Plan-change proposals are non-mutating, base-revision-bound, cannot expand allowed paths, and have literal false merge/deployment requests.

## API and MCP boundary

Sanitized mission, run, event, evidence, and ContextEpoch reads use the authenticated tier, workspace membership checks, and transaction-scoped PostgreSQL workspace binding. Every operator mutation requires an exact workspace admin/owner membership (platform role alone is insufficient), is admin-tier and strict-schema validated, and is excluded from public/MCP generation. Runtime ingress instead requires a bounded internal-service credential and exact `X-Rorca-Runtime-Id`, then re-resolves lease authority. Host evidence requires the internal service identity to equal the evidence observer. Parser-originated malformed/oversized bodies and post-parse route limits share stable AppError envelopes. OpenAPI assigns named strict request/response components to every operation.

The current managed executor is unchanged. `RORCA_GOVERNED_MISSION_MODE` defaults to `off`; `observe`/`enforce` compatibility projection is explicitly non-authoritative and refuses legacy rows missing exact spec revision, full Git SHA, or worktree identity. It never enables parallelism, auto-merge, deployment, or provider mutation.

## Threat model

The implemented controls cover:

- runtime/actor substitution: authenticated creator/observer and immutable attempt/runtime binding;
- stale fences and revision substitution: slot locks, monotonic fences, CAS heads, full SHA/repository/worktree lineage;
- evidence escalation: server-derived maximum trust and host/provider/human class separation;
- cross-workspace access: workspace composite keys, exact operator membership, and forced RLS bound to transaction-scoped `rorca.workspace_id`; migration owner, ordinary runtime, and canonical source-writer database principals are distinct constrained non-superuser roles with no inherited membership;
- changed replay and retry storms: server hashes, durable conflict rows, shared budgets, permanent-conflict no-retry, quarantine;
- stale-base confusion: byte/hash reconstruction plus fail-safe full bundle;
- event floods/order laundering: body/rate limits, bounded fields, stream heads, three order domains, explicit conflicts;
- secret/attestation leakage: recursive schema rejection, bounded JSON checks, redacted read models, restricted references only;
- confused deputies/MCP overexposure: admin-tier mutation routes and exact internal runtime credentials;
- deprecated projection laundering: projection-only response, no writer, write-rejection telemetry, executable retirement gates;
- memory/terminal/process-exit laundering: explicit non-authority labels and canonical evidence/closeout resolution.

## CI-independent local validation

Use a fresh unique database whose name ends `_test`, owned by a dedicated login with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Never use shared/live targets and never prune.

1. Start invocation-owned PostgreSQL 16 with `pgcrypto`, `vector`, and `age`; pre-provision the repository's required `auth` functions/roles.
2. Create distinct non-superuser migration, ordinary runtime, and canonical-writer logins with no role membership between them. Set `DATABASE_URL` to runtime, `RORCA_MIGRATION_DATABASE_URL` to migration, `RORCA_RUNTIME_DATABASE_USER` to the runtime role name, and both `RORCA_CANONICAL_WRITER_DATABASE_URL` / `RORCA_CANONICAL_WRITER_DATABASE_USER` to the dedicated writer. Startup rejects identity reuse or an unregistered principal.
3. Run `tsx src/db/pg-index.ts` through the migration login (or let startup use the explicit migration URL); exact ROR-24/Wave-1 source evidence is verified before the first Wave 2 DDL. Verify runtime has no canonical DML or mutation-function EXECUTE, writer has only workspace-scoped canonical grants, all migrations/readiness are current, no application migration manages `pgboss`, role flags/memberships are constrained, and extension versions are exact.
4. Set `WAVE2_TEST_MIGRATION_DATABASE_URL` to migration and keep the three application role variables above bound to the same invocation-owned `_test` database, then run `jest --config jest.wave2-db.config.ts --runInBand` and the unit lane.
5. Run backend/root/public-contract/Pi typechecks, generated-contract stability, Swagger parity, tier/MCP checks, lint, builds, security scan, license checks, and `git diff --check`.
6. Capture exact commands, tool versions, source SHA, logs and hashes. Drop only the invocation-owned database/role, stop its server, remove its state/socket/credential material, and prove listener cleanup.

No validation command, test result, memory, or reviewer prose changes story `passes`, approval, execution, merge, deployment, provider, or production authority.
