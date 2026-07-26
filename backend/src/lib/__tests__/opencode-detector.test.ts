/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockProbeSync = jest.fn();
const mockProbe = jest.fn();
jest.mock('../autonomous-cli-probe', () => ({
  probeAutonomousCliSync: (...args: unknown[]) => mockProbeSync(...args),
  probeAutonomousCli: (...args: unknown[]) => mockProbe(...args),
}));

const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock('../logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args), info: (...args: unknown[]) => mockLoggerInfo(...args), warn: jest.fn(), debug: jest.fn() },
}));

import { detectOpenCode, detectOpenCodeAsync, MIN_OPENCODE_VERSION, requireOpenCode, semverGte } from '../opencode-detector';

let temp: string;
let binary: string;
let originalPath: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.OPENCODE_BIN;
  originalPath = process.env.PATH;
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-opencode-detector-'));
  binary = path.join(temp, 'opencode');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  process.env.PATH = `${temp}${path.delimiter}${originalPath ?? ''}`;
  mockProbeSync.mockReturnValue({ status: 0, signal: null, stdout: 'opencode v0.2.0\n', stderr: '' });
  mockProbe.mockResolvedValue({ status: 0, signal: null, stdout: 'opencode v0.2.0\n', stderr: '' });
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.OPENCODE_BIN;
  fs.rmSync(temp, { recursive: true, force: true });
  jest.restoreAllMocks();
});

test('semver comparison remains stable', () => {
  expect(semverGte('0.1.0', '0.1.0')).toBe(true);
  expect(semverGte('1.0.0', '0.9.9')).toBe(true);
  expect(semverGte('0.0.9', '0.1.0')).toBe(false);
  expect(semverGte('0.1.0-beta.1', '0.1.0')).toBe(true);
});

test('sync and async detection execute version only through sandboxed probe helper', async () => {
  expect(detectOpenCode()).toMatchObject({ opencodeInstalled: true, opencodeVersion: '0.2.0', opencodeBinPath: fs.realpathSync(binary) });
  expect(await detectOpenCodeAsync()).toMatchObject({ opencodeInstalled: true, opencodeVersion: '0.2.0', opencodeBinPath: fs.realpathSync(binary) });
  expect(mockProbeSync).toHaveBeenCalledWith(fs.realpathSync(binary), ['--version'], { timeoutMs: 5_000 });
  expect(mockProbe).toHaveBeenCalledWith(fs.realpathSync(binary), ['--version'], { timeoutMs: 1_000 });
});

test('configured binary is probed without PATH execution and failed probe remains installed/unknown', () => {
  process.env.OPENCODE_BIN = binary;
  mockProbeSync.mockReturnValue({ status: 1, signal: null, stdout: '', stderr: 'failed' });
  expect(detectOpenCode()).toEqual({ opencodeInstalled: true, opencodeVersion: null, opencodeBinPath: fs.realpathSync(binary) });
});

test('missing binary is unavailable without executing a finder subprocess', () => {
  process.env.PATH = temp;
  fs.unlinkSync(binary);
  expect(detectOpenCode()).toEqual({ opencodeInstalled: false, opencodeVersion: null, opencodeBinPath: null });
  expect(mockProbeSync).not.toHaveBeenCalled();
});

test('requireOpenCode enforces minimum and logs accepted versions', () => {
  const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  mockProbeSync.mockReturnValueOnce({ status: 0, signal: null, stdout: '0.0.1', stderr: '' });
  requireOpenCode();
  expect(mockExit).toHaveBeenCalledWith(1);
  expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining(`below minimum required ${MIN_OPENCODE_VERSION}`));

  mockExit.mockClear();
  mockProbeSync.mockReturnValueOnce({ status: 0, signal: null, stdout: '0.1.0', stderr: '' });
  expect(requireOpenCode().opencodeInstalled).toBe(true);
  expect(mockExit).not.toHaveBeenCalled();
  expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining('Detected opencode 0.1.0'));
});
