---
name: sqlite
description: SQLite with better-sqlite3 conventions — synchronous API, migrations, WAL mode
globs:
  - "src/db/**"
  - "src/lib/db.ts"
  - "**/*.sql"
alwaysApply: false
---

# SQLite (better-sqlite3) Conventions

## Connection Setup

```typescript
// src/lib/db.ts
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data.db');

const db = new Database(DB_PATH);

// Enable WAL mode for concurrent read performance
db.pragma('journal_mode = WAL');

// Enable foreign key constraints
db.pragma('foreign_keys = ON');

export { db };
```

## Synchronous API (Critical)

`better-sqlite3` is **synchronous**. Never use `async/await` with DB calls.

```typescript
// CORRECT — synchronous
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

// WRONG — unnecessary async
const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
```

### Return Types
| Method | Returns |
|--------|---------|
| `.get(params)` | `T \| undefined` |
| `.all(params)` | `T[]` |
| `.run(params)` | `{ changes: number, lastInsertRowid: number }` |

## Parameterized Queries (Always)

```typescript
// CORRECT — parameterized
db.prepare('SELECT * FROM users WHERE email = ?').get(email);
db.prepare('INSERT INTO users (name, email) VALUES (?, ?)').run(name, email);

// WRONG — string interpolation (SQL injection risk)
db.prepare(`SELECT * FROM users WHERE email = '${email}'`).get();
```

## Migration Pattern

### File Naming
```
src/db/migrations/
├── 001-create-users.sql
├── 002-create-posts.sql
├── 003-add-users-avatar.sql
```

### Migration Runner
```typescript
// src/db/migrate.ts
import fs from 'fs';
import path from 'path';

export function runMigrations(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM migrations').all().map((r: any) => r.name)
  );

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
  }
}
```

### Migration Rules
- Migrations are immutable — never edit a deployed migration.
- SQLite lacks `ALTER TABLE DROP COLUMN` (before 3.35.0) — create new table + migrate data if needed.
- `ADD COLUMN` works but doesn't support `IF NOT EXISTS` — guard with `PRAGMA table_info` check.
- Always include `IF NOT EXISTS` on `CREATE TABLE`.

## Schema Conventions

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

### Rules
- UUIDs (hex) or integer autoincrement for primary keys.
- `created_at` and `updated_at` on every table.
- Indexes on every FK and commonly queried column.
- `CHECK` constraints for enum-like fields.
- `NOT NULL` by default — nullable only when semantically optional.

## Transactions

```typescript
const insertUser = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
const insertProfile = db.prepare('INSERT INTO profiles (user_id, bio) VALUES (?, ?)');

const createUserWithProfile = db.transaction((name: string, email: string, bio: string) => {
  const result = insertUser.run(name, email);
  insertProfile.run(result.lastInsertRowid, bio);
  return result.lastInsertRowid;
});

const userId = createUserWithProfile('Alice', 'alice@example.com', 'Hello world');
```

Use `db.transaction()` for multi-statement operations. Automatically rolls back on error.

## Testing with In-Memory DB

```typescript
// tests/helpers/db.ts
import Database from 'better-sqlite3';

export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);  // Apply all migrations
  return db;
}
```

## PostgreSQL Migration Path
When SQLite hits limits (high concurrent writes, advanced queries), migration path:
1. Keep same migration files — translate SQLite-specific syntax
2. Replace `better-sqlite3` with `pg` pool
3. Change to async API: `.query()` returns Promise
4. Update datetime functions: `datetime('now')` → `NOW()`
5. Update random ID: `hex(randomblob(16))` → `gen_random_uuid()`
