# GitHub App integration adversarial review

Review scope: repository changes on `feat/github-app-integration` only. No live service, GitHub, infrastructure, DNS, database, policy, merge, deployment, or remote operation was performed.

| Threat | Attack considered | Control / result |
|---|---|---|
| Secret leakage | Private key, webhook secret, App JWT, or installation token enters DB metadata, WAL, audit details, logs, API/UI responses, errors, or test snapshots. | Private key/webhook secret use AES-256-GCM integration-vault rows. JWT/token are local variables or bounded in-memory cache only. Provider errors expose status/code, not response bodies or headers. Metadata excludes token. Vault/provider tests assert ciphertext and response redaction. |
| Confused deputy | Caller asks a workspace credential to operate on a different owner/repository or installation. | Resolver derives/compares exact workspace binding. Token request contains one repository id. Provider requires GitHub's response to list exactly that repository, then verifies repository id and full name with the issued token. App/installation/account/repository identity is server-validated. |
| Stale token | Expired/near-expiry token is reused, concurrent refreshes race, or one permission profile satisfies another. | Cache is process-only, max 256 entries, 60-second skew, and keyed by immutable binding plus exact normalized permission profile. Refresh is single-flight per profile. Installation/repository identity is revalidated on refresh. GitHub revocation remains provider-enforced during the short token lifetime. |
| Installation drift | App id, account, selection mode, suspension, repository id/name, or permissions change. | Refresh checks App id, installation id, selected-repository mode, suspension, account id/login/type, exact repository and required permissions. Identity mismatch invalidates the binding and fails closed. Revalidation is admin-only and repeats all checks. |
| Replay/duplicate | Two same-delivery webhooks race past check-then-insert. | Existing webhook ledger now has atomic `INSERT ... ON CONFLICT DO NOTHING` claim. Only the claimant dispatches; duplicates are acknowledged without domain processing. |
| Multi-repo cross-talk | One App secret signs events for many repositories; an event routes to the wrong workspace. | App webhook routing requires active registration + installation + binding and exact installation id, repository id, owner/name, repository owner id/login. Unknown App identities never fall back to legacy webhook authority. DB unique/FK constraints prevent conflicting active identities. |
| Webhook forgery/abuse | Bad HMAC, modified bytes, missing headers, unsupported event, oversized body, or downgrade to a retained legacy secret. | Timing-safe SHA-256 HMAC over captured raw bytes, required bounded delivery id, 1 MiB Express/route/Traefik ceiling, and event allowlist. A current App binding (including disabled/invalid) rejects any payload that omits exact App installation/repository identity; the legacy row is transactionally retired on bind. Legacy `issues`/`check_run` compatibility remains accepted. |
| SSRF | Operator-controlled owner/repo, callback, manifest code, or IDs produce arbitrary outbound URLs. | Provider origin is hard-coded `https://api.github.com`; owner/repo have strict GitHub-compatible character bounds and path segments are encoded. Manifest endpoint/code is fixed and encoded. Callback must be configured HTTPS and non-local. |
| Callback CSRF/replay | Attacker swaps workspace/operator, replays state, or races two exchanges; a browser reload regenerates local CSRF state. | 256-bit random state stores only a SHA-256 digest, expires in 10 minutes, is bound to workspace and authenticated operator, and is atomically consumed before exchange. Normal CSRF middleware protects each local POST, but regenerated in-memory CSRF material is deliberately not callback identity. The callback targets `/settings/github`, works in a reload/new tab, and returns no private key to the browser. |
| Fallback escalation | Broken App binding silently falls back to broad workspace PAT/OAuth, a retained repository webhook, `github_connections`, or ambient `GITHUB_TOKEN`/`GH_TOKEN`. | One canonical repository-authority view makes any current App binding win; errors propagate and no credential/webhook fallback is consulted. Workspace PAT/OAuth is accepted only with active exact-repository legacy authority. Ambient and unscoped legacy-global credentials are never repository authority. |
| Model-granted authority | Model/MCP registers/installs/binds App, selects repo, activates policy, merges, or deploys. | Setup/import/bind/revalidate are actual workspace-admin middleware plus `x-rorca-tier: admin`, so excluded from MCP. UI requires explicit operator actions. No policy activation, merge, deployment, GitHub installation, or hook creation was added. Existing Lifecycle/provider evidence remains authoritative. |

## Fixes made during review

- Required the installation-token response to enumerate exactly one repository matching the immutable repository id, rather than trusting the request body alone.
- Requested and verified an exact purpose-specific token permission object, and isolated token cache/single-flight entries by that profile.
- Made webhook replay claiming atomic instead of check-then-upsert.
- Prevented App webhook identity failures from falling through to the legacy PAT webhook path.
- Avoided `/user` validation for installation tokens and made disconnect disable the audit-retained App binding rather than mutate an App-global webhook.
- Added explicit admin revalidation plus audit-retained, immutable supersession for replacement bindings.
- Added canonical App-first repository authority for status/check posters, PR creation/update, delivery policy/evidence/merge, workflow routes/worker dispatch, CI autofix, health, and issue/spec discovery.
- Separated manual status context from autonomous evidence and bound the admin route to a workspace/run/PR/full-SHA provider check.
- Made final status/check publishers use full 40/64-hex object ids and exact workspace/run-scoped closeout rows; mutable HEAD cannot authorize final success.
- Added provider request timeouts, transaction-scoped secret insertion, exact PAT repository verification, and safe repository URL construction.

## Residual operational constraints

- App secret rotation is intentionally not improvised in this change. Until a separately reviewed rotation ceremony exists, follow the maintenance guidance in `docs/operations/github-app-setup.md`.
- Legacy PAT/OAuth and legacy per-repository webhook paths remain for migration compatibility. They do not override an existing App binding.
- A token already issued by GitHub may remain in memory until the short expiry/skew boundary; GitHub-side suspension/revocation is also expected to invalidate provider use. Rorca never persists it.
- Database migration execution and live route integration tests are not run when the configured database fails the dedicated-test-owner safeguard. Static migration contracts and focused DB-free mocked route/provider tests cover this change without bypassing or mutating that safeguard.
- The OVH/Traefik files are review-only. They use observed `http`/`https` entrypoints, POST-only exact routing, and a separate Compose overlay joining `rorca_default` to external `coolify`; neither artifact has been applied.
