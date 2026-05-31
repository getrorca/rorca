/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  concatChunkBytes,
  decodeBase64Chunk,
  formatStreamJsonForDisplay,
  parseVerboseLine,
} from './run-terminal-parity';

interface CodexFixtureChunk {
  sequence: number;
  stream: 'stdout' | 'stderr';
  base64: string;
}

interface CodexFixture {
  fixture: string;
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

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/lib/__tests__/fixtures/codex-parity.json');

function readFixture(): CodexFixture {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as CodexFixture;
}

function decodeFixtureChunks(chunks: CodexFixtureChunk[]): Buffer[] {
  return chunks.map((chunk) => Buffer.from(chunk.base64, 'base64'));
}

describe('Codex run terminal parity helpers', () => {
  it('pins the Codex capture metadata without cost or model-tier assumptions', () => {
    const fixture = readFixture();

    expect(fixture.fixture).toBe('codex-parity');
    expect(fixture.codexVersion).toBe('codex 0.25.0');
    expect(fixture.captureCommand).toContain('codex exec');
    expect(fixture.captureCommand).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(fixture.captureCommand).toContain('--model gpt-5.4');
    expect(fixture.terminalWidth).toBe(80);
    expect(fixture.workspace).toBe('fixtures/codex-parity-workspace');
    expect(fixture.prompt).toBe('Explain the replay semantics of this fixed Codex terminal parity fixture.');
    expect(fixture.tokenUsage.costUsd).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(fixture.tokenUsage, 'modelTier')).toBe(false);
  });

  it('parses Codex bracketed transcript prefixes while ignoring plain fallback lines', () => {
    const fixture = readFixture();
    const lines = Buffer.concat(decodeFixtureChunks(fixture.chunks)).toString('utf8').trimEnd().split('\n');
    const steps = lines
      .map((line) => parseVerboseLine(line))
      .filter((step): step is NonNullable<ReturnType<typeof parseVerboseLine>> => step !== null);

    expect(steps.map((step) => step.type)).toEqual(['plan', 'read', 'write']);
    expect(steps[0]?.label).toBe('Task: Evaluate replay fidelity (step 1/2)');
    expect(steps[1]?.label).toBe('Read README.md');
    expect(steps[2]?.label).toBe('Write notes.txt');
    expect(parseVerboseLine('Plain output with no semantic prefix still renders.')).toBeNull();
  });

  it('keeps raw Codex redraw and ANSI bytes intact for the xterm replay path', () => {
    const fixture = readFixture();
    const replayed = concatChunkBytes(fixture.chunks.map((chunk) => decodeBase64Chunk(chunk.base64)));
    const text = Buffer.from(replayed).toString('utf8');

    expect(Buffer.from(replayed)).toEqual(Buffer.concat(decodeFixtureChunks(fixture.chunks)));
    expect(text).toContain('\r\x1b[2K');
    expect(text).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(text).toContain('\x1b[32mPASS\x1b[0m byte ordering preserved');
    expect(text).toContain('\x1b[?1049hALT SCREEN\x1b[?1049l');
  });

  it('leaves raw Codex lines unformatted so transcript replay does not normalize ANSI content', () => {
    const fixture = readFixture();
    const lines = Buffer.concat(decodeFixtureChunks(fixture.chunks)).toString('utf8').trimEnd().split('\n');
    const rendered = lines
      .map((line) => formatStreamJsonForDisplay(line))
      .filter((line): line is string => line !== null)
      .join('\n');

    expect(rendered).toContain('[Planning] Evaluate replay fidelity\r\x1b[2K[Planning] Evaluate replay fidelity (step 1/2)');
    expect(rendered).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(rendered).toContain('Plain output with no semantic prefix still renders.');
    expect(rendered).not.toContain('\\u001b');
  });
});
