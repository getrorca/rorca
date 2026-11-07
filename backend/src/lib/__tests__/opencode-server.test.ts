/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockDetectOpenCode = jest.fn();
jest.mock('../opencode-detector', () => ({
  detectOpenCode: (...args: unknown[]) => mockDetectOpenCode(...args),
}));

import { OpenCodeServer } from '../opencode-server';

beforeEach(() => {
  jest.clearAllMocks();
  mockDetectOpenCode.mockReturnValue({
    opencodeInstalled: true,
    opencodeVersion: '0.2.0',
    opencodeBinPath: '/usr/local/bin/opencode',
  });
});

test('constructor retains truthful stopped state and binary discovery', () => {
  const server = new OpenCodeServer();
  expect(mockDetectOpenCode).toHaveBeenCalled();
  expect(server.getState()).toBe('stopped');
  expect(server.getPid()).toBeNull();
  expect(server.getSocketPath()).toBeNull();
});

test('missing binary still fails closed', () => {
  mockDetectOpenCode.mockReturnValue({ opencodeInstalled: false, opencodeVersion: null, opencodeBinPath: null });
  expect(() => new OpenCodeServer()).toThrow('OpenCode binary not found');
});

test('warm cross-namespace server mode is retired without spawning or fallback', async () => {
  const server = new OpenCodeServer({ binPath: '/usr/local/bin/opencode' });
  await expect(server.start()).rejects.toThrow(/retired.*cannot share a control socket across isolated namespaces/i);
  expect(server.getState()).toBe('error');
  expect(server.getPid()).toBeNull();
  expect(() => server.attach()).toThrow('not running');
  expect(await server.restart()).toBe(false);
  await expect(server.stop()).resolves.toBeUndefined();
});
