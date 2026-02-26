import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';

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
let db: Database.Database;
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-health-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;
});

afterEach(() => {
  if (db) db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('returns 200 with required fields', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'healthy');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('uptime');
    expect(typeof res.body.uptime).toBe('number');
    expect(res.body).toHaveProperty('db_connected', true);
    expect(res.body).toHaveProperty('active_runs', 0);
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
    db.prepare("INSERT INTO workspaces (id, label, path) VALUES (?, ?, ?)").run('ws-1', 'TestWS', tmpDir);
    db.prepare(
      "INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, ?)"
    ).run('test-spec.json', 'ws-1', 'running');
    db.prepare(
      "INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, ?)"
    ).run('test-spec-2.json', 'ws-1', 'running');
    db.prepare(
      "INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES (?, ?, ?)"
    ).run('test-spec-3.json', 'ws-1', 'done');

    const res = await request(app).get('/api/health');
    expect(res.body.active_runs).toBe(2);
  });
});

describe('GET /api/health/detailed', () => {
  it('returns 200 with all detailed fields', async () => {
    const res = await request(app).get('/api/health/detailed');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'healthy');
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('uptime');
    expect(res.body).toHaveProperty('db_connected', true);
    expect(res.body).toHaveProperty('active_runs');
    expect(res.body).toHaveProperty('db_size');
    expect(typeof res.body.db_size).toBe('number');
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
    const wsDir = path.join(tmpDir, 'test-workspace');
    const pendingDir = path.join(wsDir, 'scripts', 'ralph', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'spec-a.json'), '{}');
    fs.writeFileSync(path.join(pendingDir, 'spec-b.json'), '{}');

    db.prepare("INSERT INTO workspaces (id, label, path) VALUES (?, ?, ?)").run('ws-1', 'TestWS', wsDir);

    const res = await request(app).get('/api/health/detailed');
    expect(res.body.pending_specs_count).toBe(2);
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
