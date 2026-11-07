# Rorca OpenRouter Runtime-Key Rotation Adapter — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca OpenRouter Runtime-Key Rotation Adapter specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- OSR-001 — OpenRouter management bindings expose lifecycle operations but never inference
- OSR-002 — One rotation intent creates at most one bounded replacement key
- OSR-003 — Canary success cuts over the target before the old key is revoked
- OSR-004 — Failure restores the prior target and reconciles every created key
- OSR-005 — A bounded live rotation proves security before workspace rollout

## In scope
- Implement an OpenRouter AuthorityProviderAdapter using a core ProviderBinding and SecretStore reference for the management key. Expose semantic list, create-limited-key, disable, delete, and verify operations; never return the management credential. Store provider account identity, binding generation, policy limits, fingerprints, and resource ids in core records; add no provider-specific secret column or child migration. Preflight verifies the management endpoint, account binding, scope, and the documented invariant that the management credential cannot call completion endpoints.
- Define an immutable rotation intent containing provider binding, current runtime-key fingerprint/reference, desired name, credit and usage limits, target RuntimeSecretBindingAdapter reference, canary contract, timeout, rollback action, and exact request digest. Create a distinctly named limited replacement under the core idempotency/fencing state machine. If outcome is uncertain, list provider keys by stable intent metadata before creating another. Parent and replacement secret values stay inside SecretStore and trusted adapters.
- Stage the replacement through the generic RuntimeSecretBindingAdapter, deploy or refresh the target when the binding requires it, and run the declared real OpenRouter completion through that target surface rather than a health-only endpoint. Keep the old key active until the target revision and completion result pass. Then atomically mark the new binding active, disable the old provider key, and verify old-key rejection. Do not depend on Coolify specifically; a Coolify implementation may satisfy the binding contract later.
- Implement rollback for provider creation failure, target-binding failure, deploy failure, canary failure, cutover uncertainty, old-key disable failure, and receipt/revocation failure. Restore the prior target binding when changed, retain the old key when safe, disable/delete the failed replacement, and emit a rollback or reconciliation-required receipt. Inject crashes after key creation, binding stage, deploy acceptance, canary result, cutover, and old-key disable.
- Qualify against a dedicated low-limit OpenRouter test account/binding and a disposable Rorca-owned target-binding fixture. Exercise real management API lifecycle, real inference canary, cutover, old-key rejection, rollback, replay, cross-scope denial, prompt extraction attempts, and crash recovery. Keep rollout off by default; enable per verified workspace binding only. Rollback disables the adapter, restores the prior binding where possible, revokes replacements, and preserves receipts. Non-goals are alternate LLM providers, customer environment changes, billing management, and automated production rotation without explicit policy.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### OSR-001
Implement an OpenRouter AuthorityProviderAdapter using a core ProviderBinding and SecretStore reference for the management key. Expose semantic list, create-limited-key, disable, delete, and verify operations; never return the management credential. Store provider account identity, binding generation, policy limits, fingerprints, and resource ids in core records; add no provider-specific secret column or child migration. Preflight verifies the management endpoint, account binding, scope, and the documented invariant that the management credential cannot call completion endpoints.

**Acceptance criteria**
- A healthy binding lists key metadata and fingerprints through redacted DTOs without returning key values
- The management credential is resolved only inside the adapter and a completion-endpoint probe rejects it
- Code, config, process-wide environment, model context, job payloads, logs, errors, API responses, and receipts contain no management key
- Cross-workspace, stale-generation, wrong-account, and unapproved management operations fail before a provider call
- Disabling the binding prevents new rotations and leaves existing runtime keys unchanged pending explicit reconciliation

### OSR-002
Define an immutable rotation intent containing provider binding, current runtime-key fingerprint/reference, desired name, credit and usage limits, target RuntimeSecretBindingAdapter reference, canary contract, timeout, rollback action, and exact request digest. Create a distinctly named limited replacement under the core idempotency/fencing state machine. If outcome is uncertain, list provider keys by stable intent metadata before creating another. Parent and replacement secret values stay inside SecretStore and trusted adapters.

**Acceptance criteria**
- Changing the provider binding, current fingerprint, limits, target binding, canary, timeout, or rollback action changes the digest and invalidates approval
- Concurrent and replayed execution creates at most one replacement key for the rotation intent
- Crash after provider acceptance reconciles the replacement by stable metadata and records its provider resource id before continuing
- Every created key is tracked as pending, active, revoked, cleanup-required, or reconciled; unknown is not a terminal state
- A replacement key receives only the declared limits and cannot be used across another workspace or environment binding

### OSR-003
Stage the replacement through the generic RuntimeSecretBindingAdapter, deploy or refresh the target when the binding requires it, and run the declared real OpenRouter completion through that target surface rather than a health-only endpoint. Keep the old key active until the target revision and completion result pass. Then atomically mark the new binding active, disable the old provider key, and verify old-key rejection. Do not depend on Coolify specifically; a Coolify implementation may satisfy the binding contract later.

**Acceptance criteria**
- The old key remains active while the replacement binding, target revision, and real provider-backed completion canary are pending
- A health-only response cannot satisfy the canary contract
- Canary success records the target binding generation and deployed revision before disabling the old key
- Cutover disables the old key, verifies old-key rejection, settles the new key active, and emits one redacted receipt
- An unavailable target-binding adapter produces durable WAITING_FOR_AUTHORIZATION without consuming story execution timeout

### OSR-004
Implement rollback for provider creation failure, target-binding failure, deploy failure, canary failure, cutover uncertainty, old-key disable failure, and receipt/revocation failure. Restore the prior target binding when changed, retain the old key when safe, disable/delete the failed replacement, and emit a rollback or reconciliation-required receipt. Inject crashes after key creation, binding stage, deploy acceptance, canary result, cutover, and old-key disable.

**Acceptance criteria**
- Every failed pre-cutover path leaves the prior key active and the target functional
- A changed target binding is restored to its prior generation before the failed replacement is disabled or deleted
- Crash at each external boundary resumes or reconciles once without duplicate keys or untracked target bindings
- An uncertain old-key disable is read back before any retry and cannot disable the replacement by mistake
- No failure log, exception, receipt, WAL event, or API response contains either key value

### OSR-005
Qualify against a dedicated low-limit OpenRouter test account/binding and a disposable Rorca-owned target-binding fixture. Exercise real management API lifecycle, real inference canary, cutover, old-key rejection, rollback, replay, cross-scope denial, prompt extraction attempts, and crash recovery. Keep rollout off by default; enable per verified workspace binding only. Rollback disables the adapter, restores the prior binding where possible, revokes replacements, and preserves receipts. Non-goals are alternate LLM providers, customer environment changes, billing management, and automated production rotation without explicit policy.

**Acceptance criteria**
- The bounded live fixture records successful replacement, real inference, cutover, old-key rejection, and provider resource cleanup within the declared spend limit
- Prompt extraction, cross-workspace/environment use, altered intent, replay, expired grant, and revoked-key reuse all fail
- Injected crashes leave the target functional and every provider key in a known reconciled state
- The adapter remains unavailable without an explicit healthy binding and accepted rotation policy
- Qualification and rollback require no Categoric/Cashflow-App code, environment, credential, or workspace

## Success metrics
- OSR-001: A healthy binding lists key metadata and fingerprints through redacted DTOs without returning key values
- OSR-001: The management credential is resolved only inside the adapter and a completion-endpoint probe rejects it
- OSR-001: Code, config, process-wide environment, model context, job payloads, logs, errors, API responses, and receipts contain no management key
- OSR-001: Cross-workspace, stale-generation, wrong-account, and unapproved management operations fail before a provider call
- OSR-001: Disabling the binding prevents new rotations and leaves existing runtime keys unchanged pending explicit reconciliation
- OSR-002: Changing the provider binding, current fingerprint, limits, target binding, canary, timeout, or rollback action changes the digest and invalidates approval
- OSR-002: Concurrent and replayed execution creates at most one replacement key for the rotation intent
- OSR-002: Crash after provider acceptance reconciles the replacement by stable metadata and records its provider resource id before continuing
- OSR-002: Every created key is tracked as pending, active, revoked, cleanup-required, or reconciled; unknown is not a terminal state
- OSR-002: A replacement key receives only the declared limits and cannot be used across another workspace or environment binding
- OSR-003: The old key remains active while the replacement binding, target revision, and real provider-backed completion canary are pending
- OSR-003: A health-only response cannot satisfy the canary contract
- OSR-003: Canary success records the target binding generation and deployed revision before disabling the old key
- OSR-003: Cutover disables the old key, verifies old-key rejection, settles the new key active, and emits one redacted receipt
- OSR-003: An unavailable target-binding adapter produces durable WAITING_FOR_AUTHORIZATION without consuming story execution timeout
- OSR-004: Every failed pre-cutover path leaves the prior key active and the target functional
- OSR-004: A changed target binding is restored to its prior generation before the failed replacement is disabled or deleted
- OSR-004: Crash at each external boundary resumes or reconciles once without duplicate keys or untracked target bindings
- OSR-004: An uncertain old-key disable is read back before any retry and cannot disable the replacement by mistake
- OSR-004: No failure log, exception, receipt, WAL event, or API response contains either key value
- OSR-005: The bounded live fixture records successful replacement, real inference, cutover, old-key rejection, and provider resource cleanup within the declared spend limit
- OSR-005: Prompt extraction, cross-workspace/environment use, altered intent, replay, expired grant, and revoked-key reuse all fail
- OSR-005: Injected crashes leave the target functional and every provider key in a known reconciled state
- OSR-005: The adapter remains unavailable without an explicit healthy binding and accepted rotation policy
- OSR-005: Qualification and rollback require no Categoric/Cashflow-App code, environment, credential, or workspace

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

