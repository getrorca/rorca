import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db';

const router = Router();

export const JWT_SECRET = process.env.JWT_SECRET || 'rorcha-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '15m';
const REFRESH_TOKEN_EXPIRES_DAYS = 7;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_COST = 12;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

function generateAccessToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function storeRefreshToken(userId: string, rawToken: string): void {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, tokenHash, expiresAt);
}

// POST /api/auth/register
router.post('/register', (req: Request, res: Response) => {
  const { email, password, displayName } = req.body;

  // Validate required fields
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required' });
    return;
  }
  if (!displayName || typeof displayName !== 'string') {
    res.status(400).json({ error: 'Display name is required' });
    return;
  }

  // Validate email format
  const trimmedEmail = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmedEmail)) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }

  // Validate password length
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  // Check for existing user
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(trimmedEmail) as UserRow | undefined;
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  // Hash password and create user
  const passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
  const userId = crypto.randomUUID();

  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(userId, trimmedEmail, displayName.trim(), passwordHash);

  // Generate tokens
  const accessToken = generateAccessToken(userId, trimmedEmail);
  const refreshToken = generateRefreshToken();
  storeRefreshToken(userId, refreshToken);

  // Emit WAL event
  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('user_registered', '', ?)"
  ).run(JSON.stringify({ userId, email: trimmedEmail }));

  res.status(201).json({
    user: {
      id: userId,
      email: trimmedEmail,
      displayName: displayName.trim(),
    },
    accessToken,
    refreshToken,
  });
});

// POST /api/auth/login
router.post('/login', (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  const trimmedEmail = email.trim().toLowerCase();

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(trimmedEmail) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const passwordMatch = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatch) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const accessToken = generateAccessToken(user.id, user.email);
  const refreshToken = generateRefreshToken();
  storeRefreshToken(user.id, refreshToken);

  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('user_login', '', ?)"
  ).run(JSON.stringify({ userId: user.id, email: user.email }));

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
    },
    accessToken,
    refreshToken,
  });
});

// POST /api/auth/refresh
router.post('/refresh', (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'Refresh token is required' });
    return;
  }

  const tokenHash = hashToken(refreshToken);

  const storedToken = db.prepare(
    'SELECT rt.*, u.email FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token_hash = ?'
  ).get(tokenHash) as (RefreshTokenRow & { email: string }) | undefined;

  if (!storedToken) {
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  if (storedToken.revoked_at) {
    res.status(401).json({ error: 'Refresh token has been revoked' });
    return;
  }

  if (new Date(storedToken.expires_at) <= new Date()) {
    res.status(401).json({ error: 'Refresh token has expired' });
    return;
  }

  // Invalidate the old refresh token (rotation)
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?"
  ).run(storedToken.id);

  // Issue new token pair
  const newAccessToken = generateAccessToken(storedToken.user_id, storedToken.email);
  const newRefreshToken = generateRefreshToken();
  storeRefreshToken(storedToken.user_id, newRefreshToken);

  res.json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'Refresh token is required' });
    return;
  }

  const tokenHash = hashToken(refreshToken);

  const result = db.prepare(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL"
  ).run(tokenHash);

  if (result.changes === 0) {
    res.status(401).json({ error: 'Invalid or already revoked refresh token' });
    return;
  }

  res.json({ message: 'Logged out successfully' });
});

// Auth middleware — verifies JWT access token from Authorization header
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; email: string };
    (req as Request & { userId: string; userEmail: string }).userId = decoded.sub;
    (req as Request & { userId: string; userEmail: string }).userEmail = decoded.email;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

export default router;
