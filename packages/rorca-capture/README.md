# @rorca/capture

Standalone API-only context capture sidecar for Rorca.

- Product requirements: [`../../docs/prds/rorca-context-capture-sidecar/PRD.md`](../../docs/prds/rorca-context-capture-sidecar/PRD.md)
- Architecture contract: [`../../docs/rorca-capture-sidecar-contract.md`](../../docs/rorca-capture-sidecar-contract.md)

The implementation owner is the `rorca-capture` binary. `rorca capture ...` is only a thin compatibility alias that shells out to this package.

## Commands

```sh
rorca-capture --help
rorca-capture status
rorca-capture remember "Prefer API-only capture writes"
rorca-capture ingest-commit HEAD
rorca-capture ingest-git
rorca-capture install-hooks
rorca-capture daemon
```

All Rorca writes go through `POST /api/...` with `Authorization: Bearer $(cat ~/.rorca/mcp-token)`. This package must not read `DATABASE_URL` or connect directly to PostgreSQL.
