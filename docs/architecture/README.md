<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Architecture index

These documents describe Rorca's governed mission, execution, evidence, delivery, and operations boundaries. Documentation and pending specs do not themselves grant approval, execution, provider, merge, deployment, or production authority.

- [`adr/0001-governed-execution-authority.md`](adr/0001-governed-execution-authority.md) — accepted authority and runtime-federation decision
- [`adr/0002-storage-authority-and-relational-graph.md`](adr/0002-storage-authority-and-relational-graph.md) — proposed decision: relational authority retained, AGE replaced, DuckBrain deferred
- [`../storage-architecture-phased-program.md`](../storage-architecture-phased-program.md) — staged program for control-plane stabilization, AGE removal, and gated memory evaluation
- [`mission-control-plane.md`](mission-control-plane.md) — control-plane overview and program sequence
- [`hermes-rorca-boundary.md`](hermes-rorca-boundary.md) — optional Hermes operator/runtime identity boundary
- [`governed-hermes-operations.md`](governed-hermes-operations.md) — Doctor check/fix, health admission, quotas, status planes, idle suspension, resource sagas, provider-failure isolation, and clean-room certification
- [`runtime-conformance.md`](runtime-conformance.md) — common managed/federated conformance requirements
- [`story-execution-closeout-contracts.md`](story-execution-closeout-contracts.md) — host evidence and closeout boundary
- [`ssdlc-lifecycle.md`](ssdlc-lifecycle.md) — canonical lifecycle/evidence architecture
- [`provider-neutral-delivery.md`](provider-neutral-delivery.md) — local-first delivery adapter authority
- [`execution-authority-core.md`](execution-authority-core.md) — off-by-default provider-effect authority, evidence-gated rollout, recovery, retention, and forward-fix operations
- [`../contracts/README.md`](../contracts/README.md) — mission-control contract index
- [`../implementation/context-continuation-cross-wave-plan.md`](../implementation/context-continuation-cross-wave-plan.md) — current downstream wave plan and traceability
