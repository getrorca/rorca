# Contributing

Thanks for taking the time to contribute. This guide covers everything you need
to get a change from your machine into a pull request.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For
security issues, **do not open a public issue** — follow [SECURITY.md](SECURITY.md).

## Local development setup

Prerequisites: Node.js 20+, Docker (for the bundled database), and Git.

```bash
git clone https://github.com/getrorca/rorca.git
cd rorca
npm install
cd backend && npm install && cd ..

npm run db:up     # PostgreSQL 16 + Apache AGE + pgvector, credentials generated
npm run dev       # dashboard on :5210, API on :3030
```

`npm run db:up` writes throwaway credentials to `.env.local` (mode 0600,
gitignored) on first run. Never commit that file. To use your own database
instead, set `RORCA_DB_MODE` and `DATABASE_URL` — see the README's database
section — and prove it with:

```bash
npm run verify:byop -- --url-file <file containing the URL>
```

Default local ports: dashboard `5210`, API `3030`, landing page `3002`.

## Checks to run before opening a PR

```bash
npx tsc --noEmit                 # frontend typecheck
cd backend && npx tsc --noEmit   # backend typecheck
npm run lint                     # eslint
npm run lint:tier                # swagger tier annotations
npx vitest run                   # frontend unit tests
cd backend && npm test           # backend Jest suite
npm run test:ci-contract         # repo contract guards (fast, no database)
npm run check:licenses           # SPDX headers on every source file
```

CI runs typechecks, lint, tier lint, frontend tests, and PR-critical backend
tests on every pull request. It needs no repository secrets, so pull requests
from forks run the same checks.

The backend Jest harness provisions its own nonce-scoped PostgreSQL 16 cluster
and needs the `pgvector` control file on the host. A fixed or shared database is
not used.

## Spec-first workflow

Non-trivial changes start as a spec, not a patch. A spec records the problem,
the stories with acceptance criteria, and the verification each story owes. The
canonical flow:

1. Draft the spec JSON and persist it through the API (`POST /api/specs/persist`)
   rather than hand-editing the database.
2. Review it; specs that touch the execution engine, the schema, or the public
   API contract need an adversarial pass before approval.
3. Approve, then let the pipeline execute stories.
4. Land the resulting change with the spec referenced in the PR body.

Small fixes — a typo, a broken link, a one-line bug with a test — do not need a
spec. Use your judgement, and say which path you took in the PR description.

## Submitting changes

1. Branch from `main` with a descriptive name (`fix/…`, `feat/…`, `docs/…`).
2. Keep commits conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
   `chore:`); the changelog is generated from them.
3. Add or update tests. A bug fix without a regression test will be asked for
   one before merge.
4. Fill in the pull request template — it includes the security checklist for
   annotated routes, MCP surfaces, and the sandbox boundary.
5. Make sure the checks above pass locally. Reviewers will run them again.

## Public API contract

Routes annotated `x-rorca-public-api: true` are the stable open-source CLI contract. Any change to that surface must keep the committed artifacts in sync:

- `docs/openapi-public-snapshot.json`
- `docs/OPEN_API_CONTRACT.md`

Update them with:

```bash
npm run build:contract
```

The contract check runs in PR CI and compares live OpenAPI output against the committed snapshot. Local commands load Swagger from the current checkout so another Rorca process on port 3030 cannot contaminate the result; set `RORCA_CONTRACT_BASE_URL` when explicitly validating a served document.

Breaking public API changes require all of the following:
1. Add an entry to `docs/contract-breaking-changes.md` with a fresh `<!-- contract-break: YYYY-MM-DD METHOD /path -->` marker.
2. Bump the root `package.json` major version.
3. Provide a migration path for downstream consumers in that document.

Additive public API changes still require an updated snapshot and a contract minor version bump. See CLI-054 for the enforcement details.

## Scope

This repository is the Community Edition. Managed OAuth, multi-tenant RBAC,
billing, and cloud runners live outside it — see the README's feature matrix
before proposing work in that direction. Contributions that add half-working
cloud paths will be redirected rather than merged.
