# Rorca Supabase Database and Credential Authority Adapter — Delivery Plan

## Story order
1. **SMC-001 — Supabase bindings expose exact read-only schema inventory**
2. **SMC-002 — Backup evidence and target verification protect restore drills**
3. **SMC-003 — Staging migration preflight preserves exact ordering and recovery policy**
4. **SMC-004 — Production migration authority stays separate from deployment authority**
5. **SMC-005 — Distinct Supabase key ceremonies preserve their different blast radii**
6. **SMC-006 — Disposable database failures leave one consistent reconciled state**

## Dependencies
- SMC-001 → SMC-002
- SMC-002 → SMC-003
- SMC-003 → SMC-004
- SMC-004 → SMC-005
- SMC-005 → SMC-006

## Verification
- SMC-001: Binding preflight rejects wrong project/database/environment, stale generation, unverified role, missing capabilities, and unresolved references
- SMC-001: Schema inspection executes read-only and returns a deterministic inventory with stable object identifiers and hashes
- SMC-001: Inspect cannot execute DDL, DML, backup, restore, migration, key rotation, or provider administration
- SMC-001: Application anon/publishable/secret/service credentials do not grant database schema or migration authority
- SMC-001: Responses, receipts, logs, and database authority rows contain connection/key references and fingerprints but no credential bytes
- SMC-002: Backup creation produces a verifiable encrypted artifact record with hash, source identity, retention, and no embedded credential
- SMC-002: A scratch restore recreates expected schema/data checks and records target identity and verification evidence
- SMC-002: Restore rejects ambiguous, source-equal, production, stale, or unauthorized targets before writing
- SMC-002: Inspect and backup grants cannot authorize restore or migration operations
- SMC-002: Backup or restore crash reconciles provider/storage state and leaves one receipt or an explicit cleanup-required record
- SMC-003: Preflight rejects schema-hash drift, missing or reordered migrations, duplicate ids, dependency conflicts, unsupported transaction mode, and absent recovery classification
- SMC-003: Reversible staging migration failure executes its tested rollback and verifies the prior schema state
- SMC-003: Forward-only staging migration failure follows the declared forward-fix or scratch-restore procedure and records the resulting schema hash
- SMC-003: Concurrent and replayed apply attempts cannot double-apply a migration manifest
- SMC-003: The receipt records manifest digest, target identity, before/after schema hashes, statements outcome, verification, and recovery proof without credentials
- SMC-004: Production apply rejects missing/failed backup, changed manifest/schema, closed window, invalid external gate, expired/replayed grant, and unverified recovery plan
- SMC-004: Deployment authority cannot call production migration operations and production migration authority cannot call deploy operations
- SMC-004: The exact backup, manifest, target, window, evidence, and recovery owner are bound to the grant digest
- SMC-004: Crash before, during, or after apply reconciles schema/history before retry and never double-applies a manifest
- SMC-004: Abort follows the declared reversible rollback, forward-fix, or restore path and records final database consistency
- SMC-005: The API catalog and receipts expose three distinct ceremony types and cannot interchange their grants
- SMC-005: Dashboard-created secret and signing values travel directly from secure operator capture to SecretStore/target binding without entering model or ordinary response bodies
- SMC-005: Legacy migration inventories every bound consumer and proves replacement before legacy revocation
- SMC-005: JWT signing rotation enforces standby, current, and revoked states and verifies old/new token behavior during zero-downtime cutover
- SMC-005: Old secret/signing material is revoked only after the exact replacement canary and rollback readiness pass
- SMC-006: Read-only and scratch-restore qualification succeeds before any staging mutation capability is enabled
- SMC-006: Reversible and forward-only failure fixtures each end in the declared consistent schema state with complete evidence
- SMC-006: Altered manifest, replay, cross-workspace/environment use, deploy-grant substitution, and credential extraction all fail
- SMC-006: Crash injection never double-applies a migration, loses a created key, or leaves an untracked binding generation
- SMC-006: No Categoric/Cashflow-App database, key, environment, migration, or product code is used

## Rollout
- No separate rollout procedure was declared.

## Rollback
- No separate rollback procedure was declared.
