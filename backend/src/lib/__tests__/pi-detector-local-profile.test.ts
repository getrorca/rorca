/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

jest.mock('../autonomous-cli-probe', () => ({
  probeAutonomousCliSync: jest.fn(),
  probeAutonomousCli: jest.fn(),
}));

import { probeAutonomousCliSync } from '../autonomous-cli-probe';
import { inspectPi } from '../pi-detector';

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
    { timeoutMs: 2_000, sandboxMode: 'darwin-local-pi' },
  );
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
