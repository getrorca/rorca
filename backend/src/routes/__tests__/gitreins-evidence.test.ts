/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';

jest.mock('../../lib/gitreins-evidence-store', () => ({
  listGitReinsEvidence: jest.fn(),
}));

import { listGitReinsEvidence } from '../../lib/gitreins-evidence-store';
import gitReinsEvidenceRouter from '../gitreins-evidence';
import { errorHandler } from '../../lib/error-handler';
import { getMcpToolDefinitions } from '../../lib/mcp-http';
import { swaggerSpec } from '../../lib/swagger';

const mockList = listGitReinsEvidence as jest.MockedFunction<typeof listGitReinsEvidence>;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/gitreins', gitReinsEvidenceRouter);
  instance.use(errorHandler);
  return instance;
}

describe('read-only GitReins public API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns workspace-scoped, bounded evidence', async () => {
    mockList.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    const response = await request(app()).get(
      '/api/gitreins/evidence?workspaceId=ws-1&runId=7&storyId=US-001&limit=20&offset=0',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
    expect(mockList).toHaveBeenCalledWith({
      workspaceId: 'ws-1', runId: 7, storyId: 'US-001', limit: 20, offset: 0,
    });
  });

  test('rejects missing workspace and malformed numeric filters', async () => {
    expect((await request(app()).get('/api/gitreins/evidence')).status).toBe(400);
    expect((await request(app()).get('/api/gitreins/evidence?workspaceId=ws-1&runId=7x')).status)
      .toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('has no public mutation endpoint', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const response = await request(app())[method]('/api/gitreins/evidence').send({});
      expect(response.status).toBe(404);
    }
  });

  test('declares the required stable public Swagger tier, rationale, and public-api flag', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'gitreins-evidence.ts'), 'utf8');
    expect(source).toContain('x-rorca-tier: public');
    expect(source).toMatch(/x-rorca-rationale: "[^"]+"/);
    expect(source).toContain('x-rorca-public-api: true');
    expect(source).not.toMatch(/router\.(post|put|patch|delete)\(/);
  });

  test('is exposed as one read-only public MCP tool', () => {
    const tools = getMcpToolDefinitions(swaggerSpec as never)
      .filter(tool => tool.capturedPath === '/api/gitreins/evidence');
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe('rorca_gitreins_evidence');
    expect(tools[0].capturedMethod).toBe('GET');
    expect(tools[0].capturedOperation['x-rorca-tier']).toBe('public');
  });
});
