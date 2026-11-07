<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Governed mission and lifecycle control plane

This document is the architecture index for [ROR-22](https://linear.app/rorca/issue/ROR-22/architecture-evolve-rorca-into-a-governed-mission-and-lifecycle). The decision is proposed in [ADR 0001](adr/0001-governed-execution-authority.md).

![Governed mission control plane](../diagrams/rorca-governed-mission-control-plane.png)

Editable source: [`../diagrams/rorca-governed-mission-control-plane.excalidraw`](../diagrams/rorca-governed-mission-control-plane.excalidraw).

## Identity shift

```text
FROM
spec → frozen story DAG → new process per story → exit status risks authority

TO
versioned mission → bounded work package/lease → interchangeable runtime
→ normalized host evidence → closeout → lifecycle evaluation → governed transition
```

Rorca does not become merely a spec organizer. It remains responsible for stable intent, bounded authority, evidence provenance, policy evaluation, lifecycle state and verified learning.

## Planes

### Mission and policy

Canonical specs, workspace policy and approvals compile into an immutable `MissionContract` revision. The compiler preserves source identities/hashes and cannot broaden permissions or weaken requirements.

### Execution admission and leases

A `WorkPackage` selects an independently verifiable delivery slice. An `ExecutionLease` binds runtime/attempt identity, exact mission and repository revisions, allowed paths, limits, expiry/fencing and delivery/knowledge authority.

Admission transport and executor type are separate concerns. A TaskManifest can admit work to a managed executor; a federated lease can admit an external runtime.

### Operational admission and health

Runtime admission consumes typed capability/dependency-health snapshots and scoped CPU, memory, concurrency, event, context, storage, retry, and provider-cost quotas. Required unhealthy/stale capabilities block before lease/launch; permitted advisory degradation remains explicit. Supervisor and worker provider identities/budgets/circuits are separate failure domains, and any conservative managed fallback receives a new attempt/fence without widened authority.

Hermes operational controllers use the check/fix, idle suspension, resource inventory/saga, identity-preserving update, observability-isolation, status-plane, and clean-room reconstruction requirements in [`governed-hermes-operations.md`](governed-hermes-operations.md). Operational health is a projection over canonical PostgreSQL/Git/host facts; it cannot author mission, evidence, closeout, lifecycle, approval, merge, or deployment state.

### Execution runtimes

- The managed lane retains current local worktree/process/PTY/provider behavior.
- A federated lane may use a long-lived observe/plan/edit/validate loop.
- Both emit the same attempt, event, proposal and evidence contracts.
- Neither can pass closeout or lifecycle gates.

### Evidence, closeout and lifecycle

```text
runtime claim + host observations
              ↓
evidence normalization and append-only ledger
              ↓
StoryCloseoutDecision
              ↓
LifecycleDecision
              ↓
configured QA / merge / production authority
```

Operational terminal/activity events and canonical evidence are distinct. Reconciliation/correction events must not trigger execution, hooks, memory synthesis, queue consumption, provider mutation, merge or deployment.

### Context, continuation and verified knowledge

Execution consumes a versioned `ContextBundle` and produces observations/artifacts/evidence. Required execution context (exact mission/work package/spec/story/criteria, lease/generation, Git/worktree, cursor/checkpoint, validation/failure/evidence pointers, direction and policy) is structurally separate from advisory semantic memory. Memory can suggest decisions, conventions, patterns and gotchas; it can never grant authority, override the spec, prove completion or promote lifecycle state.

Rorca owns canonical checkpoint, immutable continuation-policy definition, scope-bound policy activation/revocation, retrieval-receipt, bundle/delta, retry-budget, and dispatch state. Hermes may orchestrate refresh and a runtime adapter may deliver one authorized continuation. Deprecated epoch data is only an exact server-generated compatibility read projection; writes reject and its retirement gate is versioned. Required-context failure blocks. Advisory-memory outage degrades only when the active policy activation permits it and remains explicit. PostgreSQL remains canonical; AGE, pgvector and Markdown are freshness-aware rebuildable projections.

The complete design input is [`../contracts/context-checkpoint-retrieval-and-continuation.md`](../contracts/context-checkpoint-retrieval-and-continuation.md). The first federated pilot does not wait for the complete ontology/projection roadmap, but it must pass this continuation contract.

## UI continuity

The product flow remains familiar:

```text
select spec → run → open Run View → watch live work
→ inspect evidence → see closeout/lifecycle result
```

Run View should project:

- Overview: mission revision, runtime, lease, delivery authority.
- Live: raw ANSI/PTY/stdout telemetry.
- Plan & Tasks: mutable runtime-local planning.
- Evidence: host-observed commands, commits, tests and artifacts.
- Decisions: closeout and lifecycle decisions.

Managed execution can retain the current PTY initially. Federated runtimes stream authenticated sequenced terminal/activity telemetry into the same Rorca UI.

## Program sequence

| Milestone | Outcome | Linear |
| --- | --- | --- |
| M0 | Current-stack stabilization and branch-only managed proof | [ROR-29](https://linear.app/rorca/issue/ROR-29/stabilize-evidence-driven-closeout-and-branch-only-managed-delivery) |
| M1 | Authority ADR and runtime-neutral contracts | [ROR-24](https://linear.app/rorca/issue/ROR-24/adr-establish-rorca-execution-authority-and-trust-model), [ROR-23](https://linear.app/rorca/issue/ROR-23/define-mission-work-package-lease-evidence-and-lifecycle-contracts) |
| M2 | Managed adapter and runtime-neutral live output | [ROR-28](https://linear.app/rorca/issue/ROR-28/wrap-the-current-execution-engine-as-rorcamanagedexecutor), [ROR-25](https://linear.app/rorca/issue/ROR-25/build-runtime-neutral-live-terminal-and-structured-activity-streaming) |
| M3 | One bounded federated runtime pilot | [ROR-26](https://linear.app/rorca/issue/ROR-26/pilot-one-federated-runtime-under-a-bounded-execution-lease) |
| M4 | Hermes always-on operator | [ROR-30](https://linear.app/rorca/issue/ROR-30/establish-hermes-as-the-always-on-prompt-to-completion-operator) |
| M5 | Knowledge promotion and projection hardening | [ROR-27](https://linear.app/rorca/issue/ROR-27/harden-evidence-to-knowledge-promotion-and-canonical-projections) |

## Metrics

Measure accepted outcomes, not autonomous activity:

- time to validated completion;
- false-completion rate;
- cost per accepted requirement;
- human intervention rate;
- plan churn;
- duplicate/orphan execution rate;
- context precision and token waste;
- reviewer/fixer iterations;
- knowledge-promotion precision.

## Related contracts

- [`../contracts/mission-contract.md`](../contracts/mission-contract.md)
- [`../contracts/work-package-and-execution-lease.md`](../contracts/work-package-and-execution-lease.md)
- [`../contracts/context-checkpoint-retrieval-and-continuation.md`](../contracts/context-checkpoint-retrieval-and-continuation.md)
- [`../contracts/execution-events-and-live-output.md`](../contracts/execution-events-and-live-output.md)
- [`../contracts/evidence-closeout-and-lifecycle.md`](../contracts/evidence-closeout-and-lifecycle.md)
- [`runtime-conformance.md`](runtime-conformance.md)
- [`hermes-rorca-boundary.md`](hermes-rorca-boundary.md)
- [`governed-hermes-operations.md`](governed-hermes-operations.md)
- [`../implementation/context-continuation-cross-wave-plan.md`](../implementation/context-continuation-cross-wave-plan.md)
