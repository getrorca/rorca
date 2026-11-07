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
    expect(toolNames).toContain('rorca_pipeline_preflight');
    expect(toolNames).toContain('rorca_preflight_run');
    expect(toolNames).not.toContain('rorca_receive_linear_webhook');
    expect(toolNames).not.toContain('rorca_receive_vercel_webhook');
    expect(toolNames).not.toContain('rorca_receive_slack_webhook');
    expect(toolNames).not.toContain('rorca_get_pipeline_run_context_inspector_events');
    expect(toolNames).not.toContain('rorca_synthesize_workspace_memory');
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

  it('forwards one caller option set through preflight and an exact receipt-bound trigger', async () => {
    const { app, tokens } = buildApp();
    const intendedOptions = {
      workspaceId: 'ws-1',
      specPath: 'forge/specs/approved/exact.json',
      queue: true,
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'branch-only',
      orchestrationMode: 'sequential',
      parallelism: 1,
      forceSequential: true,
      storyId: 'US-002',
      includeGraph: true,
      agentOverride: 'pi',
      modelOverride: 'anthropic/claude-sonnet-4-5',
      effortLevel: 'high',
      reasoning: { enabled: true, effort: 'high' },
      terminal_mode: 'ansi-html',
      executionEnvironment: 'remote-rorca',
    };
    const previewResponse = {
      compatible: true,
      mismatchMode: 'warn',
      engine: 'pi',
      stories: [],
      preview: {
        schemaVersion: 'rorca.execution-preview.v1',
        previewHash: `sha256:${'a'.repeat(64)}`,
        expiresAt: '2026-08-06T20:00:00.000Z',
        workspaceId: 'ws-1',
        spec: { kind: 'spec', id: 'exact' },
        specHash: `sha256:${'b'.repeat(64)}`,
        effectiveOptions: {
          agent: 'pi',
          model: 'anthropic/claude-sonnet-4-5',
          effort: 'high',
          mode: 'sequential',
          parallelism: 1,
          storyIds: ['US-002'],
          worktree: { enabled: true },
          merge: { strategy: 'branch-only', autoMerge: false },
        },
        scheduling: 'queue',
      },
    };
    const triggerResponse = { ok: true, runId: 42, receipt: { previewHash: previewResponse.preview.previewHash } };
    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null },
        json: async () => previewResponse,
        text: async () => JSON.stringify(previewResponse),
      })
      .mockResolvedValueOnce({
        status: 201,
        headers: { get: (key: string) => key.toLowerCase() === 'content-type' ? 'application/json' : null },
        json: async () => triggerResponse,
        text: async () => JSON.stringify(triggerResponse),
      });

    const preflight = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'rorca_preflight_run', arguments: intendedOptions },
      });
    expect(preflight.status).toBe(200);
    const observedPreflight = JSON.parse(preflight.body.result.content[0].text);
    expect(observedPreflight).toEqual(previewResponse);
    expect(mockFetch.mock.calls[0]).toEqual([
      'http://example.test/api/pipeline/preflight',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.any(String),
      }),
    ]);
    expect(JSON.parse(String(mockFetch.mock.calls[0]?.[1]?.body))).toEqual(intendedOptions);

    const idempotencyKey = 'mcp-trigger:ws-1:exact-preview';
    const triggerArguments = {
      ...intendedOptions,
      previewHash: observedPreflight.preview.previewHash,
      previewExpiresAt: observedPreflight.preview.expiresAt,
      idempotencyKey,
    };
    const trigger = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'rorca_trigger_run', arguments: triggerArguments },
      });

    expect(trigger.status).toBe(200);
    expect(JSON.parse(trigger.body.result.content[0].text)).toEqual(triggerResponse);
    expect(mockFetch.mock.calls[1]).toEqual([
      'http://example.test/api/pipeline/trigger',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: expect.any(String),
      }),
    ]);
    expect(JSON.parse(String(mockFetch.mock.calls[1]?.[1]?.body))).toEqual(triggerArguments);
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

  it('rejects an unknown MCP tool without forwarding any HTTP request', async () => {
    const { app, tokens } = buildApp();

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.publicToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'rorca_unknown_protected_route', arguments: {} },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves friendly alias tools to the same tier as their underlying routes', () => {
    const { resolver } = buildApp();

    expect(resolver('rorca_list_workspaces')).toBe('public');
    expect(resolver('rorca_get_context')).toBe('public');
    expect(resolver('rorca_pipeline_task_manifests_trigger')).toBe('public');
    expect(resolver('rorca_trigger_task_manifest')).toBe('public');
  });
});
