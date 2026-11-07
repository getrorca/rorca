# Rorca Coolify Staging and Protected Production Adapter — Delivery Plan

## Story order
1. **CDP-001 — Coolify bindings identify one application and environment without leaking control credentials**
2. **CDP-002 — Bounded staging leases deploy an exact revision and report health**
3. **CDP-003 — Immutable release intent invalidates approval when any production input changes**
4. **CDP-004 — Production waits for an external gate and an open change window**
5. **CDP-005 — Canary health failures automatically restore the prior production revision**
6. **CDP-006 — Disposable deployment attacks leave the previous service healthy**

## Dependencies
- CDP-001 → CDP-002
- CDP-002 → CDP-003
- CDP-003 → CDP-004
- CDP-004 → CDP-005
- CDP-005 → CDP-006

## Verification
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

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
