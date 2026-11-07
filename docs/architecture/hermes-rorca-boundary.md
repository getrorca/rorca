<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Hermes and Rorca authority boundary

- **Status:** Draft architecture contract
- **Linear:** [ROR-30](https://linear.app/rorca/issue/ROR-30/establish-hermes-as-the-always-on-prompt-to-completion-operator)

Hermes may be the primary always-on operator interface for feature delivery. It is not Rorca's canonical datastore, lifecycle authority or required execution runtime.

```text
Human operator
      ↓
Hermes Operator Client
      ↓ canonical commands/observations
Rorca control and evaluation plane
      ↓ bounded work package/lease
Managed executor or Hermes/other federated runtime
```

## Hermes may

- capture and clarify human intent;
- invoke skill-first spec drafting and review;
- request approval and execution through canonical Rorca APIs;
- run cron, webhook and background reconciliation controllers;
- observe Rorca canonical state and report progress;
- select an eligible runtime/provider/model according to policy, capability, health, budget and rate limits;
- supervise leases, request bounded retry/replanning and escalate blockers;
- present evidence/lifecycle decisions and collect explicit human input;
- report completion only when the configured Rorca lifecycle boundary is satisfied.

## Hermes may not

- directly mark stories or lifecycle phases passed;
- weaken requirements, invariants or evidence obligations;
- expand allowed paths, delivery or operational authority;
- infer completion from CLI output;
- impersonate a human approval;
- grant itself merge/deploy authority;
- promote generated prose to durable knowledge without policy;
- embed Rorca database/projection logic or maintain competing canonical state.

## Separate identities

- **Hermes Operator Client:** requests and supervises work.
- **Hermes Runtime Adapter:** executes only within an explicit lease.
- **Human approver:** separately authenticated consent-bearing identity.

Possession of one identity never grants another role.

### Declared action authority

Every Hermes request declares an action (`intent`, `persist`, `subscription`, `watchdog`, or `dispatch`), an authority mode (`service-audit` or `operator-dispatch`), and the configured Hermes audit identity. Intent and subscription are service-audit operations. Persist, watchdog mutation, and dispatch require explicit operator-dispatch authority. The operator-dispatch principal is a scoped capability accepted only at the declared mutation or pipeline preflight/trigger boundary; it is not an admin role. Missing, mismatched, or fallback declarations fail closed, and both ordinary service identities and the scoped dispatch principal are denied at all other admin-tier routes.

The HTTP representation uses `X-Rorca-Hermes-Action`, `X-Rorca-Hermes-Authority-Mode`, and `X-Rorca-Hermes-Audit-Identity`. Rorca validates these fields before local single-user fallback. Audit actor identity therefore remains Hermes even when a permitted action consumes separately declared operator-equivalent authority.

## Provider and credential model

Hermes may choose between Pi, Claude Code, Codex, OpenCode, local models or future runtimes using API keys, OAuth or subscription-backed CLI authentication.

Selection is an auditable decision bound to mission/work-package/policy/capability revisions. Credential values remain in a vault and are represented only by opaque references. They never enter prompts, leases, event envelopes, terminal logs or evidence.

At minimum, a runtime capability records:

- runtime/adapter identity;
- provider/model and auth mode;
- health and supported capabilities;
- cost/concurrency/rate posture;
- policy tags and delivery limits;
- credential reference, never credential value.

## Context refresh and continuation

Hermes may observe a typed canonical trigger, request a context refresh, and deliver a Rorca-authorized continuation through the selected runtime adapter. Rorca remains authority for checkpoint scope, immutable policy definition, scope-bound activation/revocation, receipt, required bundle content, active lease verification, distributed retry budget, and one-use `ContinuationDispatch`. Deprecated epoch data is read-only compatibility output and never an adapter input.

For compaction, Hermes/controllers require a successful non-aborted end event with exact originating turn/generation, wait for the later matching `agent_settled`, and persist Pi retry-cycle start/end/settled identity. A controller-validated execution-turn completion candidate suppresses continuation and submits result/evidence proposals only; it is not canonical story closeout. Missing/ambiguous events use fenced timeout/restart recovery. Hermes cannot fill missing required context from memory, use a stale base except for Rorca-verified delta reconstruction, bypass full-bundle fallback, dispatch on stale lease/Git/cursor/policy activation, invent a replay key, or run a second writer.

Required-context failure blocks continuation. Advisory-memory outage may be explicit `degraded` only when the active policy activation permits it. Permanent authority/identity/secret/stale/replay conflicts do not retry; all actors spend one Rorca-owned budget and exhaustion quarantines. Retrieved memory remains advisory and cannot grant authority, prove completion, override the spec, or change lifecycle state. See [`../contracts/context-checkpoint-retrieval-and-continuation.md`](../contracts/context-checkpoint-retrieval-and-continuation.md).

The current Hermes Pi supervisor is a precursor: it observes compaction, retry start, settled, and durable cursor state, but it does not persist every required successful/non-aborted turn/retry identity or implement canonical refresh, policy activation verification, Rorca lease verification, and one-use dispatch. It is not conformance proof. Direct/raw tmux pane behavior is not the target supervised contract.

## Governed operational controllers

Hermes health, repair, provisioning, offboarding, and idle-loop controllers must implement the governed check/fix, typed dependency admission, quota/isolation, cost suspension, status-plane, saga, and clean-room requirements in [`governed-hermes-operations.md`](governed-hermes-operations.md). In particular:

- a check follows `detect → classify → propose → authority → bounded execute → verify → outcome → escalate`; observing a fault does not authorize repair;
- auto-fix is limited to explicitly classified rebuildable projections or fenced ephemeral runtime state; canonical mission/evidence/closeout/lifecycle state and destructive/external changes require separate authority;
- provider/runtime selection requires current typed capability and dependency-health snapshots plus workspace/runtime resource and provider-cost quota admission;
- supervisor and workers retain separate identities, credentials, budgets, circuits, and failure domains; conservative managed fallback requires a new exact attempt/fence and cannot widen authority;
- idle polling suspends under no-change/time/token/currency ceilings and resumes through event-driven wake plus full revalidation; and
- provider/runtime/Forgejo resources use an inventory-backed provisioning/offboarding saga and identity-preserving PATCH/update, never blind deletion or config rewrite.

These controllers project separate source/config drift, dependency, runtime, queue/outbox, lease/retry recovery, observability-freshness, and provider/operations readiness planes. None is mission, evidence, closeout, lifecycle, merge, deployment, or human authority.

## Background-controller rule

Hermes background processes reconcile; they do not maintain another workflow truth:

```text
observe Rorca canonical state
→ derive one desired request
→ issue an idempotent command
→ wait for authoritative result
```

Heartbeat proves liveness only. Repeated failure or ambiguity escalates rather than widening authority.

## Default completion

The default autonomous boundary is a merge-ready draft PR with current governed evidence. Merge and deployment remain separate explicit decisions.
