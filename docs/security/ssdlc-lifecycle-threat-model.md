# SSDLC lifecycle authority threat model

**Scope:** Rorca lifecycle planning, evidence normalization, decisions, story closeout/pass reconciliation, retry dispatch, lifecycle reads, Hermes mediation, GitHub/GitReins observations, staging, and production proof.

**Security objective:** lifecycle state advances only from current, workspace-scoped, policy-authorized, durable facts. Agent prose, UI state, unavailable integrations, and advisory systems are never advancement authority.

## Assets and authorities

| Asset | Canonical authority | Non-authoritative inputs |
|---|---|---|
| Workspace/spec/run/story identity | Workspace-scoped PostgreSQL rows plus canonical spec path/revision | Guessed IDs, request-body workspace aliases, prompt text |
| Compiled lifecycle plan | Current `ssdlc_compiled_plans` row bound to workspace/spec/input hash | Agent-edited plans, stale UI plans, retry/worker payload copies |
| Evidence ledger | Normalized append-only `ssdlc_lifecycle_evidence` written by host adapters, exact Hermes adapter, or authenticated manual QA | Agent success text, browser claims, screenshots alone, Duckbrain/session cache |
| Approval/override state | Immutable `ssdlc_decisions`, authenticated principal, active policy, exact subject, expiry/revocation state | Request-body actor/role/trust, unmediated model waivers, stale approvals |
| Standing PR-delivery authority | Disabled-by-default immutable `autonomous_delivery_policies`, exact digest activation, one-way revocation, bounded low/medium risk, expiry | UI toggle state, model request, body actor, high/critical risk, deployment permission |
| GitHub PR evidence | Append-only `github_pr_delivery_evidence` bound to workspace/run/repo/PR/branch/full head SHA and active policy digest | PR title/body text, stale approval, mutable branch name alone, caller-supplied repository/PR |
| Autonomous reviewed merge | Existing worker's persisted `autonomous_pr_deliveries` state plus exact provider/Lifecycle/decision snapshot and append-only merged-SHA evidence | Direct `autoMerge`, queue payload, model output, clean worktree, old green snapshot |
| Story pass | Accepted closeout decision for the current immutable manifest/revisions, then the narrow pass reconciler | `story_passed` event text, direct file mutation, process exit 0 |
| Retry scope | Signed, expiring preview identity plus exact preview/spec scope comparison | Worker payload options, stale preview, prompt/provider fields |
| Release lineage | Exact commit -> artifact digest -> deployment ID evidence chain | Branch name, mutable tag, successful command text, unbound deployment claim |
| Liveness | DB run state plus bounded host process/activity/completion observations | PID existence alone, old output, agent heartbeat claim |
| Secrets | Redacted canonical payloads and bounded references | Raw terminal/provider/chat payloads |

Rorca's canonical database and host observations are authoritative only within the checks above. Pi proposes work and completion but cannot approve or pass it. Hermes may mediate provider evidence and delegated human decisions only through its exact authenticated principal. GitHub, GitReins, staging, and deployment systems provide observations; their availability or success does not itself mutate phase status. Human manual QA is authenticated and auditable but cannot select commit/artifact/deployment lineage.

## Trust boundaries

1. **Browser/CLI/Pi -> Rorca routes.** All IDs, actor fields, modes, status, trust, previews, and provider labels are hostile. Routes derive principals server-side, reject unknown/bounded fields, and scope repository queries by workspace.
2. **Hermes -> Rorca evidence/decision ingress.** Only `hermes@rorca.internal` with admin role receives automated adapter authority. An internal-looking suffix, scheduler token identity, body actor, trust downgrade/upgrade, or delegated identity is insufficient. Delegation is accepted only for authenticated Hermes decisions and remains recorded separately from Hermes itself.
3. **Agent/provider process -> host runner.** Prompt output, completion packets, QA/Journey mode, tool requests, and no-code claims are proposals. The immutable execution manifest fixes tools, working directory, scope, merge/deploy capability, revisions, and evidence expectations before execution.
4. **External provider -> normalized evidence.** Payloads are bounded and redacted. Stable source IDs are immutable per workspace; exact replay is a no-op and conflicting replay is a typed, audited conflict. Subject and release lineage must match current phase identities.
5. **Database commit -> WAL/SSE.** Durable state is canonical. WAL metadata is persisted before publication; SSE is only invalidation. Replaying evidence/mutations after a crash republishes bounded invalidation without duplicating lifecycle truth.
6. **Filesystem/Git/process/PTY -> reconciliation.** These are host observations with explicit availability. Missing or contradictory observations block or remain unknown; they do not default to pass.
7. **Lifecycle database -> dashboard/API reads.** Workspace, plan, evidence, decisions, runs, learn candidates, traceability, phase detail, and inspector source state are read in one PostgreSQL `REPEATABLE READ READ ONLY` snapshot. Actions carrying an older snapshot receive `409 refresh_required`.
8. **Rorca -> GitHub observer/merge actuator.** Rorca derives repository, PR number, branch, policy, risk, and workspace credential from canonical state. Observation reads PR identity before and after checks/reviews/comparison. The only write is the existing worker's narrow exact-SHA PR merge after current Lifecycle authorization; deployment and direct/local merge remain separate.
9. **Recovery agent -> isolated PR worktree.** Queue payloads carry no authority/secrets. CI recovery reuses the existing pipeline runner with host-owned push and a command guard denying remote/network/merge operations. Conflict recovery uses the persisted configured agent and exact conflict-file containment; host code owns fetch, commit, and push.

## Concrete attacker actions and mitigations

| Attack | Required behavior / mitigation | Regression surface |
|---|---|---|
| Guess a plan/evidence/decision/spec/run ID from another workspace | Every repository lookup includes workspace; mixed run/workspace is rejected or returns not found. No fallback unscoped lookup. | lifecycle route/repository tests; evidence/decision/pass reconciler tests |
| Supply `actor`, role, authority, trust level, provider label, or forged Hermes delegation | Actor/principal/trust come from authenticated request context. Only exact Hermes can submit automated evidence or mediate delegation; internal services cannot approve. | `lifecycle-evidence.test.ts`, `lifecycle-decisions.test.ts`, `ssdlc-decisions.test.ts` |
| Arm autonomy by creating a policy, model request, body toggle, stale digest, or replayed request | Creation always yields `disabled`; activation is admin-only, idempotent, exact-digest, literal-confirmed, expiry-checked, and audited. High/critical risk and deployment authority are database-denied. | `autonomous-delivery-policy.test.ts`, `delivery-governance.test.ts`, autonomous-delivery migration test |
| Swap repository/PR/branch/SHA or reuse stale reviews/checks | Observer derives repo/PR/branch from canonical run/workspace, requires a full expected SHA, rejects provider identity drift, compares base freshness, re-reads PR/policy after collection, keeps unresolved change requests blocking, and makes duplicate/missing/truncated/mismatched evidence ineligible. | `github-pr-delivery-evidence.test.ts`, autonomous-delivery migration test |
| Treat old green evidence as current after same-SHA regression | Latest aggregate PR observation supersedes the prior same-source gate fact; non-passing snapshots are warning evidence and revoke policy authority. Decision high-water marks include revocation time. | phase evaluator and autonomous-delivery lifecycle tests |
| Merge through direct mode or a forged queue payload | Only completed `pr` routing can queue the strict UUID/SHA worker payload. The worker reloads run/policy/risk/plan/PR/agent/budget state; direct/draft/branch-only paths cannot invoke reviewed delivery. | autonomous-delivery worker contract and route tests |
| Merge a changed/unreviewed SHA | Immediate provider re-observation, current Lifecycle evaluation, active exact decision, no pre-Merge blocker, PR/base/head preflight, and GitHub's conditional `sha` merge body are all required. | autonomous PR classification/integration tests |
| Retry CI/conflicts forever or let a model push/merge | Immutable policy snapshots cap attempts and elapsed time. CI recovery requires bounded failure annotations and a clean isolated worktree; conflict repair uses exact paths/configured posture. Guarded agents cannot use normal remote/network/merge commands; host owns push. Every new SHA restarts review. | command guard, resolver, migration, and delivery tests |
| Crash after GitHub merges but before database closeout | `merging` is durable; the worker reconciles provider merged/head/merge-commit truth after error or restart, records one merged-SHA evidence/WAL row, and never sends a second merge. | autonomous PR delivery integration test |
| Use a standing policy for high/unknown/protected risk | Compiler v2 requires explicit risk to select policy Merge. High/critical, missing risk, security-sensitive, and release-operation profiles remain human; worker queue entry independently rechecks. | compiler and delivery classification tests |
| Use an internal-looking identity to claim deployment/GitReins evidence | Suffix matching grants no capability; only exact Hermes automated ingress is accepted. | `lifecycle-evidence.test.ts` |
| Replay a stable source ID with changed payload/workspace/revision | Exact same canonical hash is idempotent; changed immutable payload returns typed conflict and an audit WAL record. Identity uniqueness is workspace-scoped. | `ssdlc-evidence.test.ts`, lifecycle migrations |
| Submit old-revision proof or broken commit/artifact/deployment lineage | Revision mismatch stays visible but gate-ineligible. Build/staging require commit-bound artifact lineage; production requires commit, artifact, and exact deployment binding. | `ssdlc-evidence.test.ts`, phase evaluator tests |
| Let failed/unknown/manual/model evidence choose the active release subject | Only passed host/provider evidence from source-appropriate adapters may select commit/artifact/deployment identity; artifact/deployment selectors require verified lineage. | `ssdlc-lifecycle-authority.test.ts` |
| Bypass a hard gate with N/A, defer, override, duplicate request, direct endpoint, or race ordering | Hard-deny gates reject override. High-risk N/A requires a policy path and approver. Decisions serialize the whole phase overlap and are re-evaluated for expiry/revocation/current subject. Duplicate keys with changed bodies conflict. | `ssdlc-decisions.test.ts`, `lifecycle-decisions.test.ts` |
| Forge accepted closeout, emit `story_passed`, or mutate pass before acceptance | Attempt and decision hashes are verified and bound to one manifest/workspace/spec/run/story/revision. Pass mutation is a narrow transaction-locked false->true projection after accepted closeout; direct/early pass events have no authority. | `story-closeout.test.ts`, `execution-engine-closeout.test.ts`, `ssdlc-pass-reconciler.test.ts` |
| Race parent pass/dependency release or close independent waves together | Reconciler locks the workspace/spec scope, evaluates current dependency DAG, and isolates story identity. A blocked parent cannot release a child; independent accepted stories remain independent in ANSI/PTY scheduling. | pass reconciler, execution closeout, wave/multi-engine tests |
| Tamper retry preview, executable stories, options, or provider payload | Signed preview identity binds original run/hash/expiry. Dispatch recomputes executable scope and refuses mismatch. Governed options are copied from the original canonical run and force safe mode; preview cannot enable auto-merge/deploy/external send/backend Jest. | `retry-governance.test.ts`, `retry-dispatch-contract.test.ts`, retry route tests |
| Tamper manifest through prompt, worker, retry, stale hash, or QA mode | Immutable manifest hash covers identity, revisions, tools, scope, command safety, worktree, merge/deploy capabilities, and evidence expectations. Host runner validates observed commands/results against it. | story closeout and multi-engine lifecycle tests |
| Race compile/evidence/decision/reconcile/retry calls | Compiler/decision/pass use advisory transaction locks and immutable replay checks. Generic lifecycle mutations serialize each workspace/operation/idempotency key through a transaction advisory lock; changed requests conflict. | `lifecycle-mutations.test.ts`, plan/decision/pass tests |
| Crash after durable write but before WAL/SSE | Replay reads canonical state, returns the durable result, and republishes bounded invalidation. Decision WAL is in the decision transaction; SSE never carries lifecycle authority. | `lifecycle-mutations.test.ts`, evidence/decision tests |
| Interleave writes between portfolio, phase, traceability, inspector reads | One repeatable-read snapshot prevents mixed plan/evidence/decision state. Snapshot IDs/high-water marks force stale actions to refresh. | `lifecycle-architecture-boundaries.test.ts`, lifecycle route snapshot tests |
| Leak token/credential canaries through evidence/errors/SSE/progress/screenshots | Free text/details/provenance are sanitized and byte-bounded before hashing/persistence/rendering. WAL/SSE contains IDs/change kind only. Raw output remains behind references; capture/screenshot paths must apply the same redaction contract. | `ssdlc-evidence.test.ts`, `lifecycle-evidence.test.ts`, context safety tests |
| Abuse over-splitting, hidden cross-spec work, circular dependencies, vague stories, fabricated preflight, model waivers, or stale plans | Authoring/compiler validation requires stable stories/requirements/dependencies, rejects cycles and stale material hashes, and makes policy/disposition deterministic. Model output cannot alter hard gates. | forge authoring, plan compiler/service, contracts compiler tests |

## Failure and availability policy

Unavailable evidence never becomes positive evidence:

- **GitHub/GitReins:** no authenticated provider observation means the relevant gate is not started, blocked, or unknown with a collection/retry action. A missing active delivery policy, changed head SHA, stale approval, missing/pending/failing check, truncated response, base-branch drift, or unknown code-owner state is never treated as ready.
- **PTY/process inspection:** `available: false` and `alive: null` remain unknown. PID existence without ownership/activity cannot prove liveness or completion.
- **Graph:** unavailable graph enrichment falls back to bounded non-graph context; it cannot waive dependencies or gates.
- **Staging/deployment:** missing artifact/deployment identity or lineage blocks the phase. A successful browser/CLI message is not production proof.
- **Host validation/credentials:** missing execution evidence or environment/credential blockers are explicit closeout blockers with a next safe action.

Liveness combines recent meaningful host activity, process ownership, durable completion, terminal story state, and blockers. Recent token/output activity prevents false-stalled classification. A process that is missing, unowned, contradictory, or inactive past thresholds cannot remain forever active; it becomes unknown/stalled/orphaned and requires host inspection or recovery. No liveness classification passes a lifecycle gate.

## Red-team findings fixed in LFC-025

1. **Provider authority by email suffix (high):** any admin `*@rorca.internal` was treated as a verified evidence adapter. Fixed by granting automated ingress only to exact Hermes; scheduler/other service identities are blocked.
2. **Concurrent pending mutation execution (high):** duplicate callers could both observe a pending replay row and mutate. Fixed with a transaction-scoped advisory lock plus row lock around claim, replay, mutation, and completion persistence.
3. **Mixed lifecycle read snapshot (high):** plan/evidence/decision/run/learn queries used separate pool snapshots. Fixed with a single repeatable-read, read-only transaction for aggregate and single-spec/detail source reads.
4. **Untrusted release identity selection (high):** newest failed, unknown, manual, or agent-proposed evidence could select active release subjects. Fixed with passed/trust/source/lineage authority checks.
5. **Liveness timestamp poisoning (high):** the configured lookback was not applied and arbitrarily future activity could keep an orphan active. Fixed by accepting meaningful activity only inside the lookback and a 30-second future-skew window, clamping accepted skew to evaluation time.
6. **Legacy/tampered retry options (high):** a truthy but incomplete `effective_options` object crashed retry and the legacy fallback enabled deploy/external-send. Fixed with complete shape validation and fail-closed capabilities (`branch-only`, no auto-merge/deploy/external-send/backend Jest).

Each finding has a focused regression. No unresolved high-severity finding is accepted as ready.

## Residual risk and operating rules

- This local single-user product intentionally bypasses global route auth middleware in some deployments. Lifecycle mutation routes still require the server-populated principal contract; exposing the server remotely without the documented auth boundary is unsupported.
- Hermes/provider authenticity is only as strong as server-side credential custody and exact principal provisioning. Do not share the Hermes credential with scheduler or arbitrary internal services.
- Filesystem and process state cannot be transactionally snapshotted with PostgreSQL. Contradiction or unavailable observation therefore fails closed, and mutating actions must carry the DB snapshot identity and revalidate immutable hashes.
- External screenshots and raw logs are references, not canonical bundles. Operators must not copy raw secret-bearing output into evidence rationale.
- Any newly discovered route with unscoped lifecycle lookup, direct pass mutation, direct SSE write, or caller-controlled authority is a release blocker.
- Autonomous reviewed delivery is distinct from direct `autoMerge`: only the PR steward consumes exact provider evidence and current Lifecycle Merge authority. Direct mode remains unsuitable for reviewed delivery.
- GitHub cannot atomically condition a merge on Rorca's entire database snapshot. Rorca minimizes this distributed race with immediate repeat observation, exact base/head preflight, branch-up-to-date requirements, conditional head SHA, branch protection, durable authorization high-water marks, and post-call reconciliation. Any unprovable outcome remains `merging`/blocked for operator inspection rather than being retried blindly.
- Code-owner policy remains fail-closed while provider verification is `unverified`; operators must not expect that policy to auto-merge until an authoritative code-owner adapter exists.
- Command wrappers and path validation reduce accidental recovery side effects but are not an OS sandbox. Recovery receives no GitHub/database secret, uses an isolated worktree and exact configured posture, and host code revalidates paths/status before the only push. Stronger process/network sandboxing remains defense-in-depth work.
