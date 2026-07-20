# Operations v1

Configure `RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON` as issuer → key ID → secret. CI report issuance may use `RORCA_QUALIFICATION_SIGNING_KEY`, issuer ID, key ID, PostgreSQL version, and an already-hashed test-database identity. Never place those secrets in command arguments or artifacts.

Operator checks:

- verify the canonical and Markdown report digests agree across two invocations on identical normalized inputs;
- verify required scenario IDs, expiry, issuer, source/tree, file digests, Git inventories, budgets, and closeout telemetry;
- treat `run_closeout` and validated integration evidence as authoritative for run status;
- show scoped retries explicitly, and label carried-forward, blocked, integration-pending, and recovery-preserved stories/branches;
- never infer a pass from PTY/terminal completion, cleanup completion, report publication, or receipt signature alone.

The latest-receipt API returns bounded portable summary fields and telemetry only. If current recomputation fails or the receipt expires, history remains visible but `productionEnableAvailable` is false. Local diagnostic artifacts remain mode 0600 and are never copied into the API or frontend.
