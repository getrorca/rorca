/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Express } from 'express';
import request from 'supertest';

describe('MCP OAuth removal', () => {
  let app: Express;
  let testServer: Server;
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../lib/llm-client', () => ({
      chatComplete: jest.fn(),
      getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
      isValidModel: jest.fn().mockReturnValue(true),
      DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
      resolveVaultProvider: jest.fn().mockReturnValue(null),
      getModelInfo: jest.fn().mockReturnValue(undefined),
      SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
    }));
    jest.doMock('../lib/pi-detector', () => ({
      detectPi: jest.fn().mockReturnValue({
        piInstalled: false,
        piVersion: null,
        piBinPath: null,
      }),
    }));

    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-oauth-test-'));
    process.env.HOME = tmpHome;
    process.env.NODE_ENV = 'test';

    const serverMod = require('../server');
    app = serverMod.default as Express;
    testServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      testServer.once('listening', resolve);
      testServer.once('error', reject);
    });
  });

  afterAll(async () => {
    testServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => testServer.close((error) => error ? reject(error) : resolve()));
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it.each([
    ['get', '/.well-known/oauth-authorization-server'],
    ['get', '/.well-known/oauth-protected-resource'],
    ['post', '/oauth/register'],
    ['post', '/register'],
    ['get', '/oauth/authorize'],
    ['post', '/oauth/token'],
  ] as const)('returns honest 501 JSON for %s %s', async (method, routePath) => {
    const res = await request(testServer)[method](routePath);

    expect(res.status).toBe(501);
    expect(res.body).toEqual({
      error: 'OAuth not supported',
      message: 'Rorca uses Bearer token authentication, not OAuth. See ~/.rorca/mcp-token.',
      documentation: 'Run `rorca mcp setup-claude` to configure your MCP client.',
    });
  });

  it('still accepts the exact initialized Bearer token on /mcp initialize', async () => {
    // Use the same extensionless module identity as server.ts. Loading the same
    // source through a second ts-jest key would create a distinct token cache.
    const { ensureMcpToken } = require('../lib/mcp-auth') as typeof import('../lib/mcp-auth');
    const { publicToken } = ensureMcpToken();

    const res = await request(testServer)
      .post('/mcp')
      .set('Authorization', `Bearer ${publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'jest', version: '1.0.0' },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toBeDefined();
  });
});
