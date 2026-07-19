# Wave-parallel production rollout and rollback

Wave-parallel execution is **not enabled or deployed by this implementation**. Release authority remains a separate human decision after independent review. Production stays sequential (`orchestrationMode=sequential`, `parallelism=1`) unless every dispatch fence verifies all conditions below.

## Operator-owned configuration

1. Produce qualification evidence only with the dedicated qualification test database and disposable repositories. Never point `NODE_ENV=production` policy/integration tests at a deployed database or production workspace.
2. Configure trusted receipt issuers in `RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON`, then publish the portable receipt through `POST /api/admin/wave-qualification/receipts`. The endpoint recomputes repository, source revision, policy, compiler, invariant and test identities.
3. Select that immutable receipt and a bounded cohort through the admin rollout endpoint. Configure an explicit workspace and/or run allowlist, `maxParallelism` (hard maximum 4), global/per-workspace concurrency caps, CPU/memory limits and an error-rate threshold. This configuration does not change workspace defaults or old runs.
4. Only after review, set the separately named `RORCA_WAVE_PARALLEL_PRODUCTION_ENABLED` value to the exact string `true` on each production API/worker/local-runner runtime that may dispatch or spawn work. The variable is one input, never evidence and never sufficient by itself.
5. The caller must still explicitly send `orchestrationMode: "wave-parallel"`, `parallelism > 1`, the selected `qualificationReceiptId`, and `rolloutCohort` for each run. Graph analysis is advisory and cannot opt a run in.

`RORCA_EXPERIMENTAL_WAVE_PARALLEL=true` is accepted only when `NODE_ENV !== "production"`. It is ignored as production authority.

## Dispatch fencing

The API persists the requested/effective mode, parallelism, receipt ID/hash, qualified source revision, cohort, caps and `dispatch-boundary-v1` fence on the new run row and queue payload. API trigger, immutable manifest construction, queue handoff, worker, retry, scheduler, task-manifest broker and local runner must fail closed or dispatch sequential when the complete envelope is absent. Worker/runner checks happen immediately before spawn. A queued payload cannot broaden the persisted run policy, and restarting a worker or replaying a queue does not re-authorize it.

The status surface reports one of: `sequential-default`, `experimental-nonproduction`, `production-disabled`, `receipt-missing`, `receipt-stale`, `canary-enabled`, `halted`, `draining`, or `enabled`. It does not display the environment variable as proof.

## Health halt and rollback

- Posting health above any configured threshold atomically marks the workspace `halted`; no new parallel dispatch is allowed.
- Set `draining=true` to reject new parallel dispatch while already-running work preserves its original wave evidence and can finish.
- Set `RORCA_WAVE_PARALLEL_KILL_SWITCH=true`, or call the admin rollback endpoint, for immediate denial of future parallel starts. The kill switch wins over every receipt and cohort setting.
- Disabling the production gate or rollout control has the same future-dispatch effect. It does **not** rewrite, relabel, replay, migrate, merge or mark successful any queued or in-flight run.
- To cancel in-flight work, use the existing explicit run cancellation endpoint. Cancellation remains `cancelled`; it is never converted to sequential or successful. To drain, wait for active wave runs to reach a terminal state, inspect their immutable story/integration evidence, then explicitly clear draining or roll back.
- Queue replay after rollback revalidates current policy. A stale parallel envelope is denied rather than silently executed under a different label.

Every receipt verification, enable/deny, cohort change, automatic halt, drain and rollback appends a durable audit decision containing actor, rationale, receipt hash, revision, requested/effective policy, cohort, fence policy and outcome. Audit payloads exclude issuer keys, credentials, environment values and workspace/private paths.
