/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { csrfProtection, generateCsrfToken, setCsrfCookie } from '../csrf';
import { CsrfError } from '../errors';
import type { Request, Response, NextFunction } from 'express';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/specs',
    originalUrl: '/api/specs',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {
    cookie: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
}

describe('generateCsrfToken', () => {
  test('returns a 64-char hex string (32 bytes)', () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('generates unique tokens', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
  });
});

describe('setCsrfCookie', () => {
  test('sets _csrf cookie with correct flags (dev)', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    setCsrfCookie(res, 'test-token');
    expect(res.cookie).toHaveBeenCalledWith('_csrf', 'test-token', {
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
      path: '/',
    });
    process.env.NODE_ENV = origEnv;
  });

  test('sets Secure flag in production', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    setCsrfCookie(res, 'token');
    expect(res.cookie).toHaveBeenCalledWith('_csrf', 'token', expect.objectContaining({
      secure: true,
    }));
    process.env.NODE_ENV = origEnv;
  });
});

describe('csrfProtection middleware', () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => {
    (next as jest.Mock).mockClear();
  });

  // ─── GET requests bypass CSRF ───

  test('GET requests pass through without CSRF check', () => {
    const req = mockReq({ method: 'GET' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('HEAD requests pass through', () => {
    const req = mockReq({ method: 'HEAD' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('OPTIONS requests pass through', () => {
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // ─── Exempt paths ───

  test('webhook paths are exempt', () => {
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/webhooks/github',
      headers: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('health check is exempt', () => {
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/health',
      headers: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('login is exempt', () => {
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/auth/login',
      headers: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('register is exempt', () => {
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/auth/register',
      headers: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('billing webhook is exempt', () => {
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/billing/webhook',
      headers: {},
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('POST without _csrf cookie throws CsrfError', () => {
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/specs/generate',
      headers: {},
    });
    const res = mockRes();
    expect(() => csrfProtection(req, res, next)).toThrow(CsrfError);
    expect(() => csrfProtection(req, res, next)).toThrow('Missing CSRF cookie');
  });

  // ─── Cookie present, header missing → 403 ───

  test('POST with _csrf cookie but no X-CSRF-Token header → CsrfError', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/specs/generate',
      headers: { cookie: `_csrf=${token}` },
    });
    const res = mockRes();
    expect(() => csrfProtection(req, res, next)).toThrow(CsrfError);
    expect(() => csrfProtection(req, res, next)).toThrow('Missing CSRF token header');
    expect(next).not.toHaveBeenCalled();
  });

  // ─── Cookie present, header mismatched → 403 ───

  test('POST with mismatched X-CSRF-Token → CsrfError', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/specs/generate',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': 'wrong-token-value',
      },
    });
    const res = mockRes();
    expect(() => csrfProtection(req, res, next)).toThrow(CsrfError);
    expect(() => csrfProtection(req, res, next)).toThrow('CSRF token mismatch');
  });

  // ─── Cookie present, header matches → pass ───

  test('POST with matching X-CSRF-Token passes through', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/specs/generate',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('PUT with matching token passes through', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'PUT',
      originalUrl: '/api/direction',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('PATCH with matching token passes through', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'PATCH',
      originalUrl: '/api/auth/me',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('DELETE with matching token passes through', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'DELETE',
      originalUrl: '/api/skills/react',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': token,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // ─── Cookie parsing with multiple cookies ───

  test('parses _csrf from a multi-cookie header', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/specs/generate',
      headers: {
        cookie: `session=abc123; _csrf=${token}; theme=dark`,
        'x-csrf-token': token,
      },
    });
    const res = mockRes();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  // ─── Length mismatch doesn't crash ───

  test('different length tokens return mismatch, not crash', () => {
    const token = generateCsrfToken();
    const req = mockReq({
      method: 'POST',
      originalUrl: '/api/specs',
      headers: {
        cookie: `_csrf=${token}`,
        'x-csrf-token': 'short',
      },
    });
    const res = mockRes();
    expect(() => csrfProtection(req, res, next)).toThrow('CSRF token mismatch');
  });
});
