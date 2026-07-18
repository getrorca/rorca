# Repository-scoped GitHub App setup

This is an operator runbook, not deployment or repository authority. Do not create an App, install it, bind a repository, activate policy, merge, or deploy without explicit human authorization.

## Authority model

Rorca uses one canonical GitHub App registration with any number of GitHub account/owner installations. Each installation must use **selected repositories**. Rorca persists an immutable mapping:

`workspace -> App -> owner installation -> repository id + owner/name`

At runtime Rorca creates an RS256 App JWT and asks GitHub for a short-lived installation token constrained with exactly one `repository_ids` entry. JWTs and installation tokens live only in process memory. Private keys and webhook secrets are AES-256-GCM encrypted in the integration vault. Responses, WAL, audit details, logs, and database rows never contain plaintext secrets, JWTs, or installation tokens.

An active App binding is authoritative. Identity drift, suspension, expiry, permission uncertainty, or repository mismatch fails closed. Rorca does not silently replace it with a broader PAT/OAuth/environment token. Workspace PAT/OAuth remains an explicit migration fallback only for workspaces with no App binding. Rorca remains canonical for run, story, policy, decision, and Lifecycle/provider-evidence state; the App is only a credential provider.

## Recommended GitHub App permissions

Repository permissions:

| Permission | Access | Reason |
|---|---:|---|
| Metadata | Read | Required repository identity metadata. |
| Actions | Read | Workflow discovery/diagnostics. |
| Checks | **Read and write** | Exact-SHA evidence needs read; existing Rorca Check Run publishing creates/updates Check Runs, so this build needs write. Use read only if check publishing is disabled in a future build. |
| Commit statuses | Read and write | Existing story/spec status publishing and exact-SHA status evidence. |
| Contents | Read and write | Read supports compare/spec discovery; write is needed only for canonical PR creation/recovery paths. Remove write if those paths are disabled. |
| Pull requests | Read and write | PR/review evidence and existing canonical PR/merge operations. |

Subscribe only to `push` and `pull_request`. A signed `ping` is accepted for health setup but is not subscribed as an event. Other events are rejected. Do not grant administration, organization, members, secrets, deployments, or environments permissions.

GitHub **Team plan remains separately required** for private-repository protected branches/rulesets and review governance. App installation does not substitute for the GitHub plan or branch governance.

## Preferred Manifest flow

1. Configure an HTTPS `RORCA_APP_URL` for the authenticated UI callback and `RORCA_GITHUB_WEBHOOK_URL=https://hooks.rorca.ai/api/webhooks/github`.
2. In Settings > GitHub, choose **Prepare App setup**. The admin endpoint creates a random 10-minute, one-use state bound to the authenticated operator, workspace, and current CSRF proof.
3. Submit the returned manifest directly to GitHub. It contains no private key.
4. On callback, choose **Complete one-time App registration**. Rorca atomically consumes the state before exchanging the one-time code. GitHub's returned private key and webhook secret are identity-checked and vaulted; they are never returned to the browser.
5. Install the App for **selected repositories** under each desired owner/account.
6. Copy the numeric installation id and repository id plus owner/name into **Verify and bind exact repository**. The server validates App id, installation id/account, selected-repository mode, repository id/full name, token expiry, and permissions before persisting the immutable binding.
7. Review every capability diagnostic. A missing capability is not “connected.” No autonomous policy, merge, or deployment authority is activated by registration or binding.

No model may choose repository authority, grant permissions, install the App, activate policy, merge, or deploy.

## Bounded import fallback

If no public authenticated callback is available, setup returns `bounded-import` instead of pretending Manifest exchange completed. Create the App manually using the permission/event table above, then call the admin-only import endpoint once with `appId`, `appSlug`, PEM private key, and webhook secret. The server verifies `GET /app` with the supplied key before vaulting it and never echoes secret fields. Prefer a local operator browser/API client; do not put secrets in shell history, JSON files, tickets, chat, logs, or screenshots. Proceed with selected-repository installation and exact binding as above.

## Rotation and incident response

The current schema audit-retains bindings and secret records. Disable an invalid binding rather than deleting evidence. App private-key/webhook-secret rotation should be performed as a controlled operator change that vaults new values, updates the registration references, clears the in-memory token cache, and revalidates every binding. Until that dedicated rotation ceremony is available, use a maintenance window and do not overwrite ciphertext manually.

If installation or repository drift is reported:

1. Do not enable PAT/environment fallback.
2. Confirm App id, installation account/id, selected repository id/full name, suspension state, and permissions in GitHub.
3. Disable or replace the invalid binding through an audited admin change.
4. Re-observe exact-SHA evidence after restoration; never reuse stale evidence.
