# Wave-parallel qualification isolation

Wave qualification runs behind a separate safety boundary. It is not an alias for Jest, the application server, or a normal `DATABASE_URL` workflow.

## Provisioning contract

Provisioning is an external CI/infrastructure action against a disposable PostgreSQL 16 instance. The qualification suite does **not** create, drop, truncate, or repurpose a database or role. For a random run ID `qrun_<24 lowercase hex>` the externally provisioned identities must be exact:

- database: `rorca_qtest_<same 24 hex>`
- login/owner: `rorca_qrole_<same 24 hex>`
- database comment: `rorca-qualification-owned:qrun_<same 24 hex>`
- connection `application_name`: `rorca-qualification:qrun_<same 24 hex>`

The role must own only that database and must not have superuser, `CREATEDB`, `CREATEROLE`, replication, or `BYPASSRLS` privileges. The infrastructure job must supply only:

- `RORCA_QUALIFICATION_RUN_ID`
- `RORCA_QUALIFICATION_ISOLATION_MARKER`
- `RORCA_QUALIFICATION_DATABASE_URL`

There is no fallback to `DATABASE_URL`, `DATABASE_URL_TEST`, PG variables, persisted Rorca configuration, or a registered workspace.

## Launch

```sh
node scripts/run-wave-qualification.mjs path/to/qualification-scenario.ts
```

The launcher uses `spawn(..., { shell: false })` and an allow-listed environment. It strips application database/PG, queue, workspace, repository, cloud, Git provider, LLM provider, payment, token, secret, and credential variables. The child repeats identity checks, performs a read-only server-truth query, and verifies database name, role, owner, role privileges, application name, and the pre-provisioned database comment before creating any fixture.

Only after preflight does the runner:

1. create a run-namespaced repository/artifact root under the real OS temporary root;
2. change cwd to that synthetic repository;
3. import the scenario module;
4. expose namespace-checked row cleanup and lazy pg-boss queue creation.

A scenario exports `runQualification(context)`. It must use the context boundary identities. pg-boss is started only with `RORCA_QUALIFICATION_DATABASE_URL`, and every scenario queue is created with `boss.createQueue()` using the `qualification:<run-id>:` prefix. The suite does not run application migrations against any other database and contains no hand-managed `pgboss.*` migration.

## Deterministic subprocess authority

The authoritative concurrency/fault gate is the provider-free node:test suite in
`backend/src/lib/__tests__/deterministic-fixture-agent.node.test.ts`. Production
story dispatch and the fixture harness both enter through
`backend/src/lib/story-execution-adapter.ts`; the fixture then launches the fixed
`wave-fixture-agent.mjs` entrypoint as a real child process with `shell: false`.

Fixture behavior can only be selected by ID from the versioned test-owned
`wave-agent-scenarios.json`. Requests cannot provide commands, argv, scripts,
shell flags, environment variables, hosts, or URLs. The child receives an
allow-listed test environment with an isolated HOME, no application/provider/
cloud/database credentials, disabled system/global Git configuration, and
loopback-deny proxy settings. The fixed fixture source imports no networking
module. Production routes do not import or expose the harness or manifests.

The suite covers pass, both rejection sides of commit, dirty-worktree rejection,
bounded sleep, a two-process barrier, deterministic conflicting edits, timeout,
cancellation, abrupt exit, and checkpointed restart/resume. Every launch has a
unique execution identity, bounded JSONL/stdout/stderr, explicit timestamps and
lifecycle booleans, and process-group cleanup. Its barrier assertion requires
both arrival records to predate either release record, proving wall-clock overlap
rather than relying on launch order.

`wave-fault-points.json` is the durable-boundary catalog from queue claim through
run closeout. Determinism comparisons preserve source hashes, commit IDs/messages,
fault points, exit state, lifecycle, and normalized events. They remove only the
catalogued volatile fields: execution/process IDs, descendant PIDs, timestamps,
wall-clock barrier readings, elapsed time, and OS exit signal representation.

A real-Pi smoke may be run separately for adapter parity after this gate passes.
It is never part of `test:wave-qualification`: provider availability, credentials,
rate limits, terminal rendering, and model output cannot satisfy or block the
authoritative result.

## Cleanup and evidence

Filesystem cleanup requires canonical realpath containment, root and repository ownership markers, exact repository identity, a complete owned-worktree list, and a symlink-free tree. Any missing/mismatched marker, traversal, symlink, swapped repository, or unrelated worktree rejects cleanup without deletion.

Database cleanup permits only one exact equality predicate over an approved namespace column/value. It rejects schema-qualified/pg-boss targets, migration state, evidence, history, audit, WAL, decision, attestation, and checkpoint tables. Queue cleanup uses pg-boss APIs and exact current-run queue grammar; SQL never manipulates `pgboss.*`.

Output records only SHA-256 identity labels and before/after sentinel digests. Credentials, full database URLs, private absolute paths, scenario payloads, and production records are never printed.

The machine-checkable invariant and scenario mapping is [`wave-parallel-invariants.json`](./wave-parallel-invariants.json). Validate it with:

```sh
npm run check:wave-invariants
npm run test:wave-qualification
```
