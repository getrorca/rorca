/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  concatChunkBytes,
  decodeBase64Chunk,
  formatStreamJsonForDisplay,
} from '../../../../src/lib/run-terminal-parity';

const fixturePath = path.join(__dirname, 'fixtures', 'claude-code-parity.jsonl');

function readFixtureLines(): string[] {
  return fs.readFileSync(fixturePath, 'utf8').trimEnd().split('\n');
}

describe('Claude Code parity fixture', () => {
  test('pins the capture command, prompt, workspace, width, and Claude Code version', () => {
    const [metaLine] = readFixtureLines();
    const meta = JSON.parse(metaLine);

    expect(meta.type).toBe('fixture_meta');
    expect(meta.fixture).toBe('claude-code-parity');
    expect(meta.claudeVersion).toBe('claude-code 1.0.27');
    expect(meta.captureCommand).toContain('--dangerously-skip-permissions');
    expect(meta.captureCommand).toContain('--output-format stream-json');
    expect(meta.captureCommand).toContain('--terminal-width 80');
    expect(meta.terminalWidth).toBe(80);
    expect(meta.workspace).toBe('fixtures/claude-code-parity-workspace');
    expect(meta.prompt).toBe('Explain the replay semantics of this fixed terminal parity fixture.');
  });

  test('transcript formatting preserves control sequences without stripping or double-encoding them', () => {
    const lines = readFixtureLines().slice(1);
    const formatted = lines
      .map((line) => formatStreamJsonForDisplay(line))
      .filter((line): line is string => line !== null)
      .join('\n');

    expect(formatted).toContain('📖 Read README.md');
    expect(formatted).toContain('\r');
    expect(formatted).toContain('\x1b[2K');
    expect(formatted).toContain('\x1b[A');
    expect(formatted).toContain('\x1b[32mPASS\x1b[0m');
    expect(formatted).toContain('\x1b[?1049hALT SCREEN\x1b[?1049l');
    expect(formatted).not.toContain('\\u001b');
    expect(formatted).not.toContain('\\\\u001b');
  });

  test('SSE base64 round-trip keeps transcript bytes byte-for-byte identical', () => {
    const raw = fs.readFileSync(fixturePath);
    const chunkSize = Math.ceil(raw.length / 3);
    const chunks = [
      raw.subarray(0, chunkSize),
      raw.subarray(chunkSize, chunkSize * 2),
      raw.subarray(chunkSize * 2),
    ];

    const replayed = concatChunkBytes(chunks.map((chunk) => decodeBase64Chunk(chunk.toString('base64'))));

    expect(Buffer.from(replayed)).toEqual(raw);
  });
});
