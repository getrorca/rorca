<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Runtime conformance requirements

- **Status:** Draft architecture contract
- **Linear:** [ROR-23](https://linear.app/rorca/issue/ROR-23/define-mission-work-package-lease-evidence-and-lifecycle-contracts), [ROR-26](https://linear.app/rorca/issue/ROR-26/pilot-one-federated-runtime-under-a-bounded-execution-lease)

Every managed or federated runtime must pass the same conformance suite before it can execute a governed work package.

## Required behaviors

### Identity and revision

- Bind every attempt to workspace, mission revision, work package, lease, runtime, repository and base SHA.
- Reject an unknown, expired, superseded or fenced lease.
- Reject events/evidence for a different mission revision, repository or attempt.
- Never silently follow a moved branch when an exact SHA is required.

### Scope and authority

- Mutate only allowed paths and repository/worktree boundaries.
- Treat delivery, operational, knowledge and interaction authority as independent capabilities.
- Never broaden its own scope, budget, expiry, allowed paths or delivery authority.
- Submit work-package boundary changes as proposals; submit requirement changes as mission amendments.

### Event ingestion

- Emit stable event IDs and monotonic per-attempt sequence numbers.
- Make duplicate delivery idempotent.
- Reject conflicting reuse of an event identity.
- Treat late events from a completed/fenced attempt as non-authoritative observations.
- Heartbeat establishes liveness only.

### Context checkpoint, retrieval and continuation

- Implement versioned `ContextCheckpoint`, immutable `ContextContinuationPolicyDefinition`, scope-bound `ContextContinuationPolicyActivation`, `RetrievalReceipt`, `ContextBundle[/Delta]`, and `ContinuationDispatch` contracts without runtime-local authority fields.
- Never accept deprecated `ContextEpoch` as input or mutable/current authority. Compatibility is an exact server-generated read projection only; every write rejects and the two-minor/90-day, next-major removal gate is tested.
- Keep required canonical execution context structurally separate from provenance-bound advisory memory; required failure blocks, while advisory outage degrades only when the active policy activation allows it.
- Bind typed trigger idempotency to repository/base/current SHA/worktree, spec/story/criteria, path manifests, validation/root cause, retry phase, execution-turn completion-candidate state, and every other canonical scope field.
- Persist checkpoint/cursor before refresh, enforce token/byte/item/delta-chain bounds, allow stale-base reads only for verified reconstruction, require full-bundle fallback on forbidden/ambiguous differences, and emit telemetry without raw secrets, transcripts, credentials, or authority payloads.
- Before every continuation, verify the active policy activation and Rorca lease, then consume exactly one unexpired dispatch through compare-and-set.
- For compaction, require successful non-aborted `compaction_end` with exact originating turn/generation, later matching `agent_settled`, and Pi retry cycle phase `none|settled|fenced`. A controller-validated execution-turn completion candidate suppresses continuation and submits proposals only; it is not canonical closeout acceptance.
- Spend retries through one PostgreSQL-owned cross-actor budget. Permanent authority/identity/secret/stale/changed-replay failures do not retry; exhaustion quarantines.

### Operational admission and isolation

- Admit a runtime only from current typed capability/dependency-health snapshots that satisfy every required contract feature, freshness, rate-limit, circuit, quota, credential-reference, and fallback constraint. Unknown or stale required health blocks before lease/launch.
- Enforce independently accounted per-workspace and per-runtime CPU, memory, concurrency, event rate, context bytes/tokens, storage, retry, and provider-cost quotas. Exhaustion fences/blocks only the affected scope and cannot establish success.
- Keep supervisor and worker provider identities, credentials, budgets, circuits, processes, and queues in separate failure domains. Conservative managed fallback requires a compatible healthy snapshot and a new attempt/fence; it never transfers authority or credentials.
- Isolate observability authorization, cursors, retention, quotas, labels/partitions, raw-reference access, dashboards, alerts, logs, and errors by workspace and runtime generation; raw prompts, transcripts, unrestricted context, secrets, and human authority payloads never enter ordinary telemetry.
- Implement any operational repair through the governed check/fix and inventory/saga requirements in [`governed-hermes-operations.md`](governed-hermes-operations.md); runtime self-report cannot authorize a fix or destructive cleanup.

### Attempts and evidence

- Separate runtime claims from host observations.
- Bind command/test/artifact/commit evidence to exact revision and attempt.
- Preserve bounded output references and checksums.
- Never infer closeout acceptance from exit zero, terminal prose or a runtime status.

### Cancellation and failure

- Observe cancellation and stop mutation promptly.
- Acknowledge cancellation without declaring success.
- Lease expiry/fencing must prevent stale mutation even if a runtime continues locally.
- Cleanup failure is explicit evidence and never hidden by process exit.

### Credentials

- Receive only scoped credential references/capabilities needed for the attempt.
- Never emit credentials in terminal, events, evidence or artifacts.
- Never persist parent/operator environments or credential stores into the worktree.

## Mandatory adversarial scenarios

1. Duplicate event with identical payload is harmless.
2. Duplicate event ID with changed payload is rejected and audited.
3. Late success after cancellation cannot close work.
4. Expired lease cannot mutate or renew itself.
5. Old fencing token cannot race a replacement attempt.
6. Old mission revision evidence is stale.
7. Wrong repository/base/terminal SHA is rejected.
8. Runtime claim “tests pass” without host observation cannot satisfy validation.
9. Mission amendment invalidates affected prior approval.
10. Terminal stream loss does not change evidence or closeout truth.
11. Reconciliation changes canonical closeout state without triggering ordinary execution/provider side effects.
12. Runtime attempts to expand path, merge, deploy or knowledge authority are denied.
13. Interactive input is denied unless the lease explicitly grants audited local-human input.
14. Successful non-aborted max-output compaction with `willRetry=false`, exact originating turn/generation, and matching settled identity produces one checkpoint/retrieval/authorized same-session continuation.
15. Aborted/failed compaction or wrong-turn/wrong-generation `agent_settled` produces zero dispatch.
16. Pi auto-retry start/end/settled identities suppress controller continuation until the matching retry cycle settles or is fenced.
17. A controller-validated execution-turn completion candidate terminalizes only that turn and submits result/evidence proposals; only canonical closeout can accept story completion.
18. Missing `agent_settled` fences/kills the old generation, restores checkpoint/session cursor, and never creates a second writer.
19. Controller/companion crash before or after retrieval/dispatch, duplicate delivery, and retrieval replay produce at most one dispatched prompt.
20. Changed replay fixtures cover repository, base/current SHA, worktree, spec/story/criteria, path manifests, validation/root cause, retry phase, policy activation, and every trigger-specific field.
21. Verified stale-base reconstruction allows only declared cursor/descendant-Git/validation/restart differences; all forbidden or ambiguous differences require a full bundle.
22. Stale lease/fence/turn/generation/Git/policy activation/bundle/delta/session/cursor and wrong-workspace memory are rejected.
23. Required Rorca-context outage blocks; policy-permitted advisory-memory outage is explicit `degraded` and cannot affect authority.
24. One distributed retry budget prevents storms; permanent conflicts do not retry and exhaustion quarantines.
25. Secret values and human authority payloads are rejected from schemas, identities, keys, logs, telemetry, and errors.
26. Deprecated epoch reads map exactly; every epoch write rejects before mutation; the compatibility-removal gate is executable.
27. Same-session cursor advances after one authorized continuation; no continuation/candidate/terminal fact can establish canonical story/run/lifecycle completion.
28. Stale, missing, rate-limited, circuit-open, or incompatible required dependency capability blocks admission; policy-permitted advisory degradation is explicit.
29. CPU, memory, concurrency, event, context, storage, retry, and provider-cost exhaustion in workspace A cannot consume workspace B's reservation, data, cursor, raw reference, or alert budget.
30. Supervisor-provider failure does not expose supervisor credentials to a worker or silently change the current attempt; a worker-provider failure can use managed fallback only under a new compatible admission and fence.
31. No-change loops reach bounded suspension, accept only authenticated event-driven wake, and cannot oscillate past cooldown/cost limits.
32. Doctor fixes require exact preview/authority/idempotency/postcondition verification; blind deletion, canonical config rewrite, and delete/recreate in place of identity-preserving PATCH are denied.
33. A clean-room fixture reconstructs the lane from exact Git, migrations, database backup/ledger, policy/configuration, secret references, and content-addressed artifacts with no hidden host/runtime-memory prerequisite.

## Pilot exit criterion

Federation is not expanded until both `RorcaManagedExecutor` and the pilot federated adapter pass the suite against identical work packages and the same closeout evaluator.

Compare:

- validated completion time;
- compute/model cost;
- human intervention;
- plan churn;
- duplicate/orphan attempts;
- closeout blocks and false-completion attempts;
- review/remediation iterations.
