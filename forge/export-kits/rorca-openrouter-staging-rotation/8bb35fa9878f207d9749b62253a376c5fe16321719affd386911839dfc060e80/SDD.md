# Rorca OpenRouter Runtime-Key Rotation Adapter — Software Design

## Architecture
The canonical dependency diagram below defines the declared delivery topology.

```mermaid
graph LR
  OSR-001["OSR-001"]
  OSR-002["OSR-002"]
  OSR-003["OSR-003"]
  OSR-004["OSR-004"]
  OSR-005["OSR-005"]
  OSR-001 --> OSR-002
  OSR-002 --> OSR-003
  OSR-003 --> OSR-004
  OSR-004 --> OSR-005
```

## Components
### OSR-001 — OpenRouter management bindings expose lifecycle operations but never inference
Implement an OpenRouter AuthorityProviderAdapter using a core ProviderBinding and SecretStore reference for the management key. Expose semantic list, create-limited-key, disable, delete, and verify operations; never return the management credential. Store provider account identity, binding generation, policy limits, fingerprints, and resource ids in core records; add no provider-specific secret column or child migration. Preflight verifies the management endpoint, account binding, scope, and the documented invariant that the management credential cannot call completion endpoints.

**Boundaries**
- No explicit component boundary was declared.

### OSR-002 — One rotation intent creates at most one bounded replacement key
Define an immutable rotation intent containing provider binding, current runtime-key fingerprint/reference, desired name, credit and usage limits, target RuntimeSecretBindingAdapter reference, canary contract, timeout, rollback action, and exact request digest. Create a distinctly named limited replacement under the core idempotency/fencing state machine. If outcome is uncertain, list provider keys by stable intent metadata before creating another. Parent and replacement secret values stay inside SecretStore and trusted adapters.

**Boundaries**
- Depends on OSR-001

### OSR-003 — Canary success cuts over the target before the old key is revoked
Stage the replacement through the generic RuntimeSecretBindingAdapter, deploy or refresh the target when the binding requires it, and run the declared real OpenRouter completion through that target surface rather than a health-only endpoint. Keep the old key active until the target revision and completion result pass. Then atomically mark the new binding active, disable the old provider key, and verify old-key rejection. Do not depend on Coolify specifically; a Coolify implementation may satisfy the binding contract later.

**Boundaries**
- Depends on OSR-002

### OSR-004 — Failure restores the prior target and reconciles every created key
Implement rollback for provider creation failure, target-binding failure, deploy failure, canary failure, cutover uncertainty, old-key disable failure, and receipt/revocation failure. Restore the prior target binding when changed, retain the old key when safe, disable/delete the failed replacement, and emit a rollback or reconciliation-required receipt. Inject crashes after key creation, binding stage, deploy acceptance, canary result, cutover, and old-key disable.

**Boundaries**
- Depends on OSR-003

### OSR-005 — A bounded live rotation proves security before workspace rollout
Qualify against a dedicated low-limit OpenRouter test account/binding and a disposable Rorca-owned target-binding fixture. Exercise real management API lifecycle, real inference canary, cutover, old-key rejection, rollback, replay, cross-scope denial, prompt extraction attempts, and crash recovery. Keep rollout off by default; enable per verified workspace binding only. Rollback disables the adapter, restores the prior binding where possible, revokes replacements, and preserves receipts. Non-goals are alternate LLM providers, customer environment changes, billing management, and automated production rotation without explicit policy.

**Boundaries**
- Depends on OSR-004

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
