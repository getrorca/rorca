<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# ADR 0001: Governed execution authority and runtime federation

- **Status:** Proposed
- **Linear:** [ROR-22](https://linear.app/rorca/issue/ROR-22/architecture-evolve-rorca-into-a-governed-mission-and-lifecycle), [ROR-24](https://linear.app/rorca/issue/ROR-24/adr-establish-rorca-execution-authority-and-trust-model)
- **Program:** [Rorca Governed Mission Control Plane](https://linear.app/rorca/project/rorca-governed-mission-control-plane-d52be93c4e7b)
- **Diagram:** [`../../diagrams/rorca-governed-mission-control-plane.excalidraw`](../../diagrams/rorca-governed-mission-control-plane.excalidraw)

## Context

Rorca currently combines canonical run governance with a first-party, process-per-story execution engine. That engine remains valuable for local, offline and tightly constrained execution, but it should not define Rorca's product identity or be the only runtime capable of satisfying a governed work package.

The existing evidence-driven lifecycle already establishes the critical trust separation:

```text
process outcome ≠ story closeout ≠ lifecycle pass ≠ merge approval ≠ production approval
```

External, long-lived autonomous runtimes can improve planning continuity and reduce repeated context/process startup, but they must not become requirements, evidence, lifecycle or approval authority.

## Decision

Rorca will evolve into the canonical mission, policy, evidence and lifecycle control/evaluation plane. Execution is delegated through versioned contracts to managed or federated runtimes.

```text
Human / API / cron / webhook
            ↓
Hermes — optional always-on operator and supervisor
            ↓
Rorca — mission, policy, evidence and lifecycle authority
            ↓
Managed / brokered / federated execution runtimes
```

### Stable authority above adaptive execution

A canonical spec, policy inputs and approvals compile into an immutable `MissionContract` revision. Execution plans and runtime-local tasks may change beneath that revision without changing requirements.

- Runtime-local task changes may be autonomous.
- Work-package boundary changes require a `PlanChangeProposal` and governed acceptance.
- Requirement, invariant, evidence-obligation, risk or authority changes require a mission/spec amendment and a new revision.
- A new mission revision makes affected evidence and approvals stale.

### Runtime claims are non-authoritative

Agents and runtimes may propose completion. Execution hosts observe facts. Rorca normalizes evidence, records a `StoryCloseoutDecision`, derives lifecycle state and requests configured human/policy authority where required.

Terminal text, heartbeat, tool completion and process exit cannot directly pass a story or lifecycle gate.

### Authorities remain explicit

- Git owns code, branch and commit facts.
- CI providers own their check attestations.
- Deployment systems own rollout facts.
- Rorca owns binding, provenance, policy evaluation and governed lifecycle state around those facts.
- Configured humans/policies own QA, merge and production decisions where declared.
- Hermes cannot impersonate human authority or maintain competing canonical lifecycle state.

### Supported operating modes

- `RorcaManagedExecutor`: first-party reference/constrained lane retaining current worktree, process, CLI-provider and PTY behavior behind a stable adapter.
- Brokered admission: TaskManifest/operator calls submit bounded intent into a managed executor; the broker is an admission/transport boundary, not a separate executor.
- `FederatedRuntimeAdapter`: an external runtime executes under an expiring, fenced `ExecutionLease` and returns events, attempt results, proposals and evidence.

Managed and federated runtimes must pass the same conformance suite and feed the same closeout evaluator.

### Hermes boundary

Hermes may be the persistent prompt-to-governed-completion operator. It may run cron jobs, webhook consumers, health probes and reconciliation controllers; choose eligible runtime/provider/model capabilities; monitor work; request bounded retries/replans; and present evidence and approvals.

Hermes Operator Client, Hermes Runtime Adapter and human approval identities are separate. Hermes does not become a required executor or Rorca datastore client.

### Completion boundary

The default product completion boundary is a merge-ready draft PR with governed evidence. Merge and deployment remain separate explicit authorities. This ADR introduces no autonomous deployment.

## Migration

Use a strangler transition:

1. Stabilize evidence-driven closeout, reconciliation and branch-only managed delivery.
2. Freeze expansion of the process-per-story scheduler except safety fixes.
3. Define mission/work-package/lease/event/evidence plus context-checkpoint/retrieval/continuation contracts and conformance tests.
4. Wrap the existing engine as `RorcaManagedExecutor` without first rewriting it.
5. Preserve live PTY output through a runtime-neutral sequenced stream.
6. Pilot one external runtime, one work package, exact revision/SHA, restricted paths and branch-only authority.
7. Expand based on measured validated completion time, cost, failures and human intervention.

## Superseded assumptions

When accepted, this ADR supersedes only these older assumptions:

- `execution-engine.ts` must remain the sole possible executor forever;
- one precomputed story DAG must determine every runtime-local task;
- each story must require a new process/context window;
- process success may directly establish completion;
- Hermes must couple to the internals of the Rorca execution engine.

It does not supersede the canonical lifecycle phase order, evidence ledger, closeout gate, human approval contracts, worktree safety or current managed executor behavior.

## Consequences

### Positive

- Rorca's authority model survives changes in agent/runtime technology.
- Managed execution remains a safe local fallback and conformance reference.
- Long-lived external runtimes can plan adaptively without weakening requirements.
- UI terminal visibility can remain stable across local and remote execution.
- Hermes can supervise continuously without becoming a second control plane.

### Costs and risks

- Leases require identity, expiry, fencing, cancellation and duplicate-event handling.
- Runtime-neutral streaming requires sequence, replay, backpressure and redaction.
- Event semantics must prevent closeout/reconciliation events from activating ordinary execution subscribers.
- Mission compilation must not create a competing requirements source.
- Provider credentials and subscription-backed CLIs require explicit capability and vault boundaries.
- Post-compaction continuation requires immutable policy definition plus scope-bound activation, canonical required context, advisory-memory isolation, successful non-aborted turn/settled/retry identity, lease revalidation, one distributed retry budget, and exactly-once dispatch rather than deprecated epoch input, pane text, or runtime-local memory.

## Explicit non-goals

- A wholesale rewrite of the existing execution engine.
- Autonomous spec/requirement mutation.
- Automatic merge or deployment.
- A generic workflow designer.
- A second lifecycle state machine in Hermes.
- Treating AGE, ontology or memory synthesis as execution authority.
- Requiring the complete knowledge-projection roadmap before the first federated pilot.
