/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for CLI-045 (Project Aegis): MCP Bearer token authentication.
 *
 * Covers: token generation, file mode, atomic rotation, middleware
 * accept/reject paths, timing-safe comparison, localhost guard.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response } from 'express';

// Override homedir BEFORE importing the module under test so the token
// path resolves into a temp directory we can clean up between tests.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-auth-test-'));
jest.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);

import {
  generateMcpToken,
  ensureMcpToken,
  rotateMcpToken,
  getMcpToken,
  getMcpTokenPath,
  invalidateTokenCache,
  requireMcpAuth,
  requireLocalhost,
} from './mcp-auth';

afterAll(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset state between tests: clear cache + delete the token file
  invalidateTokenCache();
  const tokenPath = getMcpTokenPath();
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
});

// ─── Token generation ───────────────────────────────────────────────────────

describe('generateMcpToken', () => {
  it('produces 64 hex chars (32 bytes)', () => {
    const t = generateMcpToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different values on each call', () => {
    expect(generateMcpToken()).not.toBe(generateMcpToken());
  });
});

// ─── ensureMcpToken: first run + idempotency ────────────────────────────────

describe('ensureMcpToken', () => {
  it('creates the token file with mode 0600 on first run', () => {
    const result = ensureMcpToken();
    expect(result.created).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);

    const stat = fs.statSync(getMcpTokenPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('creates ~/.rorca/ directory if missing', () => {
    expect(fs.existsSync(path.join(TEST_HOME, '.rorca'))).toBe(false);
    ensureMcpToken();
    expect(fs.existsSync(path.join(TEST_HOME, '.rorca'))).toBe(true);
  });

  it('is idempotent — second call returns existing token', () => {
    const first = ensureMcpToken();
    const second = ensureMcpToken();
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });
});

// ─── rotateMcpToken ─────────────────────────────────────────────────────────

describe('rotateMcpToken', () => {
  it('generates a new token and invalidates the old one', () => {
    const { token: original } = ensureMcpToken();
    const rotated = rotateMcpToken();
    expect(rotated).not.toBe(original);
    expect(getMcpToken()).toBe(rotated);
  });

  it('preserves mode 0600 after rotation', () => {
    ensureMcpToken();
    rotateMcpToken();
    const stat = fs.statSync(getMcpTokenPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

// ─── requireMcpAuth middleware ──────────────────────────────────────────────

function makeReq(authHeader?: string): Partial<Request> {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  };
}

function makeRes(): { res: Partial<Response>; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  return {
    res: { status: status as unknown as Response['status'] },
    status,
    json,
  };
}

describe('requireMcpAuth', () => {
  it('rejects requests with no Authorization header (401 MCP_AUTH_REQUIRED)', () => {
    ensureMcpToken();
    const next = jest.fn();
    const { res, status, json } = makeRes();
    requireMcpAuth(makeReq() as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MCP_AUTH_REQUIRED' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects non-Bearer Authorization headers', () => {
    ensureMcpToken();
    const next = jest.fn();
    const { res, status } = makeRes();
    requireMcpAuth(makeReq('Basic dXNlcjpwYXNz') as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects an invalid Bearer token (401 MCP_AUTH_INVALID)', () => {
    ensureMcpToken();
    const next = jest.fn();
    const { res, status, json } = makeRes();
    const wrong = '0'.repeat(64);
    requireMcpAuth(makeReq(`Bearer ${wrong}`) as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MCP_AUTH_INVALID' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a Bearer token with wrong length (still constant-time)', () => {
    ensureMcpToken();
    const next = jest.fn();
    const { res, status } = makeRes();
    requireMcpAuth(makeReq('Bearer too-short') as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts the correct Bearer token and calls next()', () => {
    const { token } = ensureMcpToken();
    const next = jest.fn();
    const { res, status } = makeRes();
    requireMcpAuth(makeReq(`Bearer ${token}`) as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('returns 503 when token file is missing', () => {
    // Don't call ensureMcpToken — file doesn't exist
    const next = jest.fn();
    const { res, status, json } = makeRes();
    requireMcpAuth(makeReq('Bearer doesnt-matter') as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MCP_TOKEN_NOT_INITIALIZED' }));
  });

  it('rejects after token rotation with old token', () => {
    const { token: oldToken } = ensureMcpToken();
    rotateMcpToken();

    const next = jest.fn();
    const { res, status } = makeRes();
    requireMcpAuth(makeReq(`Bearer ${oldToken}`) as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('uses constant-time comparison (timing equality not exposed)', () => {
    // Spy crypto.timingSafeEqual to verify it's the comparison primitive in use
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    const { token } = ensureMcpToken();
    const next = jest.fn();
    const { res } = makeRes();
    requireMcpAuth(makeReq(`Bearer ${token}`) as Request, res as Response, next);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ─── requireLocalhost middleware ────────────────────────────────────────────

function makeReqWithRemote(remoteAddress: string): Partial<Request> {
  return { socket: { remoteAddress } as Request['socket'], headers: {} };
}

describe('requireLocalhost', () => {
  beforeEach(() => {
    delete process.env.RORCA_MCP_ALLOW_REMOTE;
  });

  it('accepts 127.0.0.1', () => {
    const next = jest.fn();
    const { res, status } = makeRes();
    requireLocalhost(makeReqWithRemote('127.0.0.1') as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('accepts ::1 (IPv6 loopback)', () => {
    const next = jest.fn();
    const { res, status } = makeRes();
    requireLocalhost(makeReqWithRemote('::1') as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('accepts ::ffff:127.0.0.1 (IPv4-mapped IPv6)', () => {
    const next = jest.fn();
    const { res, status } = makeRes();
    requireLocalhost(makeReqWithRemote('::ffff:127.0.0.1') as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects non-localhost IPs by default (403 MCP_REMOTE_FORBIDDEN)', () => {
    const next = jest.fn();
    const { res, status, json } = makeRes();
    requireLocalhost(makeReqWithRemote('10.0.0.5') as Request, res as Response, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MCP_REMOTE_FORBIDDEN' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('allows non-localhost when RORCA_MCP_ALLOW_REMOTE=true', () => {
    process.env.RORCA_MCP_ALLOW_REMOTE = 'true';
    const next = jest.fn();
    const { res, status } = makeRes();
    requireLocalhost(makeReqWithRemote('10.0.0.5') as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
