---
layer: L1
priority: 0
scope: global
---

# L1 — Engineering Principles

## Code Quality
- TypeScript strict mode (`strict: true`). No `any` without justification.
- Prefer `const` over `let`. Never `var`.
- Small functions that do one thing. If it needs a comment, split it.
- Early returns over nested conditionals.

## Error Handling
- Typed error classes with HTTP status codes — not raw `throw new Error()`.
- Central error handler middleware catches all errors. Routes throw, middleware catches.
- Validate at system boundaries (request handlers). Trust internal code after validation.
- Log errors with context (request ID, user ID, operation) — not just the message.

## Testing
- Test behavior, not implementation. Tests survive refactors.
- Every route: at least one happy-path test and one error-path test.
- Use in-memory SQLite for tests — fast, isolated, no cleanup needed.

## Git Discipline
- Atomic commits — one logical change per commit.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Branch per feature. Never commit to `main` directly.

## Security
- Never log secrets, tokens, or passwords.
- Parameterized queries only — no string interpolation in SQL.
- HTTPS in production. Rate-limit public endpoints.
- Validate and sanitize all user input at the route boundary.

## Performance
- Measure before optimizing.
- Database: index every FK and commonly queried column.
- Use connection pooling for PostgreSQL. SQLite: WAL mode for concurrent reads.
