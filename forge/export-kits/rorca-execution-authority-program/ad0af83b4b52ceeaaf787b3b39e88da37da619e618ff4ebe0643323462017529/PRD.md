# Rorca Execution Authority Core — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Execution Authority Core specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- REA-001 — Authority records survive crashes and enforce one use
- REA-002 — Operators decide exact requests without receiving credentials
- REA-003 — Runs settle missing authority before story execution begins
- REA-004 — Privileged effects resume without duplication after interruption
- REA-005 — Provider adapters resolve secret references without ambient credentials
- REA-006 — Operators can inspect and control durable authority waits
- REA-007 — Redaction and scope violations fail closed at every boundary
- REA-008 — Authority rolls out without changing legacy delivery defaults

## In scope
- Define versioned Rorca authority persistence in the next canonical backend/src/db/pg-migrations migration and matching backend contracts. Persist OperationIntent, AuthorityRequest, AuthorityDecision, AuthorityGrant, CredentialLease, ExecutionAttempt, ExecutionReceipt, and ProviderBinding with workspace/run/story principals, canonical digests, state transitions, expiry, maximumUses, idempotency keys, fencing generations, timestamps, provenance, and reference-only secret fields. Receipts are append-only. Use Rorca PostgreSQL helpers and numbered parameters; do not touch pgboss.*. Rollback policy is forward-fix plus backup/restore for populated upgrades, not ad hoc down SQL.
- Add the Rorca authority policy service and one operator-only route resource in backend/src/routes with Swagger annotations. Create/read/cancel requests; approve or deny an exact request digest; inspect redacted receipts. The requesting execution principal and the local operator principal are distinct even though Rorca remains local single-user with authRequired=false. The requesting model cannot invoke decision mutations; provider credentials are not fields in request or decision DTOs. A grant binds workspace, run, work item, environment, resource, operation, constraints, evidence digest, expiry, and maximumUses. Mutations are admin-tier and never MCP-exposed.
- Extend canonical story/run-plan contracts with versioned required-capability declarations containing capability id, binding reference, environment/resource scope, requested mode, and evidence requirements. At enqueue, compile the union for all runnable stories, ask registered adapters to validate binding health and credential mintability, and batch missing requirements before dispatch. Persist WAITING_FOR_AUTHORIZATION, WAITING_FOR_AUTHENTICATION, and WAITING_FOR_CHANGE_WINDOW as run states. Waiting uses a separate request expiry and never consumes story execution timeout. Recompile when spec revision, binding generation, or policy changes.
- Add the trusted operation executor around existing completion-runner durability patterns. Every provider effect moves through reserved, running, uncertain, and settled attempt states under an idempotency key and fencing generation. Crash recovery reconciles an uncertain external result through the adapter read path before retrying. The executor preserves completed work, resumes an authorized operation effectively once, and settles a redacted ExecutionReceipt before releasing the run. No narrative blocked note substitutes for the state machine.
- Define provider-neutral AuthorityProviderAdapter and RuntimeSecretBindingAdapter contracts for capability description, health preflight, lease preparation, execute, reconcile, revoke, and redacted receipt projection. Define SecretStore for reference resolution and attributable access audit. Keep the existing encrypted database vault as the default zero-network/offline adapter. Add an optional Infisical adapter behind configuration; it is never the default and must fail closed on unavailable, stale, or unauthorized resolution. Job payloads and model prompts carry opaque references only; values materialize inside the trusted broker boundary for the minimum operation lifetime.
- Add an Execution Authority operator surface using src/lib/apiFetch and existing panel/SlideOver patterns. Show a keyboard-accessible approval inbox, exact request digest and scope, evidence and binding health, expiry/max uses, run/story location, and approve/deny/cancel controls. Run views display each typed waiting state and distinguish wait expiry from story execution timeout. Render loading, empty, stale, denied, error, and resumed states. No secret value may enter React state, DOM text, localStorage, screenshots, or analytics.
- Centralize authority redaction for request payloads, execution job data, logs, errors, WAL events, SSE, API projections, and receipts. Add secret canaries and adversarial cases for prompt-driven reveal attempts, operator-digest forgery, request mutation, expiry, replay, maximum-use exhaustion, cross-run/workspace/environment/resource reuse, revoked leases, and broker egress outside the adapter allowlist. Preserve existing autonomous bwrap isolation and cleared model environments.
- Ship the authority core behind an off-by-default workspace capability profile. Existing specs without required-capability declarations retain current local execution and provider-neutral LocalReviewBundleAdapter behavior. Initially register no mutation-capable provider adapter. This seven-spec program remains pending and cannot approve or run itself. Until the GitHub authority adapter is accepted, program execution policy is branch-only: preserve isolated run branches and reject protected-branch push, PR merge, release, and production effects. Document schemas, API contracts, recovery, retention, operator ceremony, rollout, and forward-fix procedures only after a disposable Rorca-owned smoke fixture passes. Non-goals are hosted auth, tenants, SSO, billing, enterprise RBAC, generalized marketplace discovery, and speculative providers.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### REA-001
Define versioned Rorca authority persistence in the next canonical backend/src/db/pg-migrations migration and matching backend contracts. Persist OperationIntent, AuthorityRequest, AuthorityDecision, AuthorityGrant, CredentialLease, ExecutionAttempt, ExecutionReceipt, and ProviderBinding with workspace/run/story principals, canonical digests, state transitions, expiry, maximumUses, idempotency keys, fencing generations, timestamps, provenance, and reference-only secret fields. Receipts are append-only. Use Rorca PostgreSQL helpers and numbered parameters; do not touch pgboss.*. Rollback policy is forward-fix plus backup/restore for populated upgrades, not ad hoc down SQL.

**Acceptance criteria**
- The migration applies to a fresh PostgreSQL 16 database and a populated upgrade fixture without touching pgboss.*
- Database constraints reject duplicate idempotency keys, stale fencing generations, over-use, illegal transitions, and grants whose expiry precedes creation
- Authority and receipt rows contain secret references, fingerprints, and provider resource ids but reject provider credential bytes
- Receipt mutation and deletion fail after settlement while retention metadata remains queryable
- A failed upgrade restores the pre-migration fixture or follows the tested forward-fix procedure with no partial authority schema

### REA-002
Add the Rorca authority policy service and one operator-only route resource in backend/src/routes with Swagger annotations. Create/read/cancel requests; approve or deny an exact request digest; inspect redacted receipts. The requesting execution principal and the local operator principal are distinct even though Rorca remains local single-user with authRequired=false. The requesting model cannot invoke decision mutations; provider credentials are not fields in request or decision DTOs. A grant binds workspace, run, work item, environment, resource, operation, constraints, evidence digest, expiry, and maximumUses. Mutations are admin-tier and never MCP-exposed.

**Acceptance criteria**
- The API schema returns typed request, decision, grant, and receipt projections and Swagger declares x-rorca-tier and rationale for every operation
- Approval succeeds only for the current exact request digest and records the local operator principal separately from the requesting execution principal
- Denied, cancelled, expired, altered, replayed, and over-used grants return typed failures and execute no provider operation
- The requesting model and ordinary execution child cannot call approve or deny mutations even when prompted
- API responses, WAL events, and audit rows contain no provider secret value

### REA-003
Extend canonical story/run-plan contracts with versioned required-capability declarations containing capability id, binding reference, environment/resource scope, requested mode, and evidence requirements. At enqueue, compile the union for all runnable stories, ask registered adapters to validate binding health and credential mintability, and batch missing requirements before dispatch. Persist WAITING_FOR_AUTHORIZATION, WAITING_FOR_AUTHENTICATION, and WAITING_FOR_CHANGE_WINDOW as run states. Waiting uses a separate request expiry and never consumes story execution timeout. Recompile when spec revision, binding generation, or policy changes.

**Acceptance criteria**
- Run enqueue rejects unknown capabilities, malformed scopes, missing bindings, and stale binding generations before any story job is sent
- A run with all capabilities pre-authorized dispatches without an approval round trip
- A run with multiple missing capabilities creates one durable batched preflight result linked to the exact spec revision and does not start a story timeout
- Restart preserves each waiting request, completed story result, pending story position, and separate wait expiry
- Changing the spec revision, provider binding, environment, or policy invalidates the prior preflight and grant

### REA-004
Add the trusted operation executor around existing completion-runner durability patterns. Every provider effect moves through reserved, running, uncertain, and settled attempt states under an idempotency key and fencing generation. Crash recovery reconciles an uncertain external result through the adapter read path before retrying. The executor preserves completed work, resumes an authorized operation effectively once, and settles a redacted ExecutionReceipt before releasing the run. No narrative blocked note substitutes for the state machine.

**Acceptance criteria**
- Concurrent or replayed dispatch with one idempotency key produces at most one active fenced attempt
- A stale worker cannot settle, revoke, or repeat an operation after a newer fencing generation is reserved
- Crash after external acceptance but before local settlement performs read-side reconciliation and records one receipt without repeating the external effect
- Crash before external acceptance safely retries under the same idempotency key
- Run restart resumes from the exact operation and story position without duplicating commits, deployments, rotations, migrations, or browser sessions

### REA-005
Define provider-neutral AuthorityProviderAdapter and RuntimeSecretBindingAdapter contracts for capability description, health preflight, lease preparation, execute, reconcile, revoke, and redacted receipt projection. Define SecretStore for reference resolution and attributable access audit. Keep the existing encrypted database vault as the default zero-network/offline adapter. Add an optional Infisical adapter behind configuration; it is never the default and must fail closed on unavailable, stale, or unauthorized resolution. Job payloads and model prompts carry opaque references only; values materialize inside the trusted broker boundary for the minimum operation lifetime.

**Acceptance criteria**
- The existing database vault implements SecretStore without changing stored ciphertext semantics and remains the default when no external backend is configured
- The optional Infisical adapter passes reference-only payload, principal/purpose audit, bounded latency, explicit offline behavior, and no-ambient-fallback contract tests
- Provider adapters cannot return raw credentials through execute, reconcile, error, log, receipt, or SSE result types
- Secret resolution enforces exact workspace, environment, provider, resource, action, and lease purpose and rejects cross-scope reuse
- A resolution or revocation failure fails the operation closed, marks reconciliation required, and never falls back to process.env or plaintext config

### REA-006
Add an Execution Authority operator surface using src/lib/apiFetch and existing panel/SlideOver patterns. Show a keyboard-accessible approval inbox, exact request digest and scope, evidence and binding health, expiry/max uses, run/story location, and approve/deny/cancel controls. Run views display each typed waiting state and distinguish wait expiry from story execution timeout. Render loading, empty, stale, denied, error, and resumed states. No secret value may enter React state, DOM text, localStorage, screenshots, or analytics.

**Acceptance criteria**
- The inbox lists only the selected workspace requests and renders loading, empty, error, stale, and active states
- Request detail displays digest, principal, operation, resource, environment, constraints, evidence, binding generation, expiry, and maximum uses without a credential field
- Approve, deny, and cancel refresh the run state and cannot submit against a stale digest
- WAITING_FOR_AUTHORIZATION, WAITING_FOR_AUTHENTICATION, and WAITING_FOR_CHANGE_WINDOW appear distinctly while the story timeout remains stopped
- Keyboard navigation, focus return, accessible names, and destructive-action confirmation pass a browser-driven operator journey

### REA-007
Centralize authority redaction for request payloads, execution job data, logs, errors, WAL events, SSE, API projections, and receipts. Add secret canaries and adversarial cases for prompt-driven reveal attempts, operator-digest forgery, request mutation, expiry, replay, maximum-use exhaustion, cross-run/workspace/environment/resource reuse, revoked leases, and broker egress outside the adapter allowlist. Preserve existing autonomous bwrap isolation and cleared model environments.

**Acceptance criteria**
- Injected secret canaries never appear in model environment, prompts, job JSON, logs, errors, WAL, SSE, API responses, screenshots, or receipts
- Forged operator capability digests and agent-originated decision requests fail before a grant is written
- Altered, expired, replayed, over-used, revoked, and cross-scope grants execute no adapter operation
- Adapter egress outside the declared provider host allowlist fails and records a redacted security event
- A crash during approval, lease mint, execution, receipt settlement, or revocation leaves a recoverable state with no untracked live lease

### REA-008
Ship the authority core behind an off-by-default workspace capability profile. Existing specs without required-capability declarations retain current local execution and provider-neutral LocalReviewBundleAdapter behavior. Initially register no mutation-capable provider adapter. This seven-spec program remains pending and cannot approve or run itself. Until the GitHub authority adapter is accepted, program execution policy is branch-only: preserve isolated run branches and reject protected-branch push, PR merge, release, and production effects. Document schemas, API contracts, recovery, retention, operator ceremony, rollout, and forward-fix procedures only after a disposable Rorca-owned smoke fixture passes. Non-goals are hosted auth, tenants, SSO, billing, enterprise RBAC, generalized marketplace discovery, and speculative providers.

**Acceptance criteria**
- A workspace with the feature disabled produces byte-compatible legacy run planning and delivery behavior
- A workspace with the feature enabled but no provider adapters can preflight and wait but cannot perform an external mutation
- Dispatch for these pending specs rejects direct, pr, and draft-pr delivery and preserves an isolated branch until the accepted GitHub external-send policy exists
- Migration, API, UI, crash-recovery, redaction, and disposable-fixture smoke evidence is attached before the capability profile can be enabled
- Disabling the profile stops new leases, revokes or reconciles active leases, preserves receipts, and restores legacy local delivery without deleting audit history

## Success metrics
- REA-001: The migration applies to a fresh PostgreSQL 16 database and a populated upgrade fixture without touching pgboss.*
- REA-001: Database constraints reject duplicate idempotency keys, stale fencing generations, over-use, illegal transitions, and grants whose expiry precedes creation
- REA-001: Authority and receipt rows contain secret references, fingerprints, and provider resource ids but reject provider credential bytes
- REA-001: Receipt mutation and deletion fail after settlement while retention metadata remains queryable
- REA-001: A failed upgrade restores the pre-migration fixture or follows the tested forward-fix procedure with no partial authority schema
- REA-002: The API schema returns typed request, decision, grant, and receipt projections and Swagger declares x-rorca-tier and rationale for every operation
- REA-002: Approval succeeds only for the current exact request digest and records the local operator principal separately from the requesting execution principal
- REA-002: Denied, cancelled, expired, altered, replayed, and over-used grants return typed failures and execute no provider operation
- REA-002: The requesting model and ordinary execution child cannot call approve or deny mutations even when prompted
- REA-002: API responses, WAL events, and audit rows contain no provider secret value
- REA-003: Run enqueue rejects unknown capabilities, malformed scopes, missing bindings, and stale binding generations before any story job is sent
- REA-003: A run with all capabilities pre-authorized dispatches without an approval round trip
- REA-003: A run with multiple missing capabilities creates one durable batched preflight result linked to the exact spec revision and does not start a story timeout
- REA-003: Restart preserves each waiting request, completed story result, pending story position, and separate wait expiry
- REA-003: Changing the spec revision, provider binding, environment, or policy invalidates the prior preflight and grant
- REA-004: Concurrent or replayed dispatch with one idempotency key produces at most one active fenced attempt
- REA-004: A stale worker cannot settle, revoke, or repeat an operation after a newer fencing generation is reserved
- REA-004: Crash after external acceptance but before local settlement performs read-side reconciliation and records one receipt without repeating the external effect
- REA-004: Crash before external acceptance safely retries under the same idempotency key
- REA-004: Run restart resumes from the exact operation and story position without duplicating commits, deployments, rotations, migrations, or browser sessions
- REA-005: The existing database vault implements SecretStore without changing stored ciphertext semantics and remains the default when no external backend is configured
- REA-005: The optional Infisical adapter passes reference-only payload, principal/purpose audit, bounded latency, explicit offline behavior, and no-ambient-fallback contract tests
- REA-005: Provider adapters cannot return raw credentials through execute, reconcile, error, log, receipt, or SSE result types
- REA-005: Secret resolution enforces exact workspace, environment, provider, resource, action, and lease purpose and rejects cross-scope reuse
- REA-005: A resolution or revocation failure fails the operation closed, marks reconciliation required, and never falls back to process.env or plaintext config
- REA-006: The inbox lists only the selected workspace requests and renders loading, empty, error, stale, and active states
- REA-006: Request detail displays digest, principal, operation, resource, environment, constraints, evidence, binding generation, expiry, and maximum uses without a credential field
- REA-006: Approve, deny, and cancel refresh the run state and cannot submit against a stale digest
- REA-006: WAITING_FOR_AUTHORIZATION, WAITING_FOR_AUTHENTICATION, and WAITING_FOR_CHANGE_WINDOW appear distinctly while the story timeout remains stopped
- REA-006: Keyboard navigation, focus return, accessible names, and destructive-action confirmation pass a browser-driven operator journey
- REA-007: Injected secret canaries never appear in model environment, prompts, job JSON, logs, errors, WAL, SSE, API responses, screenshots, or receipts
- REA-007: Forged operator capability digests and agent-originated decision requests fail before a grant is written
- REA-007: Altered, expired, replayed, over-used, revoked, and cross-scope grants execute no adapter operation
- REA-007: Adapter egress outside the declared provider host allowlist fails and records a redacted security event
- REA-007: A crash during approval, lease mint, execution, receipt settlement, or revocation leaves a recoverable state with no untracked live lease
- REA-008: A workspace with the feature disabled produces byte-compatible legacy run planning and delivery behavior
- REA-008: A workspace with the feature enabled but no provider adapters can preflight and wait but cannot perform an external mutation
- REA-008: Dispatch for these pending specs rejects direct, pr, and draft-pr delivery and preserves an isolated branch until the accepted GitHub external-send policy exists
- REA-008: Migration, API, UI, crash-recovery, redaction, and disposable-fixture smoke evidence is attached before the capability profile can be enabled
- REA-008: Disabling the profile stops new leases, revokes or reconciles active leases, preserves receipts, and restores legacy local delivery without deleting audit history

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

