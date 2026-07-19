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

## Cleanup and evidence

Filesystem cleanup requires canonical realpath containment, root and repository ownership markers, exact repository identity, a complete owned-worktree list, and a symlink-free tree. Any missing/mismatched marker, traversal, symlink, swapped repository, or unrelated worktree rejects cleanup without deletion.

Database cleanup permits only one exact equality predicate over an approved namespace column/value. It rejects schema-qualified/pg-boss targets, migration state, evidence, history, audit, WAL, decision, attestation, and checkpoint tables. Queue cleanup uses pg-boss APIs and exact current-run queue grammar; SQL never manipulates `pgboss.*`.

Output records only SHA-256 identity labels and before/after sentinel digests. Credentials, full database URLs, private absolute paths, scenario payloads, and production records are never printed.

The machine-checkable invariant and scenario mapping is [`wave-parallel-invariants.json`](./wave-parallel-invariants.json). Validate it with:

```sh
npm run check:wave-invariants
npm run test:wave-qualification
```
