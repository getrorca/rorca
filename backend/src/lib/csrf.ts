import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { CsrfError } from './errors';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const EXEMPT_PREFIXES = [
  '/api/webhooks',
  '/mcp',
  '/api/health',
  '/api/docs',
  '/api/auth/csrf-token',
  '/api/billing/webhook',
];

/**
 * Generate a cryptographically random CSRF token (32 bytes, hex encoded).
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Set the _csrf cookie on the response.
 */
export function setCsrfCookie(res: Response, token: string): void {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('_csrf', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    path: '/',
  });
}

/**
 * Double-submit cookie CSRF middleware.
 *
 * - Skips non-state-changing methods (GET, HEAD, OPTIONS).
 * - Skips exempt paths (webhooks, docs, health, auth bootstrap, MCP).
 * - Requires both _csrf cookie and X-CSRF-Token header.
 * - If header and cookie values don't match, returns 403.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    next();
    return;
  }

  const reqPath = req.originalUrl || req.path;
  for (const prefix of EXEMPT_PREFIXES) {
    if (reqPath.startsWith(prefix)) {
      next();
      return;
    }
  }

  // Read the _csrf cookie from the Cookie header (no cookie-parser dependency needed)
  const cookieValue = parseCsrfCookie(req.headers.cookie || '');

  if (!cookieValue) {
    throw new CsrfError('Missing CSRF cookie');
  }

  const headerValue = req.headers['x-csrf-token'] as string | undefined;

  if (!headerValue) {
    throw new CsrfError('Missing CSRF token header');
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(cookieValue, headerValue)) {
    throw new CsrfError('CSRF token mismatch');
  }

  next();
}

function parseCsrfCookie(cookieHeader: string): string | undefined {
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name === '_csrf') {
      return rest.join('=');
    }
  }
  return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
