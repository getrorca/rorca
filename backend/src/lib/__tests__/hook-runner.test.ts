import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let execute: typeof import('../../db/index').execute;
let runHooks: typeof import('../hook-runner').runHooks;
let tmpDir: string;

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hookrunner-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const dbMod = require('../../db/index');
  await dbMod.initDb();
  execute = dbMod.execute;

  const hookRunnerMod = require('../hook-runner');
  runHooks = hookRunnerMod.runHooks;

  // Seed workspace
  await execute(
    "INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)",
    ['ws-hr', 'Hook Runner WS', tmpDir],
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

test('returns empty array when no hooks exist', async () => {
  const results = await runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toEqual([]);
});

test('runs a successful hook and captures output', async () => {
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'pre_run', 'echo hello_world', 1],
  );

  const results = await runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(0);
  expect(results[0].output).toContain('hello_world');
});

test('captures non-zero exit code', async () => {
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'post_run', 'exit 42', 1],
  );

  const results = await runHooks('ws-hr', 'post_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(42);
});

test('pre_run hooks abort on first failure', async () => {
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'pre_run', 'exit 1', 1],
  );
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'pre_run', 'echo should_not_run', 1],
  );

  const results = await runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].exitCode).toBe(1);
});

test('post_run hooks continue after failure', async () => {
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'post_run', 'exit 1', 1],
  );
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'post_run', 'echo second_hook', 1],
  );

  const results = await runHooks('ws-hr', 'post_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(2);
  expect(results[0].exitCode).toBe(1);
  expect(results[1].exitCode).toBe(0);
  expect(results[1].output).toContain('second_hook');
});

test('skips disabled hooks', async () => {
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'pre_run', 'echo disabled', 0],
  );
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'pre_run', 'echo enabled', 1],
  );

  const results = await runHooks('ws-hr', 'pre_run', tmpDir, { PATH: process.env.PATH! });
  expect(results).toHaveLength(1);
  expect(results[0].output).toContain('enabled');
});

test('passes environment variables to hooks', async () => {
  await execute(
    `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES ($1, $2, $3, $4)`,
    ['ws-hr', 'post_run', 'echo $RUN_STATUS-$RUN_ID', 1],
  );

  const results = await runHooks('ws-hr', 'post_run', tmpDir, {
    PATH: process.env.PATH!,
    RUN_STATUS: 'done',
    RUN_ID: '42',
  });
  expect(results).toHaveLength(1);
  expect(results[0].output).toContain('done-42');
});
