<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Mission control plane contract index

These documents capture architecture requirements for [ROR-23](https://linear.app/rorca/issue/ROR-23/define-mission-work-package-lease-evidence-and-lifecycle-contracts). The canonical v1 wire schemas are now generated from `backend/src/lib/governed-contracts` into `packages/rorca-public-contract/schemas/governed-execution`; PostgreSQL/services remain the authority boundary described in the implementation note below. These documents do not themselves grant approval, closeout, execution, merge, or deployment authority.

- [`mission-contract.md`](mission-contract.md)
- [`work-package-and-execution-lease.md`](work-package-and-execution-lease.md)
- [`context-checkpoint-retrieval-and-continuation.md`](context-checkpoint-retrieval-and-continuation.md)
- [`execution-events-and-live-output.md`](execution-events-and-live-output.md)
- [`evidence-closeout-and-lifecycle.md`](evidence-closeout-and-lifecycle.md)
- [`ssdlc-interoperability.md`](ssdlc-interoperability.md)

Canonical existing execution/closeout contracts remain documented in [`../architecture/story-execution-closeout-contracts.md`](../architecture/story-execution-closeout-contracts.md). Governed operational controllers, dependency admission, quotas, status-plane isolation, resource sagas, and reconstruction requirements are indexed in [`../architecture/governed-hermes-operations.md`](../architecture/governed-hermes-operations.md); they do not change the contract authority boundary.

Implementation, route, threat-model, compatibility, and local validation details: [`../implementation/wave2-governed-mission-control-plane.md`](../implementation/wave2-governed-mission-control-plane.md).
