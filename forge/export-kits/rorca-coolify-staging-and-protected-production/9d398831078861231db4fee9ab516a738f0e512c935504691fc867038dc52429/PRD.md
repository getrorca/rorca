# Rorca Coolify Staging and Protected Production Adapter — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Coolify Staging and Protected Production Adapter specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- CDP-001 — Coolify bindings identify one application and environment without leaking control credentials
- CDP-002 — Bounded staging leases deploy an exact revision and report health
- CDP-003 — Immutable release intent invalidates approval when any production input changes
- CDP-004 — Production waits for an external gate and an open change window
- CDP-005 — Canary health failures automatically restore the prior production revision
- CDP-006 — Disposable deployment attacks leave the previous service healthy

## In scope
- Implement a generic Coolify AuthorityProviderAdapter and ProviderBinding using immutable project/application/environment UUIDs, base URL, verified profile, capability policy, binding generation, and a SecretStore reference to the control token. Preflight checks API reachability, exact target identity, allowed actions, token scope, and environment isolation. Use core tables/routes and no provider-specific secret column or child migration. Staging and production bindings are distinct; name-only matching and cross-environment fallback are prohibited.
- Implement deploy.staging for an immutable commit/image digest plus configuration-binding generation. A pre-authorized staging policy may issue a bounded single-run lease without interactive approval after core preflight. Trigger the deployment through the adapter, observe provider status and declared health signals, settle an ExecutionReceipt, and reconcile unknown outcomes by deployment id. No production target or credential is reachable through this capability.
- Define a versioned ReleaseIntent in the core OperationIntent record containing source revision, artifact/image digests, migration-set digest, configuration-binding generation, feature-flag digest, rollout cohort, change window, provider-approval reference, rollback owner/procedure, health signals, and abort conditions. Provide create/read/validate projections through the core authority API. Any material field or evidence change produces a new digest; persisted intents and receipts are immutable.
- Implement deploy.production policy for Rorca local-single-operator posture. The local operator may request/approve under local policy, but a policy requiring independent approval must bind evidence from a reviewed external provider gate such as a GitHub protected environment; Rorca must not invent a second local identity or allow the run to self-review. Keep the run in WAITING_FOR_AUTHORIZATION or WAITING_FOR_CHANGE_WINDOW until the exact ReleaseIntent digest, provider approval, CI evidence, and window are valid. Production credentials remain unavailable before the gate.
- Deploy only the approved cohort, evaluate declared signals deterministically against abort conditions, then expand or invoke the exact rollback procedure. Capture the prior revision and binding generation before mutation. Rollback restores them under a fenced rollback lease, verifies health, and settles deploy/canary/evaluation/rollback/revocation receipts. Unknown provider outcomes are reconciled before another action.
- Qualify staging and protected-production behavior on disposable Rorca-owned Coolify applications. Inject digest and migration changes after approval, closed windows, denied/expired/replayed grants, cross-environment binding use, control-token extraction prompts, health aborts, and crashes at deploy/canary/rollback/revocation boundaries. Production rollout remains off until staging evidence and an external gate fixture pass. Rollback disables production capability, restores the prior revision, revokes leases, and preserves receipts. Non-goals are customer deploys, Coolify administration, secret inventory, DNS, and generalized CI/CD.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### CDP-001
Implement a generic Coolify AuthorityProviderAdapter and ProviderBinding using immutable project/application/environment UUIDs, base URL, verified profile, capability policy, binding generation, and a SecretStore reference to the control token. Preflight checks API reachability, exact target identity, allowed actions, token scope, and environment isolation. Use core tables/routes and no provider-specific secret column or child migration. Staging and production bindings are distinct; name-only matching and cross-environment fallback are prohibited.

**Acceptance criteria**
- Binding creation and revalidation resolve immutable Coolify target identifiers and report a redacted capability profile
- Preflight rejects unreachable, stale, ambiguous, wrong-environment, permission-deficient, and non-resolvable bindings before deploy
- A staging binding cannot address the production application and a production binding cannot be inferred from a shared name
- The control token is absent from browser responses, process-wide/model environment, jobs, logs, errors, receipts, and database plaintext
- Disabling a binding prevents new deploy leases and marks active attempts for revocation or reconciliation

### CDP-002
Implement deploy.staging for an immutable commit/image digest plus configuration-binding generation. A pre-authorized staging policy may issue a bounded single-run lease without interactive approval after core preflight. Trigger the deployment through the adapter, observe provider status and declared health signals, settle an ExecutionReceipt, and reconcile unknown outcomes by deployment id. No production target or credential is reachable through this capability.

**Acceptance criteria**
- A healthy staging binding deploys exactly the approved revision/image digest and configuration generation
- A pre-authorized staging lease proceeds without human approval while an unqualified binding waits before dispatch
- The staging capability cannot address, read secrets from, or mutate the production application
- Crash after provider acceptance reconciles by deployment id and records one receipt without double deploy
- The receipt records target UUIDs, revision/digest, binding generation, provider deployment id, health outcome, lease revocation, and no secrets

### CDP-003
Define a versioned ReleaseIntent in the core OperationIntent record containing source revision, artifact/image digests, migration-set digest, configuration-binding generation, feature-flag digest, rollout cohort, change window, provider-approval reference, rollback owner/procedure, health signals, and abort conditions. Provide create/read/validate projections through the core authority API. Any material field or evidence change produces a new digest; persisted intents and receipts are immutable.

**Acceptance criteria**
- ReleaseIntent serialization is canonical and the same inputs produce the same digest
- Changing revision, artifact, migrations, configuration, flags, cohort, window, approval reference, rollback, health, abort conditions, or evidence changes the digest
- A grant for one intent digest cannot authorize another intent or changed CI evidence
- The API returns redacted immutable intent and provenance projections without environment secret values
- Core records store the intent without a Coolify-specific migration and reject post-approval mutation

### CDP-004
Implement deploy.production policy for Rorca local-single-operator posture. The local operator may request/approve under local policy, but a policy requiring independent approval must bind evidence from a reviewed external provider gate such as a GitHub protected environment; Rorca must not invent a second local identity or allow the run to self-review. Keep the run in WAITING_FOR_AUTHORIZATION or WAITING_FOR_CHANGE_WINDOW until the exact ReleaseIntent digest, provider approval, CI evidence, and window are valid. Production credentials remain unavailable before the gate.

**Acceptance criteria**
- A production policy requiring independent approval rejects local self-attestation and accepts only verified external-gate evidence bound to the exact intent digest
- The run remains in typed authorization or change-window wait without consuming story timeout while the gate or window is pending
- Closed window, changed digest/evidence/cohort, denied gate, expired grant, and replay all execute no production deploy
- Production credential resolution occurs only after gate and window validation inside the trusted adapter
- If no reviewed external gate is configured, production remains not-authorized while staging capability remains usable

### CDP-005
Deploy only the approved cohort, evaluate declared signals deterministically against abort conditions, then expand or invoke the exact rollback procedure. Capture the prior revision and binding generation before mutation. Rollback restores them under a fenced rollback lease, verifies health, and settles deploy/canary/evaluation/rollback/revocation receipts. Unknown provider outcomes are reconciled before another action.

**Acceptance criteria**
- The adapter deploys exactly the approved cohort and cannot silently expand it
- Health evaluation records input signal values, thresholds, decision, and timestamps and produces the same decision for the same evidence
- An abort condition invokes the declared rollback owner/procedure and restores the prior revision and binding generation
- Crash during canary, expansion, or rollback reconciles provider state and never double-deploys or skips rollback
- Receipts link ReleaseIntent, external gate, deployment ids, cohort, health decision, rollback result, and revoked leases without secrets

### CDP-006
Qualify staging and protected-production behavior on disposable Rorca-owned Coolify applications. Inject digest and migration changes after approval, closed windows, denied/expired/replayed grants, cross-environment binding use, control-token extraction prompts, health aborts, and crashes at deploy/canary/rollback/revocation boundaries. Production rollout remains off until staging evidence and an external gate fixture pass. Rollback disables production capability, restores the prior revision, revokes leases, and preserves receipts. Non-goals are customer deploys, Coolify administration, secret inventory, DNS, and generalized CI/CD.

**Acceptance criteria**
- Staging qualification succeeds without exposing a production target
- Changed intent, closed window, invalid gate, replay, cross-environment use, and prompt extraction all fail before or safely around provider mutation
- Every injected production failure leaves the prior disposable revision serving healthy traffic or records an explicit unresolved rollback blocker
- Crash recovery produces one reconciled deployment/rollback lineage with no duplicate provider operations
- No Categoric/Cashflow-App application, environment, credential, repository, or code is used by qualification

## Success metrics
- CDP-001: Binding creation and revalidation resolve immutable Coolify target identifiers and report a redacted capability profile
- CDP-001: Preflight rejects unreachable, stale, ambiguous, wrong-environment, permission-deficient, and non-resolvable bindings before deploy
- CDP-001: A staging binding cannot address the production application and a production binding cannot be inferred from a shared name
- CDP-001: The control token is absent from browser responses, process-wide/model environment, jobs, logs, errors, receipts, and database plaintext
- CDP-001: Disabling a binding prevents new deploy leases and marks active attempts for revocation or reconciliation
- CDP-002: A healthy staging binding deploys exactly the approved revision/image digest and configuration generation
- CDP-002: A pre-authorized staging lease proceeds without human approval while an unqualified binding waits before dispatch
- CDP-002: The staging capability cannot address, read secrets from, or mutate the production application
- CDP-002: Crash after provider acceptance reconciles by deployment id and records one receipt without double deploy
- CDP-002: The receipt records target UUIDs, revision/digest, binding generation, provider deployment id, health outcome, lease revocation, and no secrets
- CDP-003: ReleaseIntent serialization is canonical and the same inputs produce the same digest
- CDP-003: Changing revision, artifact, migrations, configuration, flags, cohort, window, approval reference, rollback, health, abort conditions, or evidence changes the digest
- CDP-003: A grant for one intent digest cannot authorize another intent or changed CI evidence
- CDP-003: The API returns redacted immutable intent and provenance projections without environment secret values
- CDP-003: Core records store the intent without a Coolify-specific migration and reject post-approval mutation
- CDP-004: A production policy requiring independent approval rejects local self-attestation and accepts only verified external-gate evidence bound to the exact intent digest
- CDP-004: The run remains in typed authorization or change-window wait without consuming story timeout while the gate or window is pending
- CDP-004: Closed window, changed digest/evidence/cohort, denied gate, expired grant, and replay all execute no production deploy
- CDP-004: Production credential resolution occurs only after gate and window validation inside the trusted adapter
- CDP-004: If no reviewed external gate is configured, production remains not-authorized while staging capability remains usable
- CDP-005: The adapter deploys exactly the approved cohort and cannot silently expand it
- CDP-005: Health evaluation records input signal values, thresholds, decision, and timestamps and produces the same decision for the same evidence
- CDP-005: An abort condition invokes the declared rollback owner/procedure and restores the prior revision and binding generation
- CDP-005: Crash during canary, expansion, or rollback reconciles provider state and never double-deploys or skips rollback
- CDP-005: Receipts link ReleaseIntent, external gate, deployment ids, cohort, health decision, rollback result, and revoked leases without secrets
- CDP-006: Staging qualification succeeds without exposing a production target
- CDP-006: Changed intent, closed window, invalid gate, replay, cross-environment use, and prompt extraction all fail before or safely around provider mutation
- CDP-006: Every injected production failure leaves the prior disposable revision serving healthy traffic or records an explicit unresolved rollback blocker
- CDP-006: Crash recovery produces one reconciled deployment/rollback lineage with no duplicate provider operations
- CDP-006: No Categoric/Cashflow-App application, environment, credential, repository, or code is used by qualification

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

