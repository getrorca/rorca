/**
 * Project Aegis — CLI-045: MCP Bearer Token Authentication
 *
 * Replaces the no-op OAuth theater with a Unix-style Bearer token check.
 * Token lives at ~/.rorca/mcp-token (mode 0600). MCP clients authenticate
 * with `Authorization: Bearer <token>`. Constant-time comparison prevents
 * timing attacks. No grace period — hard cutover from unauthenticated /mcp.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger';

// ─── Paths ──────────────────────────────────────────────────────────────────

const RORCA_DIR = path.join(os.homedir(), '.rorca');
const PUBLIC_TOKEN_PATH = path.join(RORCA_DIR, 'mcp-token');

export function getMcpTokenPath(): string {
  return PUBLIC_TOKEN_PATH;
}

// ─── In-memory cache ────────────────────────────────────────────────────────
// Read once at startup, re-read on rotation. Avoids fs.readFileSync per request.

let _cachedToken: string | null = null;

export function invalidateTokenCache(): void {
  _cachedToken = null;
}

export function getMcpToken(): string | null {
  if (_cachedToken !== null) return _cachedToken;
  try {
    const raw = fs.readFileSync(PUBLIC_TOKEN_PATH, 'utf8').trim();
    if (raw.length === 0) return null;
    _cachedToken = raw;
    return _cachedToken;
  } catch {
    return null;
  }
}

// ─── Generation + storage ───────────────────────────────────────────────────

/** 64-hex-char (32 bytes) cryptographically random token. */
export function generateMcpToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Ensure the MCP token file exists. Creates ~/.rorca/ (mode 0700) and
 * the token file (mode 0600) on first run. Idempotent — re-running
 * returns the existing token.
 *
 * Throws if the file mode after write is wrong (umask defense).
 */
export function ensureMcpToken(): { token: string; created: boolean } {
  // Ensure ~/.rorca/ exists with restrictive perms
  if (!fs.existsSync(RORCA_DIR)) {
    fs.mkdirSync(RORCA_DIR, { recursive: true, mode: 0o700 });
  }

  // Token already exists — load and return
  if (fs.existsSync(PUBLIC_TOKEN_PATH)) {
    const existing = fs.readFileSync(PUBLIC_TOKEN_PATH, 'utf8').trim();
    if (existing.length > 0) {
      _cachedToken = existing;
      return { token: existing, created: false };
    }
  }

  // Generate + write atomically
  const token = generateMcpToken();
  const tmpPath = `${PUBLIC_TOKEN_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, token, { mode: 0o600 });
  fs.renameSync(tmpPath, PUBLIC_TOKEN_PATH);

  // Verify mode — defense against umask quirks
  const stat = fs.statSync(PUBLIC_TOKEN_PATH);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `[MCP Aegis] Token file mode is ${mode.toString(8)} after write — expected 600. ` +
      `Check your umask. Token file: ${PUBLIC_TOKEN_PATH}`
    );
  }

  _cachedToken = token;
  return { token, created: true };
}

/**
 * Atomic rotation. Writes a new token; old token immediately invalid.
 * Caller is responsible for warning the user that existing MCP clients
 * need re-setup (`rorca mcp setup-claude`).
 */
export function rotateMcpToken(): string {
  const newToken = generateMcpToken();
  const tmpPath = `${PUBLIC_TOKEN_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, newToken, { mode: 0o600 });
  fs.renameSync(tmpPath, PUBLIC_TOKEN_PATH);
  _cachedToken = newToken;
  return newToken;
}

// ─── Express middleware ─────────────────────────────────────────────────────

/**
 * Reject any /mcp request lacking a valid Bearer token.
 * Uses crypto.timingSafeEqual for constant-time comparison.
 */
export const requireMcpAuth: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Missing Bearer token',
      code: 'MCP_AUTH_REQUIRED',
      hint: 'Run `rorca mcp setup-claude` to configure your MCP client, or read ~/.rorca/mcp-token directly.',
    });
    return;
  }

  const provided = authHeader.slice(7).trim();
  const expected = getMcpToken();

  if (!expected) {
    res.status(503).json({
      error: 'MCP token not initialized',
      code: 'MCP_TOKEN_NOT_INITIALIZED',
      hint: 'Restart rorca to generate a token.',
    });
    return;
  }

  // Both buffers must be the same length for timingSafeEqual.
  // If lengths differ, comparison is structurally false — but we still need
  // a constant-time check to avoid leaking length info.
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

  if (providedBuf.length !== expectedBuf.length) {
    // Run a dummy timingSafeEqual against itself to keep timing consistent
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    res.status(401).json({ error: 'Invalid Bearer token', code: 'MCP_AUTH_INVALID' });
    return;
  }

  if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    res.status(401).json({ error: 'Invalid Bearer token', code: 'MCP_AUTH_INVALID' });
    return;
  }

  next();
};

// ─── Localhost-only enforcement (CLI-046 preview — kept here for cohesion) ──
// Defense in depth: even if MCP_ALLOW_REMOTE is set, this lets us audit one
// place for "where is MCP allowed to be reached from."

/**
 * Reject MCP requests that didn't originate from localhost, unless the
 * operator explicitly opts in via RORCA_MCP_ALLOW_REMOTE=true (cloud
 * deployments behind TLS terminator).
 */
export const requireLocalhost: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const remote = req.socket.remoteAddress;
  const isLocal =
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1';
  const allowRemote = process.env.RORCA_MCP_ALLOW_REMOTE === 'true';

  if (!isLocal && !allowRemote) {
    res.status(403).json({
      error: 'MCP only accessible from localhost',
      code: 'MCP_REMOTE_FORBIDDEN',
      hint: 'Set RORCA_MCP_ALLOW_REMOTE=true to enable (NOT recommended without an auth proxy).',
    });
    return;
  }
  next();
};

// ─── Startup logging helper ─────────────────────────────────────────────────

export function logMcpTokenStatus(created: boolean): void {
  if (created) {
    logger.info(`[MCP Aegis] Generated new MCP token at ${PUBLIC_TOKEN_PATH} (mode 0600)`);
    logger.info('[MCP Aegis] Run `rorca mcp setup-claude` to configure your MCP client');
  } else {
    logger.info('[MCP Aegis] Loaded existing MCP token');
  }
}
