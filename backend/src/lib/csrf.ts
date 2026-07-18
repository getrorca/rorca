/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { CsrfError } from './errors';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const EXEMPT_EXACT_PATHS = new Set([
  '/api/webhooks/github',
  '/api/webhooks/linear',
  '/api/webhooks/vercel',
  '/api/webhooks/slack',
  '/api/auth/csrf-token',
]);

const EXEMPT_PREFIXES = ['/mcp', '/api/health', '/api/docs'];
const WEBHOOK_ADMIN_REPLAY = /^\/api\/webhooks\/dlq\/[1-9][0-9]*\/retry$/;

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
 * - Skips exact provider callbacks plus docs, health, auth bootstrap, and MCP.
 * - Never applies the no-Origin bypass to explicit webhook administration replay.
 * - Requires both _csrf cookie and X-CSRF-Token header.
 * - If header and cookie values don't match, returns 403.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (!STATE_CHANGING_METHODS.has(req.method)) {
    next();
    return;
  }

  const reqPath = (req.originalUrl || req.path).split('?', 1)[0];
  if (EXEMPT_EXACT_PATHS.has(reqPath) || EXEMPT_PREFIXES.some((prefix) => reqPath.startsWith(prefix))) {
    next();
    return;
  }

  // Server-to-server requests (MCP, CLI tools, curl) have no Origin header.
  // Explicit admin replay is intentionally excluded from this bypass.
  if (!req.headers.origin && !WEBHOOK_ADMIN_REPLAY.test(reqPath)) {
    next();
    return;
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
