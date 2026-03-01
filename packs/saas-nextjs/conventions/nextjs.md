---
name: nextjs
description: Next.js 14 App Router conventions — routing, data fetching, server/client components
globs:
  - "src/app/**/*.tsx"
  - "src/app/**/*.ts"
  - "next.config.*"
alwaysApply: false
---

# Next.js 14 Conventions

## App Router Structure
- Use route groups `(groupName)` to share layouts without affecting the URL path.
- File conventions: `page.tsx`, `layout.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`.
- Dynamic routes: `[slug]` for single params, `[...slug]` for catch-all, `[[...slug]]` for optional catch-all.

## Server Components (Default)
- Every component is a Server Component unless marked with `'use client'`.
- Server Components can `await` directly — no `useEffect` for data fetching.
- Pass data down to Client Components as props. Never import server-only modules in client components.

```tsx
// GOOD — Server Component fetching data
export default async function DashboardPage() {
  const data = await prisma.project.findMany();
  return <ProjectList projects={data} />;
}

// BAD — unnecessary client component for static data
'use client'
export default function DashboardPage() {
  const [data, setData] = useState([]);
  useEffect(() => { fetch('/api/projects').then(...) }, []);
}
```

## Client Components
- Only use `'use client'` when you need: event handlers, useState, useEffect, browser APIs, or third-party client libraries.
- Keep Client Components as leaf nodes — push `'use client'` boundary as far down the tree as possible.
- Never pass functions as props from Server to Client Components (functions aren't serializable).

## Data Fetching
- Server Components: fetch directly with Prisma or `fetch()`. No API routes needed for same-server data.
- Client Components: use `fetch()` to API routes, or React Query / SWR for caching.
- Revalidation: `revalidatePath()` after mutations, `revalidateTag()` for granular cache control.

## Server Actions
- Use for form submissions and mutations that benefit from progressive enhancement.
- Define with `'use server'` at the top of the function or in a separate `actions.ts` file.
- Always validate input with Zod inside the action.

```tsx
// src/app/(dashboard)/settings/actions.ts
'use server'
import { z } from 'zod';

const UpdateProfileSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

export async function updateProfile(formData: FormData) {
  const parsed = UpdateProfileSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.flatten() };
  // ... update in DB
  revalidatePath('/settings');
  return { success: true };
}
```

## Metadata
- Static: `export const metadata: Metadata = { title: '...' }` in page/layout files.
- Dynamic: `export async function generateMetadata({ params })` for per-page titles.
- Never use `<Head>` from `next/head` — that's Pages Router.

## Middleware
- `src/middleware.ts` runs on every request before routing.
- Use for auth session refresh, redirects, and request rewriting.
- Keep middleware fast — no database queries, no heavy computation.

## Image Optimization
- Always use `next/image` instead of raw `<img>`. Configure `remotePatterns` in `next.config.js` for external images.
- Set explicit `width` and `height` or use `fill` with a sized container.
