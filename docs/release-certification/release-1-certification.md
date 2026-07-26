# Release-1 supervised-core certification

The canonical entrypoint is [`scripts/release-one-certification.mjs`](../../scripts/release-one-certification.mjs). Its immutable dependency order is data in [`config/release-one-certification-gates.json`](../../config/release-one-certification-gates.json).

## Safety and authority

- The only database identity accepted is the existing mode-`0600` credential for `rorca_test_runner@rorca_cert_test`. The runner verifies server-side database, role, owner, schema, PostgreSQL version, and migration count before any DB-backed gate. It never creates, drops, reassigns, or owns database authority objects and never hand-manages `pgboss.*`.
- Rorca application state remains canonical, pg-boss remains transport-only, and Hermes remains supervisory.
- The runner rejects the protected Rorca and Hermes checkouts. Evidence output must be outside both source repositories.
- Commands are executed without a shell and fail fast. The gate schema rejects publication shells/actuators. No gate may push, publish, create a PR/provider object, merge, deploy, install an App, activate ingress/policy, or mutate a protected checkout.
- Gate 1 refuses to start unless both repositories are clean and an explicit `--real-platform-boundaries-manifest` is supplied. Every run compares a content digest before and after all commands; a source mutation fails certification.
- Real provider capture authority is never inferred from `HOME`, Pi/OpenCode login state, environment credential directories, or an existing proxy socket. The certification-only capture command accepts only a separately supplied mode-`0600`, SHA-bound grant and credential file, and executes through the exact-host Unix-socket CONNECT broker.

## Gate 0 — dirty candidate, before commit

```bash
npm run certify:release-one -- \
  --phase gate0 \
  --hermes-root /private/tmp/hermes-rorca-production-integration \
  --historical-broad-json /private/tmp/rorca-f2-broad-rerun1-results.json \
  --output /private/tmp/rorca-release-one-gate0
```

Gate 0 binds tracked and untracked candidate bytes, regenerates the capability classification, runs the supervised/fail-closed profiles in both repositories, runs static/OpenAPI/MCP/license/OpenCore and real migration gates, builds both repositories, executes the built Hermes→Rorca live pair, and audits both diffs. A Gate 0 result is pre-commit evidence only; it is not exact-SHA release authority.

## Gate 1 — clean exact pair

After origin reconciliation, reviewable replacement commits, and clean trees:

```bash
npm run certify:release-one -- \
  --phase gate1 \
  --hermes-root /private/tmp/hermes-rorca-production-integration \
  --historical-broad-json /private/tmp/rorca-f2-broad-rerun1-results.json \
  --real-platform-boundaries-manifest /absolute/restricted/evidence/real-platform-boundaries.json \
  --output /private/tmp/rorca-release-one-gate1
```

Gate 1 reruns Gate 0 and adds real pg-boss lifecycle/load, sandbox/egress/path/Git containment, the mandatory `real-platform-boundaries` artifact gate, an exact local image build, and the complete classified Jest corpus. Every current broad failure is release-blocking; classification never authorizes implementing an excluded future capability. Every skip must carry an explicit detector/platform/fixture reason, but detector-labelled fixture skips do **not** satisfy `real-platform-boundaries`.

The real-platform manifest is runtime evidence, not a checked-in proof. Its verifier requires exact current Rorca commit/tree binding and semantic `status: "passed"`, `actual: true`, `skipped: 0` for all four boundaries:

1. Linux bwrap with real user/mount/PID/network namespaces, private proc/root, executable binding, admission, and resource/network-namespace teardown.
2. PostgreSQL 16+ with AGE, graph `rorca_v2`, idempotent real Cypher MERGE/MATCH, image, labels, indexes, and database teardown.
3. Pi `0.80.6` at fixed `80x24` geometry with exact executable hash, scoped provider/model grant, broker policy/instance binding, and raw/normalized transcript hashes.
4. OpenCode `1.17.10` with the same fixed-geometry, grant authority, exact broker instance, transcript, and teardown bindings.

All evidence references must be normalized relative regular files under a mode-`0700`, verifier-owned evidence root; the manifest and evidence files must be verifier-owned with no group/world access. Symlinks, absolute paths, hash drift, missing transcripts, source mismatch, split/expired grant authority, or any skip fail the gate. The verifier writes `real-platform-boundaries.verified.json` into the Gate 1 bundle, and the pair manifest hashes that summary.

### Certification-only real terminal capture

After a separately explicit, test-scoped, time-bounded provider grant defines the exact provider/model/hosts, credential-file hash, cost limit, expiry, binaries, and Linux runtime, run:

```bash
backend/node_modules/.bin/tsx scripts/capture-real-terminal-boundaries.ts \
  --source-root "$PWD" \
  --grant /absolute/restricted/grant.json \
  --credential-file /absolute/restricted/provider.env \
  --output /absolute/restricted/new-capture-root
```

The output directory must be new. The command runs Pi and OpenCode sequentially through `prepareAutonomousModelSandboxLaunch()`, gives each engine a separate blank isolated home/workspace, disables ambient Pi resources, fixes geometry to `80x24`, requires exact versions and an assistant-only semantic response marker, scans transcripts for credential leakage, and proves per-engine workspace plus shared-broker teardown. Missing authority or any capture defect exits nonzero and emits no passing terminal manifest. The checked-in golden terminal fixtures remain deterministic non-release replay coverage (`actualProviderCapture: false`); they are never promoted into this artifact.

## Evidence bundle

The output directory is mode `0700`; evidence files are mode `0600`.

- `pair-manifest.json`: Rorca/Hermes HEAD, tree, branch, clean/dirty state, staged/unstaged/HEAD diff hashes, untracked file hashes, DB identity, ordered gate results, exact log hashes, and build/image/broad artifact hashes.
- `pair-manifest.json.sha256`: detached hash of the rendered manifest.
- `change-manifest.json`: path-level review inventory and byte identities for the initial pair.
- `NN-<gate>.log`: command/cwd, exact combined process output, status, signal, and timeout state.
- `broad/jest-results.json` and `broad/classification.json`: machine result and deterministic current-failure/skip accounting (Gate 1).

`pair-manifest.json.payloadSha256` hashes canonical JSON for every manifest field except itself. The detached digest then binds the rendered file. A failed or interrupted run retains the last fail-fast checkpoint and is not release authority.

## Human-only remainder

Certification intentionally stops before push, tag, PR/check creation for this implementation, merge, deployment, GitHub App installation/repository selection, secret/ingress/channel activation, or any policy activation. Those actions require the exact bundle plus separate human/provider authority.
