import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Stripe from 'stripe';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/index';
import { validateBody } from '../lib/validate';
import { logger } from '../lib/logger';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

export const JWT_SECRET = process.env.JWT_SECRET || 'rorca-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '15m';
const REFRESH_TOKEN_EXPIRES_DAYS = 7;

/** Synthetic session for local single-user mode (no real auth required) */
export const LOCAL_ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@rorca.local',
  supabaseId: '00000000-0000-0000-0000-000000000001',
  displayName: 'Admin',
  role: 'admin' as const,
  plan: 'pro' as const,
  githubConnected: false,
  emailVerified: true,
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 12;

// Login rate limiting
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MINUTES = 15;
// Pre-computed dummy hash for constant-time comparison when email doesn't exist
const DUMMY_HASH = '$2b$12$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

// Email verification constants
const VERIFICATION_TOKEN_EXPIRES_HOURS = 24;
const VERIFICATION_RATE_LIMIT_PER_HOUR = 3;

// GitHub OAuth config — read lazily from process.env so dotenv can be called
// before server.ts route imports without relying on import-hoisting order.
const GITHUB_SCOPES = 'user:email,public_repo';
function githubClientId(): string { return process.env.GITHUB_CLIENT_ID || ''; }
function githubClientSecret(): string { return process.env.GITHUB_CLIENT_SECRET || ''; }
function githubCallbackUrl(): string { return process.env.GITHUB_CALLBACK_URL || 'http://localhost:3030/api/auth/github/callback'; }

// In-memory CSRF state store (TTL: 10 minutes). Not persisted — ephemeral tokens only.
const oauthStateCache = new Map<string, number>();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function storeOAuthState(state: string): void {
  oauthStateCache.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  // Prune expired entries (lazy GC)
  const now = Date.now();
  for (const [s, exp] of oauthStateCache.entries()) {
    if (exp < now) oauthStateCache.delete(s);
  }
}

function validateOAuthState(state: string): boolean {
  const exp = oauthStateCache.get(state);
  if (!exp || exp < Date.now()) return false;
  oauthStateCache.delete(state); // one-time use
  return true;
}

// Encryption key for GitHub tokens at rest — derived from JWT_SECRET via SHA256 to get 32 bytes
const ENCRYPTION_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
const ENCRYPTION_ALGO = 'aes-256-gcm' as const;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  github_id: string | null;
  github_login: string | null;
  role: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EmailVerificationTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
  supabaseId: string;
  role: string;
  plan?: string;
}

const SUPABASE_AUTH_ENABLED = Boolean(process.env.SUPABASE_URL?.trim());

interface GitHubConnectionRow {
  id: string;
  user_id: string;
  github_user_id: string;
  encrypted_token: string;
  scopes: string;
  github_username: string | null;
  created_at: string;
  updated_at: string;
}

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
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

async function storeRefreshToken(userId: string, rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const id = crypto.randomUUID();
  await execute(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [id, userId, tokenHash, expiresAt]
  );
}

/**
 * Generate an email verification token, store its hash, and log the verification link.
 * Returns the raw token (for inclusion in dev response).
 */
async function generateAndStoreVerificationToken(userId: string, email: string): Promise<string> {
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(rawToken);
  const tokenId = crypto.randomUUID();

  await execute(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '${VERIFICATION_TOKEN_EXPIRES_HOURS} hours')`,
    [tokenId, userId, tokenHash]
  );

  const _frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
  const verifyLink = `http://localhost:3030/api/auth/verify-email?token=${rawToken}`;

  logger.info(`[auth] Email verification link for ${email}: ${verifyLink}`);

  return rawToken;
}

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
 *     operationId: registerUser
 *     description: Creates a new user account with email, password, and display name, returning auth tokens and a verification link.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, displayName]
 *             properties:
 *               email: { type: string, format: email, example: "user@example.com" }
 *               password: { type: string, minLength: 8, example: "securepass123" }
 *               displayName: { type: string, example: "Jane Doe" }
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     email: { type: string }
 *                     displayName: { type: string }
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       400: { description: "Validation error", content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
 *       409: { description: "Email already registered" }
 */
const PASSWORD_STRENGTH_MSG = 'Password must be at least 8 characters and contain uppercase, lowercase, and a number';

const RegisterSchema = z.object({
  email: z.preprocess(v => (v == null ? '' : v), z.string().min(1, 'Email is required').regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format')),
  password: z.preprocess(v => (v == null ? '' : v), z.string().min(1, 'Password is required').min(8, PASSWORD_STRENGTH_MSG).refine(
    (p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p),
    { message: PASSWORD_STRENGTH_MSG },
  )),
  displayName: z.preprocess(v => (v == null ? '' : v), z.string().min(1, 'Display name is required')),
});

router.post('/register', validateBody(RegisterSchema), async (req: Request, res: Response) => {
  // Registration disabled — single-user deployment. Remove REGISTRATION_DISABLED to re-enable.
  if (process.env.REGISTRATION_DISABLED !== 'false') {
    res.status(403).json({ error: 'Registration is disabled on this server.' });
    return;
  }

  const { email, password, displayName } = req.body;

  const trimmedEmail = email.trim().toLowerCase();

  // Check for existing user
  const existing = await queryOne<UserRow>('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
  if (existing) {
    res.status(409).json({ error: 'An account with this email already exists' });
    return;
  }

  // Hash password and create user (async — ~250ms at cost 12)
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const userId = crypto.randomUUID();

  await execute(
    'INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
    [userId, trimmedEmail, displayName.trim(), passwordHash]
  );

  // Generate email verification token
  const verificationToken = await generateAndStoreVerificationToken(userId, trimmedEmail);

  // Generate auth tokens
  const accessToken = generateAccessToken(userId, trimmedEmail);
  const refreshToken = generateRefreshToken();
  await storeRefreshToken(userId, refreshToken);

  // Emit WAL event
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('user_registered', '', $1)",
    [JSON.stringify({ userId, email: trimmedEmail })]
  );

  // US-044: Set CSRF double-submit cookie on session creation
  setCsrfCookie(res, generateCsrfToken());

  res.status(201).json({
    user: {
      id: userId,
      email: trimmedEmail,
      displayName: displayName.trim(),
      emailVerified: false,
    },
    accessToken,
    refreshToken,
    // Include verification link in dev mode
    ...(process.env.NODE_ENV !== 'production' && { verificationToken }),
  });
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Authenticate and get tokens
 *     operationId: loginUser
 *     description: Authenticates a user with email and password, returning JWT access and refresh tokens.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     email: { type: string }
 *                     displayName: { type: string }
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       401: { description: "Invalid email or password" }
 */
const LoginSchema = z.object({
  email: z.preprocess(v => (v == null ? '' : v), z.string().min(1, 'Email is required')),
  password: z.preprocess(v => (v == null ? '' : v), z.string().min(1, 'Password is required')),
});

router.post('/login', validateBody(LoginSchema), async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const trimmedEmail = email.trim().toLowerCase();

  // Check login rate limit BEFORE any password work
  const recentAttempts = await query<{ id: string }>(
    `SELECT id FROM login_attempts WHERE email = $1 AND attempted_at > NOW() - INTERVAL '${LOGIN_LOCKOUT_MINUTES} minutes' AND success = false`,
    [trimmedEmail]
  );

  if (recentAttempts.length >= LOGIN_MAX_ATTEMPTS) {
    // Calculate seconds until oldest attempt expires
    const oldest = await queryOne<{ attempted_at: string }>(
      `SELECT attempted_at FROM login_attempts WHERE email = $1 AND attempted_at > NOW() - INTERVAL '${LOGIN_LOCKOUT_MINUTES} minutes' AND success = false ORDER BY attempted_at ASC LIMIT 1`,
      [trimmedEmail]
    );
    const retryAfterSec = oldest
      ? Math.ceil((new Date(oldest.attempted_at).getTime() + LOGIN_LOCKOUT_MINUTES * 60 * 1000 - Date.now()) / 1000)
      : LOGIN_LOCKOUT_MINUTES * 60;

    res.status(423).set('Retry-After', String(Math.max(retryAfterSec, 1))).json({
      error: 'Too many failed login attempts. Please try again later.',
    });
    return;
  }

  const user = await queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [trimmedEmail]);

  // Constant-time comparison: always run bcrypt.compare even if user doesn't exist
  const hashToCompare = user?.password_hash || DUMMY_HASH;
  const passwordMatch = await bcrypt.compare(password, hashToCompare);

  if (!user || !passwordMatch) {
    // Record failed attempt
    await execute(
      'INSERT INTO login_attempts (email, success) VALUES ($1, false)',
      [trimmedEmail]
    );
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  // Record successful attempt (for audit — does NOT reset counter per AC)
  await execute(
    'INSERT INTO login_attempts (email, success) VALUES ($1, true)',
    [trimmedEmail]
  );

  const accessToken = generateAccessToken(user.id, user.email);
  const refreshToken = generateRefreshToken();
  await storeRefreshToken(user.id, refreshToken);

  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('user_login', '', $1)",
    [JSON.stringify({ userId: user.id, email: user.email })]
  );

  // US-044: Set CSRF double-submit cookie on session creation
  setCsrfCookie(res, generateCsrfToken());

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      emailVerified: !!user.email_verified_at,
    },
    accessToken,
    refreshToken,
  });
});

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh access token (token rotation)
 *     operationId: refreshAuthToken
 *     description: Exchanges a valid refresh token for a new access/refresh token pair, revoking the old refresh token.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200:
 *         description: New token pair issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken: { type: string }
 *                 refreshToken: { type: string }
 *       401: { description: "Invalid or expired refresh token" }
 */
router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'Refresh token is required' });
    return;
  }

  const tokenHash = hashToken(refreshToken);

  const storedToken = await queryOne<RefreshTokenRow & { email: string }>(
    'SELECT rt.*, u.email FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token_hash = $1',
    [tokenHash]
  );

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
  await execute(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
    [storedToken.id]
  );

  // Issue new token pair
  const newAccessToken = generateAccessToken(storedToken.user_id, storedToken.email);
  const newRefreshToken = generateRefreshToken();
  await storeRefreshToken(storedToken.user_id, newRefreshToken);

  // US-044: Rotate CSRF token on refresh
  setCsrfCookie(res, generateCsrfToken());

  res.json({
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  });
});

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke a refresh token
 *     operationId: logoutUser
 *     description: Revokes the provided refresh token to end the user session.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200: { description: "Logged out successfully" }
 *       401: { description: "Invalid or already revoked token" }
 */
router.post('/logout', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken || typeof refreshToken !== 'string') {
    res.status(400).json({ error: 'Refresh token is required' });
    return;
  }

  const tokenHash = hashToken(refreshToken);

  const result = await execute(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash]
  );

  if (result.rowCount === 0) {
    res.status(401).json({ error: 'Invalid or already revoked refresh token' });
    return;
  }

  res.json({ message: 'Logged out successfully' });
});

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     operationId: getCurrentUser
 *     description: Returns the profile of the currently authenticated user, including GitHub connection status.
 *     responses:
 *       200:
 *         description: Current user info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     email: { type: string }
 *                     displayName: { type: string }
 *                     githubConnected: { type: boolean }
 *       401: { description: "Not authenticated" }
 */
router.get('/me', async (req: Request, res: Response) => {
  const authReq = req as Request & { user?: AuthUser };
  // When auth is bypassed globally, fall back to the first registered user
  const fallbackUser = authReq.user?.id
    ? undefined
    : await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  const userId = authReq.user?.id ?? fallbackUser?.id;

  if (!userId) {
    // Single-user local mode: no users in DB yet — return synthetic local-admin
    // so the app always has a session on fresh installs or during DB recovery
    if (process.env.AUTH_REQUIRED !== 'true') {
      res.json({ user: LOCAL_ADMIN });
      return;
    }
    res.status(401).json({ error: 'No user configured' });
    return;
  }

  const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'display_name' | 'github_id' | 'email_verified_at'> & { plan?: string }>(
    'SELECT id, email, display_name, github_id, email_verified_at, plan FROM users WHERE id = $1',
    [userId]
  );

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      githubConnected: !!user.github_id,
      emailVerified: !!user.email_verified_at,
      plan: user.plan || 'free',
    },
  });
});

// ─── PATCH /api/auth/me — Update profile + password ───

/**
 * @swagger
 * /api/auth/me:
 *   patch:
 *     tags: [Auth]
 *     summary: Update current user profile (display name, password)
 *     operationId: updateCurrentUser
 *     description: Updates the authenticated user's display name and/or password, requiring current password for password changes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string }
 *               currentPassword: { type: string }
 *               newPassword: { type: string, minLength: 6 }
 *     responses:
 *       200: { description: "Profile updated" }
 *       400: { description: "Validation error" }
 *       401: { description: "Not authenticated" }
 *       403: { description: "Current password incorrect" }
 */
router.patch('/me', async (req: Request, res: Response) => {
  const authReq = req as Request & { user?: AuthUser };
  const fallbackUser = authReq.user?.id
    ? undefined
    : await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  const userId = authReq.user?.id ?? fallbackUser?.id;

  if (!userId) {
    res.status(401).json({ error: 'No user configured' });
    return;
  }

  const { displayName, currentPassword, newPassword } = req.body;

  const updates: string[] = [];
  const params: (string | null)[] = [];
  let paramIdx = 0;

  // Display name update
  if (displayName !== undefined) {
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      res.status(400).json({ error: 'displayName must be a non-empty string' });
      return;
    }
    paramIdx++;
    updates.push(`display_name = $${paramIdx}`);
    params.push(displayName.trim());
  }

  // Password change (requires currentPassword)
  if (newPassword !== undefined) {
    if (!currentPassword || typeof currentPassword !== 'string') {
      res.status(400).json({ error: 'currentPassword is required to change password' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      res.status(400).json({ error: 'newPassword must be at least 6 characters' });
      return;
    }

    const row = await queryOne<Pick<UserRow, 'password_hash'>>('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!(await bcrypt.compare(currentPassword, row.password_hash))) {
      res.status(403).json({ error: 'Current password is incorrect' });
      return;
    }

    paramIdx++;
    updates.push(`password_hash = $${paramIdx}`);
    params.push(await bcrypt.hash(newPassword, BCRYPT_COST));
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  updates.push('updated_at = NOW()');
  paramIdx++;
  params.push(userId);

  await execute(`UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx}`, params);

  // Return updated user
  const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'display_name' | 'github_id' | 'email_verified_at'> & { plan?: string }>(
    'SELECT id, email, display_name, github_id, email_verified_at, plan FROM users WHERE id = $1',
    [userId]
  );

  res.json({
    ok: true,
    user: user ? {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      githubConnected: !!user.github_id,
      emailVerified: !!user.email_verified_at,
      plan: user.plan || 'free',
    } : undefined,
  });
});

// ─── Email verification endpoints ───

/**
 * @swagger
 * /api/auth/verify-email:
 *   get:
 *     tags: [Auth]
 *     summary: Verify email address using a verification token
 *     operationId: verifyEmail
 *     description: Validates the email verification token and marks the user's email as verified, then redirects to the frontend.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       302: { description: "Redirects to app on success" }
 *       400: { description: "Invalid or expired token" }
 */
router.get('/verify-email', async (req: Request, res: Response) => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Verification token is required' });
    return;
  }

  const tokenHash = hashToken(token);
  const verificationToken = await queryOne<EmailVerificationTokenRow & { is_expired: boolean }>(
    'SELECT *, (expires_at <= NOW()) as is_expired FROM email_verification_tokens WHERE token_hash = $1',
    [tokenHash]
  );

  if (!verificationToken) {
    res.status(400).json({ error: 'Invalid or expired verification token' });
    return;
  }

  if (verificationToken.used_at) {
    // Already used — just redirect to app
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
    res.redirect(`${frontendUrl}/?verified=already`);
    return;
  }

  if (verificationToken.is_expired) {
    res.status(400).json({ error: 'This verification token has expired. Please request a new one.' });
    return;
  }

  // Mark email as verified
  await execute(
    'UPDATE users SET email_verified_at = NOW(), updated_at = NOW() WHERE id = $1',
    [verificationToken.user_id]
  );

  // Mark token as used
  await execute(
    'UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1',
    [verificationToken.id]
  );

  // Emit WAL event
  const user = await queryOne<Pick<UserRow, 'email'>>('SELECT email FROM users WHERE id = $1', [verificationToken.user_id]);
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('email_verified', '', $1)",
    [JSON.stringify({ userId: verificationToken.user_id, email: user?.email })]
  );

  // Redirect to app with success indicator
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
  res.redirect(`${frontendUrl}/?verified=true`);
});

/**
 * @swagger
 * /api/auth/resend-verification:
 *   post:
 *     tags: [Auth]
 *     summary: Resend email verification link
 *     operationId: resendVerificationEmail
 *     description: Generates and sends a new email verification link for an unverified account, subject to rate limiting.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: "Verification email sent (if account exists)" }
 *       429: { description: "Too many verification requests" }
 */
router.post('/resend-verification', async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const trimmedEmail = email.trim().toLowerCase();
  const successMessage = 'If an account with that email exists and is unverified, a verification link has been sent.';

  const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'email_verified_at'>>('SELECT id, email, email_verified_at FROM users WHERE email = $1', [trimmedEmail]);

  if (!user) {
    // Don't reveal whether email exists
    res.json({ message: successMessage });
    return;
  }

  if (user.email_verified_at) {
    // Already verified
    res.json({ message: 'Email is already verified.' });
    return;
  }

  // Rate limit: max 3 verification requests per email per hour
  const rateRow = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::int as count FROM email_verification_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'",
    [user.id]
  );
  const recentCount = parseInt(rateRow?.count || '0', 10);

  if (recentCount >= VERIFICATION_RATE_LIMIT_PER_HOUR) {
    res.status(429).json({ error: 'Too many verification requests. Please try again later.' });
    return;
  }

  const rawToken = await generateAndStoreVerificationToken(user.id, trimmedEmail);

  res.json({
    message: successMessage,
    // Include token in dev mode
    ...(process.env.NODE_ENV !== 'production' && { verificationLink: `http://localhost:3030/api/auth/verify-email?token=${rawToken}` }),
  });
});

// ─── Password reset constants ───

const _RESET_TOKEN_EXPIRES_HOURS = 1;
const RESET_RATE_LIMIT_PER_HOUR = 3;

interface PasswordResetTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  used_at: string | null;
}

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset link
 *     operationId: forgotPassword
 *     description: Initiates the password reset flow by generating a reset token and logging the reset link for the given email.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: "If the email exists, a reset link has been sent" }
 *       400: { description: "Validation error" }
 *       429: { description: "Too many reset requests" }
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'Email is required' });
    return;
  }

  const trimmedEmail = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmedEmail)) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }

  // Always return success to prevent email enumeration
  const successMessage = 'If an account with that email exists, a password reset link has been sent.';

  const user = await queryOne<Pick<UserRow, 'id' | 'email'>>('SELECT id, email FROM users WHERE email = $1', [trimmedEmail]);
  if (!user) {
    // Don't reveal that the email doesn't exist
    res.json({ message: successMessage });
    return;
  }

  // Rate limit: max 3 reset requests per email per hour
  const rateRow = await queryOne<{ count: string }>(
    "SELECT COUNT(*)::int as count FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'",
    [user.id]
  );
  const recentCount = parseInt(rateRow?.count || '0', 10);

  if (recentCount >= RESET_RATE_LIMIT_PER_HOUR) {
    res.status(429).json({ error: 'Too many reset requests. Please try again later.' });
    return;
  }

  // Generate reset token
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(rawToken);
  const tokenId = crypto.randomUUID();

  await execute(
    "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')",
    [tokenId, user.id, tokenHash]
  );

  // Emit WAL event
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('password_reset_requested', '', $1)",
    [JSON.stringify({ userId: user.id, email: trimmedEmail })]
  );

  // Build reset link (for local dev, log to console; in production this would send an email)
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
  const resetLink = `${frontendUrl}/reset-password?token=${rawToken}`;

  // Log the reset link for local development (Rorca is a local-first tool)
  logger.info(`[auth] Password reset link for ${trimmedEmail}: ${resetLink}`);

  res.json({
    message: successMessage,
    // Include resetLink in dev mode so the user can see it
    ...(process.env.NODE_ENV !== 'production' && { resetLink }),
  });
});

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Reset password using a reset token
 *     operationId: resetPassword
 *     description: Sets a new password using a valid reset token and revokes all existing refresh tokens for the user.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token: { type: string }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: "Password reset successfully" }
 *       400: { description: "Invalid or expired token, or validation error" }
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Reset token is required' });
    return;
  }

  if (!newPassword || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'New password is required' });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const tokenHash = hashToken(token);
  const resetToken = await queryOne<PasswordResetTokenRow & { is_expired: boolean }>(
    'SELECT *, (expires_at <= NOW()) as is_expired FROM password_reset_tokens WHERE token_hash = $1',
    [tokenHash]
  );

  if (!resetToken) {
    res.status(400).json({ error: 'Invalid or expired reset token' });
    return;
  }

  if (resetToken.used_at) {
    res.status(400).json({ error: 'This reset token has already been used' });
    return;
  }

  if (resetToken.is_expired) {
    res.status(400).json({ error: 'This reset token has expired' });
    return;
  }

  // Update password
  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
  await execute(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [passwordHash, resetToken.user_id]
  );

  // Mark token as used
  await execute(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
    [resetToken.id]
  );

  // Invalidate all existing refresh tokens for this user (force re-login)
  await execute(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
    [resetToken.user_id]
  );

  // Emit WAL event
  const user = await queryOne<Pick<UserRow, 'email'>>('SELECT email FROM users WHERE id = $1', [resetToken.user_id]);
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('password_reset', '', $1)",
    [JSON.stringify({ userId: resetToken.user_id, email: user?.email })]
  );

  res.json({ message: 'Password has been reset successfully. Please sign in with your new password.' });
});

// ─── Account Deletion (GDPR Article 17) ───

/**
 * @swagger
 * /api/auth/account:
 *   delete:
 *     tags: [Auth]
 *     summary: Permanently delete user account and all associated data
 *     operationId: deleteUserAccount
 *     description: |
 *       Irreversible account deletion per GDPR Article 17 (Right to Erasure).
 *       Cancels active Stripe subscription, deletes all user data via CASCADE,
 *       and logs a final confirmation.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string, description: "Current password for confirmation" }
 *     responses:
 *       200: { description: "Account permanently deleted" }
 *       400: { description: "Password is required" }
 *       401: { description: "Not authenticated" }
 *       403: { description: "Incorrect password" }
 */
router.delete('/account', authRequired, async (req: Request, res: Response) => {
  const authReq = req as Request & { user: AuthUser };
  const { password } = req.body;

  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'Password is required to confirm account deletion' });
    return;
  }

  // Verify the user still exists
  const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'password_hash'>>(
    'SELECT id, email, password_hash FROM users WHERE id = $1',
    [authReq.user.id]
  );

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // GitHub-only accounts have unusable password hashes (prefix: "github:")
  if (user.password_hash.startsWith('github:')) {
    res.status(400).json({ error: 'GitHub-only accounts cannot be deleted via password. Please disconnect GitHub first and set a password.' });
    return;
  }

  // Verify password
  if (!(await bcrypt.compare(password, user.password_hash))) {
    res.status(403).json({ error: 'Incorrect password' });
    return;
  }

  // Cancel active Stripe subscription if present
  const subscription = await queryOne<{ stripe_subscription_id: string; stripe_customer_id: string }>(
    `SELECT stripe_subscription_id, stripe_customer_id FROM subscriptions
     WHERE user_id = $1 AND status IN ('active', 'past_due') AND stripe_subscription_id IS NOT NULL`,
    [user.id]
  );

  if (subscription?.stripe_subscription_id) {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey) {
      try {
        const stripe = new Stripe(stripeKey);
        await stripe.subscriptions.cancel(subscription.stripe_subscription_id);
      } catch (err) {
        logger.error({ err }, `[auth] Failed to cancel Stripe subscription ${subscription.stripe_subscription_id} for user ${user.id}`);
        // Proceed with deletion even if Stripe cancel fails — the webhook will eventually reconcile
      }
    }
  }

  // Emit WAL event BEFORE deletion (so we have an audit trail)
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('account_deleted', '', $1)",
    [JSON.stringify({ userId: user.id, email: user.email, deletedAt: new Date().toISOString() })]
  );

  // Delete user — ON DELETE CASCADE handles:
  // refresh_tokens, subscriptions, user_settings, github_connections, api_key_vault,
  // teams (owned), team_members, team_invites (sent), password_reset_tokens,
  // email_verification_tokens, notifications, notification_preferences, story_comments,
  // spec_assignments (assignee)
  await execute('DELETE FROM users WHERE id = $1', [user.id]);

  // Log final confirmation (Rorca is local-first; email would go here in production)
  logger.info(`[auth] Account deleted: ${user.email} (id: ${user.id}). All data permanently removed.`);

  res.json({ message: 'Your account and all associated data have been permanently deleted.' });
});

// ─── Token encryption helpers ───

export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(encryptedStr: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ─── GitHub OAuth helper: fetch from GitHub API ───

async function githubApiFetch<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

/**
 * @swagger
 * /api/auth/github:
 *   get:
 *     tags: [Auth]
 *     summary: Initiate GitHub OAuth flow
 *     operationId: initiateGithubOAuth
 *     description: Redirects the user to GitHub's authorization page to begin the OAuth login flow.
 *     security: []
 *     responses:
 *       302: { description: "Redirect to GitHub authorization URL" }
 *       500: { description: "GitHub OAuth not configured" }
 */
router.get('/github', (_req: Request, res: Response) => {
  const clientId = githubClientId();
  const clientSecret = githubClientSecret();
  const callbackUrl = githubCallbackUrl();
  if (!clientId || !clientSecret) {
    // Use relative redirect so it works on any host (local, VPS, custom domain)
    res.redirect('/auth/github/callback?error=github_not_configured');
    return;
  }

  const state = crypto.randomBytes(32).toString('hex');
  storeOAuthState(state);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: GITHUB_SCOPES,
    state,
  });

  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

/**
 * @swagger
 * /api/auth/github/callback:
 *   get:
 *     tags: [Auth]
 *     summary: GitHub OAuth callback
 *     operationId: handleGithubOAuthCallback
 *     description: Processes the GitHub OAuth callback by exchanging the authorization code for tokens and creating or linking the user account.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema: { type: string }
 *         description: Authorization code from GitHub
 *     responses:
 *       302: { description: "Redirect to frontend with tokens in URL fragment" }
 *       400: { description: "Missing authorization code" }
 */
router.get('/github/callback', async (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
  const { code, state, error: githubError } = req.query;

  // Handle user-denied consent from GitHub
  if (githubError === 'access_denied') {
    res.redirect(`${frontendUrl}/auth/github/callback?error=github_denied`);
    return;
  }

  if (!code || typeof code !== 'string') {
    res.redirect(`${frontendUrl}/auth/github/callback?error=missing_code`);
    return;
  }

  const cbClientId = githubClientId();
  const cbClientSecret = githubClientSecret();
  const cbCallbackUrl = githubCallbackUrl();
  if (!cbClientId || !cbClientSecret) {
    res.status(503).json({ error: 'GitHub OAuth not configured' });
    return;
  }

  // Validate CSRF state parameter
  if (!state || typeof state !== 'string' || !validateOAuthState(state)) {
    res.redirect(`${frontendUrl}/auth/github/callback?error=invalid_state`);
    return;
  }

  try {
    // 1. Exchange code for access token
    const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: cbClientId,
        client_secret: cbClientSecret,
        code,
        redirect_uri: cbCallbackUrl,
      }),
    });

    const tokenData = await tokenResp.json() as GitHubTokenResponse & { error?: string; error_description?: string };
    if (tokenData.error || !tokenData.access_token) {
      res.redirect(`${frontendUrl}/auth/github/callback?error=token_exchange_failed`);
      return;
    }

    const githubAccessToken = tokenData.access_token;
    const grantedScopes = tokenData.scope || GITHUB_SCOPES;

    // 2. Fetch GitHub user profile
    const githubUser = await githubApiFetch<GitHubUser>('https://api.github.com/user', githubAccessToken);
    const githubUserId = String(githubUser.id);
    const githubUsername = githubUser.login;
    const githubAvatarUrl = githubUser.avatar_url;

    // 3. Fetch verified primary email
    let primaryEmail = githubUser.email;
    if (!primaryEmail) {
      const emails = await githubApiFetch<GitHubEmail[]>('https://api.github.com/user/emails', githubAccessToken);
      const primary = emails.find(e => e.primary && e.verified);
      if (!primary) {
        res.redirect(`${frontendUrl}/auth/github/callback?error=no_verified_email`);
        return;
      }
      primaryEmail = primary.email;
    }
    primaryEmail = primaryEmail.toLowerCase().trim();

    // 4. Find or create user, link GitHub connection
    // Check if a github_connection already exists for this GitHub user
    const existingConnection = await queryOne<GitHubConnectionRow>(
      'SELECT * FROM github_connections WHERE github_user_id = $1',
      [githubUserId]
    );

    let userId: string;
    let userEmail: string;
    let displayName: string;

    if (existingConnection) {
      // Returning GitHub user — update their token
      userId = existingConnection.user_id;
      const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
      userEmail = user!.email;
      displayName = user!.display_name;

      // Update encrypted token and scopes
      await execute(
        'UPDATE github_connections SET encrypted_token = $1, scopes = $2, github_username = $3, updated_at = NOW() WHERE id = $4',
        [encryptToken(githubAccessToken), grantedScopes, githubUsername, existingConnection.id]
      );
      // Update github_login and avatar_url on user
      await execute(
        'UPDATE users SET github_login = $1, avatar_url = COALESCE($2, avatar_url), updated_at = NOW() WHERE id = $3',
        [githubUsername, githubAvatarUrl ?? null, userId]
      );
    } else {
      // Check if a user with this email already exists (account linking)
      const existingUser = await queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [primaryEmail]);

      if (existingUser) {
        // Link GitHub to existing email-based account
        userId = existingUser.id;
        userEmail = existingUser.email;
        displayName = existingUser.display_name;

        // Set github_id and github_login on user
        await execute(
          'UPDATE users SET github_id = $1, github_login = $2, avatar_url = COALESCE($3, avatar_url), updated_at = NOW() WHERE id = $4',
          [githubUserId, githubUsername, githubAvatarUrl ?? null, userId]
        );
      } else {
        // Create new user (no password — GitHub-only account)
        userId = crypto.randomUUID();
        userEmail = primaryEmail;
        displayName = githubUsername;

        // Use a random unusable password hash for GitHub-only users
        const noPasswordHash = `github:${crypto.randomBytes(32).toString('hex')}`;
        await execute(
          'INSERT INTO users (id, email, display_name, password_hash, github_id, github_login, avatar_url, email_verified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
          [userId, userEmail, displayName, noPasswordHash, githubUserId, githubUsername, githubAvatarUrl ?? null]
        );
      }

      // GitHub verifies emails — mark as verified if not already
      await execute(
        'UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1',
        [userId]
      );

      // Create github_connection
      const connectionId = crypto.randomUUID();
      await execute(
        'INSERT INTO github_connections (id, user_id, github_user_id, encrypted_token, scopes, github_username) VALUES ($1, $2, $3, $4, $5, $6)',
        [connectionId, userId, githubUserId, encryptToken(githubAccessToken), grantedScopes, githubUsername]
      );
    }

    // 5. Store GitHub access token in api_key_vault (encrypted, namespaced by provider=github, label=oauth)
    const encryptedVaultToken = encryptToken(githubAccessToken);
    const existingVaultEntry = await queryOne<{ id: string }>(
      "SELECT id FROM api_key_vault WHERE user_id = $1 AND provider = 'github' AND label = 'oauth'",
      [userId]
    );
    if (existingVaultEntry) {
      await execute(
        'UPDATE api_key_vault SET encrypted_key = $1 WHERE id = $2',
        [encryptedVaultToken, existingVaultEntry.id]
      );
    } else {
      await execute(
        "INSERT INTO api_key_vault (id, user_id, provider, encrypted_key, label) VALUES ($1, $2, 'github', $3, 'oauth')",
        [crypto.randomUUID(), userId, encryptedVaultToken]
      );
    }

    // 6. Generate JWT + refresh token pair (same as email login)
    const accessToken = generateAccessToken(userId, userEmail);
    const refreshToken = generateRefreshToken();
    await storeRefreshToken(userId, refreshToken);

    // Emit WAL event
    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_login', '', $1)",
      [JSON.stringify({ userId, email: userEmail, githubUserId, githubUsername })]
    );

    // US-044: Set CSRF double-submit cookie on session creation
    setCsrfCookie(res, generateCsrfToken());

    // 7. Set tokens as httpOnly cookies and redirect frontend to the callback page
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('rorca_access_token', accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutes
    });
    res.cookie('rorca_refresh_token', refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
    });

    // Also pass tokens in fragment for backwards-compat with existing AuthContext
    const fragment = new URLSearchParams({ accessToken, refreshToken }).toString();
    res.redirect(`${frontendUrl}/auth/github/callback#${fragment}`);
  } catch (err) {
    logger.error({ err }, '[auth] GitHub OAuth callback error');
    res.redirect(`${frontendUrl}/auth/github/callback?error=github_error`);
  }
});

// Auth middleware — verifies JWT access token from Authorization header
/** Internal service token for scheduler→trigger calls (not exposed externally) */
export const INTERNAL_SERVICE_TOKEN = `rorca-internal-${process.pid}`;

export async function authRequired(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Allow internal scheduler calls (same-process only, token includes PID)
  if (req.headers['x-rorca-internal'] === INTERNAL_SERVICE_TOKEN) {
    req.user = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'scheduler@rorca.internal',
      supabaseId: '00000000-0000-0000-0000-000000000000',
      role: 'admin',
    };
    next();
    return;
  }

  if (!SUPABASE_AUTH_ENABLED) {
    req.user = LOCAL_ADMIN;
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    const user = data.user;
    if (error || !user?.id || !user.email) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      supabaseId: user.id,
      role: 'admin',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

/** @deprecated Use authRequired instead */
export const requireAuth = authRequired;

// ─── Role-based permission middleware ───

export type TeamRole = 'admin' | 'editor' | 'viewer';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

/**
 * Middleware factory that enforces a minimum team role for the request.
 * Extracts teamId from req.params.teamId, req.params.id (team routes),
 * req.query.teamId, or req.body.teamId.
 *
 * Must be used AFTER authRequired (user must be authenticated).
 */
export function requireRole(minRole: TeamRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const teamId =
      req.params.teamId ||
      req.params.id ||
      (req.query.teamId as string) ||
      req.body?.teamId;

    if (!teamId) {
      res.status(400).json({ error: 'Team ID is required' });
      return;
    }

    // System user (internal scheduler) bypasses role checks
    if (user.id === 'system') {
      next();
      return;
    }

    const membership = await queryOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, user.id]
    );

    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this team' });
      return;
    }

    const userLevel = ROLE_HIERARCHY[membership.role as TeamRole];
    const requiredLevel = ROLE_HIERARCHY[minRole];

    if (userLevel === undefined || userLevel < requiredLevel) {
      res.status(403).json({ error: `Insufficient permissions: requires ${minRole} role` });
      return;
    }

    // Attach team role to request for downstream use
    (req as Request & { user: AuthUser; teamRole: TeamRole }).teamRole = membership.role as TeamRole;
    next();
  };
}

export default router;
