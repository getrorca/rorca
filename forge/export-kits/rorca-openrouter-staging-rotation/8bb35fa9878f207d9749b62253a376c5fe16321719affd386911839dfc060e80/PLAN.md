# Rorca OpenRouter Runtime-Key Rotation Adapter — Delivery Plan

## Story order
1. **OSR-001 — OpenRouter management bindings expose lifecycle operations but never inference**
2. **OSR-002 — One rotation intent creates at most one bounded replacement key**
3. **OSR-003 — Canary success cuts over the target before the old key is revoked**
4. **OSR-004 — Failure restores the prior target and reconciles every created key**
5. **OSR-005 — A bounded live rotation proves security before workspace rollout**

## Dependencies
- OSR-001 → OSR-002
- OSR-002 → OSR-003
- OSR-003 → OSR-004
- OSR-004 → OSR-005

## Verification
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

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
