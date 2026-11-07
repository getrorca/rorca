# AGENTS.md — Express API Project

File governance and behavioral rules for an Express.js + TypeScript REST API with SQLite/PostgreSQL and JWT Auth.

## Project Architecture

```
src/
├── routes/                 # Express route handlers (one file per resource)
├── middleware/              # Auth, validation, error handling, rate limiting
├── lib/                    # Core services (db client, jwt, errors, logger)
├── db/
│   ├── index.ts            # Database connection and initialization
│   └── migrations/         # Numbered SQL migration files
├── types/                  # TypeScript type definitions
└── server.ts               # Express app setup and route mounting

tests/
├── routes/                 # Route handler tests
├── lib/                    # Service tests
└── helpers/                # Test utilities (fixtures, factories, setup)
```

## File Ownership Zones

### Routes (`src/routes/`)
- **Owner**: API designer
- **Rules**:
  - One file per resource: `users.ts`, `posts.ts`, `auth.ts`.
  - Routes are thin controllers — validate input, call service, return response.
  - No business logic in routes. Extract to `src/lib/` if it's more than 5 lines.
  - Every route gets JSDoc `@swagger` annotation for OpenAPI spec generation.
  - Throw typed errors (`ValidationError`, `NotFoundError`) — never manual `res.status().json()` for errors.

### Middleware (`src/middleware/`)
- **Owner**: Backend specialist
- **Rules**:
  - `auth.ts` — JWT verification, attaches `req.user`
  - `validate.ts` — Zod schema validation middleware factory
  - `error-handler.ts` — Central error handler, catches all thrown errors
  - `rate-limiter.ts` — IP/user-based rate limiting
  - Middleware ordering matters: cors → rate-limit → auth → routes → error-handler

### Lib (`src/lib/`)
- **Owner**: Architect
- **Rules**:
  - `db.ts` — Database client singleton. `better-sqlite3` for SQLite, `pg` for PostgreSQL.
  - `errors.ts` — Typed error hierarchy: `AppError` → `ValidationError`, `NotFoundError`, `AuthError`, `ConflictError`.
  - `jwt.ts` — Token generation and verification. Never import `jsonwebtoken` elsewhere.
  - `logger.ts` — Structured logging. Never use `console.log` in production code.

### Database (`src/db/`)
- **Owner**: Database specialist
- **Rules**:
  - `better-sqlite3` is **synchronous** — never `await` DB calls.
  - `.get()` returns `T | undefined`, `.all()` returns `T[]`, `.run()` returns `RunResult`.
  - Migrations in `migrations/` numbered sequentially: `001-create-users.sql`, `002-create-posts.sql`.
  - WAL mode enabled on connection for concurrent read performance.
  - Foreign key constraints enabled: `PRAGMA foreign_keys = ON`.
  - Parameterized queries only — never string interpolation in SQL.

### Tests (`tests/`)
- **Owner**: QA
- **Rules**:
  - Mirror source structure: `tests/routes/users.test.ts` tests `src/routes/users.ts`.
  - Use in-memory SQLite (`:memory:`) for test isolation.
  - Factory functions for test data creation — never raw SQL in tests.
  - `supertest` for HTTP-level route testing.

## Dev Commands

```bash
npm run dev          # tsx watch mode
npm run build        # TypeScript compilation
npm test             # Jest test suite
npm run lint         # ESLint
npx tsc --noEmit     # Type check
```

## Critical Gotchas

1. **better-sqlite3 is synchronous**: Never use `async/await` for database calls. `db.prepare(sql).get()` is synchronous.
2. **Error handler must be last middleware**: `app.use(errorHandler)` after all routes. Express only calls 4-arg middleware for errors.
3. **JWT secret rotation**: Store JWT secret in env var. If compromised, rotating invalidates all tokens — have a refresh token strategy.
4. **SQLite concurrency**: WAL mode allows concurrent reads but only one writer. For high-write workloads, consider PostgreSQL.
5. **Migration ordering**: Never modify a deployed migration. Create a new one instead.
