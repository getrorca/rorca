/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// W5-009: omp provenance tools ported from main (rorca_select_workspace,
// rorca_record_subagent_run, omp-subagent:<agent> provenance). Both selection
// and memory mutation are ADMIN-only: a public MCP bearer must be denied, and
// only the authorized principal (admin token) may select/write a workspace.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

describe('mcp-http omp provenance tools', () => {
  let tmpHome: string;

  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-mcp-omp-'));
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
    app.delete('/mcp', auth.requireMcpAuth(), handlers.handleDelete);
    return { app, tokens, mcp };
  }

  function workspaceListBody() {
    return {
      status: 200,
      headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null },
      json: async () => ({ items: [{ id: 'ws-omp', label: 'OMP Workspace', path: '/repo/omp' }] }),
      text: async () => JSON.stringify({ items: [{ id: 'ws-omp', label: 'OMP Workspace', path: '/repo/omp' }] }),
    };
  }

  async function initializeSession(app: express.Express, token: string): Promise<string> {
    const initialized = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 0, method: 'initialize', params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'omp-test-client', version: '1.0.0' },
        },
      });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers['mcp-session-id'] as string;
    expect(sessionId).toBeDefined();
    await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return sessionId;
  }

  it('publishes the omp session tools in tools/list', async () => {
    const { app, tokens } = buildApp();
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const toolNames = res.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain('rorca_select_workspace');
    expect(toolNames).toContain('rorca_current_workspace');
    expect(toolNames).toContain('rorca_record_subagent_run');
    expect(toolNames).toContain('rorca_subscribe_run_events');
    expect(toolNames).toContain('rorca_unsubscribe_run_events');
  });

  it('denies workspace selection to a public MCP bearer', async () => {
    const { app, tokens } = buildApp();
    const sessionId = await initializeSession(app, tokens.publicToken);
    mockFetch.mockResolvedValueOnce(workspaceListBody());
    const selected = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'rorca_select_workspace',
          arguments: { workspace: 'ws-omp' },
        },
      });
    expect(selected.status).toBe(403);
    expect(JSON.stringify(selected.body)).toContain('MCP_AUTH_INSUFFICIENT_TIER');
    // No workspace enumeration may have been consumed by a public bearer.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('denies subagent memory mutation to a public MCP bearer', async () => {
    const { app, tokens } = buildApp();
    const sessionId = await initializeSession(app, tokens.publicToken);
    const recorded = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'rorca_record_subagent_run',
          arguments: { title: 't', summary: 's', agent: 'worker-a' },
        },
      });
    expect(recorded.status).toBe(403);
    expect(JSON.stringify(recorded.body)).toContain('MCP_AUTH_INSUFFICIENT_TIER');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses to record a subagent run before a workspace is selected (authorized principal)', async () => {
    const { app, tokens } = buildApp();
    const sessionId = await initializeSession(app, tokens.adminToken);
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'rorca_record_subagent_run',
          arguments: { title: 't', summary: 's', agent: 'worker-a' },
        },
      });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('No workspace selected');
  });

  it('selects a workspace with the authorized principal, then records the run with omp-subagent:<agent> provenance', async () => {
    const { app, tokens } = buildApp();
    const sessionId = await initializeSession(app, tokens.adminToken);

    mockFetch.mockResolvedValueOnce(workspaceListBody());
    const selected = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'rorca_select_workspace',
          arguments: { workspace: 'ws-omp' },
        },
      });
    expect(selected.status).toBe(200);
    expect(JSON.stringify(selected.body)).toContain('ws-omp');

    mockFetch.mockResolvedValue({
      status: 200,
      headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null },
      json: async () => ({ id: 'memory-1' }),
      text: async () => JSON.stringify({ id: 'memory-1' }),
    });
    const recorded = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
          name: 'rorca_record_subagent_run',
          arguments: { title: 'omp finding', summary: 'durable result', agent: 'worker-a', outcome: 'completed' },
        },
      });
    expect(JSON.parse((recorded.body.result.content as Array<{ type: string; text: string }>)[0].text)).toMatchObject({
      workspaceId: 'ws-omp',
      recorded: true,
      outcome: 'completed',
    });

    const memoryCall = mockFetch.mock.calls.find((call: unknown[]) => String(call[0]).endsWith('/api/memory'));
    expect(memoryCall).toBeDefined();
    const body = JSON.parse(memoryCall[1].body);
    expect(body).toMatchObject({
      workspaceId: 'ws-omp',
      title: 'omp finding',
      rule: 'durable result',
      source: 'omp-subagent:worker-a',
      sourceType: 'mcp',
    });
  });

  it('clears the session workspace on transport close (DELETE)', async () => {
    const { app, tokens, mcp } = buildApp();
    const sessionId = await initializeSession(app, tokens.adminToken);
    mockFetch.mockResolvedValueOnce(workspaceListBody());
    const selected = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
          name: 'rorca_select_workspace',
          arguments: { workspace: 'ws-omp' },
        },
      });
    expect(selected.status).toBe(200);
    expect(JSON.stringify(selected.body)).toContain('ws-omp');

    // DELETE terminates the session and must clear the bound workspace state.
    const closed = await request(app)
      .delete('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .set('mcp-session-id', sessionId);
    expect(closed.status).toBeLessThan(500);

    mockFetch.mockResolvedValueOnce(workspaceListBody());
    const afterClose = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.adminToken}`)
      .set('mcp-session-id', sessionId)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
          name: 'rorca_current_workspace',
          arguments: {},
        },
      });
    // The stale session id is rejected after close; no workspace state remains.
    expect([400, 200]).toContain(afterClose.status);
    if (afterClose.status === 200) {
      expect(JSON.stringify(afterClose.body)).toContain('workspaceId');
      expect(JSON.stringify(afterClose.body)).not.toContain('ws-omp');
    }
    void mcp;
  });
});
