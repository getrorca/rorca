# Rorca Capture Sidecar Architecture Contract

This contract implements the product requirements in [`docs/prds/rorca-context-capture-sidecar/PRD.md`](./prds/rorca-context-capture-sidecar/PRD.md).

## Package and entrypoint

- Monorepo package: `packages/rorca-capture/`
- Binary: `rorca-capture`
- Root CLI alias: `rorca capture ...`
  - Alias only: it shells out to the standalone `rorca-capture` binary/source entrypoint.
  - The alias must not reimplement command behavior.

## Commands

`rorca-capture --help` exposes the MVP surface:

- `remember`
- `ingest-commit`
- `ingest-git`
- `install-hooks`
- `daemon`
- `status`

## Non-negotiable API-only boundary

The sidecar never writes directly to the Rorca database.

Allowed:

- Read repo files and git metadata locally.
- Read `~/.rorca/mcp-token` for API authentication.
- Write local git hook files when `install-hooks` is explicitly run.
- Send reads/writes to the Rorca Express API.

Forbidden:

- Reading or requiring `DATABASE_URL`.
- Importing `pg` or constructing a PostgreSQL `Pool`.
- Writing Rorca memory, ingest, queue, workspace, or WAL records outside `POST /api/...`.

All API requests use:

```sh
Authorization: Bearer $(cat ~/.rorca/mcp-token)
```

The token file is expected at `~/.rorca/mcp-token` with POSIX mode `0600`.

## Configuration discovery

Discovery loads sources in this order while preserving explicit runtime/env values:

1. Runtime flags and env vars (`RORCA_API_URL`, `RORCA_WORKSPACE_ID`, `RORCA_QUEUE_PATH`).
2. `<git-root>/.rorca/config.json`.
3. `<git-root>/.rorca/capture.json` as the sidecar-local override for generic config values.
4. Auto defaults: detected repo path and `http://localhost:3030` outside CI.

Supported fields:

```json
{
  "apiUrl": "http://localhost:3030",
  "workspaceId": "rorca",
  "repoPath": "/path/to/repo",
  "queuePath": ".rorca/capture-queue.ndjson",
  "mode": "local",
  "ignore": {
    "paths": ["node_modules/**", ".git/**"],
    "maxFileBytes": 262144,
    "maxEventBytes": 1048576
  },
  "redaction": {
    "enabled": true,
    "replacement": "[REDACTED]",
    "patterns": ["SECRET=[^\\s]+"]
  }
}
```

Mode values are `local`, `vm`, and `ci`. `CI=true` or `--ci` forces CI mode. CI mode suppresses prompts and treats missing `RORCA_API_URL`/repo discovery as a hard error.

## Workspace/API resolution

- Resolve repo root with `git rev-parse --show-toplevel`.
- Call `GET /api/workspaces` with the MCP Bearer token.
- If `workspaceId` is configured, verify it exists in the API response.
- Otherwise match `workspace.path` against the resolved repo path.
- On no match, return a NotFound-compatible shape: `{ error: "Workspace not found", code: "NOT_FOUND", details: { repoPath } }`.

## Status output shape

Text and JSON status include:

- `ok`
- `apiOnly`
- `apiUrl`
- `repoPath`
- `workspaceId`
- `workspaceResolvedBy`
- `queuePath`
- `mode`
- `ignore.pathCount`, `ignore.maxFileBytes`, `ignore.maxEventBytes`
- `redaction.enabled`, `redaction.patternCount`
- MCP token path/mode state
- command list
- safety contract version
- errors

## Safety/redaction dependency

Canonical primitives live in `backend/src/lib/context-safety.ts`:

- path filter defaults
- file/event size limits
- SHA-256 content hashing
- built-in redaction patterns
- `CONTEXT_SAFETY_CONTRACT_VERSION = "rorca-context-safety/v1"`

`packages/rorca-capture/src/context-safety.ts` mirrors this contract so the sidecar remains standalone and does not depend on backend database/runtime modules.
