# PTY v2 Production Readiness Report

Date: 2026-07-15

Branch: `release/pty-v2-production-ready`

Merged baseline: current `origin/main` at `4ed6a98b5033cc4af2911da1837ef4f814db773a`

Initial main reconciliation merge: `7483169cf8e263dfc8e76d11500385a89d8391ef`

Final main reconciliation merge: `c8133bbde2801cb80adeb21a19966ebc701a9dea`

Rollback refs (preserved pre-merge SHA `4e2ef2e`):

- `safety/pty-v2-before-main-merge-20260715`
- `pty-v2-before-main-merge-20260715`

Fresh pre-remediation rollback refs (SHA `0e4d569f048c2f4b2c0a25d00e06018f6d0b8b46`):

- `safety/pty-v2-before-remediation-20260715`
- `pty-v2-before-remediation-20260715`

Decision: **GO FOR NORMAL RELEASE-BRANCH PUBLICATION AND REQUIRED-CI REVIEW.**

This decision permits only a normal push of the release branch after creating the clean release commit and verifying a clean worktree. It does not authorize a force-push, direct modification of `main`, production deployment, production database access, bypass/override of checks or reviews, or automatic merge.

## Scope and release fixes

The candidate preserves the run-scoped PTY architecture while hardening:

- monotonic run/story lifecycle transitions and sequential PTY handoff;
- durable raw output, cursor replay, PostgreSQL notifications, SSE backpressure, and bounded frontend queues;
- validated UTF-8/base64 input, resize bounds/coalescing, atomic control claiming, and stale-control cleanup;
- workspace authorization on output/input/resize/cancel/delete operations;
- process-group cancellation, worker shutdown/recovery, and durable cancellation when API and worker are in separate containers;
- provider startup/readiness for real Claude, Codex, OpenCode, and Pi TUIs;
- completion-file evidence separate from echoed terminal markers;
- native `node-pty` fail-closed installation and real-spawn verification;
- explicit `RORCA_DB_MODE` precedence so a supplied BYOP canary/CI database cannot be replaced by persisted local settings;
- current-checkout OpenAPI generation, without stale JS siblings or an unrelated running server;
- pinned, build-verified Docker provider CLIs on Node 22.

The public package moved from `2.0.0` to `3.0.0`; the generated public contract is `5.0.0`. Breaking-change acknowledgements cover:

- `GET /api/pipeline/runs/{runId}/output`
- `POST /api/pipeline/runs/{runId}/pty/resize`
- `POST /api/pipeline/task-manifests/trigger`

## Isolation and safety controls

Accepted provider certification used:

- disposable PostgreSQL on `127.0.0.1:55493`;
- disposable repositories under `/tmp/rorca-ptyv2-real-canaries`;
- `terminal_mode=pty`, `mergeStrategy=branch-only`, and `autoMerge=false`;
- two harmless artifact-only stories per completion run;
- separate one-story cancellation runs;
- temporary provider homes/credentials removed after use.

No provider wrote to the product repository. No candidate run merged automatically. No production database, production service, deployment, or `main` branch was modified. The canary server and worker were stopped after certification, and provider/canary process checks found no survivors.

## Genuine provider certification

The following were genuine authenticated CLIs, not fake smoke binaries:

| Provider | Certified CLI | Completion run | Result |
| --- | --- | ---: | --- |
| Claude | Claude Code `2.1.195`, Anthropic-signed, authenticated subscription | `20260316000006` | PASS — 2/2 stories, 2 commits, 702 chunks, 112,167 raw bytes |
| Codex | official Codex `0.144.4`, authenticated with ChatGPT | `20260316000012` | PASS — 2/2 stories, 2 commits, 2,897 chunks, 587,571 raw bytes |
| OpenCode | official `opencode-ai` `1.17.10`, authenticated through OpenRouter | `20260316000013` | PASS — 2/2 stories, 2 commits, 1,123 chunks, 577,700 raw bytes |
| Pi | `@earendil-works/pi-coding-agent` `0.80.6` | `20260316000014` | PASS — 2/2 stories, 2 commits, 2,845 chunks, 1,179,384 raw bytes |

For every completion run, certification verified:

- injected prompt readiness and real interactive TUI output;
- sequential story handoff with exactly two isolated commits/artifacts;
- canonical completion-file evidence;
- zero dropped PTY bytes;
- no surviving child PID/process group;
- live `/output` SSE delivery;
- reconnect from the final cursor with zero duplicate chunks and exactly one `done` event;
- branch-only disposition and no automatic merge.

OpenCode did not emit the optional terminal completion marker, but its canonical completion file was present and its process exited successfully. This is valid under the split completion contract; an echoed terminal marker cannot complete a run by itself.

### Cancellation and process cleanup

| Provider | Cancellation run | Final state |
| --- | ---: | --- |
| Pi | `20260316000015` | `cancelled` / PTY `killed`; child absent |
| OpenCode | `20260316000016` | `cancelled` / PTY `killed`; child absent |
| Claude | `20260316000017` | `cancelled` / PTY `killed`; child absent |
| Codex | `20260316000018` | `cancelled` / PTY `killed`; child absent |

After the four successful completion canaries, the worker was restarted. Runs `20260316000006`, `20260316000012`, `20260316000013`, and `20260316000014` remained `done:finished`, and zero active PTY sessions were reported.

The disposable database was subsequently recreated by test setup, so the active test database no longer retains the canary rows. The accepted evidence is the captured command output and isolated repository commits/artifacts; this report does not claim those rows remain queryable.

## Final automated gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | PASS — root, backend, Pi extension, public contract, capture package |
| `npm run lint` | PASS — 0 errors, 65 pre-existing warnings |
| `npm --prefix backend run lint` | PASS — 0 errors, 45 pre-existing warnings |
| `npm run build` | PASS — production frontend, backend, bin, and capture builds |
| `npm run check:contract` | PASS against merged `origin/main` `3b783baa`; three explicit breaking markers acknowledged |
| `npm run lint:tier` | PASS — 111 public, 32 auth, 17 paid, 27 admin; 110 public routes |
| `npm run check:licenses` | PASS — 1,039 source files |
| `npm run check:license-boundaries` | PASS/skipped under the repository's single Apache-2.0 policy |
| Root production audit | PASS — 0 vulnerabilities |
| Backend production audit | PASS — 0 vulnerabilities |
| Frontend `RunTerminal` | PASS — 16/16 tests |
| Focused PTY backend matrix | PASS — 10 suites, 88 tests |
| Previously candidate-only broad-suite failures | PASS on isolated rerun — 9 suites, 94 tests |
| Native `node-pty` verifier | PASS — Darwin/arm64 require, executable helper, real spawn |
| Staged open-core check | PASS with `--allow-review` — no blocked or unknown files; Docker/package metadata explicitly review-sensitive |
| `git diff --check` | PASS |

### Broad-suite classification

A controlled full-suite comparison was red on both the merged-main baseline and candidate under the same shared PostgreSQL/Jest environment:

- baseline: 85 failed, 190 passed suites; 382 failed, 3,404 passed tests;
- candidate before the final fixes: 94 failed, 181 passed suites; 509 failed, 3,279 passed tests.

The nine candidate-only failed suites were rerun after the final fixes in-band against the disposable database and all passed (9 suites, 94 tests). This includes pipeline PTY attachment/readiness, execution environments, workspace hydration, Hilo hydration, graph graceful degradation, WAL, and reasoning-field coverage. The remaining broad failures reproduce on merged `main` and are dominated by shared database/global-setup contamination, unavailable RLS roles, stale fixtures/types, and unrelated readiness/provider assumptions. A green monolithic backend suite is **not** claimed; no persistent candidate-only failure remains in the isolated comparison.

## PTY soak

Final command used both `DATABASE_URL` and `DATABASE_URL_TEST` pointing to `127.0.0.1:55493/rorca_ptyv2_merge_test`, with `RORCA_DB_MODE=byop`.

- target: 8,388,608 bytes;
- observed/replayed: 8,468,608 / 8,468,608 bytes;
- hash match: true;
- dropped bytes: 0;
- chunks/pages: 2,673 / 6;
- compressed payload/logical row bytes: 105,260 / 311,016;
- throughput: 2.910 MiB/s;
- batch latency: p50 7.634 ms, p95 10.991 ms, p99 11.963 ms, max 12.665 ms;
- event-loop utilization: 0.1545; p99 delay 10.994 ms;
- RSS delta: 53,575,680 bytes;
- 10,000-small-chunk flood completed.

## Package and Linux image

`npm pack` produced `rorca-3.0.0.tgz`:

- 1,075 files;
- 3.6 MB packed / 14.7 MB unpacked;
- SHA-1 `6a13c804fe140fe21730dbcde9c0bf2218adbdcb`;
- required PTY verifier, trigger-options migration, backend output, and frontend bundle present.

The final Docker image is `rorca-ptyv2-merged-final`, image ID `sha256:1326d5dbcd0f0013d749cdcbd1e1cfeb7716e45a31f5b696bf937a7174d9f92f`.

Runtime verification passed with:

- Node `v22.23.1`;
- Claude Code `2.1.195`;
- Codex `0.144.4`;
- OpenCode `1.17.10`;
- Pi `0.80.6` from `@earendil-works/pi-coding-agent`;
- Linux/arm64 `node-pty` require, executable helper, and real spawn;
- compiled PTY manager/adapter, migration, and frontend assets present.

The Dockerfile pins the same provider versions used by the authenticated canaries and runs every provider's `--version` during image construction. This turns partial/failed global installs into a build failure. The image moved to Node 22 because current Claude Code requires Node 22 or newer.

## Incident disclosures and corrective actions

- Persisted local DB mode initially overrode explicit canary/test URLs in earlier certification. The candidate now gives explicit `RORCA_DB_MODE` precedence; a direct test confirmed `byop` preserved port `55493` and the requested database. No production database was accessed.
- One diagnostic command omitted the isolated API port and sent a malformed promotion payload to an existing localhost service on port 3030. It returned HTTP 422; no run or file/database mutation was created. One contract diagnostic also read that service before current-checkout loading was enforced; it was read-only.
- Codex's TUI update path installed the official `0.144.4` binary in the user's existing NVM prefix. No global Codex MCP registration was added; the candidate deliberately avoids run-scoped mutation of the user's MCP registry.
- Repeated Docker builds exhausted the disposable Docker VM storage. The disposable PostgreSQL container exited during a checkpoint, then recovered after reclaiming build cache. A first image therefore contained a partial Codex install despite `npm install` returning success. The candidate now verifies all four provider binaries during the image build; the rebuilt pinned image and runtime verification pass.
- Earlier broad Jest setup recreated a non-production local `rorca_test` database outside the intended disposable endpoint. It did not access the active `rorca` database or a production service. All accepted final DB-backed evidence uses the disposable `55493` endpoint and explicit BYOP mode.

## Rollback and promotion controls

1. Retain both pre-merge rollback refs and `origin/main` `3b783baa8fceed11bf939bfaaeb2a79ca682ce5d`.
2. Stop/drain candidate workers before changing versions; do not allow two worker versions to claim the same controls.
3. Cancel active PTY runs through the worker-owned path and confirm process groups are absent.
4. Roll back the application SHA without dropping additive PTY tables/columns; retain durable output/control evidence.
5. Default new runs to `ansi-html` if PTY behavior is suspect, then verify queue health and orphan sweeps before resuming.
6. Publish this branch only with a normal `git push origin release/pty-v2-production-ready`; never force-push or push directly to `main`.
7. Merge and deploy only through the repository's required review/CI and the separately authorized production procedure.

## Final remediation update — current main reconciliation

### Root cause and repair

The red GitHub gates were a real release defect. Root `npm ci` invoked the root `postinstall`, which installed backend dependencies using `npm ci --ignore-scripts` and immediately ran the fail-closed verifier. Suppressing lifecycle scripts also suppressed `node-pty`'s own install hook, so Linux had no loadable `pty.node`; the verifier correctly stopped installation rather than accepting a cached or missing native backend.

`backend/scripts/install-dependencies.js` now retains the initial script-suppressed install only to avoid recursive lifecycle invocation, then explicitly runs the lockfile-selected `npm rebuild node-pty --ignore-scripts=false --foreground-scripts` before the existing require/helper/real-spawn verifier. This uses node-pty's native install path for the current OS/architecture; it does not copy a global binary or weaken verification. New node:test coverage asserts the checkout and packed lifecycle ordering and fail-closed behavior.

The delayed PTY attachment timeout was a test-isolation/determinism issue, not a reproduced transport regression. A clean disposable PostgreSQL run passed the original suite. The regression test now deliberately disables the in-process NOTIFY subscriber, sets the supported minimum 250 ms recovery cadence before loading the route, commits delayed PTY chunks, and proves ordered polling delivery plus exact durable replay. The shared Jest cleanup now truncates all PTY session/output/control tables. This replaces an ambient-listener/timing dependency; it does not increase the test timeout.

Two unrelated release-gate defects found during final evidence were repaired rather than ignored:

- Pi-extension tests now clear the operator's `RORCA_PI_WORKSPACE_ID` for chooser coverage and assert sanitizer redaction evidence without pinning an internal detector count; the full Pi extension suite passes under a real operator environment.
- Reconciliation with current main changed the public persisted-spec schema (optional Genesis provenance and additive canonical response `id`). The OpenAPI snapshot and contract documentation are regenerated at contract `6.0.0`, with an explicit, backward-compatible migration acknowledgement for `POST /api/specs/persist`.

### Final evidence after reconciliation

| Gate | Result |
| --- | --- |
| Main ancestry | PASS — `4ed6a98b5033cc4af2911da1837ef4f814db773a` is an ancestor of `c8133bbde` and the later remediation commits. |
| Clean Linux root lifecycle | PASS — clean Linux/x64 Node 20 Docker checkout ran root `npm ci`, built a real `backend/node_modules/node-pty/build/Release/pty.node`, and passed require/helper/real-spawn verification. Linux/arm64 passed the same path. |
| Clean macOS lifecycle and packed install | PASS — clean macOS checkout root install, verifier, lifecycle unit test, and isolated `scripts/verify-pack.sh` package smoke passed. |
| Static/build gates | PASS — root and backend typecheck, root/backend lint (0 errors; pre-existing warnings only), production build, tier lint, license headers/boundaries, diff check. |
| Open-core boundary preflight | PASS with `--allow-review` — 163 shareable, 28 explicitly review-sensitive, 0 blocked, 0 unknown files. |
| Contract and migrations | PASS — disposable PostgreSQL migrations plus current-checkout served contract check against `4ed6a98b`; four acknowledged contract changes, including persisted-spec contract `6.0.0`. |
| Focused PTY/backend | PASS — 12 suites, 75 passed / 1 explicitly skipped: lifecycle, cancellation, manager, native fake spawn, CLI compatibility, detector/version, durable store, attachment/replay, output parity, and golden terminal coverage. |
| Frontend and packages | PASS — `RunTerminal` 16/16; Pi extension 87/87; capture package 75/75. |
| Docker image/runtime | PASS — fresh no-cache Node 22 Alpine build verified pinned `claude 2.1.195`, `codex 0.144.4`, `opencode 1.17.10`, `pi 0.80.6`; Linux/arm64 node-pty require/helper/real-spawn passed. |
| Docker Compose smoke | PASS — isolated ephemeral `pgvector:pg16` + release image started with no provider credentials, applied migrations, returned healthy API and static frontend. Repository compose configuration also validated. |

A final repeat of the Linux clean-install command after the no-cache image build hit Docker VM `ENOSPC` while unpacking the repository's already-tracked historical `backend/backups` payload. This was infrastructure storage exhaustion, not an npm/node-pty failure; the same clean root Linux/x64 command had already passed after the lifecycle repair and main reconciliation, and the final image build/runtime verifier passed. No broad monolithic backend-suite pass is claimed; the documented baseline comparison remains applicable and no focused candidate-only PTY failure remains.

### Publication and merge controls

- These fresh rollback refs are local by design; only the release branch is eligible for normal publication. Existing safety refs/tags remain untouched.
- Push only `release/pty-v2-production-ready` with a normal non-force push, then wait for every required GitHub check and any mandatory approval.
- Merge only with `gh pr merge` after GitHub reports green required checks and policy permits a normal protected merge. Do not delete the release branch.
- No production deployment, production service/database operation, or direct push to `main` was performed during remediation.

## Final publication procedure

1. Review the complete staged diff and create one clean release commit.
2. Verify `origin/main` remains an ancestor, the worktree is clean, and no canary/provider process or temporary credential remains.
3. Record the release commit SHA in the operator handoff, then perform a normal non-force push.

## PR #15 frontend CI remediation

The first PR #15 CI run (`29465930614`) failed only its Frontend Tests job (119 failed / 743 passed). This was investigated rather than bypassed.

- 114 failures were caused by five test files replacing all `react-router-dom` exports while their shared renderer requires `MemoryRouter`. The mocks now preserve the actual exports, and `MemoryPanel` no longer nests a second router.
- The remaining five were real release defects: unavailable PTY telemetry was rendered as zeroes, Pi/Terra provenance was lost in metadata, native interactive PTY did not force sequential execution, and the Always-On Capture panel still called a retired candidate API with a mismatched trust vocabulary.
- The UI now consumes canonical telemetry formatters, forces sequential execution for `native-pty`, and uses the canonical `/api/context-candidates` list/action/preview contract with its context-candidate trust tiers. Unsupported retired filters/actions were removed rather than silently issuing ineffective requests.

Post-remediation evidence:

| Gate | Result |
| --- | --- |
| Focused affected frontend suites | PASS — 155 tests across router isolation, metadata, trigger, capture, and run-view coverage |
| Full frontend CI command (`npx vitest run`) | PASS — 66 files, 862 tests |
| `npx tsc --noEmit` | PASS |
| `npm run build` | PASS — frontend, backend, bin, capture package |

This remediation changes neither deployment state nor branch-protection policy. PR #15 remains unmerged pending a normal push, fresh CI, and any required review.
