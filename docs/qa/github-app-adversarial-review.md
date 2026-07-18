# GitHub App integration adversarial review

Review scope: repository changes on `feat/github-app-integration` only. No live service, GitHub, infrastructure, DNS, database, policy, merge, deployment, or remote operation was performed.

| Threat | Attack considered | Control / result |
|---|---|---|
| Secret leakage | Private key, webhook secret, App JWT, or installation token enters DB metadata, WAL, audit details, logs, API/UI responses, errors, or test snapshots. | Private key/webhook secret use AES-256-GCM integration-vault rows. JWT/token are local variables or bounded in-memory cache only. Provider errors expose status/code, not response bodies or headers. Metadata excludes token. Vault/provider tests assert ciphertext and response redaction. |
| Confused deputy | Caller asks a workspace credential to operate on a different owner/repository or installation. | Resolver derives/compares exact workspace binding. Token request contains one repository id. Provider requires GitHub's response to list exactly that repository, then verifies repository id and full name with the issued token. App/installation/account/repository identity is server-validated. |
| Stale token | Expired/near-expiry token is reused, concurrent refreshes race, or a low-permission refresh satisfies a higher-permission waiter. | Cache is process-only, max 256 entries, 60-second skew, and keyed by immutable binding. Refresh is single-flight. Every cache hit and joined refresh re-checks the caller's required permissions. Installation/repository identity is revalidated on refresh. GitHub revocation remains provider-enforced during the short token lifetime. |
| Installation drift | App id, account, selection mode, suspension, repository id/name, or permissions change. | Refresh checks App id, installation id, selected-repository mode, suspension, account id/login/type, exact repository and required permissions. Identity mismatch invalidates the binding and fails closed. Revalidation is admin-only and repeats all checks. |
| Replay/duplicate | Two same-delivery webhooks race past check-then-insert. | Existing webhook ledger now has atomic `INSERT ... ON CONFLICT DO NOTHING` claim. Only the claimant dispatches; duplicates are acknowledged without domain processing. |
| Multi-repo cross-talk | One App secret signs events for many repositories; an event routes to the wrong workspace. | App webhook routing requires active registration + installation + binding and exact installation id, repository id, owner/name, repository owner id/login. Unknown App identities never fall back to legacy webhook authority. DB unique/FK constraints prevent conflicting active identities. |
| Webhook forgery/abuse | Bad HMAC, modified bytes, missing headers, unsupported event, oversized body. | Timing-safe SHA-256 HMAC over captured raw bytes, required bounded delivery id, 1 MiB Express/route/Traefik ceiling, and event allowlist. Focused HMAC and contract tests cover tampering and bounds wiring. |
| SSRF | Operator-controlled owner/repo, callback, manifest code, or IDs produce arbitrary outbound URLs. | Provider origin is hard-coded `https://api.github.com`; owner/repo have strict GitHub-compatible character bounds and path segments are encoded. Manifest endpoint/code is fixed and encoded. Callback must be configured HTTPS and non-local. |
| Callback CSRF/replay | Attacker swaps workspace/operator, replays state, or races two exchanges. | 256-bit random state stores only SHA-256 digest, expires in 10 minutes, is bound to workspace/operator/current CSRF proof, and is atomically consumed before exchange. Failure does not make state reusable. No private key is returned to the browser. |
| Fallback escalation | Broken App binding silently falls back to broad workspace PAT/OAuth or ambient `GITHUB_TOKEN`. | Any existing App binding wins; errors propagate and no fallback is consulted. PAT/OAuth is used only with no App binding. Ambient env fallback is explicit and routine-only; Checks/reviewed delivery always deny it. Tests cover precedence and escalation denial. |
| Model-granted authority | Model/MCP registers/installs/binds App, selects repo, activates policy, merges, or deploys. | Setup/import/bind/revalidate are actual workspace-admin middleware plus `x-rorca-tier: admin`, so excluded from MCP. UI requires explicit operator actions. No policy activation, merge, deployment, GitHub installation, or hook creation was added. Existing Lifecycle/provider evidence remains authoritative. |

## Fixes made during review

- Required the installation-token response to enumerate exactly one repository matching the immutable repository id, rather than trusting the request body alone.
- Re-checked required permissions after joining a concurrent single-flight refresh, preventing a low-permission first caller from satisfying a higher-permission waiter.
- Made webhook replay claiming atomic instead of check-then-upsert.
- Prevented App webhook identity failures from falling through to the legacy PAT webhook path.
- Avoided `/user` validation for installation tokens and made disconnect disable the audit-retained App binding rather than mutate an App-global webhook.
- Added explicit admin revalidation for an existing disabled/invalid immutable binding.

## Residual operational constraints

- App secret rotation is intentionally not improvised in this change. Until a separately reviewed rotation ceremony exists, follow the maintenance guidance in `docs/operations/github-app-setup.md`.
- Legacy PAT/OAuth and legacy per-repository webhook paths remain for migration compatibility. They do not override an existing App binding.
- A token already issued by GitHub may remain in memory until the short expiry/skew boundary; GitHub-side suspension/revocation is also expected to invalidate provider use. Rorca never persists it.
- Database migration execution and live route integration tests were not run because the configured test database failed the immutable owner safeguard. Focused mocked tests were run without bypassing or mutating that safeguard.
