# Wave 4 — Bounded Federated Runtime Pilot — Product Requirements

## Problem
Deliver the behavior defined by the canonical Wave 4 — Bounded Federated Runtime Pilot specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- W4-001 — Gate the pilot on Wave 2 and both exact Wave 3 packets
- W4-002 — Register one authenticated external runtime identity
- W4-003 — Serve canonical HTTP lease and work-package contracts
- W4-004 — Provision exact-revision bounded mutation inputs
- W4-005 — Ingest idempotent federated events and activity streams
- W4-006 — Verify proposed results with host-observed evidence
- W4-007 — Require cancellation acknowledgement and governed plan changes
- W4-008 — Fail closed through context, lease, network, runtime, and controller recovery
- W4-009 — Run identical managed-versus-federated continuation conformance and fault injection
- W4-011 — Implement the governed Doctor check/fix controller
- W4-012 — Suspend idle loops with an event-driven cost circuit breaker
- W4-013 — Provision and offboard inventoried provider, runtime, and Forgejo resources
- W4-014 — Certify noisy-neighbor isolation and clean-room reconstruction
- W4-010 — Demonstrate one bounded merge-ready draft PR without release authority

## In scope
- Start ROR-26 only after Wave 2 contracts and the separately integrated, independently reviewed Wave 3A RorcaManagedExecutor and Wave 3B stream packets are complete at exact compatible revisions. Wave 4 is sequential; no overlap with another implementation wave is permitted.
- Implement a bounded registry/credential profile for exactly one pilot external runtime. Identity is workspace-scoped, versioned, rotatable, least-privilege, and separate from operator, GitHub App, database, model-provider, and human approval credentials.
- Expose authenticated HTTP/service operations for the one runtime to discover eligible work, acquire one lease, read its exact work-package/context inputs, renew, and release. MCP is only an optional generated projection and not the federation protocol.
- Give the leased runtime only the exact repository/spec/work-package/context material and bounded mutation paths needed for one work package. Git remains code truth and runtime-provided revisions never override host verification.
- Accept normalized Wave 2 execution events and Wave 3B sequenced activity/PTY telemetry from the leased runtime under bounded batch, sequence, redaction, and backpressure controls.
- Allow the runtime to submit a versioned result proposal and artifact references, then require host verification of lease, repository/worktree, exact changes, validation, and provider projections before canonical evidence/closeout services evaluate it.
- Deliver cancellation to the external runtime and require exact-fence acknowledgement while preserving host expiry/termination authority. Accept plan-change proposals only for human/system review under Wave 2 revision contracts.
- Implement bounded restart/reconciliation for host, Hermes controller/companion, external runtime, canonical-context, and network failures. Recovery follows the same checkpoint/retrieval/one-use-dispatch state machine as RorcaManagedExecutor and cannot infer completion from silence or terminal output.
- Execute the same Wave 2/Wave 3 normative conformance assertions against RorcaManagedExecutor and the one federated Hermes/runtime lane through declared transport/trust adapters on fresh local infrastructure, including the full context-continuation fault matrix.
- Implement operational reconciliation as an explicit detect/classify/propose/authority/execute/verify/outcome/escalate controller. Checks and fixes remain separate and cannot rewrite canonical truth or infer destructive/provider authority.
- Replace autonomous no-change polling with bounded event-driven wake and durable suspension so idle controllers cannot burn provider spend or create overlapping retry loops.
- Implement one canonical workspace-scoped resource inventory and an idempotent staged saga for provider, runtime, and Forgejo provisioning, identity-preserving updates, credential lifecycle, and separately authorized offboarding.
- Fault-inject workspace/runtime resource exhaustion and reconstruct the pilot lane from canonical declared inputs on a fresh isolated host namespace before the final pilot demonstration.
- After conformance and independent review, run exactly one pilot work package through the external runtime to host-verified closeout and a real repository-scoped GitHub App draft PR/Check projection at the exact head. Stop at merge-ready review evidence.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### W4-001
Start ROR-26 only after Wave 2 contracts and the separately integrated, independently reviewed Wave 3A RorcaManagedExecutor and Wave 3B stream packets are complete at exact compatible revisions. Wave 4 is sequential; no overlap with another implementation wave is permitted.

**Acceptance criteria**
- The gate binds exact Wave 2 contract/migration hashes and exact Wave 3A/3B spec revisions, implementation/integration SHAs, conformance results, independent reviews, and compatibility versions.
- The repository head contains both reviewed Wave 3 integrations with no unresolved shared-file or contract-version conflict.
- Missing, stale, changed, revoked, incompatible, ambiguous, or self-asserted prerequisite evidence blocks pilot work and dispatch before mutation.
- The scheduler rejects Wave 4 overlap with ROR-28, ROR-25, any second federated runtime, or any other active implementation wave.
- The gate grants no merge, deployment, production, provider-human, or lifecycle-decision authority.

### W4-002
Implement a bounded registry/credential profile for exactly one pilot external runtime. Identity is workspace-scoped, versioned, rotatable, least-privilege, and separate from operator, GitHub App, database, model-provider, and human approval credentials.

**Acceptance criteria**
- The pilot configuration permits exactly one named runtime ID and binds credential/key version, workspace, allowed contract versions, network endpoint, mutation bounds, status, and audit provenance.
- Secrets are encrypted/restricted at rest, redacted from APIs/logs/streams/evidence, delivered only to the authentication boundary, and rotatable without rewriting historical identity.
- Unknown, disabled, rotated, expired, cross-workspace, or impersonated runtime credentials fail before lease or work-package disclosure.
- The runtime receives no PostgreSQL, GitHub App, provider-human, model-provider, merge, deployment, or control-plane credentials.
- Authentication, rotation, revocation, replay, cross-tenant, and redaction tests pass with a local pilot fixture.

### W4-003
Expose authenticated HTTP/service operations for the one runtime to discover eligible work, acquire one lease, read its exact work-package/context inputs, renew, and release. MCP is only an optional generated projection and not the federation protocol.

**Acceptance criteria**
- Responses use exact Wave 2 MissionContract, work-package revision, execution lease, policy definition/activation, checkpoint/receipt/bundle/dispatch, repository revision, version, and idempotency contracts without runtime-specific authority fields; deprecated epoch may appear only on its authenticated read-only compatibility route.
- One atomic acquire returns work only when dependencies/gates pass and no active lease exists; polling or duplicate requests cannot create duplicate execution.
- Renew/release require exact runtime, lease/fence, work-package/spec/story revision, policy activation, repository/base/current SHA/worktree, and database expiry time; epoch or caller-supplied projection identity is rejected before mutation.
- Routes enforce strict schema, TLS/auth boundary, AppError handling, Swagger tier/rationale, body/rate/time bounds, and immutable audit records.
- MCP discovery may expose permitted generated reads but cannot substitute for HTTP authentication, lease fencing, event/result ingestion, or cancellation acknowledgement.

### W4-004
Give the leased runtime only the exact repository/spec/work-package/context material and bounded mutation paths needed for one work package. Git remains code truth and runtime-provided revisions never override host verification.

**Acceptance criteria**
- Lease input binds repository/base/current SHA/worktree, spec/story/criteria/path, work-package revision, validation plan, branch-only posture, active policy activation, checkpoint/receipt and verified bundle; no deprecated epoch hash is authoritative.
- The host verifies base/head and changed paths before launch/result acceptance; short SHA, alternate remote, symlink/path escape, submodule drift, dirty base, or forbidden mutation fails closed.
- Runtime work occurs in one isolated disposable worktree/clone identity and cannot access another workspace or the source checkout.
- Context, plan, path, validation/root-cause, policy activation, or scope changes require a typed checkpoint/trigger and where required a new proposal/revision/lease; runtime and compatibility projection cannot self-amend authority.
- Adversarial path, Git identity, revision drift, dirty worktree, forbidden-file, and context mismatch tests preserve artifacts without integration.

### W4-005
Accept normalized Wave 2 execution events and Wave 3B sequenced activity/PTY telemetry from the leased runtime under bounded batch, sequence, redaction, and backpressure controls.

**Acceptance criteria**
- Every event/stream batch binds runtime, mission/work-package/spec/story/attempt, lease/fence, policy activation, checkpoint, originating turn/generation/session/cursor, repository/base/current SHA/worktree/path, validation/root-cause, schema/idempotency, sequence range, and payload hash; deprecated epoch writes reject.
- Identical replay is idempotent; changed replay, stale/expired/cancelled fence, wrong runtime/revision/context/generation, sequence conflict, and unsupported version are rejected and audited.
- Payload/rate/sequence windows, compression bounds, retention, redaction, and backpressure prevent unbounded resource use while preserving explicit gaps.
- Terminal and activity data remain observability only and cannot mutate evidence, closeout, lifecycle, approval, Check conclusion, merge, or deployment.
- DB-backed tests cover partial batches, reconnect, duplicate, out-of-order, gap, event flood, secret payload, restart, and cancellation races.

### W4-006
Allow the runtime to submit a versioned result proposal and artifact references, then require host verification of lease, repository/worktree, exact changes, validation, and provider projections before canonical evidence/closeout services evaluate it.

**Acceptance criteria**
- A result proposal binds exact work-package/spec/story/attempt/lease/policy-activation/checkpoint/repository/worktree/path/validation identity, changed-path hash, claimed validations, artifact hashes, terminal sequence, execution-turn completion-candidate state, outcome claim, and idempotency key.
- The host independently observes Git revision/diff/path bounds, worktree state, required validation results, timestamps, and artifact integrity and stores trust-separated evidence envelopes.
- Runtime claims, exit zero, terminal text, or self-reported tests cannot become host-observed/provider-verified/human evidence.
- Late, stale-fence, revoked activation, changed revision, forbidden path, missing validation, secret/attestation payload, duplicate conflict, or unverifiable result blocks closeout and preserves artifacts.
- The same closeout/lifecycle resolver used by RorcaManagedExecutor evaluates the federated lane; no pilot-specific success shortcut exists.

### W4-007
Deliver cancellation to the external runtime and require exact-fence acknowledgement while preserving host expiry/termination authority. Accept plan-change proposals only for human/system review under Wave 2 revision contracts.

**Acceptance criteria**
- Cancellation requests are durable, exact-attempt/fence-bound, visible in the stream, retried with bounded backoff, and acknowledged idempotently by the same runtime generation.
- Missing acknowledgement reaches lease expiry and blocks all later events/results; contradictory or late acknowledgement remains non-authoritative evidence.
- Plan-change proposals bind base revision and exact diff/hash, rationale, impact, paths, dependencies, validation, and context changes but perform no canonical mutation.
- Scope expansion, autonomous story mutation, forbidden paths, provider registry change, merge/deploy request, and replayed/stale proposals are rejected.
- Tests cover acknowledged cancellation, unreachable runtime, expiry, late result, duplicate ack, restart, accepted/rejected/stale proposal, and no self-authorization.

### W4-008
Implement bounded restart/reconciliation for host, Hermes controller/companion, external runtime, canonical-context, and network failures. Recovery follows the same checkpoint/retrieval/one-use-dispatch state machine as RorcaManagedExecutor and cannot infer completion from silence or terminal output.

**Acceptance criteria**
- Recovery classifies successful/aborted/failed compaction, waiting/mismatched settled, Pi retry started/ended/settled, completion-candidate observed/rejected/validated/submitted, checkpoint/retrieval/delta-full-fallback/continuation, network, cancellation, result, closeout, expired/superseded/quarantined/conflicting states from canonical records.
- Only the same authenticated runtime/session with active lease/fence, active policy activation, matching turn/generation/cursor and repository/base/current SHA/worktree/path plus verified bundle may resume; takeover revokes prior unused authorization and stale results.
- Crash before retrieval/dispatch CAS resumes identical idempotent work; crash after CAS observes/reconciles only. Changed replay is permanent/audited, consumes no retry, and cannot cause a nonce key or duplicate continuation.
- Missing or mismatched agent_settled reaches policy timeout, fences/verifies old process-group death, restores session/cursor in a new generation, refreshes canonical context, and permits no second writer/prompt source.
- Only successful non-aborted compaction with exact originating turn/generation and Pi retry phase none/settled/fenced may continue; controller-validated execution-turn candidate suppresses continuation and submits proposals, not closeout acceptance.
- Stale-base delta is read only for verified permitted cursor/descendant-Git/validation/fenced-restart reconstruction; policy/lease/session/repository/worktree/base/spec/story/path ambiguity forces a new full bundle.
- Required Rorca/context outage blocks; permitted advisory outage degrades; secret/authority/wrong-workspace/stale failures are permanent. One PostgreSQL retry budget spans host/API/worker/Hermes/controller/companion/runtime and exhaustion quarantines.
- Restart, partition, duplicate, expiry/renew race, stale scope, replay, partial batch/result, and crash produce at most one eligible execution and deterministic proposal/closeout posture without inferring success.
- Ambiguity preserves redacted bounded artifact/stream/evidence/checkpoint/activation/receipt/dispatch/retry-budget references without relaunch, duplicate prompt, old-context fallback, merge/deploy, success inference, or unbounded retry.

### W4-009
Execute the same Wave 2/Wave 3 normative conformance assertions against RorcaManagedExecutor and the one federated Hermes/runtime lane through declared transport/trust adapters on fresh local infrastructure, including the full context-continuation fault matrix.

**Acceptance criteria**
- Both lanes pass the same normative assertions, with transport/trust adapters only, for mission/work-package, lease, policy definition/activation/revocation, typed triggers, checkpoint/receipt/bundle/delta/dispatch, events, result/evidence/closeout distinction, retries/quarantine, authorization, versions, and recovery.
- A successful max-output compaction fixture records status success, aborted=false, willRetry=false, originating turn/generation and later matching agent_settled, then proves exactly one Rorca-authorized same-session continuation/cursor advance.
- Aborted/failed compaction and wrong-turn/wrong-generation settled fixtures prove zero retrieval authorization/dispatch/prompt.
- Pi retry start/end/settled fixtures prove zero controller continuation while started/ended and eligibility only after matching settled/fenced; retry identity cannot splice generations.
- Execution-turn completion candidate observed/rejected/validated/submitted fixtures prove controller validation terminalizes only that turn and proposes evidence/results; only canonical closeout may accept story completion.
- Crash/replay fixtures around retrieval and dispatch CAS produce zero or one eligible dispatch and never two prompts; changed replay covers repository/base/current SHA/worktree/spec/story/criteria/path/validation/root-cause/retry/policy/trigger fields and is non-retryable.
- Delta fixtures prove the narrow verified stale-base exception and byte-exact target reconstruction; every forbidden/ambiguous difference, corrupt/missing base, or chain overflow proves mandatory full-bundle fallback.
- Stale lease/fence/turn/generation/Git/policy activation/bundle/delta/session/cursor and wrong-workspace inputs reject; required outage blocks and permitted advisory outage is explicit degraded.
- Distributed retry fixtures prove one database budget, one in-flight retry, bounded backoff/expiry, permanent conflict suppression, aggregate exhaustion, and quarantine across all actors.
- Secret values, credentials, raw prompts/transcripts, human attestations/signatures, and unrestricted context reject from schemas/keys/logs/errors; deprecated epoch reads map exact identities while every write rejects and removal gate executes.
- Both lanes prove one active writer/process/prompt, same-session cursor advancement, and no story/run/lifecycle promotion from terminal/activity/retrieval/continuation/candidate/federated self-report.
- A CI-independent recipe runs fresh dedicated-owner PostgreSQL 16 migrations, managed/fake/federated fixtures, fault tests, typecheck, contract/Swagger/tier/license/Hermes docs checks, gitleaks and diff checks; independent architecture/security review resolves all P0/P1.

### W4-011
Implement operational reconciliation as an explicit detect/classify/propose/authority/execute/verify/outcome/escalate controller. Checks and fixes remain separate and cannot rewrite canonical truth or infer destructive/provider authority.

**Acceptance criteria**
- Every check and fix definition has stable IDs, exact workspace/subject/revision, typed condition/severity/capability, evidence source and freshness, expected precondition/postcondition, and immutable definition hash.
- Each invocation persists detect, classify, propose, authority, bounded execute, verify, outcome, and escalate transitions; a fixture proves no transition may skip proposal, authority, or independent postcondition verification.
- Auto-fix admits only explicitly classified rebuildable projections or fenced ephemeral runtime state; canonical mission/spec/evidence/closeout/lifecycle/human decisions and immutable artifacts are observe-only.
- Every mutation defaults to dry-run and requires an unexpired exact preview, complete idempotency key, one fence, maximum attempts, wall-clock/provider-cost/resource budget, rate limit, and cooldown.
- Identical replay returns the prior result, changed replay is permanently rejected and audited, overlapping controller/cron delivery shares one PostgreSQL lock and aggregate retry/cost budget, and exhaustion quarantines.
- Verification re-observes the declared postcondition independently; command exit, runtime prose, heartbeat, and raw test count cannot produce fixed or healthy outcome.
- Each mutating definition declares compensation; failed or indeterminate execute/verify records compensated, indeterminate, or quarantined and escalates one safe next action without widening scope.
- Audit projections are append-only, redacted, bounded, and workspace-scoped and expose no raw prompt, transcript, secret, credential, human signature, merge, deployment, or provider authority.

### W4-012
Replace autonomous no-change polling with bounded event-driven wake and durable suspension so idle controllers cannot burn provider spend or create overlapping retry loops.

**Acceptance criteria**
- The idle policy has versioned no-change tick, elapsed-time, token/request/currency, retry, exponential-sleep, jitter, cooldown, and wake-source limits with explicit hard maxima.
- A deterministic fixture crosses each hard limit and atomically sets only the scoped controller to suspended, releases nonessential reservations, emits one redacted escalation, and performs zero further provider requests.
- Only an authenticated relevant canonical event, webhook, lease deadline, or explicit operator request may request wake; heartbeat, terminal output, and elapsed cron alone cannot resume work.
- Wake revalidates dependency capability health, workspace/runtime quotas, lease/fence, policy, session/cursor, cooldown, and single-writer identity before one new loop iteration.
- Repeated wake/suspend oscillation opens a scoped circuit and requires governed operator review; duplicate wake delivery is idempotent and cannot create concurrent loops.
- Suspension and wake are operational observations only and cannot cancel canonical work silently, discard diagnostics, mark completion, or grant provider, merge, deployment, or approval authority.

### W4-013
Implement one canonical workspace-scoped resource inventory and an idempotent staged saga for provider, runtime, and Forgejo provisioning, identity-preserving updates, credential lifecycle, and separately authorized offboarding.

**Acceptance criteria**
- Each inventory row binds workspace, resource type, immutable external ID, exact owner labels, provider/account/region, desired and observed revision, credential-reference identity, dependencies, retention class, timestamps, and lifecycle status.
- Discovery without exact ownership labels and canonical inventory linkage is an observation only; unknown, shared, referenced, or ambiguous resources become quarantined and produce zero deletion or config rewrite.
- Provisioning stages validate authority/capability health, reserve quota, create or exactly adopt, configure by identity-preserving PATCH/update, verify, record inventory, and admit, with an idempotency identity over complete material input.
- Every completed provisioning stage declares compensation and an indeterminate branch; retry reconciles exact external identity/request hash and cannot create a replacement when provider outcome is unprovable.
- Offboarding separately authorizes and stages revoke-admission, fence/quarantine, verify no active lease/dispatch, rotate/revoke scoped credentials, archive retained evidence, detach dependencies, preview cleanup, execute cleanup, and verify inventory.
- Delete/recreate is rejected when identity-preserving PATCH/update exists; replacement requires an explicit new-identity saga with lineage, revalidation, compensation, and review.
- Credential fixtures cover proactive expiry rotation, compromise revocation, bounded overlap, provider 401, and rollback without storing plaintext env/JSON secrets or rewriting historical identity.
- Local fake-provider/Forgejo fixtures cover duplicate calls, partial success, timeout, stale inventory, unknown resource, active lease, shared dependency, failed compensation, and offboard replay with zero real provider mutation.

### W4-014
Fault-inject workspace/runtime resource exhaustion and reconstruct the pilot lane from canonical declared inputs on a fresh isolated host namespace before the final pilot demonstration.

**Acceptance criteria**
- Fault fixtures independently exhaust CPU, memory, execution/continuation concurrency, event rate, context bytes/tokens, storage bytes/objects, retry spend, provider token/currency, raw-reference, retention, and alert budgets in workspace A.
- For every exhaustion fixture workspace B retains its reservations, admission, cursor/replay window, archive/raw-reference access, status planes, and alerts with zero data, secret, credential, or authority leakage.
- The clean-room fixture begins with empty caches/projections/runtime homes and reconstructs only from exact Git SHA, PostgreSQL migrations plus verified backup/ledger, versioned policy/configuration, vault secret references, and content-addressed artifacts.
- Hidden home files, ambient environment, mutable host cron, undocumented SSH state, preserved containers, projection databases, and runtime-local/advisory memory are each removed and proven unnecessary or cause a typed block.
- Reconstruction proves migration and public-contract generation, inventory reconciliation, queue/outbox recovery, lease/fence/retry scans, artifact integrity, context continuation safety, all seven status planes, and policy-permitted optional-dependency degradation.
- The certificate binds source/migration/contract/spec/artifact hashes, tool versions, exact commands, bounded redacted host observations, unresolved blockers, and cleanup; raw test counts and successful command text are not certification.
- The same fault and reconstruction assertions run for managed and one fake federated lane through transport/trust adapters only and produce no provider, merge, deployment, approval, or production mutation.
- An independent architecture/security/operations review of one exact packet is required before W4-010; any hidden-state, cross-workspace, resource-isolation, secret, or authority finding blocks the final demonstration.

### W4-010
After conformance and independent review, run exactly one pilot work package through the external runtime to host-verified closeout and a real repository-scoped GitHub App draft PR/Check projection at the exact head. Stop at merge-ready review evidence.

**Acceptance criteria**
- The pilot packet identifies one runtime, mission/work-package/spec/story, lease/fence/generation, active policy activation, checkpoint/receipt/bundle/dispatch lineage, exact base/head/worktree/path/validation scope, and canonical closeout; deprecated epoch is absent as authority.
- Host-verified passed closeout may project one branch and draft PR plus App-owned Check Run through existing GitHub App authority; no PAT, gh/manual-PR, or human-user substitute is allowed.
- Independent reviewers can verify exact-SHA diff, path bounds, conformance/validation evidence, lease/fence history, stream integrity, cancellation posture, closeout policy, and provider ownership from redacted immutable references.
- Any provider/runtime/validation/revision/evidence ambiguity leaves the pilot blocked and performs no fallback publication or success promotion.
- The pilot cannot auto-merge, deploy, mutate production, expand to a second runtime, productize always-on Hermes, autonomously mutate stories, expand the provider registry, or implement execution-graph ROR-31.
- A final independent review packet records exact commands/results and residual limits; merge and deployment remain separate explicit human actions outside this spec.

## Success metrics
- W4-001: The gate binds exact Wave 2 contract/migration hashes and exact Wave 3A/3B spec revisions, implementation/integration SHAs, conformance results, independent reviews, and compatibility versions.
- W4-001: The repository head contains both reviewed Wave 3 integrations with no unresolved shared-file or contract-version conflict.
- W4-001: Missing, stale, changed, revoked, incompatible, ambiguous, or self-asserted prerequisite evidence blocks pilot work and dispatch before mutation.
- W4-001: The scheduler rejects Wave 4 overlap with ROR-28, ROR-25, any second federated runtime, or any other active implementation wave.
- W4-001: The gate grants no merge, deployment, production, provider-human, or lifecycle-decision authority.
- W4-002: The pilot configuration permits exactly one named runtime ID and binds credential/key version, workspace, allowed contract versions, network endpoint, mutation bounds, status, and audit provenance.
- W4-002: Secrets are encrypted/restricted at rest, redacted from APIs/logs/streams/evidence, delivered only to the authentication boundary, and rotatable without rewriting historical identity.
- W4-002: Unknown, disabled, rotated, expired, cross-workspace, or impersonated runtime credentials fail before lease or work-package disclosure.
- W4-002: The runtime receives no PostgreSQL, GitHub App, provider-human, model-provider, merge, deployment, or control-plane credentials.
- W4-002: Authentication, rotation, revocation, replay, cross-tenant, and redaction tests pass with a local pilot fixture.
- W4-003: Responses use exact Wave 2 MissionContract, work-package revision, execution lease, policy definition/activation, checkpoint/receipt/bundle/dispatch, repository revision, version, and idempotency contracts without runtime-specific authority fields; deprecated epoch may appear only on its authenticated read-only compatibility route.
- W4-003: One atomic acquire returns work only when dependencies/gates pass and no active lease exists; polling or duplicate requests cannot create duplicate execution.
- W4-003: Renew/release require exact runtime, lease/fence, work-package/spec/story revision, policy activation, repository/base/current SHA/worktree, and database expiry time; epoch or caller-supplied projection identity is rejected before mutation.
- W4-003: Routes enforce strict schema, TLS/auth boundary, AppError handling, Swagger tier/rationale, body/rate/time bounds, and immutable audit records.
- W4-003: MCP discovery may expose permitted generated reads but cannot substitute for HTTP authentication, lease fencing, event/result ingestion, or cancellation acknowledgement.
- W4-004: Lease input binds repository/base/current SHA/worktree, spec/story/criteria/path, work-package revision, validation plan, branch-only posture, active policy activation, checkpoint/receipt and verified bundle; no deprecated epoch hash is authoritative.
- W4-004: The host verifies base/head and changed paths before launch/result acceptance; short SHA, alternate remote, symlink/path escape, submodule drift, dirty base, or forbidden mutation fails closed.
- W4-004: Runtime work occurs in one isolated disposable worktree/clone identity and cannot access another workspace or the source checkout.
- W4-004: Context, plan, path, validation/root-cause, policy activation, or scope changes require a typed checkpoint/trigger and where required a new proposal/revision/lease; runtime and compatibility projection cannot self-amend authority.
- W4-004: Adversarial path, Git identity, revision drift, dirty worktree, forbidden-file, and context mismatch tests preserve artifacts without integration.
- W4-005: Every event/stream batch binds runtime, mission/work-package/spec/story/attempt, lease/fence, policy activation, checkpoint, originating turn/generation/session/cursor, repository/base/current SHA/worktree/path, validation/root-cause, schema/idempotency, sequence range, and payload hash; deprecated epoch writes reject.
- W4-005: Identical replay is idempotent; changed replay, stale/expired/cancelled fence, wrong runtime/revision/context/generation, sequence conflict, and unsupported version are rejected and audited.
- W4-005: Payload/rate/sequence windows, compression bounds, retention, redaction, and backpressure prevent unbounded resource use while preserving explicit gaps.
- W4-005: Terminal and activity data remain observability only and cannot mutate evidence, closeout, lifecycle, approval, Check conclusion, merge, or deployment.
- W4-005: DB-backed tests cover partial batches, reconnect, duplicate, out-of-order, gap, event flood, secret payload, restart, and cancellation races.
- W4-006: A result proposal binds exact work-package/spec/story/attempt/lease/policy-activation/checkpoint/repository/worktree/path/validation identity, changed-path hash, claimed validations, artifact hashes, terminal sequence, execution-turn completion-candidate state, outcome claim, and idempotency key.
- W4-006: The host independently observes Git revision/diff/path bounds, worktree state, required validation results, timestamps, and artifact integrity and stores trust-separated evidence envelopes.
- W4-006: Runtime claims, exit zero, terminal text, or self-reported tests cannot become host-observed/provider-verified/human evidence.
- W4-006: Late, stale-fence, revoked activation, changed revision, forbidden path, missing validation, secret/attestation payload, duplicate conflict, or unverifiable result blocks closeout and preserves artifacts.
- W4-006: The same closeout/lifecycle resolver used by RorcaManagedExecutor evaluates the federated lane; no pilot-specific success shortcut exists.
- W4-007: Cancellation requests are durable, exact-attempt/fence-bound, visible in the stream, retried with bounded backoff, and acknowledged idempotently by the same runtime generation.
- W4-007: Missing acknowledgement reaches lease expiry and blocks all later events/results; contradictory or late acknowledgement remains non-authoritative evidence.
- W4-007: Plan-change proposals bind base revision and exact diff/hash, rationale, impact, paths, dependencies, validation, and context changes but perform no canonical mutation.
- W4-007: Scope expansion, autonomous story mutation, forbidden paths, provider registry change, merge/deploy request, and replayed/stale proposals are rejected.
- W4-007: Tests cover acknowledged cancellation, unreachable runtime, expiry, late result, duplicate ack, restart, accepted/rejected/stale proposal, and no self-authorization.
- W4-008: Recovery classifies successful/aborted/failed compaction, waiting/mismatched settled, Pi retry started/ended/settled, completion-candidate observed/rejected/validated/submitted, checkpoint/retrieval/delta-full-fallback/continuation, network, cancellation, result, closeout, expired/superseded/quarantined/conflicting states from canonical records.
- W4-008: Only the same authenticated runtime/session with active lease/fence, active policy activation, matching turn/generation/cursor and repository/base/current SHA/worktree/path plus verified bundle may resume; takeover revokes prior unused authorization and stale results.
- W4-008: Crash before retrieval/dispatch CAS resumes identical idempotent work; crash after CAS observes/reconciles only. Changed replay is permanent/audited, consumes no retry, and cannot cause a nonce key or duplicate continuation.
- W4-008: Missing or mismatched agent_settled reaches policy timeout, fences/verifies old process-group death, restores session/cursor in a new generation, refreshes canonical context, and permits no second writer/prompt source.
- W4-008: Only successful non-aborted compaction with exact originating turn/generation and Pi retry phase none/settled/fenced may continue; controller-validated execution-turn candidate suppresses continuation and submits proposals, not closeout acceptance.
- W4-008: Stale-base delta is read only for verified permitted cursor/descendant-Git/validation/fenced-restart reconstruction; policy/lease/session/repository/worktree/base/spec/story/path ambiguity forces a new full bundle.
- W4-008: Required Rorca/context outage blocks; permitted advisory outage degrades; secret/authority/wrong-workspace/stale failures are permanent. One PostgreSQL retry budget spans host/API/worker/Hermes/controller/companion/runtime and exhaustion quarantines.
- W4-008: Restart, partition, duplicate, expiry/renew race, stale scope, replay, partial batch/result, and crash produce at most one eligible execution and deterministic proposal/closeout posture without inferring success.
- W4-008: Ambiguity preserves redacted bounded artifact/stream/evidence/checkpoint/activation/receipt/dispatch/retry-budget references without relaunch, duplicate prompt, old-context fallback, merge/deploy, success inference, or unbounded retry.
- W4-009: Both lanes pass the same normative assertions, with transport/trust adapters only, for mission/work-package, lease, policy definition/activation/revocation, typed triggers, checkpoint/receipt/bundle/delta/dispatch, events, result/evidence/closeout distinction, retries/quarantine, authorization, versions, and recovery.
- W4-009: A successful max-output compaction fixture records status success, aborted=false, willRetry=false, originating turn/generation and later matching agent_settled, then proves exactly one Rorca-authorized same-session continuation/cursor advance.
- W4-009: Aborted/failed compaction and wrong-turn/wrong-generation settled fixtures prove zero retrieval authorization/dispatch/prompt.
- W4-009: Pi retry start/end/settled fixtures prove zero controller continuation while started/ended and eligibility only after matching settled/fenced; retry identity cannot splice generations.
- W4-009: Execution-turn completion candidate observed/rejected/validated/submitted fixtures prove controller validation terminalizes only that turn and proposes evidence/results; only canonical closeout may accept story completion.
- W4-009: Crash/replay fixtures around retrieval and dispatch CAS produce zero or one eligible dispatch and never two prompts; changed replay covers repository/base/current SHA/worktree/spec/story/criteria/path/validation/root-cause/retry/policy/trigger fields and is non-retryable.
- W4-009: Delta fixtures prove the narrow verified stale-base exception and byte-exact target reconstruction; every forbidden/ambiguous difference, corrupt/missing base, or chain overflow proves mandatory full-bundle fallback.
- W4-009: Stale lease/fence/turn/generation/Git/policy activation/bundle/delta/session/cursor and wrong-workspace inputs reject; required outage blocks and permitted advisory outage is explicit degraded.
- W4-009: Distributed retry fixtures prove one database budget, one in-flight retry, bounded backoff/expiry, permanent conflict suppression, aggregate exhaustion, and quarantine across all actors.
- W4-009: Secret values, credentials, raw prompts/transcripts, human attestations/signatures, and unrestricted context reject from schemas/keys/logs/errors; deprecated epoch reads map exact identities while every write rejects and removal gate executes.
- W4-009: Both lanes prove one active writer/process/prompt, same-session cursor advancement, and no story/run/lifecycle promotion from terminal/activity/retrieval/continuation/candidate/federated self-report.
- W4-009: A CI-independent recipe runs fresh dedicated-owner PostgreSQL 16 migrations, managed/fake/federated fixtures, fault tests, typecheck, contract/Swagger/tier/license/Hermes docs checks, gitleaks and diff checks; independent architecture/security review resolves all P0/P1.
- W4-011: Every check and fix definition has stable IDs, exact workspace/subject/revision, typed condition/severity/capability, evidence source and freshness, expected precondition/postcondition, and immutable definition hash.
- W4-011: Each invocation persists detect, classify, propose, authority, bounded execute, verify, outcome, and escalate transitions; a fixture proves no transition may skip proposal, authority, or independent postcondition verification.
- W4-011: Auto-fix admits only explicitly classified rebuildable projections or fenced ephemeral runtime state; canonical mission/spec/evidence/closeout/lifecycle/human decisions and immutable artifacts are observe-only.
- W4-011: Every mutation defaults to dry-run and requires an unexpired exact preview, complete idempotency key, one fence, maximum attempts, wall-clock/provider-cost/resource budget, rate limit, and cooldown.
- W4-011: Identical replay returns the prior result, changed replay is permanently rejected and audited, overlapping controller/cron delivery shares one PostgreSQL lock and aggregate retry/cost budget, and exhaustion quarantines.
- W4-011: Verification re-observes the declared postcondition independently; command exit, runtime prose, heartbeat, and raw test count cannot produce fixed or healthy outcome.
- W4-011: Each mutating definition declares compensation; failed or indeterminate execute/verify records compensated, indeterminate, or quarantined and escalates one safe next action without widening scope.
- W4-011: Audit projections are append-only, redacted, bounded, and workspace-scoped and expose no raw prompt, transcript, secret, credential, human signature, merge, deployment, or provider authority.
- W4-012: The idle policy has versioned no-change tick, elapsed-time, token/request/currency, retry, exponential-sleep, jitter, cooldown, and wake-source limits with explicit hard maxima.
- W4-012: A deterministic fixture crosses each hard limit and atomically sets only the scoped controller to suspended, releases nonessential reservations, emits one redacted escalation, and performs zero further provider requests.
- W4-012: Only an authenticated relevant canonical event, webhook, lease deadline, or explicit operator request may request wake; heartbeat, terminal output, and elapsed cron alone cannot resume work.
- W4-012: Wake revalidates dependency capability health, workspace/runtime quotas, lease/fence, policy, session/cursor, cooldown, and single-writer identity before one new loop iteration.
- W4-012: Repeated wake/suspend oscillation opens a scoped circuit and requires governed operator review; duplicate wake delivery is idempotent and cannot create concurrent loops.
- W4-012: Suspension and wake are operational observations only and cannot cancel canonical work silently, discard diagnostics, mark completion, or grant provider, merge, deployment, or approval authority.
- W4-013: Each inventory row binds workspace, resource type, immutable external ID, exact owner labels, provider/account/region, desired and observed revision, credential-reference identity, dependencies, retention class, timestamps, and lifecycle status.
- W4-013: Discovery without exact ownership labels and canonical inventory linkage is an observation only; unknown, shared, referenced, or ambiguous resources become quarantined and produce zero deletion or config rewrite.
- W4-013: Provisioning stages validate authority/capability health, reserve quota, create or exactly adopt, configure by identity-preserving PATCH/update, verify, record inventory, and admit, with an idempotency identity over complete material input.
- W4-013: Every completed provisioning stage declares compensation and an indeterminate branch; retry reconciles exact external identity/request hash and cannot create a replacement when provider outcome is unprovable.
- W4-013: Offboarding separately authorizes and stages revoke-admission, fence/quarantine, verify no active lease/dispatch, rotate/revoke scoped credentials, archive retained evidence, detach dependencies, preview cleanup, execute cleanup, and verify inventory.
- W4-013: Delete/recreate is rejected when identity-preserving PATCH/update exists; replacement requires an explicit new-identity saga with lineage, revalidation, compensation, and review.
- W4-013: Credential fixtures cover proactive expiry rotation, compromise revocation, bounded overlap, provider 401, and rollback without storing plaintext env/JSON secrets or rewriting historical identity.
- W4-013: Local fake-provider/Forgejo fixtures cover duplicate calls, partial success, timeout, stale inventory, unknown resource, active lease, shared dependency, failed compensation, and offboard replay with zero real provider mutation.
- W4-014: Fault fixtures independently exhaust CPU, memory, execution/continuation concurrency, event rate, context bytes/tokens, storage bytes/objects, retry spend, provider token/currency, raw-reference, retention, and alert budgets in workspace A.
- W4-014: For every exhaustion fixture workspace B retains its reservations, admission, cursor/replay window, archive/raw-reference access, status planes, and alerts with zero data, secret, credential, or authority leakage.
- W4-014: The clean-room fixture begins with empty caches/projections/runtime homes and reconstructs only from exact Git SHA, PostgreSQL migrations plus verified backup/ledger, versioned policy/configuration, vault secret references, and content-addressed artifacts.
- W4-014: Hidden home files, ambient environment, mutable host cron, undocumented SSH state, preserved containers, projection databases, and runtime-local/advisory memory are each removed and proven unnecessary or cause a typed block.
- W4-014: Reconstruction proves migration and public-contract generation, inventory reconciliation, queue/outbox recovery, lease/fence/retry scans, artifact integrity, context continuation safety, all seven status planes, and policy-permitted optional-dependency degradation.
- W4-014: The certificate binds source/migration/contract/spec/artifact hashes, tool versions, exact commands, bounded redacted host observations, unresolved blockers, and cleanup; raw test counts and successful command text are not certification.
- W4-014: The same fault and reconstruction assertions run for managed and one fake federated lane through transport/trust adapters only and produce no provider, merge, deployment, approval, or production mutation.
- W4-014: An independent architecture/security/operations review of one exact packet is required before W4-010; any hidden-state, cross-workspace, resource-isolation, secret, or authority finding blocks the final demonstration.
- W4-010: The pilot packet identifies one runtime, mission/work-package/spec/story, lease/fence/generation, active policy activation, checkpoint/receipt/bundle/dispatch lineage, exact base/head/worktree/path/validation scope, and canonical closeout; deprecated epoch is absent as authority.
- W4-010: Host-verified passed closeout may project one branch and draft PR plus App-owned Check Run through existing GitHub App authority; no PAT, gh/manual-PR, or human-user substitute is allowed.
- W4-010: Independent reviewers can verify exact-SHA diff, path bounds, conformance/validation evidence, lease/fence history, stream integrity, cancellation posture, closeout policy, and provider ownership from redacted immutable references.
- W4-010: Any provider/runtime/validation/revision/evidence ambiguity leaves the pilot blocked and performs no fallback publication or success promotion.
- W4-010: The pilot cannot auto-merge, deploy, mutate production, expand to a second runtime, productize always-on Hermes, autonomously mutate stories, expand the provider registry, or implement execution-graph ROR-31.
- W4-010: A final independent review packet records exact commands/results and residual limits; merge and deployment remain separate explicit human actions outside this spec.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

