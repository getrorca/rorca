# Rorca GitHub Execution Foundation — Delivery Plan

## Story order
1. **GEF-001 — GitHub authority reuses the accepted provider-neutral delivery boundary**
2. **GEF-002 — Repository-scoped installation leases expose only reviewed SCM capabilities**
3. **GEF-003 — Authorized SCM delivery produces a review branch but never merges**
4. **GEF-004 — SCM receipts reconcile unknown outcomes and revoke every lease**
5. **GEF-005 — Operators can qualify repository bindings without handling tokens**
6. **GEF-006 — Disposable-repository attacks cannot broaden SCM authority**

## Dependencies
- GEF-001 → GEF-002
- GEF-002 → GEF-003
- GEF-003 → GEF-004
- GEF-002 → GEF-005
- GEF-004 → GEF-006
- GEF-005 → GEF-006

## Verification
- GEF-001: An architecture test reports one canonical GitHub App registration, repository binding, installation-token provider, settings path, and adapter implementation
- GEF-001: A workspace without a GitHub binding continues to produce a local review bundle and never attempts network delivery
- GEF-001: The GitHub adapter is selected only by an explicit healthy repository binding and accepted external-send authority policy
- GEF-001: ProviderBinding stores installation/repository identifiers and secret references but no installation token, app JWT, private key, PAT, or SSH key
- GEF-001: Existing GitHub delivery routes remain compatible and duplicate routes, vaults, token caches, and settings components are absent
- GEF-002: Preflight rejects an unbound, suspended, stale, profile-unverified, permission-deficient, or non-mintable installation before branch work starts
- GEF-002: A minted lease accesses exactly the bound repository and only contents read/write, pull-request write, checks read, and review-request operations required by the grant
- GEF-002: Installation tokens and app JWTs are absent from model prompts, child persistent environment, job payloads, logs, API responses, receipts, and database rows
- GEF-002: A token cannot read or change Actions secrets, repository administration, releases, deployments, or another repository
- GEF-002: Lease settlement revokes the token when supported or records verified expiry and clears the in-memory cache
- GEF-003: A disposable bound repository journey reports the approved base revision, isolated checkout, one feature branch, one Rorca-authored commit, one pull request, observed checks, and requested review
- GEF-003: Protected-branch push, force push, merge, tag, release, repository administration, Actions-secret mutation, and production deployment are absent or rejected
- GEF-003: Replaying branch push or pull-request creation returns the existing resource and produces no duplicate commit or pull request
- GEF-003: The adapter never changes LocalReviewBundleAdapter as the default provider-neutral delivery path
- GEF-003: The receipt records repository id, base and head revisions, branch, pull-request URL/id, check conclusions, review request, and no secret values
- GEF-004: Crash after push but before settlement finds the remote branch/commit and records one settled receipt without a second push
- GEF-004: Crash after pull-request acceptance finds and reuses the existing pull request without creating another
- GEF-004: Completion, denial, cancellation, expiry, and failure all remove the isolated worktree and settle token revocation or verified expiry
- GEF-004: A revocation failure leaves the lease unusable and reconciliation-required until a read-side check settles it
- GEF-004: Receipts are immutable, redacted, workspace scoped, and link every operation attempt to the core request/grant/lease
- GEF-005: The existing settings panel displays one repository binding path with loading, missing, stale, ready, revalidation, disabled, and error states
- GEF-005: Bind and revalidate prove immutable repository identity and granted permissions without returning a token to the browser
- GEF-005: Disabling a binding invalidates preflight, revokes or expires active leases, and prevents new external-send grants
- GEF-005: Settings mutations remain local operator/admin tier and are not exposed through MCP
- GEF-005: A browser inspection reports no app private key, app JWT, installation token, PAT, or secret in DOM, storage, network response bodies, or logs
- GEF-006: The disposable journey completes feature-branch and pull-request delivery while protected main remains unchanged
- GEF-006: Credential reveal, protected-branch push, merge, other-repository access, Actions-secret access, altered request, replay, and revoked-token reuse all fail
- GEF-006: Crash at token mint, push, pull-request creation, check observation, and revocation resumes or reconciles once without duplicate external resources
- GEF-006: Disabling the adapter restores local review bundle delivery and leaves no active installation lease
- GEF-006: No Categoric/Cashflow-App repository, workspace, spec, environment, or product code is required by the qualification

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
