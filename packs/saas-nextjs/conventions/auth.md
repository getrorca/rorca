---
name: auth
description: Supabase Auth conventions — session management, middleware, role-based access
globs:
  - "src/lib/supabase/**"
  - "src/middleware.ts"
  - "src/app/(auth)/**"
  - "src/app/api/auth/**"
alwaysApply: false
---

# Supabase Auth Conventions

## Client Setup

### Server Client
```typescript
// src/lib/supabase/server.ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options));
        },
      },
    },
  );
}
```

### Browser Client
```typescript
// src/lib/supabase/browser.ts
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

## Middleware (Session Refresh)
```typescript
// src/middleware.ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            request.cookies.set(name, value);
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  // Redirect unauthenticated users away from protected routes
  if (!user && request.nextUrl.pathname.startsWith('/dashboard')) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

## Auth Flow Patterns

### Sign Up
```typescript
const { error } = await supabase.auth.signUp({
  email,
  password,
  options: { emailRedirectTo: `${origin}/auth/callback` },
});
```

### Sign In
```typescript
const { error } = await supabase.auth.signInWithPassword({ email, password });
```

### OAuth (Social Login)
```typescript
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: `${origin}/auth/callback` },
});
```

### Auth Callback Route
```typescript
// src/app/auth/callback/route.ts
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (code) {
    const supabase = createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL('/dashboard', request.url));
}
```

## Protected Route Pattern
```typescript
// In any Server Component or API route
const supabase = createClient();
const { data: { user } } = await supabase.auth.getUser();

if (!user) {
  redirect('/login');
}
```

**Always use `getUser()`** — never `getSession()` alone. `getUser()` validates the JWT with Supabase servers; `getSession()` only reads the local cookie (can be tampered with).

## Role-Based Access
- Store roles in a `profiles` table linked to `auth.users`.
- Check role in middleware or at the top of Server Components.
- Never trust client-side role checks for authorization — always verify server-side.

```typescript
const profile = await prisma.profile.findUnique({
  where: { userId: user.id },
  select: { role: true },
});

if (profile?.role !== 'admin') {
  return new Response('Forbidden', { status: 403 });
}
```

## Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL` — safe for client
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — safe for client (RLS enforced)
- `SUPABASE_SERVICE_ROLE_KEY` — **server-only**, bypasses RLS. Never expose.
