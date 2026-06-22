/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let authToken: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
}, 60_000);

beforeEach(async () => {
  authToken = await getAuthToken(app);
});

afterAll(() => {
  delete process.env.NODE_ENV;
});

describe('GET /api/mcp/tools', () => {
  test('returns the live MCP catalog including memory aliases', async () => {
    const res = await request(app)
      .get('/api/mcp/tools')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tools)).toBe(true);

    const names = res.body.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('rorca_save_memory');
    expect(names).toContain('rorca_get_memories');
    expect(names).toContain('rorca_trigger_run');
    expect(names).toContain('rorca_retry_story');
    expect(names).toContain('rorca_create_spec');
    expect(names).toContain('rorca_persist_spec');
    expect(names).toContain('rorca_spec_workflow');
    expect(names).toContain('rorca_spec_readiness');
    expect(names).toContain('rorca_retry_spec_stage');
    expect(names).toContain('rorca_repair_spec');
    expect(names).toContain('rorca_repair_spec_batch');
    expect(names).not.toContain('rorca_log_decision');

    const saveMemory = res.body.tools.find((tool: { name: string }) => tool.name === 'rorca_save_memory');
    expect(saveMemory).toMatchObject({
      category: 'Memory',
    });
    expect(saveMemory.requiredParams).toEqual(expect.arrayContaining(['category', 'title', 'rule']));

    const triggerRun = res.body.tools.find((tool: { name: string }) => tool.name === 'rorca_trigger_run');
    expect(triggerRun).toMatchObject({
      category: 'Specs & Pipeline',
    });
  });
});
