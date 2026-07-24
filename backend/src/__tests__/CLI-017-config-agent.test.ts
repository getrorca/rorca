/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { execute } from '../db/index';
import { getAuthToken } from '../routes/__tests__/helpers/auth-helper';

describe('CLI-017: PUT /api/config/agent', () => {
  let app: Express;
  let authToken: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeEach(async () => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';

    jest.doMock('../lib/opencode-detector', () => ({
      detectOpenCode: jest.fn(() => ({
        opencodeInstalled: true,
        opencodeVersion: '0.1.0',
      })),
      requireOpenCode: jest.fn(),
    }));

    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cli-017-'));

    const serverMod = require('../server');
    app = serverMod.default;
    authToken = await getAuthToken(app);

    workspaceId = `ws-cli-017-${Date.now()}`;
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [workspaceId, 'CLI-017 Workspace', workspacePath],
    );

    const specDir = path.join(workspacePath, 'forge', 'specs', 'approved');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      path.join(specDir, 'cli-017-spec.json'),
      JSON.stringify({
        title: 'cli-017-spec',
        userStories: [
          {
            id: 'US-001',
            title: 'Test story',
            description: 'Simple story for runtime agent switching',
            acceptanceCriteria: ['Runs with the updated agent'],
            dependsOn: [],
            passes: false,
          },
        ],
      }, null, 2),
      'utf8',
    );
  });

  afterEach(async () => {
    try {
      const { setActiveAgentConfig } = require('../lib/config');
      setActiveAgentConfig({ agent: 'claude', model: null });
    } catch {}
    try {
      const { closePool } = require('../db/index');
      await closePool();
    } catch {}
    fs.rmSync(workspacePath, { recursive: true, force: true });
    delete process.env.NODE_ENV;
  });

  test('returns 400 for an invalid agent', async () => {
    const res = await request(app)
      .put('/api/config/agent')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ agent: 'invalid-agent' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid agent/i);
  });

  test('updates in-memory agent config without restart and preserves non-mutating dry-run planning', async () => {
    const updateRes = await request(app)
      .put('/api/config/agent')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ agent: 'opencode' });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body).toEqual({
      agent: 'opencode',
      model: null,
      changed: true,
    });

    const { activeAgent, activeModel } = require('../lib/config');
    expect(activeAgent).toBe('opencode');
    expect(activeModel).toBeNull();

    const triggerRes = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        specPath: 'forge/specs/approved/cli-017-spec.json',
        dryRun: true,
      });

    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.dryRun).toBe(true);
    expect(activeAgent).toBe('opencode');
  });
});
