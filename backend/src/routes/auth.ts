import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db } from '../db';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'rorcha-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '15m';
const REFRESH_TOKEN_EXPIRES_DAYS = 30;

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

function generateAccessToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

function storeRefreshToken(userId: string, rawToken: string): void {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
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

export default router;
