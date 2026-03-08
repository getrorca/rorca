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

const WORKSPACE_ID = 'ws-budget-test';

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-budget-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES (?, 'Test Workspace', ?)"
  ).run(WORKSPACE_ID, tmpDir);

  authToken = await getAuthToken(app);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

describe('GET /api/workspaces/:id/budget', () => {
  it('returns null config when no budget is set', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.config).toBeNull();
    expect(res.body.spending_usd).toBe(0);
    expect(res.body.remaining_usd).toBeNull();
    expect(res.body.alert_triggered).toBe(false);
    expect(res.body.cap_exceeded).toBe(false);
  });

  it('returns budget config and spending status', async () => {
    db.prepare(
      "INSERT INTO budget_config (workspace_id, alert_threshold_usd, hard_cap_usd, period, notify_emails) VALUES (?, 10, 50, 'monthly', '[]')"
    ).run(WORKSPACE_ID);

    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.config).not.toBeNull();
    expect(res.body.config.period).toBe('monthly');
    expect(res.body.config.alert_threshold_usd).toBe(10);
    expect(res.body.config.hard_cap_usd).toBe(50);
    expect(res.body.spending_usd).toBe(0);
    expect(res.body.remaining_usd).toBe(50);
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .get('/api/workspaces/nonexistent/budget')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:id/budget', () => {
  it('creates a new budget config', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        alert_threshold_usd: 10,
        hard_cap_usd: 50,
        period: 'monthly',
        notify_emails: ['admin@example.com'],
      });

    expect(res.status).toBe(200);
    expect(res.body.config.alert_threshold_usd).toBe(10);
    expect(res.body.config.hard_cap_usd).toBe(50);
    expect(res.body.config.period).toBe('monthly');
    expect(res.body.config.notify_emails).toEqual(['admin@example.com']);
    expect(res.body.alert_triggered).toBe(false);
    expect(res.body.cap_exceeded).toBe(false);
  });

  it('upserts existing budget config', async () => {
    db.prepare(
      "INSERT INTO budget_config (workspace_id, alert_threshold_usd, hard_cap_usd, period, notify_emails) VALUES (?, 5, 20, 'daily', '[]')"
    ).run(WORKSPACE_ID);

    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ alert_threshold_usd: 25, hard_cap_usd: 100, period: 'weekly' });

    expect(res.status).toBe(200);
    expect(res.body.config.alert_threshold_usd).toBe(25);
    expect(res.body.config.hard_cap_usd).toBe(100);
    expect(res.body.config.period).toBe('weekly');

    const count = (db.prepare('SELECT COUNT(*) as c FROM budget_config WHERE workspace_id = ?').get(WORKSPACE_ID) as { c: number }).c;
    expect(count).toBe(1);
  });

  it('returns 400 for invalid period', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ period: 'yearly' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/period must be one of/i);
  });

  it('returns 400 when alert_threshold >= hard_cap', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ alert_threshold_usd: 100, hard_cap_usd: 50 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/alert_threshold_usd must be less than hard_cap_usd/i);
  });

  it('returns 400 for negative threshold', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ alert_threshold_usd: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be negative/i);
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/workspaces/nonexistent/budget')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ period: 'monthly' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/workspaces/:id/budget', () => {
  it('deletes an existing budget config', async () => {
    db.prepare(
      "INSERT INTO budget_config (workspace_id, period, notify_emails) VALUES (?, 'monthly', '[]')"
    ).run(WORKSPACE_ID);

    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const gone = db.prepare('SELECT * FROM budget_config WHERE workspace_id = ?').get(WORKSPACE_ID);
    expect(gone).toBeUndefined();
  });

  it('returns 404 when no budget config exists', async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no budget config found/i);
  });
});
