# Rorca Authenticated Browser Session Broker — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Authenticated Browser Session Broker specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- BSB-001 — Dedicated browser profiles keep external identity secrets outside model context
- BSB-002 — Expiring browser leases isolate one run, purpose, profile, and domain set
- BSB-003 — Step-up authentication pauses durably for the human operator
- BSB-004 — Claude onboarding proves a real MCP consumer journey on a Rorca-owned fixture
- BSB-005 — ChatGPT onboarding produces evidence equivalent to the Claude journey
- BSB-006 — Browser-session attacks and crashes leave accounts healthy and evidence complete

## In scope
- Implement BrowserSessionBroker as a Rorca AuthorityProviderAdapter for dedicated external test identities. Store encrypted domain-bound profile artifacts and SecretStore references with provider, account alias, allowlisted origins, enrollment provenance, health state, generation, retention, and destruction policy; never store cookies or TOTP seeds in authority rows. Human enrollment completes login/MFA/passkey on an operator-controlled surface. Use core ProviderBinding/receipt storage; no plaintext child table or customer identity dependency.
- Implement browser.session.request, use, revoke, and reconcile under the core grant/lease state machine. Bind each lease to run, story, purpose, profile generation, allowed origins/actions, maximum concurrent runner count, expiry, evidence contract, and destruction/preservation policy. Launch a fresh isolated browser runner with constrained network/filesystem/artifact access. Revocation terminates use and clears ephemeral state; uncertain termination reconciles before reuse.
- Detect login expiry, consent, MFA, passkey, CAPTCHA, account lock, and provider step-up states as structured authentication requests. Transition the run to WAITING_FOR_AUTHENTICATION with the exact provider/profile/purpose/evidence and a separate expiry; stop story timeout. Present an operator takeover surface that never exposes model control during the human step. Resume once after health revalidation. Enforce documented provider terms and anti-automation constraints; never bypass, auto-solve, or extract secrets.
- Create a disposable Rorca-owned MCP conformance fixture with deterministic OAuth consent, one harmless tool, refresh, and revocation endpoints; it is test infrastructure, not Categoric. Through a dedicated Claude consumer test identity and leased browser runner, perform real install/connect, consent, tool invocation, refresh, revoke, and post-revocation failure. Capture redacted screenshots, accessibility snapshots, network metadata, MCP result hashes, provider/session state, and revocation proof in one ExecutionReceipt.
- Run the same Rorca-owned MCP conformance fixture journey through a separately enrolled ChatGPT consumer test identity and profile. Preserve provider-specific UI differences while requiring equivalent install/connect, consent, tool, refresh, revoke, and post-revocation observations and the same redaction/provenance classes. Do not reuse the Claude profile, lease, cookies, account, or OAuth grant.
- Inject crashes at enrollment handoff, lease issue, navigation, consent, tool call, refresh, revoke, and receipt settlement. Attempt prompt extraction of cookies/TOTP/tokens, cross-domain/profile/provider use, expired/replayed lease, revoked-session reuse, automation during takeover, evidence tampering, and network escape. Qualify only dedicated test identities. Rollout remains experimental and off by default; rollback revokes leases, kills runners, quarantines profiles, disables the broker, and retains redacted receipts. Non-goals are personal accounts, general browsing, CAPTCHA solving, credential export, provider-policy circumvention, and unattended production browser automation.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### BSB-001
Implement BrowserSessionBroker as a Rorca AuthorityProviderAdapter for dedicated external test identities. Store encrypted domain-bound profile artifacts and SecretStore references with provider, account alias, allowlisted origins, enrollment provenance, health state, generation, retention, and destruction policy; never store cookies or TOTP seeds in authority rows. Human enrollment completes login/MFA/passkey on an operator-controlled surface. Use core ProviderBinding/receipt storage; no plaintext child table or customer identity dependency.

**Acceptance criteria**
- Each provider test identity has a separately encrypted profile, immutable account alias, domain allowlist, generation, retention, and health state
- Enrollment records human provenance and provider/session health without recording password, cookie, TOTP seed, passkey private material, or recovery code
- Profiles mount only into isolated browser runners and are absent from model context, prompts, job JSON, logs, API bodies, screenshots, and authority rows
- Cross-provider, cross-account, cross-workspace, and non-allowlisted origin use fails before navigation
- Deleting or quarantining a profile revokes active leases and preserves redacted audit evidence

### BSB-002
Implement browser.session.request, use, revoke, and reconcile under the core grant/lease state machine. Bind each lease to run, story, purpose, profile generation, allowed origins/actions, maximum concurrent runner count, expiry, evidence contract, and destruction/preservation policy. Launch a fresh isolated browser runner with constrained network/filesystem/artifact access. Revocation terminates use and clears ephemeral state; uncertain termination reconciles before reuse.

**Acceptance criteria**
- Lease issuance rejects unhealthy/stale profiles, wrong workspace/provider, broadened origins/actions, expired grants, and concurrent use beyond policy
- One lease mounts one profile generation into one isolated runner and exposes no raw profile file to the model
- Network navigation outside the exact provider/MCP allowlist fails and records a redacted security event
- Revocation terminates the runner, invalidates further actions, clears ephemeral state, and applies the profile retention policy
- Crash or lost runner heartbeat reconciles session/provider health before the profile can be leased again

### BSB-003
Detect login expiry, consent, MFA, passkey, CAPTCHA, account lock, and provider step-up states as structured authentication requests. Transition the run to WAITING_FOR_AUTHENTICATION with the exact provider/profile/purpose/evidence and a separate expiry; stop story timeout. Present an operator takeover surface that never exposes model control during the human step. Resume once after health revalidation. Enforce documented provider terms and anti-automation constraints; never bypass, auto-solve, or extract secrets.

**Acceptance criteria**
- Each supported step-up state produces a typed request and durable run wait rather than a narrative block or story timeout
- The operator can complete or cancel the step on a takeover surface while model input and automation are suspended
- MFA, passkey, CAPTCHA, account lock, and provider anti-automation controls cannot be bypassed or marked complete without observed provider state
- Restart during the wait preserves exact browser/profile/run position and resumes once only after health revalidation
- Denied, cancelled, expired, unhealthy, or policy-prohibited steps revoke the lease and return a typed terminal/retryable outcome

### BSB-004
Create a disposable Rorca-owned MCP conformance fixture with deterministic OAuth consent, one harmless tool, refresh, and revocation endpoints; it is test infrastructure, not Categoric. Through a dedicated Claude consumer test identity and leased browser runner, perform real install/connect, consent, tool invocation, refresh, revoke, and post-revocation failure. Capture redacted screenshots, accessibility snapshots, network metadata, MCP result hashes, provider/session state, and revocation proof in one ExecutionReceipt.

**Acceptance criteria**
- The real Claude consumer surface completes fixture installation/connection, consent, deterministic tool call, refresh, revocation, and verified post-revocation failure
- Evidence records timestamps, UI observations, redacted network metadata, MCP result hashes, and revocation proof without cookies or tokens
- The conformance fixture accepts only the bounded test identity/client and harmless deterministic tool contract
- Session and OAuth leases are revoked or verified expired and the profile is preserved/quarantined/destroyed according to policy
- The journey requires no Categoric/Cashflow-App MCP server, OAuth client, code, account, or workspace

### BSB-005
Run the same Rorca-owned MCP conformance fixture journey through a separately enrolled ChatGPT consumer test identity and profile. Preserve provider-specific UI differences while requiring equivalent install/connect, consent, tool, refresh, revoke, and post-revocation observations and the same redaction/provenance classes. Do not reuse the Claude profile, lease, cookies, account, or OAuth grant.

**Acceptance criteria**
- The real ChatGPT consumer surface completes fixture installation/connection, consent, deterministic tool call, refresh, revocation, and verified post-revocation failure
- Evidence contains the same required classes as Claude and records explicit provider-specific differences
- Claude and ChatGPT accounts, profiles, leases, cookies, and OAuth grants remain isolated and cannot be interchanged
- No cookie, token, TOTP, password, passkey material, or recovery code appears in model context or retained evidence
- The journey requires no Categoric/Cashflow-App MCP server, OAuth client, code, account, or workspace

### BSB-006
Inject crashes at enrollment handoff, lease issue, navigation, consent, tool call, refresh, revoke, and receipt settlement. Attempt prompt extraction of cookies/TOTP/tokens, cross-domain/profile/provider use, expired/replayed lease, revoked-session reuse, automation during takeover, evidence tampering, and network escape. Qualify only dedicated test identities. Rollout remains experimental and off by default; rollback revokes leases, kills runners, quarantines profiles, disables the broker, and retains redacted receipts. Non-goals are personal accounts, general browsing, CAPTCHA solving, credential export, provider-policy circumvention, and unattended production browser automation.

**Acceptance criteria**
- Crash injection resumes or reconciles once without duplicate onboarding, duplicate OAuth grants, orphan runners, or untracked sessions
- Cookie, TOTP, password, passkey, token, cross-domain/profile/provider, replay, revoked-session, takeover-automation, and network-escape attempts all fail
- Evidence tampering changes the receipt digest and prevents acceptance
- Every injected failure leaves the dedicated provider account healthy or quarantined with an explicit operator recovery action
- Disabling the broker revokes leases, terminates runners, blocks new requests, preserves receipts, and leaves no Categoric/Cashflow-App dependency

## Success metrics
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

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

