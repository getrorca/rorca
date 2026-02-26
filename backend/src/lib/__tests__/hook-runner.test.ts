import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let db: Database.Database;
let runHooks: typeof import('../hook-runner').runHooks;
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hookrunner-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const dbMod = require('../../db/index');
  db = dbMod.db;

  const hookRunnerMod = require('../hook-runner');
  runHooks = hookRunnerMod.runHooks;

  // Seed workspace
  db.prepare(
    "INSERT INTO workspaces (id, label, path) VALUES ('ws-hr', 'Hook Runner WS', ?)"
  ).run(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

test('returns empty array when no hooks exist', () => {
  const results = runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toEqual([]);
});

test('runs a successful hook and captures output', () => {
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'pre_run', 'echo hello_world', 1)`
  ).run();

  const results = runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(0);
  expect(results[0].output).toContain('hello_world');
});

test('captures non-zero exit code', () => {
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'post_run', 'exit 42', 1)`
  ).run();

  const results = runHooks('ws-hr', 'post_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(42);
});

test('pre_run hooks abort on first failure', () => {
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'pre_run', 'exit 1', 1)`
  ).run();
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'pre_run', 'echo should_not_run', 1)`
  ).run();

  const results = runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(1);
});

test('post_run hooks continue after failure', () => {
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'post_run', 'exit 1', 1)`
  ).run();
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'post_run', 'echo second_hook', 1)`
  ).run();

  const results = runHooks('ws-hr', 'post_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(2);
  expect(results[0].exitCode).toBe(1);
  expect(results[1].exitCode).toBe(0);
  expect(results[1].output).toContain('second_hook');
});

test('skips disabled hooks', () => {
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'pre_run', 'echo disabled', 0)`
  ).run();
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'pre_run', 'echo enabled', 1)`
  ).run();

  const results = runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].output).toContain('enabled');
});

test('passes environment variables to hooks', () => {
  db.prepare(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ('ws-hr', 'post_run', 'echo $RUN_STATUS-$RUN_ID', 1)`
  ).run();

  const results = runHooks('ws-hr', 'post_run', tmpDir, {
    PATH: process.env.PATH!,
    RUN_STATUS: 'done',
    RUN_ID: '42',
  });
  expect(results).toHaveLength(1);
  expect(results[0].output).toContain('done-42');
});
