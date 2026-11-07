# Rorca Supabase Database and Credential Authority Adapter — Product Requirements

## Problem
Deliver the behavior defined by the canonical Rorca Supabase Database and Credential Authority Adapter specification.

## Target users
- No target-user segment was declared in the canonical spec.

## Desired outcomes
- SMC-001 — Supabase bindings expose exact read-only schema inventory
- SMC-002 — Backup evidence and target verification protect restore drills
- SMC-003 — Staging migration preflight preserves exact ordering and recovery policy
- SMC-004 — Production migration authority stays separate from deployment authority
- SMC-005 — Distinct Supabase key ceremonies preserve their different blast radii
- SMC-006 — Disposable database failures leave one consistent reconciled state

## In scope
- Implement a generic Supabase database AuthorityProviderAdapter and ProviderBinding for one project/environment using immutable project reference, database identity, verified role/capability profile, binding generation, and SecretStore references. database.schema.inspect returns tables, columns, constraints, indexes, extensions, functions, and RLS policies through read-only transactions. Use core authority storage; add no provider-specific secret column. Staging and production bindings are separate and no application runtime credential implies migration authority.
- Implement database.backup.create and database.backup.restore as distinct capabilities. Create records provider/storage location, content hash, schema/version metadata, encryption provenance, retention, and verification result. Restore requires explicit target identity, scratch by default, a separate high-risk grant, and post-restore integrity checks. Production restore is unavailable without a separately reviewed policy and external gate.
- Implement database.migration.apply.staging from an immutable ordered manifest containing ids, content hashes, current-schema hash, prerequisites, transaction mode, reversibility classification, verification queries, and rollback or forward-fix procedure. Do not require a fictitious down script for every migration: reversible migrations provide tested rollback; forward-only migrations provide backup, forward-fix, and restore evidence. Apply under an advisory/fencing lock, verify expected schema state, and settle a receipt.
- Implement database.migration.apply.production with immutable manifest and target digests, verified backup, change window, health/abort evidence, rollback owner, and external gate when policy requires independent approval. A deploy grant cannot authorize database mutation and a migration grant cannot deploy application code. Preserve WAITING states without consuming story timeout. Reconcile uncertain DDL outcome from schema and migration history before retry.
- Implement separate typed ceremonies for publishable/secret API-key rotation, legacy anon/service_role migration, and JWT signing-key standby/current/revoked rotation. Human Dashboard steps use a secure operator capture directly into SecretStore and RuntimeSecretBindingAdapter; values never pass through model chat, ordinary API JSON, or receipts. Each ceremony has its own capability, request digest, binding inventory, canary, cutover, grace/revocation policy, and recovery procedure. Public publishable values are classified separately from server-only secrets.
- Qualify against a disposable Rorca-owned Supabase project or equivalent supported fixture, never a customer workspace. Exercise read-only inspection, backup/scratch restore, staging reversible and forward-only manifests, separately gated production simulation, all three key-ceremony state machines, replay, cross-scope denial, prompt extraction, and crashes around every external boundary. Rollout proceeds inspect-only, backup/restore, staging mutation, then production/key capabilities. Rollback disables mutation capabilities, revokes leases, and preserves receipts.

## Out of scope
- No explicit exclusions were declared.

## Functional requirements
### SMC-001
Implement a generic Supabase database AuthorityProviderAdapter and ProviderBinding for one project/environment using immutable project reference, database identity, verified role/capability profile, binding generation, and SecretStore references. database.schema.inspect returns tables, columns, constraints, indexes, extensions, functions, and RLS policies through read-only transactions. Use core authority storage; add no provider-specific secret column. Staging and production bindings are separate and no application runtime credential implies migration authority.

**Acceptance criteria**
- Binding preflight rejects wrong project/database/environment, stale generation, unverified role, missing capabilities, and unresolved references
- Schema inspection executes read-only and returns a deterministic inventory with stable object identifiers and hashes
- Inspect cannot execute DDL, DML, backup, restore, migration, key rotation, or provider administration
- Application anon/publishable/secret/service credentials do not grant database schema or migration authority
- Responses, receipts, logs, and database authority rows contain connection/key references and fingerprints but no credential bytes

### SMC-002
Implement database.backup.create and database.backup.restore as distinct capabilities. Create records provider/storage location, content hash, schema/version metadata, encryption provenance, retention, and verification result. Restore requires explicit target identity, scratch by default, a separate high-risk grant, and post-restore integrity checks. Production restore is unavailable without a separately reviewed policy and external gate.

**Acceptance criteria**
- Backup creation produces a verifiable encrypted artifact record with hash, source identity, retention, and no embedded credential
- A scratch restore recreates expected schema/data checks and records target identity and verification evidence
- Restore rejects ambiguous, source-equal, production, stale, or unauthorized targets before writing
- Inspect and backup grants cannot authorize restore or migration operations
- Backup or restore crash reconciles provider/storage state and leaves one receipt or an explicit cleanup-required record

### SMC-003
Implement database.migration.apply.staging from an immutable ordered manifest containing ids, content hashes, current-schema hash, prerequisites, transaction mode, reversibility classification, verification queries, and rollback or forward-fix procedure. Do not require a fictitious down script for every migration: reversible migrations provide tested rollback; forward-only migrations provide backup, forward-fix, and restore evidence. Apply under an advisory/fencing lock, verify expected schema state, and settle a receipt.

**Acceptance criteria**
- Preflight rejects schema-hash drift, missing or reordered migrations, duplicate ids, dependency conflicts, unsupported transaction mode, and absent recovery classification
- Reversible staging migration failure executes its tested rollback and verifies the prior schema state
- Forward-only staging migration failure follows the declared forward-fix or scratch-restore procedure and records the resulting schema hash
- Concurrent and replayed apply attempts cannot double-apply a migration manifest
- The receipt records manifest digest, target identity, before/after schema hashes, statements outcome, verification, and recovery proof without credentials

### SMC-004
Implement database.migration.apply.production with immutable manifest and target digests, verified backup, change window, health/abort evidence, rollback owner, and external gate when policy requires independent approval. A deploy grant cannot authorize database mutation and a migration grant cannot deploy application code. Preserve WAITING states without consuming story timeout. Reconcile uncertain DDL outcome from schema and migration history before retry.

**Acceptance criteria**
- Production apply rejects missing/failed backup, changed manifest/schema, closed window, invalid external gate, expired/replayed grant, and unverified recovery plan
- Deployment authority cannot call production migration operations and production migration authority cannot call deploy operations
- The exact backup, manifest, target, window, evidence, and recovery owner are bound to the grant digest
- Crash before, during, or after apply reconciles schema/history before retry and never double-applies a manifest
- Abort follows the declared reversible rollback, forward-fix, or restore path and records final database consistency

### SMC-005
Implement separate typed ceremonies for publishable/secret API-key rotation, legacy anon/service_role migration, and JWT signing-key standby/current/revoked rotation. Human Dashboard steps use a secure operator capture directly into SecretStore and RuntimeSecretBindingAdapter; values never pass through model chat, ordinary API JSON, or receipts. Each ceremony has its own capability, request digest, binding inventory, canary, cutover, grace/revocation policy, and recovery procedure. Public publishable values are classified separately from server-only secrets.

**Acceptance criteria**
- The API catalog and receipts expose three distinct ceremony types and cannot interchange their grants
- Dashboard-created secret and signing values travel directly from secure operator capture to SecretStore/target binding without entering model or ordinary response bodies
- Legacy migration inventories every bound consumer and proves replacement before legacy revocation
- JWT signing rotation enforces standby, current, and revoked states and verifies old/new token behavior during zero-downtime cutover
- Old secret/signing material is revoked only after the exact replacement canary and rollback readiness pass

### SMC-006
Qualify against a disposable Rorca-owned Supabase project or equivalent supported fixture, never a customer workspace. Exercise read-only inspection, backup/scratch restore, staging reversible and forward-only manifests, separately gated production simulation, all three key-ceremony state machines, replay, cross-scope denial, prompt extraction, and crashes around every external boundary. Rollout proceeds inspect-only, backup/restore, staging mutation, then production/key capabilities. Rollback disables mutation capabilities, revokes leases, and preserves receipts.

**Acceptance criteria**
- Read-only and scratch-restore qualification succeeds before any staging mutation capability is enabled
- Reversible and forward-only failure fixtures each end in the declared consistent schema state with complete evidence
- Altered manifest, replay, cross-workspace/environment use, deploy-grant substitution, and credential extraction all fail
- Crash injection never double-applies a migration, loses a created key, or leaves an untracked binding generation
- No Categoric/Cashflow-App database, key, environment, migration, or product code is used

## Success metrics
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

## Non-goals
- No explicit non-goals were declared.

## Research provenance
- No external research package informed this canonical spec.

