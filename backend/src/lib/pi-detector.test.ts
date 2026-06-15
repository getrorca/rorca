/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execSync, spawnSync } from 'child_process';

jest.mock('child_process');

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockedSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

describe('pi-detector', () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PI_BIN;
    process.env.SHELL = originalShell;
  });

  afterAll(() => {
    process.env.SHELL = originalShell;
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

  it('detectPi falls back to the login shell when the current PATH cannot resolve pi', () => {
    process.env.SHELL = '/bin/zsh';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockedSpawnSync.mockImplementation((command, args) => {
      if (command === '/bin/zsh' && Array.isArray(args) && args[0] === '-ilc') {
        if (args[1] === 'command -v pi') {
          return {
            status: 0,
            stdout: '/opt/homebrew/bin/pi\n',
            stderr: '',
          } as ReturnType<typeof spawnSync>;
        }

        return {
          status: 0,
          stdout: 'pi 0.67.0\n',
          stderr: '',
        } as ReturnType<typeof spawnSync>;
      }

      if (command === '/opt/homebrew/bin/pi' && Array.isArray(args) && args[0] === '--version') {
        return {
          status: 127,
          stdout: '',
          stderr: 'env: node: No such file or directory\n',
        } as ReturnType<typeof spawnSync>;
      }

      throw new Error(`Unexpected spawnSync call: ${command} ${String(args)}`);
    });

    const { detectPi } = require('./pi-detector') as typeof import('./pi-detector');

    expect(detectPi()).toEqual({
      piInstalled: true,
      piVersion: '0.67.0',
      piBinPath: '/opt/homebrew/bin/pi',
    });
  });
});
