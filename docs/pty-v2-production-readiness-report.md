# PTY v2 Production Readiness Report

Date: 2026-07-15

Branch: `release/pty-v2-production-ready`

Starting SHA: `6e7bc30b5337d99e54b0e2d85b8a17447fe27a23`

Merge base: `f6ad9aa763b8f5c8c7159f7766576619c03c35b4`

Decision: **GO FOR MANUAL PROVIDER CANARIES**

This is not a production GO. It does not authorize a push, merge to `main`, production deployment, production database access, automatic merge, or paid-provider execution. Production remains gated on real Pi, Claude, Codex, and OpenCode PTY canaries plus explicit operator review.

## Scope and release fixes

The candidate hardens the PTY v2 path without changing its run-scoped architecture:

- Keeps lifecycle state monotonic across sequential stories by attaching later story PTYs without moving a running run backward.
- Bounds and validates raw terminal input, UTF-8/base64 payloads, resize dimensions, pending input, and frontend queues.
- Claims and deletes input atomically, coalesces resize requests, and purges stale controls between story generations.
- Enforces workspace membership on PTY output, input, resize, cancel, and delete operations.
- Disconnects slow SSE consumers after bounded backpressure and relies on durable cursor replay rather than unbounded server buffering.
- Cancels durable PTY process groups even when an in-memory child handle is missing, including worker shutdown/recovery paths.
- Removes shell interpolation from Codex MCP setup and strips Rorca infrastructure secrets from autonomous agent environments.
- Coalesces small PTY output callbacks before persistence and adds a deterministic soak harness.
- Adds migration `20260714160000_pty_transport_security_bounds.sql` for PTY constraints and rate limits.
- Makes native `node-pty` installation fail closed and verifies the module, executable `spawn-helper`, and a real spawn.
- Updates vulnerable production dependencies; root and backend production audits report zero vulnerabilities.

## Database isolation and migration evidence

Accepted database evidence was generated on a disposable PostgreSQL 16 instance at `127.0.0.1:55492`. Before each accepted DB-backed command, both `DATABASE_URL` and `DATABASE_URL_TEST` were printed and asserted to resolve to that port. A temporary HOME with persisted `byop` mode was used for server-importing Jest suites so local mode selection could not rewrite the endpoint.

### Fresh database

A new `rorca_fresh2_test` database applied all 147 migrations through `20260714160000`, then an immediate idempotent rerun applied zero and skipped 147.

Post-migration checks:

- Extensions: `age`, `pgcrypto`, `plpgsql`, `vector`.
- Four `rorca.run_pty%` tables present.
- Migration 050 recorded as `050_knowledge_graph.sql [skipped: application schema collision]`.
- The runner retains `CREATE EXTENSION IF NOT EXISTS age` when supported, but does not create the legacy AGE graph named `rorca`, because AGE graph names are PostgreSQL schemas and that name belongs to application tables. The supported graph bootstrap remains `rorca_v2`.
- AGE-unavailable or permission-restricted databases continue in graph-lite mode.

### Upgrade database

A disposable database initialized from merge base upgraded from 137 to 147 migrations. It gained lifecycle v2 fields, PTY output bounds, input/resize security constraints, and the latest migration version. The temporary merge-base worktree was removed after validation.

### Isolation incident disclosure

During broad-suite classification, one invocation demonstrated that persisted native DB mode could rewrite an explicitly supplied local test URL to port 5433. Requests then failed because `rorca_suite_test` did not exist there. A subsequent single-suite invocation mistakenly allowed Jest global setup to recreate/migrate the separate `rorca_test` database on port 5433. This violated the isolation instruction. It did **not** address the active `rorca` database, backend, worker, or run `20260316000492`; no cleanup command was issued against port 5433. All accepted evidence listed after that point used the verified 55492 endpoint and temporary BYOP HOME guard described above.

## PTY regression gates

| Gate | Result |
| --- | --- |
| Backend PTY/lifecycle/store/adapter/CLI/security matrix | PASS — 7 suites, 50 tests |
| Pipeline PTY attachment, sequential forcing, replay, cursor reset, resize/input validation, fallback, and disconnect | PASS — 14 tests with a local fake `claude` executable; no provider call |
| Frontend `RunTerminal` regression suite | PASS — 16 tests |
| Fresh PostgreSQL 16 migration + idempotent rerun | PASS — 147 migrations |
| Merge-base upgrade migration | PASS — 137 → 147 migrations |
| `node-pty` require, helper permissions, and spawn | PASS — Darwin/arm64 |
| Deterministic isolated soak | PASS |

## Isolated soak result

Command: `cd backend && npm run soak:pty`, with both database URLs verified as `127.0.0.1:55492/rorca_suite_test`.

- Observed/replayed: 8,468,608 / 8,468,608 bytes.
- Hash match: true; dropped bytes: 0.
- Persisted chunks: 2,673; replay pages: 6.
- Throughput: 13.923 MiB/s.
- Batch latency: p50 1.920 ms, p95 2.914 ms, p99 3.382 ms, max 5.214 ms.
- Event loop: utilization 0.5558; mean delay 10.062 ms; p99 11.330 ms; max 12.722 ms.
- RSS delta: 62,685,184 bytes.
- Compressed DB payload: 105,260 bytes; logical row bytes: 311,016.
- 10,000-small-chunk flood completed.

## Release and packaging gates

| Command | Result |
| --- | --- |
| Fresh detached checkout: `npm ci` | PASS — backend checkout dependencies retained; node-pty verification ran during install |
| Fresh detached checkout: `npm run typecheck` | PASS — frontend, backend, Pi extension, public contract |
| Fresh detached checkout: `npm run build` | PASS — frontend production bundle, backend TypeScript, bin TypeScript |
| `npm run lint` | PASS — 0 errors, 68 warnings |
| `cd backend && npm run lint` | PASS — 0 errors, 41 warnings |
| `npm run check:contract` | PASS against merge base; contract 2.0.0 |
| `npm run lint:tier` | PASS — 73 public, 28 auth, 17 paid, 30 admin; 69 stable public API routes |
| `npm run check:licenses` | PASS — 894 source files |
| `npm run check:license-boundaries` | PASS/skipped by single Apache-2.0 repository policy |
| `npm run split:check -- --allow-review` | PASS — 54 shareable, 3 review, 0 blocked, 0 unknown |
| `npm audit --omit=dev --audit-level=high` | PASS — 0 vulnerabilities |
| `cd backend && npm audit --omit=dev --audit-level=high` | PASS — 0 vulnerabilities |
| `npm pack --pack-destination /tmp/ptyv2-pack-final --json` | PASS — 912 entries, 3,154,522-byte tarball |
| Package content checks | PASS — verifier, migration, CLI, and frontend bundle included |
| `git diff --check` | PASS |

The production bundle reports existing large-chunk warnings but completes. `npm pack` invokes the production build. Because the historical bin TypeScript compile also emits two tracked backend JavaScript siblings, those unintentional emitted files were reverted before commit; they are not candidate changes.

Docker image construction was not executed because the local Docker daemon is unavailable:

`failed to connect to the docker API at unix:///Users/dimitriteravanessian/.docker/run/docker.sock`

This is an external environment blocker, not a passing Docker gate. Linux image/native-addon validation remains required in CI or another host with a working daemon.

## Broad-suite classification (not PTY gates)

A broad backend run was split into bounded batches to avoid the repository's known monolithic Jest memory/listener accumulation. Work stopped after four batches in accordance with release scope; unrelated tests were not rewritten merely to make the legacy suite green.

Observed non-PTY failures include:

- RLS integration assumptions requiring `anon`/authenticated roles absent from plain PostgreSQL, plus a direction-layer RLS expectation mismatch.
- Legacy trigger/spec-generation tests returning readiness 422 or generation 500 when real CLI/provider prerequisites were intentionally unavailable.
- `CLI-016` and PR-template fixtures that do not type-check under the current strict test compiler.
- Pi retry-context assertions expecting clone behavior while current code requests new sessions.
- MCP transport expectation 200 versus current protocol response 406.
- A process-listener isolation assertion failing only after many server-importing suites run in one process.
- A core-table test querying `public.pg_tables` while application tables are under `rorca`.

None of those failures intersects the PTY candidate hunks. Focused PTY gates pass with isolated DB and fake CLI. The frontend monolithic suite likewise has unrelated pre-existing failures outside `RunTerminal`; only the PTY frontend suite is a release gate here.

## Rollback plan

1. Stop or drain candidate workers before changing versions; do not leave two worker versions claiming the same PTY controls.
2. Cancel candidate PTY runs through the normal worker-owned cancellation path and confirm process groups are gone.
3. Deploy the previous reviewed SHA and default new triggers to `ansi-html` if PTY behavior is suspect.
4. Do not drop PTY tables or reverse additive constraints during an emergency rollback. Retain output/control evidence for diagnosis; old code ignores additive tables/columns.
5. If rollback follows migration but precedes provider canaries, verify queue health and orphan-process checks before resuming traffic.

## Remaining gates before production

1. Run one branch-only PTY canary each for Pi, Claude, Codex, and OpenCode with paid/subscription use explicitly approved.
2. For every provider verify prompt startup, stdin, live resize, reconnect/durable replay, sequential-story handoff, cancellation, terminal completion, worker restart/recovery, and no orphan process group.
3. Run Linux/Docker package and native-addon validation on a host with a working Docker daemon.
4. Record the clean candidate SHA with `git rev-parse HEAD`, review this report and canary artifacts, and issue a separate explicit production GO.

Until those steps pass, the only authorized conclusion is **GO FOR MANUAL PROVIDER CANARIES**.
