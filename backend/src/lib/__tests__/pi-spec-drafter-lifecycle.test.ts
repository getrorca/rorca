/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSpawn = jest.fn();
const mockPrepareModelLaunch = jest.fn();

jest.mock('child_process', () => {
  const actual = jest.requireActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (command: unknown, args: unknown, options: unknown) => mockSpawn(command, args, options),
  };
});
jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousModelSandboxLaunch: (options: unknown) => mockPrepareModelLaunch(options),
}));
jest.mock('../pi-detector', () => ({
  detectPi: () => ({ piInstalled: true, piVersion: '1.0.0', piBinPath: '/usr/bin/pi' }),
}));

import { draftSpecWithPi } from '../pi-spec-drafter';

type Scenario = 'timeout' | 'error' | 'close';

interface FakePiChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write(value: string): boolean };
  kill: jest.Mock<boolean, [NodeJS.Signals]>;
}

function fakePiChild(scenario: Scenario, commands: string[]): FakePiChild {
  const child = new EventEmitter() as FakePiChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn((_signal: NodeJS.Signals) => true);
  child.stdin = {
    write(value: string): boolean {
      const command = JSON.parse(value.trim()) as { id: string; type: string };
      commands.push(command.type);
      if (command.type === 'new_session' || command.type === 'get_state') {
        queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({
          type: 'response',
          id: command.id,
          success: true,
          data: command.type === 'get_state' ? { sessionId: 'fixture-session' } : {},
        })}\n`));
      } else if (command.type === 'prompt' && scenario === 'error') {
        queueMicrotask(() => child.emit('error', new Error('fixture pre-prompt error')));
      } else if (command.type === 'prompt' && scenario === 'close') {
        queueMicrotask(() => child.emit('close', 23));
      }
      return true;
    },
  };
  return child;
}

const lifecycleTestName = 'Pi terminal flow observes timeout and pre-prompt failures and closes exactly once';

test(lifecycleTestName, async () => {
  const cases: Array<{ scenario: Scenario; expected: RegExp; expectedCommands: string[] }> = [
    {
      scenario: 'timeout',
      expected: /Pi forge draft timed out after 25ms/,
      expectedCommands: ['new_session', 'get_state', 'prompt', 'abort'],
    },
    {
      scenario: 'error',
      expected: /Pi forge process failed: fixture pre-prompt error/,
      expectedCommands: ['new_session', 'get_state', 'prompt'],
    },
    {
      scenario: 'close',
      expected: /Pi forge process closed before RPC completion \(23\)/,
      expectedCommands: ['new_session', 'get_state', 'prompt'],
    },
  ];

  for (const { scenario, expected, expectedCommands } of cases) {
    jest.clearAllMocks();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-pi-terminal-${scenario}-`));
    const commands: string[] = [];
    const child = fakePiChild(scenario, commands);
    const closeModelEgress = jest.fn(async () => undefined);
    mockSpawn.mockReturnValue(child);
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
      closeModelEgress,
    }));

    try {
      await expect(draftSpecWithPi({ cwd, prompt: 'draft', timeoutMs: 25 })).rejects.toThrow(expected);
      // Let Node perform its unhandled-rejection checkpoint before assertions.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(commands).toEqual(expectedCommands);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      if (scenario === 'timeout') {
        await new Promise(resolve => setTimeout(resolve, 2_050));
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      }
      expect(closeModelEgress).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(cwd).filter(name => name.startsWith('.rorca-pi-draft-'))).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('Pi terminal regressions exit cleanly under Node strict unhandled-rejection behavior', () => {
  const backendRoot = path.resolve(__dirname, '..', '..', '..');
  const jestCli = path.join(backendRoot, 'node_modules', 'jest', 'bin', 'jest.js');
  const config = JSON.stringify({
    rootDir: backendRoot,
    preset: 'ts-jest',
    testEnvironment: 'node',
    transform: { '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }] },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    maxWorkers: 1,
  });
  const result = spawnSync(process.execPath, [
    '--unhandled-rejections=strict',
    jestCli,
    '--config', config,
    '--runInBand',
    '--runTestsByPath', __filename,
    '--testNamePattern', `^${lifecycleTestName}$`,
  ], {
    cwd: backendRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
  });

  expect({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
  }).toEqual(expect.objectContaining({ status: 0, signal: null, error: undefined }));
  expect(`${result.stdout}\n${result.stderr}`).toContain('1 passed');
});
