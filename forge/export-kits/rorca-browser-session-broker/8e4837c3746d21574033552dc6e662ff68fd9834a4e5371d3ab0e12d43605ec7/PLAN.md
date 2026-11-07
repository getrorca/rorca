# Rorca Authenticated Browser Session Broker — Delivery Plan

## Story order
1. **BSB-001 — Dedicated browser profiles keep external identity secrets outside model context**
2. **BSB-002 — Expiring browser leases isolate one run, purpose, profile, and domain set**
3. **BSB-003 — Step-up authentication pauses durably for the human operator**
4. **BSB-004 — Claude onboarding proves a real MCP consumer journey on a Rorca-owned fixture**
5. **BSB-005 — ChatGPT onboarding produces evidence equivalent to the Claude journey**
6. **BSB-006 — Browser-session attacks and crashes leave accounts healthy and evidence complete**

## Dependencies
- BSB-001 → BSB-002
- BSB-002 → BSB-003
- BSB-003 → BSB-004
- BSB-004 → BSB-005
- BSB-005 → BSB-006

## Verification
- BSB-001: Each provider test identity has a separately encrypted profile, immutable account alias, domain allowlist, generation, retention, and health state
- BSB-001: Enrollment records human provenance and provider/session health without recording password, cookie, TOTP seed, passkey private material, or recovery code
- BSB-001: Profiles mount only into isolated browser runners and are absent from model context, prompts, job JSON, logs, API bodies, screenshots, and authority rows
- BSB-001: Cross-provider, cross-account, cross-workspace, and non-allowlisted origin use fails before navigation
- BSB-001: Deleting or quarantining a profile revokes active leases and preserves redacted audit evidence
- BSB-002: Lease issuance rejects unhealthy/stale profiles, wrong workspace/provider, broadened origins/actions, expired grants, and concurrent use beyond policy
- BSB-002: One lease mounts one profile generation into one isolated runner and exposes no raw profile file to the model
- BSB-002: Network navigation outside the exact provider/MCP allowlist fails and records a redacted security event
- BSB-002: Revocation terminates the runner, invalidates further actions, clears ephemeral state, and applies the profile retention policy
- BSB-002: Crash or lost runner heartbeat reconciles session/provider health before the profile can be leased again
- BSB-003: Each supported step-up state produces a typed request and durable run wait rather than a narrative block or story timeout
- BSB-003: The operator can complete or cancel the step on a takeover surface while model input and automation are suspended
- BSB-003: MFA, passkey, CAPTCHA, account lock, and provider anti-automation controls cannot be bypassed or marked complete without observed provider state
- BSB-003: Restart during the wait preserves exact browser/profile/run position and resumes once only after health revalidation
- BSB-003: Denied, cancelled, expired, unhealthy, or policy-prohibited steps revoke the lease and return a typed terminal/retryable outcome
- BSB-004: The real Claude consumer surface completes fixture installation/connection, consent, deterministic tool call, refresh, revocation, and verified post-revocation failure
- BSB-004: Evidence records timestamps, UI observations, redacted network metadata, MCP result hashes, and revocation proof without cookies or tokens
- BSB-004: The conformance fixture accepts only the bounded test identity/client and harmless deterministic tool contract
- BSB-004: Session and OAuth leases are revoked or verified expired and the profile is preserved/quarantined/destroyed according to policy
- BSB-004: The journey requires no Categoric/Cashflow-App MCP server, OAuth client, code, account, or workspace
- BSB-005: The real ChatGPT consumer surface completes fixture installation/connection, consent, deterministic tool call, refresh, revocation, and verified post-revocation failure
- BSB-005: Evidence contains the same required classes as Claude and records explicit provider-specific differences
- BSB-005: Claude and ChatGPT accounts, profiles, leases, cookies, and OAuth grants remain isolated and cannot be interchanged
- BSB-005: No cookie, token, TOTP, password, passkey material, or recovery code appears in model context or retained evidence
- BSB-005: The journey requires no Categoric/Cashflow-App MCP server, OAuth client, code, account, or workspace
- BSB-006: Crash injection resumes or reconciles once without duplicate onboarding, duplicate OAuth grants, orphan runners, or untracked sessions
- BSB-006: Cookie, TOTP, password, passkey, token, cross-domain/profile/provider, replay, revoked-session, takeover-automation, and network-escape attempts all fail
- BSB-006: Evidence tampering changes the receipt digest and prevents acceptance
- BSB-006: Every injected failure leaves the dedicated provider account healthy or quarantined with an explicit operator recovery action
- BSB-006: Disabling the broker revokes leases, terminates runners, blocks new requests, preserves receipts, and leaves no Categoric/Cashflow-App dependency

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
