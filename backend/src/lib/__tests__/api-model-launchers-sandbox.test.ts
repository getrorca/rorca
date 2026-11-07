/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Behavioral reachability proof for every API-side tool-capable draft launcher. */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSpawn = jest.fn();
const mockCloseModelEgress = jest.fn(async () => undefined);
const mockPrepareModelLaunch = jest.fn().mockRejectedValue(new Error('sandbox-sentinel'));

jest.mock('child_process', () => ({
  spawn: (command: unknown, args: unknown, options: unknown) => mockSpawn(command, args, options),
}));
jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousModelSandboxLaunch: (options: unknown) => mockPrepareModelLaunch(options),
}));
jest.mock('../codex-detector', () => ({
  detectCodex: () => ({ codexInstalled: true, codexVersion: '1.0.0', codexBinPath: '/usr/bin/codex' }),
}));
jest.mock('../pi-detector', () => ({
  detectPi: () => ({ piInstalled: true, piVersion: '1.0.0', piBinPath: '/usr/bin/pi' }),
}));
jest.mock('../opencode-detector', () => ({
  detectOpenCode: () => ({ opencodeInstalled: true, opencodeVersion: '1.0.0', opencodeBinPath: '/usr/bin/opencode' }),
}));

import { draftSpecWithCodex } from '../codex-spec-drafter';
import { draftSpecWithPi } from '../pi-spec-drafter';
import { generateSpecViaOpenCode } from '../opencode-spec-gen';

let cwd: string;
beforeEach(() => {
  jest.clearAllMocks();
  mockPrepareModelLaunch.mockRejectedValue(new Error('sandbox-sentinel'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-api-model-launcher-'));
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

test('Codex, Pi, and OpenCode all fail at the sandbox seam before direct spawn', async () => {
  await expect(draftSpecWithCodex({ cwd, prompt: 'draft' })).rejects.toThrow('sandbox-sentinel');
  await expect(draftSpecWithPi({ cwd, prompt: 'draft' })).rejects.toThrow('sandbox-sentinel');
  await expect(generateSpecViaOpenCode({
    workspacePath: cwd,
    title: 'Test',
    brief: 'Test',
    storyCount: 1,
    storyPrefix: 'US',
    directionContext: '',
  })).rejects.toThrow('sandbox-sentinel');

  expect(mockPrepareModelLaunch).toHaveBeenCalledTimes(3);
  expect(mockPrepareModelLaunch.mock.calls.map(call => call[0].command)).toEqual([
    '/usr/bin/codex', '/usr/bin/pi', '/usr/bin/opencode',
  ]);
  expect(mockSpawn).not.toHaveBeenCalled();
});

test('Codex, Pi, and OpenCode close only their acquired operation lease when spawn throws before a child exists', async () => {
  mockPrepareModelLaunch.mockImplementation(async (options: any) => ({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: options.env,
    isolated: true,
    modelEgressIdentity: Object.freeze({
      operationId: `operation:${'1'.repeat(64)}`,
      authorityHash: `sha256:${'2'.repeat(64)}`,
    }),
    modelEgressSocket: '/tmp/test-operation.sock',
    closeModelEgress: mockCloseModelEgress,
  }));
  mockSpawn.mockImplementation(() => { throw new Error('synchronous pre-spawn failure'); });

  await expect(draftSpecWithCodex({ cwd, prompt: 'draft' })).rejects.toThrow('synchronous pre-spawn failure');
  await expect(draftSpecWithPi({ cwd, prompt: 'draft' })).rejects.toThrow('synchronous pre-spawn failure');
  await expect(generateSpecViaOpenCode({
    workspacePath: cwd,
    title: 'Test',
    brief: 'Test',
    storyCount: 1,
    storyPrefix: 'US',
    directionContext: '',
  })).rejects.toThrow('synchronous pre-spawn failure');

  expect(mockPrepareModelLaunch).toHaveBeenCalledTimes(3);
  expect(mockSpawn).toHaveBeenCalledTimes(3);
  expect(mockCloseModelEgress).toHaveBeenCalledTimes(3);
});
