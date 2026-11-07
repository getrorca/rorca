# Rorca GitHub Execution Foundation — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca GitHub Execution Foundation specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- GEF-001 — GitHub authority reuses the accepted provider-neutral delivery boundary
- GEF-002 — Repository-scoped installation leases expose only reviewed SCM capabilities
- GEF-003 — Authorized SCM delivery produces a review branch but never merges
- GEF-004 — SCM receipts reconcile unknown outcomes and revoke every lease
- GEF-005 — Operators can qualify repository bindings without handling tokens
- GEF-006 — Disposable-repository attacks cannot broaden SCM authority

## In scope
- Reconcile the new optional GitHub adapter with Rorca existing GitHub App binding, installation-token provider, workspace GitHub routes/UI, and accepted LocalReviewBundleAdapter architecture. Extend those surfaces rather than duplicating registration, credentials, migrations, routes, or settings UI. Implement the core AuthorityProviderAdapter contract for a generic workspace-bound repository. LocalReviewBundleAdapter remains the default and requires no GitHub account; GitHub is an opt-in external-send adapter. Use the core ProviderBinding tables and routes, so no GitHub-specific secret column or separate authority table is introduced.
- Map scm.repository.read, scm.branch.write, scm.pull_request.write, scm.checks.read, and scm.review.request to a GitHub App installation binding. Mint short-lived installation access tokens for exactly one approved repository and permission profile; cache only in memory for the lease; inject only into the trusted adapter process; revoke or allow bounded expiry after settlement. Preflight validates installation state, repository ownership/name/id, verified provider profile, app permission grant, token mintability, and binding generation. Exclude PAT, developer SSH, repository secret, and signing-key fallbacks.
- Implement typed adapter operations for prepareRepository at the approved revision, createBranch using a collision-safe run/story identity, commit with the Rorca machine identity, push the feature branch under a separate external-send grant, create or update one pull request, observe checks, and request review. Use isolated worktrees and existing DeliveryAdapter semantics. Reject protected-branch push, force push, merge, tag, release, repository settings, Actions-secret mutation, and production deployment. A restarted operation discovers existing branch/PR resources before creating anything.
- Implement GitHub-specific reconcile and revoke behavior over the core attempt state machine. Mark externally accepted operations with stable repository, branch, commit, pull-request, check-run, and installation resource identifiers. On crash, query those identifiers before retry. Remove the isolated worktree after settlement while preserving the branch/review artifact according to policy. Revocation failure remains reconciliation-required and blocks new use.
- Extend the existing GitHub settings surface and API rather than creating a second panel. Display app registration readiness, installation/repository binding, verified profile, granted permissions, token-mint probe result, binding generation, and capability availability. Allow explicit bind, revalidate, and disable operations under existing local provider-mutation authority. Never display or accept installation tokens. Data changes remain in core ProviderBinding and audit records; no child migration.
- Qualify the adapter on a disposable Rorca-owned repository with protected main and no customer workspace dependency. Inject prompt requests to reveal credentials, push main, merge, access another repository, read secrets, alter approved arguments, reuse a revoked token, replay a grant, and crash at each external boundary. Keep the adapter disabled by default after qualification; rollout is per healthy binding. Rollback disables the adapter, revokes leases, preserves local review bundles, and retains receipts.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### GEF-001
Reconcile the new optional GitHub adapter with Rorca existing GitHub App binding, installation-token provider, workspace GitHub routes/UI, and accepted LocalReviewBundleAdapter architecture. Extend those surfaces rather than duplicating registration, credentials, migrations, routes, or settings UI. Implement the core AuthorityProviderAdapter contract for a generic workspace-bound repository. LocalReviewBundleAdapter remains the default and requires no GitHub account; GitHub is an opt-in external-send adapter. Use the core ProviderBinding tables and routes, so no GitHub-specific secret column or separate authority table is introduced.

**Acceptance criteria**
- An architecture test reports one canonical GitHub App registration, repository binding, installation-token provider, settings path, and adapter implementation
- A workspace without a GitHub binding continues to produce a local review bundle and never attempts network delivery
- The GitHub adapter is selected only by an explicit healthy repository binding and accepted external-send authority policy
- ProviderBinding stores installation/repository identifiers and secret references but no installation token, app JWT, private key, PAT, or SSH key
- Existing GitHub delivery routes remain compatible and duplicate routes, vaults, token caches, and settings components are absent

### GEF-002
Map scm.repository.read, scm.branch.write, scm.pull_request.write, scm.checks.read, and scm.review.request to a GitHub App installation binding. Mint short-lived installation access tokens for exactly one approved repository and permission profile; cache only in memory for the lease; inject only into the trusted adapter process; revoke or allow bounded expiry after settlement. Preflight validates installation state, repository ownership/name/id, verified provider profile, app permission grant, token mintability, and binding generation. Exclude PAT, developer SSH, repository secret, and signing-key fallbacks.

**Acceptance criteria**
- Preflight rejects an unbound, suspended, stale, profile-unverified, permission-deficient, or non-mintable installation before branch work starts
- A minted lease accesses exactly the bound repository and only contents read/write, pull-request write, checks read, and review-request operations required by the grant
- Installation tokens and app JWTs are absent from model prompts, child persistent environment, job payloads, logs, API responses, receipts, and database rows
- A token cannot read or change Actions secrets, repository administration, releases, deployments, or another repository
- Lease settlement revokes the token when supported or records verified expiry and clears the in-memory cache

### GEF-003
Implement typed adapter operations for prepareRepository at the approved revision, createBranch using a collision-safe run/story identity, commit with the Rorca machine identity, push the feature branch under a separate external-send grant, create or update one pull request, observe checks, and request review. Use isolated worktrees and existing DeliveryAdapter semantics. Reject protected-branch push, force push, merge, tag, release, repository settings, Actions-secret mutation, and production deployment. A restarted operation discovers existing branch/PR resources before creating anything.

**Acceptance criteria**
- A disposable bound repository journey reports the approved base revision, isolated checkout, one feature branch, one Rorca-authored commit, one pull request, observed checks, and requested review
- Protected-branch push, force push, merge, tag, release, repository administration, Actions-secret mutation, and production deployment are absent or rejected
- Replaying branch push or pull-request creation returns the existing resource and produces no duplicate commit or pull request
- The adapter never changes LocalReviewBundleAdapter as the default provider-neutral delivery path
- The receipt records repository id, base and head revisions, branch, pull-request URL/id, check conclusions, review request, and no secret values

### GEF-004
Implement GitHub-specific reconcile and revoke behavior over the core attempt state machine. Mark externally accepted operations with stable repository, branch, commit, pull-request, check-run, and installation resource identifiers. On crash, query those identifiers before retry. Remove the isolated worktree after settlement while preserving the branch/review artifact according to policy. Revocation failure remains reconciliation-required and blocks new use.

**Acceptance criteria**
- Crash after push but before settlement finds the remote branch/commit and records one settled receipt without a second push
- Crash after pull-request acceptance finds and reuses the existing pull request without creating another
- Completion, denial, cancellation, expiry, and failure all remove the isolated worktree and settle token revocation or verified expiry
- A revocation failure leaves the lease unusable and reconciliation-required until a read-side check settles it
- Receipts are immutable, redacted, workspace scoped, and link every operation attempt to the core request/grant/lease

### GEF-005
Extend the existing GitHub settings surface and API rather than creating a second panel. Display app registration readiness, installation/repository binding, verified profile, granted permissions, token-mint probe result, binding generation, and capability availability. Allow explicit bind, revalidate, and disable operations under existing local provider-mutation authority. Never display or accept installation tokens. Data changes remain in core ProviderBinding and audit records; no child migration.

**Acceptance criteria**
- The existing settings panel displays one repository binding path with loading, missing, stale, ready, revalidation, disabled, and error states
- Bind and revalidate prove immutable repository identity and granted permissions without returning a token to the browser
- Disabling a binding invalidates preflight, revokes or expires active leases, and prevents new external-send grants
- Settings mutations remain local operator/admin tier and are not exposed through MCP
- A browser inspection reports no app private key, app JWT, installation token, PAT, or secret in DOM, storage, network response bodies, or logs

### GEF-006
Qualify the adapter on a disposable Rorca-owned repository with protected main and no customer workspace dependency. Inject prompt requests to reveal credentials, push main, merge, access another repository, read secrets, alter approved arguments, reuse a revoked token, replay a grant, and crash at each external boundary. Keep the adapter disabled by default after qualification; rollout is per healthy binding. Rollback disables the adapter, revokes leases, preserves local review bundles, and retains receipts.

**Acceptance criteria**
- The disposable journey completes feature-branch and pull-request delivery while protected main remains unchanged
- Credential reveal, protected-branch push, merge, other-repository access, Actions-secret access, altered request, replay, and revoked-token reuse all fail
- Crash at token mint, push, pull-request creation, check observation, and revocation resumes or reconciles once without duplicate external resources
- Disabling the adapter restores local review bundle delivery and leaves no active installation lease
- No Categoric/Cashflow-App repository, workspace, spec, environment, or product code is required by the qualification

## Success metrics
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

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

