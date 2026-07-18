# Repository-scoped GitHub App setup

This is an operator runbook, not deployment or repository authority. Do not create an App, install it, bind a repository, activate policy, merge, or deploy without explicit human authorization.

## Authority model

Rorca uses one canonical GitHub App registration with any number of GitHub account/owner installations. Each installation must use **selected repositories**. Rorca persists an immutable mapping:

`workspace -> App -> owner installation -> repository id + owner/name`

At runtime Rorca creates an RS256 App JWT and asks GitHub for a short-lived installation token constrained with exactly one `repository_ids` entry and an operation-specific `permissions` object. Every returned token must enumerate exactly that repository and exactly the requested permission profile; broader or unknown grants fail closed. JWTs and installation tokens live only in process memory. Private keys and webhook secrets are AES-256-GCM encrypted in the integration vault. Responses, WAL, audit details, logs, and database rows never contain plaintext secrets, JWTs, or installation tokens.

An active App binding is authoritative. Binding it transactionally retires the legacy repository-webhook row and marks that secret authority revoked; omission of App installation identity can never fall back to the retained row. Identity drift, suspension, expiry, permission uncertainty, or repository mismatch fails closed. Rorca does not silently replace it with a broader PAT/OAuth/environment token. Workspace PAT/OAuth remains an explicit migration fallback only for workspaces with no current App binding. Rorca remains canonical for run, story, policy, decision, and Lifecycle/provider-evidence state; the App is only a credential provider.

## Recommended GitHub App permissions

Repository permissions:

| Permission | Access | Reason |
|---|---:|---|
| Metadata | Read | Required repository identity metadata. |
| Actions | **Read and write** | Workflow discovery and explicit workflow dispatch. |
| Checks | **Read and write** | Exact-SHA evidence reads Check Runs; Rorca publishes exact-final-SHA Check Runs. |
| Commit statuses | **Read and write** | Exact-SHA evidence reads statuses; Rorca publishes status evidence. |
| Contents | **Read and write** | Compare/spec discovery reads contents; governed merge paths require write. |
| Issues | Read | GitHub issue-to-story import. |
| Pull requests | **Read and write** | PR/review evidence, PR creation/update, and governed merge operations. |

This is an exact server-enforced ceiling, not a minimum: imported/modified Apps with unknown permissions, broader levels, missing grants, or extra events are rejected. Subscribe exactly to `check_run`, `issues`, `pull_request`, and `push`. A signed `ping` is accepted for setup health. Legacy repository webhooks retain the same event compatibility during migration. Do not grant administration, organization, members, secrets, deployments, or environments permissions.

GitHub **Team plan remains separately required** for private-repository protected branches/rulesets and review governance. App installation does not substitute for the GitHub plan or branch governance.

## Preferred Manifest flow

1. Configure an HTTPS `RORCA_APP_URL`, `RORCA_GITHUB_WEBHOOK_URL=https://hooks.rorca.ai/api/webhooks/github`, and `RORCA_GITHUB_APP_CREATION_ORG=<organization-login>`. Configure `VAULT_KEY` (64 hex characters) or an explicit strong `JWT_SECRET` before storing credentials.
2. In Settings > GitHub, choose **Prepare App setup**. The admin endpoint creates a random 10-minute, one-use state bound to the authenticated operator and workspace. Normal CSRF middleware protects each local POST; the callback does not depend on an in-memory CSRF value that changes across reload.
3. Submit the returned manifest directly to the organization-owned GitHub App creation URL. Production CSP permits form submission only to the same origin and `https://github.com`; the manifest contains no private key.
4. GitHub returns directly to `/settings/github`. After a reload or a new callback tab, choose **Complete one-time App registration**. Rorca atomically consumes the state before exchanging the one-time code. GitHub's returned private key and webhook secret are provider-profile checked and inserted in the same database transaction as the registration; they are never returned to the browser.
5. Install the App for **selected repositories** under each desired owner/account.
6. Copy the numeric installation id and repository id plus owner/name into **Verify and bind exact repository**. The server validates App id, installation id/account, selected-repository mode, repository id/full name, token expiry, and permissions before persisting the immutable binding.
7. Review every capability diagnostic. A missing capability is not “connected.” Provider permissions, events, and exact webhook URL/configuration must all verify. No autonomous policy, merge, or deployment authority is activated by registration or binding.
8. To replace a disabled/invalid binding, enter the new exact installation/repository identity and an audited replacement reason. Rorca preserves and permanently supersedes the old row; it never deletes or rewrites binding identity.

No model may choose repository authority, grant permissions, install the App, activate policy, merge, or deploy.

## Bounded import fallback

If no public authenticated callback is available, setup returns `bounded-import` instead of pretending Manifest exchange completed. Create the App manually using the permission/event table above, then call the admin-only import endpoint once with `appId`, `appSlug`, PEM private key, and webhook secret. The server verifies `GET /app` with the supplied key before vaulting it and never echoes secret fields. Prefer a local operator browser/API client; do not put secrets in shell history, JSON files, tickets, chat, logs, or screenshots. Proceed with selected-repository installation and exact binding as above.

## Rotation and incident response

The current schema audit-retains bindings, registrations, and secret records. Disable an invalid binding rather than deleting evidence. Registration identity and typed secret references are immutable; a future dedicated rotation ceremony must create an audited replacement registration/secrets, supersede affected bindings, clear in-memory token state, and revalidate every replacement. Until that ceremony exists, use a maintenance window and do not overwrite ciphertext or secret references manually.

If installation or repository drift is reported:

1. Do not enable PAT/environment fallback.
2. Confirm App id, installation account/id, selected repository id/full name, suspension state, and permissions in GitHub.
3. Disable or replace the invalid binding through an audited admin change.
4. Re-observe exact-SHA evidence after restoration; never reuse stale evidence.
