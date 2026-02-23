import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-wal-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;
  authToken = await getAuthToken(app);

  // Clear WAL events from user registration so tests start with a clean slate
  db.prepare('DELETE FROM wal_events').run();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

function insertWalEvent(eventType: string, workspaceId?: string) {
  db.prepare(
    'INSERT INTO wal_events (event_type, workspace_id) VALUES (?, ?)'
  ).run(eventType, workspaceId || null);
}

test('GET /api/wal returns all 3 inserted events, newest first', async () => {
  insertWalEvent('workspace_create', 'ws-1');
  insertWalEvent('direction_update', 'ws-1');
  insertWalEvent('generate', 'ws-1');

  const res = await request(app).get('/api/wal').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.events).toHaveLength(3);
  expect(res.body.total).toBe(3);
  expect(res.body.limit).toBe(50);
  expect(res.body.offset).toBe(0);
  // Newest first (DESC by id)
  expect(res.body.events[0].event_type).toBe('generate');
  expect(res.body.events[1].event_type).toBe('direction_update');
  expect(res.body.events[2].event_type).toBe('workspace_create');
});

test('limit=2 returns only 2 events, total still reflects full count', async () => {
  insertWalEvent('workspace_create', 'ws-1');
  insertWalEvent('direction_update', 'ws-1');
  insertWalEvent('generate', 'ws-1');

  const res = await request(app).get('/api/wal?limit=2').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.events).toHaveLength(2);
  expect(res.body.total).toBe(3);
  expect(res.body.limit).toBe(2);
});

test('offset=1 skips the newest event', async () => {
  insertWalEvent('workspace_create', 'ws-1');
  insertWalEvent('direction_update', 'ws-1');
  insertWalEvent('generate', 'ws-1');

  const res = await request(app).get('/api/wal?offset=1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.events).toHaveLength(2);
  expect(res.body.offset).toBe(1);
  // Skipped 'generate' (newest), first result is 'direction_update'
  expect(res.body.events[0].event_type).toBe('direction_update');
  expect(res.body.events[1].event_type).toBe('workspace_create');
});

test('empty WAL returns events:[], total:0', async () => {
  const res = await request(app).get('/api/wal').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.events).toEqual([]);
  expect(res.body.total).toBe(0);
  expect(res.body.limit).toBe(50);
  expect(res.body.offset).toBe(0);
});
