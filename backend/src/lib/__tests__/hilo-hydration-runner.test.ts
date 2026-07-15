/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  createHydration,
  getHydrationById,
  type WorkspaceHydration,
} from '../../db/workspace-hydration';
import { resolveHiloConfig, type HiloConfig } from '../hilo-config';
import {
  buildHiloArgs,
  HILO_MAX_OUTPUT_BYTES,
  runHiloHydration,
  type HiloHydrationRunError,
} from '../hilo-hydration-runner';
import { closeTestPool, getTestPool, truncateAll } from '../../__tests__/helpers/pg-test-utils';
import type { Pool } from 'pg';

// ── Mock child_process ──────────────────────────────────────────────

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: jest.fn(),
  };
});

// We get the mocked execFile through the require helper.
import { execFile as mockExecFileRaw } from 'child_process';
const mockExecFile = mockExecFileRaw as jest.MockedFunction<typeof mockExecFileRaw>;

let pool: Pool;

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE workspace_hydration RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO workspaces (id, label, path)
     VALUES ('ws-sut', 'SUT Workspace', '/tmp/ws-sut')
     ON CONFLICT (id) DO NOTHING`,
  );
  jest.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────

const emptyEnv: NodeJS.ProcessEnv = {};

function makeEnabledConfig(overrides: Partial<HiloConfig> = {}): HiloConfig {
  return resolveHiloConfig({
    workspaceRoot: '/tmp/ws-sut',
    env: emptyEnv,
    config: {
      hilo: {
        enabled: true,
        binaryPath: '/fake/hilo',
        outputDir: '.rorca/hilo',
        timeoutMs: 30_000,
        ...overrides,
      },
    },
  });
}

async function createPendingHydration(): Promise<WorkspaceHydration> {
  return createHydration({
    workspaceId: 'ws-sut',
    status: 'pending',
  });
}

/** Create a temporary directory that exists on disk (valid cwd). */
function createTempCheckout(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-checkout-'));
}

/** Create a temporary output directory. */
function createTempOutputDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-output-'));
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe('hilo-hydration-runner (US-007)', () => {
  let checkoutDir: string;
  let outputDir: string;

  beforeEach(() => {
    checkoutDir = createTempCheckout();
    outputDir = createTempOutputDir();
  });

  afterEach(() => {
    try { fs.rmSync(checkoutDir, { recursive: true, force: true }); } catch { /* cleanup */ }
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  // ── buildHiloArgs ─────────────────────────────────────────────────

  describe('buildHiloArgs', () => {
    it('produces safe argument arrays from the resolved config', () => {
      const config = makeEnabledConfig({
        checkoutPath: '/repo',
        outputDir: '/repo/.rorca/hilo',
      });
      const args = buildHiloArgs(config);
      expect(args).toEqual(['/repo', '--output', '/repo/.rorca/hilo']);
      for (const arg of args) {
        expect(typeof arg).toBe('string');
        expect(arg).not.toContain('&&');
        expect(arg).not.toContain(';');
        expect(arg).not.toContain('|');
      }
    });
  });

  // ── Success path ──────────────────────────────────────────────────

  it('records graph location, git SHA, duration, and provider metadata on success', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    // First call = hilo success, second = git rev-parse success
    let callCount = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        // hilo success
        if (typeof cb === 'function') cb(null, '', '');
      } else {
        // git rev-parse success
        if (typeof cb === 'function') cb(null, 'abc1234\n', '');
      }
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({
      hydration,
      config,
      binaryPathOverride: '/usr/bin/hilo',
      argsOverride: ['scan', checkoutDir, '--output', outputDir],
    });

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.gitSha).toBe('abc1234');
      expect(result.graphPath).toBe(outputDir);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.metadata).toMatchObject({
        provider: 'hilo',
        binaryPath: '/usr/bin/hilo',
        graphPath: outputDir,
        gitSha: 'abc1234',
      });
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.gitSha).toBe('abc1234');
    expect(updated?.graphPath).toBe(outputDir);
    expect(updated?.durationMs).toBeGreaterThanOrEqual(0);
    expect(updated?.errorJson).toBeNull();
    expect(updated?.startedAt).toBeInstanceOf(Date);
    expect(updated?.finishedAt).toBeInstanceOf(Date);
  });

  it('handles success when the checkout is not a git repo (null sha)', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    let callCount = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        // hilo success
        if (typeof cb === 'function') cb(null, '', '');
      } else {
        // git rev-parse fails
        if (typeof cb === 'function') {
          const e: ExecFileException = new Error('fatal: not a git repository');
          cb(e, '', '');
        }
      }
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') {
      expect(result.gitSha).toBeNull();
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('succeeded');
    expect(updated?.gitSha).toBeNull();
  });

  it('creates the output directory automatically when missing', async () => {
    const nestedOutput = path.join(outputDir, 'nested', 'hilo');
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir: nestedOutput });
    const hydration = await createPendingHydration();

    let callCount = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        if (typeof cb === 'function') cb(null, '', '');
      } else {
        if (typeof cb === 'function') cb(null, 'sha\n', '');
      }
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });
    expect(result.status).toBe('succeeded');
    expect(fs.existsSync(nestedOutput)).toBe(true);
  });

  // ── Non-zero exit ─────────────────────────────────────────────────

  it('records sanitized error_json on non-zero exit', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const e = Object.assign(new Error('Command failed: hilo --bad-flag'), {
        code: 2,
      }) as ExecFileException & { code: number };
      if (typeof cb === 'function') cb(e, '', 'unknown flag: --bad-flag\n');
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_NONZERO_EXIT');
      expect(result.error.exitCode).toBe(2);
      expect(result.error.timedOut).toBe(false);
      expect(result.error.stderrTail).toContain('unknown flag');
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.errorJson).toBeTruthy();
    const errJson = updated?.errorJson as unknown as HiloHydrationRunError;
    expect(errJson.code).toBe('HILO_NONZERO_EXIT');
    expect(errJson.exitCode).toBe(2);
    expect(updated?.finishedAt).toBeInstanceOf(Date);
  });

  // ── Timeout ───────────────────────────────────────────────────────

  it('records sanitized error_json on timeout and never leaves running status', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir, timeoutMs: 100 });
    const hydration = await createPendingHydration();

    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const e = Object.assign(new Error('ETIMEDOUT'), {
        killed: true,
        signal: 'SIGTERM' as NodeJS.Signals,
      }) as ExecFileException & { killed?: boolean; signal?: NodeJS.Signals };
      if (typeof cb === 'function') cb(e, '', 'processing...\n');
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_TIMEOUT');
      expect(result.error.timedOut).toBe(true);
      expect(result.error.signal).toBe('SIGTERM');
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.finishedAt).toBeInstanceOf(Date);
    expect(updated?.status).not.toBe('running');
  });

  // ── Missing workspace ─────────────────────────────────────────────

  it('returns HILO_WORKSPACE_MISSING and never leaves running when cwd does not exist', async () => {
    const config = makeEnabledConfig({
      checkoutPath: '/nonexistent/path/xyz',
      outputDir,
    });
    const hydration = await createPendingHydration();

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_WORKSPACE_MISSING');
      expect(result.error.message).toContain('does not exist');
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.finishedAt).toBeInstanceOf(Date);
  });

  it('returns HILO_WORKSPACE_MISSING when cwd is a file, not a directory', async () => {
    const tmpFile = path.join(os.tmpdir(), 'hilo-not-a-dir');
    fs.writeFileSync(tmpFile, 'not a directory');
    try {
      const config = makeEnabledConfig({ checkoutPath: tmpFile, outputDir });
      const hydration = await createPendingHydration();

      const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error.code).toBe('HILO_WORKSPACE_MISSING');
        expect(result.error.message).toContain('not a directory');
      }

      const updated = await getHydrationById(hydration.id);
      expect(updated?.status).toBe('failed');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  // ── Signal kill ───────────────────────────────────────────────────

  it('records sanitized error on SIGKILL', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const e = Object.assign(new Error('killed'), {
        signal: 'SIGKILL' as NodeJS.Signals,
      }) as ExecFileException & { signal?: NodeJS.Signals };
      if (typeof cb === 'function') cb(e, '', '');
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_SIGNAL');
      expect(result.error.signal).toBe('SIGKILL');
      expect(result.error.exitCode).toBeNull();
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.errorJson).toBeTruthy();
  });

  // ── Spawn failure (ENOENT) ────────────────────────────────────────

  it('records HILO_SPAWN_FAILED when the binary cannot be found', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const e = Object.assign(new Error('spawn /bad/path ENOENT'), {
        code: 'ENOENT',
      }) as ExecFileException & { code: string };
      if (typeof cb === 'function') cb(e, '', '');
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({
      hydration,
      config,
      binaryPathOverride: '/bad/path/to/hilo',
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_SPAWN_FAILED');
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('failed');
  });

  // ── Missing binary path ────────────────────────────────────────────

  it('fails cleanly when binaryPath is null', async () => {
    const config = makeEnabledConfig({
      checkoutPath: checkoutDir,
      outputDir,
      binaryPath: null as unknown as string,
    });
    const hydration = await createPendingHydration();

    const result = await runHiloHydration({ hydration, config });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_SPAWN_FAILED');
    }
  });

  // ── Stderr capture / bounds ────────────────────────────────────────

  it('captures and truncates stderr in error_json', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    const longStderr = 'Line: ' + 'x'.repeat(10_000) + '\n' + 'Short\n';

    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      const e = Object.assign(new Error('exit'), {
        code: 1,
      }) as ExecFileException & { code: number };
      if (typeof cb === 'function') cb(e, '', longStderr);
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.stderrTail).not.toContain('x'.repeat(10_000));
      expect(result.error.stderrTail).toContain('Short');
      expect(result.error.stderrTail?.length).toBeLessThanOrEqual(HILO_MAX_OUTPUT_BYTES);
    }
  });

  // ── maxBuffer protection ────────────────────────────────────────────

  it('verifies maxBuffer is passed to execFile call options', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    let callCount = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        if (typeof cb === 'function') cb(null, '', '');
      } else {
        if (typeof cb === 'function') cb(null, 'sha\n', '');
      }
      return undefined as unknown as ReturnType<typeof import('child_process').execFile>;
    });

    await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    const callOpts = mockExecFile.mock.calls[0]?.[2];
    expect(callOpts).toBeDefined();
    expect((callOpts as Record<string, unknown>)?.maxBuffer).toBe(HILO_MAX_OUTPUT_BYTES);
  });

  // ── Non-Error exception ────────────────────────────────────────────

  it('sanitizes non-Error error values (e.g. string thrown synchronously)', async () => {
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir });
    const hydration = await createPendingHydration();

    // Simulate a synchronous throw in the mock (should never happen but we guard).
    mockExecFile.mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'something broke';
    });

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_SPAWN_FAILED');
      expect(result.error.message).toContain('something broke');
    }
  });

  // ── Output dir creation failure ─────────────────────────────────────

  it('fails when the output directory cannot be created', async () => {
    const badOutputDir = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\subdir\\hilo-out'
      : '/dev/null/hilo-out';
    const config = makeEnabledConfig({ checkoutPath: checkoutDir, outputDir: badOutputDir });
    const hydration = await createPendingHydration();

    const result = await runHiloHydration({ hydration, config, binaryPathOverride: '/usr/bin/hilo' });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error.code).toBe('HILO_SPAWN_FAILED');
    }

    const updated = await getHydrationById(hydration.id);
    expect(updated?.status).toBe('failed');
  });

  // ── Graph-only constraint ──────────────────────────────────────────

  it('introduces no FUSE / xattr / inotify dependency', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'hilo-hydration-runner.ts'), 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [/\bfuse\b/i, /xattr/i, /inotify/i, /chokidar/i, /fs\.watch\b/i, /\.watch\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
