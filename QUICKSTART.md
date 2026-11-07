# Rorca Quickstart

This is the fastest honest path to a running Rorca. It is organized as a
**chooser**: pick the database path that matches how you want to run Postgres,
then start the app.

Rorca always runs on **PostgreSQL 16**. There is **no** SQLite or PGlite
fallback — every path below is real Postgres. What differs is where that
Postgres lives and whether **Apache AGE** (the graph extension) is available,
which decides whether you get **Full Graph** or **Graph Lite**.

---

## 0. Install

```bash
git clone https://github.com/getrorca/rorca.git
cd rorca
npm install
cd backend && npm install && cd ..
```

You also need:

- Node.js **20+**
- Git
- one execution path (Claude Code CLI, OpenCode, Codex, or Pi)

---

## 1. Choose your database path

| If you want… | Use this path | Graph capability |
|---|---|---|
| The smoothest path to graph features | **Docker Postgres with AGE** | **Full Graph** |
| The lightest setup with Postgres you already run | **Native / local Postgres** | **Graph Lite** (Full Graph only if you install AGE) |
| To reuse a hosted database (Supabase, Neon, …) | **BYOP hosted Postgres** | **Graph Lite** (Full Graph only if that instance has AGE) |

You can change this later in the onboarding wizard or
**Settings → Knowledge Graph**. Rorca persists your choice across sessions and
reports the active `dbMode`/`graphMode` on `GET /api/health`.

---

### Path A — Docker Postgres with AGE (recommended)

The bundled `docker-compose.yml` builds a PostgreSQL 16 image with Apache AGE
compiled in, so this is the only path that gives **Full Graph** with no manual
extension work.

```bash
rorca db start        # provision/start managed Docker Postgres (AGE included)
rorca db status       # verify it is healthy
npm run dev           # start frontend + backend against it
```

Requires a running Docker runtime (Docker Desktop or equivalent).

### Path B — Native / local Postgres

Use a Postgres 16 instance you run yourself. Lightest setup, but it starts in
**Graph Lite** because AGE is not installed by default.

```bash
# Point DATABASE_URL at your local Postgres (default native port: 5433)
export DATABASE_URL="postgres://rorca:rorca@localhost:5433/rorca"
npm run dev
```

To unlock Full Graph on this path, install Apache AGE on that Postgres instance
and reconnect. `rorca init --skip-docker` can set up a managed native instance
without Docker.

### Path C — BYOP hosted Postgres (Supabase, Neon, Railway, self-hosted)

Bring your own database. In the onboarding wizard or
**Settings → Knowledge Graph**, choose **Bring your own Postgres** and paste a
full connection string. Rorca validates it before saving and stores it outside
your repo (`~/.rorca/database-url`, `chmod 600`), surfacing only redacted
host/database details afterward.

BYOP validation requires:

- a reachable connection over **SSL/TLS** (`sslmode=disable` is rejected)
- a valid hostname and database name
- the **pgvector** extension installed

```text
postgresql://USER:PASSWORD@HOST:5432/DBNAME?sslmode=require
```

BYOP is a *bring-your-own-database* path, **not** a full-graph replacement for
the AGE-backed Docker/native setups. Hosted Postgres typically runs in **Graph
Lite** unless that instance already has AGE. See
[`docs/supabase-setup.md`](docs/supabase-setup.md) for a Supabase walkthrough.

---

## 2. Run the app

```bash
npm run dev
```

`npm run dev` is the smart default:

- if no backend is running, it starts the local dev stack
- if a healthy backend is already on `:3030`, it starts the frontend only

Default local services:

- frontend UI: `http://localhost:5210`
- backend API: `http://localhost:3030`
- landing page: `http://localhost:3002`

Need the worker (spec execution, queued pipeline jobs)? Run the full stack:

```bash
npm run dev:full      # frontend + backend + worker
```

---

## 3. Confirm your database & graph mode

```bash
curl -s http://localhost:3030/api/health | jq '{dbMode, graphMode, graphWarnings}'
```

- `graphMode: "full"` → AGE is active, Full Graph is on.
- `graphMode: "lite"` → Graph Lite. Knowledge/relevance/memory still work via
  relational + pgvector evidence; AGE-only graph traversal is unavailable.
- `graphMode: "disabled"` → the database is unreachable.

**Get Full Graph back from Graph Lite:** switch to Docker mode
(`rorca db start`), or install Apache AGE on your native/BYOP Postgres and
reconnect.

---

## 4. Next steps

1. Register a workspace (point Rorca at a local git repo).
2. Add context via the Direction Stack.
3. Create a spec — **Spec Forge** in the UI, `rorca forge <brief...>` on the
   CLI, `/rorca-create-spec` in Pi, or `rorca_create_spec` over MCP.
4. Review, approve, and run it story-by-story.

See [`README.md`](README.md) for the full mental model and
[`docs/mcp-integration.md`](docs/mcp-integration.md) for MCP/Hermes usage.
