# Backend test database safety

Backend Jest is destructive by design: per-test isolation truncates selected application tables. It must never share credentials or a database with a running Rorca instance.

## Enforced contract

Jest now fails closed unless all of these are true:

1. A test target is explicitly supplied through `RORCA_TEST_DATABASE_URL`, `DATABASE_URL_TEST`, or `~/.rorca/test-db.env`.
2. The URL database name ends in `_test`.
3. PostgreSQL reports the same database from `current_database()` after connecting.
4. The server-reported name also ends in `_test`.

Production `DATABASE_URL` is deliberately ignored when selecting the Jest target. The cleanup hook captures one immutable test URL at module load and does not follow later mutations to `process.env.DATABASE_URL`.

Jest does not create, drop, or recreate databases during global setup. Provision the test database before running the suite.

## Local least-privilege setup

Use a dedicated login that:

- owns only the test database;
- is `NOSUPERUSER`, `NOCREATEDB`, and `NOCREATEROLE`;
- cannot connect to the production `rorca` database;
- has no production object grants;
- may inherit test-only `authenticated`/`anon` roles when RLS suites need `SET ROLE`, while production database CONNECT remains denied.

Store its URL outside Git:

```sh
mkdir -p ~/.rorca
cat > ~/.rorca/test-db.env <<'EOF'
RORCA_TEST_DATABASE_URL=postgresql://<test-user>:<password>@127.0.0.1:5433/rorca_test
EOF
chmod 600 ~/.rorca/test-db.env
```

Because PostgreSQL grants `CONNECT` to `PUBLIC` by default, merely revoking `CONNECT` from the test role is not sufficient. A local administrator must revoke production `CONNECT` from `PUBLIC`, explicitly grant it to application/operator roles, and then verify the test role is denied:

```sql
REVOKE CONNECT ON DATABASE rorca FROM PUBLIC;
GRANT CONNECT ON DATABASE rorca TO rorca, <operator-role>;
```

Do not automate that production ACL change from Jest.

## CI and disposable Docker

CI should create `rorca_test` as the service's initial database and set `DATABASE_URL_TEST`. A disposable database service may use an owner login because it contains no production database or data.

```sh
DATABASE_URL_TEST=postgresql://rorca:rorca@localhost:5432/rorca_test \
  npm test -- --runInBand <test paths>
```

## Incident regression

The prior cleanup hook opened a direct connection from mutable `process.env.DATABASE_URL`. `db-strategy.test.ts` intentionally changed that variable to production-shaped URLs and did not restore it. On the next test, the global cleanup hook ran before the file-local `beforeEach`, inherited the previous value, and issued its core-table `TRUNCATE` against the wrong target. It also swallowed connection/query errors.

Regression coverage now proves that a sentinel in the test database is removed even after a test leaves mutable `DATABASE_URL` pointed elsewhere. The cleanup hook uses its immutable dedicated credential, verifies server truth immediately before truncation, and propagates any guard or cleanup failure.
