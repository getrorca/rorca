/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { detectPi } from '../pi-detector';

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
    expect(meta.piVersion).toBe('pi 0.67.0');
    expect(meta.provider).toBe('openai-codex');
    expect(meta.model).toBe('gpt-5.4');
    expect(meta.providerState).toBe('pinned openai-codex/gpt-5.4');
    expect(String(meta.captureCommand)).toContain('pi run --jsonl');
    expect(String(meta.captureCommand)).toContain('--provider openai-codex');
    expect(String(meta.captureCommand)).toContain('--model gpt-5.4');
    expect(String(meta.captureCommand)).toContain('COLUMNS=80');
    expect(meta.terminalWidth).toBe(80);
    expect(meta.workspace).toBe('fixtures/pi-parity-workspace');
    expect(meta.prompt).toBe('Explain the replay semantics of this fixed Pi terminal parity fixture.');
  });

  test('replays the captured JSONL fixture through a PI_BIN override script without touching a real Pi install', () => {
    process.env.PI_BIN = replayScriptPath;

    const status = detectPi();
    expect(status).toEqual({
      piInstalled: true,
      piVersion: '0.67.0',
      piBinPath: replayScriptPath,
    });

    const result = spawnSync(process.env.PI_BIN!, ['run', '--jsonl', '--skill', 'fixtures/pi-parity-skill.md'], {
      encoding: 'buffer',
      cwd: path.dirname(replayScriptPath),
    });

    expect(result.status).toBe(0);
    expect(Buffer.from(result.stdout)).toEqual(fs.readFileSync(fixturePath));
  });
});
