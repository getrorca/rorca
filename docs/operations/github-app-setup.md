# Repository-scoped GitHub App setup

This is an operator runbook, not deployment or repository authority. Do not create an App, install it, bind a repository, activate policy, merge, or deploy without explicit human authorization.

## Authority model

Rorca uses one canonical GitHub App registration with any number of GitHub account/owner installations. Each installation must use **selected repositories**. Rorca persists an immutable mapping:

`workspace -> App -> owner installation -> repository id + owner/name`

At runtime Rorca creates an RS256 App JWT and asks GitHub for a short-lived installation token constrained with exactly one `repository_ids` entry and an operation-specific `permissions` object. Every returned token must enumerate exactly that repository and exactly the requested permission profile; broader or unknown grants fail closed. JWTs and installation tokens live only in process memory. Private keys and webhook secrets are AES-256-GCM encrypted in the integration vault. Responses, WAL, audit details, logs, and database rows never contain plaintext secrets, JWTs, or installation tokens.

An active App binding is authoritative. Binding it transactionally retires the legacy repository-webhook row and marks that secret authority revoked; omission of App installation identity can never fall back to the retained row. Identity drift, suspension, expiry, permission uncertainty, provider-profile staleness (24 hours), inactive/mismatched hook configuration, authoritative provider rejection, or repository mismatch fails closed. Rorca does not silently replace it with a broader PAT/OAuth/environment token. Workspace PAT/OAuth remains an explicit migration fallback only for workspaces with no current App binding. Rorca remains canonical for run, story, policy, decision, and Lifecycle/provider-evidence state; the App is only a credential provider.

## Recommended GitHub App permissions

Repository permissions:

| Permission | Access | Reason |
|---|---:|---|
| Metadata | Read | Required repository identity metadata. |
| Actions | **Read** | Workflow/deployment dispatch is hard disabled; read supports workflow diagnostics only. Historical Actions-write bindings fail closed until the provider profile is explicitly downgraded and revalidated. |
| Checks | **Read and write** | Exact-SHA evidence reads Check Runs; Rorca publishes exact-final-SHA Check Runs. |
| Commit statuses | **Read and write** | Exact-SHA evidence reads statuses; only explicit admin manual/non-governing statuses are published. Per-story trusted-WAL status projection is disabled. |
| Contents | **Read and write** | Compare/spec discovery reads contents; governed merge paths require write. |
| Issues | Read | GitHub issue-to-story import. |
| Pull requests | **Read and write** | PR/review evidence, PR creation/update, and governed merge operations. |

This is an exact server-enforced ceiling, not a minimum: imported/modified Apps with unknown permissions, broader levels, missing grants, or extra events are rejected. Subscribe exactly to `check_run`, `issues`, `pull_request`, and `push`. A signed `ping` is accepted for setup health. Legacy repository webhooks retain the same event compatibility during migration. Do not grant administration, organization, members, secrets, deployments, or environments permissions.

GitHub **Team plan remains separately required** for private-repository protected branches/rulesets and review governance. App installation does not substitute for the GitHub plan or branch governance.

## Preferred Manifest flow

1. Configure an HTTPS `RORCA_APP_URL`, `RORCA_GITHUB_WEBHOOK_URL=https://hooks.rorca.ai/api/webhooks/github`, and `RORCA_GITHUB_APP_CREATION_ORG=<organization-login>`. Configure `VAULT_KEY` (64 hex characters) or an explicit strong `JWT_SECRET` before storing credentials.
2. In Settings > GitHub, choose **Prepare App setup** as an explicit platform/superuser operator who is also authorized for the workspace. An ordinary workspace administrator receives 403 for process-global setup, exchange, and import. The endpoint creates a random 10-minute, one-use state bound to the authenticated operator and workspace. Normal CSRF middleware protects each local POST; the callback does not depend on an in-memory CSRF value that changes across reload.
3. Submit the returned manifest directly to the organization-owned GitHub App creation URL. Both Express/Helmet and the checked-in static nginx document CSP permit form submission only to the same origin and exact `https://github.com` origin; the manifest contains no private key.
4. GitHub returns directly to `/settings/github`. After a reload or a new callback tab, choose **Complete one-time App registration**. Rorca atomically consumes the state before exchanging the one-time code. GitHub's returned private key and webhook secret are provider-profile checked and inserted in the same database transaction as the registration; they are never returned to the browser.
5. Install the App for **selected repositories** under each desired owner/account.
6. Copy the numeric installation id and repository id plus owner/name into **Verify and bind exact repository**. The server validates App id, installation id/account, selected-repository mode, repository id/full name, token expiry, and permissions before persisting the immutable binding.
7. Review credential readiness separately from webhook health. Provider permissions, events, active state, and exact webhook URL/configuration must verify (and remain within the 24-hour freshness window) before credential readiness is connected. A new binding truthfully shows **Awaiting signed delivery**; the first valid signed App ping/event promotes observed webhook health without being required to authenticate that initial delivery. No autonomous policy, merge, or deployment authority is activated by registration or binding.

## Host-owned release authority

- Execution-engine story commits remain local. PATH wrappers deny common remote commands only as defense in depth; they are not the capability boundary. The Compose worker drops every container capability and adds back only `SYS_ADMIN` to the already trusted worker so Docker seccomp/AppArmor permit namespace construction; `no-new-privileges` and a PID limit remain set. Every semantic/RPC/PTY/conflict-resolution agent and every worktree-controlled host validation command then runs through `bubblewrap` with fresh PID/proc, user, mount, IPC, UTS, cgroup, and network namespaces, and drops **all** capabilities before the model executable; a private HOME/tmp; curated root-owned runtime mounts; exact writable worktree/Git metadata mounts; masked workspace credential files; and a cleared allowlisted environment. The model namespace has no direct interface/default route, so absolute Node/Python/Git/`gh`, package runners, `env -i`, and arbitrary sockets cannot reach PostgreSQL, GitHub, localhost, or the Rorca control plane or inspect trusted ancestor processes/files.
- Cloud-model inference uses a trusted worker-owned Unix-socket CONNECT broker mounted into that namespace through a loopback relay. It accepts only `CONNECT` to port 443 for exact names in `RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS`, resolves/pins public addresses, and rejects IP literals, wildcards, private/mixed DNS answers, GitHub, DB, localhost, and arbitrary ports. Model API keys may enter the child only under this network confinement; DB/vault/App/PAT/internal/operator capabilities and credential homes never do. If namespace, required absolute-tool, credential-mask, socket-denial, ancestor-environment, or broker preflight fails, the worker refuses the run before `running`, and no host release can be prepared.
- `RORCA_AUTONOMOUS_ISOLATION=local-dev` is an explicit non-production bypass only. It is rejected for external/provider-capable runs and whenever GitHub/vault/operator/SSH authority is present. It cannot coexist with production. Safe local runs must be provider-inert; use the Linux image for App-backed/provider-capable autonomous execution.
- Configure a separate unpredictable `RORCA_INTERNAL_SERVICE_TOKEN` (at least 32 bytes) for trusted server/worker HTTP. Production rejects missing/predictable values. The internal principal is explicitly ineligible for provider mutation even though scheduler routes retain their existing internal administration behavior.
- In local mode set only `RORCA_OPERATOR_CAPABILITY_SHA256=<sha256-of-operator-secret>` on the server and supply the preimage in `X-Rorca-Operator-Capability` for provider-facing mutations. The server never stores or returns the preimage, and execution children receive neither digest nor preimage. Without this configuration, provider mutation controls are safely read-only/disabled.
- The worker persists one immutable release intent containing the exact authorized 40-hex SHA, branch, DB-frozen workspace/worktree realpaths, exact base branch/SHA, deterministic isolated integration path, unique provider release ref, and exact repository/App installation identity. Intent, terminal checkout attestation, and `release_pending` transition commit in one transaction before any effect.
- Every merge, push, PR create/finalize, and reviewed exact-SHA merge reacquires canonical repository authority under repository-wide local/provider locks, resolves a purpose-scoped credential last, and repeats exact identity validation immediately before actuation.
- App authority never downgrades. Workspace PAT/OAuth is usable only when the canonical authority view explicitly selects `pat-oauth-fallback` because no App binding exists. There is no `gh` or SSH fallback.
- `direct` builds the merge in the persisted isolated integration checkout, verifies the frozen canonical base, pushes with provider force-with-lease CAS, and advances the local base by exact `update-ref` CAS. Local-base replay accepts only an exact clean merge tree (reset already completed) or an exact clean frozen-base tree (the narrow post-`update-ref` window, repaired by reset); every other staged/unstaged/untracked state blocks. `pr`/`draft-pr`/`branch-only` push a unique run-owned ref; PR create/finalize rereads that ref immediately before mutation, verifies exact head afterward, retains closed/quarantined PRs as history, and reconciles only one exact open replacement. Multiple open candidates remain blocked. Deployment/workflow dispatch and automatic legacy PR/CI-autofix statuses are hard disabled. ANSI, PTY, and native-PTY execution transport is unchanged.
- Successful fresh and retry runs use the identical release seam and preserve predecessor authority/strategy. Terminal intent and exact SHA are durable before `done`; startup drains a globally bounded set before stale classification and periodic worker reconciliation retries bounded batches. Exact cleanup treats an already absent/unregistered authorized worktree as complete and never replays a completed cleanup after relay failure. A transport-ambiguous result journal preserves the complete proposed pass outbox only for read-only exact comparison with one already immutable ready host outbox; replay never inserts, promotes, or governs from it.
8. To replace a disabled/invalid binding, enter the new exact installation/repository identity and an audited replacement reason. Rorca preserves and permanently supersedes the old row; it never deletes or rewrites binding identity.

No model may choose repository authority, grant permissions, install the App, activate policy, merge, or deploy.

## Bounded import fallback

If no public authenticated callback is available, setup returns `bounded-import` instead of pretending Manifest exchange completed. Create the App manually using the permission/event table above, then call the platform/superuser-only import endpoint once (with workspace authority also required) using `appId`, `appSlug`, PEM private key, and webhook secret. The server verifies `GET /app` with the supplied key and, when `RORCA_GITHUB_APP_OWNER` or `RORCA_GITHUB_APP_CREATION_ORG` is configured, requires the exact provider App owner before vaulting it. It never echoes secret fields. Prefer a local operator browser/API client; do not put secrets in shell history, JSON files, tickets, chat, logs, or screenshots. Proceed with selected-repository installation and exact binding as above.

## Rotation and incident response

The current schema audit-retains bindings, registrations, and secret records. Disable an invalid binding rather than deleting evidence. Registration identity and typed secret references are immutable; a future dedicated rotation ceremony must create an audited replacement registration/secrets, supersede affected bindings, clear in-memory token state, and revalidate every replacement. Until that ceremony exists, use a maintenance window and do not overwrite ciphertext or secret references manually.

GitHub webhook processing is bounded at-least-once. Rorca acknowledges only after durable handler completion; failed or two-minute-stale claims may be reclaimed on provider redelivery, up to five claims. Completed duplicates return 200 without dispatch; current non-completed claims return retry-later 503 so a crash is never falsely acknowledged. Handlers must remain idempotent because Rorca does not claim exactly-once side effects.

If installation or repository drift is reported:

1. Do not enable PAT/environment fallback.
2. Confirm App id, installation account/id, selected repository id/full name, suspension state, and permissions in GitHub.
3. Disable or replace the invalid binding through an audited admin change.
4. Re-observe exact-SHA evidence after restoration; never reuse stale evidence.
