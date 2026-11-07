<!--
Copyright (c) 2026 Rorca Inc.
SPDX-License-Identifier: Apache-2.0
Licensed under the Apache License, Version 2.0.
See LICENSE file in the project root for full license text.
-->

# Autonomous reviewed-delivery closeout (items 3–7)

Date: 2026-07-17

Core implementation commit: `ad7a52880e80c6a1f849832d3803df1f99dad6d1`

Recovery secret-scope hardening: commit `e32e2b2d`.

Policy/evidence foundation: `9c406033d45d58ac7e82896bc89f45ce8226e51f`

## Scope and stopping point

This change completes the remaining reviewed-delivery seams:

3. project exact-SHA GitHub facts into existing Lifecycle Validation and Merge gates;
4. authorize and actuate merge only for the unchanged reviewed SHA with current provider and Lifecycle authority;
5. run bounded CI/conflict recovery through existing worker, worktree, and configured-agent boundaries, then require a complete new review cycle;
6. close out one exact merged SHA and WAL event idempotently, including crash reconciliation; and
7. allow standing-policy continuation only for admitted low/medium risk while retaining explicit authenticated human Merge approval for high/critical/protected work.

The authorized stopping point was implementation, isolated validation, documentation, and local commits. No policy was activated in production, no production database was contacted, no branch was pushed, no live PR was modified or merged, no deployment was performed, and no external notification was sent.

## Canonical authority flow

### Lifecycle consumption

- Compiler `ssdlc-plan-compiler-2` assigns the Merge gate `approvalRequirement=policy` only when the plan has an explicit low/medium risk assignment and is not security-sensitive or release-operations.
- Missing risk, high/critical risk, security-sensitive, and release-operations plans retain `approvalRequirement=human`.
- A compiler-version change recompiles identical spec material instead of reusing old gate semantics.
- Stable provider observations become canonical `ssdlc_lifecycle_evidence` through the existing evidence service. Validation receives provider-verified aggregate check evidence. Merge receives separate provider-verified approval evidence.
- Projections are directly foreign-key-bound to the raw GitHub observation and compiled plan. The raw provider ledger remains append-only.
- Same-source/same-subject GitHub observations use the newest fact during gate evaluation. A same-SHA regression supersedes old green evidence and revokes any derived policy decision.
- Merge evidence also requires current commit-to-artifact lineage. Provider checks/reviews alone cannot pass the Lifecycle.

### Approval separation

- Internal `policy_approval` is distinct from public `merge_approval`; it cannot satisfy a human gate and is rejected at the public decision route.
- Standing policy authority is created only for an active exact policy digest that admits the plan risk and only for the exact run/gate/head SHA.
- An explicit authenticated human Merge approval can satisfy either a human gate or a policy gate.
- High/critical/protected work can enter the reviewed-delivery steward, but remains `awaiting_human_approval` until the canonical human decision exists. It never receives standing policy approval.
- Policy expiry, replacement, or revocation removes derived policy authority and terminates non-actuating deliveries. Revocation cannot rewrite an already merged fact.

### Point-of-no-return merge checks

The existing pg-boss worker owns `pipeline:pr-delivery`. Its payload contains only the delivery UUID and expected full head SHA. Every step reloads immutable authority server-side.

Immediately before merge, Rorca requires:

- a completed canonical run using merge strategy `pr` (not `direct`, `draft-pr`, or `branch-only`);
- canonical workspace/repository/PR/branch binding;
- active matching policy digest and unexpired bounded policy envelope;
- unchanged full head SHA and base SHA;
- open, non-draft, unmerged PR;
- fresh base comparison and provider mergeability `clean | has_hooks`;
- every exact required check successful;
- current-SHA approval count and required reviewers satisfied;
- no unresolved change request;
- no provider truncation or unstable observation window;
- current artifact lineage;
- current canonical Merge decision;
- every applicable Lifecycle phase through Merge passed; and
- unchanged Lifecycle evidence/decision high-water marks at authorization.

Rorca then performs another PR metadata preflight and sends GitHub's conditional merge request with `sha=<expectedHeadSha>`. Branch protection remains an independent provider-side enforcement layer. Deployment authority remains false and separate.

## Bounded recovery and re-review

### CI recovery

- Recovery starts only for definitive required-check failures with bounded GitHub failure annotations.
- It creates one child `pipeline:run` at a time in the existing isolated worktree, using the persisted configured agent/model/reasoning posture.
- The child is branch-only, non-deploying, policy locked, and uses the existing execution engine.
- Agent-visible credentials are redacted; guarded network and host-owned Git operations are denied.
- Host closeout rejects empty revisions, merge commits, workflow/CODEOWNERS edits, dirty worktrees, and a remote branch that does not prove the new SHA.
- The host-owned branch push is the only PR-update side effect. Failure remains bounded by immutable attempt and elapsed-time budgets.

### Conflict recovery

- The host fetches and starts a no-commit merge of the configured base branch.
- Only the exact unmerged path set is handed to the configured resolver.
- The resolver cannot fetch, push, commit, merge, switch, reset, clean, or use common network commands.
- Existing containment requires exactly the conflict paths staged, no unresolved index entries, no unrelated edits, and a clean cached diff.
- The host alone commits and pushes the semantic resolution.

Every successful recovery produces a new full SHA, clears prior delivery authority snapshots, and returns to queued observation. Old checks, approvals, policy decisions, and Lifecycle evidence cannot authorize the new revision.

## Idempotent merge closeout

- `authorized` and `merging` are durable states before provider actuation.
- One append-only `autonomous_pr_delivery_merge_evidence` row binds delivery, policy, exact GitHub snapshot, Lifecycle Merge evidence, decision, evaluator snapshot/high-water marks, PR, expected head, merge method, merged SHA, provider response hash, and merge time.
- One bounded `autonomous_pr_merged` WAL event records the same identifiers.
- Replaying a completed delivery performs no second merge and creates no duplicate evidence/WAL row.
- A lost provider response is reconciled once from PR merged state, exact original head, and provider merge-commit SHA.
- Worker restart scans bounded durable `merging` rows. It reconciles provider truth and never submits a second merge call.
- Unprovable provider outcomes remain fail-closed for operator inspection.

## Persistence

Migration: `20260715220000_autonomous_reviewed_delivery.sql`

New tables:

- `autonomous_pr_deliveries`
- `autonomous_pr_delivery_events`
- `autonomous_pr_delivery_recovery_attempts`
- `autonomous_pr_delivery_merge_evidence`

The migration also:

- aligns Lifecycle run IDs to PostgreSQL `BIGINT`;
- adds the `approval` evidence classification and internal `policy_approval` decision type;
- directly links projected evidence to raw GitHub evidence and compiled plans;
- guards legal delivery/recovery state transitions;
- makes event and merged-SHA ledgers append-only;
- permits only one terminal recovery-attempt transition;
- makes terminal delivery state immutable; and
- creates no `pgboss.*` object.

Fresh disposable PostgreSQL verification:

- database owner/login: `rorca_test_runner`;
- database name ended in `_test`;
- all required extensions were provisioned outside Jest;
- first run: 179 ledger entries, 178 applied, one intentional legacy graph skip;
- second run: zero applied, 179 skipped;
- both Lifecycle `run_id` columns are `BIGINT`;
- all four reviewed-delivery tables exist; and
- no migration touched `pgboss.*`.

All three task-owned disposable databases were identity-checked as owned by `rorca_test_runner`, had their task connections terminated, and were removed. The pre-existing `rorca_test` and production `rorca` databases were not changed.

## Validation evidence

### Task-focused backend

- Reviewed-delivery policy/provider/Lifecycle/compiler/evaluator/route/migration/state-machine matrix: **15 suites, 144/144 passed**.
- Contained recovery secret/guard/state-machine matrix: **4 suites, 23/23 passed**.
- Existing Recovery Wave compatibility matrix: **14 suites, 136/136 passed**.
- Explicit SSDLC Lifecycle/retry/closeout/Learn matrix: **35 suites, 353/353 passed**.
- Pipeline queue/readiness/Hermes/recovery/graph/delivery matrix: **8 suites, 78/78 passed**.
- pg-boss cancellation: **1 suite, 2/2 passed** on the fresh disposable database.

The focused integration proves an exact-SHA merge dependency is invoked once, merge evidence is one row, WAL closeout is one row, and a crash after provider merge reconciles without a second merge request.

### Frontend and browser

- Focused autonomous-delivery settings: **2 files, 11/11 passed**.
- Full frontend: **83 files, 972/972 passed**.
- Pi extension runtime tests: **11 files, 87/87 passed**.
- Capture runtime tests: **8 files, 75/75 passed**.
- Isolated candidate-worktree Lifecycle Playwright journey: **1/1 passed**.

The Playwright result uses deterministic browser fixtures against an isolated candidate Vite server. It is not production deployment or visual-signoff evidence.

### Static, build, and governance

- Root/frontend TypeScript: passed.
- Backend TypeScript: passed.
- Public-contract and Capture TypeScript: passed.
- Focused ESLint: zero errors; only the repository module-type warning was emitted.
- Production build (frontend, backend, CLI, Capture): passed.
- Public contract regenerated: version 8.0.0, 116 public routes.
- Contract stability: passed against `6f87e79b0035985463739b05245cdd6e34969717`; three pre-existing major-version override markers acknowledged.
- Tier lint: 116 stable public routes and 163 MCP tools; reviewed-delivery operations are admin-only.
- Apache-2.0 headers: 1,167 source files passed.
- License boundary check: intentionally skipped under the repository-wide Apache-2.0 license.
- `git diff --check`: passed.

Full `npm run typecheck` remains blocked only by the already documented optional standalone Pi peer types `@mariozechner/pi-tui` and `typebox`. Root, backend, public-contract, Capture, builds, and Pi runtime tests pass.

A mistakenly broad backend Jest invocation also completed: **255 suites passed, 85 failed; 3,832 tests passed**. Its failures match the known order-sensitive/shared-schema and legacy-test backlog (RLS session leakage, legacy SQLite backup expectations, absent paid tables, optional/stale test types, and similar unrelated surfaces). It is not represented as a green repository-wide backend suite. The task-owned compiler-v1 fixture it exposed was updated, after which the explicit SSDLC matrix passed 353/353.

## Residual risk and release conditions

- No live exact-SHA merge was performed. A replacement PR still needs green exact-SHA CI, staging evidence, required human review, and unchanged-SHA release authorization.
- GitHub and PostgreSQL cannot form one distributed transaction. Immediate re-observation, conditional head SHA, branch freshness, branch protection, durable `merging`, and provider reconciliation minimize the race; uncertainty never becomes success.
- Code-owner automation remains fail-closed because provider code-owner verification is still `unverified`.
- Command guards and path containment are not an OS sandbox. Recovery receives no GitHub/database secret and host code revalidates changed paths, worktree state, and remote SHA; stronger process/network sandboxing remains defense in depth.
- Existing explicit direct-merge mode is preserved for backward compatibility but is not autonomous reviewed delivery and does not satisfy this reviewed-delivery evidence chain.
- Production activation, deployment, recovery arming, and external notifications remain separate operator-controlled actions.

## Conclusion

Items 3–7 are implemented and locally validated as a fail-closed reviewed-PR steward built on Rorca's existing Lifecycle evaluator, evidence/decision ledgers, pg-boss worker, execution engine, configured-agent resolver, worktrees, WAL, and GitHub boundary. No second orchestrator, scheduler, queue system, policy engine, lifecycle truth store, or deployment authority was introduced.
