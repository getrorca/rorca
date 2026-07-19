# PTY noisy multi-story recovery release evidence

This document is the review gate for PTY-008. It records deterministic evidence; it does not authorize merge, deployment, auto-merge, or a server/worker restart.

## Recovery guarantee

Rorca's guarantee is precise and intentionally split by artifact:

- **The current terminal is always recoverable** from a validated, bounded checkpoint plus bounded generation deltas. A corrupt newest checkpoint is ignored in favor of earlier valid evidence; it never resets a valid visible screen.
- **Complete structured history is browsable** as generation-bound, cursor-paginated transcript pages. Structured history is presentation evidence, not completion authority.
- **Exact raw bytes are available during their configured retention window** as restricted, hash-verified gzip segments. Missing or corrupt segments are reported as gaps without deleting valid earlier evidence.
- **No UI attempts to load an unbounded raw TUI recording at once.** The terminal loads a bounded checkpoint/delta window, the transcript loads pages of at most 100 events, and raw archives stream one verified segment at a time to an authorized operator.

The guarantee does not promise indefinite raw-byte retention, reconstruction after both checkpoint and retained-delta evidence are gone, or terminal recovery from a corrupt checkpoint with no earlier valid checkpoint/delta. Terminal repaint normalization is not lifecycle authority.

## Deterministic harness

Run from the repository root:

```bash
cd backend
npm run typecheck:pty-release
npm run test:pty-release
npm run benchmark:pty-release -- --output docs/evidence/pty-noisy-recovery-benchmark.json
```

`backend/scripts/lib/pty-noisy-release-harness.ts` generates every byte at runtime from a story-indexed xorshift32 seed. No output fixture or raw archive is committed. Four generations cover three sequential stories, including a failed first attempt and isolated successful retry. Each generation emits more than the former 64 MiB prefix limit through the production headless-xterm checkpoint codec. Repaint blocks are archived into bounded gzip segments and restored/hash-checked byte-for-byte.

The fast `node:test` profile uses the same paths at reduced volume. The release profile enforces full volume and fails on any false release-matrix cell or threshold violation. It uses no database, network, pg-boss queue, server, worker, sleep-based assertion, or deployed process.

## Recorded benchmark

Artifact: [`evidence/pty-noisy-recovery-benchmark.json`](evidence/pty-noisy-recovery-benchmark.json)

| Measure | Recorded | Explicit threshold | Meaning |
| --- | ---: | ---: | --- |
| Logical repaint traffic | 302,080,056 B | >64 MiB for each of 4 generations; >=3 stories | Bytes actually accepted by checkpoint emulators and archive hashers |
| Bounded database growth model | 33,651,519 B | <=48 MiB | Sum of each generation's peak compressed checkpoint plus uncompacted delta window; no live DB was touched |
| Compressed archive | 4,573,369 B | <=48 MiB | Actual gzip segment bytes held by the run and hash verified |
| Checkpoint cost, max / p95 | 652.325 / 576.943 ms | max <=10,000 ms | Measured serialization barriers, no elapsed-time sleep assertion |
| Replay latency, max / p95 | 12.715 / 6.511 ms | max <=10,000 ms | Measured decode and fresh-emulator recovery |
| Browser recovery memory | 16,991 B | <=16 MiB | Largest serialized current-screen payload presented to the bounded browser recovery model, not whole Chromium RSS |
| Event lag | 1 sequence | <=2 | Durable cursor distance while every third notification is intentionally lost |
| True dropped bytes | 0 B | exactly 0 B | Observed raw bytes minus independently decompressed/hash-verified bytes |
| Committed fixtures | 0 B | exactly 0 B | Traffic and archives are runtime generated |

Timing values are machine-load sensitive and are evidence from this run, while hashes, byte counts, generation ordering, and matrix outcomes are deterministic. The generous latency ceiling catches runaway replay without turning scheduling jitter into a release failure. Production capacity planning must still measure real PostgreSQL/WAL/filesystem/browser-process overhead; this isolated release harness deliberately does not mutate a live database or active worker.

## Positive journey matrix

| Journey | Deterministic evidence | Production contract evidence |
| --- | --- | --- |
| Sequential story rollover and retry isolation | Four ordered generation records; failed `NOISY-002/1` and successful `NOISY-002/2` have distinct hashes | `run-pty-store.test.ts` generation isolation; `pipeline-pty-attachment.test.ts` rollover/reset |
| Interactive input and resize | Generation-bound input acknowledgement and mid-stream resize reflected in every later marker/checkpoint | `pipeline-pty-attachment.test.ts` exact-generation controls; `RunTerminal.test.tsx` input/resize forwarding |
| Structured Pi events | Correlated tool call/result plus model/host/completion records | `pi-structured-profile.test.ts` and `pty-transcript-store.test.ts` |
| Transcript pagination | Ordered pages of three events in harness; production limit is 1–100 | `pty-evidence.test.ts` and `RunTranscript.test.tsx` bounded on-demand paging |
| Raw archive integrity | Per-segment compressed SHA-256 plus independently restored whole-stream SHA-256 | `pty-raw-archive.test.ts` and `pty-evidence.test.ts` |
| Compaction, refresh, reconnect | 36/36 compaction checks and 36/36 fresh-emulator reconnect checks preserve the exact current marker | `RunTerminal.test.tsx` checkpoint-before-delta, refresh cursor, reconnect and visible-screen preservation |
| Notification loss | Every third notification is omitted; durable cursor catches up with maximum lag 1 | `pipeline-pty-attachment.test.ts` notifier-free polling and `Last-Event-ID` resume |
| Slow consumer | First backpressure refusal emits one cursor-preserving retry frame and closes; no second frame queues | `sse-hub-bounded.test.ts` and `RunTerminal.test.tsx` backpressure reconnect |
| Terminal completion | Every generation records an explicit failed/completed terminal state without treating screen text as authority | completion protocol and execution-engine closeout tests |

## Negative recovery drills

All cells are `true` in the benchmark artifact. The harness checks corrupt-checkpoint rejection with prior evidence intact, missing archive detection with the valid prefix intact, malformed structured-event quarantine with surrounding events intact, stale generation input denial, restart recovery from durable checkpoints, failed-worker rollover, retention eligibility races, unauthorized raw archive denial, and legacy-only current-screen fallback.

Production-focused coverage remains authoritative for boundaries that a process-local harness cannot mutate safely:

- corrupt checkpoint plus retained deltas: `backend/src/routes/__tests__/pipeline-pty-attachment.test.ts`
- missing/corrupt archive and valid-prefix preservation: `backend/src/lib/__tests__/pty-raw-archive.test.ts`
- malformed/partial Pi event retention: `backend/src/lib/__tests__/pi-structured-profile.test.ts`
- stale generation control and replacement races: `backend/src/lib/__tests__/run-pty-store.test.ts`
- additive database/server restart safety: PTY migration contract tests and generation durability tests
- worker exit and retry identity: execution-engine closeout and generation rollover tests
- retention active/reference races and rollback preservation: `pty-operations-contract.test.ts`
- unauthorized transcript/archive access: `backend/src/routes/__tests__/pty-evidence.test.ts`
- legacy-only captures: `run-pty-store.test.ts` and ANSI fallback terminal tests

No negative drill deletes valid evidence to prove an error path.

## Release and rollback controls

Before opening the PR:

1. Fetch `origin/main` and verify the branch is based on it with `git merge-base --is-ancestor origin/main HEAD`.
2. Run focused tests, test-file typecheck, frontend tests, safe backend unit/integration suites, root/backend typechecks, lint, build, public-contract stability, license headers/boundaries, and dependency security audit.
3. Run `git diff --stat origin/main` and inspect `git status --short`; reject generated archives, runtime locks, secrets, absolute personal paths, or unrelated files.
4. Create with `gh pr create --base main`. Do not pass `--fill` without reviewing the body.
5. Confirm no `auto-merge` label, merge queue, deployment label, deployment environment, or automatic deployment rule is enabled.
6. Do not restart or signal the active Genesis server/worker. This harness needs neither process.

`lint:swagger` and `lint:tier` remain unusable through `tsx` because their ESM `__dirname` resolves incorrectly. Use `npm run build:contract && npm run check:contract` and record that known tooling limitation in the PR instead of weakening route tiers. Rollback is the non-destructive feature-flag sequence in [`pty-recovery-operations.md`](pty-recovery-operations.md); it preserves generations, transcripts, manifests, and valid raw segments.
