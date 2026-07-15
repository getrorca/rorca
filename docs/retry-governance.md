# Governed retry preview and dispatch

Pipeline retries use the existing `pipeline:retry` queue in two phases.

1. `POST /api/pipeline/runs/:runId/retry` without `previewHash` reconciles current pass evidence, resolves dependencies, classifies every story, freezes effective execution options, performs worktree preflight, persists a hash-bound preview, and emits `retry_preview_generated` through `/api/wal`.
2. The caller reviews the packet and repeats the request with `previewHash`. The route re-runs reconciliation and policy resolution. It refuses drift unless an approval token and audited override rationale are supplied.
3. The route writes an executable-only retry spec, resolves the same `StoryExecutionManifest` schema used by initial dispatch, and compares the generated plan to the preview immediately before `boss.send()`.
4. The worker verifies the durable preview, cancellation state, worktree, generated plan, and scope hashes again before changing the run from `queued` to `running`.

## Scope categories

Every preview reports `requested`, `requiredDependency`, `copiedPassed`, `skipped`, `executable`, `remaining`, and `excluded` stories with reason codes. Passed stories may be copied for evidence but are excluded from executable work. Unrequested failures remain visible as remaining work and are excluded from that retry spec.

## Option replay and approvals

Agent, model, effort (including `xhigh`), terminal mode, graph inclusion, worktree/branch, merge strategy, and safety options are replayed from the original effective options. `safeMode: true` is an explicit preview change to branch-only, no-auto-merge, no-deploy, and no-external-send behavior. Otherwise destructive options set `requiresApproval: true`; dispatch requires an approval token. Retry code never resets, deletes a branch, force-pushes, deploys, or externally sends by silent default.

## Worktree preflight

Preflight classifies `fresh`, `stale_base`, `missing_branch`, `dirty_expected_work`, `dirty_unrelated_work`, `conflict_risk`, and `invalid_ownership_safe_directory`. A clean stale worktree can be rebased onto the current workspace HEAD. The refresh records before/after revisions and preserved commits, aborts a conflicting rebase, and never uses reset or force push. Unrelated dirty work and conflicts require operator action.

## Idempotency and cancellation

`pipeline_retry_previews` is the audit ledger. A partial unique index prevents more than one dispatched retry per original run and scope hash. The route also checks active pg-boss jobs by `originalRunId` and `scopeHash`. It explicitly creates `pipeline:retry`, lets pg-boss generate the UUID, and keeps numeric run IDs only in job data. A preview can be cancelled before dispatch; cancelled previews cannot create runs or jobs.
