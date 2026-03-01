# AGENTS.md — SaaS Next.js Project

File governance and behavioral rules for a Next.js 14 SaaS application with Tailwind, Prisma, Stripe, and Supabase Auth.

## Project Architecture

```
src/
├── app/                    # Next.js App Router
│   ├── (auth)/             # Auth pages (login, register, forgot-password)
│   ├── (dashboard)/        # Protected dashboard pages
│   ├── (marketing)/        # Public marketing pages
│   ├── api/                # API routes
│   └── layout.tsx          # Root layout with providers
├── components/
│   ├── ui/                 # Primitive UI components (Button, Input, Card, etc.)
│   ├── forms/              # Form components with validation
│   └── layouts/            # Layout components (Sidebar, Header, Footer)
├── lib/
│   ├── supabase/           # Supabase client setup (server + browser)
│   ├── stripe/             # Stripe helpers (checkout, webhooks, sync)
│   ├── db.ts               # Prisma client singleton
│   └── utils.ts            # Shared utilities (cn, formatDate, etc.)
├── hooks/                  # Custom React hooks
├── types/                  # TypeScript type definitions
└── styles/                 # Global CSS + Tailwind config

prisma/
├── schema.prisma           # Database schema
└── migrations/             # Prisma migration files
```

## File Ownership Zones

### App Router (`src/app/`)
- **Owner**: Full-stack
- **Rules**:
  - Route groups in parentheses for layout isolation: `(auth)`, `(dashboard)`, `(marketing)`
  - `page.tsx` for pages, `layout.tsx` for layouts, `loading.tsx` for suspense, `error.tsx` for error boundaries
  - Server Components by default. Add `'use client'` only when needed (event handlers, hooks, browser APIs)
  - Metadata via `export const metadata` or `generateMetadata()` — never `<Head>`

### API Routes (`src/app/api/`)
- **Owner**: Backend specialist
- **Rules**:
  - One directory per resource: `api/users/`, `api/subscriptions/`, `api/webhooks/`
  - Use `NextRequest` / `NextResponse` — not raw Node `req`/`res`
  - Validate request body with Zod at the top of every handler
  - Auth check via Supabase `createServerClient()` — return 401 before any business logic

### Components (`src/components/`)
- **Owner**: Frontend specialist
- **Rules**:
  - `ui/` = headless primitives. No business logic. Styled with Tailwind + `cn()`.
  - `forms/` = business forms with validation (react-hook-form + zod resolvers)
  - Every component gets its own file. No barrel exports (`index.ts`) — direct imports only.
  - Props interface defined in the same file, exported for testing.

### Prisma Schema (`prisma/schema.prisma`)
- **Owner**: Database specialist
- **Rules**:
  - UUIDs for all primary keys (`@id @default(uuid())`)
  - `createdAt` and `updatedAt` on every model
  - Soft delete via `deletedAt DateTime?` — never hard delete user data
  - Relations must have explicit `onDelete` behavior
  - Indexes on every foreign key and commonly queried fields

### Stripe Integration (`src/lib/stripe/`)
- **Owner**: Billing specialist
- **Rules**:
  - Webhook handler verifies signature before any processing
  - Idempotent event handling — check if event already processed before acting
  - Never store full card numbers. Stripe handles PCI compliance.
  - Sync Stripe subscription status to local DB on every webhook event

### Supabase Auth (`src/lib/supabase/`)
- **Owner**: Auth specialist
- **Rules**:
  - `server.ts` for server-side client, `browser.ts` for client-side
  - Middleware in `src/middleware.ts` refreshes session on every request
  - Never expose `service_role` key to the client — server-only

## Dev Commands

```bash
npm run dev          # Next.js dev server
npx prisma studio   # Database GUI
npx prisma migrate dev  # Run migrations
npx prisma generate # Regenerate client after schema changes
npm test             # Run test suite
npm run build        # Production build
npm run lint         # ESLint
```

## Critical Gotchas

1. **Server vs Client Components**: Default to Server Components. Only use `'use client'` for interactivity. Never import server-only code in client components.
2. **Prisma Client Singleton**: Use `src/lib/db.ts` — never instantiate `new PrismaClient()` elsewhere. Hot-reload creates multiple instances otherwise.
3. **Stripe Webhook Raw Body**: Stripe signature verification needs the raw body. Use `export const config = { api: { bodyParser: false } }` in the webhook route.
4. **Supabase Cookie Handling**: `@supabase/ssr` manages cookies automatically. Don't manually set auth cookies.
5. **Environment Variables**: `NEXT_PUBLIC_` prefix for client-accessible vars. Everything else is server-only. Never prefix secrets with `NEXT_PUBLIC_`.
