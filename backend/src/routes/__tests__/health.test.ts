/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Server } from 'http';
import { once } from 'events';
import express, { type Express } from 'express';
import request from 'supertest';
import { execute } from '../../db/index';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../../lib/pi-detector', () => ({
  detectPi: jest.fn().mockReturnValue({ piInstalled: false, piVersion: null, piBinPath: null }),
  detectPiAsync: jest.fn().mockResolvedValue({ piInstalled: false, piVersion: null, piBinPath: null }),
}));

const ACTIVE_RUN_WORKSPACE_ID = 'health-active-runs-fixture';

let app: Server;
let tmpDir: string;

function buildHealthTestApp(): Express {
  const testApp = express();
  // Require after each suite's detector/config mocks are registered.
  const healthRouter = require('../health').default;
  testApp.use('/api/health', healthRouter);
  return testApp;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-test-'));
  process.env.NODE_ENV = 'test';
  const expressApp = buildHealthTestApp();
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [ACTIVE_RUN_WORKSPACE_ID]);
});

afterEach(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [ACTIVE_RUN_WORKSPACE_ID]);
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('GET /api/health', () => {
  it('returns 200 with required fields', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    // Health returns 'ok' when all components are up, 'degraded' when worker is not running (common in tests)
    expect(['healthy', 'degraded']).toContain(res.body.status);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('uptime');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body).toHaveProperty('db_connected', true);
    expect(typeof res.body.active_runs).toBe('number');
    expect(res.body.active_runs).toBeGreaterThanOrEqual(0);
    expect(res.body).toHaveProperty('readiness.confirmed', true);
    expect(res.body).toHaveProperty('readiness.deadlineMs', 750);
    expect(res.body).not.toHaveProperty('piInstalled');
    expect(res.body).not.toHaveProperty('engines');
    expect(res.body).not.toHaveProperty('components');
    expect(res.body).toHaveProperty('mcpTransport', 'http');
    expect(res.body).toHaveProperty('mcp.enabled', true);
    expect(res.body).toHaveProperty('mcp.status', 'healthy');
    expect(res.body).toHaveProperty('mcp.url', 'http://localhost:3030/mcp');
    expect(res.body).toHaveProperty('dbMode');
    expect(res.body).toHaveProperty('graphMode');
    expect(Array.isArray(res.body.graphWarnings)).toBe(true);
    expect(res.body).toHaveProperty('databaseCapability.dbMode');
    expect(res.body).toHaveProperty('databaseCapability.provider');
    expect(res.body).toHaveProperty('databaseCapability.extensions.age');
    expect(res.body).toHaveProperty('databaseCapability.graphMode');
    expect(Array.isArray(res.body.databaseCapability.warnings)).toBe(true);
    expect(res.body).toHaveProperty('databaseSetup.selectedMode');
    expect(res.body.databaseSetup).toHaveProperty('selectionPersistsAcrossSessions', true);
    expect(res.body.databaseSetup.modes).toHaveLength(3);
    expect(res.body.databaseSetup.graphModes.map((entry: { mode: string }) => entry.mode).sort()).toEqual(['full', 'lite']);
    expect(res.body.dbMode).toBe(res.body.databaseCapability.dbMode);
    expect(res.body.graphMode).toBe(res.body.databaseCapability.graphMode);
    expect(res.body.pgvectorReady).toBe(res.body.databaseCapability.extensions.vector);
    expect(res.body.extensions.includes('age')).toBe(res.body.databaseCapability.extensions.age);
    expect(res.body.extensions.includes('vector')).toBe(res.body.databaseCapability.extensions.vector);
    expect(res.body.extensions.includes('pgcrypto')).toBe(res.body.databaseCapability.extensions.pgcrypto);
    expect(String(res.body.databaseCapability.connection.url ?? '')).not.toContain('@');
  });

  it('reports installed extensions identically in basic and detailed health', async () => {
    const [basic, detailed] = await Promise.all([
      request(app).get('/api/health'),
      request(app).get('/api/health/detailed?refresh=true'),
    ]);
    expect(basic.status).toBe(200);
    expect(detailed.status).toBe(200);
    expect(basic.body.databaseCapability.extensions).toEqual(
      detailed.body.databaseCapability.extensions,
    );
    expect(basic.body.graphMode).toBe(detailed.body.graphMode);
    expect(basic.body.extensions.sort()).toEqual(
      Object.entries(detailed.body.databaseCapability.extensions)
        .filter(([, installed]) => installed)
        .map(([extension]) => extension)
        .sort(),
    );
  });

  it('returns no-cache headers', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['expires']).toBe('0');
  });

  it('does not require authentication', async () => {
    // No auth header — should still return 200
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('provides process-only liveness and an explicit readiness alias', async () => {
    const live = await request(app).get('/api/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ status: 'alive', version: expect.any(String) });
    expect(live.body).not.toHaveProperty('db_connected');

    const ready = await request(app).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      status: 'healthy',
      db_connected: true,
      readiness: { confirmed: true, deadlineMs: 750 },
    });
  });

  it('never invokes executable diagnostics on basic health', async () => {
    const piDetector = require('../../lib/pi-detector') as { detectPi: jest.Mock };
    piDetector.detectPi.mockClear();

    await request(app).get('/api/health');

    expect(piDetector.detectPi).not.toHaveBeenCalled();
  });

  it('reports active runs count relative to current application state', async () => {
    const baseline = (await request(app).get('/api/health')).body.active_runs as number;
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
      [ACTIVE_RUN_WORKSPACE_ID, 'Health active-run fixture', tmpDir],
    );
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, $3)`, ['test-spec.json', ACTIVE_RUN_WORKSPACE_ID, 'running']);
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, $3)`, ['test-spec-2.json', ACTIVE_RUN_WORKSPACE_ID, 'running']);
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, $3)`, ['test-spec-3.json', ACTIVE_RUN_WORKSPACE_ID, 'done']);

    const res = await request(app).get('/api/health');
    expect(res.body.active_runs).toBe(baseline + 2);
  });

  it('reports MCP disabled when RORCA_SERVE_MCP=false', async () => {
    process.env.RORCA_SERVE_MCP = 'false';
    jest.resetModules();
    const mcpDisabledApp = buildHealthTestApp().listen(0, '127.0.0.1');
    await once(mcpDisabledApp, 'listening');
    try {
      const res = await request(mcpDisabledApp).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.mcpTransport).toBe('disabled');
      expect(res.body.mcp).toMatchObject({
        enabled: false,
        status: 'disabled',
        url: 'http://localhost:3030/mcp',
        sessions: 0,
      });
    } finally {
      mcpDisabledApp.closeAllConnections();
      await new Promise<void>((resolve, reject) => mcpDisabledApp.close((error) => error ? reject(error) : resolve()));
      delete process.env.RORCA_SERVE_MCP;
    }
  });
});

describe('GET /api/health/detailed', () => {
  it('returns 200 with all detailed fields', async () => {
    const res = await request(app).get('/api/health/detailed');

    expect(res.status).toBe(200);
    expect(['healthy', 'degraded']).toContain(res.body.status);
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('db_connected', true);
    expect(res.body).toHaveProperty('active_runs');
    expect(res.body).toHaveProperty('pending_specs_count');
    expect(typeof res.body.pending_specs_count).toBe('number');
    expect(res.body).toHaveProperty('memory_usage');
    expect(res.body.memory_usage).toHaveProperty('rss');
    expect(res.body.memory_usage).toHaveProperty('heapTotal');
    expect(res.body.memory_usage).toHaveProperty('heapUsed');
    expect(res.body.memory_usage).toHaveProperty('external');
    expect(res.body).toHaveProperty('last_backup_at');
    expect(res.body).toHaveProperty('dbMode');
    expect(res.body).toHaveProperty('graphMode');
    expect(Array.isArray(res.body.graphWarnings)).toBe(true);
    expect(res.body).toHaveProperty('databaseCapability.graphMode');
    expect(res.body).toHaveProperty('databaseSetup.selectedMode');
    expect(res.body.databaseSetup.modes).toHaveLength(3);
    expect(res.body).toHaveProperty('piInstalled', false);
    expect(res.body).toHaveProperty('piVersion', null);
    expect(res.body).toHaveProperty('piBinPath', null);
    expect(res.body).toHaveProperty('engines');
    expect(res.body).toHaveProperty('components.database');
    expect(res.body).toHaveProperty('components.worker');
    expect(res.body).toHaveProperty('activeJobs');
    expect(res.body).toHaveProperty('scheduledJobs');
    expect(res.body.dbMode).toBe(res.body.databaseCapability.dbMode);
    expect(res.body.graphMode).toBe(res.body.databaseCapability.graphMode);
    expect(res.body.pgvectorReady).toBe(res.body.databaseCapability.extensions.vector);
    expect(res.body.components.database.extensionStatus).toEqual(res.body.databaseCapability.extensions);
    expect(res.body.components.migrations).toEqual(expect.objectContaining({
      status: 'ok',
      pending: 0,
      currentVersion: expect.any(String),
      canonicalVersion: expect.any(String),
      canonicalFilename: expect.stringMatching(/\.sql$/),
    }));
    expect(res.body.components.migrations.currentVersion).toBe(res.body.components.migrations.canonicalVersion);
  });

  it('returns no-cache headers', async () => {
    const res = await request(app).get('/api/health/detailed');

    expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/health/detailed');
    expect(res.status).toBe(200);
  });

  it('counts pending specs from workspace directories', async () => {
    // Create a workspace with pending specs
    // Get baseline count before adding our test workspace
    const baselineRes = await request(app).get('/api/health/detailed');
    const baseline = baselineRes.body.pending_specs_count as number;

    const wsDir = path.join(tmpDir, 'test-workspace');
    const pendingDir = path.join(wsDir, 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'spec-a.json'), '{}');
    fs.writeFileSync(path.join(pendingDir, 'spec-b.json'), '{}');

    await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, ['health-test-ws', 'TestWS', wsDir]);

    const res = await request(app).get('/api/health/detailed?refresh=true');
    expect(res.body.pending_specs_count).toBe(baseline + 2);
  });

  it('returns last_backup_at as null when no backups exist', async () => {
    // Force a fresh snapshot after binding this assertion to its own empty dir;
    // a prior detailed-health request may otherwise legitimately remain cached.
    const previousBackupDir = process.env.BACKUP_DIR;
    const emptyBackupDir = path.join(tmpDir, 'no-backups');
    fs.mkdirSync(emptyBackupDir, { recursive: true });
    process.env.BACKUP_DIR = emptyBackupDir;
    try {
      const res = await request(app).get('/api/health/detailed?refresh=true');
      expect(res.body.last_backup_at).toBeNull();
    } finally {
      if (previousBackupDir === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = previousBackupDir;
    }
  });

  it('returns memory_usage with positive values', async () => {
    const res = await request(app).get('/api/health/detailed');
    expect(res.body.memory_usage.rss).toBeGreaterThan(0);
    expect(res.body.memory_usage.heapUsed).toBeGreaterThan(0);
    expect(res.body.memory_usage.heapTotal).toBeGreaterThan(0);
  });
});

// OC-002: OpenCode fields in health endpoint
describe('GET /api/health (agentType=claude)', () => {
  it('does not include opencode fields when agentType is claude', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body).not.toHaveProperty('opencodeInstalled');
    expect(res.body).not.toHaveProperty('opencodeVersion');
  });
});

describe('GET /api/health (agentType=opencode)', () => {
  let ocApp: Server;
  let ocTmpDir: string;

  beforeAll(async () => {
    jest.resetModules();

    jest.mock('../../lib/llm-client', () => ({
      chatComplete: jest.fn(),
      getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
      isValidModel: jest.fn().mockReturnValue(true),
      DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
      resolveVaultProvider: jest.fn().mockReturnValue(null),
      getModelInfo: jest.fn().mockReturnValue(undefined),
      SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
    }));

    // Mock config to return opencode as agent type
    jest.mock('../../lib/config', () => ({
      agentType: 'opencode',
      agentModel: 'openai/gpt-4o',
      agentConfig: { agentType: 'opencode', agentModel: 'openai/gpt-4o' },
      parseAgentConfig: jest.fn(),
      VALID_AGENT_TYPES: ['claude', 'opencode', 'codex', 'pi'],
    }));

    // Mock opencode-detector to return a known status
    jest.mock('../../lib/opencode-detector', () => ({
      detectOpenCode: jest.fn().mockReturnValue({
        opencodeInstalled: true,
        opencodeVersion: '0.2.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      }),
      detectOpenCodeAsync: jest.fn().mockResolvedValue({
        opencodeInstalled: true,
        opencodeVersion: '0.2.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      }),
      requireOpenCode: jest.fn().mockReturnValue({
        opencodeInstalled: true,
        opencodeVersion: '0.2.0',
        opencodeBinPath: '/usr/local/bin/opencode',
      }),
      MIN_OPENCODE_VERSION: '0.1.0',
      semverGte: jest.fn().mockReturnValue(true),
    }));
    jest.mock('../../lib/pi-detector', () => ({
      detectPi: jest.fn().mockReturnValue({
        piInstalled: true,
        piVersion: '1.2.3',
        piBinPath: '/usr/local/bin/pi',
      }),
      detectPiAsync: jest.fn().mockResolvedValue({
        piInstalled: true,
        piVersion: '1.2.3',
        piBinPath: '/usr/local/bin/pi',
      }),
    }));

    ocTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-oc-test-'));
    const _dbPath = path.join(ocTmpDir, 'test.db');
process.env.NODE_ENV = 'test';

    ocApp = buildHealthTestApp().listen(0, '127.0.0.1');
    await once(ocApp, 'listening');
  });

  afterAll(async () => {
    ocApp.closeAllConnections();
    await new Promise<void>((resolve, reject) => ocApp.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    fs.rmSync(ocTmpDir, { recursive: true, force: true });
  });

  it('keeps executable status off basic health', async () => {
    const res = await request(ocApp).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('opencodeInstalled');
    expect(res.body).not.toHaveProperty('piInstalled');
  });

  it('includes executable status in detailed health', async () => {
    const res = await request(ocApp).get('/api/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.opencodeInstalled).toBe(true);
    expect(res.body.opencodeVersion).toBe('0.2.0');
    expect(res.body.piInstalled).toBe(true);
    expect(res.body.piVersion).toBe('1.2.3');
    expect(res.body.piBinPath).toBe('/usr/local/bin/pi');
  });
});

describe('GET /api/health (pi detector failure)', () => {
  let failApp: Server;
  let failTmpDir: string;

  beforeEach(async () => {
    jest.resetModules();

    jest.mock('../../lib/llm-client', () => ({
      chatComplete: jest.fn(),
      getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
      isValidModel: jest.fn().mockReturnValue(true),
      DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
      resolveVaultProvider: jest.fn().mockReturnValue(null),
      getModelInfo: jest.fn().mockReturnValue(undefined),
      SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
    }));
    jest.mock('../../lib/pi-detector', () => ({
      detectPi: jest.fn(() => {
        throw new Error('pi detector failed');
      }),
      detectPiAsync: jest.fn().mockRejectedValue(new Error('pi detector failed')),
    }));

    failTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-pi-fail-test-'));
    const _dbPath = path.join(failTmpDir, 'test.db');
process.env.NODE_ENV = 'test';

    failApp = buildHealthTestApp().listen(0, '127.0.0.1');
    await once(failApp, 'listening');
  });

  afterEach(async () => {
    failApp.closeAllConnections();
    await new Promise<void>((resolve, reject) => failApp.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(failTmpDir, { recursive: true, force: true });
  });

  it('returns 200 and null pi fields when detailed detectPi throws', async () => {
    const res = await request(failApp).get('/api/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.piInstalled).toBe(false);
    expect(res.body.piVersion).toBeNull();
    expect(res.body.piBinPath).toBeNull();
  });
});
