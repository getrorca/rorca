# Threat model v1

| Threat | Control |
| --- | --- |
| Copy receipt from another revision/workspace/repository | Recompute revision, tree, remote identity hash, workspace hash, and report hash. |
| Change engine, compiler, policy, invariants, fixtures, or tests | Recompute explicit versioned file-set digests. |
| Add fields interpreted permissively | Exact-key checks and unsupported-version rejection. |
| Forge or mutate receipt | Trusted issuer/key lookup, minimum key strength, HMAC-SHA-256, timing-safe comparison. |
| Replay stale receipt | Issued/expiry window checked at verification and latest-read time. |
| Use terminal success as proof | Terminal output is non-durable and cannot satisfy any authoritative class. |
| Leak secrets or local diagnostics | Closed portable schema, safe identifiers, hashed identities, forbidden-content scan, bounded 512 KiB report. |
| Cardinality/metrics denial of service | Closed enums, at most 512 telemetry samples, saturated counts, no raw IDs in labels. |
| Turn evidence failure into run success | Gate is derived after semantic closeout and can only become unavailable on evidence failure. |
| Rewrite published qualification | Append-only trigger rejects update/delete. |

Trusted issuer keys are configuration secrets and must not appear in logs, API responses, metrics, reports, frontend state, or receipts. Rotation uses a new key ID; old trust is removed only after all intended receipts expire.
