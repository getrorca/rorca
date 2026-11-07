<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Context continuation cross-wave implementation plan

- **Status:** Draft downstream plan; no execution authority
- **Canonical contract:** [`../contracts/context-checkpoint-retrieval-and-continuation.md`](../contracts/context-checkpoint-retrieval-and-continuation.md)
- **Sequence:** Wave 1 → Wave 2 → Wave 3A and 3B (only allowed overlap) → integrated Wave 3 review → Wave 4

## Scope and non-claim

This plan adds no Wave 1 implementation work. Wave 1 remains the unchanged
stabilization/authority prerequisite. The current Hermes supervisor precursor is
discovery input, not conformance proof: it observes compaction/retry/cursor state,
but the canonical Rorca retrieval and lease-verified continuation boundary is
not implemented.

Raw tmux pane output is not the target supervised contract. Terminal/activity
output remains observability and cannot establish context validity, execution
authority, evidence, completion, or lifecycle state.

The cross-wave operational extension is [`../architecture/governed-hermes-operations.md`](../architecture/governed-hermes-operations.md). It adds typed dependency admission, workspace/runtime quotas, provider failure isolation, isolated status planes, governed check/fix, idle suspension, inventory-backed provisioning/offboarding, fault isolation, and clean-room reconstruction. It preserves PostgreSQL/Git/host authority and advisory memory and grants no provider, merge, deployment, approval, or execution authority.

## Delivery sequence

| Stage | Owner/outcome | Entry gate | Exit gate |
| --- | --- | --- | --- |
| Wave 1 | Existing closeout/evidence/branch-only stabilization; no context-continuation scope change | Existing Wave 1 spec | Existing independently reviewed exact-SHA packet |
| Wave 2 | Publish policy-definition/activation, checkpoint/receipt/bundle/delta/dispatch contracts, persistence, services, compatibility projection, state machines, retry budget, and shared fixtures | Exact Wave 1 + accepted ADR gate | Local DB-backed contract suite and independent architecture/security review |
| Wave 3A | Implement `RorcaManagedExecutor` adapters, typed capability/dependency admission, workspace/runtime quotas, supervisor/worker provider-failure isolation, conservative managed fallback, and Pi RPC managed continuation using only canonical identities | Exact Wave 2 packet | Managed admission/resource/failure-domain and continuation conformance, crash/fence/exactly-once proof, independent review |
| Wave 3B | Implement runtime-neutral turn/compaction/retry/completion-candidate events, isolated/redacted per-workspace observability, seven distinct operational status planes, projections, replay, retention, and Run View states | Exact Wave 2 packet | Stream/status-plane isolation, redaction/replay/browser proof, independent review |
| Wave 3 integration | Serialize shared public-contract/generated files; prove compatible 3A/3B packet | Both separate Wave 3 reviews | One integrated exact-SHA compatibility packet |
| Wave 4 | Implement one federated Hermes/runtime pilot plus governed check/fix, idle-cost suspension, provisioning/offboarding saga, noisy-neighbor/resource fault injection, clean-room reconstruction, and the same normative adversarial matrix with lane-specific transport/trust adapters | Wave 2 + integrated Wave 3 packet | One bounded pilot, equivalent assertions, independently reviewable reconstruction/operations packet, merge-ready draft PR evidence only |

Wave 3A and Wave 3B may overlap only in separate worktrees and ownership zones.
Shared schema/generated integration is serialized. Wave 4 is sequential.

## Requirement traceability

| ID | Observable requirement | Canonical contract section | Wave 2 | Wave 3A | Wave 3B | Wave 4 proof |
| --- | --- | --- | --- | --- | --- | --- |
| CCTX-001 | Required execution context is structurally distinct from advisory memory; memory cannot grant authority or completion | Context classes; Authority | W2-005, W2-012 | W3A-003, W3A-006 | W3B-002 | W4-004, W4-009 |
| CCTX-002 | Versioned checkpoint, immutable policy definition, scope activation, receipt, bundle/delta, and dispatch schemas/state transitions exist | Versioned contracts | W2-005 | W3A-002, W3A-006 | W3B-002 | W4-003, W4-009 |
| CCTX-003 | Deprecated epoch is an exact read-only projection; every write rejects; two-minor/90-day window and next-major removal gate are executable | Deprecated projection | W2-005, W2-010, W2-011, W2-012 | W3A-002–W3A-006 | W3B-002, W3B-005 | W4-003–W4-005, W4-010 |
| CCTX-004 | Definition/version/hash/lifecycle is immutable and separate from scope activation/reference; revocation stales unused artifacts | Policy definition/activation | W2-005 | W3A-006 | W3B-002 | W4-008, W4-009 |
| CCTX-005 | All nine triggers have typed, material identities including repository/base/worktree/spec/story/path/validation/root-cause/retry facts | Trigger material; Idempotency | W2-005 | W3A-006, W3A-008 | W3B-002 | W4-008, W4-009 |
| CCTX-006 | Changed replay conflicts are permanent/audited and fixtures cover every common/trigger-specific dimension | Idempotency | W2-005, W2-006 | W3A-005, W3A-006 | W3B-002, W3B-003 | W4-005, W4-009 |
| CCTX-007 | Required-first budgets, dedupe, delta reconstruction and verified stale-base exception/full fallback are deterministic | Bundle/Delta | W2-005 | W3A-006 | W3B-002, W3B-007 | W4-008, W4-009 |
| CCTX-008 | Secrets/authority payloads are forbidden; restricted data is redacted/opaque; wrong-workspace/stale context rejects | Retrieval/redaction/secrets | W2-005, W2-006, W2-012 | W3A-004, W3A-006 | W3B-002, W3B-007 | W4-002, W4-004, W4-009 |
| CCTX-009 | Required failure blocks; advisory outage degrades only when activated policy permits; one DB retry budget prevents storms | Failure/retry/quarantine | W2-005, W2-012 | W3A-006, W3A-008 | W3B-002, W3B-008 | W4-008, W4-009 |
| CCTX-010 | Rorca verifies lease/fence immediately before authorization and dispatch CAS | Lease verification | W2-004, W2-005 | W3A-005, W3A-006 | W3B-002 | W4-003, W4-008, W4-009 |
| CCTX-011 | Compaction is successful/non-aborted, turn/generation-bound, matched to settled, and Pi retry phases suppress duplicate continuation | Trigger/turn decision | W2-005, W2-006 | W3A-006 | W3B-002 | W4-008, W4-009 |
| CCTX-012 | Execution-turn completion candidate is distinct from canonical closeout; controller validation submits proposals only | Trigger/turn decision; Authority | W2-006, W2-008 | W3A-006, W3A-009 | W3B-002, W3B-008 | W4-006, W4-009, W4-010 |
| CCTX-013 | Events carry exact turn/generation/settled/retry phase and canonical refs without raw prompts, transcripts, secrets, or attestations | Structured telemetry | W2-006 | W3A-006 | W3B-002, W3B-003 | W4-005, W4-009 |
| CCTX-014 | Crash/replay/stale/outage tests prove one writer/process/prompt, bounded quarantine, and no authority widening | Minimum conformance | W2-012 | W3A-006, W3A-008, W3A-009 | W3B-009 | W4-008, W4-009 |
| OPS-001 | Required typed dependency/capability health and workspace/runtime quotas gate admission; supervisor/worker provider failure domains and managed fallback remain separate | Governed Hermes operations: admission, quotas, provider isolation | — | W3A-003–W3A-005, W3A-009 | W3B-008, W3B-009 | W4-009, W4-013 |
| OPS-002 | Observability is redacted and isolated per workspace/runtime and projects seven distinct operational status planes | Governed Hermes operations: isolation and status planes | — | W3A-005 | W3B-003, W3B-007–W3B-009 | W4-009, W4-013 |
| OPS-003 | Doctor fixes use preview/authority/bounds/verification/compensation/audit; idle loops suspend and wake by authenticated event | Governed Hermes operations: Doctor and idle circuit | — | — | W3B-008 | W4-011, W4-012 |
| OPS-004 | Provider/runtime/Forgejo resources use exact inventory, identity-preserving update, staged provisioning/offboarding, and separately authorized cleanup | Governed Hermes operations: resource saga | — | — | W3B-008 | W4-013 |
| OPS-005 | Noisy-neighbor faults are scope-contained and clean-room reconstruction proves no hidden host/runtime-memory prerequisite | Governed Hermes operations: quotas and reconstruction | — | W3A-005, W3A-009 | W3B-009 | W4-014 |

## Adapter boundaries

Wave 3A publishes interfaces with fake implementations used by the shared suite:

- `ContextCheckpointStore.persist/loadCurrent`
- `CanonicalContextClient.retrieve/reconcileReceipt`
- `PolicyActivationVerifier.verifyActive`
- `LeaseVerifier.verifyForContinuation`
- `ContinuationAuthorizer.authorize/reconcile`
- `PiRpcContinuationAdapter.getState/getEntries/prompt/waitForSettled/abort`
- `ContinuationEventSink.append`
- `ContinuationRetryBudget.acquire/record/quarantine`
- `ContinuationClock`

The managed controller is the only prompt writer. An event consumer, tmux pane,
worker retry, or memory client cannot call Pi RPC directly. No adapter method
accepts a deprecated epoch input.

## Shared fixture inventory

Wave 2 publishes immutable fixture IDs consumed unchanged at the assertion level
by Wave 3A and Wave 4. Lane adapters may differ only in transport and declared
trust source; expected authority outcomes do not differ.

- `CTX-ID-*`: changed replay for repository, base/current SHA, worktree, spec,
  story/criteria, path manifests, validation/root cause, policy definition/
  activation, and every trigger-specific field.
- `CTX-CMP-*`: successful/non-aborted compaction; aborted/failed compaction;
  wrong-turn/wrong-generation settled; retry start/end/settled; completion
  candidate observed/rejected/validated/submitted.
- `CTX-DLT-*`: permitted stale cursor/Git/validation/generation reconstruction;
  forbidden spec/lease/session/policy/repository/worktree/base/path differences;
  corrupt/missing base and chain overflow full-bundle fallback.
- `CTX-RETRY-*`: distributed duplicate attempts, permanent conflicts, expiry,
  one in-flight retry, aggregate budget exhaustion, and quarantine.
- `CTX-SEC-*`: secret values, attestation/signature payloads, credentials,
  restricted references, logs/errors, and wrong-workspace memory.
- `CTX-EPOCH-*`: exact projection mapping/read authorization, every write surface
  rejected before mutation, unmappable history, usage telemetry, and executable
  compatibility-removal gate.
- `CTX-AUTH-*`: continuation/terminal/candidate records cannot establish evidence,
  closeout, lifecycle, approval, Check, merge, or deployment state.

## Coverage ledger policy

[`governed-mission-waves-coverage.json`](governed-mission-waves-coverage.json) is a current-path implementation ledger,
not a historical snapshot. Any pending spec edit regenerates its spec hash,
story/criterion text, and criterion count while preserving honest implementation
status. Wave 2, 3A, 3B, and 4 entries remain `gated` with empty code/test/evidence
arrays until their prerequisite and implementation packets actually exist. The
ledger never treats spec authorship as implementation evidence.

## Required local proof packets

Each downstream wave records exact source SHA, contract/spec hashes, tool
versions, commands/results, fixture IDs, database identity/owner in redacted
form, unresolved limitations, and independent review findings. Proof recipes
must run locally and may not rely on CI as the only validation path.

No packet in this plan approves a spec, triggers a run, merges, deploys, mutates a
live provider, or promotes memory. All edited specs remain under
`forge/specs/pending/` with stale authoring preflight, `approvalReady=false`, and
`executionAuthority=none` until fresh canonical preflight and review.
