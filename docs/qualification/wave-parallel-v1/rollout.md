# Rollout v1

1. **Audit-only:** generate artifacts on CI and compare deterministic digests; production enable remains unavailable.
2. **Trusted issuance:** configure one short-lived CI issuer and validate cross-platform/runtime matrix receipts without changing execution mode.
3. **Operator publication:** enable admin publication, monitor verification rejection reasons out of band, and confirm immutable storage/expiry behavior.
4. **Canary:** permit production-enable only for selected workspaces with complete durable evidence and validated `run_closeout`.
5. **General availability:** require v1 receipts for wave-parallel production mode. Serial/recovery behavior remains available under existing policy.

Rollback removes issuer trust or disables the production-enable consumer. It does not delete receipts, mutate WAL, rewrite closeout, remove recovery refs, or downgrade schema parsing. Unknown future versions remain rejected until explicitly supported.
