<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Governed Hermes operations

- **Status:** Draft architecture requirements; not an implementation or approval claim
- **Downstream scope:** pending Wave 3A, Wave 3B, Wave 4, and future ROR-30 work
- **Authority:** [ADR 0001](adr/0001-governed-execution-authority.md) and the [Hermes/Rorca boundary](hermes-rorca-boundary.md)

This document adopts useful fleet-operating lessons from Hermes4Friends without importing its authority or unsafe topology. Hermes may observe, classify, propose, execute a separately authorized bounded operational action, and verify the result. Rorca remains canonical for mission, policy, lease, evidence, closeout, and lifecycle state. PostgreSQL owns governed state and replay identity; Git owns code/revision facts; the host owns process, worktree, filesystem, and resource observations. Memory remains advisory.

No requirement here grants spec approval, execution outside a current lease, provider consent, human authority, evidence trust, closeout, merge, deployment, or production mutation.

## Governed Doctor check/fix loop

Every operational check/fix pair is a versioned controller definition with a stable `checkId` and `fixId`. One invocation follows this state machine:

```text
detect → classify → propose → authority → bounded execute → verify → outcome → escalate
```

1. **Detect:** read a bounded, workspace-scoped snapshot and record source identities, revisions, freshness, and host/database time.
2. **Classify:** select a typed condition, severity, affected capability, retryability, blast radius, and confidence. Unknown or contradictory input is not healthy.
3. **Propose:** produce an immutable preview with exact subject/revision, expected precondition/postcondition, action hash, resource impact, rollback or compensation, and expiry.
4. **Authority:** resolve an explicit authority class and current policy. A check never authorizes its own fix.
5. **Bounded execute:** compare-and-set the preview against current state, acquire one fence/lease, enforce attempt/rate/cost/time limits, and perform only the declared operation.
6. **Verify:** re-read independently observable postconditions. Command exit, runtime prose, heartbeat, and raw test count are not verification by themselves.
7. **Outcome:** append `fixed`, `unchanged`, `blocked`, `failed`, `compensated`, `indeterminate`, or `quarantined` with exact observations and hashes.
8. **Escalate:** stop and present one safe next action when authority is absent, ambiguity remains, verification fails, the budget expires, or compensation cannot restore a known state.

### Auto-fix authority classes

| Class | Examples | Automatic posture |
| --- | --- | --- |
| `A0_observe_only` | Canonical mission/spec/evidence/closeout/lifecycle/human decisions; immutable artifacts; ownership ambiguity | Detect, classify, and propose only. Never auto-fix. |
| `A1_rebuildable_projection` | Cache, read-model projection, derived index, bounded telemetry cursor | Auto-fix may rebuild from canonical sources after exact scope and freshness checks. |
| `A2_ephemeral_runtime` | Fenced stale worker, disposable temp state, bounded reconnect | Auto-fix may restart/fence/recreate only with a current lease, no competing writer, and preserved diagnostics. |
| `A3_external_identity_preserving` | Provider/runtime/Forgejo configuration update | Requires declared external operational authority and identity-preserving PATCH/update plus verification. No implicit consent. |
| `A4_destructive_or_authoritative` | Delete/recreate, credential revoke, offboard cleanup, canonical rewrite, merge, deploy | Separate explicit human/policy authority and saga; never silent or inferred. |

All fixes default to dry-run/preview. Mutation requires an idempotency key over complete material input; identical replay returns the prior outcome and changed replay is a permanent audited conflict. Definitions specify maximum attempts, wall-clock/provider-cost/resource budget, rate limit, cooldown, one in-flight fence, retry classification, expected postcondition, compensation, and quarantine threshold. Overlapping cron/controller layers share one PostgreSQL-owned lock and aggregate budget rather than independently retrying. Audit records are append-only, workspace-scoped, redacted, bounded, and link previews, authority receipts, observations, execution, verification, compensation, and escalation without raw prompts, secrets, or human signatures.

## Typed dependency capability and health admission

Runtime selection and work admission consume immutable, typed `DependencyCapabilitySnapshot` records. Each snapshot binds:

- workspace, dependency, adapter/runtime and capability revision;
- capability kind and supported contract versions/features;
- status `healthy | degraded | unavailable | rate_limited | circuit_open | unknown`;
- observed-at, valid-until, probe/source identity, latency and bounded reason codes;
- rate-limit headroom, circuit state/cooldown, quota/budget posture;
- fallback policy and whether degradation is allowed; and
- opaque credential reference only, never a credential value.

Admission computes the required capability set from the mission/work package and active policy. A required missing, stale, unknown, incompatible, unhealthy, exhausted, or circuit-open dependency blocks before lease/launch. An advisory dependency may degrade only when policy explicitly allows it and the degraded dimension is projected. Runtime/provider fallback must independently satisfy exact capability, health, isolation, budget, credential, and authority requirements; it is never selected from exception text. A conservative `RorcaManagedExecutor` fallback is permitted only when its own snapshot is current and the work package remains within its existing branch-only/no-merge/no-deploy ceiling.

## Resource quotas and noisy-neighbor isolation

Admission and continued execution enforce both per-workspace and per-runtime-generation quotas for:

- CPU time/share and memory/working-set;
- active execution and continuation concurrency;
- event/record/byte rate and replay volume;
- required/advisory context bytes, tokens, items, and retrieval frequency;
- durable/temporary/archive storage bytes and object counts; and
- provider token/currency spend, request rate, and retry spend.

Limits are versioned policy inputs with soft warning, hard stop, observation window, and reset/cooldown semantics. The stricter applicable workspace/runtime/global limit wins. Reservation and use are atomic and idempotent; expiry releases reservations, while measured use remains auditable. Hard exhaustion blocks admission or fences only the affected runtime/workspace, preserves evidence, and cannot be converted into success. Fault tests must prove that one workspace's CPU, memory, storage, event flood, context amplification, retry storm, or provider exhaustion cannot consume another workspace's allocation.

Observability is isolated by workspace and runtime generation through authorization, database scope, cryptographic cursor identity, project/partition/label policy, retention, and quotas—not labels alone. Cross-workspace joins, replay, raw-reference resolution, dashboards, alerts, and error paths fail closed. Raw prompts, unrestricted context, transcripts, secrets, provider tokens, database URLs, and human authority payloads are excluded from ordinary telemetry.

## Idle-loop cost circuit breaker

Always-on does not mean always polling. Controllers use event-driven wake-up for canonical state changes, webhook delivery, lease deadlines, explicit operator requests, and bounded reconciliation timers. Heartbeats prove liveness only.

Each loop records last material change and enforces no-change tick count, elapsed-time, token/request/currency, and retry ceilings. Consecutive idle ticks cause exponential sleep with jitter; crossing any hard ceiling atomically transitions the scoped controller to `suspended`, releases nonessential reservations, and emits one redacted escalation. A relevant authenticated event may request wake-up, but resumption rechecks dependencies, quotas, lease/fence, policy, cursor, cooldown, and single-writer identity. Repeated wake/suspend oscillation opens a circuit and requires governed operator review. Suspension cannot cancel canonical work silently, mark completion, or discard diagnostics.

## Provisioning and offboarding saga

Provider, runtime, and Forgejo integration lifecycles use one canonical, workspace-scoped `ResourceInventory`. Every entry records resource type, immutable external ID, owner/workspace labels, provider/account/region, desired and observed revision, credential-reference identity, dependencies, retention class, creation/update observations, and lifecycle status. Discovery is an observation; it cannot establish ownership or authorize deletion.

Provisioning is an idempotent staged saga: validate authority and capability health; reserve quota; create or adopt an exactly owned resource; configure by identity-preserving PATCH/update; verify; record inventory; then admit. Each completed stage has a compensation and an `indeterminate` branch for unprovable provider outcomes. Retries reconcile by exact external identity and request hash rather than creating replacements.

Offboarding is separately authorized and staged: revoke new admission; fence/quarantine active runtime work; verify no active lease or continuation dispatch; rotate/revoke scoped credentials; archive evidence according to retention policy; detach dependencies; preview cleanup; then execute explicitly authorized cleanup and verify inventory. Unknown, shared, unlabeled, referenced, or provider-ambiguous resources are quarantined, never blindly deleted. Delete/recreate is allowed only as an explicit replacement saga with a new identity, lineage, revalidation, compensation, and review.

## Operational status planes

Operational readiness is a composition, never one green badge. Read models expose these distinct planes with independent source, observed-at/valid-until, reason, impact, and next safe action:

1. source/config drift;
2. dependency capability/health;
3. runtime/process/sandbox/resource health;
4. queue/outbox freshness and backlog;
5. lease/fence/retry/recovery state;
6. observability ingest/replay/archive freshness; and
7. provider/operations readiness, including credential-reference rotation and quota/circuit posture.

These planes do not overwrite canonical mission, evidence, closeout, or lifecycle state. A unit-test result, process exit, PTY line, raw test count, heartbeat, or runtime self-report cannot make an operational plane healthy. Silence may reduce alert noise only while a bounded current health observation remains valid. Alerts are workspace-isolated, transition/actionability based, deduplicated, rate-limited, and free of raw prompts or secrets.

## Supervisor and worker provider failure isolation

Supervisor/operator and execution-worker identities, provider credentials, model budgets, rate limits, circuits, processes, and queues are separate failure domains. A shared provider account must not make both roles simultaneously unavailable. Selection uses the typed capability/health admission above. A supervisor may select or propose fallback but cannot transfer its credential, budget, lease, or authority to a worker. A worker cannot make itself supervisor, issue a lease, approve evidence, or widen provider scope.

When a worker provider fails, Rorca preserves the exact attempt and host evidence, fences the generation, and either blocks or admits a policy-compatible conservative managed fallback under a new attempt/fence. When the supervisor provider fails, existing fenced workers may continue only within current leases; reconciliation and authority remain available through Rorca/host state without model inference. No fallback retries passed work, changes provider identity under the same attempt, or grants merge/deploy/provider authority.

## Clean-room reconstruction certification

Wave 4/release certification must reconstruct one isolated workspace/control-plane lane from declared canonical inputs only: Git at exact SHA, PostgreSQL migrations plus a verified backup/ledger, versioned policy/configuration, vault/secret references, and content-addressed artifacts. Hidden home-directory files, ambient environment, mutable host cron, undocumented SSH state, caches, projection databases, runtime-local memory, and manually preserved containers are forbidden prerequisites.

The certification uses a fresh host namespace and empty projection/cache directories, then proves migration and contract regeneration, inventory reconciliation, queue/outbox recovery, lease/fence/retry scans, artifact checksums, context retrieval/continuation safety, status-plane reconstruction, and safe degraded behavior for unavailable optional dependencies. It records exact source/migration/contract/artifact hashes, commands, tool versions, bounded redacted observations, and unresolved blockers. A raw test count or successful command is not certification; an independent review of the exact packet remains required.

## Unsafe patterns not to copy

The following patterns are prohibited architecture inputs:

- plaintext `.env` or JSON credentials, access tokens, database URLs, or provider keys;
- hardcoded public topology, direct root SSH, shared operator key material, or runbooks containing secret-bearing commands;
- Docker-in-Docker as the default tenant/runtime sandbox;
- one shared bot/runtime/human identity across workspaces or rooms;
- blind deletion of unknown/orphaned resources or automatic canonical config rewrite;
- delete-and-recreate where identity-preserving PATCH/update is available;
- credential rotation only after HTTP 401, rather than expiry, compromise revocation, bounded overlap, and proactive policy;
- overlapping cron layers without one durable lock, idempotency identity, cooldown, and aggregate retry/cost budget;
- raw prompt/transcript/context observability or cross-tenant observability projects;
- “code complete,” process success, or raw test counts treated as host evidence, closeout, operational readiness, approval, or production proof; and
- unrelated travel/IATA data models or other accidental source contamination treated as Rorca requirements.

## Downstream gates

- **Wave 3A:** typed dependency/capability admission; workspace/runtime quotas; supervisor/worker failure isolation; conservative managed fallback.
- **Wave 3B:** isolated/redacted observability and all seven separate operational status planes.
- **Wave 4:** governed Doctor controller; idle suspension; provisioning/offboarding saga; resource/noisy-neighbor fault injection; clean-room reconstruction.
- **ROR-30:** may compose these capabilities as an always-on operator, but remains subject to the same authority and no-merge/no-deploy boundaries.

The pending specs are design recommendations only. Material edits invalidate prior authoring material and require fresh preflight and independent review before any approval or execution decision.
