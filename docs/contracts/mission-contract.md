<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# MissionContract — draft contract requirements

- **Status:** Design input; not yet an implemented wire schema
- **Linear:** [ROR-23](https://linear.app/rorca/issue/ROR-23/define-mission-work-package-lease-evidence-and-lifecycle-contracts)

`MissionContract` is an immutable compiled projection of canonical inputs. It must not become a parallel authoring or requirements source.

## Canonical inputs

- workspace and canonical spec identity/version/hash;
- stable requirement and acceptance-criterion identities;
- objectives, invariants, constraints and prohibited outcomes;
- evidence obligations and completion definition;
- risk classification and permission boundaries;
- policy/compiler versions and hashes;
- configured human gates and approval references;
- repository identities and allowed delivery boundaries;
- direction-layer, immutable context-continuation policy-definition, permitted activation authority, and required-context source identities/hashes that downstream activations/bundles must preserve.

The compiler preserves source references and produces a canonical mission revision/hash. The compiled contract is immutable.

## Amendment semantics

- Runtime-local tasks are not mission inputs.
- Work-package changes cannot mutate mission requirements.
- Requirement, invariant, evidence, risk or authority changes create a new canonical spec/policy input and mission revision.
- Evidence and approvals declare the mission revision they address.
- An amendment stales affected evidence/approvals; unaffected reuse requires an explicit deterministic compatibility decision, never inference from prose.

## Minimum identity

An eventual wire schema must bind at least:

```text
schemaVersion
workspaceId
missionId
missionRevision
missionHash
sourceSpecId/sourceSpecVersion/sourceSpecHash
policyVersion/policyHash
contextContinuationPolicyDefinitionId/version/hash
compilerVersion
requirements[]
evidenceObligations[]
riskAndPermissionProfile
completionDefinition
createdAt
```

Runtime checkpoints, scope-bound policy activations, and retrieved bundles reference this immutable mission identity; they do not amend it. If a required mission/spec/story/criterion/direction/policy-definition or activation hash changes, the prior bundle and any unused continuation authorization become stale. Deprecated epoch projections cannot compile or amend a mission. See [`context-checkpoint-retrieval-and-continuation.md`](context-checkpoint-retrieval-and-continuation.md).

Exact field types and schema versioning belong to the implementation spec, not this architecture note.
