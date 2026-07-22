# Release-1 supervised-core certification

The canonical entrypoint is [`scripts/release-one-certification.mjs`](../../scripts/release-one-certification.mjs). Its immutable dependency order is data in [`config/release-one-certification-gates.json`](../../config/release-one-certification-gates.json).

## Safety and authority

- The only database identity accepted is the existing mode-`0600` credential for `rorca_test_runner@rorca_cert_test`. The runner verifies server-side database, role, owner, schema, PostgreSQL version, and migration count before any DB-backed gate. It never creates, drops, reassigns, or owns database authority objects and never hand-manages `pgboss.*`.
- Rorca application state remains canonical, pg-boss remains transport-only, and Hermes remains supervisory.
- The runner rejects the protected Rorca and Hermes checkouts. Evidence output must be outside both source repositories.
- Commands are executed without a shell and fail fast. The gate schema rejects publication shells/actuators. No gate may push, publish, create a PR/provider object, merge, deploy, install an App, activate ingress/policy, or mutate a protected checkout.
- Gate 1 refuses to start unless both repositories are clean. Every run compares a content digest before and after all commands; a source mutation fails certification.

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
  --output /private/tmp/rorca-release-one-gate1
```

Gate 1 reruns Gate 0 and adds real pg-boss lifecycle/load, sandbox/egress/path/Git containment, an exact local image build, and the complete classified Jest corpus. Every current broad failure is release-blocking; classification never authorizes implementing an excluded future capability. Every skip must carry an explicit detector/platform/fixture reason.

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
