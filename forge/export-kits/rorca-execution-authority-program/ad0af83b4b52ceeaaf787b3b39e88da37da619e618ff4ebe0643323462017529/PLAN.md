# Rorca Execution Authority Core — Delivery Plan

## Story order
1. **REA-001 — Authority records survive crashes and enforce one use**
2. **REA-002 — Operators decide exact requests without receiving credentials**
3. **REA-003 — Runs settle missing authority before story execution begins**
4. **REA-004 — Privileged effects resume without duplication after interruption**
5. **REA-005 — Provider adapters resolve secret references without ambient credentials**
6. **REA-006 — Operators can inspect and control durable authority waits**
7. **REA-007 — Redaction and scope violations fail closed at every boundary**
8. **REA-008 — Authority rolls out without changing legacy delivery defaults**

## Dependencies
- REA-001 → REA-002
- REA-002 → REA-003
- REA-003 → REA-004
- REA-001 → REA-005
- REA-004 → REA-005
- REA-002 → REA-006
- REA-003 → REA-006
- REA-004 → REA-007
- REA-005 → REA-007
- REA-006 → REA-008
- REA-007 → REA-008

## Verification
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

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
