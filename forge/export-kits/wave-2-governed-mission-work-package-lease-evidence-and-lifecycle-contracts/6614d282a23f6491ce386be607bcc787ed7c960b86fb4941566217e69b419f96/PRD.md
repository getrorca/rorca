# Wave 2 — Governed Mission, Work Package, Lease, Evidence and Lifecycle Contracts — Product Requirements

## Problem
Deliver the behavior defined by the canonical Wave 2 — Governed Mission, Work Package, Lease, Evidence and Lifecycle Contracts specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- W2-001 — Fail closed on the exact ROR-24 ADR and Wave 1 gates
- W2-002 — Publish versioned MissionContract primitives and compatibility rules
- W2-003 — Persist stable missions and revisioned mutable work packages
- W2-004 — Issue fenced execution leases bound to runtime and repository identity
- W2-005 — Publish canonical policy, checkpoint, retrieval, bundle, and continuation contracts
- W2-006 — Normalize runtime-neutral execution and context-continuation events
- W2-007 — Persist host-observed evidence envelopes with explicit trust
- W2-008 — Resolve closeout and lifecycle decisions from canonical evidence
- W2-009 — Govern cancellation acknowledgements and plan-change proposals
- W2-010 — Expose authorized idempotent service APIs and audit trails
- W2-011 — Preserve current executor behavior behind compatibility projections
- W2-012 — Pass threat-model, conformance, recovery, and independent review gates

## In scope
- Create a gate-only intake verifier for ROR-23. It must resolve the exact accepted ROR-24 ADR artifact and immutable authority identity, plus the independently reviewed Wave 1 completion packet, before migrations, contract publication, dispatch, or implementation work begins.
- Define MissionContract and shared identifiers in packages/rorca-public-contract with JSON Schema/OpenAPI projections. A MissionContract is an immutable compilation of canonical spec revision, policy versions, approved decisions, repository authority, and allowed execution posture; PostgreSQL is canonical and Git is code truth.
- Add numbered PostgreSQL migrations and repositories for immutable mission contract versions and mutable, revisioned work packages under stable mission authority. Work-package changes are proposals with optimistic concurrency, not silent mission mutation.
- Define canonical execution-lease acquisition, renewal, expiry, release, and supersession. Leases authorize bounded execution only for one mission/work-package revision, runtime/repository identity, and exact canonical continuation references; they grant no approval, closeout, merge, or deployment authority.
- Publish the canonical context-continuation family without a second mutable context authority. Rorca owns immutable policy definitions, scope activations/revocation, checkpoints, receipts, bundle/delta verification, lease verification, retry budget, and one-use dispatch; Hermes orchestrates and memory remains advisory.
- Define one versioned runtime-neutral envelope for attempt/activity and canonical continuation projections. Events carry immutable canonical references and exact turn/compaction/retry/completion-candidate facts while raw PTY remains separate observability.
- Define evidence envelopes that distinguish host-observed facts, runtime assertions, provider-verified facts, automated test results, and human decisions. Evidence is append-only and exact-subject-bound; only policy-authorized evidence kinds may contribute to closeout.
- Compile eligible exact-subject evidence into a proposed attempt/work-package closeout, then apply existing SSDLC lifecycle policies and provider-human decisions without transferring their authority to runtimes. Process exit and transport completion remain observations only.
- Add contracts for durable cancellation request/acknowledgement and runtime plan-change proposals. A runtime may acknowledge cancellation or propose bounded changes but cannot mutate canonical scope, dependencies, revisions, approvals, or lifecycle state.
- Add route/service/repository APIs for mission compilation/read, work-package revisions, leases, policy definitions/activations, checkpoints/receipts/bundles/deltas/dispatch/retry budgets, events/evidence, cancellation, proposals, and closeout. Every route validates tenant/workspace/runtime/human authority and emits bounded immutable audit records.
- Introduce adapters that project current pipeline-run/story/attempt data into the new contracts without changing execution-engine semantics. Generate MCP as an optional projection of canonical HTTP/service contracts; it is not the federation protocol or authority source.
- Deliver a reusable DB-backed contract conformance suite, security threat model, operational/recovery runbook, migration compatibility matrix, and independent review packet before Wave 2 can gate Wave 3 work.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### W2-001
Create a gate-only intake verifier for ROR-23. It must resolve the exact accepted ROR-24 ADR artifact and immutable authority identity, plus the independently reviewed Wave 1 completion packet, before migrations, contract publication, dispatch, or implementation work begins.

**Acceptance criteria**
- The gate binds the canonical Linear workspace/team, ROR-24 issue identity, accepted ADR version/content hash, acceptance state, approval authority, updated-at/version marker, and evidence snapshot; a title, issue number, label, or mutable status alone is insufficient.
- ROR-24 is schema-forbidden as dispatch work and can appear only as a prerequisite gate; no adapter may create a run, work package, branch, or provider mutation for it.
- The Wave 1 prerequisite binds its exact spec revision, implementation Git SHA, independent review packet, validation receipt, and provider-neutral immutable local-review-bundle proof result and independent review.
- Missing, stale, ambiguous, changed, revoked, cross-workspace, or self-asserted ROR-24/Wave 1 evidence returns a stable blocked reason before any migration or execution side effect.
- Fixtures cover accepted, pending, changed-after-observation, duplicate, wrong-team, wrong-SHA, and unavailable gate states without using memory as authority.

### W2-002
Define MissionContract and shared identifiers in packages/rorca-public-contract with JSON Schema/OpenAPI projections. A MissionContract is an immutable compilation of canonical spec revision, policy versions, approved decisions, repository authority, and allowed execution posture; PostgreSQL is canonical and Git is code truth.

**Acceptance criteria**
- MissionContract v1 has stable mission ID, contract version/hash, workspace, canonical spec ID/version/hash/path, repository and exact base revision, policy identities, approval/decision references, allowed execution posture, and creation provenance.
- Contract hashes are canonical and deterministic; unknown authority fields, duplicate identifiers, relative/short SHAs, and unversioned payloads are rejected.
- Compatibility rules define additive minor evolution, explicit major-version negotiation, read-old/write-current behavior, and fail-closed handling of unsupported versions.
- Generated JSON Schema, OpenAPI, TypeScript exports, break markers, examples, and contract stability checks are reproducible from one source definition.
- Mission compilation never treats MCP fields, memory, PTY output, runtime claims, or process exit as approval or lifecycle authority.

### W2-003
Add numbered PostgreSQL migrations and repositories for immutable mission contract versions and mutable, revisioned work packages under stable mission authority. Work-package changes are proposals with optimistic concurrency, not silent mission mutation.

**Acceptance criteria**
- Migrations create tenant/workspace-scoped mission, mission-version, work-package, and work-package-revision tables with foreign keys, unique identities, append-only hashes, revision CAS, timestamps from PostgreSQL, and least-privilege/RLS treatment consistent with current core tables.
- A work package binds mission contract version, story/scope, ordered dependencies, allowed file/mutation paths, exact repository revision, validation requirements, execution posture, and current lifecycle state.
- Changing scope, dependencies, target revision, validation, or authority creates a new revision/proposal; active leases remain bound to their original immutable revision.
- Concurrent update, stale revision, deleted dependency, cross-mission reference, and migration rollback/upgrade paths fail deterministically without partial state.
- Migration contract and local PostgreSQL integration tests run under the dedicated non-superuser test owner.

### W2-004
Define canonical execution-lease acquisition, renewal, expiry, release, and supersession. Leases authorize bounded execution only for one mission/work-package revision, runtime/repository identity, and exact canonical continuation references; they grant no approval, closeout, merge, or deployment authority.

**Acceptance criteria**
- Lease v1 includes opaque lease ID, monotonic fence, mission/work-package/spec/story revision, runtime identity, repository/base/current SHA and worktree/path scope, active policy-definition/activation plus current checkpoint/bundle references, database times, mutation bounds, and state; deprecated epoch is not a lease field.
- PostgreSQL atomically prevents two active leases for the same execution identity and rejects stale fence renewals, late results, replayed releases, runtime substitution, and revision drift.
- Expiry, cancellation, or policy-activation revocation makes the old generation and every unused receipt/bundle/dispatch ineligible even if a process continues running.
- Queue delivery, worker PIDs, compatibility projections, and continuation artifacts are transport/provenance only and cannot issue or extend a lease.
- DB-backed race tests cover duplicate acquire, renew-versus-expire, cancellation-versus-result, policy revocation, worker crash, clock skew, stale fence, and takeover.

### W2-005
Publish the canonical context-continuation family without a second mutable context authority. Rorca owns immutable policy definitions, scope activations/revocation, checkpoints, receipts, bundle/delta verification, lease verification, retry budget, and one-use dispatch; Hermes orchestrates and memory remains advisory.

**Acceptance criteria**
- Public schemas and PostgreSQL/service state transitions exist for policy-definition v1, scope-bound policy-activation v1, checkpoint v1, retrieval-receipt v1, context-bundle/delta v1, continuation-dispatch v1, and retry-budget/quarantine records with deterministic IDs/hashes, provenance, and rejection states.
- A policy definition has immutable version/body/hash and append-only validated/published/superseded/revoked authority lifecycle, carries no cursor/Git scope, and is bound by one separately revisioned activation to exact scope/effective values; revocation stales every affected unused artifact.
- The deprecated epoch surface is only an exact server-generated read projection over checkpoint, policy definition+activation, receipt, bundle, and optional dispatch identities; all writes reject before mutation, compatibility lasts two minor releases and at least 90 days, and removal is next-major gated by zero-use telemetry, client migration, fixtures, break markers, and independent review.
- ContextBundle structurally separates exact requiredContext from provenance/freshness-bound advisoryMemory; memory cannot grant authority, override spec/policy, satisfy evidence, prove completion, or promote lifecycle state.
- Typed triggers cover initial dispatch, successful non-aborted compaction, generation restart, story/wave transition, material file scope, validation/root-cause change, meaningful retry, TTL/source staleness, and missing context with exact trigger material.
- Every key binds repository ID/base/current SHA/worktree, spec/story/criteria hashes, path manifests, validation/root-cause, definition/activation, turn/generation/session/cursor, retry/completion-candidate phase, and trigger material; identical replay returns the record while changed replay is permanent/audited and never bypassed by a nonce.
- Policy budgets reserve required context first, reject required oversize without criterion truncation, dedupe only same-class stable sources, and cap delta chains.
- A stale base is readable only for verified reconstruction with exact stable scope and permitted cursor, descendant-Git, validation, or fenced restart differences; every forbidden/ambiguous difference, corrupt/missing base, or hash mismatch requires a newly assembled full bundle.
- Compaction eligibility requires status success, aborted=false, willRetry=false, exact originating turn/generation, later matching agent_settled, Pi retry phase none/settled/fenced, and explicit execution-turn completion-candidate state; controller validation submits proposals only and is not canonical closeout.
- Server-owned workspace, sensitivity, redaction, secret-reference, version, Git/worktree/path, lease, turn/generation, session/cursor, receipt/bundle/delta, and definition/activation checks reject stale, tampered, secret-bearing, unsupported, or wrong-workspace input without old-context fallback.
- Required context or lease verification failure blocks; permitted advisory outage is explicit degraded; one PostgreSQL retry budget spans all actors, permanent conflicts do not retry, exhaustion quarantines, and dispatch is an expiring one-use compare-and-set after double lease verification.
- CI-independent schema/PostgreSQL/render/redaction/replay/budget/delta/stale/outage/state fixtures prove projection-write rejection, every changed-replay dimension, stale-base fallback, aborted/mismatched compaction, retry phases, secret/authority isolation, no retry storm, and no completion authority.

### W2-006
Define one versioned runtime-neutral envelope for attempt/activity and canonical continuation projections. Events carry immutable canonical references and exact turn/compaction/retry/completion-candidate facts while raw PTY remains separate observability.

**Acceptance criteria**
- The envelope binds event/idempotency/schema identity; workspace/mission/work-package/spec/story/run/attempt/lease/fence; policy definition/activation, checkpoint/receipt/bundle/dispatch; repository/base/current SHA/worktree/path manifests; validation/root-cause; runtime/controller/originating turn/generation; session/cursor; times/sequence/trust/payload hash/redaction and optional restricted reference.
- The registry includes compaction started/ended, agent_settled observed, Pi auto-retry started/ended/settled, execution completion-candidate observed/validated/rejected/submitted, checkpoint/retrieval/continuation/cursor/stale/rejected/quarantined types plus attempt, validation, cancellation, result, closeout, recovery, and liveness.
- Compaction ended requires success/aborted/willRetry/result identity; settled and retry events require exact turn/generation/session/retry-cycle phase and state-order links, so aborted/failed/unmatched events cannot make continuation eligible.
- Execution completion-candidate validation terminalizes only an execution turn and submits result/evidence proposals; only canonical StoryCloseoutDecision.accepted can establish story completion or lifecycle input.
- Ordering distinguishes per-generation runtime sequence, canonical state order, and host receipt order; identical duplicates are idempotent while gaps, changed replay, regression, and stale generation are explicit permanent conflicts.
- Payloads contain bounded canonical IDs/hashes/reasons/counts/timing only; raw prompts/transcripts, credentials, secret values, human attestations/signatures, unrestricted context, and deprecated epoch writes are schema-forbidden.
- Events, terminal bytes, retrieval output, advisory memory, prompts, agent claims, process exit, and completion candidates cannot mutate canonical verification, evidence, closeout, lifecycle, approval, Check, merge, or deployment state.
- Managed/federated-shaped fixtures validate every type and state violation, changed replay dimension, retry phase, aborted/mismatched compaction, secret/authority boundary, version negotiation, quarantine, and side-effect isolation locally.

### W2-007
Define evidence envelopes that distinguish host-observed facts, runtime assertions, provider-verified facts, automated test results, and human decisions. Evidence is append-only and exact-subject-bound; only policy-authorized evidence kinds may contribute to closeout.

**Acceptance criteria**
- Evidence v1 binds immutable evidence ID/hash, kind, trust, observer, subject lineage, mission/work-package/attempt/lease/policy-activation/checkpoint/repository revision, observed/received times, status, payload hash, and restricted raw reference.
- Host-observed process/worktree/Git facts, provider-verified GitHub facts, runtime claims, and human decisions use separate non-escalating trust classes.
- Idempotent replay returns the existing evidence; same identity with changed payload, stale fence, wrong revision, or cross-workspace subject is rejected and audited.
- Redacted reads expose enough provenance for independent review while secrets and restricted raw payloads remain inaccessible.
- Threat-focused tests prove a runtime, terminal stream, MCP client, memory entry, or caller cannot forge host/provider/human trust.

### W2-008
Compile eligible exact-subject evidence into a proposed attempt/work-package closeout, then apply existing SSDLC lifecycle policies and provider-human decisions without transferring their authority to runtimes. Process exit and transport completion remain observations only.

**Acceptance criteria**
- Closeout records exact input evidence IDs/hashes, policy/version, computed outcome, missing/conflicting evidence, resolver version, decision time, and immutable subject lineage.
- Passed requires complete policy-eligible evidence for the exact mission/work-package/spec/story revision, lease fence, active policy activation, checkpoint/attempt and Git/worktree subject; exit zero, continuation settlement, or controller-validated execution-turn completion candidate alone is insufficient.
- Failed, cancelled, expired, conflicted, stale, and reconciliation-required outcomes are explicit, idempotent, and cannot be overwritten by late runtime events.
- Existing SSDLC gate/disposition/approval authority remains provider-human and receipt-bound; no new contract grants waiver, retry, merge, or production authority.
- Golden and adversarial DB tests cover complete pass, missing evidence, conflicting trust, late result, cancellation race, stale revision, policy change, and replay.

### W2-009
Add contracts for durable cancellation request/acknowledgement and runtime plan-change proposals. A runtime may acknowledge cancellation or propose bounded changes but cannot mutate canonical scope, dependencies, revisions, approvals, or lifecycle state.

**Acceptance criteria**
- Cancellation binds requester authority, reason, target attempt/lease fence, requested time/deadline, acknowledgement identity/time, and terminal disposition.
- Late, wrong-runtime, wrong-fence, duplicated, and contradictory acknowledgements are preserved as non-authoritative conflicts and do not revive execution.
- Plan-change proposals bind base work-package revision, proposed diff/hash, rationale, impact, requested paths/dependencies/validation, and proposer runtime; they create no mutation until separately authorized and revisioned.
- Scope expansion, forbidden paths, new merge/deploy authority, revision drift, and proposal replay are rejected before review publication.
- Tests cover graceful cancellation, forced expiry, lost runtime, competing acknowledgements, accepted/rejected/stale proposals, and restart recovery.

### W2-010
Add route/service/repository APIs for mission compilation/read, work-package revisions, leases, policy definitions/activations, checkpoints/receipts/bundles/deltas/dispatch/retry budgets, events/evidence, cancellation, proposals, and closeout. Every route validates tenant/workspace/runtime/human authority and emits bounded immutable audit records.

**Acceptance criteria**
- OpenAPI routes use strict boundary validation, AppError subclasses, explicit x-rorca-tier/rationale, pagination/limits, request IDs, and idempotency keys where mutations are allowed.
- Runtime credentials can access only leased subjects and permitted operations; operator/human decisions retain existing stronger signed authority and one-use/expiry semantics.
- Audit records bind actor, authority source, request hash, subject, decision, evidence references, result, database time, and correlation without secrets.
- Rate, body, sequence, retention, query, and aggregate retry bounds prevent unbounded ingestion/replay; epoch and secret/authority-payload writes reject before mutation; partial failures are transactional or explicitly quarantined.
- Route and repository tests cover unauthorized, cross-workspace, stale-token, replay, conflict, malformed-version, pagination, and recovery paths on a local test DB.

### W2-011
Introduce adapters that project current pipeline-run/story/attempt data into the new contracts without changing execution-engine semantics. Generate MCP as an optional projection of canonical HTTP/service contracts; it is not the federation protocol or authority source.

**Acceptance criteria**
- Current sequential branch-only runs continue through the existing execution engine while compatibility code emits contract-conformant identities/events/evidence behind a disabled-by-default activation boundary.
- Legacy reads remain available only for the declared two-minor/90-day window and resolve to canonical truth; the deprecated epoch projection maps exact component identities, accepts no writes, emits bounded use telemetry, and is removed only at the next-major executable gate.
- MCP tools are generated from reviewed service/OpenAPI contracts, expose only permitted tiers, and cannot issue leases or ingest authoritative runtime results unless the underlying authenticated service operation permits it.
- TaskManifest broker remains a bounded dispatch broker, not an ExecutionAdapter or federated protocol.
- Parity tests compare legacy and new projections for success, failure, retry, cancellation, crash, exact revision, and closeout without enabling parallelism, auto-merge, or deployment.

### W2-012
Deliver a reusable DB-backed contract conformance suite, security threat model, operational/recovery runbook, migration compatibility matrix, and independent review packet before Wave 2 can gate Wave 3 work.

**Acceptance criteria**
- One conformance suite verifies missions, work packages, leases, policy definitions/activations/revocation, checkpoints/receipts/bundles/deltas/dispatch/retry budgets, exact epoch read projection/write rejection/removal gate, event/evidence idempotency, closeout, cancellation, proposals, authorization, and versions.
- Threat modeling covers runtime impersonation, stale fences, evidence escalation, revision substitution, cross-tenant access, changed replay, retry storms, stale-base confusion, event floods, secret/attestation leakage, confused deputies, MCP overexposure, deprecated-projection authority laundering, and memory/terminal authority laundering.
- Crash exercises cover transaction interruption, queue loss/archive, worker/controller restart, lease expiry/takeover, partial events, compaction/retry phase ambiguity, closeout replay, aggregate retry exhaustion, and migration rollback/roll-forward without duplicate execution/prompt.
- A CI-independent local validation recipe creates a fresh dedicated-owner PostgreSQL 16 test database and runs migrations, typecheck, focused tests, contract generation/stability, Swagger tiers, security scan, and git diff --check.
- An independent architecture/security reviewer resolves all P0/P1 findings and signs an exact-SHA packet; no auto-merge/deploy is performed and memory remains advisory.
- The Wave 2 completion packet explicitly authorizes only the separate isolated Wave 3A ROR-28 and Wave 3B ROR-25 workstreams to overlap; every other wave remains sequential.

## Success metrics
- W2-001: The gate binds the canonical Linear workspace/team, ROR-24 issue identity, accepted ADR version/content hash, acceptance state, approval authority, updated-at/version marker, and evidence snapshot; a title, issue number, label, or mutable status alone is insufficient.
- W2-001: ROR-24 is schema-forbidden as dispatch work and can appear only as a prerequisite gate; no adapter may create a run, work package, branch, or provider mutation for it.
- W2-001: The Wave 1 prerequisite binds its exact spec revision, implementation Git SHA, independent review packet, validation receipt, and provider-neutral immutable local-review-bundle proof result and independent review.
- W2-001: Missing, stale, ambiguous, changed, revoked, cross-workspace, or self-asserted ROR-24/Wave 1 evidence returns a stable blocked reason before any migration or execution side effect.
- W2-001: Fixtures cover accepted, pending, changed-after-observation, duplicate, wrong-team, wrong-SHA, and unavailable gate states without using memory as authority.
- W2-002: MissionContract v1 has stable mission ID, contract version/hash, workspace, canonical spec ID/version/hash/path, repository and exact base revision, policy identities, approval/decision references, allowed execution posture, and creation provenance.
- W2-002: Contract hashes are canonical and deterministic; unknown authority fields, duplicate identifiers, relative/short SHAs, and unversioned payloads are rejected.
- W2-002: Compatibility rules define additive minor evolution, explicit major-version negotiation, read-old/write-current behavior, and fail-closed handling of unsupported versions.
- W2-002: Generated JSON Schema, OpenAPI, TypeScript exports, break markers, examples, and contract stability checks are reproducible from one source definition.
- W2-002: Mission compilation never treats MCP fields, memory, PTY output, runtime claims, or process exit as approval or lifecycle authority.
- W2-003: Migrations create tenant/workspace-scoped mission, mission-version, work-package, and work-package-revision tables with foreign keys, unique identities, append-only hashes, revision CAS, timestamps from PostgreSQL, and least-privilege/RLS treatment consistent with current core tables.
- W2-003: A work package binds mission contract version, story/scope, ordered dependencies, allowed file/mutation paths, exact repository revision, validation requirements, execution posture, and current lifecycle state.
- W2-003: Changing scope, dependencies, target revision, validation, or authority creates a new revision/proposal; active leases remain bound to their original immutable revision.
- W2-003: Concurrent update, stale revision, deleted dependency, cross-mission reference, and migration rollback/upgrade paths fail deterministically without partial state.
- W2-003: Migration contract and local PostgreSQL integration tests run under the dedicated non-superuser test owner.
- W2-004: Lease v1 includes opaque lease ID, monotonic fence, mission/work-package/spec/story revision, runtime identity, repository/base/current SHA and worktree/path scope, active policy-definition/activation plus current checkpoint/bundle references, database times, mutation bounds, and state; deprecated epoch is not a lease field.
- W2-004: PostgreSQL atomically prevents two active leases for the same execution identity and rejects stale fence renewals, late results, replayed releases, runtime substitution, and revision drift.
- W2-004: Expiry, cancellation, or policy-activation revocation makes the old generation and every unused receipt/bundle/dispatch ineligible even if a process continues running.
- W2-004: Queue delivery, worker PIDs, compatibility projections, and continuation artifacts are transport/provenance only and cannot issue or extend a lease.
- W2-004: DB-backed race tests cover duplicate acquire, renew-versus-expire, cancellation-versus-result, policy revocation, worker crash, clock skew, stale fence, and takeover.
- W2-005: Public schemas and PostgreSQL/service state transitions exist for policy-definition v1, scope-bound policy-activation v1, checkpoint v1, retrieval-receipt v1, context-bundle/delta v1, continuation-dispatch v1, and retry-budget/quarantine records with deterministic IDs/hashes, provenance, and rejection states.
- W2-005: A policy definition has immutable version/body/hash and append-only validated/published/superseded/revoked authority lifecycle, carries no cursor/Git scope, and is bound by one separately revisioned activation to exact scope/effective values; revocation stales every affected unused artifact.
- W2-005: The deprecated epoch surface is only an exact server-generated read projection over checkpoint, policy definition+activation, receipt, bundle, and optional dispatch identities; all writes reject before mutation, compatibility lasts two minor releases and at least 90 days, and removal is next-major gated by zero-use telemetry, client migration, fixtures, break markers, and independent review.
- W2-005: ContextBundle structurally separates exact requiredContext from provenance/freshness-bound advisoryMemory; memory cannot grant authority, override spec/policy, satisfy evidence, prove completion, or promote lifecycle state.
- W2-005: Typed triggers cover initial dispatch, successful non-aborted compaction, generation restart, story/wave transition, material file scope, validation/root-cause change, meaningful retry, TTL/source staleness, and missing context with exact trigger material.
- W2-005: Every key binds repository ID/base/current SHA/worktree, spec/story/criteria hashes, path manifests, validation/root-cause, definition/activation, turn/generation/session/cursor, retry/completion-candidate phase, and trigger material; identical replay returns the record while changed replay is permanent/audited and never bypassed by a nonce.
- W2-005: Policy budgets reserve required context first, reject required oversize without criterion truncation, dedupe only same-class stable sources, and cap delta chains.
- W2-005: A stale base is readable only for verified reconstruction with exact stable scope and permitted cursor, descendant-Git, validation, or fenced restart differences; every forbidden/ambiguous difference, corrupt/missing base, or hash mismatch requires a newly assembled full bundle.
- W2-005: Compaction eligibility requires status success, aborted=false, willRetry=false, exact originating turn/generation, later matching agent_settled, Pi retry phase none/settled/fenced, and explicit execution-turn completion-candidate state; controller validation submits proposals only and is not canonical closeout.
- W2-005: Server-owned workspace, sensitivity, redaction, secret-reference, version, Git/worktree/path, lease, turn/generation, session/cursor, receipt/bundle/delta, and definition/activation checks reject stale, tampered, secret-bearing, unsupported, or wrong-workspace input without old-context fallback.
- W2-005: Required context or lease verification failure blocks; permitted advisory outage is explicit degraded; one PostgreSQL retry budget spans all actors, permanent conflicts do not retry, exhaustion quarantines, and dispatch is an expiring one-use compare-and-set after double lease verification.
- W2-005: CI-independent schema/PostgreSQL/render/redaction/replay/budget/delta/stale/outage/state fixtures prove projection-write rejection, every changed-replay dimension, stale-base fallback, aborted/mismatched compaction, retry phases, secret/authority isolation, no retry storm, and no completion authority.
- W2-006: The envelope binds event/idempotency/schema identity; workspace/mission/work-package/spec/story/run/attempt/lease/fence; policy definition/activation, checkpoint/receipt/bundle/dispatch; repository/base/current SHA/worktree/path manifests; validation/root-cause; runtime/controller/originating turn/generation; session/cursor; times/sequence/trust/payload hash/redaction and optional restricted reference.
- W2-006: The registry includes compaction started/ended, agent_settled observed, Pi auto-retry started/ended/settled, execution completion-candidate observed/validated/rejected/submitted, checkpoint/retrieval/continuation/cursor/stale/rejected/quarantined types plus attempt, validation, cancellation, result, closeout, recovery, and liveness.
- W2-006: Compaction ended requires success/aborted/willRetry/result identity; settled and retry events require exact turn/generation/session/retry-cycle phase and state-order links, so aborted/failed/unmatched events cannot make continuation eligible.
- W2-006: Execution completion-candidate validation terminalizes only an execution turn and submits result/evidence proposals; only canonical StoryCloseoutDecision.accepted can establish story completion or lifecycle input.
- W2-006: Ordering distinguishes per-generation runtime sequence, canonical state order, and host receipt order; identical duplicates are idempotent while gaps, changed replay, regression, and stale generation are explicit permanent conflicts.
- W2-006: Payloads contain bounded canonical IDs/hashes/reasons/counts/timing only; raw prompts/transcripts, credentials, secret values, human attestations/signatures, unrestricted context, and deprecated epoch writes are schema-forbidden.
- W2-006: Events, terminal bytes, retrieval output, advisory memory, prompts, agent claims, process exit, and completion candidates cannot mutate canonical verification, evidence, closeout, lifecycle, approval, Check, merge, or deployment state.
- W2-006: Managed/federated-shaped fixtures validate every type and state violation, changed replay dimension, retry phase, aborted/mismatched compaction, secret/authority boundary, version negotiation, quarantine, and side-effect isolation locally.
- W2-007: Evidence v1 binds immutable evidence ID/hash, kind, trust, observer, subject lineage, mission/work-package/attempt/lease/policy-activation/checkpoint/repository revision, observed/received times, status, payload hash, and restricted raw reference.
- W2-007: Host-observed process/worktree/Git facts, provider-verified GitHub facts, runtime claims, and human decisions use separate non-escalating trust classes.
- W2-007: Idempotent replay returns the existing evidence; same identity with changed payload, stale fence, wrong revision, or cross-workspace subject is rejected and audited.
- W2-007: Redacted reads expose enough provenance for independent review while secrets and restricted raw payloads remain inaccessible.
- W2-007: Threat-focused tests prove a runtime, terminal stream, MCP client, memory entry, or caller cannot forge host/provider/human trust.
- W2-008: Closeout records exact input evidence IDs/hashes, policy/version, computed outcome, missing/conflicting evidence, resolver version, decision time, and immutable subject lineage.
- W2-008: Passed requires complete policy-eligible evidence for the exact mission/work-package/spec/story revision, lease fence, active policy activation, checkpoint/attempt and Git/worktree subject; exit zero, continuation settlement, or controller-validated execution-turn completion candidate alone is insufficient.
- W2-008: Failed, cancelled, expired, conflicted, stale, and reconciliation-required outcomes are explicit, idempotent, and cannot be overwritten by late runtime events.
- W2-008: Existing SSDLC gate/disposition/approval authority remains provider-human and receipt-bound; no new contract grants waiver, retry, merge, or production authority.
- W2-008: Golden and adversarial DB tests cover complete pass, missing evidence, conflicting trust, late result, cancellation race, stale revision, policy change, and replay.
- W2-009: Cancellation binds requester authority, reason, target attempt/lease fence, requested time/deadline, acknowledgement identity/time, and terminal disposition.
- W2-009: Late, wrong-runtime, wrong-fence, duplicated, and contradictory acknowledgements are preserved as non-authoritative conflicts and do not revive execution.
- W2-009: Plan-change proposals bind base work-package revision, proposed diff/hash, rationale, impact, requested paths/dependencies/validation, and proposer runtime; they create no mutation until separately authorized and revisioned.
- W2-009: Scope expansion, forbidden paths, new merge/deploy authority, revision drift, and proposal replay are rejected before review publication.
- W2-009: Tests cover graceful cancellation, forced expiry, lost runtime, competing acknowledgements, accepted/rejected/stale proposals, and restart recovery.
- W2-010: OpenAPI routes use strict boundary validation, AppError subclasses, explicit x-rorca-tier/rationale, pagination/limits, request IDs, and idempotency keys where mutations are allowed.
- W2-010: Runtime credentials can access only leased subjects and permitted operations; operator/human decisions retain existing stronger signed authority and one-use/expiry semantics.
- W2-010: Audit records bind actor, authority source, request hash, subject, decision, evidence references, result, database time, and correlation without secrets.
- W2-010: Rate, body, sequence, retention, query, and aggregate retry bounds prevent unbounded ingestion/replay; epoch and secret/authority-payload writes reject before mutation; partial failures are transactional or explicitly quarantined.
- W2-010: Route and repository tests cover unauthorized, cross-workspace, stale-token, replay, conflict, malformed-version, pagination, and recovery paths on a local test DB.
- W2-011: Current sequential branch-only runs continue through the existing execution engine while compatibility code emits contract-conformant identities/events/evidence behind a disabled-by-default activation boundary.
- W2-011: Legacy reads remain available only for the declared two-minor/90-day window and resolve to canonical truth; the deprecated epoch projection maps exact component identities, accepts no writes, emits bounded use telemetry, and is removed only at the next-major executable gate.
- W2-011: MCP tools are generated from reviewed service/OpenAPI contracts, expose only permitted tiers, and cannot issue leases or ingest authoritative runtime results unless the underlying authenticated service operation permits it.
- W2-011: TaskManifest broker remains a bounded dispatch broker, not an ExecutionAdapter or federated protocol.
- W2-011: Parity tests compare legacy and new projections for success, failure, retry, cancellation, crash, exact revision, and closeout without enabling parallelism, auto-merge, or deployment.
- W2-012: One conformance suite verifies missions, work packages, leases, policy definitions/activations/revocation, checkpoints/receipts/bundles/deltas/dispatch/retry budgets, exact epoch read projection/write rejection/removal gate, event/evidence idempotency, closeout, cancellation, proposals, authorization, and versions.
- W2-012: Threat modeling covers runtime impersonation, stale fences, evidence escalation, revision substitution, cross-tenant access, changed replay, retry storms, stale-base confusion, event floods, secret/attestation leakage, confused deputies, MCP overexposure, deprecated-projection authority laundering, and memory/terminal authority laundering.
- W2-012: Crash exercises cover transaction interruption, queue loss/archive, worker/controller restart, lease expiry/takeover, partial events, compaction/retry phase ambiguity, closeout replay, aggregate retry exhaustion, and migration rollback/roll-forward without duplicate execution/prompt.
- W2-012: A CI-independent local validation recipe creates a fresh dedicated-owner PostgreSQL 16 test database and runs migrations, typecheck, focused tests, contract generation/stability, Swagger tiers, security scan, and git diff --check.
- W2-012: An independent architecture/security reviewer resolves all P0/P1 findings and signs an exact-SHA packet; no auto-merge/deploy is performed and memory remains advisory.
- W2-012: The Wave 2 completion packet explicitly authorizes only the separate isolated Wave 3A ROR-28 and Wave 3B ROR-25 workstreams to overlap; every other wave remains sequential.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

