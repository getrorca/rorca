# PTY v2 Production Readiness Report

Date: 2026-07-15

Branch: `release/pty-v2-production-ready`

Starting SHA: `06ef7f864c1e926cc7cb1248de5da186dbb97e5d`

Merge base: `f6ad9aa763b8f5c8c7159f7766576619c03c35b4`

Decision: **NO-GO — provider matrix and promotion prerequisites incomplete**

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

## Linux/Docker production validation (2026-07-15)

**Result: PASS — advance only to GO FOR MANUAL PROVIDER CANARIES.** This validates Linux containers and a fake interactive CLI only. It is not a production GO and did not invoke Pi, Claude, Codex, OpenCode, or any paid provider.

### Isolation and cleanup contract

All runtime work used Compose project `rorca_ptyv2_cert`, whose only network and volume were `rorca_ptyv2_cert_default` and `rorca_ptyv2_cert_rorca_pgdata`. No host ports were published (the Compose services expose only internal `5432`/`3030`); existing host services and ports `3030`, `5210`, and `5433` were untouched. The validation used an absent `.env` file and empty provider-key substitutions. The backend health capability report showed all real CLIs unavailable, which was expected and prevented provider execution.

Commands (run from the candidate worktree) included:

```bash
DOCKER_BUILDKIT=1 docker build --no-cache -t rorca-ptyv2-cert:backend -f Dockerfile.backend .
DOCKER_BUILDKIT=1 docker build --no-cache -t rorca-ptyv2-cert:frontend -f Dockerfile.frontend .
DOCKER_BUILDKIT=1 docker build --no-cache -t rorca-ptyv2-cert:full -f Dockerfile .
DOCKER_BUILDKIT=1 docker compose -p rorca_ptyv2_cert -f docker-compose.yml build --no-cache db
docker compose -p rorca_ptyv2_cert -f docker-compose.yml up -d --no-build
```

Final image IDs were `rorca-ptyv2-cert:full` `sha256:5efa04126e9bea8be7bdccf63f10391ebc356737011e893d3181580b572e9aec`, backend `sha256:413ca3d047b77c0b8eef0eed26a5df0ae9d21a634843b31b77914ad1a7c6dde9`, frontend `sha256:706d149248459fb6960bc1b9d4bb120f44a4b4aaef89bae29d203e7375cd3964`, and isolated PostgreSQL/AGE `sha256:4d1ea020594e01702b596dd6115ef06e19b2d4ad7a9e6092c579d9604b1dc7b9`.

`docker image inspect` reported Linux/arm64 for all candidate images. The Node runtime is Alpine Linux with Node `v20.20.2` and npm `10.8.2`; `node-pty` is `1.1.0`. The Dockerfiles currently define no `USER`, so image `Config.User` is empty (root default); no non-root posture is claimed beyond the upstream image defaults. Docker history confirmed the build compiler toolchain is absent from the final Node runtime (the final runtime contains only the copied production dependency tree plus `postgresql16-client`). `docker scout` was not installed, so no vulnerability scan result is claimed.

### Packaging fixes discovered and verified

The clean Linux/arm64 builds initially exposed three packaging defects:

1. `Dockerfile.backend` ran `npm ci --omit=dev` in its runtime stage. `node-pty` has no musl/linux-arm64 prebuild, so npm attempted node-gyp without Python or a compiler.
2. Both backend build paths invoked the node-pty postinstall verifier before its script had been copied into the build context.
3. The standalone frontend image omitted `backend/src/reason-codes.ts`, which the frontend imports, and did not apply the repository's `legacy-peer-deps` install setting.

The backend now compiles and verifies `node-pty` in a build stage, prunes production dependencies, and copies the verified addon into the minimal runtime. The final runtime retains the verifier for deployment certification. The frontend copies its shared readiness module and installs reproducibly. The combined Compose service now runs `node backend/dist/server.js`; this prevents the image CLI from starting an embedded worker alongside Compose's dedicated worker.

### Native-addon and PTY evidence

Inside the assembled full Linux backend image:

```text
node-pty verified (linux/arm64); spawn-helper executable; require+spawn passed
minimal raw PTY: exitCode=0, rawHex=726f7263612d7074792d76322d6c696e75782d7261770d0a
```

The compiled native module was `/app/backend/node_modules/node-pty/build/Release/pty.node`, mode `0755`, root-owned and readable/executable in the image. The package's Darwin `spawn-helper` fixtures were also mode `0755`; on Linux/arm64 node-pty used the compiled `pty.node` path. The repository verifier and a separate `/bin/sh` PTY spawn both passed after the final image was assembled.

### Isolated stack, migrations, and worker evidence

`db`, `rorca`, and `worker` all reached Docker health `healthy`. On the fresh isolated volume, the worker applied 45 migrations and skipped 102 already represented by the packaged seed, reporting `Total: 147`; the API's immediate idempotent migration run applied 0 and skipped 147. Database inspection recorded 105 schema-migration rows through `20260319200000` and the four PTY tables: `run_pty_sessions`, `run_pty_output_chunks`, `run_pty_input_requests`, and `run_pty_resize_requests`.

`GET /api/health` from inside the API container returned database connected, PostgreSQL 16.14/arm64, AGE/pgvector available, worker `status: ok` with PID 1, and all four external PTY CLI compatibility probes `ready: false`/`binary_not_found`. Worker logs confirmed pg-boss startup, registration of pipeline/spec handlers, startup orphan sweep with no existing orphans, and `ready — listening for pipeline and spec job queues`. Two pre-existing non-fatal scheduler warnings reported missing `queue-snapshot-prune` and `integration:health-check` queues; worker health and the Compose health check remained green.

### Containerized fake interactive PTY/API integration

A disposable `fake` PTY was created only inside the isolated worker container. Its raw output and control requests used the compiled `run-pty-store` while the containerized API handled the public PTY routes using its internal service header. No real provider binary or credential was present.

- Valid API resize returned `{ ok: true, cols: 100, rows: 40 }`; the worker-side PTY applied it.
- Invalid base64 input returned HTTP 400. Valid UTF-8 base64 input returned `{ ok: true, bytes: 15 }`.
- The real PTY persisted and emitted `hello-from-api\r\nECHO:hello-from-api\r\n` in two raw chunks (37 bytes). A late API SSE attachment replayed both base64 chunks from `run_pty_output_chunks` and emitted `done`; reconnecting from `afterSequence=2` emitted no duplicate chunk and still emitted `done`.
- The recorded child PID was absent after normal completion.
- A second fake PTY intentionally ignored SIGTERM. This exposed a container-boundary cancellation bug: the API could not see a worker-container PID and prematurely marked the run cancelled. The API now defers any durable active PTY session to the worker. The focused unit test covers that policy. In the rebuilt stack, cancel returned `cancelling`; the worker changed the run to `cancelled`, PTY session to `killed`, and no child PID remained.

### Validation limitation / incident disclosure

The focused policy Jest invocation ran without an isolated `DATABASE_URL_TEST` guard and its global setup recreated the local `rorca_test` test database. It did not access the active `rorca` database, any active pipeline run, the main `/Users/dimitriteravanessian/rorca` worktree, or non-project Docker containers, but this was outside the intended Docker-only isolation boundary. No further local database tests were run; all remaining runtime/migration/integration evidence above is confined to `rorca_ptyv2_cert`.

Before handoff, stop and remove **only** this project with:

```bash
docker compose -p rorca_ptyv2_cert -f docker-compose.yml down -v --remove-orphans
docker ps -a --filter label=com.docker.compose.project=rorca_ptyv2_cert
```

The final command must return no project-specific containers; it removes only `rorca_ptyv2_cert_default` and `rorca_ptyv2_cert_rorca_pgdata`.

## Rollback plan

1. Stop or drain candidate workers before changing versions; do not leave two worker versions claiming the same PTY controls.
2. Cancel candidate PTY runs through the normal worker-owned cancellation path and confirm process groups are gone.
3. Deploy the previous reviewed SHA and default new triggers to `ansi-html` if PTY behavior is suspect.
4. Do not drop PTY tables or reverse additive constraints during an emergency rollback. Retain output/control evidence for diagnosis; old code ignores additive tables/columns.
5. If rollback follows migration but precedes provider canaries, verify queue health and orphan-process checks before resuming traffic.

## Remaining gates before production

1. Run one branch-only PTY canary each for Pi, Claude, Codex, and OpenCode with paid/subscription use explicitly approved.
2. For every provider verify prompt startup, stdin, live resize, reconnect/durable replay, sequential-story handoff, cancellation, terminal completion, worker restart/recovery, and no orphan process group.
3. ~~Run Linux/Docker package and native-addon validation on a host with a working Docker daemon.~~ **Complete 2026-07-15**; see Linux/Docker production validation above.
4. Record the clean candidate SHA with `git rev-parse HEAD`, review this report and canary artifacts, and issue a separate explicit production GO.

Until those steps pass, the only authorized conclusion is **GO FOR MANUAL PROVIDER CANARIES**.

## Final provider-canary and promotion review (2026-07-15)

**Decision: NO-GO.** No release branch was pushed, no branch was merged, and no production deployment was requested. Automated and Docker evidence is supportive only; it cannot replace the mandatory four-provider matrix.

### Isolation and evidence handling

The real Pi attempt used candidate SHA `06ef7f864c1e926cc7cb1248de5da186dbb97e5d` in disposable worktree `/tmp/rorca-ptyv2-canary-pi-20260715` on branch `canary/pty-v2-pi-20260715`, with `autoMerge=false`, `mergeStrategy=branch-only`, terminal mode `pty`, and an isolated PostgreSQL database. The approved one-story spec was deliberately limited to a committed text artifact `canary-artifacts/pty-v2-pi-canary.txt` containing `RORCA_PTY_V2_PI_CANARY_OK`; no product source was changed.

The first isolated-server startup exposed the known local DB-mode hazard: native persisted mode rewrote the supplied disposable URL to `postgres://localhost:5433/rorca`. It was stopped immediately. A check after shutdown recorded the shared database migration snapshot unchanged at `188 / 20260714143000`; no canary was launched in that configuration. The accepted attempt used a temporary `HOME` with `.rorca/db-mode=byop`, a mode-0600 disposable database-url file, and a temporary copy of Pi auth that was removed during cleanup. Its health response named only `rorca_ptyv2_canary_pi_20260715`.

### Provider matrix (sequential)

| Order | Provider | Exact CLI / compatibility result | Real run evidence | Result |
| --- | --- | --- | --- | --- |
| 1 | Pi | `/Users/dimitriteravanessian/.nvm/versions/node/v22.19.0/bin/pi`, `0.80.6`; `--version`/`--help` passed and advertise PTY-required `--mode`, `--provider`, `--model`, tools, extension, and prompt options. A minimal `openai-codex/gpt-5.4` provider preflight returned `PI_CANARY_AUTH_OK`. | Run `20260316000002`, `pty`, Pi `openai-codex/gpt-5.4`, exited 0. Prompt readiness was `pi_banner_or_prompt` then `injected`; resize `100x40` and a four-byte input request both returned `{ok:true}`. PTY health recorded 874,885 raw bytes, 0 dropped, durable completion file seen, real PID `96095` no longer alive, branch-only merge gate, and a committed harmless artifact. The corrected `/api/pipeline/runs/:id/output` SSE replay delivered 2,048 base64 raw chunk events (sequences 833–2880, 593,783 bytes), including real Pi UI/model output and the artifact value; reconnect from 2880 returned zero chunks plus `done`. | **PARTIAL — do not count as a final provider PASS.** The initial live attachment used the wrong `/pty` URL and captured no live stream; cancellation was not exercised against the completed paid run. Durable replay, controls, health, process exit, and completion-file gating passed. |
| 2 | Claude | Path resolves to `/Applications/cmux.app/Contents/Resources/bin/claude`, but both bounded probes fail: `Error: claude not found in PATH`. This is a cmux wrapper without a discoverable real Claude executable. | No paid session launched. | **BLOCKED** |
| 3 | Codex | `codex` is absent from `PATH`. | Not attempted: sequential matrix stopped at Claude. | **NOT RUN** |
| 4 | OpenCode | `opencode` is absent from `PATH`. | Not attempted: sequential matrix stopped at Claude. | **NOT RUN** |

No provider failure was suppressed. No release-code change was made because the observed blockers are environment/credential availability and operator-side incorrect initial SSE URL, not a demonstrated candidate defect. The real Pi terminal's completion marker was not printed, but the primary completion status file was observed and the real PTY process exited code 0; this meets the split completion contract for that run only.

### Exact accepted Pi commands and evidence

```bash
# Candidate-local isolated server/worker environment (temporary HOME forces BYOP)
HOME=/tmp/rorca-ptyv2-canary-pi-home \
DATABASE_URL=postgres://localhost:5433/rorca_ptyv2_canary_pi_20260715 \
DATABASE_URL_TEST=postgres://localhost:5433/rorca_ptyv2_canary_pi_20260715 \
PORT=3031 PI_BIN=/Users/dimitriteravanessian/.nvm/versions/node/v22.19.0/bin/pi \
npx tsx backend/src/server.ts

# Structured trigger payload used equivalent fields:
# autoWorktree=false, autoMerge=false, mergeStrategy=branch-only,
# agentOverride=pi, modelOverride=openai-codex/gpt-5.4,
# storyId=PTYPI-001, readinessOverride=true, terminal_mode=pty.

curl -NsS \
  'http://127.0.0.1:3031/api/pipeline/runs/20260316000002/output?workspaceId=pty-v2-pi-canary-20260715'
```

The accepted SSE metadata was `terminalMode=pty`, `isPty=true`, `ptyLiveTransport=postgres-notify+db-replay`, `ptySessionStatus=exited`, `ptyPromptReadinessStatus=injected`, `ptyCompletionFileSeen=true`, and `ptyProcessAlive=false`. Raw output was base64 SSE data rather than synthetic heartbeats. Cleanup verified that PTY child PID `96095` was absent; stopped the disposable server/worker; removed both temporary databases (ports 5432 and 5433), the temporary auth HOME/logs, the disposable worktree/branch, and the `rorca_ptyv2_finalgate` Compose containers/network/volume.

### Final candidate gate matrix

| Gate | Final result |
| --- | --- |
| `npm run check:contract` | PASS; acknowledged additive/breaking markers against merge base `f6ad9aa` |
| `npm run lint:tier` | PASS — 73 public, 28 auth, 17 paid, 30 admin |
| `npm run check:licenses` / `npm run check:license-boundaries` | PASS — 896 headers; single-Apache policy skip is expected |
| `npm run lint` | PASS — 0 errors, 68 pre-existing warnings |
| `npm run typecheck` / `npm run build` | PASS |
| Frontend `RunTerminal` focused test | PASS — 16 tests |
| Backend focused PTY suite final rerun | **BLOCKED SAFELY**: Jest refused to recreate the isolated database because its name lacked the `_test` suffix. It was not bypassed or redirected to another database. Earlier accepted certification remains recorded above; this final attempted rerun is not claimed as a pass. |
| `npm pack --pack-destination /tmp/ptyv2-final-pack --json` | PASS after creating the destination directory — 914 entries |
| `git diff --check` | PASS |
| `npm run split:check -- --allow-review` | **FAIL / promotion blocker** — four Docker files are `unknown` in `config/open-core-boundaries.json`; export is explicitly not safe |
| Fresh Docker Compose `rorca_ptyv2_finalgate` | PASS — rebuilt candidate images; `db`, `rorca`, and `worker` all reached `healthy`, then `down -v --remove-orphans` removed project containers/network/volume |

### Production review

- **Diff and policy:** candidate and `origin/main` have diverged since merge base `f6ad9aa`; `origin/main` is `3b783baa8fceed11bf939bfaaeb2a79ca682ce5d`. This is not a fast-forward ancestry relationship. No merge/rebase/push was attempted. The open-core boundary gate is additionally red.
- **Security/privacy:** PTY input/output bounds, workspace checks, guarded agent environment, durable control queues, and provider output retention are covered by the candidate and prior certification. The canary used a temporary copied auth file only; no secret is included in this report or committed evidence.
- **Database migrations:** all 147 candidate migrations applied to the disposable database and the accepted server/worker reruns skipped all 147. Migrations are additive; rollback must not drop PTY tables.
- **Native packaging/observability:** candidate native `node-pty` checks and the final Docker rebuild/health smoke pass. Pi health metadata, raw durable chunks, replay cursor, prompt injection state, completion file, exit code, and orphan PID state were observed.
- **Rollback point:** current production/main reference remains `origin/main` `3b783baa8fceed11bf939bfaaeb2a79ca682ce5d`; retain it as the rollback deployment reference. The candidate rollback procedure above still applies after any future promotion.

### Required manual gates before reconsidering GO

1. Repair/install subscription-authenticated CLIs, then re-run the **entire** sequential matrix in fresh disposable branch-only worktrees: Pi (including correctly attached live `/output` SSE and a safe cancellation run), Claude, Codex, OpenCode. Do not reuse this partial Pi result as the required PASS.
2. Resolve the open-core manifest gate deliberately; do not export the Docker changes while `npm run split:check -- --allow-review` reports unknown files.
3. Reconcile the stale release branch with current remote main in a new clean integration worktree; do not force-push or rewrite this candidate. Review branch protection and CI at `https://github.com/getrorca/rorca/settings/branches` and the pull-request checks before promotion.
4. Once all gates are green, use only normal pushes: `git push origin release/pty-v2-production-ready`, then merge through the repository-approved PR/required-check path or a verified fast-forward worktree, followed by `git push origin main`. Do not use `--force`.
5. Deployment is blocked: `coolify_status` could not fetch and no documented noninteractive production approval/credential was available. After repository promotion, use the documented target-host procedure in `DEPLOYMENT.md` (for example `cd /opt/rorca && docker compose build && docker compose up -d`) only with the production approver and then run its health/migration/non-destructive smoke checks.
