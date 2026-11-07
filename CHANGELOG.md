# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

From the next tagged release onward, entries are generated from conventional
commits with `npm run changelog`. This first entry is hand-written because the
project history predates the public repository.

## [10.0.0] — 2026-11-05

First public release (Community Edition).

### Added

- **Spec orchestration** — author, review, approve, version, and execute specs
  against a registered workspace. Specs are JSON documents in
  `forge/specs/{pending,approved}/` with story-level acceptance criteria.
- **Direction Stack** — five-layer context synthesis (L1–L5) combining workspace
  conventions, retrieved evidence, schema snapshots, the spec brief, and
  per-story annotations into one execution prompt.
- **Execution engine** — per-story process spawning for `claude`, `opencode`,
  `codex`, `omp`, and `pi`, with selective retry, timeouts, story result
  recording, and WAL event emission.
- **Graph RAG** — PostgreSQL 16 with Apache AGE for graph traversal, with an
  honest Graph Lite fallback (relational + pgvector evidence) when AGE is absent.
  The bundled Docker image ships AGE 1.5.0 and pgvector 0.8.7 preinstalled.
- **Context Inspector** — append-only `.ndjson.gz` run traces under
  `.rorca/traces/`, addressed by deterministic `rawRef` identifiers, with
  configurable retention.
- **Three database modes** — `native` (your own PostgreSQL), `docker` (bundled
  container), and `byop` (hosted Postgres such as Supabase, Neon, or RDS),
  verified end to end by `npm run verify:byop`.
- **One-command local stack** — `npm run db:up` generates throwaway credentials
  into a gitignored `.env.local`, starts PostgreSQL with AGE and pgvector, and
  waits for readiness. `npm run db:migrate`, `db:logs`, and `db:down` complete
  the lifecycle.
- **MCP surface** — stdio and loopback HTTP transports with tiered exposure
  (`public`, `auth`, `paid`, `admin`) declared per route.
- **GitHub integration** — personal access token flows plus GitHub App
  installation, with signed webhook delivery and review delivery.
- **Community scaffolding** — Apache-2.0 licence, `NOTICE`, security policy,
  contribution guide, code of conduct, issue and pull-request templates, and a
  fork-safe CI workflow that needs no repository secrets.

### Security

- Split-principal database roles: migrations, runtime traffic, and canonical
  writes each use a distinct least-privilege role.
- No default credentials anywhere; local secrets are generated per install.
- Hosted concerns (managed OAuth, multi-tenant RBAC, billing, cloud runners) are
  not stubbed in this tree — they are out of scope for the Community Edition.
