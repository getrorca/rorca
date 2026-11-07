---
name: prisma
description: Prisma ORM conventions — schema design, query patterns, migration workflow
globs:
  - "prisma/**"
  - "src/lib/db.ts"
  - "**/*.prisma"
alwaysApply: false
---

# Prisma Conventions

## Schema Design

### Model Naming
- PascalCase for model names: `User`, `Subscription`, `ProjectMember`.
- camelCase for field names: `createdAt`, `stripeCustomerId`.
- Plural table names via `@@map`: `model User { @@map("users") }`.

### Required Fields (Every Model)
```prisma
model Example {
  id        String   @id @default(uuid())
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

### Soft Deletes
```prisma
model User {
  // ...
  deletedAt DateTime?
}
```
- Filter soft-deleted records in queries: `where: { deletedAt: null }`.
- Use Prisma middleware or a wrapper for automatic soft-delete filtering.

### Relations
- Explicit `onDelete` on every relation:
  - `Cascade` for owned children (user deletes → delete their posts)
  - `SetNull` for optional references
  - `Restrict` for critical references that shouldn't be orphaned

```prisma
model Post {
  author   User   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId String
}
```

### Indexes
- Add `@@index` on every foreign key and frequently queried field.
- Composite indexes for multi-column queries: `@@index([userId, createdAt])`.

## Client Singleton

```typescript
// src/lib/db.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
```

**Never** instantiate `new PrismaClient()` anywhere else. Import from `@/lib/db`.

## Query Patterns

### Select Only What You Need
```typescript
// GOOD — explicit select
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, name: true, email: true },
});

// BAD — fetches all columns
const user = await prisma.user.findUnique({ where: { id } });
```

### Avoid N+1 Queries
```typescript
// GOOD — include related data
const posts = await prisma.post.findMany({
  include: { author: { select: { name: true } } },
});

// BAD — N+1 loop
const posts = await prisma.post.findMany();
for (const post of posts) {
  post.author = await prisma.user.findUnique({ where: { id: post.authorId } });
}
```

### Transactions
```typescript
// Use interactive transactions for multi-step operations
const [user, subscription] = await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { ... } });
  const subscription = await tx.subscription.create({ data: { userId: user.id, ... } });
  return [user, subscription];
});
```

## Migration Workflow
1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name descriptive-name`
3. Review generated SQL in `prisma/migrations/`
4. Commit both schema and migration files
5. In production: `npx prisma migrate deploy`

**Never** use `npx prisma db push` in production — it doesn't create migration files.

## Seeding
- Seed file at `prisma/seed.ts`.
- Seed must be idempotent — use `upsert` not `create`.
- Include test users, plans, and sample data.
