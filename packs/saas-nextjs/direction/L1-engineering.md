---
layer: L1
priority: 0
scope: global
---

# L1 — Engineering Principles

## Code Quality
- TypeScript strict mode (`strict: true` in tsconfig). No `any` without a comment explaining why.
- Prefer `const` over `let`. Never use `var`.
- Functions should do one thing. If a function needs a comment explaining what it does, it's too complex — split it.
- Early returns over nested conditionals. Guard clauses at the top.

## Error Handling
- Never swallow errors silently. At minimum, log them.
- Use typed error classes — not raw `throw new Error("something broke")`.
- Distinguish user-facing errors (show to user) from internal errors (log + generic message).
- Validate at system boundaries (API routes, form submissions). Trust internal code after validation.

## Testing
- Test behavior, not implementation. Tests should survive refactors.
- Every API route gets at least one happy-path test and one error-path test.
- Mock external services (Stripe, Supabase) — never call real APIs in tests.

## Git Discipline
- Atomic commits — one logical change per commit.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Branch per feature. Never commit directly to `main`.

## Security
- Never log secrets, tokens, or PII.
- Sanitize all user input before database queries (Prisma handles this, but verify raw queries).
- HTTPS everywhere. No HTTP in production.
- Rate-limit public endpoints. Auth-gate everything else.

## Performance
- Measure before optimizing. Premature optimization is the root of all evil.
- Lazy load below-the-fold content.
- Database queries: always check for N+1. Use `include` / `select` in Prisma.
