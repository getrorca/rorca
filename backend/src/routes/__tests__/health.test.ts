import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
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

let app: Express;
let tmpDir: string;

beforeEach(() => {
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
    detectPi: jest.fn().mockReturnValue({
      piInstalled: false,
      piVersion: null,
      piBinPath: null,
    }),
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
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
    expect(res.body).toHaveProperty('active_runs', 0);
    expect(res.body).toHaveProperty('piInstalled', false);
    expect(res.body).toHaveProperty('piVersion', null);
    expect(res.body).toHaveProperty('piBinPath', null);
    expect(res.body).toHaveProperty('mcpTransport', 'http');
    expect(res.body).toHaveProperty('mcp.enabled', true);
    expect(res.body).toHaveProperty('mcp.status', 'healthy');
    expect(res.body).toHaveProperty('mcp.url', 'http://localhost:3030/mcp');
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

  it('reports active runs count', async () => {
    // Seed a workspace and a running pipeline
    await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, ['ws-1', 'TestWS', tmpDir]);
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, $3)`, ['test-spec.json', 'ws-1', 'running']);
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, $3)`, ['test-spec-2.json', 'ws-1', 'running']);
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, $2, $3)`, ['test-spec-3.json', 'ws-1', 'done']);

    const res = await request(app).get('/api/health');
    expect(res.body.active_runs).toBe(2);
  });

  it('reports MCP disabled when RORCA_SERVE_MCP=false', async () => {
    process.env.RORCA_SERVE_MCP = 'false';
    jest.resetModules();
    const serverMod = require('../../server');
    const mcpDisabledApp = serverMod.default as Express;

    const res = await request(mcpDisabledApp).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.mcpTransport).toBe('disabled');
    expect(res.body.mcp).toMatchObject({
      enabled: false,
      status: 'disabled',
      url: 'http://localhost:3030/mcp',
      sessions: 0,
    });

    delete process.env.RORCA_SERVE_MCP;
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

    const res = await request(app).get('/api/health/detailed');
    expect(res.body.pending_specs_count).toBe(baseline + 2);
  });

  it('returns last_backup_at as null when no backups exist', async () => {
    // Point backup dir to empty location
    process.env.BACKUP_DIR = path.join(tmpDir, 'no-backups');

    const res = await request(app).get('/api/health/detailed');
    expect(res.body.last_backup_at).toBeNull();
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
  let ocApp: Express;
  let ocTmpDir: string;

  beforeEach(() => {
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
      VALID_AGENT_TYPES: ['claude', 'opencode', 'codex'],
    }));

    // Mock opencode-detector to return a known status
    jest.mock('../../lib/opencode-detector', () => ({
      detectOpenCode: jest.fn().mockReturnValue({
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
    }));

    ocTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-oc-test-'));
    const _dbPath = path.join(ocTmpDir, 'test.db');
process.env.NODE_ENV = 'test';

    const serverMod = require('../../server');
    ocApp = serverMod.default;
});

  afterEach(() => {
fs.rmSync(ocTmpDir, { recursive: true, force: true });
  });

  it('includes opencodeInstalled and opencodeVersion when agentType=opencode', async () => {
    const res = await request(ocApp).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.opencodeInstalled).toBe(true);
    expect(res.body.opencodeVersion).toBe('0.2.0');
    expect(res.body.piInstalled).toBe(true);
    expect(res.body.piVersion).toBe('1.2.3');
    expect(res.body.piBinPath).toBe('/usr/local/bin/pi');
  });

  it('includes opencode fields in detailed health too', async () => {
    const res = await request(ocApp).get('/api/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body.opencodeInstalled).toBe(true);
    expect(res.body.opencodeVersion).toBe('0.2.0');
  });
});

describe('GET /api/health (pi detector failure)', () => {
  let failApp: Express;
  let failTmpDir: string;

  beforeEach(() => {
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
    }));

    failTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-pi-fail-test-'));
    const _dbPath = path.join(failTmpDir, 'test.db');
process.env.NODE_ENV = 'test';

    const serverMod = require('../../server');
    failApp = serverMod.default;
  });

  afterEach(() => {
fs.rmSync(failTmpDir, { recursive: true, force: true });
  });

  it('returns 200 and null pi fields when detectPi throws', async () => {
    const res = await request(failApp).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.piInstalled).toBe(false);
    expect(res.body.piVersion).toBeNull();
    expect(res.body.piBinPath).toBeNull();
  });
});
