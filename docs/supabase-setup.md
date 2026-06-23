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

---

## 1. Get your Supabase connection string

1. In the Supabase dashboard, open **Project Settings → Database**.
2. Copy the **Connection string** (URI form). It looks like:

   ```text
   postgresql://postgres:[YOUR-PASSWORD]@db.<project-ref>.supabase.co:5432/postgres?sslmode=require
   ```

3. Make sure SSL is enabled (`sslmode=require` is a good default). Do **not**
   use `sslmode=disable` — Rorca will reject it.

> Tip: Supabase also offers a pooled connection (port `6543`). The direct
> connection (port `5432`) is the most reliable choice for Rorca's migrations
> and extension checks.

## 2. Enable pgvector

pgvector is required for BYOP. In the Supabase **SQL Editor**:

```sql
create extension if not exists vector;
```

(Supabase also exposes pgvector under **Database → Extensions** as `vector`.)

## 3. Connect Rorca in BYOP mode

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
| `pgvector extension must be installed` | run `create extension if not exists vector;` in Supabase |
| `Could not connect…` | verify host, password, and that the project is not paused |
| Graph features missing | expected on Supabase — confirm `graphMode: "lite"` on `/api/health`; use Docker mode for Full Graph |

See also:

- [`README.md`](../README.md#database-modes--graph-capability) — all three database modes
- [`QUICKSTART.md`](../QUICKSTART.md) — chooser-oriented startup guide
- [`docs/mcp-integration.md`](mcp-integration.md) — Graph Lite + BYOP expectations for MCP/Hermes
