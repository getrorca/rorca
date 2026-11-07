# Wave 3A — Wrap Current Engine as RorcaManagedExecutor — Product Requirements

## Problem
Deliver the behavior defined by the canonical Wave 3A — Wrap Current Engine as RorcaManagedExecutor specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- W3A-001 — Gate RorcaManagedExecutor work on exact Wave 2 contracts
- W3A-002 — Define ExecutionAdapter and RorcaManagedExecutor boundaries
- W3A-003 — Translate governed work inputs into canonical engine inputs
- W3A-004 — Preserve four-engine symmetry and environment isolation
- W3A-005 — Fence launch, worktree mutation, and duplicate execution
- W3A-006 — Implement the managed context-continuation hook and normalized outputs
- W3A-007 — Preserve bounded retry, cancellation, and passed-story semantics
- W3A-008 — Recover managed attempts after process and worker crashes
- W3A-009 — Prove managed-executor behavioral equivalence and review readiness

## In scope
- Start ROR-28 only from the independently reviewed Wave 2 contract/version/SHA packet. Reserve a separate worktree and ownership zone; ROR-25 is the only permitted concurrent wave and no shared-file overlap may be silently accepted.
- Add a runtime-neutral ExecutionAdapter interface around the canonical service contracts and implement the first adapter named RorcaManagedExecutor. Keep TaskManifest broker, queue transport, lifecycle resolver, release authority, and provider-human decisions outside the adapter.
- Build a deterministic translation from MissionContract, work-package revision, fenced lease, active policy activation, and verified canonical context bundle to existing engine prompt/model/terminal/story/worktree/timeout/retry/branch-only inputs.
- Route Claude, OpenCode, Codex, and Pi through the adapter while retaining the current engine's symmetric tool/output contract, provider-specific invocation, secret stripping, process sandboxing, timeout, output bounds, and cancellation behavior.
- Compose PostgreSQL execution leases with existing launch gates and story-worktree lifecycle. Every process generation must hold the exact active fence before mutation and lose mutation/result eligibility on cancellation, expiry, supersession, or revision drift.
- Implement the Wave 2 checkpoint/retrieval/continuation state machine inside RorcaManagedExecutor around the existing Pi RPC runtime. The managed controller is the sole prompt writer; it emits normalized events and host evidence but canonical Rorca services retain context, lease, closeout, and lifecycle authority.
- Connect adapter cancel/retry operations to existing durable cancellation and governed retry authority without widening scope. Retries use new attempts/fences in preserved worktrees and never rerun exact compatible passes.
- Implement bounded adapter recovery from canonical leases, attempts, worktree state, host evidence, process identity, and transport archive. Recovery resumes observation or reconciliation, never blindly relaunches ambiguous work.
- Run the shared Wave 2 conformance suite and a legacy-versus-adapter equivalence matrix against a fresh local test database, then independently review the safety boundary before integration. Do not auto-merge, deploy, or activate a federated runtime.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### W3A-001
Start ROR-28 only from the independently reviewed Wave 2 contract/version/SHA packet. Reserve a separate worktree and ownership zone; ROR-25 is the only permitted concurrent wave and no shared-file overlap may be silently accepted.

**Acceptance criteria**
- The gate binds the exact accepted Wave 2 spec revision, contract package version/hash, migration head, implementation Git SHA, conformance result, and independent review receipt.
- Missing, stale, changed, unsupported, or self-asserted Wave 2 evidence blocks implementation and dispatch before file mutation.
- The work manifest identifies ROR-28 as one member of the sole allowed ROR-28/ROR-25 parallel pair and rejects any third active implementation wave.
- A deterministic ownership map identifies shared contract/generated files as serialized integration points and fails on overlapping unreviewed edits.
- The gate grants no approval, merge, deployment, production activation, or executor authority.

### W3A-002
Add a runtime-neutral ExecutionAdapter interface around the canonical service contracts and implement the first adapter named RorcaManagedExecutor. Keep TaskManifest broker, queue transport, lifecycle resolver, release authority, and provider-human decisions outside the adapter.

**Acceptance criteria**
- ExecutionAdapter methods consume exact mission/work-package/lease, active policy-activation, checkpoint/receipt/bundle/dispatch inputs and expose prepare, launch, cancel, observe, recover, and propose-result outputs; deprecated epoch is compile-time forbidden.
- RorcaManagedExecutor delegates to current execution-engine entrypoints instead of copying, deleting, or rewriting safety-critical engine logic.
- The interface grants bounded execution only; it cannot approve specs, decide lifecycle gates, issue its own leases, create human receipts, merge, deploy, or mutate provider authority.
- TaskManifest broker remains a dispatch broker and has no structural or nominal compatibility with ExecutionAdapter.
- Architecture and compile-time tests reject dependency inversions from engine/adapter code into lifecycle decision or release authority.

### W3A-003
Build a deterministic translation from MissionContract, work-package revision, fenced lease, active policy activation, and verified canonical context bundle to existing engine prompt/model/terminal/story/worktree/timeout/retry/branch-only inputs.

**Acceptance criteria**
- Translation verifies workspace, canonical spec/story/criteria, repository/base/current SHA, worktree/path scope, runtime, lease fence/expiry, policy definition/activation, checkpoint/receipt/bundle hashes, and secret-reference boundary before launch.
- The same canonical input yields the same normalized engine request hash; unsupported contract versions or ambiguous legacy values fail before spawn.
- Default execution remains sequential with parallelism 1, host-created isolated worktree, autoMerge false, branch-only delivery, and no deployment authority.
- Context injection records exact policy activation, checkpoint, receipt, and bundle identities and labels memory advisory; deprecated epoch, memory, terminal, and runtime claims cannot replace spec/policy/approval material.
- Translation fixtures cover Claude, OpenCode, Codex, Pi, PTY/non-PTY, retries, cancellation, malformed scope, revision drift, and expired leases.
- A typed capability snapshot fixture admits launch only when every required dependency declares a compatible contract version and status healthy or policy-permitted degraded with observedAt, validUntil, rate-limit, circuit, quota, and fallback fields current at admission.
- A required dependency that is missing, stale, unknown, incompatible, unavailable, rate-limited without headroom, circuit-open, or quota-exhausted produces a typed pre-spawn block and zero lease release or child process.
- An advisory dependency may degrade only when the active policy names that dependency and dimension; the normalized request and event projection record the degradation and never replace required context or evidence.
- Runtime/provider selection records the exact capability-snapshot hashes and rejects exception-text, ambient credential, or runtime-self-reported fallback decisions.

### W3A-004
Route Claude, OpenCode, Codex, and Pi through the adapter while retaining the current engine's symmetric tool/output contract, provider-specific invocation, secret stripping, process sandboxing, timeout, output bounds, and cancellation behavior.

**Acceptance criteria**
- All four agents receive equivalent governed mission/lease/policy-activation/bundle identities, allowed tools/path scope, worktree, timeout/cancel fence, and normalized event/result contract without secret or authority payloads.
- Claude child launches continue stripping CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_VERSION, and CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING; equivalent secret minimization remains intact for other agents.
- No adapter path exposes PostgreSQL, GitHub credentials, provider-human receipts, trusted parent environment, or unauthorized network/file paths to the runtime.
- Provider-specific spawn/auth/binary failures become normalized host-observed failures without synthetic success or fallback to another agent.
- Focused symmetry and sandbox tests compare request/evidence fields, cancellation, timeouts, output bounds, and environment redaction for all four agents.
- Supervisor and worker fixtures use distinct principal, credential-reference, provider-budget, rate-limit, circuit, process, and queue identities; neither role can resolve or assume the other role credentials or authority.
- Supervisor-provider failure leaves already fenced workers bounded by their current leases and canonical Rorca/host reconciliation, while worker-provider failure preserves the attempt and host evidence without changing provider under that attempt.
- A conservative RorcaManagedExecutor fallback is admitted only from its own current compatible health/quota snapshot, starts under a new attempt/generation/fence, and retains branch-only, autoMerge false, no-deploy authority.
- No fallback retries an exact compatible passed story, transfers supervisor credentials/budget, or treats provider availability as closeout or lifecycle evidence.

### W3A-005
Compose PostgreSQL execution leases with existing launch gates and story-worktree lifecycle. Every process generation must hold the exact active fence before mutation and lose mutation/result eligibility on cancellation, expiry, supersession, or revision drift.

**Acceptance criteria**
- One atomic preparation path binds attempt/generation/process/worktree, repository/base/current SHA, path manifests, lease fence, policy activation, checkpoint/bundle, and launch token before child release; deprecated epoch is absent.
- Duplicate queue deliveries and concurrent workers can prepare at most one released launch generation for a work-package revision.
- The adapter rechecks fence, expiry, cancellation, worktree cleanliness, and exact revision before launch, commit, result proposal, and closeout handoff.
- Lost fences terminate bounded child processes and preserve worktree/output/evidence without integrating changes or reporting pass.
- Race and fault-injection tests cover duplicate delivery, cancel-before-release, cancel-after-release, lease takeover, dirty worktree, base drift, worker crash, and late result.
- Admission atomically reserves explicit per-workspace and per-runtime CPU, memory, execution/continuation concurrency, event rate, context bytes/tokens, storage bytes/objects, retry spend, and provider token/currency quotas before child release.
- The stricter applicable workspace, runtime, and global hard limit wins; identical reservation replay is idempotent and a changed reservation under the same identity is rejected and audited.
- Hard quota exhaustion blocks admission or fences only the affected workspace/runtime generation, preserves bounded diagnostics/evidence, and cannot be converted to success or borrowed from another workspace.
- Quota observations, raw-reference access, cursor identity, retention, dashboards, alerts, logs, and errors are scoped by workspace/runtime authorization rather than labels alone and exclude raw prompts, transcripts, secrets, and human authority payloads.
- Fault fixtures saturate each quota in workspace A and prove workspace B retains its reserved CPU, memory, concurrency, event, context, storage, retry, provider-cost, and observability capacity with zero data/reference leakage.

### W3A-006
Implement the Wave 2 checkpoint/retrieval/continuation state machine inside RorcaManagedExecutor around the existing Pi RPC runtime. The managed controller is the sole prompt writer; it emits normalized events and host evidence but canonical Rorca services retain context, lease, closeout, and lifecycle authority.

**Acceptance criteria**
- Compile-time interfaces exist for checkpoint store, canonical context client, policy-activation verifier, lease verifier, continuation authorizer, Pi RPC adapter, event sink, aggregate retry budget, and clock; dependency tests preserve one managed prompt writer and forbid deprecated epoch input.
- Before every typed trigger the controller persists exact checkpoint/session/entry cursor with repository/base/current SHA/worktree/path manifests, spec/story/criteria, validation/root-cause, policy definition/activation, turn/generation, retry phase, and completion-candidate state.
- Compaction requires a successful non-aborted end with willRetry=false and exact originating turn/generation, then later matching agent_settled; aborted/failed/unmatched/cross-generation events produce zero retrieval authorization or prompt.
- Pi auto-retry start/end/settled uses one retry-cycle/turn/generation identity; controller continuation is suppressed in started/ended and eligible only in none/settled/fenced after proving no retry remains.
- A controller-validated execution-turn completion candidate suppresses continuation, terminalizes only that turn, and submits result/evidence proposals; it cannot set story/run/lifecycle state and is distinct from canonical closeout acceptance.
- The controller requests canonical retrieval and verifies receipt plus full bundle or Rorca-verified stale-base delta; only permitted cursor/descendant-Git/validation/fenced-restart differences may reconstruct, otherwise it requires a full bundle and never builds required context locally.
- The controller verifies required/advisory status, budgets, redaction, TTL, workspace, source/content hashes, active policy activation and revocation; required/secret/stale/wrong-workspace failure blocks.
- Immediately before send the controller obtains Rorca lease/fence/turn/generation/session/cursor/Git/worktree/policy/bundle verification, consumes one unexpired dispatch CAS, and sends exactly one same-session Pi RPC continuation.
- Continuation settled requires matching authorized turn/generation agent_settled plus new non-empty assistant entry/cursor advance; it records no completion/pass and rejects stale/reused cursor/entry.
- Missing settled reaches fenced timeout, aborts and verifies prior process-group death, increments generation, restores session/checkpoint/cursor, refreshes full canonical context as required, revalidates lease, and starts no replacement while an old writer lives.
- Crash reconciliation resumes identical pre-dispatch work, only observes after dispatch CAS, and cannot produce a second prompt; one PostgreSQL retry budget spans worker/controller/companion/transport actors, permanent conflicts do not retry, and exhaustion quarantines.
- CI-independent fake-Pi/PostgreSQL fixtures cover every trigger/change-replay dimension, successful/aborted/mismatched compaction, retry phases, completion-candidate versus closeout, stale-base/full fallback, crashes, stale scope, secret/authority rejection, outages, wrong-workspace memory, retry-storm suppression, quarantine, and cursor advance.

### W3A-007
Connect adapter cancel/retry operations to existing durable cancellation and governed retry authority without widening scope. Retries use new attempts/fences in preserved worktrees and never rerun exact compatible passes.

**Acceptance criteria**
- Cancellation request is acknowledged by the active runtime generation or expires fail closed; late callbacks cannot overwrite cancellation.
- Retry preview computes the smallest failed/repairable scope from canonical closeout evidence and rejects passed, stale-revision, unapproved, expired, or changed packets.
- Each retry receives a new attempt/generation/lease fence while retaining lineage to original evidence and exact worktree/base revision.
- Timeout, SIGTERM/SIGKILL escalation, output limit, provider error, validation failure, and user cancellation settle to distinct recoverable or terminal diagnostics.
- DB-backed tests prove no passed-story rerun, no packet replay, no duplicate execution, and deterministic cancellation/retry races across all four agents.

### W3A-008
Implement bounded adapter recovery from canonical leases, attempts, worktree state, host evidence, process identity, and transport archive. Recovery resumes observation or reconciliation, never blindly relaunches ambiguous work.

**Acceptance criteria**
- Startup classifies prepared-not-launched, running-live, running-lost, result-persisted, closeout-pending, cancelled, expired, and conflicting attempts from PostgreSQL plus host observations.
- A live correctly fenced process may be reattached/observed; a lost or stale process is terminated or expired and cannot emit authoritative results.
- Persisted exact result/evidence proceeds to idempotent closeout without engine re-execution; ambiguous work preserves artifacts and blocks for reconciliation.
- Recovery is bounded by page, database-owned aggregate retry budget, time, backoff, expiry, and quarantine; permanent replay/stale/authority/secret failures do not retry and pg-boss/process exit cannot imply success.
- Crash-injection tests cover every transaction/launch/result/closeout seam and prove at-most-one execution plus exact evidence retention.

### W3A-009
Run the shared Wave 2 conformance suite and a legacy-versus-adapter equivalence matrix against a fresh local test database, then independently review the safety boundary before integration. Do not auto-merge, deploy, or activate a federated runtime.

**Acceptance criteria**
- The identical normative contract assertions pass for RorcaManagedExecutor across leases, policy activations/revocation, typed triggers, checkpoint/receipt/bundle/delta/dispatch, events, evidence/closeout distinction, retries/quarantine, recovery, authorization, and versions.
- Legacy and adapter lanes produce equivalent canonical outcomes for Claude/OpenCode/Codex/Pi success, failure, timeout, cancel, retry, crash, no-change, dirty worktree, and exact-revision mismatch fixtures.
- A CI-independent recipe runs fresh dedicated-owner PostgreSQL migrations, focused tests, typecheck, public-contract stability, Swagger/license checks, security scan, and git diff --check.
- An independent execution/security reviewer resolves all P0/P1 findings and verifies engine delegation, environment stripping, fence enforcement, no duplicate launch, no passed-story rerun, and no merge/deploy authority.
- The exact-SHA completion packet records shared-file integration coordination with ROR-25; no other parallel work is permitted.
- Conformance fixtures reject stale/unhealthy capability admission, cross-workspace quota borrowing, supervisor/worker credential or budget reuse, same-attempt provider switching, and fallback without a new fence.
- The completion packet reports quota and capability policy versions plus redacted fault outcomes, but records no raw provider credential, prompt, transcript, approval, or provider operation.

## Success metrics
- W3A-001: The gate binds the exact accepted Wave 2 spec revision, contract package version/hash, migration head, implementation Git SHA, conformance result, and independent review receipt.
- W3A-001: Missing, stale, changed, unsupported, or self-asserted Wave 2 evidence blocks implementation and dispatch before file mutation.
- W3A-001: The work manifest identifies ROR-28 as one member of the sole allowed ROR-28/ROR-25 parallel pair and rejects any third active implementation wave.
- W3A-001: A deterministic ownership map identifies shared contract/generated files as serialized integration points and fails on overlapping unreviewed edits.
- W3A-001: The gate grants no approval, merge, deployment, production activation, or executor authority.
- W3A-002: ExecutionAdapter methods consume exact mission/work-package/lease, active policy-activation, checkpoint/receipt/bundle/dispatch inputs and expose prepare, launch, cancel, observe, recover, and propose-result outputs; deprecated epoch is compile-time forbidden.
- W3A-002: RorcaManagedExecutor delegates to current execution-engine entrypoints instead of copying, deleting, or rewriting safety-critical engine logic.
- W3A-002: The interface grants bounded execution only; it cannot approve specs, decide lifecycle gates, issue its own leases, create human receipts, merge, deploy, or mutate provider authority.
- W3A-002: TaskManifest broker remains a dispatch broker and has no structural or nominal compatibility with ExecutionAdapter.
- W3A-002: Architecture and compile-time tests reject dependency inversions from engine/adapter code into lifecycle decision or release authority.
- W3A-003: Translation verifies workspace, canonical spec/story/criteria, repository/base/current SHA, worktree/path scope, runtime, lease fence/expiry, policy definition/activation, checkpoint/receipt/bundle hashes, and secret-reference boundary before launch.
- W3A-003: The same canonical input yields the same normalized engine request hash; unsupported contract versions or ambiguous legacy values fail before spawn.
- W3A-003: Default execution remains sequential with parallelism 1, host-created isolated worktree, autoMerge false, branch-only delivery, and no deployment authority.
- W3A-003: Context injection records exact policy activation, checkpoint, receipt, and bundle identities and labels memory advisory; deprecated epoch, memory, terminal, and runtime claims cannot replace spec/policy/approval material.
- W3A-003: Translation fixtures cover Claude, OpenCode, Codex, Pi, PTY/non-PTY, retries, cancellation, malformed scope, revision drift, and expired leases.
- W3A-003: A typed capability snapshot fixture admits launch only when every required dependency declares a compatible contract version and status healthy or policy-permitted degraded with observedAt, validUntil, rate-limit, circuit, quota, and fallback fields current at admission.
- W3A-003: A required dependency that is missing, stale, unknown, incompatible, unavailable, rate-limited without headroom, circuit-open, or quota-exhausted produces a typed pre-spawn block and zero lease release or child process.
- W3A-003: An advisory dependency may degrade only when the active policy names that dependency and dimension; the normalized request and event projection record the degradation and never replace required context or evidence.
- W3A-003: Runtime/provider selection records the exact capability-snapshot hashes and rejects exception-text, ambient credential, or runtime-self-reported fallback decisions.
- W3A-004: All four agents receive equivalent governed mission/lease/policy-activation/bundle identities, allowed tools/path scope, worktree, timeout/cancel fence, and normalized event/result contract without secret or authority payloads.
- W3A-004: Claude child launches continue stripping CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_VERSION, and CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING; equivalent secret minimization remains intact for other agents.
- W3A-004: No adapter path exposes PostgreSQL, GitHub credentials, provider-human receipts, trusted parent environment, or unauthorized network/file paths to the runtime.
- W3A-004: Provider-specific spawn/auth/binary failures become normalized host-observed failures without synthetic success or fallback to another agent.
- W3A-004: Focused symmetry and sandbox tests compare request/evidence fields, cancellation, timeouts, output bounds, and environment redaction for all four agents.
- W3A-004: Supervisor and worker fixtures use distinct principal, credential-reference, provider-budget, rate-limit, circuit, process, and queue identities; neither role can resolve or assume the other role credentials or authority.
- W3A-004: Supervisor-provider failure leaves already fenced workers bounded by their current leases and canonical Rorca/host reconciliation, while worker-provider failure preserves the attempt and host evidence without changing provider under that attempt.
- W3A-004: A conservative RorcaManagedExecutor fallback is admitted only from its own current compatible health/quota snapshot, starts under a new attempt/generation/fence, and retains branch-only, autoMerge false, no-deploy authority.
- W3A-004: No fallback retries an exact compatible passed story, transfers supervisor credentials/budget, or treats provider availability as closeout or lifecycle evidence.
- W3A-005: One atomic preparation path binds attempt/generation/process/worktree, repository/base/current SHA, path manifests, lease fence, policy activation, checkpoint/bundle, and launch token before child release; deprecated epoch is absent.
- W3A-005: Duplicate queue deliveries and concurrent workers can prepare at most one released launch generation for a work-package revision.
- W3A-005: The adapter rechecks fence, expiry, cancellation, worktree cleanliness, and exact revision before launch, commit, result proposal, and closeout handoff.
- W3A-005: Lost fences terminate bounded child processes and preserve worktree/output/evidence without integrating changes or reporting pass.
- W3A-005: Race and fault-injection tests cover duplicate delivery, cancel-before-release, cancel-after-release, lease takeover, dirty worktree, base drift, worker crash, and late result.
- W3A-005: Admission atomically reserves explicit per-workspace and per-runtime CPU, memory, execution/continuation concurrency, event rate, context bytes/tokens, storage bytes/objects, retry spend, and provider token/currency quotas before child release.
- W3A-005: The stricter applicable workspace, runtime, and global hard limit wins; identical reservation replay is idempotent and a changed reservation under the same identity is rejected and audited.
- W3A-005: Hard quota exhaustion blocks admission or fences only the affected workspace/runtime generation, preserves bounded diagnostics/evidence, and cannot be converted to success or borrowed from another workspace.
- W3A-005: Quota observations, raw-reference access, cursor identity, retention, dashboards, alerts, logs, and errors are scoped by workspace/runtime authorization rather than labels alone and exclude raw prompts, transcripts, secrets, and human authority payloads.
- W3A-005: Fault fixtures saturate each quota in workspace A and prove workspace B retains its reserved CPU, memory, concurrency, event, context, storage, retry, provider-cost, and observability capacity with zero data/reference leakage.
- W3A-006: Compile-time interfaces exist for checkpoint store, canonical context client, policy-activation verifier, lease verifier, continuation authorizer, Pi RPC adapter, event sink, aggregate retry budget, and clock; dependency tests preserve one managed prompt writer and forbid deprecated epoch input.
- W3A-006: Before every typed trigger the controller persists exact checkpoint/session/entry cursor with repository/base/current SHA/worktree/path manifests, spec/story/criteria, validation/root-cause, policy definition/activation, turn/generation, retry phase, and completion-candidate state.
- W3A-006: Compaction requires a successful non-aborted end with willRetry=false and exact originating turn/generation, then later matching agent_settled; aborted/failed/unmatched/cross-generation events produce zero retrieval authorization or prompt.
- W3A-006: Pi auto-retry start/end/settled uses one retry-cycle/turn/generation identity; controller continuation is suppressed in started/ended and eligible only in none/settled/fenced after proving no retry remains.
- W3A-006: A controller-validated execution-turn completion candidate suppresses continuation, terminalizes only that turn, and submits result/evidence proposals; it cannot set story/run/lifecycle state and is distinct from canonical closeout acceptance.
- W3A-006: The controller requests canonical retrieval and verifies receipt plus full bundle or Rorca-verified stale-base delta; only permitted cursor/descendant-Git/validation/fenced-restart differences may reconstruct, otherwise it requires a full bundle and never builds required context locally.
- W3A-006: The controller verifies required/advisory status, budgets, redaction, TTL, workspace, source/content hashes, active policy activation and revocation; required/secret/stale/wrong-workspace failure blocks.
- W3A-006: Immediately before send the controller obtains Rorca lease/fence/turn/generation/session/cursor/Git/worktree/policy/bundle verification, consumes one unexpired dispatch CAS, and sends exactly one same-session Pi RPC continuation.
- W3A-006: Continuation settled requires matching authorized turn/generation agent_settled plus new non-empty assistant entry/cursor advance; it records no completion/pass and rejects stale/reused cursor/entry.
- W3A-006: Missing settled reaches fenced timeout, aborts and verifies prior process-group death, increments generation, restores session/checkpoint/cursor, refreshes full canonical context as required, revalidates lease, and starts no replacement while an old writer lives.
- W3A-006: Crash reconciliation resumes identical pre-dispatch work, only observes after dispatch CAS, and cannot produce a second prompt; one PostgreSQL retry budget spans worker/controller/companion/transport actors, permanent conflicts do not retry, and exhaustion quarantines.
- W3A-006: CI-independent fake-Pi/PostgreSQL fixtures cover every trigger/change-replay dimension, successful/aborted/mismatched compaction, retry phases, completion-candidate versus closeout, stale-base/full fallback, crashes, stale scope, secret/authority rejection, outages, wrong-workspace memory, retry-storm suppression, quarantine, and cursor advance.
- W3A-007: Cancellation request is acknowledged by the active runtime generation or expires fail closed; late callbacks cannot overwrite cancellation.
- W3A-007: Retry preview computes the smallest failed/repairable scope from canonical closeout evidence and rejects passed, stale-revision, unapproved, expired, or changed packets.
- W3A-007: Each retry receives a new attempt/generation/lease fence while retaining lineage to original evidence and exact worktree/base revision.
- W3A-007: Timeout, SIGTERM/SIGKILL escalation, output limit, provider error, validation failure, and user cancellation settle to distinct recoverable or terminal diagnostics.
- W3A-007: DB-backed tests prove no passed-story rerun, no packet replay, no duplicate execution, and deterministic cancellation/retry races across all four agents.
- W3A-008: Startup classifies prepared-not-launched, running-live, running-lost, result-persisted, closeout-pending, cancelled, expired, and conflicting attempts from PostgreSQL plus host observations.
- W3A-008: A live correctly fenced process may be reattached/observed; a lost or stale process is terminated or expired and cannot emit authoritative results.
- W3A-008: Persisted exact result/evidence proceeds to idempotent closeout without engine re-execution; ambiguous work preserves artifacts and blocks for reconciliation.
- W3A-008: Recovery is bounded by page, database-owned aggregate retry budget, time, backoff, expiry, and quarantine; permanent replay/stale/authority/secret failures do not retry and pg-boss/process exit cannot imply success.
- W3A-008: Crash-injection tests cover every transaction/launch/result/closeout seam and prove at-most-one execution plus exact evidence retention.
- W3A-009: The identical normative contract assertions pass for RorcaManagedExecutor across leases, policy activations/revocation, typed triggers, checkpoint/receipt/bundle/delta/dispatch, events, evidence/closeout distinction, retries/quarantine, recovery, authorization, and versions.
- W3A-009: Legacy and adapter lanes produce equivalent canonical outcomes for Claude/OpenCode/Codex/Pi success, failure, timeout, cancel, retry, crash, no-change, dirty worktree, and exact-revision mismatch fixtures.
- W3A-009: A CI-independent recipe runs fresh dedicated-owner PostgreSQL migrations, focused tests, typecheck, public-contract stability, Swagger/license checks, security scan, and git diff --check.
- W3A-009: An independent execution/security reviewer resolves all P0/P1 findings and verifies engine delegation, environment stripping, fence enforcement, no duplicate launch, no passed-story rerun, and no merge/deploy authority.
- W3A-009: The exact-SHA completion packet records shared-file integration coordination with ROR-25; no other parallel work is permitted.
- W3A-009: Conformance fixtures reject stale/unhealthy capability admission, cross-workspace quota borrowing, supervisor/worker credential or budget reuse, same-attempt provider switching, and fallback without a new fence.
- W3A-009: The completion packet reports quota and capability policy versions plus redacted fault outcomes, but records no raw provider credential, prompt, transcript, approval, or provider operation.

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

