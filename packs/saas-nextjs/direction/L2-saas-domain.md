---
layer: L2
priority: 0
scope: saas
---

# L2 — SaaS Domain Conventions

## Authentication
- Supabase Auth for all user authentication. No custom auth implementation.
- Auth middleware on every protected route — use `createServerClient()` from `@supabase/ssr`.
- Session tokens in HTTP-only cookies, never localStorage.
- Role-based access: `user`, `admin`. Enforce in middleware, not in UI.
- Social login (Google, GitHub) via Supabase OAuth providers.

## Billing & Subscriptions
- Stripe Checkout for payment collection. Never build a custom checkout form.
- Stripe webhooks for subscription lifecycle events — `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
- Webhook signature verification on every incoming Stripe event — reject unverified.
- Plans stored in Stripe Products/Prices, mirrored in local DB for fast reads.
- Free tier always available. Trial period optional but recommended (14 days).

## Multi-Tenancy
- Tenant isolation at the database level — every table has a `user_id` or `org_id` FK.
- Never expose raw database IDs in URLs. Use UUIDs or slugs.
- Tenant-scoped queries by default — add WHERE clause in middleware, not per-query.

## API Design
- REST for CRUD. Server Actions for mutations that benefit from co-location.
- API routes in `app/api/` — one file per resource.
- Response shape: `{ data, error, meta }`. Never return naked arrays.
- Pagination: cursor-based for feeds, offset-based for admin lists.
- Rate limiting: 60 req/min for authenticated, 20 req/min for unauthenticated.

## Email
- Transactional emails via Resend or Supabase built-in.
- Templates in code (React Email), not in a third-party dashboard.
- Required emails: welcome, password reset, subscription confirmation, payment failed.

## Feature Flags
- Environment-variable based for v1 (`NEXT_PUBLIC_ENABLE_X=true`).
- Never ship dead code behind a flag for more than 2 sprints. Clean up.
