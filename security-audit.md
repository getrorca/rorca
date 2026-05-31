# Supabase Auth + RLS Security Audit

## Scope
- Audit target: complete Supabase Auth + RLS implementation for API, CSRF, token storage, WebSocket terminal auth, and related graph/session surfaces.
- Focus areas: IDOR, RLS bypass, JWT manipulation, CSRF, XSS token theft, rate-limit bypass, raw error leakage, session fixation, and terminal wsToken abuse.

## Summary
- Result: multiple HIGH findings confirmed in route enforcement and terminal token binding.
- Result: HIGH findings fixed in this patch.
- Result: no frontend auth token persistence found in `localStorage`; frontend Supabase client is configured for in-memory storage.
- Result: AGE search-path cleanup in graph modules was already correct.

## Findings

### Fixed HIGH
- `backend/src/routes/env-vars.ts`: used service-pool queries for workspace existence and CRUD on `workspace_env_vars`, bypassing per-user RLS. Fixed by moving route-bound reads/writes to `withUserClient()`.
- `backend/src/routes/budget.ts`: used service-pool queries for `workspaces` and `budget_config`, bypassing per-user RLS. Fixed by moving route-bound reads/writes to `withUserClient()`.
- `backend/src/routes/terminal.ts`: terminal session creation looked up workspace via service-pool query, allowing potential cross-user workspace attachment if route auth passed. Fixed by moving workspace lookup to `withUserClient()`.
- `backend/src/routes/terminal.ts` + `backend/src/server.ts`: `wsToken` was only bound to `sessionId`, not the creating user. Fixed by binding each token to `userId` and validating the bearer-backed user on WebSocket connect.
- `backend/src/server.ts`: in local fallback mode, an invalid bearer token could fall through to `LOCAL_ADMIN`. Fixed to return `401` on invalid provided tokens instead of silently downgrading into admin mode.
- `backend/src/lib/csrf.ts`: CSRF middleware returned `422`; acceptance requires `403`. Fixed by introducing `CsrfError` with `403` and using it for missing/mismatched CSRF proof.

### Confirmed Safe / Already Correct
- `src/lib/supabase.ts`: Supabase client disables token persistence; tokens are not stored in `localStorage`, `sessionStorage`, or cookies.
- `src/contexts/AuthContext.tsx`: auth state is hydrated from Supabase session APIs, not app-managed `localStorage` tokens.
- `src/lib/apiFetch.ts`: attaches bearer token from in-memory session and adds `X-CSRF-Token` on state-changing requests using `/api/auth/csrf-token` bootstrap.
- `backend/src/lib/knowledge-graph.ts`: restores `search_path` to `rorca, public` before releasing pooled connections.
- `backend/src/lib/graph-context.ts`: restores `search_path` correctly.
- `backend/src/lib/graph-drift-detector.ts`: restores `search_path` correctly.

### Medium / Follow-up
- Many non-audit routes still query `workspaces` through the service pool for path/config lookups. Some may be operationally safe, but they should be reviewed route-by-route and migrated to `withUserClient()` wherever user-owned resources are exposed.
- Several routes still use ad-hoc `try/catch` handlers. Most funnel through shared helpers, but a broader pass is still recommended to eliminate any raw `err.message` serialization outside `AppError` handling.

## Test Matrix

### IDOR via API
- Target: `GET /api/workspaces/:id` for another user's workspace.
- Expected: `403` or not-found semantics under RLS.
- Status: partially fixed at critical dependent routes (`env-vars`, `budget`, terminal session creation) by forcing per-request RLS clients.
- Note: `workspaces.ts` still contains mixed access patterns and should receive a broader follow-up pass for complete route-level assurance.

### RLS bypass attempts
- Target tables: `workspaces`, `workspace_env_vars`, `budget_config`, `vault_keys`.
- Expected: service-pool access must not be used for user-scoped route reads/writes.
- Status: fixed for `workspace_env_vars`, `budget_config`, and terminal workspace lookup.
- Status: `vault_keys` should remain under separate audit for all direct route access paths using decrypted provider keys.

### JWT manipulation
- Test: modified or forged bearer token should return `401`.
- Status: fixed in `backend/src/server.ts` local fallback branch; invalid supplied tokens no longer fall through to `LOCAL_ADMIN`.

### CSRF bypass
- Test: state-changing request without valid CSRF proof should return `403`.
- Status: fixed in `backend/src/lib/csrf.ts`.

### XSS token theft
- Test: inspect browser storage for auth tokens.
- Status: passed by code audit. No auth token storage in `localStorage` in frontend auth implementation.

### Rate-limit bypass
- Target: login-equivalent rapid bursts should return `429` with rate limiting active.
- Status: configuration reviewed; rate limiter is mounted globally after auth and before protected routes in `backend/src/server.ts`.
- Note: runtime validation not executed in this environment because backend dependencies are not installed locally.

### WebSocket IDOR
- Test: connect to `/ws/terminal?wsToken=...` from another user context.
- Expected: reject.
- Status: fixed by binding `wsToken` to creating `userId` and validating on WebSocket connection.

### Session fixation / token reuse after logout
- Expected: revoked Supabase token rejected by `supabaseAdmin.auth.getUser()`.
- Status: design relies on Supabase token validation. Runtime revocation scenario not executed in this environment.

### Sensitive error leakage
- Expected: no raw tokens, SQL, or stack traces in production error responses.
- Status: reviewed core error handler and patched auth fallback path to return stable `AUTH_ERROR` without echoing token contents.

## Validation Performed
- Static audit of auth middleware placement in `backend/src/server.ts`.
- Static audit of frontend token handling in `src/lib/supabase.ts`, `src/contexts/AuthContext.tsx`, `src/lib/apiFetch.ts`.
- Static audit of graph search-path cleanup in `backend/src/lib/knowledge-graph.ts`, `backend/src/lib/graph-context.ts`, `backend/src/lib/graph-drift-detector.ts`.
- Added regression tests in `backend/src/lib/__tests__/csrf.test.ts` and `backend/src/routes/__tests__/security-audit.test.ts`.

## Validation Blockers
- Local backend dependencies are not installed in this environment, so `jest`/`tsc` could not be executed successfully from `backend/`.
- Recommended follow-up once deps are installed:
  - `cd backend && npm test -- --runInBand src/lib/__tests__/csrf.test.ts src/routes/__tests__/security-audit.test.ts`
  - `cd backend && npx tsc --noEmit`

## Files Changed
- `backend/src/lib/errors.ts`
- `backend/src/lib/csrf.ts`
- `backend/src/server.ts`
- `backend/src/routes/env-vars.ts`
- `backend/src/routes/budget.ts`
- `backend/src/routes/terminal.ts`
- `backend/src/lib/__tests__/csrf.test.ts`
- `backend/src/routes/__tests__/security-audit.test.ts`

## Recommended Next Pass
- Migrate remaining user-facing `workspaces` route reads in `backend/src/routes/workspaces.ts` from service-pool access to `withUserClient()` where ownership/RLS should govern visibility.
- Add end-to-end multi-user Supabase integration tests for cross-user workspace access, vault access, and revoked-session behavior against a real local Supabase stack.
