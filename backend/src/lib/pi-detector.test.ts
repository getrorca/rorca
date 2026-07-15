/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawnSync } from 'child_process';

jest.mock('child_process');

const mockedSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe('pi-detector', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PI_BIN;
  });

  it("parsePiModelTable('') returns []", () => {
    const { parsePiModelTable } = require('./pi-detector') as typeof import('./pi-detector');
    expect(parsePiModelTable('')).toEqual([]);
  });

  it('parsePiModelTable parses a valid ASCII table row', () => {
    const { parsePiModelTable } = require('./pi-detector') as typeof import('./pi-detector');
    const table = [
      '│ Provider  Model              Context Tokens  Max Out Tokens  Thinking  Images │',
      '│ openai    gpt-5              400000          128000          true      false  │',
    ].join('\n');

    expect(parsePiModelTable(table)).toEqual([
      {
        provider: 'openai',
        model: 'gpt-5',
        contextTokens: 400000,
        maxOutTokens: 128000,
        thinking: true,
        images: false,
      },
    ]);
  });

  it('detectPi returns the missing-binary shape for a bad PI_BIN path', () => {
    process.env.PI_BIN = '/definitely/missing/pi';
    mockedSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>);

    const { detectPi } = require('./pi-detector') as typeof import('./pi-detector');

    expect(detectPi()).toEqual({
      piInstalled: false,
      piVersion: null,
      piBinPath: null,
    });
  });

  it('detectPiAvailability checks the configured executable without spawning Pi', () => {
    process.env.PI_BIN = process.execPath;

    const { detectPiAvailability } = require('./pi-detector') as typeof import('./pi-detector');

    expect(detectPiAvailability()).toEqual({
      piInstalled: true,
      piVersion: null,
      piBinPath: process.execPath,
    });
    expect(mockedSpawnSync).not.toHaveBeenCalled();
  });

  it('detectPi disables extensions and network startup during its version probe', () => {
    process.env.PI_BIN = '/usr/local/bin/pi';
    mockedSpawnSync.mockReturnValue({ status: 0, stdout: '0.80.6\n', stderr: '' } as ReturnType<typeof spawnSync>);

    const { detectPi } = require('./pi-detector') as typeof import('./pi-detector');

    expect(detectPi()).toEqual({
      piInstalled: true,
      piVersion: '0.80.6',
      piBinPath: '/usr/local/bin/pi',
    });
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      '/usr/local/bin/pi',
      ['--no-extensions', '--offline', '--version'],
      expect.objectContaining({ timeout: 2_000, killSignal: 'SIGKILL' }),
    );
  });
});
