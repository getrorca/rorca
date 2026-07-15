/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { paramsHash, recordMcpCall } from './mcp-audit';
import { logger } from './logger';

export type McpTier = 'public' | 'admin';

type TokenTierOrDenied = McpTier | 'denied';
type McpToolTierResolver = (toolName: string) => McpTier;

interface EnsureMcpTokenResult {
  token: string;
  created: boolean;
  publicToken: string;
  adminToken: string;
  publicCreated: boolean;
  adminCreated: boolean;
}

let cachedPublicToken: string | null = null;
let cachedAdminToken: string | null = null;

export const MCP_ALLOWED_ORIGINS = [
  'http://localhost:3030',
  'http://127.0.0.1:3030',
] as const;

export function generateMcpToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function getHomeDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('Unable to resolve home directory for MCP token path');
  }
  return home;
}

export function getMcpPublicTokenPath(): string {
  return path.join(getHomeDir(), '.rorca', 'mcp-token');
}

export function getMcpAdminTokenPath(): string {
  return path.join(getHomeDir(), '.rorca', 'mcp-admin-token');
}

export function getMcpTokenPath(): string {
  return getMcpPublicTokenPath();
}

function getMcpDirPath(): string {
  return path.dirname(getMcpPublicTokenPath());
}

function setSecureMode(filePath: string, mode: number): void {
  if (process.platform === 'win32') {
    return;
  }

  fs.chmodSync(filePath, mode);
}

function verifyPosixMode(filePath: string, expectedMode: number): void {
  if (process.platform === 'win32') return;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink at secure MCP path: ${filePath}`);
  const actualMode = stat.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(`Invalid mode for ${filePath}: expected ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`);
  }
}

function assertCurrentUserOwner(uid: number, filePath: string): void {
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && uid !== process.getuid()) {
    throw new Error(`Secure MCP path must be owned by the current user: ${filePath}`);
  }
}

function ensureMcpDir(): void {
  const dirPath = getMcpDirPath();
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`MCP token parent must be a real directory: ${dirPath}`);
  assertCurrentUserOwner(stat.uid, dirPath);
  setSecureMode(dirPath, 0o700);
  verifyPosixMode(dirPath, 0o700);
}

function readTokenFile(tokenPath: string, repairMode = false): string {
  const fd = fs.openSync(tokenPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`MCP token must be a regular file: ${tokenPath}`);
    assertCurrentUserOwner(stat.uid, tokenPath);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      if (!repairMode) throw new Error(`MCP token must have mode 0600: ${tokenPath}`);
      fs.fchmodSync(fd, 0o600);
    }
    return fs.readFileSync(fd, 'utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

function writeTokenFileExclusive(tokenPath: string, token: string): void {
  const fd = fs.openSync(tokenPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, token, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensureTokenFile(tokenPath: string): { token: string; created: boolean } {
  ensureMcpDir();
  try {
    return { token: readTokenFile(tokenPath, true), created: false };
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) throw error;
  }

  const token = generateMcpToken();
  try {
    writeTokenFileExclusive(tokenPath, token);
    fsyncMcpDir();
    return { token, created: true };
  } catch (error) {
    if (!isFsError(error, 'EEXIST')) throw error;
    return { token: readTokenFile(tokenPath, true), created: false };
  }
}

function rotateTokenFile(tokenPath: string): string {
  ensureMcpDir();
  try {
    const target = fs.lstatSync(tokenPath);
    if (!target.isFile() || target.isSymbolicLink()) throw new Error(`Refusing non-regular MCP token target: ${tokenPath}`);
    assertCurrentUserOwner(target.uid, tokenPath);
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) throw error;
  }

  const tmpPath = path.join(path.dirname(tokenPath), `.${path.basename(tokenPath)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const token = generateMcpToken();
  writeTokenFileExclusive(tmpPath, token);
  try {
    fs.renameSync(tmpPath, tokenPath);
    fsyncMcpDir();
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
  return token;
}

function fsyncMcpDir(): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(getMcpDirPath(), fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function safeCompareToken(providedToken: string, expectedToken: string): boolean {
  const providedBuffer = Buffer.from(providedToken, 'utf8');
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function resolveRequiredTier(
  req: Request,
  defaultTier: McpTier,
  resolveToolTier?: McpToolTierResolver,
): McpTier {
  if (!resolveToolTier || req.method !== 'POST') {
    return defaultTier;
  }

  const body = req.body as {
    method?: unknown;
    params?: { name?: unknown };
  } | undefined;

  if (body?.method !== 'tools/call' || typeof body.params?.name !== 'string') {
    return defaultTier;
  }

  return resolveToolTier(body.params.name);
}

function getAuditToolName(req: Request): string {
  const body = req.body as {
    method?: unknown;
    params?: { name?: unknown };
  } | undefined;
  if (body?.method === 'tools/call' && typeof body.params?.name === 'string') {
    return body.params.name;
  }
  return 'mcp_transport';
}

function getAuditParamsHash(req: Request): string | null {
  const body = req.body as {
    method?: unknown;
    params?: { arguments?: unknown };
  } | undefined;
  if (body?.method !== 'tools/call') return null;
  return paramsHash(body.params?.arguments ?? {});
}

function recordAuthFailure(req: Request, errorCode: string): void {
  recordMcpCall({
    toolName: getAuditToolName(req),
    tokenTier: 'public',
    remoteAddr: req.ip,
    sessionId: typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : null,
    paramsHash: getAuditParamsHash(req),
    success: false,
    errorCode,
    durationMs: 0,
  }).catch(() => {});
}

function resolveTokenTier(providedToken: string): TokenTierOrDenied {
  const publicToken = getMcpPublicToken();
  if (publicToken && safeCompareToken(providedToken, publicToken)) {
    return 'public';
  }

  const adminToken = getMcpAdminToken();
  if (adminToken && safeCompareToken(providedToken, adminToken)) {
    return 'admin';
  }

  return 'denied';
}

export function invalidateTokenCache(): void {
  cachedPublicToken = null;
  cachedAdminToken = null;
}

export function ensureMcpToken(): EnsureMcpTokenResult {
  const publicResult = ensureTokenFile(getMcpPublicTokenPath());
  const adminResult = ensureTokenFile(getMcpAdminTokenPath());

  cachedPublicToken = publicResult.token;
  cachedAdminToken = adminResult.token;

  return {
    token: publicResult.token,
    created: publicResult.created,
    publicToken: publicResult.token,
    adminToken: adminResult.token,
    publicCreated: publicResult.created,
    adminCreated: adminResult.created,
  };
}

export function rotateAllMcpTokens(): { publicToken: string; adminToken: string } {
  const publicToken = rotateTokenFile(getMcpPublicTokenPath());
  const adminToken = rotateTokenFile(getMcpAdminTokenPath());
  invalidateTokenCache();
  cachedPublicToken = publicToken;
  cachedAdminToken = adminToken;
  return { publicToken, adminToken };
}

export function rotateMcpToken(): string;
export function rotateMcpToken(tier: 'public'): string;
export function rotateMcpToken(tier: 'admin'): string;
export function rotateMcpToken(tier: 'all'): { publicToken: string; adminToken: string };
export function rotateMcpToken(tier: 'public' | 'admin' | 'all' = 'public'): string | { publicToken: string; adminToken: string } {
  if (tier === 'all') {
    return rotateAllMcpTokens();
  }

  const tokenPath = tier === 'admin' ? getMcpAdminTokenPath() : getMcpPublicTokenPath();
  const token = rotateTokenFile(tokenPath);
  invalidateTokenCache();
  if (tier === 'admin') {
    cachedAdminToken = token;
  } else {
    cachedPublicToken = token;
  }
  return token;
}

export function getMcpPublicToken(): string | null {
  if (cachedPublicToken) {
    return cachedPublicToken;
  }

  const tokenPath = getMcpPublicTokenPath();
  try {
    const token = readTokenFile(tokenPath);
    cachedPublicToken = token;
    return token;
  } catch (error) {
    if (isFsError(error, 'ENOENT')) return null;
    throw error;
  }
}

export function getMcpAdminToken(): string | null {
  if (cachedAdminToken) {
    return cachedAdminToken;
  }

  const tokenPath = getMcpAdminTokenPath();
  try {
    const token = readTokenFile(tokenPath);
    cachedAdminToken = token;
    return token;
  } catch (error) {
    if (isFsError(error, 'ENOENT')) return null;
    throw error;
  }
}

export function getMcpToken(): string | null {
  return getMcpPublicToken();
}

export function isAllowedMcpOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  return MCP_ALLOWED_ORIGINS.includes(origin as (typeof MCP_ALLOWED_ORIGINS)[number]);
}

export function isLocalhostAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
}

export function requireLocalhost(req: Request, res: Response, next: NextFunction): void {
  const remoteAddress = req.socket.remoteAddress;
  const allowRemote = process.env.RORCA_MCP_ALLOW_REMOTE === 'true';

  if (!isLocalhostAddress(remoteAddress) && !allowRemote) {
    res.status(403).json({
      error: 'MCP only accessible from localhost',
      code: 'MCP_REMOTE_FORBIDDEN',
      hint: 'Set RORCA_MCP_ALLOW_REMOTE=true to enable (NOT recommended for production without auth proxy).',
    });
    return;
  }

  next();
}

export function requireMcpAuth(requiredTier: McpTier = 'public', resolveToolTier?: McpToolTierResolver) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      recordAuthFailure(req, 'MCP_AUTH_REQUIRED');
      res.status(401).json({
        error: 'Missing Bearer token',
        code: 'MCP_AUTH_REQUIRED',
        hint: 'Run `rorca mcp setup-claude` for the public token, `rorca mcp setup-claude --admin` for admin, or read ~/.rorca/mcp-token directly.',
      });
      return;
    }

    const providedToken = authHeader.slice(7).trim();
    const publicToken = getMcpPublicToken();
    const adminToken = getMcpAdminToken();

    if (!publicToken || !adminToken) {
      res.status(503).json({
        error: 'MCP token not initialized — restart rorca to generate',
        code: 'MCP_TOKEN_NOT_INITIALIZED',
      });
      return;
    }

    const tokenTier = resolveTokenTier(providedToken);
    if (tokenTier === 'denied') {
      recordAuthFailure(req, 'MCP_AUTH_INVALID');
      res.status(401).json({ error: 'Invalid Bearer token', code: 'MCP_AUTH_INVALID' });
      return;
    }

    const effectiveRequiredTier = resolveRequiredTier(req, requiredTier, resolveToolTier);
    if (effectiveRequiredTier === 'admin' && tokenTier !== 'admin') {
      recordAuthFailure(req, 'MCP_AUTH_INSUFFICIENT_TIER');
      res.status(403).json({
        error: 'Admin token required for this tool',
        code: 'MCP_AUTH_INSUFFICIENT_TIER',
        hint: 'Use the admin token from ~/.rorca/mcp-admin-token, or run `rorca mcp setup-claude --admin`.',
      });
      return;
    }

    (req as Request & { mcpTier?: McpTier }).mcpTier = tokenTier;
    next();
  };
}

// ─── Startup logging helper ─────────────────────────────────────────────────
// Kept for backward compat with callers that use the single-token logMcpTokenStatus signature.

export function logMcpTokenStatus(created: boolean): void {
  const publicTokenPath = getMcpPublicTokenPath();
  if (created) {
    logger.info(`[MCP Aegis] Generated new MCP token at ${publicTokenPath} (mode 0600)`);
    logger.info('[MCP Aegis] Run `rorca mcp setup-claude` to configure your MCP client');
  } else {
    logger.info('[MCP Aegis] Loaded existing MCP token');
  }
}
