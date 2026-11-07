/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { detectPi } from '../pi-detector';

jest.mock('../autonomous-cli-probe', () => {
  const childProcess = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  const probe = (command: string, args: readonly string[], options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) => {
    const result = childProcess.spawnSync(command, [...args], {
      encoding: 'utf8', timeout: options.timeoutMs, env: options.env ?? process.env,
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      ...(result.error ? { error: result.error } : {}),
    };
  };
  return {
    probeAutonomousCliSync: probe,
    probeAutonomousCli: async (...args: Parameters<typeof probe>) => probe(...args),
  };
});

const fixturePath = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'pi', 'pi-parity.jsonl');
const replayScriptPath = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'pi', 'mock-pi-replay.sh');

const originalPiBin = process.env.PI_BIN;

afterAll(() => {
  if (originalPiBin === undefined) {
    delete process.env.PI_BIN;
  } else {
    process.env.PI_BIN = originalPiBin;
  }
});

describe('Pi parity fixture', () => {
  test('pins the capture command, prompt, workspace, terminal width, and provider state', () => {
    const [metaLine] = fs.readFileSync(fixturePath, 'utf8').trimEnd().split('\n');
    const meta = JSON.parse(metaLine) as Record<string, unknown>;

    expect(meta.type).toBe('fixture_meta');
    expect(meta.fixture).toBe('pi-parity');
    expect(meta.agentType).toBe('pi');
    expect(meta.piVersion).toBe('pi 0.80.7');
    expect(meta.evidenceClass).toBe('non-release-fixture-replay');
    expect(meta.actualProviderCapture).toBe(false);
    expect(meta.provider).toBe('openai-codex');
    expect(meta.model).toBe('gpt-5.4');
    expect(meta.providerState).toBe('fixture metadata only; no provider authority');
    expect(String(meta.captureCommand)).toContain('mock-pi-replay.sh --mode json');
    expect(String(meta.captureCommand)).toContain('--provider openai-codex');
    expect(String(meta.captureCommand)).toContain('--model gpt-5.4');
    expect(String(meta.captureCommand)).toContain('COLUMNS=80');
    expect(meta.terminalWidth).toBe(80);
    expect(meta.workspace).toBe('fixtures/pi-parity-workspace');
    expect(meta.prompt).toBe('Explain the replay semantics of this fixed Pi terminal parity fixture.');
  });

  test('replays the JSONL fixture through the shipped Pi CLI shape without touching a real provider', () => {
    process.env.PI_BIN = replayScriptPath;

    const status = detectPi();
    expect(status).toEqual({
      piInstalled: true,
      piVersion: '0.80.7',
      piBinPath: replayScriptPath,
    });

    const result = spawnSync(process.env.PI_BIN!, [
      '--mode', 'json', '--no-session',
      '--provider', 'openai-codex', '--model', 'gpt-5.4',
      'Explain the replay semantics of this fixed Pi terminal parity fixture.',
    ], {
      encoding: 'buffer',
      cwd: path.dirname(replayScriptPath),
    });

    expect(result.status).toBe(0);
    expect(Buffer.from(result.stdout)).toEqual(fs.readFileSync(fixturePath));
  });
});
