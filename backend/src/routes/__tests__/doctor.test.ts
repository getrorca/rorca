/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Express } from 'express';
import request from 'supertest';
import { execute } from '../../db/index';
import { ensureMcpToken, getMcpTokenPath } from '../../lib/mcp-auth';

const mockExecSync = jest.fn();
const mockDetectPi = jest.fn();
const mockListPiModels = jest.fn();

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
  };
});

jest.mock('../../lib/pi-detector', () => ({
  detectPi: () => mockDetectPi(),
  listPiModels: (...args: unknown[]) => mockListPiModels(...args),
}));

describe('GET /api/doctor', () => {
  let app: Express;
  let tmpDir: string;

  beforeEach(() => {
    jest.resetModules();
    mockExecSync.mockReset();
    mockDetectPi.mockReset();
    mockListPiModels.mockReset();
    mockDetectPi.mockReturnValue({
      piInstalled: false,
      piVersion: null,
      piBinPath: null,
    });
    mockListPiModels.mockReturnValue([]);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-doctor-test-'));
    process.env.NODE_ENV = 'test';
    process.env.HOME = tmpDir;
    ensureMcpToken();

    const serverMod = require('../../server');
    app = serverMod.default;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ordered doctor checks with actionable statuses', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('which docker')) return '/usr/local/bin/docker\n';
      if (command.includes('docker info')) return 'Server: Docker Engine\n';
      if (command.includes('docker ps')) return 'Up 2 minutes\n';
      return '';
    });
    mockDetectPi.mockReturnValue({
      piInstalled: true,
      piVersion: '1.2.3',
      piBinPath: '/usr/local/bin/pi',
    });
    mockListPiModels.mockReturnValue([
      { provider: 'anthropic', model: 'claude-sonnet', contextTokens: 200000, maxOutTokens: 8192, thinking: true, images: true },
    ]);

    await execute(
      `INSERT INTO worker_heartbeat (worker_id, pid, hostname, started_at, last_seen) VALUES ($1, $2, $3, NOW(), NOW())`,
      [randomUUID(), 12345, 'localhost'],
    );
    await execute(
      `INSERT INTO workspaces (id, label, path, domains) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [`doctor-ws-${Date.now()}`, 'Doctor Test', tmpDir, '[]'],
    );

    const res = await request(app).get('/api/doctor');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.summary.errors).toBe(0);
    expect(res.body.checks.map((check: { id: string }) => check.id)).toEqual([
      'docker',
      'database-container',
      'backend',
      'database',
      'mcp-token',
      'worker',
      'pi-installed',
      'pi-authenticated',
      'workspace',
      'agent',
    ]);
    expect(res.body.checks[0]).toMatchObject({
      id: 'docker',
      status: 'ok',
    });
    expect(res.body.checks[1]).toMatchObject({
      id: 'database-container',
      status: 'ok',
    });
    expect(res.body.checks[5]).toMatchObject({
      id: 'worker',
      status: 'ok',
    });
    expect(res.body.checks[6]).toMatchObject({
      id: 'pi-installed',
      status: 'ok',
    });
    expect(res.body.checks[7]).toMatchObject({
      id: 'pi-authenticated',
      status: 'ok',
    });
  });

  it('reports docker missing and pi unauthenticated failures cleanly', async () => {
    mockExecSync.mockImplementation((command: string) => {
      if (command.includes('which docker')) {
        throw new Error('not found');
      }
      return '';
    });
    mockDetectPi.mockReturnValue({
      piInstalled: false,
      piVersion: null,
      piBinPath: null,
    });
    mockListPiModels.mockReturnValue([]);
    await execute('DELETE FROM worker_heartbeat');

    const res = await request(app).get('/api/doctor');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.checks[0]).toMatchObject({
      id: 'docker',
      status: 'error',
      message: 'Docker not found',
    });
    expect(res.body.checks[1]).toMatchObject({
      id: 'database-container',
      status: 'error',
      message: 'Database container not running',
    });
    expect(res.body.checks[5]).toMatchObject({
      id: 'worker',
      status: 'error',
      message: 'Worker not running',
    });
    expect(res.body.checks[6]).toMatchObject({
      id: 'pi-installed',
      status: 'error',
      message: 'Pi not found',
    });
    expect(res.body.checks[7]).toMatchObject({
      id: 'pi-authenticated',
      status: 'warning',
    });
  });

  it('warns when the MCP token mode is not 0600', async () => {
    const tokenPath = getMcpTokenPath();
    fs.chmodSync(tokenPath, 0o644);

    const res = await request(app).get('/api/doctor');

    const tokenCheck = res.body.checks.find((check: { id: string }) => check.id === 'mcp-token');
    expect(tokenCheck).toMatchObject({
      id: 'mcp-token',
      status: 'warning',
    });
  });
});
