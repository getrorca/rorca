---
name: typescript
description: TypeScript conventions — strict mode, type patterns, project configuration
globs:
  - "**/*.ts"
  - "tsconfig.json"
alwaysApply: true
---

# TypeScript Conventions

## tsconfig.json Essentials
```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "moduleResolution": "node",
    "module": "commonjs",
    "target": "ES2022",
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true
  }
}
```

`strict: true` is non-negotiable. It enables `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, and more.

## Type Patterns

### Prefer Interfaces for Object Shapes
```typescript
// GOOD — interface for object shapes
interface User {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'admin';
}

// Use type for unions, intersections, utility types
type UserRole = 'user' | 'admin';
type CreateUserInput = Pick<User, 'name' | 'email'>;
type PartialUser = Partial<User>;
```

### No `any` Without Justification
```typescript
// BAD
const data: any = getResponse();

// GOOD — use unknown and narrow
const data: unknown = getResponse();
if (typeof data === 'object' && data !== null && 'name' in data) {
  // Now TypeScript knows the shape
}

// ACCEPTABLE — when interfacing with untyped library (add comment)
const result = untypedLib.doThing() as any; // TODO: type this properly
```

### Function Signatures
```typescript
// Always type parameters and return values for exported functions
export function createUser(input: CreateUserInput): User {
  // ...
}

// Arrow functions in modules also get return types
export const formatDate = (date: Date): string => {
  return date.toISOString();
};

// Private/internal functions: inferred return types are OK
function buildQuery(filters: QueryFilters) {
  // Return type inferred — acceptable for private functions
}
```

### Discriminated Unions for Results
```typescript
type Result<T> =
  | { success: true; data: T }
  | { success: false; error: string };

function parseConfig(raw: string): Result<Config> {
  try {
    return { success: true, data: JSON.parse(raw) };
  } catch {
    return { success: false, error: 'Invalid JSON' };
  }
}
```

### Enums vs Union Types
```typescript
// PREFER union types (tree-shakeable, no runtime cost)
type Status = 'active' | 'inactive' | 'pending';

// AVOID enums (generate runtime code, harder to tree-shake)
enum Status { Active, Inactive, Pending }
```

### Const Assertions
```typescript
// Lock down literal types
const ROLES = ['user', 'admin'] as const;
type Role = typeof ROLES[number]; // 'user' | 'admin'

const CONFIG = {
  port: 3000,
  host: 'localhost',
} as const;
```

## Import/Export Patterns

### Named Exports (Preferred)
```typescript
// GOOD — explicit, refactor-friendly
export function createUser() {}
export interface User {}

// AVOID — default exports make renaming easy but tracking hard
export default function createUser() {}
```

### Type-Only Imports
```typescript
// Use type-only imports when importing types
import type { User } from './types';
import { type Request, type Response, Router } from 'express';
```

## Null Handling
- Prefer `undefined` over `null` for missing values (TypeScript convention).
- Use `null` only when interfacing with APIs that use `null` (databases, JSON).
- Optional chaining (`?.`) over manual null checks.
- Nullish coalescing (`??`) over `||` for defaults (handles `0`, `''`, `false` correctly).

## Async Patterns
```typescript
// Prefer async/await over raw Promises
// GOOD
async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}

// AVOID (unless composing multiple promises)
function fetchUser(id: string): Promise<User> {
  return fetch(`/api/users/${id}`).then(r => r.json());
}
```

**Exception**: `better-sqlite3` is synchronous — no async/await needed for database calls.
