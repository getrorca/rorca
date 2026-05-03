import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

describe('mcp-auth', () => {
  let tmpHome: string;

  beforeEach(() => {
    jest.resetModules();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-auth-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates a 64-char token with secure file permissions', () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const result = mod.ensureMcpToken();
    const tokenPath = mod.getMcpTokenPath();

    expect(result.created).toBe(true);
    expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(fs.readFileSync(tokenPath, 'utf8')).toBe(result.token);
    expect(fs.statSync(path.dirname(tokenPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it('rotates token atomically and invalidates the old token cache', () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const original = mod.ensureMcpToken().token;
    const rotated = mod.rotateMcpToken();

    expect(rotated).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated).not.toBe(original);
    expect(mod.getMcpToken()).toBe(rotated);
    expect(fs.readFileSync(mod.getMcpTokenPath(), 'utf8')).toBe(rotated);
    expect(fs.readdirSync(path.dirname(mod.getMcpTokenPath())).filter((name) => name.includes('mcp-token.tmp'))).toHaveLength(0);
  });

  it('requires bearer auth and rejects invalid tokens without falling through', async () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const token = mod.ensureMcpToken().token;
    const app = express();
    app.get('/mcp', mod.requireMcpAuth, (_req, res) => {
      res.json({ ok: true });
    });

    const missing = await request(app).get('/mcp');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('MCP_AUTH_REQUIRED');

    const invalid = await request(app).get('/mcp').set('Authorization', 'Bearer wrong');
    expect(invalid.status).toBe(401);
    expect(invalid.body.code).toBe('MCP_AUTH_INVALID');

    const valid = await request(app).get('/mcp').set('Authorization', `Bearer ${token}`);
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({ ok: true });
  });

  it('returns 503 when the token file is not initialized', async () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const app = express();
    app.get('/mcp', mod.requireMcpAuth, (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${'a'.repeat(64)}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MCP_TOKEN_NOT_INITIALIZED');
  });
});
