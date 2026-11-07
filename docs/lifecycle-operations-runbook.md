<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Lifecycle rollout and operator runbook

## Safety and authority

Lifecycle is an evidence-evaluated read model, not a second workflow engine. Canonical Specs and Runs continue to work when GitHub, GitReins, staging, deployment, PTY, graph, or other evidence adapters are absent. An unavailable adapter produces `unknown`/blocked evidence state and a next action; it never changes `pipeline_runs`, `story_results`, spec approval, or an existing closeout decision.

This runbook permits local/test inspection and bounded plan compilation. It does **not** authorize merge, deployment, production mutation, external send, credential copying, gate waiver, or approval on behalf of a human. Those require their existing separate approval paths.

Hermes/fleet repair, idle suspension, dependency admission, quotas, status planes, and provider/runtime/Forgejo provisioning/offboarding follow [`architecture/governed-hermes-operations.md`](architecture/governed-hermes-operations.md). A health result is not fix authority: operators must require preview, authority class, idempotency, budget/cooldown/fence, independent postcondition verification, compensation, and audit. Unknown resources or hidden-host reconstruction dependencies block and quarantine rather than trigger deletion or config rewrite.

## Semantics operators must preserve

- A **disposition** says whether a phase is `required`, governed `deferred`, or governed `not_applicable`. It does not say the work passed. Deferred/N/A always need rationale and, where policy requires it, an authorized decision.
- A **status** is evaluator output: `stale`, `blocked`, `awaiting_approval`, `deferred`, `not_applicable`, `passed`, `in_progress`, or `not_started`, in that precedence order. `needs_compilation` is the read model for a spec without a usable plan.
- A **gate** passes only from eligible evidence/decisions on the current immutable subject and policy/compiler versions. Agent claims, exit zero, and UI state are not phase authority.
- **QA execution mode** chooses story prompts/validation. **QA lifecycle approval** is a governed human decision bound to the immutable revision. A QA-mode run can succeed while QA remains `awaiting_approval` because the human approval is absent, expired, revoked, or bound to another commit/artifact.
- **Journey execution mode** exercises a user journey. **Lifecycle phase status** remains evaluator-derived. A successful browser journey can leave Staging blocked by missing artifact lineage, QA awaiting approval, Merge blocked by subject mismatch, and Production not started.

## Answer “what is blocked and what is next?”

1. Open **Lifecycle Control**, retain the current snapshot, and enable **Blocked only** or filter the relevant phase/status.
2. Read the cell's visible status and gate fraction; do not infer pass from color or icon.
3. Open the phase drawer. Read **Current state**, **Blocker**, and **Next safe action** before traceability detail.
4. Follow requirement → story → gate → current evidence. Historical or revision-mismatched evidence is inspectable but cannot satisfy the gate.
5. Open Evidence Inspector only for the snapshot that selected the item. A `409 refresh_required` means refresh the entire evaluated view; never silently substitute another evidence record.
6. Use the offered action only if the server returns permission. Retry is preview-first; override is a review packet, not a bypass; approval records the authenticated principal and immutable subject.

For workspace-wide triage, call:

```http
GET /api/lifecycle/operations?workspaceId=<workspace-id>
```

This admin-tier, read-only report is bounded to 500 canonical spec files. It reports plan coverage, unresolved compile failure codes, stale plans, a bounded blocked-phase sample, exact retryable compile actions, adapter availability/errors, evidence conflicts, stale-preview denials, evaluator errors, phase transitions, and observed backfill pages. It returns counts/identifiers only—never raw evidence, terminal output, credentials, excerpts, or provider payloads. `blockedPhases.truncated=true` means use Lifecycle filters to narrow the portfolio; it must not be read as complete phase coverage.

## Bounded rollout/backfill

### 1. Preflight (no mutation)

- Back up the local database through the existing backup procedure.
- Confirm the workspace is below the 500-spec operational bound.
- Capture the operations report and record `planCoverage`, `compileFailures`, `stalePlans`, `blockedPhases`, `health.adapters`, and `retryableActions`.
- Confirm ordinary Specs/Runs endpoints are healthy. A degraded evidence adapter is not a reason to stop existing Specs/Runs.
- Start with a disposable/local workspace. Do not point this procedure at production without separate authorization.

### 2. Compile one bounded page

Use the already implemented admin operation; page size is hard-capped at 20:

```http
POST /api/lifecycle/recompile
Idempotency-Key: lifecycle-backfill-<workspace>-<page>
Content-Type: application/json

{"workspaceId":"<workspace-id>","cursor":null,"limit":20}
```

The response returns `compiled`, `skipped`, `failed`, `nextCursor`, `limit`, and `replayed`. A failure is per spec and retryable; it does not roll back successful siblings or block Specs/Runs. Preserve the response as rollout evidence.

### 3. Continue or pause

- Reuse the same idempotency key only to replay the exact same page request.
- For the next page, use a new key and the response's `nextCursor`. Stop when it is `null`.
- Pause if compile failures increase, adapter/evaluator errors increase, stale plans grow, or existing Specs/Runs health regresses.
- After each page, re-read `/api/lifecycle/operations`. `backfillProgress` is the current projection; `pagesObservedLast24h` is an audit counter, not a queue depth.

### 4. Retry failures safely

Use each report `retryableActions` path with a new `Idempotency-Key`. Resolve source/preflight errors before retrying. Never edit the compiled-plan table, mark a phase passed, or delete readiness reasons manually. Material spec edits invalidate the current plan and prior revision-bound approval/evidence by design.

## Drawer actions and recovery

- **Retry:** open preview; verify exact executable/copied/pending stories, current worktree/revision, agent/model/effort, focused and broad checks, and branch-only/no-merge/no-deploy/no-send policy. Dispatch the identical, unexpired packet only after required approval. A denial increments the operational stale-preview counter; generate a fresh preview.
- **Override/defer/N/A:** review rationale, evidence gap, policy, expiry, approver class, and immutable subject. Hard-deny gates cannot use override/defer/N/A. Revocation is append-only and immediately invalidates evaluation.
- **Approval:** QA, merge, and production approvals are separate governed decisions. Approval against commit A cannot approve artifact/deployment B without verified lineage.
- **Adapter outage:** leave source state unchanged, repair/reconnect the adapter, rerun its existing normalization/ingress path, then refresh. Do not fabricate manual evidence for an automated source.
- **Evaluator error:** use the redacted operation/spec identity and server log correlation; repair the underlying read/evaluator issue, then refresh. The audit event contains no evidence payload.
- **Stale plan/snapshot:** recompile from canonical persisted spec, then refresh. Old evidence remains historical; recollect or reapprove only for the new immutable subject.
- **Learn blocked:** retry deterministic Learn generation after source evidence is durable. Candidates remain `review_required` and retrieval-ineligible until human review.

## Complete skill-first lifecycle across clients

Pi, Hermes, CLI, and UI share one authority chain:

1. A skill/model drafts and decomposes a brief and performs authoring preflight.
2. Rorca validates, then canonical persistence (`rorca_persist_spec` / `POST /api/specs/persist`) is the sole persisted-spec authority. Backend generation is fallback, not the normal authoring path.
3. Post-save stages capture/enrich/match skills/synthesize memory under the documented v1 policy. A stage result does not approve or run a spec.
4. Lifecycle compilation produces a deterministic plan from canonical content and workspace inputs. Compilation does not execute or pass a phase.
5. The existing execution engine consumes a `StoryExecutionManifest`, emits a `StoryAttemptResult`, and records one `StoryCloseoutDecision` before local story pass.
6. Evidence adapters side-write normalized immutable evidence. Governed human/policy decisions are separate.
7. The evaluator derives the board snapshot. Learn closeout creates provenance-linked review candidates; it does not rewrite delivery outcome.

Clients may propose, display, or invoke the correct canonical operation. They may not claim another plane's authority.

## Rollback and recovery

There is no destructive backfill rollback: compiled plans are versioned and old evidence/decisions are immutable. To recover, stop paging, preserve reports, repair canonical input, and recompile the affected spec. If this release's read route causes operational issues, disable/remove only the `/api/lifecycle/operations` route and its audit instrumentation; do not delete lifecycle tables or edit Specs/Runs. Database restoration is the last resort and must use the existing backup process with separate approval.
