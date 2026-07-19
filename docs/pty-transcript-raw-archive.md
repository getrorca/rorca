# PTY transcript and restricted raw archive

For capacity, alerts, independent retention, mixed-version rollout, repair, and non-destructive rollback, see [`pty-recovery-operations.md`](pty-recovery-operations.md).

Rorca stores two independent generation-scoped terminal records:

1. **Structured transcript (`v1`)** — readable model lines, structured tool calls/results, host notices, errors, and explicit gaps. Events are append-only and ordered by `(generation_id, seq)`. Terminal-normalized rows are presentation evidence and are never lifecycle authority. Story completion still comes from the completion file, process exit, merge, and validation gates.
2. **Raw archive (`v1`)** — exact unredacted bytes received from `node-pty`, including ANSI controls and screen repaints. Bytes are written in order as rotating gzip segments under `<workspace>/.rorca/pty-archives/<generation-id>/`.

The bounded PostgreSQL PTY output ring remains an attachment/replay optimization. It is not full-history authority.

## Transcript API

`GET /api/pty-evidence/runs/:runId/generations/:generationId/transcript`

- Requires authenticated workspace access.
- Accepts an opaque generation-bound `cursor` and `limit` from 1–100.
- Returns at most one bounded page, a next cursor, and explicit sequence gaps.
- Payloads are redacted and bounded only through `backend/src/lib/context-safety.ts`.
- `correlationId` is mandatory for `tool_call` and `tool_result` events.
- Live notifications use the SSE hub topic and instruct clients to rehydrate from the durable cursor; stream delivery order is not trusted.

## Raw archive access

Raw bytes are **restricted operator evidence**. They may contain secrets shown by the terminal and are intentionally not redacted or exposed to MCP.

- `GET .../raw-archive/manifest` returns ranges, compressed/raw sizes, SHA-256 hashes, timestamps, retention, completion state, and gaps to administrators.
- `GET .../raw-archive` is administrator-only. Before sending headers, Rorca resolves the run/generation/workspace join, verifies every path remains under the workspace archive root (including real-path/symlink containment), verifies sizes/hashes and contiguous byte ranges, then streams one segment at a time with backpressure.
- The response is a concatenation of valid gzip members. Standard gzip readers restore the exact original byte stream in segment order.
- Filesystem paths, environment data, launch prompts, and output from unrelated workspaces are not returned as metadata or selected by request input.

## Rotation, recovery, and retention

Environment controls:

- `RORCA_PTY_ARCHIVE_SEGMENT_BYTES`: raw bytes per segment; bounded to 4 KiB–64 MiB (default 8 MiB).
- `RORCA_PTY_ARCHIVE_RETENTION_DAYS`: restricted-evidence retention; bounded to 1–3650 days (default 30).

On startup, Rorca performs a bounded reconciliation of manifests left in `writing` after their generation closed. It scans only the contained generation directory, reconstructs byte ranges from valid gzip members, recomputes shared context-safety hashes, preserves valid earlier segments, and marks missing/corrupt ranges explicitly. Retention is an explicit schema-gated daily operation; it independently prunes only completed, unreferenced artifacts from inactive generations and preserves generation/manifests.

Writer, manifest, transcript, integrity, and prune failures use `AppError` subclasses and structured logging. They never manufacture agent completion or change the agent process/story result. Archive completion means only that the evidence writer closed successfully.
