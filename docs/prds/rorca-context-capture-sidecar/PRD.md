# PRD: Rorca Context Capture Sidecar

## Summary

`rorca-capture` is a standalone, API-only sidecar that captures developer context from local repositories, VMs, and CI jobs and sends that context to Rorca through the Express API. It does not connect to PostgreSQL, does not read `DATABASE_URL`, and does not write Rorca queue, memory, or ingest records outside `POST /api/...` calls.

## MVP command surface

The package entrypoint is `packages/rorca-capture` and the binary is `rorca-capture`:

- `remember <text>` — create a manual memory through `POST /api/memory`.
- `ingest-commit [hash]` — request commit ingestion through the Rorca API.
- `ingest-git` — request repository git-history ingestion through the Rorca API.
- `install-hooks` — install local git hooks that call `rorca-capture`.
- `daemon` — reserved long-running sidecar process; MVP emits a status heartbeat.
- `status` — print resolved configuration, token, workspace, queue, ignore, redaction, and command state.

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

CI mode (`CI=true` or `--ci`) never prompts. Missing API URL or repo path is a hard configuration error.

## Workspace resolution

The sidecar resolves the repository root with `git rev-parse --show-toplevel`, then calls `GET /api/workspaces` and matches the returned workspace `path` against the resolved repo path. If `workspaceId` is explicitly configured, the sidecar verifies that ID through the same API response. A missing match returns an error compatible with Rorca's `NotFoundError` response shape: `{ error, code: "NOT_FOUND", details }`.

## Safety contract

Path filtering, size limits, hashing, and redaction use the canonical `backend/src/lib/context-safety.ts` contract. The sidecar mirrors that contract locally so it stays standalone and API-only while keeping the same `rorca-context-safety/v1` version and defaults.

## References

- Architecture contract: `docs/rorca-capture-sidecar-contract.md`
- Package: `packages/rorca-capture`
