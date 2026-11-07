/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseCodexLine, parseLine } from '../semantic-log-parser';

interface CodexFixtureChunk {
  sequence: number;
  stream: 'stdout' | 'stderr';
  base64: string;
}

interface CodexFixture {
  fixture: string;
  storyId: string;
  agentType: string;
  codexVersion: string;
  captureCommand: string;
  terminalWidth: number;
  workspace: string;
  prompt: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  };
  chunks: CodexFixtureChunk[];
}

const fixturePath = path.join(__dirname, 'fixtures', 'codex-parity.json');

function readFixture(): CodexFixture {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as CodexFixture;
}

function decodeFixtureBytes(fixture: CodexFixture): Buffer {
  return Buffer.concat(fixture.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
}

describe('Codex parity fixture', () => {
  test('pins the capture command, prompt, workspace, width, and Codex version', () => {
    const fixture = readFixture();

    expect(fixture.fixture).toBe('codex-parity');
    expect(fixture.storyId).toBe('TP-006');
    expect(fixture.agentType).toBe('codex');
    expect(fixture.codexVersion).toBe('codex 0.25.0');
    expect(fixture.captureCommand).toContain('codex exec');
    expect(fixture.captureCommand).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(fixture.captureCommand).toContain('--model gpt-5.4');
    expect(fixture.captureCommand).toContain('COLUMNS=80');
    expect(fixture.terminalWidth).toBe(80);
    expect(fixture.workspace).toBe('fixtures/codex-parity-workspace');
    expect(fixture.prompt).toBe('Explain the replay semantics of this fixed Codex terminal parity fixture.');
    expect(fixture.tokenUsage.costUsd).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(fixture.tokenUsage, 'modelTier')).toBe(false);
  });

  test('heuristic Codex semantic parsing extracts prefixed transcript steps and ignores plain output', () => {
    const lines = decodeFixtureBytes(readFixture()).toString('utf8').trimEnd().split('\n');
    const steps = lines.flatMap((line) => parseLine(line, 'codex'));

    expect(steps.map((step) => step.type)).toEqual(['plan', 'read', 'write']);
    expect(steps.map((step) => step.label)).toEqual([
      'Task: Evaluate replay fidelity (step 1/2)',
      'Read README.md',
      'Write notes.txt',
    ]);
    expect(parseCodexLine('Plain output with no semantic prefix still renders.')).toEqual([]);
  });

  test('base64 fixture chunks replay to the original byte stream without normalization', () => {
    const fixture = readFixture();
    const replayed = Buffer.concat(fixture.chunks.map((chunk) => Buffer.from(chunk.base64, 'base64')));
    const text = replayed.toString('utf8');

    expect(replayed).toEqual(decodeFixtureBytes(fixture));
    expect(text).toContain('\r\x1b[2K');
    expect(text).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(text).toContain('\x1b[32mPASS\x1b[0m byte ordering preserved');
    expect(text).toContain('\x1b[?1049hALT SCREEN\x1b[?1049l');
  });
});
