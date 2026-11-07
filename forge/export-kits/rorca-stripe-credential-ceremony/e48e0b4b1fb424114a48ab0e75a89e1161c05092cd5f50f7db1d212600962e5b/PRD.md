# Rorca Stripe Credential Authority Adapter — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Stripe Credential Authority Adapter specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- SCR-001 — Stripe bindings inventory least-privilege credentials without storing values
- SCR-002 — Human-assisted restricted-key creation bypasses neither reauthentication nor secret isolation
- SCR-003 — Verified canary and grace cut over before old-key revocation
- SCR-004 — Rotation failure restores payment access and surfaces emergency authority
- SCR-005 — Stripe test-mode attacks cannot expose keys or interrupt the prior binding

## In scope
- Implement a generic Stripe AuthorityProviderAdapter and ProviderBinding inventory for account, test/live mode, application/resource binding, key kind, permission manifest, owner, fingerprint, SecretStore reference, target-binding reference, status, binding generation, and last verification. Treat webhook signing secrets as a distinct credential class. Use core tables/routes and no provider-specific secret column or child migration. Never map application runtime to an unrestricted account secret when a restricted key can satisfy the declared operations.
- Define an immutable rotation intent with current fingerprint, exact restricted permission manifest, test/live mode, target binding, canary, grace period, rollback, and human-step requirements. When Stripe Dashboard reauthentication or manual creation is required, pause in WAITING_FOR_AUTHENTICATION and present a secure operator ceremony. Capture the replacement directly into SecretStore/target binding; the model and ordinary API never receive it. Do not automate MFA, bypass provider controls, or use an unrestricted account secret as replacement.
- Stage the replacement through RuntimeSecretBindingAdapter, run a real bounded Stripe test-mode operation matching the permission manifest, verify target health and fingerprint, then enter the declared grace period. After post-cutover verification, revoke the old key through the supported provider/human ceremony and verify old-key failure. Reconcile provider and target state before retrying uncertain steps.
- Implement failure and runtime-detection paths. Canary/cutover failure restores the prior target binding, keeps the old key active when safe, quarantines the replacement, and emits a rollback receipt. Revoked/failing runtime credentials create a structured emergency rotation request with evidence; they do not inject a new secret or bypass approval. Unknown revocation outcome is reconciled before another action.
- Qualify on a dedicated Rorca-owned Stripe test account and disposable target binding. Exercise least-privilege inventory, human-assisted capture, real canary, grace, revocation verification where supported, rollback, runtime failure, replay, cross-mode/workspace denial, prompt extraction, and crash recovery. Live-mode remains disabled until separately authorized evidence exists. Rollback disables the adapter, restores the prior target binding, revokes/quarantines replacements, and preserves receipts. Non-goals are payment-product changes, billing logic, webhook processing, customer accounts, and automatic provider-control bypass.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### SCR-001
Implement a generic Stripe AuthorityProviderAdapter and ProviderBinding inventory for account, test/live mode, application/resource binding, key kind, permission manifest, owner, fingerprint, SecretStore reference, target-binding reference, status, binding generation, and last verification. Treat webhook signing secrets as a distinct credential class. Use core tables/routes and no provider-specific secret column or child migration. Never map application runtime to an unrestricted account secret when a restricted key can satisfy the declared operations.

**Acceptance criteria**
- Inventory returns every bound Stripe credential class with mode, application/resource scope, permissions, owner, fingerprint, status, generation, and verification time
- Inventory, API responses, logs, receipts, and database rows contain no key or webhook-secret values
- Test and live bindings are distinct and cross-mode fallback or reuse fails
- The adapter rejects application mappings broader than the approved permission manifest and reports why
- Webhook signing-secret rotation cannot be authorized by a restricted API-key grant

### SCR-002
Define an immutable rotation intent with current fingerprint, exact restricted permission manifest, test/live mode, target binding, canary, grace period, rollback, and human-step requirements. When Stripe Dashboard reauthentication or manual creation is required, pause in WAITING_FOR_AUTHENTICATION and present a secure operator ceremony. Capture the replacement directly into SecretStore/target binding; the model and ordinary API never receive it. Do not automate MFA, bypass provider controls, or use an unrestricted account secret as replacement.

**Acceptance criteria**
- Changing permissions, mode, target, canary, grace, rollback, or current fingerprint changes the digest and invalidates approval
- Required Dashboard reauthentication and restricted-key creation cannot be bypassed, scripted through model prompts, or marked complete without provider evidence
- Secure operator capture writes the replacement to SecretStore/target binding and returns only reference, fingerprint, and provenance
- A replacement broader than the approved permission manifest or in the wrong mode is rejected before cutover
- Waiting for the human step does not consume story timeout and resumes exactly once against the same intent

### SCR-003
Stage the replacement through RuntimeSecretBindingAdapter, run a real bounded Stripe test-mode operation matching the permission manifest, verify target health and fingerprint, then enter the declared grace period. After post-cutover verification, revoke the old key through the supported provider/human ceremony and verify old-key failure. Reconcile provider and target state before retrying uncertain steps.

**Acceptance criteria**
- The old key remains active while secure capture, target stage, canary, and post-cutover verification are pending
- The canary calls a real Stripe test-mode operation requiring the declared permissions rather than only a local health endpoint
- Grace-period state records both fingerprints and exact expiry without exposing either value
- Old-key revocation occurs only after successful canary/cutover and is followed by verified old-key rejection
- Replay or crash discovers the existing replacement/binding state and produces no duplicate rotation or untracked key

### SCR-004
Implement failure and runtime-detection paths. Canary/cutover failure restores the prior target binding, keeps the old key active when safe, quarantines the replacement, and emits a rollback receipt. Revoked/failing runtime credentials create a structured emergency rotation request with evidence; they do not inject a new secret or bypass approval. Unknown revocation outcome is reconciled before another action.

**Acceptance criteria**
- Canary or pre-revocation failure restores the prior binding, retains the old key, quarantines the replacement, and records a rollback receipt
- Runtime authentication failure creates a typed emergency request linked to binding, fingerprint, evidence, and affected resource without a secret
- Emergency state cannot grant itself, broaden permissions, cross mode/workspace, or skip required Dashboard authentication
- Unknown old/new key status is read back or sent to manual reconciliation before retry
- Errors, incident evidence, receipts, WAL events, and UI contain no Stripe key or webhook-secret value

### SCR-005
Qualify on a dedicated Rorca-owned Stripe test account and disposable target binding. Exercise least-privilege inventory, human-assisted capture, real canary, grace, revocation verification where supported, rollback, runtime failure, replay, cross-mode/workspace denial, prompt extraction, and crash recovery. Live-mode remains disabled until separately authorized evidence exists. Rollback disables the adapter, restores the prior target binding, revokes/quarantines replacements, and preserves receipts. Non-goals are payment-product changes, billing logic, webhook processing, customer accounts, and automatic provider-control bypass.

**Acceptance criteria**
- The test-mode journey proves restricted permissions, secure capture, real canary, cutover, and rollback without exposing key values
- Prompt extraction, cross-mode/workspace use, broadened permissions, altered intent, replay, and expired grant all fail
- Crash at secure capture, target stage, canary, grace, revocation, and receipt settlement resumes or reconciles once
- Every injected failure leaves the prior disposable payment binding functional or records an explicit manual-reconciliation blocker
- No Categoric/Cashflow-App Stripe account, key, environment, payment flow, or product code is used

## Success metrics
- SCR-001: Inventory returns every bound Stripe credential class with mode, application/resource scope, permissions, owner, fingerprint, status, generation, and verification time
- SCR-001: Inventory, API responses, logs, receipts, and database rows contain no key or webhook-secret values
- SCR-001: Test and live bindings are distinct and cross-mode fallback or reuse fails
- SCR-001: The adapter rejects application mappings broader than the approved permission manifest and reports why
- SCR-001: Webhook signing-secret rotation cannot be authorized by a restricted API-key grant
- SCR-002: Changing permissions, mode, target, canary, grace, rollback, or current fingerprint changes the digest and invalidates approval
- SCR-002: Required Dashboard reauthentication and restricted-key creation cannot be bypassed, scripted through model prompts, or marked complete without provider evidence
- SCR-002: Secure operator capture writes the replacement to SecretStore/target binding and returns only reference, fingerprint, and provenance
- SCR-002: A replacement broader than the approved permission manifest or in the wrong mode is rejected before cutover
- SCR-002: Waiting for the human step does not consume story timeout and resumes exactly once against the same intent
- SCR-003: The old key remains active while secure capture, target stage, canary, and post-cutover verification are pending
- SCR-003: The canary calls a real Stripe test-mode operation requiring the declared permissions rather than only a local health endpoint
- SCR-003: Grace-period state records both fingerprints and exact expiry without exposing either value
- SCR-003: Old-key revocation occurs only after successful canary/cutover and is followed by verified old-key rejection
- SCR-003: Replay or crash discovers the existing replacement/binding state and produces no duplicate rotation or untracked key
- SCR-004: Canary or pre-revocation failure restores the prior binding, retains the old key, quarantines the replacement, and records a rollback receipt
- SCR-004: Runtime authentication failure creates a typed emergency request linked to binding, fingerprint, evidence, and affected resource without a secret
- SCR-004: Emergency state cannot grant itself, broaden permissions, cross mode/workspace, or skip required Dashboard authentication
- SCR-004: Unknown old/new key status is read back or sent to manual reconciliation before retry
- SCR-004: Errors, incident evidence, receipts, WAL events, and UI contain no Stripe key or webhook-secret value
- SCR-005: The test-mode journey proves restricted permissions, secure capture, real canary, cutover, and rollback without exposing key values
- SCR-005: Prompt extraction, cross-mode/workspace use, broadened permissions, altered intent, replay, and expired grant all fail
- SCR-005: Crash at secure capture, target stage, canary, grace, revocation, and receipt settlement resumes or reconciles once
- SCR-005: Every injected failure leaves the prior disposable payment binding functional or records an explicit manual-reconciliation blocker
- SCR-005: No Categoric/Cashflow-App Stripe account, key, environment, payment flow, or product code is used

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

