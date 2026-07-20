# Generation-aware PTY recovery operations

This runbook covers generation capture, rolling checkpoints, normalized transcripts, restricted raw archives, retention, rollout, and rollback. It does **not** authorize deployment, backend/worker restart, merge, terminal input, or story completion. Those authorities remain unchanged.

## Data and sensitivity model

| Artifact | Purpose | Sensitivity | Default retention |
| --- | --- | --- | --- |
| Replay chunks | Fast current terminal attachment | Raw terminal bytes; may contain secrets | 14 days |
| Checkpoints | Bounded current viewport recovery | Serialized terminal state; may contain terminal content | 14 days |
| Transcript events | Redacted readable history | Bounded through `context-safety.ts` | 30 days |
| Raw archive segments | Lossless incident evidence | **Restricted and unredacted**; prompts, operator input, and credentials may appear | 30 days |
| Generation/manifests | Identity, lifecycle-neutral integrity metadata | Metadata only | Not deleted by PTY artifact retention |

Store raw archives only on encrypted, access-controlled storage. Archive download remains an explicit local-admin action and is never MCP exposed.

## Feature controls

Controls are independent and read from `process.env` at each operation/request. Setting one does not broaden merge, deploy, keyboard-input, lifecycle, or completion authority.

- `RORCA_DISABLE_STRUCTURED_PI_MODE=true`: use the legacy interactive Pi execution adapter instead of Pi RPC. It does not enable browser keyboard input.
- `RORCA_DISABLE_PTY_CHECKPOINT_COMPACTION=true`: continue capture/replay/archive/transcript writing but stop new checkpoint creation and delta eviction.
- `RORCA_DISABLE_PTY_GENERATION_READER=true`: select legacy ANSI replay. Generation-only captures can show a blank terminal; their rows, transcripts, manifests, and raw segments remain intact.

Retention windows are independent:

- `RORCA_PTY_REPLAY_RETENTION_DAYS` (default 14)
- `RORCA_PTY_CHECKPOINT_RETENTION_DAYS` (default 14)
- `RORCA_PTY_TRANSCRIPT_RETENTION_DAYS` (default 30)
- `RORCA_PTY_ARCHIVE_RETENTION_DAYS` (default 30)

`RORCA_PTY_ARCHIVE_SEGMENT_BYTES` controls segment rotation, not evidence retention.

## Health, metrics, and alerts

Use **Settings → PTY Recovery** or `GET /api/pty-operations/health`. Live events are available at `/api/pty-operations/health/stream` and traverse `sse-hub.ts` exclusively.

Byte metrics have only `component` and the closed `byte_class` label: `observed`, `archived`, `transcripted`, `compacted`, `dropped`, or `unrecoverable`. Retained replay is a separate gauge. No metric label/event contains output, prompts, absolute paths, generation credentials, or unbounded identifiers.

Recommended alerts (tune to normal workload):

- `dropped > 0`: warning; inspect queue pressure and database latency.
- `unrecoverable > 0`: critical; raw continuity could not be proven.
- missing/corrupt archive segments: critical; quarantine the manifest and verify contained files.
- checkpoint age > 2 checkpoint intervals while output is active: warning.
- replay latency p95 > 2 seconds: warning; inspect PostgreSQL and chunk volume.
- transcript lag > 30 seconds for structured Pi or normalized output: warning.
- storage > 70%: warning; > 85%: critical and stop starting high-output workloads.

## Capacity planning

Estimate daily capacity independently rather than from the replay cap:

```text
daily raw = concurrent runs × average observed bytes/run × runs/day
archive disk = daily raw × gzip ratio × archive retention days
replay DB = daily retained replay × replay retention days
checkpoint DB = checkpoints/day × compressed checkpoint size × checkpoint retention days
transcript DB = events/day × average bounded payload × transcript retention days
```

Add at least 30% burst/headroom and account for PostgreSQL indexes/WAL. Compare `observed` against `archived`, `transcripted`, retained replay, `compacted`, `dropped`, and `unrecoverable`; these represent different guarantees and must not be summed as one storage total.

### Why increasing byte caps is temporary mitigation

A larger `RORCA_PTY_MAX_CAPTURE_BYTES` postpones replay-ring exhaustion but increases database growth, late-attach latency, browser work, and incident blast radius. It does not repair slow persistence, queue overflow, missing archive segments, transcript lag, checkpoint corruption, or broken retention. Increase a cap only for a bounded incident window while correcting the bottleneck and documenting a return value/date.

## Retention procedure

1. Run `POST /api/pty-operations/retention` with `{ "dryRun": true }`.
2. Confirm the four independent counts and configured windows.
3. Verify no long-running generation is unexpectedly marked closed and any legal/incident holds use `referenced_by_manifest=true`.
4. Execute with `{ "dryRun": false }` only under operator authorization.
5. Refresh health and verify integrity/storage trends.

Every prune query requires `completed_at IS NOT NULL AND NOT referenced_by_manifest` and `generation.is_active = FALSE`. Replay chunks, checkpoints, transcript events, and raw files are pruned independently. Generation rows and archive manifests survive. PTY retention never accesses `pgboss.*`.

## Checkpoint repair and blank-terminal diagnosis

1. Confirm `controls.generationReader` and `controls.checkpointCompaction`.
2. Check schema compatibility. A blocked/unknown schema returns HTTP 422 for mutation with the expected/actual version and migration action.
3. Inspect checkpoint age and corruption telemetry. Never reset the browser from an unvalidated blob.
4. If the newest checkpoint is corrupt, retain it for evidence and allow the reader to use the prior valid checkpoint plus deltas.
5. If no valid checkpoint exists, use bounded retained replay. A transcript or verified archive can prove history but must not manufacture terminal state.
6. For a blank terminal, determine whether legacy rollback is active, the capture is generation-only, replay retention expired, or the browser attached after a missing checkpoint. During rollback, a blank terminal is expected presentation degradation—not generation loss or a lifecycle regression.
7. Never repair by deleting a generation, transcript, manifest, or valid raw segment.

## Rollout order and mixed versions

1. Back up and verify database restore capability.
2. Apply additive migrations first. They preserve historical rows and create legacy sentinel generation metadata without renumbering bytes.
3. Verify `/api/pty-operations/health` reports schema v1 `ready`.
4. Roll out writers. New writers do not require a new browser/reader to finish a process or story.
5. Enable the generation reader for a small operator cohort; old captures continue through sentinel-selected legacy replay.
6. Enable checkpoint compaction only after archive integrity and replay latency are healthy.
7. Enable structured Pi independently after its isolated/offline capability probe passes.
8. Expand while watching dropped/unrecoverable bytes, checkpoint age, transcript lag, replay latency, archive integrity, and storage.

An older browser ignores additive SSE fields. A newer browser against an older server can continue legacy replay and accepts the former run-meta control credential for mixed-version compatibility. Unsupported schema states degrade reads and block mutation with actionable HTTP 422 diagnostics; they are never silently mutated.

## Non-destructive rollback drill

Before rollback, call `POST /api/pty-operations/rollback/simulate`. Record `mutationPerformed=false`, expected presentation, and preserved counts.

Rollback order:

1. Disable the new reader with `RORCA_DISABLE_PTY_GENERATION_READER=true` through the request-time environment/config surface.
2. Confirm existing processes continue; do **not** restart the backend or worker as part of the drill.
3. Reattach through legacy terminal replay. Generation-only captures may be blank.
4. Optionally disable checkpoint compaction and structured Pi independently if isolating those paths.
5. Verify generation rows, transcript events, archive manifests, and valid raw segments match the simulation counts.
6. Verify merge/deploy/input/completion authority is unchanged.
7. Re-enable in reverse order after health is stable.

Temporarily unavailable during legacy rollback: generation selection, checkpoint viewport restore, and structured transcript presentation. Transcript/archive APIs and stored evidence remain available to a compatible server; rollback must never drop additive tables or delete evidence.

## Incident learning

Record: effective flags and policy, schema state, six byte classes plus retained replay, latency/lag/age, integrity counts, storage trend, dry-run/executed retention counts, repair decision, and rollback simulation. Do not paste terminal output, prompts, absolute paths, credentials, generation tokens, or raw archive content into tickets or telemetry.
