/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

jest.mock('../autonomous-cli-probe', () => ({
  probeAutonomousCliSync: jest.fn(),
  probeAutonomousCli: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeAutonomousCliSync } from '../autonomous-cli-probe';
import { inspectPi } from '../pi-detector';
import {
  ORDINARY_LOCAL_PI_PROFILE_VERSION,
  serializeOrdinaryLocalPiRuntimeProfile,
} from '../ordinary-local-pi-profile';

const mockProbeSync = probeAutonomousCliSync as jest.MockedFunction<typeof probeAutonomousCliSync>;

beforeEach(() => {
  delete process.env.RORCA_ORDINARY_LOCAL_PI_PROFILE;
  process.env.PI_BIN = process.execPath;
  mockProbeSync.mockReset();
  mockProbeSync.mockReturnValue({ status: 0, signal: null, stdout: '0.80.6\n', stderr: '' });
});

afterEach(() => {
  delete process.env.PI_BIN;
  delete process.env.RORCA_ORDINARY_LOCAL_PI_PROFILE;
});

test('ordinary local Pi inspection selects the explicit Darwin no-network probe profile', () => {
  expect(inspectPi({ sandboxMode: 'darwin-local-pi' })).toEqual({
    status: { piInstalled: true, piVersion: '0.80.6', piBinPath: process.execPath },
  });
  expect(mockProbeSync).toHaveBeenCalledWith(
    process.execPath,
    ['--no-extensions', '--offline', '--version'],
    {
      timeoutMs: 5_000,
      sandboxMode: 'darwin-local-pi',
      env: expect.objectContaining({ PI_BIN: process.execPath }),
    },
  );
});

test('ordinary local Pi inspection preserves the frozen launcher symlink identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-detector-launcher-'));
  const launcher = path.join(root, 'pi');
  fs.symlinkSync(process.execPath, launcher);
  process.env.PI_BIN = launcher;
  process.env.RORCA_ORDINARY_LOCAL_PI_PROFILE = serializeOrdinaryLocalPiRuntimeProfile({
    schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
    runId: 20260316000288,
    workspacePath: path.join(root, 'workspace'),
    worktreePath: path.join(root, 'worktree'),
    branchName: 'feat/frozen-pi-launcher',
    piBinPath: launcher,
    piRealPath: fs.realpathSync(launcher),
    runtimeRoot: path.join(root, 'runtime'),
    posture: 'task-manifest-pr',
  });

  try {
    expect(inspectPi()).toEqual({
      status: { piInstalled: true, piVersion: '0.80.6', piBinPath: launcher },
    });
    expect(mockProbeSync).toHaveBeenCalledWith(
      launcher,
      ['--no-extensions', '--offline', '--version'],
      expect.objectContaining({
        sandboxMode: 'darwin-local-pi',
        env: expect.objectContaining({ PI_BIN: launcher }),
      }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Linux bwrap preflight failure is not misreported as a missing Pi installation', () => {
  mockProbeSync.mockReturnValue({
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    error: new Error('linux-bwrap autonomous isolation requires Linux'),
  });

  expect(inspectPi()).toEqual({
    status: { piInstalled: false, piVersion: null, piBinPath: null },
    failureCode: 'linux_bwrap_required_for_requested_mode',
  });
});
