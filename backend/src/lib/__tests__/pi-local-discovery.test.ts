/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

const probeAutonomousCliSync = jest.fn();

jest.mock('../autonomous-cli-probe', () => ({
  probeAutonomousCliSync: (...args: unknown[]) => probeAutonomousCliSync(...args),
  probeAutonomousCli: jest.fn(),
}));

import { detectPiForLocalDiscovery, listPiModelsForLocalDiscovery } from '../pi-detector';

const originalPiBin = process.env.PI_BIN;

afterEach(() => {
  if (originalPiBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = originalPiBin;
  jest.clearAllMocks();
});

describe('Pi local dashboard discovery', () => {
  it('uses the restricted Darwin no-network probe for version and model discovery', () => {
    process.env.PI_BIN = process.execPath;
    probeAutonomousCliSync
      .mockReturnValueOnce({ status: 0, signal: null, stdout: '0.80.6\n', stderr: '' })
      .mockReturnValueOnce({
        status: 0,
        signal: null,
        stdout: '│ openai  gpt-5  400000  128000  true  false │',
        stderr: '',
      });

    expect(detectPiForLocalDiscovery('darwin')).toEqual({
      piInstalled: true,
      piVersion: '0.80.6',
      piBinPath: process.execPath,
    });
    expect(listPiModelsForLocalDiscovery(process.execPath, 'darwin')).toEqual([{
      provider: 'openai',
      model: 'gpt-5',
      contextTokens: 400000,
      maxOutTokens: 128000,
      thinking: true,
      images: false,
    }]);
    expect(probeAutonomousCliSync).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      ['--no-extensions', '--offline', '--version'],
      expect.objectContaining({ timeoutMs: 5_000, sandboxMode: 'darwin-local-pi', env: expect.objectContaining({ PI_BIN: process.execPath }) }),
    );
    expect(probeAutonomousCliSync).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      ['--list-models'],
      expect.objectContaining({ timeoutMs: 10_000, sandboxMode: 'darwin-local-pi', env: expect.objectContaining({ PI_BIN: process.execPath }) }),
    );
  });
});
