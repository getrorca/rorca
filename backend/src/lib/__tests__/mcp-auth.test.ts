/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

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

  it('creates public and admin tokens with secure file permissions', () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const result = mod.ensureMcpToken();

    expect(result.publicCreated).toBe(true);
    expect(result.adminCreated).toBe(true);
    expect(result.publicToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.adminToken).toMatch(/^[a-f0-9]{64}$/);
    expect(result.adminToken).not.toBe(result.publicToken);
    expect(fs.existsSync(mod.getMcpPublicTokenPath())).toBe(true);
    expect(fs.existsSync(mod.getMcpAdminTokenPath())).toBe(true);
    expect(fs.readFileSync(mod.getMcpPublicTokenPath(), 'utf8')).toBe(result.publicToken);
    expect(fs.readFileSync(mod.getMcpAdminTokenPath(), 'utf8')).toBe(result.adminToken);
    expect(fs.statSync(path.dirname(mod.getMcpPublicTokenPath())).mode & 0o777).toBe(0o700);
    expect(fs.statSync(mod.getMcpPublicTokenPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(mod.getMcpAdminTokenPath()).mode & 0o777).toBe(0o600);
  });

  it('rotates public, admin, and all tokens atomically', () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const original = mod.ensureMcpToken();

    const rotatedPublic = mod.rotateMcpToken('public');
    expect(typeof rotatedPublic).toBe('string');
    expect(rotatedPublic).not.toBe(original.publicToken);
    expect(mod.getMcpPublicToken()).toBe(rotatedPublic);

    const rotatedAdmin = mod.rotateMcpToken('admin');
    expect(typeof rotatedAdmin).toBe('string');
    expect(rotatedAdmin).not.toBe(original.adminToken);
    expect(mod.getMcpAdminToken()).toBe(rotatedAdmin);

    const rotatedAll = mod.rotateMcpToken('all');
    expect(rotatedAll.publicToken).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedAll.adminToken).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readdirSync(path.dirname(mod.getMcpPublicTokenPath())).filter((name) => name.includes('mcp-token.tmp'))).toHaveLength(0);
    expect(fs.readdirSync(path.dirname(mod.getMcpAdminTokenPath())).filter((name) => name.includes('mcp-admin-token.tmp'))).toHaveLength(0);
  });

  it('enforces the public/admin curl matrix at the middleware layer', async () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const tokens = mod.ensureMcpToken();
    const app = express();
    app.use(express.json());
    app.post('/mcp', mod.requireMcpAuth('public', (toolName) => toolName === 'rorca_pipeline_trigger' ? 'admin' : 'public'), (_req, res) => {
      res.json({ ok: true });
    });

    const publicPublic = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .send({ method: 'tools/call', params: { name: 'rorca_specs' } });
    expect(publicPublic.status).toBe(200);

    const publicAdmin = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .send({ method: 'tools/call', params: { name: 'rorca_pipeline_trigger' } });
    expect(publicAdmin.status).toBe(403);
    expect(publicAdmin.body.code).toBe('MCP_AUTH_INSUFFICIENT_TIER');

    const adminAdmin = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .send({ method: 'tools/call', params: { name: 'rorca_pipeline_trigger' } });
    expect(adminAdmin.status).toBe(200);

    const adminPublic = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .send({ method: 'tools/call', params: { name: 'rorca_specs' } });
    expect(adminPublic.status).toBe(200);
  });

  it('rejects invalid or mismatched-length tokens without throwing', async () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    mod.ensureMcpToken();
    const app = express();
    app.get('/mcp', mod.requireMcpAuth(), (_req, res) => {
      res.json({ ok: true });
    });

    const missing = await request(app).get('/mcp');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('MCP_AUTH_REQUIRED');

    const invalidShort = await request(app).get('/mcp').set('Authorization', 'Bearer short');
    expect(invalidShort.status).toBe(401);
    expect(invalidShort.body.code).toBe('MCP_AUTH_INVALID');

    const invalidLong = await request(app).get('/mcp').set('Authorization', `Bearer ${'a'.repeat(128)}`);
    expect(invalidLong.status).toBe(401);
    expect(invalidLong.body.code).toBe('MCP_AUTH_INVALID');
  });

  it('returns 503 when either token file is not initialized', async () => {
    const mod = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const app = express();
    app.get('/mcp', mod.requireMcpAuth(), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${'a'.repeat(64)}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MCP_TOKEN_NOT_INITIALIZED');
  });
});
