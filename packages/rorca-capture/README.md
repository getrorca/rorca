# @rorca/capture

Standalone API-only context capture sidecar for Rorca.

- Product requirements: [`../../docs/prds/rorca-context-capture-sidecar/PRD.md`](../../docs/prds/rorca-context-capture-sidecar/PRD.md)
- Architecture contract: [`../../docs/rorca-capture-sidecar-contract.md`](../../docs/rorca-capture-sidecar-contract.md)

The implementation owner is the `rorca-capture` binary. `rorca capture ...` is only a thin compatibility alias that shells out to this package.

## Commands

```sh
rorca-capture --help
rorca-capture status
rorca-capture remember "Prefer API-only capture writes" --category Decision --files docs/notes.md
rorca-capture ingest-commit HEAD
rorca-capture ingest-git --since origin/main
rorca-capture ingest-git --since last-rorca-run --json
rorca-capture install-hooks
rorca-capture daemon
```

`remember` creates a pending memory candidate through `POST /api/memory/candidates` by default. `--approve` only promotes after submission when `operatorAutoApprove` (or `RORCA_CAPTURE_OPERATOR_AUTO_APPROVE=true`) is explicitly enabled.

`ingest-commit` normalizes one git commit into a `git_commit` context event. `ingest-git --since <ref>` scans `<ref>..HEAD` oldest-first; `--since last-rorca-run` resolves the latest completed Rorca pipeline run pointer from the API. Add `--dry-run` to inspect without API writes or queue changes.

All Rorca writes go through `POST /api/...` with `Authorization: Bearer $(cat ~/.rorca/mcp-token)`. This package must not read `DATABASE_URL` or connect directly to PostgreSQL.
