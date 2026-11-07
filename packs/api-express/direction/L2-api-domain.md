---
layer: L2
priority: 0
scope: api
---

# L2 — REST API Domain Conventions

## Route Design
- RESTful resource naming: `/api/users`, `/api/users/:id`, `/api/users/:id/posts`.
- Plural nouns for collections. No verbs in URLs — HTTP methods express the action.
- Consistent response shape: `{ data, error, meta }`. Never return naked arrays or primitives.

```typescript
// Success
res.json({ data: user, meta: { requestId } });

// Error
res.status(400).json({ error: 'Validation failed', details: errors });

// List
res.json({ data: users, meta: { total, page, pageSize } });
```

## HTTP Methods
| Method | Usage | Idempotent |
|--------|-------|------------|
| GET | Read resource(s) | Yes |
| POST | Create resource | No |
| PUT | Full replace | Yes |
| PATCH | Partial update | Yes |
| DELETE | Remove resource | Yes |

## Status Codes
| Code | When |
|------|------|
| 200 | Success (GET, PUT, PATCH) |
| 201 | Created (POST) |
| 204 | No Content (DELETE) |
| 400 | Bad request / validation error |
| 401 | Unauthenticated |
| 403 | Forbidden (authenticated but not authorized) |
| 404 | Resource not found |
| 409 | Conflict (duplicate, concurrent modification) |
| 422 | Unprocessable entity (valid syntax, invalid semantics) |
| 429 | Rate limited |
| 500 | Internal server error (never intentionally returned) |

## Pagination
- Offset-based for admin/backoffice: `?page=1&pageSize=20`.
- Cursor-based for feeds and large datasets: `?cursor=abc&limit=20`.
- Always return `total` count in meta for offset pagination.

## Versioning
- URL prefix: `/api/v1/users`. Increment major version for breaking changes only.
- No versioning in v1 — add when needed, not preemptively.

## Authentication
- JWT Bearer tokens in `Authorization` header: `Authorization: Bearer <token>`.
- Short-lived access tokens (15 min) + long-lived refresh tokens (7 days).
- Refresh tokens stored hashed in DB — revocable on logout.
- Auth middleware extracts user from token, attaches to `req.user`.

## Rate Limiting
- IP-based for public endpoints: 20 req/min.
- User-based for authenticated endpoints: 60 req/min.
- Return `429` with `Retry-After` header.

## Input Validation
- Zod schemas at the route boundary. Validate body, params, and query.
- Reject invalid input immediately — don't let it reach business logic.
- Return field-level errors: `{ error: 'Validation failed', details: { email: 'Invalid format' } }`.

## CORS
- Explicit origin allowlist in production. Never `origin: '*'` with credentials.
- Preflight cache: `Access-Control-Max-Age: 86400`.
