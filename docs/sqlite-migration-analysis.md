# SQLite Migration Path

This documents what would need to change to support SQLite as a first-class database backend for Rorca, enabling zero-dependency `rorca start` with no PostgreSQL requirement.

## Current State

Rorca uses PostgreSQL 18 with:
- **`pg`** Node.js driver (async pool, `$1/$2` placeholders)
- **pgvector** extension for embedding similarity search
- **Apache AGE** extension for graph queries (Cypher)
- **pg-boss** for job queues
- **62 SQL migration files** in `backend/src/db/pg-migrations/`
- **~50 route files** that query PostgreSQL directly

## What Would Need to Change

### Phase 1 — Core (Minimum Viable SQLite)

**Effort: 3-5 weeks for one developer**

| Component | Change Required | Effort |
|-----------|----------------|---------|
| **DB driver** | Abstract `query()`/`queryOne()`/`execute()` behind a DB interface. Implement SQLite adapter using `better-sqlite3` | 3-5 days |
| **Placeholders** | Replace `$1, $2` → `?` for SQLite (or normalize in adapter) | 1 day |
| **Migrations** | Rewrite 62 SQL migrations for SQLite dialect. Most are standard DDL — straightforward. JSONB columns → TEXT with JSON functions. Array types → TEXT with JSON arrays. | 3-5 days |
| **Schema differences** | `SERIAL` → `INTEGER PRIMARY KEY AUTOINCREMENT`, `TIMESTAMP` → `TEXT` (ISO 8601), `BOOLEAN` → `INTEGER` (0/1), `JSONB` → `TEXT` | 2-3 days |
| **Query dialect** | `ILIKE` → `LIKE` (case-insensitive by default in SQLite), `NOW()` → `datetime('now')`, `array_agg()` → `json_group_array()` | 2-3 days |
| **Testing** | Run full test suite against SQLite. Fix incompatibilities. | 3-5 days |

### Phase 2 — Embeddings (Replace pgvector)

**Effort: 1-2 weeks**

| Component | Change Required | Effort |
|-----------|----------------|---------|
| **Vector search** | Replace `pgvector` `<->` operator. Options: `sqlite-vec` (SQLite-native), ChromaDB (embedded), or brute-force in-memory cosine similarity | 2-3 days |
| **Embedding pipeline** | Refactor `embedding-pipeline.ts` to use the new vector backend | 2-3 days |
| **Migration** | pgvector columns (`vector(1536)`) → BLOB in SQLite | 1 day |

### Phase 3 — Graph (Replace Apache AGE)

**Effort: 2-4 weeks**

| Component | Change Required | Effort |
|-----------|----------------|---------|
| **Graph queries** | Replace Cypher queries. Options: SQLite recursive CTEs (for traversal), in-memory graph (for small datasets), or an embedded graph DB like DuckDB with graph extension | 1-2 weeks |
| **Graph populator** | Refactor `graph-populator.ts` | 3-5 days |
| **Graph context cache** | Refactor `graph-context.ts` | 2-3 days |
| **Lite mode** | Already partially supported — some routes return 503 when AGE is missing. Expand this to work with SQLite | 1-2 days |

### Phase 4 — Job Queue (Replace pg-boss)

**Effort: 1-2 weeks**

| Component | Change Required | Effort |
|-----------|----------------|---------|
| **Job queue** | Replace `pg-boss` with an in-process queue or SQLite-backed queue. Options: `bull` (Redis-backed, adds Redis dependency), `better-queue` (SQLite-backed), or a simple in-memory queue for single-user mode | 3-5 days |
| **Worker** | Refactor worker to consume from new queue | 2-3 days |
| **Spec post-save jobs** | Refactor `spec-post-save.ts` job scheduling | 2-3 days |

## Total Estimated Effort

| Phase | Timeline | Cumulative |
|-------|----------|------------|
| Core SQLite adapter | 3-5 weeks | **Working single-user Rorca** |
| Embeddings | 1-2 weeks | Feature-complete except graph |
| Graph | 2-4 weeks | Full feature parity |
| Job queue | 1-2 weeks | Multi-user ready |

**Total: 7-13 weeks for one developer.** Approximately 2-3 months of focused work.

## Recommended Approach: pglite (WASM PostgreSQL)

Instead of rewriting for SQLite, consider **[pglite](https://github.com/electric-sql/pglite)** — a full PostgreSQL compiled to WebAssembly that runs in-process with zero dependencies.

**Benefits:**
- **No code changes** — it IS PostgreSQL, just embedded
- **Supports pgvector** via extension
- **Supports most pg features** — `pg` driver connects to it via TCP or Unix socket
- **One-command install** — `npm install @electric-sql/pglite`
- **Single file** — the database is a single directory on disk

**What changes:**
```typescript
// Current: requires external PostgreSQL
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// With pglite: auto-start embedded PG on first run
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite('./.rorca/data');
// Use the same 'pg' driver pointed at PGlite's port
```

**Limitations:**
- **No Apache AGE** — graph features still need external PG or the graph refactor
- **Performance** — WASM PostgreSQL is slower than native (fine for single-user)
- **pg-boss** — may work, untested with pglite

**Estimated effort with pglite: 1-2 weeks** (vs 7-13 weeks for SQLite rewrite).

## Recommendation

1. **Short-term:** Ship pglite as the "zero-dependency" option. `rorca start` auto-starts an embedded PostgreSQL. External PostgreSQL remains for production.
2. **Medium-term:** Abstract the graph layer to work without AGE (Lite mode improvements).
3. **Long-term:** If embedded performance becomes a bottleneck, invest in the SQLite migration.

The `npm install -g rorca && rorca start` experience requires pglite or equivalent. SQLite migration is the nuclear option — powerful but expensive.
