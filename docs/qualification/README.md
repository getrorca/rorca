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

## Successful exactly-once integration gate

`successful-wave-integration.node.test.ts` executes four independent fixture
stories in owned temporary worktrees. Deliberately duplicated queue deliveries
are claimed once, while two-process barriers prove actual overlap. Contributions
are serialized by compiled wave index and story-ID tie-breaking; the same wave
runs with bounds two and four and must produce the same accepted IDs, integration
order, source files, and final tree hash.

The integration linearization protocol is `wave-integration-protocol.ts`. Its
atomic restart record progresses through `prepared`, `integrating`,
`conflicted`, `resolution_pending`, `aborted`, `integrated`,
`integrated_validated`, `finalized`, or `failed`, and binds each
transition to run/story/attempt, source/base commits, expected parent, frozen
manifest hash, resulting revision, validation identity, and finalization receipt.
Before every apply it rejects dirty or busy Git state, a moved source ref, broken
source ancestry, an unexpected target head, or a changed manifest. An
`integrating` restart recognizes only the exact expected-parent/source two-parent
merge; everything else fails closed.

The PostgreSQL mirror is `story_integration_ledger`, keyed by
`(run_id, story_id, attempt)`, with unique integration order and finalization
idempotency constraints. Result/spec/run/WAL pass projections occur in the proof
trace only after durable finalization. A separately implemented JavaScript trace
checker consumes the normalized trace as a subprocess and must agree with the
TypeScript engine-facing assertions on order, state chains, projection timing,
and final run revision.

## Conflicted-story recovery and partial-wave semantics

`conflicted-wave-integration.node.test.ts` creates two real concurrent fixture
branches that edit the same existing hunk. Agent completion arrival is permuted,
but integration is always serialized by wave index and canonical story ID. The
first contribution and an independent sibling remain finalized exactly once;
the second conflict makes the overall run and authoritative `run_closeout`
failed. Dependents of that story block. This is intentionally **not** wave-level
atomicity: already accepted independent history is neither rolled back nor
retroactively failed.

Before aborting, the ledger durably records bounded path prefixes plus full path
hashes, conflict class, source commit, expected and actual parent, and pre-merge
head. It then runs `git merge --abort`, verifies a clean idle target at the same
head, records the post-abort head, and transitions to `aborted`. Restart
projection distinguishes never-attempted, integrating, conflicted,
resolution-pending, aborted, failed, and integrated attempts. A conflicted or
aborted record cannot enter integrated validation or canonical pass
finalization.

Automatic conflict resolution is disabled. Resolver identity and resolution
diff are therefore explicitly null in durable evidence; binary, generated,
rename/delete, add/add, gitlink/unsupported, ambiguous, and resolver-crash paths
all fail closed rather than selecting a side or dropping source. Any future
resolver must introduce an explicit bounded policy, durable identity and diff,
and mandatory integrated validation before finalization.

Rejected conflict worktrees are snapshotted through the owned cleanup protocol,
removed, and retained by a content-addressed recovery ref. The run branch,
successful sibling commits, unrelated refs, ledger evidence, and recovery ref
remain. Qualification inventory requires no merge/cherry-pick/rebase head,
unmerged index entry, mutation lock, owned temporary source ref, or extra
worktree after every conflict scenario.

## Rejected-story fail-closed gate

`rejected-wave-closeout.node.test.ts` runs a post-commit rejection and an
independent sibling behind the same two-process barrier. Once rejection is
accounted, the dispatch fence prevents every unstarted story and later wave from
starting. An independent sibling that was already running is not killed between
unsafe phases: it may drain only through its current host validation,
integration, and canonical closeout boundary. Direct and transitive dependents
are computed from exact compiled-DAG story IDs, persisted with `blockedBy`, and
never receive a fixture process, worktree, queue claim, commit, validation, or
merge.

Rejected, failed, and processed accounting precedes dependency analysis. Spec,
run, WAL, story-result, and local-diagnostic projections are all attempted with
`Promise.allSettled`; any missing channel sets an evidence gap and remains
semantic failure. Process success, independent-story success, or cleanup success
cannot supersede the authoritative failed `run_closeout`, and no process-level
`run_finished` success is accepted after rejection.

`rejected-wave-closeout.ts` is the portable evidence boundary. API/WAL reason
and stack fields are valid UTF-8, byte-bounded, and secret/POSIX/Windows-path
redacted for Error, string, object, primitive, oversized multibyte, circular,
and serialization-failure values. The raw local diagnostic is separately
bounded, mode 0600, marked non-portable, and must never be copied to an API or
WAL. A rejected committed worktree is removed normally while its commit remains
available through the owned recovery ref; the successful sibling finalizes and
integrates exactly once and has both temporary worktree and branch removed.

## Cleanup and evidence

Filesystem cleanup requires canonical realpath containment, root and repository ownership markers, exact repository identity, a complete owned-worktree list, and a symlink-free tree. Any missing/mismatched marker, traversal, symlink, swapped repository, or unrelated worktree rejects cleanup without deletion.

Database cleanup permits only one exact equality predicate over an approved namespace column/value. It rejects schema-qualified/pg-boss targets, migration state, evidence, history, audit, WAL, decision, attestation, and checkpoint tables. Queue cleanup uses pg-boss APIs and exact current-run queue grammar; SQL never manipulates `pgboss.*`.

Output records only SHA-256 identity labels and before/after sentinel digests. Credentials, full database URLs, private absolute paths, scenario payloads, and production records are never printed.

The repeated seeded model, CI/soak profiles, leak sentinel, versioned performance
budgets, and failure evidence contract are documented in
[`wave-stress.md`](./wave-stress.md).

The machine-checkable invariant and scenario mapping is [`wave-parallel-invariants.json`](./wave-parallel-invariants.json). The versioned production evidence architecture, state machine, qualification, threat model, operations, rollout, recovery, and requirement cross-reference are indexed in [`wave-parallel-v1/README.md`](./wave-parallel-v1/README.md).

Portable reports are generated after the stress child as a separate blocking phase. Terminal output is never passed to the builder. Trusted publication recomputes current repository/workspace and engine/policy/compiler/invariant/test/configuration identities before appending a receipt; stale history remains visible but cannot enable production.

Production release readiness is a separate gate. See [`wave-parallel-release-checklist.md`](./wave-parallel-release-checklist.md) for the independent architecture, security/red-team, database/queue, Git, SRE, QA and operator-UX reviews; PR-head check mapping; non-production canary/soak; rollback rehearsal; and explicit protected-production non-mutation attestation. A receipt cannot substitute for this packet or for the later separate operator activation.

Validate these contracts with:

```sh
npm run check:wave-invariants
npm run test:wave-qualification
```
