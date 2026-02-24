import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';

let db: Database.Database;
let runMigrations: () => void;
let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  const mod = require('../index');
  db = mod.db;
  runMigrations = mod.runMigrations;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

test('PRAGMA journal_mode returns wal', () => {
  const result = db.pragma('journal_mode') as { journal_mode: string }[];
  expect(result[0].journal_mode).toBe('wal');
});

test('all core tables plus FTS5 tables exist in sqlite_master', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const names = tables.map(t => t.name).sort();
  expect(names).toEqual([
    'agent_hooks',
    'api_key_vault',
    'budget_config',
    'direction_layers',
    'github_connections',
    'model_pricing',
    'onboarding_state',
    'pipeline_hooks',
    'pipeline_runs',
    'pipeline_schedules',
    'rate_limits',
    'refresh_tokens',
    'spec_assignments',
    'spec_search_index',
    'spec_search_index_config',
    'spec_search_index_content',
    'spec_search_index_data',
    'spec_search_index_docsize',
    'spec_search_index_idx',
    'spec_tags',
    'spec_versions',
    'story_comments',
    'story_commits',
    'story_results',
    'team_invites',
    'team_members',
    'teams',
    'template_ratings',
    'templates',
    'token_usage',
    'users',
    'wal_events',
    'workspace_access',
    'workspace_context',
    'workspace_env_vars',
    'workspace_github_webhooks',
    'workspaces',
  ]);
});

test('can INSERT and SELECT from each table', () => {
  // workspaces
  db.prepare("INSERT INTO workspaces (id, label, path) VALUES ('w1', 'Test', '/tmp')").run();
  const ws = db.prepare("SELECT * FROM workspaces WHERE id = 'w1'").get() as Record<string, unknown>;
  expect(ws.label).toBe('Test');

  // direction_layers
  db.prepare("INSERT INTO direction_layers (workspace_id, layer, content_yaml) VALUES ('w1', 1, 'key: val')").run();
  const dl = db.prepare("SELECT * FROM direction_layers WHERE workspace_id = 'w1'").get() as Record<string, unknown>;
  expect(dl.content_yaml).toBe('key: val');

  // pipeline_runs
  db.prepare("INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('spec.yaml', 'w1', 'running')").run();
  const pr = db.prepare("SELECT * FROM pipeline_runs WHERE workspace_id = 'w1'").get() as Record<string, unknown>;
  expect(pr.status).toBe('running');

  // story_results
  const runId = (pr as { id: number }).id;
  db.prepare("INSERT INTO story_results (run_id, story_id, status) VALUES (?, 'US-001', 'pass')").run(runId);
  const sr = db.prepare("SELECT * FROM story_results WHERE story_id = 'US-001'").get() as Record<string, unknown>;
  expect(sr.status).toBe('pass');

  // wal_events
  db.prepare("INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('test', 'w1', '{\"a\":1}')").run();
  const we = db.prepare("SELECT * FROM wal_events WHERE event_type = 'test'").get() as Record<string, unknown>;
  expect(we.actor).toBe('ralph');
});

test('running runMigrations() twice does not throw', () => {
  expect(() => runMigrations()).not.toThrow();
});
