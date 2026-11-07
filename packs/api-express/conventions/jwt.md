---
name: jwt
description: JWT authentication conventions — token lifecycle, refresh flow, security practices
globs:
  - "src/lib/jwt.ts"
  - "src/middleware/auth.ts"
  - "src/routes/auth.ts"
alwaysApply: false
---

# JWT Authentication Conventions

## Token Architecture

### Two-Token Strategy
| Token | Lifetime | Storage | Purpose |
|-------|----------|---------|---------|
| Access token | 15 minutes | Memory / Authorization header | API authentication |
| Refresh token | 7 days | HTTP-only cookie + hashed in DB | Token renewal |

- Short access tokens limit damage window if stolen.
- Long refresh tokens enable persistent sessions without re-login.
- Refresh tokens are hashed (bcrypt or SHA-256) before DB storage — stolen DB doesn't yield valid tokens.

## JWT Module

```typescript
// src/lib/jwt.ts
import jwt from 'jsonwebtoken';

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export function generateAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
}

export function generateRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as TokenPayload;
}
```

**Never** import `jsonwebtoken` directly elsewhere. Use `src/lib/jwt.ts`.

## Auth Flow

### Login
```typescript
// POST /api/auth/login
const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (!user || !await bcrypt.compare(password, user.password_hash)) {
  throw new AuthError('Invalid credentials');
}

const accessToken = generateAccessToken({ userId: user.id, email: user.email, role: user.role });
const refreshToken = generateRefreshToken({ userId: user.id, email: user.email, role: user.role });

// Store hashed refresh token in DB
const hashedRefresh = crypto.createHash('sha256').update(refreshToken).digest('hex');
db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
  .run(user.id, hashedRefresh, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

res.json({ data: { accessToken, refreshToken } });
```

### Refresh
```typescript
// POST /api/auth/refresh
const { refreshToken } = req.body;
const payload = verifyRefreshToken(refreshToken);

const hashedToken = crypto.createHash('sha256').update(refreshToken).digest('hex');
const stored = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ? AND user_id = ?')
  .get(hashedToken, payload.userId);

if (!stored) throw new AuthError('Invalid refresh token');

// Rotate: delete old, issue new pair
db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hashedToken);
const newAccessToken = generateAccessToken(payload);
const newRefreshToken = generateRefreshToken(payload);

// Store new refresh token
const newHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
  .run(payload.userId, newHash, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());

res.json({ data: { accessToken: newAccessToken, refreshToken: newRefreshToken } });
```

### Logout
```typescript
// POST /api/auth/logout
// Delete all refresh tokens for this user (invalidate all sessions)
db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(req.user.userId);
res.status(204).end();
```

## Security Rules

### Token Content
- Include: `userId`, `email`, `role` — minimum needed for authorization.
- Never include: passwords, full user objects, sensitive data, PII beyond email.
- `role` in token enables fast RBAC checks without DB roundtrip.

### Secret Management
- Separate secrets for access and refresh tokens.
- Minimum 256-bit (32 byte) secrets: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Store in environment variables — never in code, config files, or version control.
- Rotate secrets periodically — rotation invalidates all outstanding tokens.

### Refresh Token Security
- Hash before storing — stolen DB doesn't compromise active sessions.
- Rotate on every use — detect token reuse (indicates theft).
- Delete on logout — explicit session termination.
- Limit active refresh tokens per user (e.g., max 5 devices).

### Password Hashing
```typescript
import bcrypt from 'bcrypt';
const SALT_ROUNDS = 12;

// Hash on registration
const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

// Verify on login
const valid = await bcrypt.compare(password, storedHash);
```

- `bcrypt` with 12+ rounds. Never SHA-256/MD5 for passwords.
- Salt is built into bcrypt — no separate salt column needed.

## req.user Type Extension
```typescript
// src/types/express.d.ts
import { TokenPayload } from '../lib/jwt';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}
```
