# Rorca Supabase Database and Credential Authority Adapter — Software Design

## Architecture
The canonical dependency diagram below defines the declared delivery topology.

```mermaid
graph LR
  SMC-001["SMC-001"]
  SMC-002["SMC-002"]
  SMC-003["SMC-003"]
  SMC-004["SMC-004"]
  SMC-005["SMC-005"]
  SMC-006["SMC-006"]
  SMC-001 --> SMC-002
  SMC-002 --> SMC-003
  SMC-003 --> SMC-004
  SMC-004 --> SMC-005
  SMC-005 --> SMC-006
```

## Components
### SMC-001 — Supabase bindings expose exact read-only schema inventory
Implement a generic Supabase database AuthorityProviderAdapter and ProviderBinding for one project/environment using immutable project reference, database identity, verified role/capability profile, binding generation, and SecretStore references. database.schema.inspect returns tables, columns, constraints, indexes, extensions, functions, and RLS policies through read-only transactions. Use core authority storage; add no provider-specific secret column. Staging and production bindings are separate and no application runtime credential implies migration authority.

**Boundaries**
- No explicit component boundary was declared.

### SMC-002 — Backup evidence and target verification protect restore drills
Implement database.backup.create and database.backup.restore as distinct capabilities. Create records provider/storage location, content hash, schema/version metadata, encryption provenance, retention, and verification result. Restore requires explicit target identity, scratch by default, a separate high-risk grant, and post-restore integrity checks. Production restore is unavailable without a separately reviewed policy and external gate.

**Boundaries**
- Depends on SMC-001

### SMC-003 — Staging migration preflight preserves exact ordering and recovery policy
Implement database.migration.apply.staging from an immutable ordered manifest containing ids, content hashes, current-schema hash, prerequisites, transaction mode, reversibility classification, verification queries, and rollback or forward-fix procedure. Do not require a fictitious down script for every migration: reversible migrations provide tested rollback; forward-only migrations provide backup, forward-fix, and restore evidence. Apply under an advisory/fencing lock, verify expected schema state, and settle a receipt.

**Boundaries**
- Depends on SMC-002

### SMC-004 — Production migration authority stays separate from deployment authority
Implement database.migration.apply.production with immutable manifest and target digests, verified backup, change window, health/abort evidence, rollback owner, and external gate when policy requires independent approval. A deploy grant cannot authorize database mutation and a migration grant cannot deploy application code. Preserve WAITING states without consuming story timeout. Reconcile uncertain DDL outcome from schema and migration history before retry.

**Boundaries**
- Depends on SMC-003

### SMC-005 — Distinct Supabase key ceremonies preserve their different blast radii
Implement separate typed ceremonies for publishable/secret API-key rotation, legacy anon/service_role migration, and JWT signing-key standby/current/revoked rotation. Human Dashboard steps use a secure operator capture directly into SecretStore and RuntimeSecretBindingAdapter; values never pass through model chat, ordinary API JSON, or receipts. Each ceremony has its own capability, request digest, binding inventory, canary, cutover, grace/revocation policy, and recovery procedure. Public publishable values are classified separately from server-only secrets.

**Boundaries**
- Depends on SMC-004

### SMC-006 — Disposable database failures leave one consistent reconciled state
Qualify against a disposable Rorca-owned Supabase project or equivalent supported fixture, never a customer workspace. Exercise read-only inspection, backup/scratch restore, staging reversible and forward-only manifests, separately gated production simulation, all three key-ceremony state machines, replay, cross-scope denial, prompt extraction, and crashes around every external boundary. Rollout proceeds inspect-only, backup/restore, staging mutation, then production/key capabilities. Rollback disables mutation capabilities, revokes leases, and preserves receipts.

**Boundaries**
- Depends on SMC-005

## Data changes
- No data changes were declared.

## API changes
- No API changes were declared.

## Security and privacy
- No additional security or privacy constraints were declared.

## Migrations
- No migrations were declared.

## Operational concerns
- No additional operational concerns were declared.
