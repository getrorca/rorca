# Alexis Multi-Path Install PR — Architecture, Replacement, and Commercialization Analysis

Date: 2026-06-19  
Branch reviewed: `origin/feat/multi-path-install`  
PR context: `feat/multi-path-install` / PR #3  
Reviewer intent: determine whether anything in the PR should replace current Rorca architecture, what should be adopted as net-new work, and how these ideas relate to OSS, paid, and enterprise strategy.

---

## Executive Summary

Alexis's PR is valuable, but it should not be treated as a core architecture replacement.

It is primarily an **open-source distribution, install, documentation, and ecosystem-adoption PR**. It is not an enterprise architecture PR and it does not actually implement the major architectural alternatives it discusses.

The correct posture is:

> **Adopt the useful distribution paths and documentation ideas. Do not replace Rorca's core architecture with PGlite, SQLite, Supabase, Hermes, or the PR's Docker/Helm paths as-is.**

Recommended decision:

- **Do not replace** Rorca's current PostgreSQL / pg-boss / AGE-centered architecture.
- **Do adopt** the PR's useful OSS onboarding ideas after corrections.
- **Do support Supabase/Neon/etc. as optional BYOP paths**, not defaults.
- **Do add Graph Lite** for hosted Postgres providers that lack Apache AGE.
- **Do use BYOP as a bridge into paid and enterprise tiers.**
- **Do spike PGlite later**, meaning run a short proof-of-viability experiment before committing to a real architecture shift.

---

## Current Rorca Architecture Baseline

Rorca currently centers on:

- React/Vite/Tailwind frontend
- Express/TypeScript backend
- PostgreSQL via `pg` Pool
- PostgreSQL migrations in `backend/src/db/pg-migrations/`
- pgvector for embeddings/vector search
- Apache AGE for graph/Cypher-backed graph features
- pg-boss for durable job queues
- separate backend and worker processes
- local/native Postgres bootstrap via Rorca's Postgres manager
- Docker and BYOP modes
- MCP, CLI, TUI, Pi extension, and dashboard as product surfaces

Rorca's current DB modes are conceptually:

| Mode | Meaning |
|---|---|
| `native` | Rorca downloads/starts local PostgreSQL |
| `docker` | Rorca uses Docker PostgreSQL |
| `byop` | User provides their own PostgreSQL connection string |

The current architecture is heavier than a simple SQLite app, but it preserves the features Rorca relies on: queues, vector search, graph behavior, migrations, worker orchestration, and production-like semantics.

---

## What the PR Actually Is

The PR is mostly:

- install/distribution docs
- multi-path setup story
- Supabase optional setup docs
- SQLite/PGlite migration analysis docs
- Hermes skill docs/examples
- MCP integration docs
- README/Quickstart rewrite
- Helm chart draft
- Docker/Supabase compose override draft
- a few useful CI/runtime fixes

It is **not**:

- a PGlite implementation
- a SQLite implementation
- a real graph replacement
- a pg-boss replacement
- a Supabase auth/RLS implementation
- a complete Helm production deployment
- an enterprise cloud architecture

Approximate PR composition from second-pass review:

| Category | Files | Insertions | Deletions |
|---|---:|---:|---:|
| docs/deploy | 18 | 1344 | 464 |
| code/tests | 41 | 269 | 10 |
| packaging | 4 | 271 | 0 |
| other | 2 | 17 | 1 |

This confirms the PR is mostly documentation and distribution, not deep architecture.

---

# Part 1 — Replacement Analysis

This section answers: should Rorca replace anything it currently has with something proposed or mentioned in the PR?

## 1. Replace Managed/Native PostgreSQL with PGlite?

### PR idea

The PR's SQLite migration analysis recommends PGlite as the preferred zero-dependency path instead of a full SQLite rewrite.

PGlite is PostgreSQL compiled to WebAssembly. The promise is an embedded Postgres-like runtime that could make `npm install -g rorca && rorca start` smoother.

### Potential benefits

- Better first-run install story
- Less dependence on native Postgres binaries
- Simpler local onboarding
- Single embedded database directory
- May preserve more SQL compatibility than SQLite

### Why not replace now

PGlite does not automatically solve Rorca's hard dependencies:

- Apache AGE is not available
- pg-boss behavior is unproven
- separate worker process behavior is unproven
- pgvector parity needs proof
- migrations need proof
- concurrent access semantics need proof
- performance needs proof
- production parity is weaker than real PostgreSQL

Rorca already has a managed local PostgreSQL strategy that supports a fuller feature set.

### Verdict

**Do not replace current managed/native PostgreSQL with PGlite now.**

PGlite is worth a future spike, not an immediate replacement.

### What “spike later” means

A spike is a short, time-boxed proof-of-viability experiment. It is not a full implementation.

For PGlite, a useful spike would be:

1. Create a short-lived branch/spec.
2. Add experimental `pglite` DB mode.
3. Run current migrations.
4. Test pg-boss/worker behavior.
5. Test pipeline runs.
6. Test vector retrieval.
7. Confirm graph fallback behavior.
8. Decide from evidence whether to proceed.

Suggested spike duration:

- 3–5 days for initial viability
- 1–2 weeks if testing worker/queue/migration behavior deeply

Only if that succeeds should Rorca consider a real PGlite implementation spec.

---

## 2. Replace PostgreSQL with SQLite?

### PR idea

The PR includes a SQLite migration analysis and correctly suggests SQLite is the expensive/nuclear path.

### Potential benefits

- One-file DB
- Simple local story
- No Postgres install
- Familiar embedded deployment model

### Why not replace now

A SQLite-first Rorca would require replacing or abstracting:

- PostgreSQL dialect
- `$1` placeholders vs `?`
- JSONB behavior
- arrays
- timestamps
- migrations
- pgvector
- Apache AGE
- pg-boss
- direct SQL route queries
- test harnesses
- worker/queue assumptions

The PR's estimate appears too optimistic for the current codebase. The doc referenced ~62 migrations and ~50 route files, but current Rorca has substantially more PG migration history and route/query surface.

### Verdict

**Do not replace PostgreSQL with SQLite.**

SQLite would be a major platform rewrite, not an onboarding improvement.

### Rough effort

- PR doc estimate: 7–13 weeks
- More realistic current estimate: 8–16+ weeks, possibly more if feature parity is required

---

## 3. Replace local/self-managed DB default with Supabase?

### PR idea

The PR proposes Supabase free tier as a zero-cost hosted PostgreSQL backend.

This is essentially:

> Use Supabase as BYOP — Bring Your Own Postgres.

A user creates their own Supabase project, copies its Postgres connection string, and runs Rorca with:

```bash
DATABASE_URL="postgresql://postgres.xxx:password@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
RORCA_DB_MODE=byop
rorca start
```

### What problem Supabase solves

Supabase solves database setup friction for OSS users.

A new user may not want to:

- install Postgres
- run Docker
- debug ports
- manage local DB state
- understand extensions immediately

Supabase gives them a hosted Postgres in a few minutes.

### What Supabase does not solve

Supabase does not replace:

- Rorca backend
- dashboard
- worker
- execution engine
- full graph capabilities
- enterprise cloud hosting

Supabase is just a hosted PostgreSQL database that the user owns.

### Free-tier reality

Supabase free tier can be useful because Rorca's core records are mostly text/JSON:

- specs
- stories
- run metadata
- memory entries
- retrieval telemetry
- settings

For light personal use, demos, and trials, this can fit in the free tier.

But caveats matter:

- 500 MB can fill up with logs/context traces/telemetry/embeddings
- free projects may pause after inactivity
- network dependency is introduced
- latency is higher than local DB
- connection pooling can affect workers/listeners/pg-boss
- Apache AGE is not available

### Verdict

**Do not make Supabase the default DB.**

**Do support Supabase as optional BYOP hosted Postgres.**

Supabase is useful for:

- OSS onboarding
- demos
- light personal use
- self-hosted users who do not want local DB setup
- early paid/prosumer bridge

It is not full parity with managed local PostgreSQL.

---

## 4. Replace Apache AGE graph with Supabase-compatible graph?

### Problem

Supabase does not support Apache AGE. Neon and most hosted Postgres providers also generally do not support arbitrary extensions like AGE.

So if users bring Supabase/Neon/RDS/Cloud SQL, Rorca cannot assume full AGE-backed graph behavior.

### Recommended approach

Do not block hosted Postgres support on AGE.

Instead, support three graph modes:

| DB capability | Product mode |
|---|---|
| AGE available | Full Graph |
| AGE missing but Postgres available | Graph Lite |
| Graph storage unavailable/broken | Graph Disabled |

### Full Graph

Used with Rorca-managed/local/docker Postgres where AGE is available.

Provides:

- AGE/Cypher-backed graph traversal
- richer graph analytics
- full graph evidence behavior

### Graph Lite

Used with Supabase/Neon/BYOP Postgres without AGE.

Implemented using ordinary Postgres tables and bounded traversal:

- normal relational edge tables
- recursive CTEs
- app-level traversal for bounded neighborhoods

Graph Lite should preserve useful product behavior:

- specs still work
- memories still work
- runs still work
- retrieval still works
- graph UI can show degraded but useful relationships
- context relevance graphs can use table-backed edges

Graph Lite should honestly label degraded behavior:

> “Graph Lite: this database does not support Apache AGE. Rorca is using table-backed graph traversal.”

### Verdict

**Do not replace AGE globally.**

Keep AGE for full local/native/docker mode and add Graph Lite for hosted BYOP providers.

---

## 5. Replace pg-boss worker queue?

### PR implication

SQLite/PGlite conversations imply possible queue replacement, but the PR does not actually implement one.

### Current Rorca

Rorca uses pg-boss and a separate worker process for durable jobs:

- pipeline runs
- retries
- spec post-save jobs
- async processing

### Verdict

**Do not replace pg-boss.**

pg-boss is tightly integrated and durable. Replacing it would be a major execution-engine reliability project.

If PGlite is ever considered, pg-boss compatibility should be a spike acceptance criterion.

---

## 6. Replace Pi/Rorca skills with Hermes skills?

### PR idea

The PR adds Hermes skill docs/examples and positions Hermes as a distribution channel.

### Benefit

This is one of the strongest ideas in the PR.

Hermes skills can be an external ecosystem distribution channel:

- no marketplace infra to build
- easier discovery
- complements MCP
- complements Pi extension
- useful OSS adoption path

### Risk

Do not let Hermes messaging obscure first-party Rorca surfaces:

- dashboard
- CLI
- TUI
- MCP
- Pi extension

Hermes should be another channel, not the core product identity.

### Verdict

**Do not replace Pi/Rorca skill surfaces with Hermes.**

**Do add Hermes skills as an additional distribution channel.**

---

## 7. Replace current Docker/Compose/Helm setup with PR artifacts?

### PR additions

- `install.sh`
- Docker one-liner docs
- `docker-compose.supabase.yml`
- Helm chart

### Second-pass validation found issues

#### Docker one-liner problem

The PR suggests running a single Rorca container and mapping `5210` and `3030`, but the production `Dockerfile` only exposes `3030` and serves static frontend through the backend.

Also, `install.sh` sets:

```bash
DATABASE_URL=postgres://rorca:rorca@localhost:5432/rorca
```

Inside a single container, `localhost:5432` means Postgres inside that same container. No Postgres container is started by the one-liner.

#### Supabase compose override problem

Compose validation reported:

```text
service "rorca" depends on undefined service "db": invalid compose project
```

So the override is not currently valid.

#### Helm chart problems

The Helm chart is incomplete for current Rorca architecture:

- no separate worker deployment
- frontend/backend ports mismatch actual image
- chart exposes `5210` but production image exposes only `3030`
- missing dependency lock/update story
- secrets are underdeveloped
- agent CLI availability is not addressed
- persistence/workspace semantics are not fully modeled

#### Installer problem

`install.sh` contains an `install_helm()` function and dispatch path, but the argument parser does not expose `--helm`.

### Verdict

**Do not replace current deployment setup with the PR artifacts as-is.**

Adopt the intent, but fix and validate each install path separately.

---

# Part 2 — Net-New Things Worth Adopting

These ideas are useful regardless of whether any architecture replacement happens.

## 1. CI/runtime fixes

Worth cherry-picking:

- duplicate migration timestamp fix
- Jest `DATABASE_URL` handling fix
- CI `DATABASE_URL_TEST`
- verify-pack fix
- shebang/license ordering fixes

These are practical and low-risk.

### Verdict

**Adopt.**

---

## 2. README and Quickstart overhaul

The PR's docs are more growth-oriented and easier for OSS users.

Benefits:

- better product hook
- clearer install paths
- clearer problem framing
- better ecosystem positioning
- better first impression

But they need truth alignment:

- PostgreSQL version should match actual support
- Docker ports must match image behavior
- Supabase should be documented as partial/full-minus-AGE, not full parity
- MCP should be described as tier-gated, not “full API surface” without qualification
- star/skill count claims should be verified

### Verdict

**Adopt after accuracy pass.**

---

## 3. MCP integration guide

The MCP docs are valuable for users of:

- Hermes
- Claude Code
- OpenClaw
- Cline
- Continue
- other MCP clients

Needed correction:

> Rorca exposes approved public/auth API operations as tier-gated MCP tools generated from annotated OpenAPI routes.

Avoid saying “full API surface” without qualification.

### Verdict

**Adopt after wording corrections.**

---

## 4. Hermes skill docs/examples

The Hermes skill docs are strategically useful.

They support:

- ecosystem reach
- MCP adoption
- external skills distribution
- no need to build a marketplace immediately

### Verdict

**Adopt as additive OSS distribution.**

---

## 5. Supabase setup docs

Useful as optional BYOP docs.

Should clearly state:

- user brings their own Supabase project
- user provides `DATABASE_URL`
- graph runs in lite mode because AGE is unavailable
- free tier is good for trials/light usage
- serious production needs different planning

### Verdict

**Adopt after correcting claims and validating config.**

---

## 6. Multi-path install strategy

The idea is strong:

- npm
- curl
- Docker
- Docker Compose
- Helm
- source

But each path must actually work.

### Verdict

**Adopt strategy. Do not merge current artifacts until fixed.**

---

# Part 3 — Supabase, Neon, BYOP, and Graph Strategy

## What BYOP Means

**BYOP = Bring Your Own Postgres.**

It means Rorca does not start or manage the database. The user provides a PostgreSQL connection string.

Example:

```bash
DATABASE_URL="postgresql://user:password@host:5432/database"
RORCA_DB_MODE=byop
rorca start
```

That Postgres could be:

- Supabase
- Neon
- AWS RDS
- Google Cloud SQL
- Azure Database for PostgreSQL
- local Postgres installed by the user
- company-managed Postgres

## Supabase's role

Supabase is not a replacement for Rorca. It is a convenient hosted Postgres option for BYOP.

Best for:

- trying Rorca without installing Postgres
- light personal use
- demos
- OSS onboarding
- small self-hosted usage

Not best for:

- full graph parity
- serious production on free tier
- local/offline operation
- enterprise control without additional governance

## Neon

Neon is a credible alternative to Supabase for hosted Postgres.

But Neon generally does not solve the AGE problem either.

So Neon should be treated like Supabase:

- good hosted Postgres
- likely useful BYOP option
- graph requires Graph Lite
- not full replacement for Rorca-managed Postgres with AGE

## Other providers

| Provider/type | Relational | Graph | Rorca fit |
|---|---:|---:|---|
| Supabase | Yes | No AGE | Good BYOP + Graph Lite |
| Neon | Yes | No AGE | Good BYOP + Graph Lite |
| RDS/Cloud SQL/Azure PG | Yes | Usually no AGE | Enterprise BYOP + Graph Lite |
| Self-hosted Postgres + AGE | Yes | Yes | Best full-feature path |
| Crunchy/CloudNativePG + AGE | Yes | Yes if installed | Strong self-hosted/enterprise path |
| Neo4j/Neptune/Memgraph | Limited relational | Yes | Not drop-in |
| ArangoDB/SurrealDB | Multi-model | Yes | Interesting, not drop-in |

## Recommended graph strategy

Do not chase a hosted provider just to get relational + graph in one.

Instead:

1. Keep full graph on Rorca-managed/self-hosted Postgres with AGE.
2. Support Supabase/Neon/RDS/etc. as BYOP Postgres.
3. Add Graph Lite using normal Postgres tables/recursive traversal.
4. Surface graph capability honestly in product UI/API.

Suggested graph mode enum:

```ts
type GraphMode = 'full' | 'lite' | 'disabled';
```

---

# Part 4 — OSS vs Enterprise Intent

Alexis's PR reads primarily as **open-source/self-hosted distribution work**, not enterprise architecture work.

## Why it looks OSS-focused

The PR optimizes for:

- `npm install -g rorca`
- `curl | sh`
- Docker one-liner
- Docker Compose
- Helm chart
- Supabase free tier
- MCP integration docs
- Hermes skills distribution
- README/Quickstart positioning

These are classic OSS onboarding improvements.

## Why it does not look enterprise-first

Enterprise/cloud architecture would emphasize:

- hosted control plane
- tenant isolation
- team/org auth
- RBAC
- audit policy
- SSO/SAML/OIDC
- billing/subscriptions
- backups/retention
- encrypted secrets management
- VPC/private networking
- managed worker scaling
- observability/SLA
- compliance posture

The PR does not meaningfully implement those.

## Helm caveat

Helm can be enterprise-relevant, but this chart currently feels like a self-hosting artifact, not an enterprise-grade deployment.

It needs worker, secrets, persistence, ingress, agent runtime, and operational hardening before becoming enterprise-relevant.

---

# Part 5 — BYOP as a Bridge to Paid and Enterprise

The Supabase/BYOP conversation is strategically important because it creates a natural ladder from OSS into paid and enterprise.

## Tier ladder

### 1. OSS Local

User runs everything locally:

- Rorca app
- local managed Postgres
- local worker
- local workspaces
- own agent subscriptions/API keys

Best for:

- solo developers
- OSS users
- local trials

### 2. OSS + BYOP

User still runs Rorca, but brings hosted Postgres:

- Supabase
- Neon
- RDS
- Cloud SQL
- company Postgres

Best for:

- users who do not want local DB setup
- small teams
- self-hosted users
- early prosumer usage

This is where Supabase free tier fits.

### 3. Paid Self-Hosted / Team

Rorca monetizes stronger team/self-hosted features around BYOP:

- team workspaces
- auth
- audit logs
- secrets management
- GitHub integrations
- managed worker orchestration
- backups/restore
- Graph Lite/Full Graph configuration
- RDS/Cloud SQL/Neon/Supabase support
- real Helm chart
- support/SLA

Best for:

- startups
- dev teams
- internal platform teams

### 4. Enterprise Cloud / Managed Rorca

Rorca hosts the control plane or provides enterprise deployment.

Possible models:

#### A. Rorca-managed database

Rorca owns DB/storage/ops.

#### B. Enterprise BYOP / private data plane

Customer brings infrastructure, DB, VPC, cloud account, or private Postgres. Rorca provides orchestration/control plane/support.

Best for:

- regulated companies
- security-conscious teams
- enterprise procurement

## Product packaging idea

| Tier | DB | Graph | Target |
|---|---|---|---|
| OSS Local | Managed local PG | Full if AGE available | Solo devs |
| OSS BYOP | Supabase/Neon/etc. | Graph Lite | Easy trial/self-host |
| Pro Team | Hosted/BYOP PG | Graph Lite or Full | Teams |
| Enterprise | Managed or private PG | Full/custom | Organizations |

## Strategic insight

Supabase/Neon/BYOP is not just a convenience path. It is the first step toward:

- paid teams
- cloud-hosted Rorca
- enterprise data ownership
- private infrastructure deployments
- BYO-cloud/BYO-database procurement stories

So the PR's Supabase idea is weak as a core architecture replacement, but strong as a monetization and onboarding bridge.

---

# Part 6 — Merge Recommendation

## Merge/cherry-pick immediately

- duplicate migration timestamp fix
- Jest DB mode fix
- CI `DATABASE_URL_TEST`
- verify-pack fix
- shebang/license fixes

## Merge after truth-alignment edits

- README rewrite
- QUICKSTART
- MCP integration guide
- Supabase setup guide
- Hermes skills docs/examples

## Do not merge as-is

- `install.sh`
- Docker one-liner docs
- `docker-compose.supabase.yml`
- Helm chart

## Spin out into separate RFC/spec/spike

- PGlite experimental mode
- SQLite backend analysis/implementation
- Graph Lite implementation
- Helm production deployment
- BYOP paid-tier/enterprise strategy

---

# Final Verdict

## Should Rorca replace anything with anything in Alexis's PR?

**No. Replace nothing now.**

| Current Rorca thing | PR alternative | Decision |
|---|---|---|
| Managed/native PostgreSQL | PGlite | Do not replace; spike later |
| PostgreSQL | SQLite | Do not replace |
| Local-first DB default | Supabase free tier | Do not replace; support as BYOP |
| Apache AGE full graph | Supabase-compatible Graph Lite | Do not replace; add fallback |
| pg-boss | SQLite/in-process queue ideas | Do not replace |
| Pi/Rorca skill surfaces | Hermes skills | Do not replace; add as channel |
| Current Docker/Compose setup | PR Docker/Helm artifacts | Do not replace as-is |

## What should Rorca adopt?

Adopt as additive work:

1. BYOP hosted Postgres docs/support for Supabase/Neon/etc.
2. Graph Lite mode for hosted providers without AGE.
3. Hermes skills as an external distribution channel.
4. Better README/Quickstart after accuracy pass.
5. CI/runtime fixes.
6. Eventually a PGlite spike.
7. A real paid/enterprise BYOP story.

## One-sentence decision

> **Alexis's PR is worth pursuing as OSS distribution and paid-tier bridge work, but not as a replacement for Rorca's current core architecture.**
