# PRD: Rorca Context Capture Sidecar

## Summary

`rorca-capture` is a standalone, API-only sidecar that captures developer context from local repositories, VMs, and CI jobs and sends that context to Rorca through the Express API. It does not connect to PostgreSQL, does not read `DATABASE_URL`, and does not write Rorca queue, memory, or ingest records outside `POST /api/...` calls.

## MVP command surface

The package entrypoint is `packages/rorca-capture` and the binary is `rorca-capture`:

- `remember <text>` — create a pending manual memory candidate through `POST /api/memory/candidates`; `--approve` promotes only after explicit operator auto-approval is configured.
- `ingest-commit [hash]` — submit one idempotent `git_commit` context event through `POST /api/context-events`.
- `ingest-git --since <ref|last-rorca-run>` — scan git history oldest-first and submit each idempotent commit context event through the same API path.
- `ingest-pr --ci` — create a pending PR/CI memory candidate through `POST /api/memory/candidates` using deterministic merge-SHA + CI-run idempotency.
- `import-duckbrain <path>` — import selected DuckBrain JSONL records as pending memory candidates through `POST /api/memory/candidates`.
- `install-hooks` — install local post-commit hooks that call `rorca-capture ingest-commit HEAD` without blocking commits unless `--strict` is explicit.
- `daemon` — reconcile local commits from the persisted cursor, queue while the API is offline, flush after health checks recover, and expose status/stop controls.
- `status` — print resolved configuration, token, workspace, queue, daemon, hook, ignore, redaction, and command state.
- `flush` — replay the local JSONL queue through the same public API client.

Existing or future `rorca capture ...` invocations are thin aliases only. The standalone `rorca-capture` package owns the implementation.

## API and authentication

- All sidecar writes go through the Rorca Express API (`POST /api/...`).
- The sidecar authenticates with the existing MCP Bearer token at `~/.rorca/mcp-token`.
- Token file mode must be `0600` on POSIX systems.
- Requests send `Authorization: Bearer $(cat ~/.rorca/mcp-token)`.
- No sidecar code may import `pg`, construct a `Pool`, or consume `DATABASE_URL`.

## Configuration discovery

Discovery order is deterministic:

1. Environment variables: `RORCA_API_URL`, `RORCA_WORKSPACE_ID`, `RORCA_QUEUE_PATH`.
2. `<git-root>/.rorca/config.json`.
3. `<git-root>/.rorca/capture.json` sidecar-local overrides for generic config values.
4. Auto-detection from `git rev-parse --show-toplevel` plus default API `http://localhost:3030` for local/VM mode.

Supported config values:

- `apiUrl` / `rorcaApiUrl`
- `workspaceId`
- `repoPath`
- `queuePath`
- `mode`: `local`, `vm`, or `ci`
- `ignore`: path globs, max file bytes, max event bytes
- `redaction`: enabled flag, replacement text, redaction patterns
- `operatorAutoApprove`: opt-in gate for `remember --approve`; defaults to `false`

CI mode (`CI=true` or `--ci`) never prompts. Missing API URL, workspace, repo path, or required PR metadata is a hard configuration error.

## Workspace resolution

The sidecar resolves the repository root with `git rev-parse --show-toplevel`, then calls `GET /api/workspaces` and matches the returned workspace `path` against the resolved repo path. If `workspaceId` is explicitly configured, the sidecar verifies that ID through the same API response. A missing match returns an error compatible with Rorca's `NotFoundError` response shape: `{ error, code: "NOT_FOUND", details }`.

## Review, promotion, and retrieval gates

Manual, PR/CI, DuckBrain, and future extracted learnings enter Rorca as pending memory candidates. Pending and rejected candidates are review artifacts only: they are not durable memories and are not included in retrieval-safe context by default. Approving a candidate calls `POST /api/memory/candidates/{id}/approve`, promotes a durable memory with provenance, and records the candidate's review metadata. Retrieval-safe candidate reads keep conservative defaults: exclude pending/rejected rows, require at least medium confidence unless explicitly lowered, and require regulated-domain candidates to be approved.

## Safety contract

Path filtering, size limits, hashing, and redaction use the canonical `backend/src/lib/context-safety.ts` contract. The sidecar mirrors that contract locally so it stays standalone and API-only while keeping the same `rorca-context-safety/v1` version and defaults.

## References

- Architecture contract: `docs/rorca-capture-sidecar-contract.md`
- Package: `packages/rorca-capture`
