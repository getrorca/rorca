<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# ADR: Canonical evidence-driven SSDLC lifecycle boundary

- **Status:** Accepted
- **Date:** 2026-07-14
- **Contract:** [`backend/src/lib/ssdlc-contracts.ts`](../../backend/src/lib/ssdlc-contracts.ts)

## Context and design inputs

The product argument comes from the [Lifecycle delivery-board wireframe](../diagrams/rorca-ssdlc-lifecycle-board-wireframe.excalidraw): fixed end-to-end phases, explainable dispositions, requirement-to-gate traceability, immutable-subject coherence, and evidence rather than an agent completion claim. The [Hermes/Rorca SSDLC skill sequence](../diagrams/hermes-rorca-ssdlc-skill-sequence-clean.excalidraw) supplies the model/skill/evidence handoffs and identifies GitReins risk verdicts, policy findings, and repository guardrails as external evidence.

Existing boundaries remain design constraints:

- [Rorca's skill-first contract](../../README.md#one-forge-workflow-across-every-rorca-product) says “skills think, MCP/tools fetch and mutate, Rorca persists and orchestrates.” Rorca owns canonical spec, run, approval, and lifecycle state.
- [Hermes is an external distribution channel, not a second control plane](../mcp-integration.md#what-hermes-is-and-is-not). It may author through skills and call versioned Rorca tools; it does not become lifecycle authority.
- GitReins owns its repository-risk and guardrail judgments. Rorca may ingest a stable GitReins result as evidence for a declared gate. It does not reproduce GitReins, infer a verdict on its behalf, or silently treat “pending” as pass.
- The existing [`execution-engine.ts`](../../backend/src/lib/execution-engine.ts) remains the sole story executor and scheduler. Its current run queue, retry, process, worktree, and agent paths are not lifecycle phases.

The fixed phase order is **Intake, Requirements, Architecture, Implementation, Validation, Security, Staging, QA, Merge, Production, Learn**. Speculative custom phases and generic workflow authoring are explicitly out of scope. Teams express variation with versioned gate definitions, evidence requirements, policies, and governed `deferred`/`not_applicable` dispositions—not by creating another workflow language.

`schemaVersion: 1` is only a wire-compatibility discriminant for future discriminated-union migration. It does **not** mean MVP, partial product scope, reduced production quality, or permission to defer a post-v1 user experience.

## Decision

### Persisted versus derived

The only **new durable concepts** are:

1. versioned lifecycle plans compiled from a canonical persisted spec and workspace inputs;
2. immutable, redacted evidence records/completion packets with provenance; and
3. governed decisions with policy, approver, subject, evidence, and expiry references.

Canonical specs and execution runs are existing durable Rorca concepts. Evaluated phase status, blockers, lifecycle coverage, readiness, and portfolio metrics are **derived read models**. They are never an additional progress store. Every read model carries a verified evaluation snapshot identity over plan ID/version/input hash, evidence and decision high-water marks, active release subject, policy/compiler versions, and evaluation time. A changed input or high-water mark creates another snapshot; it does not mutate old evidence.

Plans persist stable requirement mappings and declarative evidence requirements, never mutable evidence facts. Acceptance criteria use either a validated explicit requirement ID or `story-id:ac:sha256:<fingerprint>` over NFKC-normalized, trimmed, case-folded, whitespace-collapsed criterion text. Reordering therefore preserves identity; a duplicate normalized criterion is rejected. Missing optional compiler sources deterministically normalize to empty arrays; supplied tags, risk assignments, owner assignments, and policy annotations are workspace-checked and sorted by stable keys before compilation.

### Five cooperating planes

The planes integrate only through the versioned contracts below. A plane must validate its input and may not silently assume that another plane approved, persisted, executed, or evaluated anything.

| Plane | Versioned input | Versioned output | Owner and sole state transition |
| --- | --- | --- | --- |
| **Authoring** | brief/context plus skill contract; canonical-spec validation request | model-authored draft proposal, then validated canonical spec DTO | The skill/model owns draft authorship only. Rorca's authoring validator alone changes `proposed → validated`; canonical spec persistence alone changes `validated → persisted`. Model output is never canonical merely because generation succeeded. |
| **Lifecycle control** | canonical spec JSON/version/hash joined to workspace tags, risk assignments, owner assignments, policy annotations, compiler/policy versions | immutable versioned lifecycle plan and governed decision DTOs | The Rorca lifecycle compiler alone changes `compiler inputs → plan version`; the configured human/policy authority alone records approvals, deferrals, N/A decisions, retry authorization, merge authorization, or deployment authorization. |
| **Execution** | approved canonical story/run packet plus persisted story-skill assignments and execution-mode request | agent process outcome, files/commits, run/WAL evidence candidates | The existing Rorca execution engine alone changes run/story process state and injects selected story skills into `buildPrompt()`. It is not a lifecycle compiler or evaluator. |
| **Story closeout** | one process outcome plus meaningful-change and local validation evidence | one mode-agnostic accepted/rejected story completion packet | The existing execution engine may make exactly one local closeout decision before marking the story locally passed. Exit zero is only a process outcome and cannot bypass this closeout. |
| **Evidence evaluation** | plan version, immutable evidence high-water mark, governed decision high-water mark, active release subject, policy/compiler versions | snapshot-bound phase/readiness/portfolio read models | The lifecycle evaluator alone derives phase and gate status. It cannot execute stories, approve its own missing evidence, or mutate plan/evidence/decision history. |

The authoring plane deliberately separates **skill-first model authorship**, **authoritative Rorca authoring/plan validation**, and **canonical spec persistence**. The execution plane separately performs **story-skill injection**. The evidence-evaluation plane separately derives lifecycle state. Persist success does not imply skill injection; skill injection does not imply process success; process success does not imply closeout acceptance; closeout acceptance does not imply a phase pass.

### Execution modes are not phases

**Implementation, QA, and Journey are execution modes**, even where a mode name resembles a canonical phase name. A mode chooses prompts and validation behavior for the existing story loop. No mode directly sets Validation, QA, Merge, Production, or Learn status.

The execution engine may enforce one mode-agnostic story-closeout decision before local story pass. It cannot compile lifecycle plans, evaluate phase status, approve governed decisions, calculate retry scope, or authorize merge/deployment. Retry scope remains an explicit governed request consumed by the existing retry path; this design adds no retry engine.

The contract therefore distinguishes three non-interchangeable facts:

1. **Agent process outcome:** succeeded/failed/timed out/cancelled, including exit code and signal.
2. **Accepted story closeout:** accepted/rejected after meaningful-change and local evidence checks.
3. **Evaluated lifecycle phase status:** snapshot-derived governance state from plan, evidence, decisions, subject coherence, and policy.

Exit zero is not story pass. Story pass is not phase pass.

### Dispositions, status precedence, and release subjects

Every phase has exactly one disposition: `required`, `deferred`, or `not_applicable`. All require a rationale. A deferral also requires a governed approval reference and expiry policy; N/A requires a non-empty rationale.

Evaluators apply the shared `STATUS_PRECEDENCE` in order: **stale → blocked → awaiting_approval → deferred → not_applicable → passed → in_progress → not_started**. “Stale” wins when versioned inputs invalidate prior evaluation; a hard blocker wins over approval wait; dispositions apply only when governed; pass requires all current gates; progress requires observed current activity/evidence. Invalid disposition/status combinations fail contract validation.

Release subjects are only `spec_hash | commit_sha | artifact_digest | deployment_id`. Every gate declares accepted types and explicit QA, Merge, and Production coherence (`same_subject`, `derived_from_subject`, or `not_applicable`). QA and Merge must evaluate the declared immutable commit/artifact relationship; Production may evaluate a deployment derived from that same verified chain. A successful check against a different subject cannot satisfy the gate.

### Normalized evidence and Hermes ingress

[`ssdlc-evidence.ts`](../../backend/src/lib/ssdlc-evidence.ts) is the single thin normalization contract. Internal adapters side-write immutable records from `story_results`, `story_commits`, validation/completion WAL events, GitHub check events, and output-chunk metadata after a run finishes. Adapter errors produce retryable `ssdlc_evidence_adapter_error` WAL events and never update `pipeline_runs` or `story_results`.

Hermes remains the external integration/auth boundary for GitReins judgments, manual QA, staging, deployment, and memory-closeout candidates. It submits one bounded `hermes.evidence.v1` envelope to canonical `POST /api/lifecycle/evidence` (`/evidence/hermes` remains a compatibility alias). Rorca derives source type, actor, and trust from the envelope kind plus the authenticated server principal; body claims cannot impersonate automation or upgrade trust. Ordinary users may submit authenticated manual QA only; automated kinds require a verified internal/Hermes adapter. Responses classify the result as `persisted` or `duplicate`; conflicting source identities return `conflict`, and unauthorized source claims return `blocked`. A different canonical payload under the same `(workspace, source system, source event ID)` is rejected and audited in WAL.

The ledger stores a redacted excerpt of at most 8 KiB and an opaque raw reference of at most 4 KiB. PTY/output chunks and logs stay in their existing storage. Every record includes explicit nullable workspace/spec/run/story/phase/gate scope keys, typed subject and phase-subject identities, release lineage, classified outcome, trust, confidence, provenance chain, and `revisionMismatch`. Gate evaluation requires `passed`, a policy-explicit accepted trust level, a coherent current subject, and gate-appropriate identity: commit for code, artifact digest plus commit lineage for build/staging, and deployment ID bound to that exact artifact and commit for production. `unknown` never passes.

### Governed mutation boundary

Lifecycle write adapters are authenticated and intentionally narrow: one-spec recompile, bounded workspace recompile pages, governed decision create/revoke, read-only retry preview, and exact retry dispatch. Mutations require a client `Idempotency-Key`; durable replay records reject key reuse with different input and return completed responses after restart. Retry preview writes nothing and returns the exact governed packet plus a short-lived signed identity. Dispatch recomputes scope and shared run policy, rejects stale/expired/mismatched packets, and submits only through the existing `pipeline:retry` queue with worktree, branch-only, no-auto-merge, no-deploy, and no-external-send defaults.

After durable lifecycle changes, Rorca writes only bounded `lifecycle_changed` invalidation metadata (`workspaceId`, `specId`, `phaseId`, `runId`, `changeKind`) to existing WAL and publishes that row through `sse-hub`. Raw logs, Slack text, credentials, and attachments are never copied into invalidation events.

### Completeness

The version-1 completeness contract forbids placeholder UI, TODO-backed primary flows, fake success states, and deferral of specified normal, negative, recovery, responsive, accessibility, or light-theme journeys to an unspecified later release. A plan that weakens any of these literals is invalid. Product delivery may still use governed phase disposition where genuinely appropriate; it may not relabel unfinished specified behavior as “post-v1.”

## Prohibited abstractions and consequences

This ADR adds contracts and validators, not infrastructure. No lifecycle component may introduce:

- a second workflow engine or generic workflow authoring system;
- a second event bus;
- a second policy engine;
- a second progress/status store;
- a second story loop, scheduler, or queue;
- a mode detector;
- a retry engine or retry supervisor;
- a worktree manager;
- an agent orchestrator;
- a Hermes control-plane clone; or
- a GitReins repository-policy/guardrail clone.

Use existing Rorca persistence, WAL/SSE boundaries, execution scheduling, retry APIs, worktree handling, and agent adapters. Integrations publish or reference validated evidence through the versioned DTOs. This keeps lifecycle control explainable and KISS: plans say what is required, evidence and decisions say what happened or was governed, and snapshot evaluators derive what the board displays.

## Developer contract guide

### Plane connectors

The five planes above are connected by three explicit execution/closeout contracts, not by shared mutable status:

1. `StoryExecutionManifest` (`story-execution-manifest.v1`) connects lifecycle-safe run preparation to execution. It freezes workspace/spec/run/story/attempt identity, spec/story revisions, execution mode/options, command hashes and validation plan, evidence expectations, repository change policy, worktree/merge boundary, and command-safety profile under `manifestHash`.
2. `StoryAttemptResult` (`story-attempt-result.v1`) connects the agent process to closeout. It records process outcome, bounded output references, the untrusted proposed completion packet, observed files/commits, host validation observations, known issues, revisions, and manifest identity under `attemptResultId`. It is an observation, not acceptance.
3. `StoryCloseoutDecision` (`story-closeout-decision.v1`) connects closeout to canonical local story state/evidence normalization. It records `accepted | blocked`, reason codes, criterion-to-host-evidence mappings, normalized evidence references, active subject revision, and one next safe action under `decisionId`. The engine persists this decision before a story may be marked passed.

The authoring/lifecycle-control boundary is the version-1 `LifecycleCompilerInput → LifecyclePlan` contract in `ssdlc-contracts.ts`; the evidence-evaluation boundary is `LifecyclePlan + normalized evidence + governed decisions + run state → LifecycleEvaluation` in `ssdlc-phase-evaluator.ts`. Every contract validates schema and content identity on consumption. `schemaVersion: 1` is a compatibility discriminator only; it does not denote MVP scope, incomplete UX, weaker safety, or permission to omit primary/negative/recovery journeys.

### Compiler profiles and canonical inputs

The compiler deterministically classifies `docs-only`, `code-change`, `data-storage`, `security-sensitive`, `integration`, and `release-operations` from canonical stories, criteria, tags, file hints, risk, and validated annotations. Callers can suggest profile/disposition annotations but cannot force unsupported classification or waive protected gates. Optional sources normalize to explicit empty arrays. Requirement and acceptance-criterion identities, profile order, gate templates, evidence requirements, phase order, compiler version, policy version, and normalized input hash are stable inputs to replay.

The complete client-neutral flow is: skill-first draft/decomposition/preflight → Rorca validation → canonical persistence → durable post-save stages → lifecycle compilation → existing execution engine → attempt result → closeout decision → normalized evidence/governed decisions → snapshot evaluation → human-reviewed Learn candidates. Pi, Hermes, UI, CLI, and API clients can invoke or present these steps but cannot inherit authority from another plane.

### Repositories, APIs, and events

- Contracts/compilation: `ssdlc-contracts.ts`, `ssdlc-plan-compiler.ts`, `ssdlc-plan-service.ts`.
- Attempt/closeout: `story-execution-packet.ts`, `story-closeout.ts`, canonical `execution-engine.ts`.
- Evidence/decisions/evaluation: `ssdlc-evidence.ts`, `ssdlc-decisions.ts`, `ssdlc-phase-evaluator.ts`, `ssdlc-lifecycle-read.ts`.
- Read APIs: `GET /api/lifecycle`, `/specs/:specId`, `/specs/:specId/phases/:phaseId`, `/evidence/:evidenceId`; operations health is the admin-tier `GET /api/lifecycle/operations` projection.
- Mutations: one-spec/bounded-workspace recompile, evidence ingress, governed decision create/revoke, read-only retry preview, exact retry dispatch, and Learn closeout generation. Mutation replay uses `Idempotency-Key` where specified.
- SSE: durable writes emit bounded `lifecycle_changed` WAL rows and publish through `sse-hub`. The payload is only `workspaceId`, optional `specId/phaseId/runId`, and `changeKind`. Clients refetch canonical snapshots; SSE is invalidation, not lifecycle truth.
- Operational WAL: adapter, conflict, evaluator, and retry-denial events contain redacted types/identifiers/countable metadata, never raw evidence payloads.

Swagger annotations and tier rationales are mandatory for every route. Auth-tier lifecycle reads are workspace-owned and not marked stable public. The operations projection is admin-tier and is intentionally excluded from MCP/public-contract generation. Shared contract changes require typecheck, Swagger/tier checks, public-contract stability, license-boundary, and open-core checks.

### Tests and extension points

Contract/compiler fixtures cover every compiler profile and deterministic replay. Repository/migration tests enforce workspace isolation and immutable uniqueness. Evaluator tests cover status precedence, dispositions, wrong-revision evidence, approval expiry/revocation, lineage, and blocked snapshots. Execution regressions cover four agents, implementation/QA/Journey modes, ANSI and PTY waves, cancellation/timeout cleanup, retry option replay/scope, and closeout-before-pass. Frontend tests cover typed API state, matrix/drawer/inspector/actions, accessibility, responsiveness, themes, reduced motion, and explicit operational states; Playwright owns the staging-quality browser journey.

Supported extension points are a versioned compiler profile/gate template, a normalized evidence adapter with server-owned trust, a governed decision policy, or a read-only derived projection. Extensions must preserve canonical phase order, immutable subjects, workspace scoping, snapshot identity, and existing event/scheduler boundaries.

### Explicit non-goals

There is no generic lifecycle designer, arbitrary phase plugin, automatic adapter polling system, lifecycle-owned deploy/merge/send command, second queue/event bus/policy engine, mutable percentage-complete store, agent self-approval, mode-to-phase mapping, or automatic human QA sign-off. Operational health reports implemented counters only; it does not claim provider reachability where no probe exists. See [`../lifecycle-operations-runbook.md`](../lifecycle-operations-runbook.md) for rollout and recovery.
