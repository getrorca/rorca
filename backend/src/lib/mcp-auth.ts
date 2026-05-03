import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

let cachedToken: string | null = null;

export function generateMcpToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function getMcpTokenPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) {
    throw new Error('Unable to resolve home directory for MCP token path');
  }
  return path.join(home, '.rorca', 'mcp-token');
}

function getMcpDirPath(): string {
  return path.dirname(getMcpTokenPath());
}

function verifyPosixMode(filePath: string, expectedMode: number): void {
  if (process.platform === 'win32') {
    return;
  }

  const stat = fs.statSync(filePath);
  const actualMode = stat.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(`Invalid mode for ${filePath}: expected ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`);
  }
}

function ensureMcpDir(): void {
  const dirPath = getMcpDirPath();
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  verifyPosixMode(dirPath, 0o700);
}

function readTokenFile(tokenPath: string): string {
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

export function invalidateTokenCache(): void {
  cachedToken = null;
}

export function ensureMcpToken(): { token: string; created: boolean } {
  const tokenPath = getMcpTokenPath();
  ensureMcpDir();

  if (fs.existsSync(tokenPath)) {
    verifyPosixMode(tokenPath, 0o600);
    const token = readTokenFile(tokenPath);
    cachedToken = token;
    return { token, created: false };
  }

  const token = generateMcpToken();
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  verifyPosixMode(tokenPath, 0o600);
  cachedToken = token;
  return { token, created: true };
}

export function rotateMcpToken(): string {
  const tokenPath = getMcpTokenPath();
  const tmpPath = `${tokenPath}.tmp-${process.pid}-${Date.now()}`;
  const token = generateMcpToken();

  ensureMcpDir();
  fs.writeFileSync(tmpPath, token, { mode: 0o600 });
  fs.renameSync(tmpPath, tokenPath);
  verifyPosixMode(tokenPath, 0o600);
  invalidateTokenCache();
  cachedToken = token;
  return token;
}

export function getMcpToken(): string | null {
  if (cachedToken) {
    return cachedToken;
  }

  const tokenPath = getMcpTokenPath();
  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  const token = readTokenFile(tokenPath);
  cachedToken = token;
  return token;
}

export function requireMcpAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Missing Bearer token',
      code: 'MCP_AUTH_REQUIRED',
      hint: 'Run `rorca mcp setup-claude` to configure your MCP client, or read ~/.rorca/mcp-token directly.',
    });
    return;
  }

  const providedToken = authHeader.slice(7).trim();
  const expectedToken = getMcpToken();

  if (!expectedToken) {
    res.status(503).json({
      error: 'MCP token not initialized — restart rorca to generate',
      code: 'MCP_TOKEN_NOT_INITIALIZED',
    });
    return;
  }

  if (providedToken.length !== expectedToken.length) {
    res.status(401).json({ error: 'Invalid Bearer token', code: 'MCP_AUTH_INVALID' });
    return;
  }

  const providedBuffer = Buffer.from(providedToken, 'utf8');
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    res.status(401).json({ error: 'Invalid Bearer token', code: 'MCP_AUTH_INVALID' });
    return;
  }

  next();
}
