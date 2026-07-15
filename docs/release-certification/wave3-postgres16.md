# Wave 3 PostgreSQL 16 release certification

This runbook certifies the Always-On Context migration chain, canonical capture/distillation persistence, and custom-format backup/restore on PostgreSQL 16 with Apache AGE, pgvector, and pgcrypto.

## Safety boundary

The harness:

- refuses to run outside `/Users/dimitriteravanessian/rorca-wave3-postgres-cert` on `wave3/postgres-cert`;
- connects to the explicit local PostgreSQL 16 listener (default `127.0.0.1:5433`) through PostgreSQL 16 client tools;
- captures server port, data-directory hash, system-identifier hash, maintenance database, and protected `rorca` database OID before any mutation;
- refuses a non-16 server, ambiguous identity, unavailable required extension, or mutable database name without `rorca_wave3_cert_`;
- never starts a Rorca server, worker, daemon, or service;
- lets `boss.start()` own `pgboss.*` and uses only `createQueue`, `send`, `fetch`, and `complete` for queue work;
- traps exit/signals to drop all disposable databases and remove the custom-format archive;
- writes no connection string, password, raw data directory, or system identifier to evidence.

Do not override the host/port to a remote or production target. The script uses passwordless local peer authentication and an empty temporary pgpass file.

## Prerequisites

```bash
/usr/local/opt/postgresql@16/bin/psql --version
/usr/local/opt/postgresql@16/bin/pg_dump --version
/usr/local/opt/postgresql@16/bin/pg_restore --version
```

The default PATH may still resolve PostgreSQL 14 clients. Do not use those clients for PostgreSQL 16 backup/restore. The harness pins `/usr/local/opt/postgresql@16/bin` unless `PG16_BIN` is explicitly set.

The target PostgreSQL 16 server must advertise:

- `age`
- `vector`
- `pgcrypto`

## Run

```bash
cd /Users/dimitriteravanessian/rorca-wave3-postgres-cert
backend/scripts/wave3-postgres16-cert.sh .wave3-postgres-cert-evidence.log
```

The raw `.log` is intentionally gitignored. Preserve a reviewed, redacted summary under `docs/release-certification/` and update `.wave3-postgres-cert-progress.md`.

## Certification phases

1. **Identity and compatibility:** require PostgreSQL 16 server and clients, unambiguous server identity, protected database OID, and extension availability.
2. **Fresh install:** apply every canonical migration; require zero lite/extension skips; validate AGE graph/labels, pgvector dimensions, pgcrypto digest/UUID behavior, Always-On tables, constraints, and indexes. Confirm canonical migrations did not create `pgboss`.
3. **Brownfield:** clone the disposable fresh database before pg-boss exists, construct the divergent CCS/UCC state, preserve accepted historical error evidence and approved/conflict candidates, replay reconciliation migration `20260714150000`, and compare event/candidate checksums.
4. **Capture → distill:** start pg-boss in-process only, explicitly create `context:capture` and `context:distill`, synchronously pump one harmless metadata-only shell fixture and one explicit durable-memory fixture, and verify privacy/governance outcomes.
5. **Backup/restore:** create a PostgreSQL 16 custom-format archive, validate `pg_restore --list`, restore into a second disposable database, and compare critical schema, constraint, row, graph, extension, and queue snapshots.
6. **Atomic failure:** run a controlled migration-shaped transaction that creates a table and tracking record before raising; require both objects to be absent afterward.
7. **Backend checks:** run backend TypeScript typecheck and focused Jest tests with both `DATABASE_URL` and `DATABASE_URL_TEST` set to a unique `rorca_wave3_cert_*_test` database.
8. **Cleanup:** require zero named disposable databases and archive removal.

## Fresh-install AGE fix

The certification exposed a real fresh-install collision: the migration runner creates the application schema `rorca`, while AGE `create_graph('rorca')` also requires ownership of a schema with that name. Migration `050_knowledge_graph.sql` now bridges this transactionally:

1. rename the pre-AGE application schema;
2. let AGE create/register graph `rorca`;
3. relocate pgcrypto/pgvector extension objects to `public`;
4. move application tables, owned sequences, indexes, standalone sequences, and helper functions into the AGE-owned `rorca` schema;
5. refuse unsupported leftovers and drop the temporary schema.

Existing databases with graph `rorca` skip the bridge. A focused regression test locks this contract, while the certification harness proves the real PostgreSQL 16 path.

## Expected terminal result

```text
[result] PASS fresh_install=true brownfield=true capture_distill=true backup_restore=true atomic_failure=true
[cleanup] disposable_databases_remaining=0 archive_removed=true
[cleanup] result=0
```

Any other result is not a release certificate. Preserve only redacted output and investigate before rerunning.
