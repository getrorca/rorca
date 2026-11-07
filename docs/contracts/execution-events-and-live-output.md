<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Execution events and live output — draft contract requirements

- **Status:** Design input; not yet an implemented wire schema
- **Linear:** [ROR-25](https://linear.app/rorca/issue/ROR-25/build-runtime-neutral-live-terminal-and-structured-activity-streaming)

The Run View remains runtime-neutral. Managed and federated execution publish a sequenced stream, while canonical evidence and decisions remain separate stores.

## Three non-interchangeable classes

1. **Terminal telemetry:** raw bounded ANSI/PTY/stdout useful for humans and diagnostics; never evidence by itself.
2. **Structured activity:** runtime status, plan/task/tool activity and requests for human input; useful for supervision/read models but not closeout authority.
3. **Host-observed evidence:** commands, exits, commits, changed paths, tests, artifacts and provider attestations bound to exact revisions; eligible for closeout evaluation.

## Stream envelope

An eventual `RunStreamEnvelope` must bind at least:

```text
schemaVersion
eventId
workspaceId/runId
missionRevision
workPackageId/attemptId/leaseId/runtimeId
sequence
timestamp
type
payload or rawRef
payload hash
redaction/retention classification
```

Candidate types include terminal chunks, runtime status, plan/task/tool activity, validation observations, evidence acceptance, closeout decisions, lifecycle changes, human-input requests and liveness heartbeats. Operational projections use distinct typed events for source/config drift, dependency capability/health, runtime/resource health, queue/outbox freshness, lease/retry recovery, observability freshness, provider/operations readiness, quota/circuit transitions, Doctor proposals/outcomes, saga stages, and idle suspension/wake. These planes must not be collapsed into one readiness flag.

Context-continuation events are runtime-neutral first-class types:

```text
context_compaction_started
context_compaction_ended
agent_settled_observed
pi_auto_retry_started
pi_auto_retry_ended
pi_auto_retry_settled
execution_completion_candidate_observed
execution_completion_candidate_validated
execution_completion_candidate_rejected
execution_completion_candidate_submitted
context_checkpoint_persisted
context_retrieval_requested
context_retrieval_completed
context_retrieval_degraded
context_retrieval_failed
continuation_authorized
continuation_dispatched
continuation_settled
cursor_advanced
context_stale
context_rejected
continuation_quarantined
```

Each carries canonical workspace/mission/work-package/spec/story/run/attempt/lease/fence/runtime, originating turn/generation, session/cursor, repository/base/current SHA/worktree/path-manifest, validation/root-cause, policy-definition/activation, event and payload hashes, and checkpoint/receipt/bundle/dispatch references where applicable. Compaction events require success/aborted/willRetry/result fields; settled and Pi retry events require exact matching turn/generation/retry-cycle identity and phase. Raw prompts, transcripts, credentials, secret values, human attestations/signatures, and unrestricted context are prohibited. These events project the state machines in [`context-checkpoint-retrieval-and-continuation.md`](context-checkpoint-retrieval-and-continuation.md); they are observability/audit records, not authority.

## Delivery semantics

- Stable event identity plus monotonic per-attempt sequence.
- Identical replay is idempotent; conflicting identity reuse is rejected.
- Browser reconnect uses a sequence cursor and bounded replay.
- Backpressure cannot silently drop canonical evidence or decisions.
- Terminal retention may use bounded files/artifacts rather than one database row per chunk.
- Credentials and unredacted secrets are prohibited.
- Projection and replay authorization, generation-bound cursors, labels/partitions, retention, rate/byte quotas, raw references, dashboards, alerts, logs, and errors are isolated per workspace/runtime; labels alone are not an authorization boundary.
- Raw prompts, transcripts, unrestricted context, environment snapshots, database URLs, provider tokens, and human authority payloads are prohibited from ordinary observability. Redacted bounded references may resolve only through separately authorized restricted storage.
- Status events carry source identity, observed-at/valid-until, reason, impact, and next safe action. Unit-test results, raw test counts, heartbeat, process exit, terminal text, and runtime self-report cannot set operational readiness.
- Terminal stream loss does not alter attempt/closeout/lifecycle truth.
- `compaction_end` alone does not authorize a prompt. It must be successful and non-aborted, name its originating turn/generation, match a later `agent_settled`, and have no pending Pi retry cycle. A controller-validated execution-turn completion candidate suppresses continuation and submits proposals only; it is distinct from canonical closeout acceptance.
- Identical event replay is idempotent. Changed replay across repository/base/worktree/spec/story/path/validation/root-cause/retry/turn/policy/bundle material is a permanent audited conflict, consumes no transport retry, and cannot be bypassed with a random key.
- One database-owned retry budget spans API, worker, Hermes, controller, companion, and transport retries; permanent authority/identity/secret/stale conflicts never retry and exhaustion quarantines.

## Operational-event isolation

Closeout/lifecycle correction events must be semantically distinct from ordinary execution completion. A reconciliation event cannot activate agent hooks, queue consumption, memory synthesis, execution, provider mutation, PR/check creation, merge, deployment or cleanup.

A health/check event is also not fix authority. Doctor execution requires an exact preview, authority class, idempotency identity, budget/cooldown/fence, postcondition verification, compensation, and audit under [`../architecture/governed-hermes-operations.md`](../architecture/governed-hermes-operations.md). Idle-loop suspension and event-driven wake remain transport/operations state and cannot change mission, lease, evidence, closeout, lifecycle, merge, or deployment truth.

## Interactive input

Federated terminal input is read-only by default. Input requires an explicit lease capability, local-human authority and an append-only audit record. Otherwise the runtime emits a structured human-input request and pauses/replans safely.
