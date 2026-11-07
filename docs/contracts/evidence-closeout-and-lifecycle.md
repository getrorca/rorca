<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Evidence, closeout and lifecycle — runtime-neutral contract requirements

- **Status:** Draft extension of the accepted lifecycle/closeout contracts
- **Linear:** [ROR-23](https://linear.app/rorca/issue/ROR-23/define-mission-work-package-lease-evidence-and-lifecycle-contracts)
- **Existing contracts:** [`../architecture/story-execution-closeout-contracts.md`](../architecture/story-execution-closeout-contracts.md), [`../architecture/ssdlc-lifecycle.md`](../architecture/ssdlc-lifecycle.md)

The existing `StoryExecutionManifest`, `StoryAttemptResult` and `StoryCloseoutDecision` remain the foundation. Runtime federation strengthens rather than replaces their authority separation.

## Trust chain

```text
agent/runtime proposes completion
→ execution host observes facts
→ Rorca normalizes revision-bound evidence
→ StoryCloseoutDecision accepts or blocks local completion
→ lifecycle evaluator derives gate/phase state
→ configured human/policy authority records governed decisions
```

## Required invariants

- Attempt result and a controller-validated execution-turn completion candidate are proposals/observations, not `StoryCloseoutDecision.accepted`.
- Exit zero, heartbeat, terminal prose and runtime status cannot pass closeout.
- Evidence binds mission revision, work package, attempt, repository and exact subject revision.
- Wrong/stale revisions do not satisfy current obligations.
- Closeout decisions are immutable and explainable through stable reason codes and criterion/evidence mappings.
- Lifecycle evaluation remains a derived snapshot over current plan, evidence, decisions and release subject.
- QA, merge readiness, merge approval and production approval remain distinct.
- Runtime/operator identities cannot approve their own evidence unless an explicit policy grants a separately represented authority; human identity is never inferred.

## Reconciliation

Closeout reconciliation is an exact-run, idempotent correction protocol for already-observed outcomes. It must:

- require explicit authority and current immutable evidence;
- use preview identity/hash/expiry and revalidate before mutation;
- never discover or batch-select unrelated runs;
- never rerun passed stories;
- preserve prior diagnostics and append correction provenance;
- never activate ordinary execution, hook, memory, queue, provider, PR/check, merge, deployment or cleanup effects;
- remain application-authoritative when pg-boss transport is lost or retried.

## Knowledge boundary

Only accepted validated evidence may feed candidate knowledge. Candidate memory/fact/relation/ontology changes are not retrieval-visible truth until their distinct promotion/governance policy succeeds. Even approved memory remains advisory when included in a [`ContextBundle`](context-checkpoint-retrieval-and-continuation.md): retrieval cannot turn it into lease, evidence, completion, approval, or lifecycle authority.
