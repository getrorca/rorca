# Rorca Stripe Credential Authority Adapter — Delivery Plan

## Story order
1. **SCR-001 — Stripe bindings inventory least-privilege credentials without storing values**
2. **SCR-002 — Human-assisted restricted-key creation bypasses neither reauthentication nor secret isolation**
3. **SCR-003 — Verified canary and grace cut over before old-key revocation**
4. **SCR-004 — Rotation failure restores payment access and surfaces emergency authority**
5. **SCR-005 — Stripe test-mode attacks cannot expose keys or interrupt the prior binding**

## Dependencies
- SCR-001 → SCR-002
- SCR-002 → SCR-003
- SCR-003 → SCR-004
- SCR-004 → SCR-005

## Verification
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

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
