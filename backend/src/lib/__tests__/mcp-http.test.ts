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

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('mcp-http transport compatibility', () => {
  let tmpHome: string;

  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-http-'));
    process.env.HOME = tmpHome;
    process.env.RORCA_API_URL = 'http://example.test';
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.RORCA_API_URL;
  });

  function buildApp() {
    const { swaggerSpec } = require('../swagger.ts') as typeof import('../swagger');
    const auth = require('../mcp-auth.ts') as typeof import('../mcp-auth');
    const mcp = require('../mcp-http.ts') as typeof import('../mcp-http');

    const tokens = auth.ensureMcpToken();
    const app = express();
    app.use(express.json());

    const handlers = mcp.createMcpRequestHandler(swaggerSpec as any);
    const resolver = mcp.buildMcpToolTierResolver(swaggerSpec as any);
    app.post('/mcp', auth.requireMcpAuth('public', resolver), handlers.handlePost);

    return { app, tokens, resolver };
  }

  it('serves tools/list over stateless POST without mcp-session-id', async () => {
    const { app, tokens } = buildApp();

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
    const toolNames = res.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain('rorca_list_workspaces');
    expect(toolNames).toContain('rorca_get_context');
    expect(toolNames).toContain('rorca_pipeline_task_manifests_trigger');
    expect(toolNames).toContain('rorca_trigger_task_manifest');
  });

  it('serves tools/call over stateless POST without mcp-session-id', async () => {
    const { app, tokens } = buildApp();

    mockFetch.mockResolvedValueOnce({
      status: 200,
      headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null },
      json: async () => ({ items: [] }),
      text: async () => JSON.stringify({ items: [] }),
    });

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'rorca_list_workspaces',
          arguments: {},
        },
      });

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://example.test/api/workspaces',
      expect.objectContaining({
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(res.body.result?.content?.[0]?.text).toContain('"items"');
  });

  it('serves tools/list over stateless POST with a stale mcp-session-id header', async () => {
    const { app, tokens } = buildApp();

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', 'stale-session-id')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.result?.tools)).toBe(true);
    expect(res.body.result.tools.some((tool: { name: string }) => tool.name === 'rorca_list_workspaces')).toBe(true);
  });

  it('resolves friendly alias tools to the same tier as their underlying routes', () => {
    const { resolver } = buildApp();

    expect(resolver('rorca_list_workspaces')).toBe('public');
    expect(resolver('rorca_get_context')).toBe('public');
    expect(resolver('rorca_pipeline_task_manifests_trigger')).toBe('public');
    expect(resolver('rorca_trigger_task_manifest')).toBe('public');
  });
});
