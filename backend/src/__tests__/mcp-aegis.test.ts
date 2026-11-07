/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../lib/error-handler';
import type * as McpHttpModule from '../lib/mcp-http';
import type * as SwaggerModule from '../lib/swagger';

describe('MCP aegis hardening', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalAllowRemote: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-aegis-'));
    originalHome = process.env.HOME;
    originalAllowRemote = process.env.RORCA_MCP_ALLOW_REMOTE;
    process.env.HOME = tmpHome;
    delete process.env.RORCA_MCP_ALLOW_REMOTE;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalAllowRemote === undefined) delete process.env.RORCA_MCP_ALLOW_REMOTE;
    else process.env.RORCA_MCP_ALLOW_REMOTE = originalAllowRemote;

    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function createHarness(options?: { remoteAddress?: string; allowRemote?: boolean }) {
    const mod = require('../lib/mcp-auth.ts') as typeof import('../lib/mcp-auth');
    if (options?.allowRemote) {
      process.env.RORCA_MCP_ALLOW_REMOTE = 'true';
    } else {
      delete process.env.RORCA_MCP_ALLOW_REMOTE;
    }

    const token = mod.ensureMcpToken().publicToken;
    const app = express();
    const remoteAddress = options?.remoteAddress ?? '127.0.0.1';

    const mcpCors = cors({
      origin: (origin, callback) => {
        if (mod.isAllowedMcpOrigin(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin not allowed: ${origin}`));
      },
      credentials: false,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'Authorization'],
      exposedHeaders: ['Mcp-Session-Id'],
      maxAge: 86400,
    });

    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', {
        configurable: true,
        value: remoteAddress,
      });
      next();
    });

    app.get('/mcp', mcpCors, mod.requireLocalhost, mod.requireMcpAuth(), (_req, res) => {
      res.status(200).json({ ok: true });
    });

    app.use(errorHandler);

    return { app, token, mod };
  }

  it('allows only exact localhost browser origins and server-to-server requests', () => {
    const { mod } = createHarness();

    expect(mod.isAllowedMcpOrigin(undefined)).toBe(true);
    expect(mod.isAllowedMcpOrigin('http://localhost:3030')).toBe(true);
    expect(mod.isAllowedMcpOrigin('http://127.0.0.1:3030')).toBe(true);
    expect(mod.isAllowedMcpOrigin('http://evil.localhost.com:3030')).toBe(false);
    expect(mod.isAllowedMcpOrigin('http://[::1]:3030')).toBe(false);
    expect(mod.isAllowedMcpOrigin('https://localhost:3030')).toBe(false);
  });

  it('accepts the supported localhost address forms', () => {
    const { mod } = createHarness();

    expect(mod.isLocalhostAddress('127.0.0.1')).toBe(true);
    expect(mod.isLocalhostAddress('::1')).toBe(true);
    expect(mod.isLocalhostAddress('::ffff:127.0.0.1')).toBe(true);
    expect(mod.isLocalhostAddress('192.168.1.20')).toBe(false);
  });

  it('treats a disallowed browser origin as a CORS rejection before auth', async () => {
    const { app, token } = createHarness();

    const res = await request(app)
      .get('/mcp')
      .set('Origin', 'http://evil.com')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('allows server-to-server requests without Origin when the token is valid', async () => {
    const { app, token } = createHarness();

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('still requires a bearer token for server-to-server requests', async () => {
    const { app } = createHarness();

    const res = await request(app).get('/mcp');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MCP_AUTH_REQUIRED');
  });

  it('rejects non-localhost connections by default before auth', async () => {
    const { app, token } = createHarness({ remoteAddress: '10.0.0.24' });

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'MCP only accessible from localhost',
      code: 'MCP_REMOTE_FORBIDDEN',
    });
  });

  it('allows non-localhost connections when RORCA_MCP_ALLOW_REMOTE=true and auth succeeds', async () => {
    const { app, token } = createHarness({
      remoteAddress: '10.0.0.24',
      allowRemote: true,
    });

    const res = await request(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('exposes the side-effect-free preflight operation without widening it to the public API', () => {
    const { swaggerSpec } = require('../lib/swagger.ts') as typeof SwaggerModule;
    const mcp = require('../lib/mcp-http.ts') as typeof McpHttpModule;
    const definitions = mcp.getMcpToolDefinitions(swaggerSpec as never)
      .filter(definition => definition.capturedPath === '/api/pipeline/preflight');

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      toolName: 'rorca_pipeline_preflight',
      capturedMethod: 'POST',
      capturedOperation: {
        'x-rorca-tier': 'auth',
      },
    });
    expect(definitions[0].capturedOperation['x-rorca-public-api']).toBeUndefined();
    const resolveTier = mcp.buildMcpToolTierResolver(swaggerSpec as never);
    expect(resolveTier('rorca_pipeline_preflight')).toBe('public');
    expect(resolveTier('rorca_preflight_run')).toBe('public');
  });
});
