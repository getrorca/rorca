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

// GitHub OAuth config
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3030/api/auth/github/callback';
const GITHUB_SCOPES = 'user:email repo';

// Encryption key for GitHub tokens at rest — derived from JWT_SECRET via SHA256 to get 32 bytes
const ENCRYPTION_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();
const ENCRYPTION_ALGO = 'aes-256-gcm' as const;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  github_id: string | null;
  role: string;
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

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

function storeRefreshToken(userId: string, rawToken: string): void {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, tokenHash, expiresAt);
}

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new user
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

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Authenticate and get tokens
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

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh access token (token rotation)
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

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Revoke a refresh token
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

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
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
router.get('/me', authRequired, (req: Request, res: Response) => {
  const authReq = req as Request & { user: AuthUser };
  const user = db.prepare(
    'SELECT id, email, display_name, github_id FROM users WHERE id = ?'
  ).get(authReq.user.id) as Pick<UserRow, 'id' | 'email' | 'display_name' | 'github_id'> | undefined;

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
    },
  });
});

// ─── Password reset constants ───

const RESET_TOKEN_EXPIRES_HOURS = 1;
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
router.post('/forgot-password', (req: Request, res: Response) => {
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

  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(trimmedEmail) as Pick<UserRow, 'id' | 'email'> | undefined;
  if (!user) {
    // Don't reveal that the email doesn't exist
    res.json({ message: successMessage });
    return;
  }

  // Rate limit: max 3 reset requests per email per hour
  const recentCount = (db.prepare(
    "SELECT COUNT(*) as count FROM password_reset_tokens WHERE user_id = ? AND created_at > datetime('now', '-1 hour')"
  ).get(user.id) as { count: number }).count;

  if (recentCount >= RESET_RATE_LIMIT_PER_HOUR) {
    res.status(429).json({ error: 'Too many reset requests. Please try again later.' });
    return;
  }

  // Generate reset token
  const rawToken = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(rawToken);
  const tokenId = crypto.randomUUID();

  db.prepare(
    "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))"
  ).run(tokenId, user.id, tokenHash);

  // Emit WAL event
  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('password_reset_requested', '', ?)"
  ).run(JSON.stringify({ userId: user.id, email: trimmedEmail }));

  // Build reset link (for local dev, log to console; in production this would send an email)
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
  const resetLink = `${frontendUrl}/reset-password?token=${rawToken}`;

  // Log the reset link for local development (Rorcha is a local-first tool)
  console.log(`[auth] Password reset link for ${trimmedEmail}: ${resetLink}`);

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
router.post('/reset-password', (req: Request, res: Response) => {
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
  const resetToken = db.prepare(
    'SELECT *, (expires_at <= datetime(\'now\')) as is_expired FROM password_reset_tokens WHERE token_hash = ?'
  ).get(tokenHash) as (PasswordResetTokenRow & { is_expired: number }) | undefined;

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
  const passwordHash = bcrypt.hashSync(newPassword, BCRYPT_COST);
  db.prepare(
    "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(passwordHash, resetToken.user_id);

  // Mark token as used
  db.prepare(
    "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?"
  ).run(resetToken.id);

  // Invalidate all existing refresh tokens for this user (force re-login)
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"
  ).run(resetToken.user_id);

  // Emit WAL event
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(resetToken.user_id) as Pick<UserRow, 'email'> | undefined;
  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('password_reset', '', ?)"
  ).run(JSON.stringify({ userId: resetToken.user_id, email: user?.email }));

  res.json({ message: 'Password has been reset successfully. Please sign in with your new password.' });
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
 *     security: []
 *     responses:
 *       302: { description: "Redirect to GitHub authorization URL" }
 *       500: { description: "GitHub OAuth not configured" }
 */
router.get('/github', (_req: Request, res: Response) => {
  if (!GITHUB_CLIENT_ID) {
    res.status(500).json({ error: 'GitHub OAuth not configured: GITHUB_CLIENT_ID missing' });
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_CALLBACK_URL,
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
  const { code } = req.query;

  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Authorization code is required' });
    return;
  }

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    res.status(500).json({ error: 'GitHub OAuth not configured' });
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
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_CALLBACK_URL,
      }),
    });

    const tokenData = await tokenResp.json() as GitHubTokenResponse & { error?: string; error_description?: string };
    if (tokenData.error || !tokenData.access_token) {
      res.status(401).json({ error: tokenData.error_description || 'Failed to exchange authorization code' });
      return;
    }

    const githubAccessToken = tokenData.access_token;
    const grantedScopes = tokenData.scope || GITHUB_SCOPES;

    // 2. Fetch GitHub user profile
    const githubUser = await githubApiFetch<GitHubUser>('https://api.github.com/user', githubAccessToken);
    const githubUserId = String(githubUser.id);
    const githubUsername = githubUser.login;

    // 3. Fetch verified primary email
    let primaryEmail = githubUser.email;
    if (!primaryEmail) {
      const emails = await githubApiFetch<GitHubEmail[]>('https://api.github.com/user/emails', githubAccessToken);
      const primary = emails.find(e => e.primary && e.verified);
      if (!primary) {
        res.status(400).json({ error: 'No verified primary email found on GitHub account' });
        return;
      }
      primaryEmail = primary.email;
    }
    primaryEmail = primaryEmail.toLowerCase().trim();

    // 4. Find or create user, link GitHub connection
    // Check if a github_connection already exists for this GitHub user
    const existingConnection = db.prepare(
      'SELECT * FROM github_connections WHERE github_user_id = ?'
    ).get(githubUserId) as GitHubConnectionRow | undefined;

    let userId: string;
    let userEmail: string;
    let displayName: string;

    if (existingConnection) {
      // Returning GitHub user — update their token
      userId = existingConnection.user_id;
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow;
      userEmail = user.email;
      displayName = user.display_name;

      // Update encrypted token and scopes
      db.prepare(
        "UPDATE github_connections SET encrypted_token = ?, scopes = ?, github_username = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(encryptToken(githubAccessToken), grantedScopes, githubUsername, existingConnection.id);
    } else {
      // Check if a user with this email already exists (account linking)
      const existingUser = db.prepare('SELECT * FROM users WHERE email = ?').get(primaryEmail) as UserRow | undefined;

      if (existingUser) {
        // Link GitHub to existing email-based account
        userId = existingUser.id;
        userEmail = existingUser.email;
        displayName = existingUser.display_name;

        // Set github_id on user
        db.prepare("UPDATE users SET github_id = ?, updated_at = datetime('now') WHERE id = ?").run(githubUserId, userId);
      } else {
        // Create new user (no password — GitHub-only account)
        userId = crypto.randomUUID();
        userEmail = primaryEmail;
        displayName = githubUsername;

        // Use a random unusable password hash for GitHub-only users
        const noPasswordHash = `github:${crypto.randomBytes(32).toString('hex')}`;
        db.prepare(
          'INSERT INTO users (id, email, display_name, password_hash, github_id) VALUES (?, ?, ?, ?, ?)'
        ).run(userId, userEmail, displayName, noPasswordHash, githubUserId);
      }

      // Create github_connection
      const connectionId = crypto.randomUUID();
      db.prepare(
        'INSERT INTO github_connections (id, user_id, github_user_id, encrypted_token, scopes, github_username) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(connectionId, userId, githubUserId, encryptToken(githubAccessToken), grantedScopes, githubUsername);
    }

    // 5. Generate JWT + refresh token pair (same as email login)
    const accessToken = generateAccessToken(userId, userEmail);
    const refreshToken = generateRefreshToken();
    storeRefreshToken(userId, refreshToken);

    // Emit WAL event
    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_login', '', ?)"
    ).run(JSON.stringify({ userId, email: userEmail, githubUserId, githubUsername }));

    // Redirect to frontend with tokens in URL fragment (fragments aren't sent to servers)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
    const fragment = new URLSearchParams({
      accessToken,
      refreshToken,
    }).toString();
    res.redirect(`${frontendUrl}/auth/github/callback#${fragment}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error during GitHub OAuth';
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
    res.redirect(`${frontendUrl}/auth/github/callback#error=${encodeURIComponent(message)}`);
  }
});

// Auth middleware — verifies JWT access token from Authorization header
/** Internal service token for scheduler→trigger calls (not exposed externally) */
export const INTERNAL_SERVICE_TOKEN = `rorcha-internal-${process.pid}`;

export function authRequired(req: Request, res: Response, next: NextFunction): void {
  // Allow internal scheduler calls (same-process only, token includes PID)
  if (req.headers['x-rorcha-internal'] === INTERNAL_SERVICE_TOKEN) {
    (req as Request & { user: AuthUser }).user = { id: 'system', email: 'scheduler@rorcha.internal', role: 'admin' };
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { sub: string; email: string };

    // Look up user to get role
    const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(decoded.sub) as
      | Pick<UserRow, 'id' | 'email' | 'role'>
      | undefined;

    if (!user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    (req as Request & { user: AuthUser }).user = {
      id: user.id,
      email: user.email,
      role: user.role,
    };
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
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
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user: AuthUser }).user;
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

    const membership = db
      .prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, user.id) as { role: string } | undefined;

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
