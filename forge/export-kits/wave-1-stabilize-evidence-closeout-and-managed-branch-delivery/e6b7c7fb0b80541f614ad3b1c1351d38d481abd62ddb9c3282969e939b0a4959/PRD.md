# Wave 1 — Stabilize Evidence Closeout and Provider-Neutral Local Delivery — Product Requirements

## Problem
Deliver the behavior defined by the canonical Wave 1 — Stabilize Evidence Closeout and Provider-Neutral Local Delivery specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- W1-001 — Freeze the stabilization baseline and protected-run deny list
- W1-002 — Bind host-observed attempt evidence to exact spec and Git revisions
- W1-003 — Separate semantic closeout and lifecycle truth from process exit
- W1-004 — Fence cancellation, retries, idempotency, and isolated worktree recovery
- W1-005 — Productize exact-run closeout reconciliation preview authority
- W1-006 — Compose reconciliation under advisory locks with isolated evidence events
- W1-007 — Define archived pg-boss recovery without reviving semantic work
- W1-008 — Make Forge and MCP artifacts reproducible across reviewed integration
- W1-009 — Enforce isolated test-database authority and independent stabilization review
- W1-010 — Prove provider-neutral delivery with an immutable local review bundle

## In scope
- Add a fail-closed Wave 1 intake guard around the existing run, closeout, reconciliation, Forge/MCP, test-database, provider-neutral delivery-adapter, and optional GitHub seams. The guard must bind work to the reviewed clean integration baseline and make externally owned Genesis run 20260316000549 structurally ineligible for every read, preview, reconciliation, retry, delivery, and mutation path introduced by this spec.
- Complete host-observed attempt envelopes at the execution-engine and worker boundary so process identity, launch generation, worktree, immutable spec revision/hash, base and observed Git SHA, agent/runtime, timestamps, cancellation fence, and outcome provenance are durable before lifecycle interpretation.
- Finish run_closeout authority across backend/src/lib/run-closeout-authority.ts, execution-engine closeout, worker terminalization, and Run View projections. Process exit is one observation only; explicit durable story evidence and closeout decide semantic status.
- Stabilize route, queue, worker, local-runner, engine, and story-worktree boundaries so cancellation and retry share exact immutable attempt identity, PostgreSQL-owned leases/fences, and bounded recovery. pg-boss remains transport and ordinary execution stays sequential with parallelism 1 and branch-only delivery.
- Provide a read-only reconciliation preview and separately authorized apply path across backend reconciliation routes and src/lib/run-closeout-reconciliation.ts. Bind a canonical run, spec revision, evidence snapshot, target closeout transition, expiry, and deterministic preview hash without granting ordinary execution authority.
- Make reconciliation a narrowly scoped PostgreSQL transaction that composes with existing advisory locks, lifecycle writes, and pass reconciliation. It may append dedicated reconciliation evidence/events and settle eligible closeout rows only; it must not traverse ordinary execution or release side effects.
- Reconcile pg-boss v10 live/archive transport state with canonical PostgreSQL run authority. Recovery must infer no semantic success from transport disappearance and must never resurrect a terminal or superseded generation.
- Stabilize explicit-draft Forge, public-contract generation, MCP discovery, provider-neutral delivery reads, and packaged Pi extension outputs so the reviewed source tree, generated assets, and installed package expose the same canonical create/readiness/workflow/reconciliation/local-review-bundle contracts without backend drafting or untracked package drift.
- Make DB-backed validation self-identifying and fail closed unless it uses a fresh PostgreSQL 16 test database owned by the dedicated non-superuser test role. Produce a bounded independent review packet covering Forge/MCP, closeout, reconciliation, transport recovery, provider-neutral local delivery, security, and side-effect exclusions.
- After W1-001 through W1-009 local implementation gates are complete, exercise the default LocalReviewBundleAdapter only against an isolated local proof fixture. Finalize one immutable content-addressed review bundle without any GitHub, PAT, remote account, webhook, network provider, merge, deployment, or live-run authority; GitHub remains an optional uninvoked adapter.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### W1-001
Add a fail-closed Wave 1 intake guard around the existing run, closeout, reconciliation, Forge/MCP, test-database, provider-neutral delivery-adapter, and optional GitHub seams. The guard must bind work to the reviewed clean integration baseline and make externally owned Genesis run 20260316000549 structurally ineligible for every read, preview, reconciliation, retry, delivery, and mutation path introduced by this spec.

**Acceptance criteria**
- A checked contract fixture records the exact implementation baseline Git SHA, spec revision identity, allowed isolated proof-fixture identity, and the explicit deny-listed Genesis run 20260316000549.
- Every Wave 1 reconciliation or delivery-proof selector rejects run 20260316000549 before loading run evidence or acquiring a mutation lock, and a regression test proves zero reads and zero writes against that identity.
- Baseline, workspace, canonical spec path, and repository mismatches return typed fail-closed diagnostics and do not enqueue jobs or invoke providers, hooks, memory writes, delivery writes, merge, or deployment.
- The gate documents that proof run 20260316000550 remains ineligible for reconciliation until separately reviewed code is merged and deployed by authorized humans; this spec grants neither authority.
- Focused contract tests and git diff --check run locally without CI services or network providers and report the deny-list and baseline checks as passed.

### W1-002
Complete host-observed attempt envelopes at the execution-engine and worker boundary so process identity, launch generation, worktree, immutable spec revision/hash, base and observed Git SHA, agent/runtime, timestamps, cancellation fence, and outcome provenance are durable before lifecycle interpretation.

**Acceptance criteria**
- The host persists a versioned attempt envelope with run/story/attempt/generation identity, exact canonical spec path and revision/hash, exact repository and Git SHA, worktree identity, runtime identity, and host-observed timestamps.
- Agent text, PTY output, exit code, memory, and caller-supplied evidence cannot overwrite host-observed identity or promote an attempt to passed.
- A changed spec revision, moved canonical path, changed Git SHA, reused generation, or mismatched worktree is preserved as immutable conflicting evidence and blocks closeout.
- Duplicate delivery of the same envelope is idempotent; a payload change under the same identity is rejected and audited.
- DB-backed tests cover success, nonzero exit, timeout, cancellation, crash, stale generation, duplicate, and revision-mismatch envelopes.

### W1-003
Finish run_closeout authority across backend/src/lib/run-closeout-authority.ts, execution-engine closeout, worker terminalization, and Run View projections. Process exit is one observation only; explicit durable story evidence and closeout decide semantic status.

**Acceptance criteria**
- Exit zero without complete exact-revision story evidence cannot produce passed, done, release eligibility, lifecycle completion, or a successful Check Run.
- Nonzero exit, rejected promise, lost worktree, cancellation, unresolved conflict, missing evidence, and stale revision settle to explicit failed, cancelled, blocked, or reconciliation-required states rather than ambiguous success.
- Previously passed stories are carried forward only from exact compatible durable evidence and are never re-executed merely to repair aggregate closeout.
- Run View and API status derive from authoritative closeout rows and explicit story evidence, not process state, PTY text, positional inference, or memory.
- Focused backend and frontend tests cover contradictory exit/evidence combinations and distinguish run-level status from story-level status.

### W1-004
Stabilize route, queue, worker, local-runner, engine, and story-worktree boundaries so cancellation and retry share exact immutable attempt identity, PostgreSQL-owned leases/fences, and bounded recovery. pg-boss remains transport and ordinary execution stays sequential with parallelism 1 and branch-only delivery.

**Acceptance criteria**
- Cancellation is durably requested, acknowledged by the active fenced runtime generation, and terminalized without a late completion overwriting cancellation.
- Retries compute the smallest safe scope from exact evidence, exclude passed stories, preserve failed worktrees, and cannot reuse a consumed approval, preview, lease, or launch token.
- Duplicate pg-boss delivery, worker restart, and concurrent retry requests yield at most one executing generation under a PostgreSQL fence.
- Singleton and sequential execution use isolated host-created worktrees where required, never dirty the source checkout, and preserve conflict/crash evidence for review.
- Local DB-backed adversarial tests cover cancellation races, lease loss, duplicate delivery, archived transport recovery, crash-before-launch, crash-after-result, and retry of mixed passed/failed stories.

### W1-005
Provide a read-only reconciliation preview and separately authorized apply path across backend reconciliation routes and src/lib/run-closeout-reconciliation.ts. Bind a canonical run, spec revision, evidence snapshot, target closeout transition, expiry, and deterministic preview hash without granting ordinary execution authority.

**Acceptance criteria**
- Preview performs no mutation and returns a deterministic hash over workspace, run, exact spec revision/path, Git SHA, immutable evidence IDs/hashes, proposed transitions, exclusions, and expiry.
- Apply accepts only the exact unexpired preview packet and authorized human receipt, then re-resolves the same canonical workspace/path/run and revalidates every evidence hash before mutation.
- Canonical path traversal, symlink escape, alternate encoding, cross-workspace run, malformed CSRF/origin, expired preview, replayed receipt, and changed evidence are rejected before locking or mutation.
- The API uses AppError subclasses plus explicit Swagger tier/rationale and the frontend uses apiFetch and existing design tokens.
- Route, library, CSRF, path, expiry, replay, and time-of-check/time-of-use tests run against a local isolated test database without GitHub or CI.

### W1-006
Make reconciliation a narrowly scoped PostgreSQL transaction that composes with existing advisory locks, lifecycle writes, and pass reconciliation. It may append dedicated reconciliation evidence/events and settle eligible closeout rows only; it must not traverse ordinary execution or release side effects.

**Acceptance criteria**
- One documented lock order covers run, closeout, story evidence, and lifecycle composition; concurrent apply, retry, cancellation, and worker closeout either serialize or fail closed without deadlock.
- Reconciliation revalidates immutable source evidence inside the transaction and uses database time for expiry and transition guards.
- Events identify reconciliation as their source and cannot be consumed as ordinary agent attempt, provider, hook, memory, delivery-bundle, change-request, merge, deployment, or release-dispatch events.
- A transaction rollback leaves closeout, story status, lifecycle, receipts, and outbox state unchanged while retaining bounded failure diagnostics outside authoritative success state.
- Concurrency and fault-injection tests prove exactly-once settlement, no advisory-lock leakage, no partial transition, and zero calls to provider, hook, memory, delivery, merge, and deployment adapters.

### W1-007
Reconcile pg-boss v10 live/archive transport state with canonical PostgreSQL run authority. Recovery must infer no semantic success from transport disappearance and must never resurrect a terminal or superseded generation.

**Acceptance criteria**
- Recovery distinguishes queued, active, archived-completed, archived-failed, expired, missing, and duplicate jobs while treating Rorca application rows as canonical.
- An archived or missing job can prompt bounded reconciliation/redispatch only when the canonical run state and unconsumed fenced packet permit it; it cannot rerun passed stories.
- Explicit queue creation is verified before send, pg-boss UUID rules are respected, and a null send result fails closed with durable diagnostics.
- Worker restart drains bounded recovery pages and cannot mark a run done from a transport completion alone.
- Local PostgreSQL tests seed live and archive fixtures and prove crash/restart, duplicate, stale-fence, missing-partition, and null-send behavior.

### W1-008
Stabilize explicit-draft Forge, public-contract generation, MCP discovery, provider-neutral delivery reads, and packaged Pi extension outputs so the reviewed source tree, generated assets, and installed package expose the same canonical create/readiness/workflow/reconciliation/local-review-bundle contracts without backend drafting or untracked package drift.

**Acceptance criteria**
- Two clean local builds of the public contract, MCP tool inventory, Pi extension package, and any checked generated artifacts are byte-identical or differ only in explicitly excluded non-authoritative metadata.
- The packaged Forge skill uses generation-context plus rorca_create_spec/persist, carries contextUsed/contextSummary and explicit post-save policy, and never routes normal authoring through backend generation.
- Generated OpenAPI/MCP surfaces include reviewed closeout and safe local-review-bundle read operations at the intended tier while reconciliation apply and bundle creation remain separately human-authorized and non-public as required.
- Source, package tarball, installed-package smoke, and MCP discovery tests agree on tool names, request schemas, body limits, provider-neutral delivery defaults, and explicit no-approve/no-run/no-merge/no-deploy behavior.
- Contract stability, Swagger coverage, license/open-core boundaries, package smoke, and git diff --check pass locally without publication or provider access.

### W1-009
Make DB-backed validation self-identifying and fail closed unless it uses a fresh PostgreSQL 16 test database owned by the dedicated non-superuser test role. Produce a bounded independent review packet covering Forge/MCP, closeout, reconciliation, transport recovery, provider-neutral local delivery, security, and side-effect exclusions.

**Acceptance criteria**
- The test harness rejects shared, production-like, wrong-owner, wrong-database, and non-test connection targets before applying migrations or fixtures.
- A fresh uniquely named PostgreSQL 16 database owned by the dedicated test role applies all canonical migrations and runs the targeted DB-backed suites without production data or credentials.
- Validation has a documented CI-independent local command set covering typecheck, focused unit/integration tests, public contract, Swagger tiers, package reproducibility, gitleaks, and git diff --check.
- An independent reviewer not authoring the implementation records findings against authority, races, path/CSRF, side-effect isolation, retry/recovery, and deny-listed-run protections; all P0/P1 findings are resolved or block the gate.
- The review packet records exact source SHA, commands, tool versions, database identity/owner in redacted form, results, and unresolved limitations without claiming deployment readiness.

### W1-010
After W1-001 through W1-009 local implementation gates are complete, exercise the default LocalReviewBundleAdapter only against an isolated local proof fixture. Finalize one immutable content-addressed review bundle without any GitHub, PAT, remote account, webhook, network provider, merge, deployment, or live-run authority; GitHub remains an optional uninvoked adapter.

**Acceptance criteria**
- The versioned rorca.delivery-adapter.v1 catalog selects LocalReviewBundleAdapter as the canonical default with requiresNetwork=false and requiresCredentials=false, while the existing GitHub App path remains available only as an explicit optional provider and is not contacted by the local flow.
- One bounded local bundle binds workspace/spec/story/run/attempt/generation, exact repository/base/head/branch/worktree identity, canonical spec and story revisions, changed-file before/after hashes, patch artifact hash, host validation receipts, evidence references, creation timestamp, adapter/version, content hash, and idempotency key.
- Only exact host-observed attempt, closeout, commit, and validation receipts may project validation passed; agent prose, PTY, process exit, memory, and caller fields cannot author pass, and every bundle states mergeStatus=not_authorized, deploymentStatus=not_authorized, mergeAuthority=none, and deploymentAuthority=none.
- Focused tests prove exact replay idempotency, changed-replay audit, database and filesystem immutability, restart recovery, corruption detection, stale-SHA rejection, path and symlink containment, secret and size fail-closed behavior, bounded redaction, atomic content addressing, and zero provider/network calls.
- A safe public read model supports Rorca, Hermes/MCP, Pi Workbench, and the packaged Pi extension without raw patch bytes, changed paths, host paths, credentials, or transcripts; creation stays behind an authorized human-admin boundary, frontend calls use apiFetch/design tokens, and protected Genesis run 20260316000549 is rejected before reads.
- An independent reviewer who did not author the change verifies the exact source/spec hashes, criteria traceability, local no-provider posture, optional-GitHub regression coverage, immutable bundle lineage, no merge/deploy authority, and the complete validation packet before Wave 1 is considered gated.

## Success metrics
- W1-001: A checked contract fixture records the exact implementation baseline Git SHA, spec revision identity, allowed isolated proof-fixture identity, and the explicit deny-listed Genesis run 20260316000549.
- W1-001: Every Wave 1 reconciliation or delivery-proof selector rejects run 20260316000549 before loading run evidence or acquiring a mutation lock, and a regression test proves zero reads and zero writes against that identity.
- W1-001: Baseline, workspace, canonical spec path, and repository mismatches return typed fail-closed diagnostics and do not enqueue jobs or invoke providers, hooks, memory writes, delivery writes, merge, or deployment.
- W1-001: The gate documents that proof run 20260316000550 remains ineligible for reconciliation until separately reviewed code is merged and deployed by authorized humans; this spec grants neither authority.
- W1-001: Focused contract tests and git diff --check run locally without CI services or network providers and report the deny-list and baseline checks as passed.
- W1-002: The host persists a versioned attempt envelope with run/story/attempt/generation identity, exact canonical spec path and revision/hash, exact repository and Git SHA, worktree identity, runtime identity, and host-observed timestamps.
- W1-002: Agent text, PTY output, exit code, memory, and caller-supplied evidence cannot overwrite host-observed identity or promote an attempt to passed.
- W1-002: A changed spec revision, moved canonical path, changed Git SHA, reused generation, or mismatched worktree is preserved as immutable conflicting evidence and blocks closeout.
- W1-002: Duplicate delivery of the same envelope is idempotent; a payload change under the same identity is rejected and audited.
- W1-002: DB-backed tests cover success, nonzero exit, timeout, cancellation, crash, stale generation, duplicate, and revision-mismatch envelopes.
- W1-003: Exit zero without complete exact-revision story evidence cannot produce passed, done, release eligibility, lifecycle completion, or a successful Check Run.
- W1-003: Nonzero exit, rejected promise, lost worktree, cancellation, unresolved conflict, missing evidence, and stale revision settle to explicit failed, cancelled, blocked, or reconciliation-required states rather than ambiguous success.
- W1-003: Previously passed stories are carried forward only from exact compatible durable evidence and are never re-executed merely to repair aggregate closeout.
- W1-003: Run View and API status derive from authoritative closeout rows and explicit story evidence, not process state, PTY text, positional inference, or memory.
- W1-003: Focused backend and frontend tests cover contradictory exit/evidence combinations and distinguish run-level status from story-level status.
- W1-004: Cancellation is durably requested, acknowledged by the active fenced runtime generation, and terminalized without a late completion overwriting cancellation.
- W1-004: Retries compute the smallest safe scope from exact evidence, exclude passed stories, preserve failed worktrees, and cannot reuse a consumed approval, preview, lease, or launch token.
- W1-004: Duplicate pg-boss delivery, worker restart, and concurrent retry requests yield at most one executing generation under a PostgreSQL fence.
- W1-004: Singleton and sequential execution use isolated host-created worktrees where required, never dirty the source checkout, and preserve conflict/crash evidence for review.
- W1-004: Local DB-backed adversarial tests cover cancellation races, lease loss, duplicate delivery, archived transport recovery, crash-before-launch, crash-after-result, and retry of mixed passed/failed stories.
- W1-005: Preview performs no mutation and returns a deterministic hash over workspace, run, exact spec revision/path, Git SHA, immutable evidence IDs/hashes, proposed transitions, exclusions, and expiry.
- W1-005: Apply accepts only the exact unexpired preview packet and authorized human receipt, then re-resolves the same canonical workspace/path/run and revalidates every evidence hash before mutation.
- W1-005: Canonical path traversal, symlink escape, alternate encoding, cross-workspace run, malformed CSRF/origin, expired preview, replayed receipt, and changed evidence are rejected before locking or mutation.
- W1-005: The API uses AppError subclasses plus explicit Swagger tier/rationale and the frontend uses apiFetch and existing design tokens.
- W1-005: Route, library, CSRF, path, expiry, replay, and time-of-check/time-of-use tests run against a local isolated test database without GitHub or CI.
- W1-006: One documented lock order covers run, closeout, story evidence, and lifecycle composition; concurrent apply, retry, cancellation, and worker closeout either serialize or fail closed without deadlock.
- W1-006: Reconciliation revalidates immutable source evidence inside the transaction and uses database time for expiry and transition guards.
- W1-006: Events identify reconciliation as their source and cannot be consumed as ordinary agent attempt, provider, hook, memory, delivery-bundle, change-request, merge, deployment, or release-dispatch events.
- W1-006: A transaction rollback leaves closeout, story status, lifecycle, receipts, and outbox state unchanged while retaining bounded failure diagnostics outside authoritative success state.
- W1-006: Concurrency and fault-injection tests prove exactly-once settlement, no advisory-lock leakage, no partial transition, and zero calls to provider, hook, memory, delivery, merge, and deployment adapters.
- W1-007: Recovery distinguishes queued, active, archived-completed, archived-failed, expired, missing, and duplicate jobs while treating Rorca application rows as canonical.
- W1-007: An archived or missing job can prompt bounded reconciliation/redispatch only when the canonical run state and unconsumed fenced packet permit it; it cannot rerun passed stories.
- W1-007: Explicit queue creation is verified before send, pg-boss UUID rules are respected, and a null send result fails closed with durable diagnostics.
- W1-007: Worker restart drains bounded recovery pages and cannot mark a run done from a transport completion alone.
- W1-007: Local PostgreSQL tests seed live and archive fixtures and prove crash/restart, duplicate, stale-fence, missing-partition, and null-send behavior.
- W1-008: Two clean local builds of the public contract, MCP tool inventory, Pi extension package, and any checked generated artifacts are byte-identical or differ only in explicitly excluded non-authoritative metadata.
- W1-008: The packaged Forge skill uses generation-context plus rorca_create_spec/persist, carries contextUsed/contextSummary and explicit post-save policy, and never routes normal authoring through backend generation.
- W1-008: Generated OpenAPI/MCP surfaces include reviewed closeout and safe local-review-bundle read operations at the intended tier while reconciliation apply and bundle creation remain separately human-authorized and non-public as required.
- W1-008: Source, package tarball, installed-package smoke, and MCP discovery tests agree on tool names, request schemas, body limits, provider-neutral delivery defaults, and explicit no-approve/no-run/no-merge/no-deploy behavior.
- W1-008: Contract stability, Swagger coverage, license/open-core boundaries, package smoke, and git diff --check pass locally without publication or provider access.
- W1-009: The test harness rejects shared, production-like, wrong-owner, wrong-database, and non-test connection targets before applying migrations or fixtures.
- W1-009: A fresh uniquely named PostgreSQL 16 database owned by the dedicated test role applies all canonical migrations and runs the targeted DB-backed suites without production data or credentials.
- W1-009: Validation has a documented CI-independent local command set covering typecheck, focused unit/integration tests, public contract, Swagger tiers, package reproducibility, gitleaks, and git diff --check.
- W1-009: An independent reviewer not authoring the implementation records findings against authority, races, path/CSRF, side-effect isolation, retry/recovery, and deny-listed-run protections; all P0/P1 findings are resolved or block the gate.
- W1-009: The review packet records exact source SHA, commands, tool versions, database identity/owner in redacted form, results, and unresolved limitations without claiming deployment readiness.
- W1-010: The versioned rorca.delivery-adapter.v1 catalog selects LocalReviewBundleAdapter as the canonical default with requiresNetwork=false and requiresCredentials=false, while the existing GitHub App path remains available only as an explicit optional provider and is not contacted by the local flow.
- W1-010: One bounded local bundle binds workspace/spec/story/run/attempt/generation, exact repository/base/head/branch/worktree identity, canonical spec and story revisions, changed-file before/after hashes, patch artifact hash, host validation receipts, evidence references, creation timestamp, adapter/version, content hash, and idempotency key.
- W1-010: Only exact host-observed attempt, closeout, commit, and validation receipts may project validation passed; agent prose, PTY, process exit, memory, and caller fields cannot author pass, and every bundle states mergeStatus=not_authorized, deploymentStatus=not_authorized, mergeAuthority=none, and deploymentAuthority=none.
- W1-010: Focused tests prove exact replay idempotency, changed-replay audit, database and filesystem immutability, restart recovery, corruption detection, stale-SHA rejection, path and symlink containment, secret and size fail-closed behavior, bounded redaction, atomic content addressing, and zero provider/network calls.
- W1-010: A safe public read model supports Rorca, Hermes/MCP, Pi Workbench, and the packaged Pi extension without raw patch bytes, changed paths, host paths, credentials, or transcripts; creation stays behind an authorized human-admin boundary, frontend calls use apiFetch/design tokens, and protected Genesis run 20260316000549 is rejected before reads.
- W1-010: An independent reviewer who did not author the change verifies the exact source/spec hashes, criteria traceability, local no-provider posture, optional-GitHub regression coverage, immutable bundle lineage, no merge/deploy authority, and the complete validation packet before Wave 1 is considered gated.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

