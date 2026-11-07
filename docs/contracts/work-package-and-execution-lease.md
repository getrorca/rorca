<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# WorkPackage and ExecutionLease — draft contract requirements

- **Status:** Design input; not yet an implemented wire schema
- **Linear:** [ROR-23](https://linear.app/rorca/issue/ROR-23/define-mission-work-package-lease-evidence-and-lifecycle-contracts)

## WorkPackage

A `WorkPackage` is an independently verifiable delivery slice under one mission revision. It may map to one or more stable stories, but it does not redefine their requirements.

It binds:

- mission and requirement/story identities;
- objective and acceptance/evidence obligations;
- repository/base revision and allowed path scope;
- risk and capability requirements;
- dependency and rollback/review boundaries;
- delivery and knowledge authority ceilings;
- resource/time/retry limits;
- current plan revision.

Runtime-local tasks beneath a work package may be created, reordered and replaced autonomously. A change to the package boundary requires a `PlanChangeProposal`; a change to mission intent requires amendment.

## ExecutionLease

An `ExecutionLease` authorizes one runtime attempt for a bounded period and scope. It is not evidence or completion authority.

An eventual schema must bind at least:

```text
leaseId
attemptId
workspaceId
missionId/missionRevision/missionHash
workPackageId/workPackageRevision
runtimeId/runtimeCapabilityRevision
repositoryId
baseSha
expectedBranch/worktree identity
allowedPaths
fencingToken
issuedAt/expiresAt
cancellation identity
resource/retry limits
deliveryAuthority
operationalAuthority
knowledgeAuthority
interactiveInputAuthority
policy/permission profile hashes
contextContinuationPolicyDefinition ID/version/hash
contextContinuationPolicyActivation ID/revision/hash
contextCheckpoint ID/hash
retrievalReceipt ID/hash
contextBundle ID/version/hash or verified delta/base references
continuationDispatch scope/expiry (when continuation is authorized)
evidence-obligation digest
```

## Safety semantics

- Only the current fencing token may mutate governed work.
- Renewal is a Rorca decision and cannot broaden scope or authority.
- Expiry/cancellation prevents further governed mutation even if a process continues locally.
- Replacement attempts receive a new attempt identity and fencing token.
- Duplicate/late events remain append-only observations and cannot revive a lease.
- Branch names are not revision identity; exact SHAs are required at evidence/closeout boundaries.
- Delivery, operational, knowledge and interactive authority are independent capabilities.
- A checkpoint, policy activation, receipt, bundle/delta, dispatch, or deprecated epoch read projection is not a lease and cannot extend, replace or broaden one.
- Leases reference immutable policy definition plus scope-bound activation identities; policy revocation/supersession stales unused continuation artifacts but does not rewrite lease history.
- Rorca verifies the exact active lease/fence, turn/generation, session/cursor, repository/base/current SHA, worktree/path scope, policy definition/activation, checkpoint/receipt, and bundle hashes before authorization and again in dispatch compare-and-set.
- Required canonical-context failure blocks continuation. Advisory-memory outage may degrade only when the active policy activation allows it and remains explicit in receipt, bundle, and event projection.
- Deprecated `ContextEpoch` is accepted only as a server-generated compatibility read projection. Every lease/acquire/renew/release or other write containing it fails before mutation.

The complete checkpoint/retrieval/continuation identity and state machines are in [`context-checkpoint-retrieval-and-continuation.md`](context-checkpoint-retrieval-and-continuation.md).
