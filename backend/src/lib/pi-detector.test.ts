/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockProbeSync = jest.fn();
const mockProbe = jest.fn();
jest.mock('./autonomous-cli-probe', () => ({
  probeAutonomousCliSync: (...args: unknown[]) => mockProbeSync(...args),
  probeAutonomousCli: (...args: unknown[]) => mockProbe(...args),
}));

import { detectPi, detectPiAsync, detectPiAvailability, listPiModels, parsePiModelTable } from './pi-detector';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PI_BIN;
  mockProbeSync.mockReturnValue({ status: 0, signal: null, stdout: '0.80.6\n', stderr: '' });
  mockProbe.mockResolvedValue({ status: 0, signal: null, stdout: '0.80.6\n', stderr: '' });
});

test("parsePiModelTable('') returns [] and parses valid rows", () => {
  expect(parsePiModelTable('')).toEqual([]);
  const table = [
    '│ Provider  Model              Context Tokens  Max Out Tokens  Thinking  Images │',
    '│ openai    gpt-5              400000          128000          true      false  │',
  ].join('\n');
  expect(parsePiModelTable(table)).toEqual([{
    provider: 'openai', model: 'gpt-5', contextTokens: 400000,
    maxOutTokens: 128000, thinking: true, images: false,
  }]);
});

test('availability is process-free and bad configured paths are unavailable', () => {
  process.env.PI_BIN = process.execPath;
  expect(detectPiAvailability()).toEqual({ piInstalled: true, piVersion: null, piBinPath: process.execPath });
  expect(mockProbeSync).not.toHaveBeenCalled();
  process.env.PI_BIN = '/definitely/missing/pi';
  expect(detectPi()).toEqual({ piInstalled: false, piVersion: null, piBinPath: null });
});

test('sync and async version probes disable extensions/network and use the sandbox helper', async () => {
  process.env.PI_BIN = process.execPath;
  expect(detectPi()).toEqual({ piInstalled: true, piVersion: '0.80.6', piBinPath: process.execPath });
  expect(await detectPiAsync()).toEqual({ piInstalled: true, piVersion: '0.80.6', piBinPath: process.execPath });
  expect(mockProbeSync).toHaveBeenCalledWith(
    process.execPath,
    ['--no-extensions', '--offline', '--version'],
    process.platform === 'darwin'
      ? expect.objectContaining({
          timeoutMs: 5_000,
          sandboxMode: 'darwin-local-pi',
          env: expect.objectContaining({ PI_BIN: process.execPath }),
        })
      : { timeoutMs: 5_000, sandboxMode: 'linux-bwrap' },
  );
  expect(mockProbeSync).toHaveBeenCalledTimes(2);
  expect(mockProbe).not.toHaveBeenCalled();
});

test('model listing cannot bypass the sandboxed probe helper', () => {
  mockProbeSync.mockReturnValue({
    status: 0, signal: null,
    stdout: '│ openai  gpt-5  400000  128000  true  false │', stderr: '',
  });
  expect(listPiModels(process.execPath)).toHaveLength(1);
  expect(mockProbeSync).toHaveBeenCalledWith(
    process.execPath,
    ['--list-models'],
    process.platform === 'darwin'
      ? expect.objectContaining({
          timeoutMs: 10_000,
          sandboxMode: 'darwin-local-pi',
          env: expect.objectContaining({ PI_BIN: process.execPath }),
        })
      : { timeoutMs: 10_000 },
  );
});
