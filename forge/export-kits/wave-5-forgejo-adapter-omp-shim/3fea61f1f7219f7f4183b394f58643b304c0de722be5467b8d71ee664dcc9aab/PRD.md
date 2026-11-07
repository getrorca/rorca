# Wave 5 — Forgejo Adapter + Oh My Pi Primary Shim — Product Requirements

## Problem
Deliver the behavior defined by the canonical Wave 5 — Forgejo Adapter + Oh My Pi Primary Shim specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- W5-001 — Gate the wave on the exact Wave 2/3/4 packets and clean-room evidence
- W5-002 — Register a repository-scoped Forgejo credential with an exact capability probe
- W5-003 — Serve Forgejo release authority for host-owned draft PR actuation
- W5-004 — Project durable Forgejo commit-status and check-run evidence
- W5-005 — Bridge host-verified federation results to Forgejo draft PR and status at the exact head
- W5-006 — Ingest Forgejo webhook events with HMAC verification
- W5-007 — Run the managed executor through Oh My Pi (omp) as the primary shim
- W5-008 — Wire the managed continuation controller into production with an omp lane
- W5-009 — Verify the rorca extension and skills under omp and reconcile the DMS omp-adapter branch
- W5-010 — Conform and certify the adapter against the operator's real Forgejo instance

## In scope
- Start W5-002..W5-009 only after the separately merged, independently reviewed Wave 2, Wave 3, Wave 4 packets and the W4-014 real-host clean-room certificates are complete at exact compatible revisions. Wave 5 is sequential; no overlap with another implementation wave is permitted.
- Implement a bounded Forgejo credential provider replacing the GitHub App JWT/installation flow with Forgejo-native token authentication: a repository-scoped token (or OAuth2 application credential) bound per workspace, verified by an exact capability probe, never stored raw, and rotatable without rewriting historical identity.
- Mirror the GitHub release-authority seam (backend/src/lib/release-authority.ts + release-identity.ts) over the Forgejo API: host-owned draft pull-request creation, release intents, canonical-PR assertion, quarantine, reconcile, and drain, all under exact per-purpose locks and identity revalidation.
- Mirror the durable Check Run projector (backend/src/lib/check-run-poster.ts) over Forgejo commit statuses (context rorca/pipeline, pending/success/failure, target_url to the run view), driven by the same trusted WAL events with a 30-second reconcile discipline; optionally project Forgejo Actions check runs behind the same interface.
- Close the W4-010 residual for Forgejo: a host-verified Wave 4 result proposal (head-exact, changed-path manifest-verified) triggers the release-intent path that projects a Forgejo draft PR and commit status at the exact proposed head. The projection is evidence, not authority.
- Extend the reviewed webhook surface with Forgejo webhooks: HMAC-SHA256 verification (X-Forgejo-Signature and X-Gitea-Signature), exact-path mounting, and pull_request/push/status event ingestion with immutable audit.
- Add an OmpManagedExecutor implementing the ROR-28 ExecutionAdapter interface: launch omp (--mode rpc or --print text fallback) with the translated story contract, sanitized environment, capability-snapshot admission, and the same fence/hash evidence discipline as the pi-backed executor.
- Activate the built-but-unwired PiManagedContinuationController and NormativeContinuationLane (Wave 3A design surface) in worker/service/routes with an omp continuation lane, and add omp as an execution-engine agent kind beside claude/opencode/codex/pi.
- Make the rorca-pi-extension fully omp-native (omp.extensions/omp.skills manifests), verify all five rorca skills load and run under omp, port the main-only omp provenance tools (rorca_record_subagent_run, rorca_select_workspace, omp-subagent:<agent>) onto the wave branch, and reconcile the user-owned feat/dms-omp-adapter-20260804 branch.
- Operator-owned lane: run conformance, real-host clean-room certification, and a bounded pilot demonstration (federated result -> Forgejo draft PR + commit status at the exact head) against the operator's Forgejo server, mirroring the W4-014 clean-room and W4-010 demo discipline.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### W5-001
Start W5-002..W5-009 only after the separately merged, independently reviewed Wave 2, Wave 3, Wave 4 packets and the W4-014 real-host clean-room certificates are complete at exact compatible revisions. Wave 5 is sequential; no overlap with another implementation wave is permitted.

**Acceptance criteria**
- The gate binds exact Wave 2/3/4 spec revisions, implementation/integration SHAs, ledger receipts, conformance results, independent review verdicts, and the clean-room certificate hashes (docs/wave4-cleanroom-certificates.json + realhost certificate) as committed artifacts, never self-asserted literals.
- The repository head contains all reviewed waves with no unresolved shared-file or contract-version conflict.
- Missing, stale, changed, revoked, incompatible, ambiguous, or self-asserted prerequisite evidence blocks dispatch before mutation.
- The scheduler rejects Wave 5 overlap with any other active implementation wave.
- The gate grants no merge, deployment, production, provider-human, or lifecycle-decision authority.

### W5-002
Implement a bounded Forgejo credential provider replacing the GitHub App JWT/installation flow with Forgejo-native token authentication: a repository-scoped token (or OAuth2 application credential) bound per workspace, verified by an exact capability probe, never stored raw, and rotatable without rewriting historical identity.

**Acceptance criteria**
- The provider binds workspace, repository owner/name, token digest, scope/profile metadata, status, expiry, and audit provenance; the raw token never enters the database, API responses, logs, streams, or evidence.
- An exact capability probe (GET /user identity + GET /repos/{owner}/{repo} + bounded write-probe policy) asserts the token can perform ONLY the adapter's required operations on the ONE configured repository; unknown/ambiguous capabilities fail closed.
- Invalid, expired, rotated, cross-workspace, or over-scoped credentials fail before any PR/status projection or release intent mutation.
- The provider grants no merge, deployment, production, provider-human, or lifecycle-decision authority and is revocable without side effects.
- Authentication, capability-probe, rotation, revocation, replay, and redaction tests pass against a hermetic gitea-compatible fake server fixture.

### W5-003
Mirror the GitHub release-authority seam (backend/src/lib/release-authority.ts + release-identity.ts) over the Forgejo API: host-owned draft pull-request creation, release intents, canonical-PR assertion, quarantine, reconcile, and drain, all under exact per-purpose locks and identity revalidation.

**Acceptance criteria**
- RunMergeStrategy (direct/pr/draft-pr/branch-only) and release-intent preparation behave exactly as the GitHub seam, with draft PRs created via POST /repos/{owner}/{repo}/pulls (draft: true, '[WIP] {specId}' title) on the Forgejo API.
- Every real provider effect (PR creation) is host-owned, wrapped in the exact-purpose actuation lock with identity revalidation, and recorded in pipeline_run_release_intents with immutable audit.
- Reconcile/drain converge on the desired projection; quarantined or asserted-mismatch PRs are never silently rewritten.
- The seam is fully test-covered against the hermetic fake Forgejo server, including idempotent replay, fence conflicts, and failure paths.
- No merge authority is granted by the seam itself; merge remains an explicit operator decision.

### W5-004
Mirror the durable Check Run projector (backend/src/lib/check-run-poster.ts) over Forgejo commit statuses (context rorca/pipeline, pending/success/failure, target_url to the run view), driven by the same trusted WAL events with a 30-second reconcile discipline; optionally project Forgejo Actions check runs behind the same interface.

**Acceptance criteria**
- run_started/run_finished WAL events project pending/success/failure commit statuses on the exact head SHA via POST /repos/{owner}/{repo}/statuses/{sha}; external_id and context are stable and per-run-unique.
- Reconcile converges pending projections within the same bounded window; duplicate or reordered WAL events are idempotent.
- The projector never fabricates statuses without an authority record (release intent or verified result) and never writes to unverified repositories.
- The optional Actions check-run backend satisfies the same projection interface and is gated behind capability detection on the target instance.
- Projection tests pass against the hermetic fake server, including failure, drift, and quarantine paths.

### W5-005
Close the W4-010 residual for Forgejo: a host-verified Wave 4 result proposal (head-exact, changed-path manifest-verified) triggers the release-intent path that projects a Forgejo draft PR and commit status at the exact proposed head. The projection is evidence, not authority.

**Acceptance criteria**
- A host-verified proposal (runtime_asserted claims + host_observed verification, acceptedAsCompletion=false) transitions to release-intent preparation with the exact head, changed-path manifest, and proposal hash bound to the intent.
- The Forgejo draft PR ([WIP] title) and pending/success status are projected at the exact head only after every canonical lineage check (lease, activation, evidence envelope) passes.
- The bridge grants no closeout, merge, deployment, or production authority; the proposal remains proposal-only and the closeout posture stays shared_canonical_resolver_pending.
- Replays and idempotency keys cannot duplicate PRs or statuses; changed-head proposals are rejected before projection.
- The bridge is demonstrated end-to-end against the hermetic fake Forgejo server with a full federated lane (discover -> acquire -> propose -> projection) in an integration test.

### W5-006
Extend the reviewed webhook surface with Forgejo webhooks: HMAC-SHA256 verification (X-Forgejo-Signature and X-Gitea-Signature), exact-path mounting, and pull_request/push/status event ingestion with immutable audit.

**Acceptance criteria**
- Webhook deliveries are verified against the configured per-workspace secret before any handler runs; unverifiable deliveries are rejected with audit records.
- pull_request (opened/synchronize/closed), push, and status events are parsed into canonical, workspace-scoped records with exact repository and SHA identity checks.
- Events can only affect projections for repositories with a verified Forgejo credential binding; cross-repository or unbound events are dropped with audit.
- The route follows the reviewed exact-path webhook overlay constraints (no public exposure change, same bounds and error handling).
- Webhook tests pass against the hermetic fake server, including HMAC failure, replay, and unknown-event paths.

### W5-007
Add an OmpManagedExecutor implementing the ROR-28 ExecutionAdapter interface: launch omp (--mode rpc or --print text fallback) with the translated story contract, sanitized environment, capability-snapshot admission, and the same fence/hash evidence discipline as the pi-backed executor.

**Acceptance criteria**
- OmpManagedExecutor exposes prepare/launch/cancel/observe/revalidateMutation/recover/proposeResult with behavior parity to RorcaManagedExecutor (IPC handshake, fence tokens, hashed output evidence, managed-admission errors).
- The omp spawn contract is explicit: omp --mode rpc --profile rorca --cwd <worktree> --model <resolved> --thinking <level> <story message>, with --mode text --print --no-pty fallback; version and surface are probed at startup and pinned in evidence.
- Environment sanitization removes the same secrets as the pi path plus omp-specific additions; the child receives only the bounded workspace/runtime variables.
- Capability snapshot admission, quota checks, and degradation policy are reused unchanged from ROR-28; no new authority is granted.
- The executor is test-covered with a hermetic fake omp binary (fixture) covering launch, handshake, cancel, crash, and proposal paths.

### W5-008
Activate the built-but-unwired PiManagedContinuationController and NormativeContinuationLane (Wave 3A design surface) in worker/service/routes with an omp continuation lane, and add omp as an execution-engine agent kind beside claude/opencode/codex/pi.

**Acceptance criteria**
- The continuation controller is constructed and invoked from production paths (worker construction site and dispatch handling) with the omp lane adapter; no test-only wiring remains.
- The execution engine accepts an 'omp' agent kind and resolves its binary/args through the generalized launcher (AGENT_BIN resolution) with the --story/--start-from targeting preserved.
- Continuation dispatch, checkpoint consumption, retry-cycle, and cancellation semantics match the tested controller contract exactly; the existing controller test suite passes against the production wiring.
- Fail-closed behavior on missing omp binary, unknown story, or capability mismatch matches the pi path.
- An end-to-end engine test launches a story through the omp kind against a fixture and observes the full managed lifecycle.

### W5-009
Make the rorca-pi-extension fully omp-native (omp.extensions/omp.skills manifests), verify all five rorca skills load and run under omp, port the main-only omp provenance tools (rorca_record_subagent_run, rorca_select_workspace, omp-subagent:<agent>) onto the wave branch, and reconcile the user-owned feat/dms-omp-adapter-20260804 branch.

**Acceptance criteria**
- The extension package declares omp.extensions and omp.skills entries that load under omp v17+ with the legacy pi manifest fallback preserved; a fixture test loads the extension with the omp loader.
- rorca-forge, rorca-forge-run, rorca-retry-planner, rorca-run-operator, and rorca-approve all load and pass their smoke paths under omp; failures are surfaced with actionable errors.
- The mcp-http omp provenance tools (omp-subagent:<agent> provenance) are ported to the wave branch and test-covered.
- The dms-omp-adapter branch is inventoried (durable mission supervisor, canaries, compatibility tests); compatible pieces are ported with clear attribution and conflicting changes are surfaced to the operator, never resolved silently.
- The omp-integrated surface lets an operator drive spec execution from omp (story launch via hermes principal) and observe run status in the Run View.

### W5-010
Operator-owned lane: run conformance, real-host clean-room certification, and a bounded pilot demonstration (federated result -> Forgejo draft PR + commit status at the exact head) against the operator's Forgejo server, mirroring the W4-014 clean-room and W4-010 demo discipline.

**Acceptance criteria**
- Conformance suite runs against the real instance with the operator-provided repository-scoped credential; every API surface the adapter uses is exercised and recorded (draft PR, statuses, webhook signature, capability probe).
- Clean-room real-host certification mirrors the W4-014 packet: per-lane fresh clone + nonce database, sanitized allowlisted env, asserted probes that block on mismatch, credentials redacted from recorded commands and diagnostics, run-scoped cleanup, zero credential leaks verified.
- The pilot demonstration creates ONE draft PR ([WIP]) and ONE status at the exact host-verified head on the operator's repository, records the evidence packet, and stops at merge-ready review evidence.
- No merge, closeout, or production action is performed by the adapter or the demonstration; those remain explicit operator decisions.
- Certificates and the demo packet are committed with valid governed hashes and recorded in the wave ledger.

## Success metrics
- W5-001: The gate binds exact Wave 2/3/4 spec revisions, implementation/integration SHAs, ledger receipts, conformance results, independent review verdicts, and the clean-room certificate hashes (docs/wave4-cleanroom-certificates.json + realhost certificate) as committed artifacts, never self-asserted literals.
- W5-001: The repository head contains all reviewed waves with no unresolved shared-file or contract-version conflict.
- W5-001: Missing, stale, changed, revoked, incompatible, ambiguous, or self-asserted prerequisite evidence blocks dispatch before mutation.
- W5-001: The scheduler rejects Wave 5 overlap with any other active implementation wave.
- W5-001: The gate grants no merge, deployment, production, provider-human, or lifecycle-decision authority.
- W5-002: The provider binds workspace, repository owner/name, token digest, scope/profile metadata, status, expiry, and audit provenance; the raw token never enters the database, API responses, logs, streams, or evidence.
- W5-002: An exact capability probe (GET /user identity + GET /repos/{owner}/{repo} + bounded write-probe policy) asserts the token can perform ONLY the adapter's required operations on the ONE configured repository; unknown/ambiguous capabilities fail closed.
- W5-002: Invalid, expired, rotated, cross-workspace, or over-scoped credentials fail before any PR/status projection or release intent mutation.
- W5-002: The provider grants no merge, deployment, production, provider-human, or lifecycle-decision authority and is revocable without side effects.
- W5-002: Authentication, capability-probe, rotation, revocation, replay, and redaction tests pass against a hermetic gitea-compatible fake server fixture.
- W5-003: RunMergeStrategy (direct/pr/draft-pr/branch-only) and release-intent preparation behave exactly as the GitHub seam, with draft PRs created via POST /repos/{owner}/{repo}/pulls (draft: true, '[WIP] {specId}' title) on the Forgejo API.
- W5-003: Every real provider effect (PR creation) is host-owned, wrapped in the exact-purpose actuation lock with identity revalidation, and recorded in pipeline_run_release_intents with immutable audit.
- W5-003: Reconcile/drain converge on the desired projection; quarantined or asserted-mismatch PRs are never silently rewritten.
- W5-003: The seam is fully test-covered against the hermetic fake Forgejo server, including idempotent replay, fence conflicts, and failure paths.
- W5-003: No merge authority is granted by the seam itself; merge remains an explicit operator decision.
- W5-004: run_started/run_finished WAL events project pending/success/failure commit statuses on the exact head SHA via POST /repos/{owner}/{repo}/statuses/{sha}; external_id and context are stable and per-run-unique.
- W5-004: Reconcile converges pending projections within the same bounded window; duplicate or reordered WAL events are idempotent.
- W5-004: The projector never fabricates statuses without an authority record (release intent or verified result) and never writes to unverified repositories.
- W5-004: The optional Actions check-run backend satisfies the same projection interface and is gated behind capability detection on the target instance.
- W5-004: Projection tests pass against the hermetic fake server, including failure, drift, and quarantine paths.
- W5-005: A host-verified proposal (runtime_asserted claims + host_observed verification, acceptedAsCompletion=false) transitions to release-intent preparation with the exact head, changed-path manifest, and proposal hash bound to the intent.
- W5-005: The Forgejo draft PR ([WIP] title) and pending/success status are projected at the exact head only after every canonical lineage check (lease, activation, evidence envelope) passes.
- W5-005: The bridge grants no closeout, merge, deployment, or production authority; the proposal remains proposal-only and the closeout posture stays shared_canonical_resolver_pending.
- W5-005: Replays and idempotency keys cannot duplicate PRs or statuses; changed-head proposals are rejected before projection.
- W5-005: The bridge is demonstrated end-to-end against the hermetic fake Forgejo server with a full federated lane (discover -> acquire -> propose -> projection) in an integration test.
- W5-006: Webhook deliveries are verified against the configured per-workspace secret before any handler runs; unverifiable deliveries are rejected with audit records.
- W5-006: pull_request (opened/synchronize/closed), push, and status events are parsed into canonical, workspace-scoped records with exact repository and SHA identity checks.
- W5-006: Events can only affect projections for repositories with a verified Forgejo credential binding; cross-repository or unbound events are dropped with audit.
- W5-006: The route follows the reviewed exact-path webhook overlay constraints (no public exposure change, same bounds and error handling).
- W5-006: Webhook tests pass against the hermetic fake server, including HMAC failure, replay, and unknown-event paths.
- W5-007: OmpManagedExecutor exposes prepare/launch/cancel/observe/revalidateMutation/recover/proposeResult with behavior parity to RorcaManagedExecutor (IPC handshake, fence tokens, hashed output evidence, managed-admission errors).
- W5-007: The omp spawn contract is explicit: omp --mode rpc --profile rorca --cwd <worktree> --model <resolved> --thinking <level> <story message>, with --mode text --print --no-pty fallback; version and surface are probed at startup and pinned in evidence.
- W5-007: Environment sanitization removes the same secrets as the pi path plus omp-specific additions; the child receives only the bounded workspace/runtime variables.
- W5-007: Capability snapshot admission, quota checks, and degradation policy are reused unchanged from ROR-28; no new authority is granted.
- W5-007: The executor is test-covered with a hermetic fake omp binary (fixture) covering launch, handshake, cancel, crash, and proposal paths.
- W5-008: The continuation controller is constructed and invoked from production paths (worker construction site and dispatch handling) with the omp lane adapter; no test-only wiring remains.
- W5-008: The execution engine accepts an 'omp' agent kind and resolves its binary/args through the generalized launcher (AGENT_BIN resolution) with the --story/--start-from targeting preserved.
- W5-008: Continuation dispatch, checkpoint consumption, retry-cycle, and cancellation semantics match the tested controller contract exactly; the existing controller test suite passes against the production wiring.
- W5-008: Fail-closed behavior on missing omp binary, unknown story, or capability mismatch matches the pi path.
- W5-008: An end-to-end engine test launches a story through the omp kind against a fixture and observes the full managed lifecycle.
- W5-009: The extension package declares omp.extensions and omp.skills entries that load under omp v17+ with the legacy pi manifest fallback preserved; a fixture test loads the extension with the omp loader.
- W5-009: rorca-forge, rorca-forge-run, rorca-retry-planner, rorca-run-operator, and rorca-approve all load and pass their smoke paths under omp; failures are surfaced with actionable errors.
- W5-009: The mcp-http omp provenance tools (omp-subagent:<agent> provenance) are ported to the wave branch and test-covered.
- W5-009: The dms-omp-adapter branch is inventoried (durable mission supervisor, canaries, compatibility tests); compatible pieces are ported with clear attribution and conflicting changes are surfaced to the operator, never resolved silently.
- W5-009: The omp-integrated surface lets an operator drive spec execution from omp (story launch via hermes principal) and observe run status in the Run View.
- W5-010: Conformance suite runs against the real instance with the operator-provided repository-scoped credential; every API surface the adapter uses is exercised and recorded (draft PR, statuses, webhook signature, capability probe).
- W5-010: Clean-room real-host certification mirrors the W4-014 packet: per-lane fresh clone + nonce database, sanitized allowlisted env, asserted probes that block on mismatch, credentials redacted from recorded commands and diagnostics, run-scoped cleanup, zero credential leaks verified.
- W5-010: The pilot demonstration creates ONE draft PR ([WIP]) and ONE status at the exact host-verified head on the operator's repository, records the evidence packet, and stops at merge-ready review evidence.
- W5-010: No merge, closeout, or production action is performed by the adapter or the demonstration; those remain explicit operator decisions.
- W5-010: Certificates and the demo packet are committed with valid governed hashes and recorded in the wave ledger.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

