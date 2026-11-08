# Supabase setup (BYOP)

This guide connects Rorca to a **Supabase** Postgres database using Rorca's
**BYOP** (Bring Your Own Postgres) mode. The same steps apply to other hosted
Postgres providers such as **Neon** and **Railway**, and to self-hosted
Postgres.

> **Supabase is a BYOP path, not a full-graph replacement.** Rorca's Full Graph
> features depend on the **Apache AGE** extension, which Supabase does not
> provide by default. On Supabase you should expect **Graph Lite** (see
> [Graph Lite on Supabase](#graph-lite-on-supabase) below). If you need Full
> Graph, use the Docker Postgres path described in
> [`README.md`](../README.md#database-modes--graph-capability) instead.

---

## What Rorca requires from a BYOP database

When you save a BYOP `DATABASE_URL`, Rorca validates it before accepting it:

- a reachable PostgreSQL connection over **SSL/TLS** — `sslmode=disable` is
  rejected
- a valid **hostname** and **database name** in the URL
- the **pgvector** extension installed (required for embedding-backed retrieval)

Apache AGE is **optional**. If it is not present, Rorca stays in Graph Lite
rather than failing.

> **pgvector is verified in every database mode.** Rorca checks for pgvector on
> all three paths before declaring a setup ready:
>
> - **Native/local Postgres** — startup verifies pgvector is installable on the
>   bundled Postgres before reporting success; if it is missing you are told to
>   reinstall with `rorca start` or run `CREATE EXTENSION IF NOT EXISTS vector;`.
> - **Docker Postgres** — `rorca db start` confirms pgvector bootstrapped in the
>   AGE image before the Docker path is marked ready.
> - **BYOP (Supabase/Neon/Railway/self-hosted)** — saving a `DATABASE_URL` is
>   rejected if pgvector is absent, with a provider-named fix path.
>
> In each case the rejection names the exact `CREATE EXTENSION IF NOT EXISTS
> vector;` command and never echoes your credentials — connection details are
> always shown redacted.

---

## 1. Get your Supabase connection string

1. In the Supabase dashboard, open the **Connect** dialog for the project.
2. Choose the connection mode that matches your network and plan **before**
   copying anything:

   | Your situation | Use | Host:port |
   | --- | --- | --- |
   | Free plan, ordinary home/office network | **Shared pooler, session mode** | `aws-<n>-<region>.pooler.supabase.com:5432` |
   | Pro + IPv4 add-on, or an IPv6-capable network | Direct connection | `db.<project-ref>.supabase.co:5432` |
   | Serverless/edge functions | *not supported for Rorca* | transaction mode (`:6543`) breaks migrations |

   **Free-plan direct connections are IPv6-only.** Most networks are IPv4, so a
   free-plan user who copies the "direct connection" string will get a
   connection timeout. The shared pooler in **session mode** is IPv4 on every
   plan and supports prepared statements and persistent sessions, which is what
   Rorca's migrations need.
3. Keep `sslmode=require` in the URL. Rorca only enables TLS when the URL says
   `sslmode=require` (or `PGSSLMODE=require` is set), and it rejects
   `sslmode=disable` outright.
4. Note the username differs by mode: `postgres` for direct, and
   `postgres.<project-ref>` for the shared pooler. Copy the string verbatim from
   the dashboard rather than editing a direct string by hand.

> Do **not** use transaction mode (port `6543`). It does not support prepared
> statements or session state, so Rorca's migrations and pg-boss either fail or
> silently misbehave.

### Pooler (Supavisor) connections

Supabase's pooler identifies the tenant from the username, so a pooler URL must
carry the tenant suffix on whichever role connects: `rorca_runtime.<project-ref>`
for the app, not `postgres.<project-ref>` and not a bare `rorca_runtime`. Rorca
rejects a runtime connection whose database user is not the registered
`internal_runtime` principal, so the bare form fails with
`DATABASE_URL must connect as the registered Wave 2 internal_runtime principal`,
while a missing suffix makes the pooler answer `Tenant or user not found`.

A working split for a pooled deployment:

- `rorca bootstrap-byop-principals.mjs --url <direct-url>` — role creation needs
  `CREATE ROLE` and cannot run through the pooler.
- Apply migrations against the direct connection (`RORCA_MIGRATION_DATABASE_URL`).
- Point `DATABASE_URL` at the pooler with the suffixed runtime role.

`RORCA_POOLER_TENANT_SUFFIX=.` + `<ref>` covers self-hosted poolers whose
hostname does not identify them. Unlike PgBouncer, Supavisor accepts Rorca's
`statement_timeout` startup parameter, so transaction mode works for the
application (migrations still belong on the direct/session connection).

## 2. Enable pgvector

pgvector is required for BYOP. In the Supabase **SQL Editor**:

```sql
create extension if not exists vector;
```

(Supabase also exposes pgvector under **Database → Extensions** as `vector`.)

## 3. Provision the split-principal roles (required, one time)

Rorca does not run as the database owner. Its migrations require three distinct
non-privileged LOGIN roles plus the `authenticated`/`anon` compatibility roles.
The bundled Docker image provisions these automatically
(`docker/postgres/bootstrap-roles.sh`); a hosted database never runs that
entrypoint, so a fresh Supabase project fails its first start with:

```text
requires a distinct existing non-privileged RORCA_RUNTIME_DATABASE_USER
```

Run the bootstrap once against your connection string:

```bash
node scripts/bootstrap-byop-principals.mjs --url "postgres://…?sslmode=require"
```

It creates `rorca_migrator`, `rorca_runtime`, `rorca_canonical_writer` with
random passwords, reserves the `pgboss` schema for the runtime role, and writes
two private files (mode `0600`, outside the repository):

| File | Purpose | Holds migration credential? |
| --- | --- | --- |
| `~/.rorca/byop-principals.env` | runtime profile for the API/worker | **no** |
| `~/.rorca/byop-migrate.env` | one-shot migration profile | yes |

The connection user needs `CREATE ROLE`: on Supabase connect as the `postgres`
role. Nothing is written into the repository, and no credential is printed.

## 4. Apply migrations once

Exactly like the Docker `db-migrate` service — the migration-owner credential
reaches only this one-shot process:

```bash
set -a; . ~/.rorca/byop-migrate.env; set +a
(cd backend && npx tsx src/db/pg-index.ts && npx tsx src/db/pg-boss-install.ts)
```

Expect `Applied: N, Skipped: 1, Total: …` followed by
`Graph Lite active: rorca_v2 bootstrap extension-not-installed`. That line is
the expected outcome on Supabase, not an error.

## 5. Start Rorca

```bash
set -a; . ~/.rorca/byop-principals.env; set +a
RORCA_DB_MODE=byop npm run dev:server
```

`~/.rorca/byop-principals.env` already sets `RORCA_PGBOSS_PREAPPLIED=true` and
`RORCA_MIGRATIONS_PREAPPLIED=true`: the runtime process must never attempt
migrations or receive the migration credential.

## 6. Connect Rorca in BYOP mode

In the Rorca onboarding wizard or in **Settings → Knowledge Graph**:

1. Choose **Bring your own Postgres**.
2. Paste the full connection string into the secure `DATABASE_URL` field.
3. Save / validate. Rorca will:
   - connect over SSL,
   - confirm pgvector is present,
   - detect the provider (e.g. `supabase`),
   - store the URL outside your repo at `~/.rorca/database-url` (`chmod 600`),
   - and afterward show only redacted host/database details.

Your mode choice persists across sessions. You can confirm it any time:

```bash
curl -s http://localhost:3030/api/health | jq '{dbMode, graphMode, provider: .databaseCapability.provider}'
```

You should see `dbMode: "byop"` and `provider: "supabase"`.

---

## Graph Lite on Supabase

Because Supabase does not ship Apache AGE, a fresh Supabase connection runs in
**Graph Lite**:

- Knowledge, relevance, and memory workflows still work, using relational +
  semantic (pgvector) evidence instead of AGE graph traversal.
- AGE-only graph-traversal and graph-admin/visualisation operations are
  unavailable until AGE is enabled. This is expected behavior, **not** an error.

The Knowledge Graph and Health views display the active mode and what is missing
rather than implying AGE is present.

### How to get Full Graph

You have two options:

1. **Use Docker mode (recommended for Full Graph).** Switch to the bundled
   Docker Postgres path, which builds Apache AGE in:

   ```bash
   rorca db start
   ```

   See [`README.md`](../README.md#database-modes--graph-capability).

2. **Install Apache AGE on your hosted Postgres** (only if your provider allows
   custom C extensions — Supabase's managed plans generally do **not**), then
   reconnect. Most BYOP users stay on Graph Lite or move to Docker mode for Full
   Graph.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `DATABASE_URL must not disable SSL/TLS` | remove `sslmode=disable`; use `sslmode=require` |
| `pgvector is not installed on …` | run `create extension if not exists vector;` in Supabase (or enable the `vector` extension), then reconnect |
| `Could not connect…` | verify host, password, and that the project is not paused |
| Graph features missing | expected on Supabase — confirm `graphMode: "lite"` on `/api/health`; use Docker mode for Full Graph |

See also:

- [`README.md`](../README.md#database-modes--graph-capability) — all three database modes
- [`QUICKSTART.md`](../QUICKSTART.md) — chooser-oriented startup guide
- [`docs/mcp-integration.md`](mcp-integration.md) — Graph Lite + BYOP expectations for MCP/Hermes
