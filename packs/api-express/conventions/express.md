---
name: express
description: Express.js conventions — routing, middleware, error handling, request lifecycle
globs:
  - "src/routes/**/*.ts"
  - "src/middleware/**/*.ts"
  - "src/server.ts"
alwaysApply: false
---

# Express.js Conventions

## Route Structure

### One File Per Resource
```
src/routes/
├── auth.ts          # POST /login, /register, /refresh, /logout
├── users.ts         # CRUD /api/users
├── posts.ts         # CRUD /api/users/:userId/posts
└── health.ts        # GET /api/health
```

### Route File Pattern
```typescript
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create a user
 */
router.post('/', validate(CreateUserSchema), (req: Request, res: Response) => {
  const { name, email } = req.body;
  const user = createUser({ name, email });
  res.status(201).json({ data: user });
});

export default router;
```

### Route Mounting
```typescript
// src/server.ts
app.use('/api/auth', authRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/health', healthRoutes);
app.use(errorHandler);  // Must be LAST
```

## Middleware

### Ordering (Critical)
```typescript
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimiter);
// ... mount routes ...
app.use(errorHandler);  // LAST — catches all thrown errors
```

### Validation Middleware Factory
```typescript
// src/middleware/validate.ts
import { z, type ZodSchema } from 'zod';
import { ValidationError } from '../lib/errors';

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details: Record<string, string> = {};
      for (const issue of result.error.issues) {
        details[issue.path.join('.') || 'root'] = issue.message;
      }
      throw new ValidationError('Validation failed', details);
    }
    req.body = result.data;
    next();
  };
}
```

### Auth Middleware
```typescript
// src/middleware/auth.ts
export function authRequired(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AuthError('Missing or invalid authorization header');
  }
  const token = header.slice(7);
  const payload = verifyAccessToken(token);
  req.user = payload;
  next();
}
```

## Error Handling

### Error Hierarchy
```typescript
export class AppError extends Error {
  constructor(public message: string, public statusCode: number, public details?: Record<string, string>) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, string>) { super(message, 400, details); }
}
export class AuthError extends AppError {
  constructor(message = 'Unauthorized') { super(message, 401); }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(message, 404); }
}
export class ConflictError extends AppError {
  constructor(message = 'Conflict') { super(message, 409); }
}
```

### Central Error Handler
```typescript
// src/middleware/error-handler.ts
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
      ...(err.details && { details: err.details }),
    });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
```

Routes **throw** errors. They never call `res.status().json()` for error responses.

## Request/Response Patterns

### Async Route Handlers
Express doesn't catch async errors by default. Wrap or use `express-async-errors`:
```typescript
import 'express-async-errors';  // At the top of server.ts
```

### Response Shapes
```typescript
// Single resource
res.json({ data: user });

// Collection
res.json({ data: users, meta: { total, page, pageSize } });

// Created
res.status(201).json({ data: newUser });

// Deleted
res.status(204).end();
```
