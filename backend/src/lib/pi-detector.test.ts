/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execSync } from 'child_process';

jest.mock('child_process');

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

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
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const { detectPi } = require('./pi-detector') as typeof import('./pi-detector');

    expect(detectPi()).toEqual({
      piInstalled: false,
      piVersion: null,
      piBinPath: null,
    });
  });
});
