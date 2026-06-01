/// <reference types="node" />
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

interface FixtureChunk {
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
  chunks: FixtureChunk[];
}

interface OpenCodeFixture {
  fixture: string;
  opencodeVersion: string;
  captureCommand: string;
  terminalWidth: number;
  workspace: string;
  prompt: string;
  captureNotes: string[];
  chunks: FixtureChunk[];
}

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/lib/__tests__/fixtures');
const codexFixturePath = path.join(fixtureDir, 'codex-parity.json');
const openCodeFixturePath = path.join(fixtureDir, 'opencode-parity.json');
const piFixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend/src/__tests__/fixtures/pi/pi-parity.jsonl');

type ParsedStep = NonNullable<ReturnType<typeof parseVerboseLine>>;

function readJsonFixture<T>(fixturePath: string): T {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as T;
}

function decodeFixtureChunks(chunks: FixtureChunk[]): Buffer[] {
  return chunks.map((chunk) => Buffer.from(chunk.base64, 'base64'));
}

describe('Codex run terminal parity helpers', () => {
  it('pins the Codex capture metadata without cost or model-tier assumptions', () => {
    const fixture = readJsonFixture<CodexFixture>(codexFixturePath);

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
    const fixture = readJsonFixture<CodexFixture>(codexFixturePath);
    const lines = Buffer.concat(decodeFixtureChunks(fixture.chunks)).toString('utf8').trimEnd().split('\n');
    const steps = lines
      .map((line: string) => parseVerboseLine(line))
      .filter((step: ReturnType<typeof parseVerboseLine>): step is ParsedStep => step !== null);

    expect(steps.map((step) => step.type)).toEqual(['plan', 'read', 'write']);
    expect(steps[0]?.label).toBe('Task: Evaluate replay fidelity (step 1/2)');
    expect(steps[1]?.label).toBe('Read README.md');
    expect(steps[2]?.label).toBe('Write notes.txt');
    expect(parseVerboseLine('Plain output with no semantic prefix still renders.')).toBeNull();
  });

  it('keeps raw Codex redraw and ANSI bytes intact for the xterm replay path', () => {
    const fixture = readJsonFixture<CodexFixture>(codexFixturePath);
    const replayed = concatChunkBytes(fixture.chunks.map((chunk) => decodeBase64Chunk(chunk.base64)));
    const text = Buffer.from(replayed).toString('utf8');

    expect(Buffer.from(replayed)).toEqual(Buffer.concat(decodeFixtureChunks(fixture.chunks)));
    expect(text).toContain('\r\x1b[2K');
    expect(text).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(text).toContain('\x1b[32mPASS\x1b[0m byte ordering preserved');
    expect(text).toContain('\x1b[?1049hALT SCREEN\x1b[?1049l');
  });

  it('leaves raw Codex lines unformatted so transcript replay does not normalize ANSI content', () => {
    const fixture = readJsonFixture<CodexFixture>(codexFixturePath);
    const lines = Buffer.concat(decodeFixtureChunks(fixture.chunks)).toString('utf8').trimEnd().split('\n');
    const rendered = lines
      .map((line: string) => formatStreamJsonForDisplay(line))
      .filter((line: string | null): line is string => line !== null)
      .join('\n');

    expect(rendered).toContain('[Planning] Evaluate replay fidelity\r\x1b[2K[Planning] Evaluate replay fidelity (step 1/2)');
    expect(rendered).toContain('\x1b[33mwarning\x1b[0m: fixture stderr interleave');
    expect(rendered).toContain('Plain output with no semantic prefix still renders.');
    expect(rendered).not.toContain('\\u001b');
  });
});

describe('Pi run terminal parity helpers', () => {
  it('renders the captured Pi JSONL fixture as transcript output without leaking raw JSON lines', () => {
    const lines = fs.readFileSync(piFixturePath, 'utf8').trimEnd().split('\n');
    const rendered = lines
      .map((line: string) => formatStreamJsonForDisplay(line))
      .filter((line: string | null): line is string => line !== null)
      .join('\n');

    expect(rendered).toContain('[Planning] Inspecting the fixed Pi JSONL fixture before replaying terminal updates.');
    expect(rendered).toContain('[Read] README.md');
    expect(rendered).toContain('→ Loading 1/3\r\x1b[2KLoading 2/3\r\x1b[2KLoading 3/3\r\x1b[A\x1b[2K\x1b[32mPASS\x1b[0m byte ordering preserved \x1b[?1049hALT SCREEN\x1b[?1049l');
    expect(rendered).toContain('[Write] notes.txt');
    expect(rendered).toContain('[Completed] Pi fixture replay complete.');
    expect(rendered).not.toContain('"type":"tool_call"');
    expect(rendered).not.toContain('\\u001b');
  });

  it('derives semantic Pi steps from the same JSONL fixture in transcript order', () => {
    const lines = fs.readFileSync(piFixturePath, 'utf8').trimEnd().split('\n');
    const steps = lines
      .map((line: string) => parseVerboseLine(line))
      .filter((step: ReturnType<typeof parseVerboseLine>): step is ParsedStep => step !== null);

    expect(steps.map((step) => step.type)).toEqual(['plan', 'read', 'read', 'bash', 'bash', 'write', 'write', 'commit']);
    expect(steps[0]).toMatchObject({
      type: 'plan',
      label: 'Reasoning',
      detail: 'Inspecting the fixed Pi JSONL fixture before replaying terminal updates.',
    });
    expect(steps[3]).toMatchObject({ type: 'bash', label: 'Emit overwrite semantics', toolName: 'bash' });
    expect(steps[4]).toMatchObject({
      type: 'bash',
      label: 'bash result',
      durationMs: 18,
      toolName: 'bash',
    });
    expect(steps[7]).toMatchObject({ type: 'commit', label: 'Run completed' });
  });
});

describe('OpenCode run terminal parity helpers', () => {
  it('pins the OpenCode capture metadata to a fixed workspace, width, and attached version', () => {
    const fixture = readJsonFixture<OpenCodeFixture>(openCodeFixturePath);

    expect(fixture.fixture).toBe('opencode-parity');
    expect(fixture.opencodeVersion).toBe('opencode 0.1.0');
    expect(fixture.captureCommand).toContain('opencode run --format json');
    expect(fixture.captureCommand).toContain('--attach /tmp/rorca-opencode-parity.sock');
    expect(fixture.captureCommand).toContain('COLUMNS=80');
    expect(fixture.terminalWidth).toBe(80);
    expect(fixture.workspace).toBe('fixtures/opencode-parity-workspace');
    expect(fixture.prompt).toBe('Explain the replay semantics of this fixed OpenCode terminal parity fixture.');
    expect(fixture.captureNotes[1]).toContain('omits a trailing newline');
  });

  it('keeps raw OpenCode JSONL chunks ordered for native terminal replay, including the final attach update', () => {
    const fixture = readJsonFixture<OpenCodeFixture>(openCodeFixturePath);
    const replayed = concatChunkBytes(fixture.chunks.map((chunk) => decodeBase64Chunk(chunk.base64)));
    const text = Buffer.from(replayed).toString('utf8');

    expect(Buffer.from(replayed)).toEqual(Buffer.concat(decodeFixtureChunks(fixture.chunks)));
    expect(text.indexOf('"type":"assistant"')).toBeLessThan(text.indexOf('"tool":"read"'));
    expect(text.indexOf('"tool":"read"')).toBeLessThan(text.indexOf('"tool":"bash"'));
    expect(text.indexOf('"tool":"bash"')).toBeLessThan(text.indexOf('"tool":"write"'));
    expect(text.indexOf('live attach update')).toBeGreaterThan(text.indexOf('"tool":"bash"'));
    expect(text.endsWith('}}')).toBe(true);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('renders the OpenCode transcript path from the fixture without falling back to raw JSON', () => {
    const fixture = readJsonFixture<OpenCodeFixture>(openCodeFixturePath);
    const lines = Buffer.concat(decodeFixtureChunks(fixture.chunks)).toString('utf8').split('\n');
    const rendered = lines
      .map((line: string) => formatStreamJsonForDisplay(line))
      .filter((line: string | null): line is string => line !== null)
      .join('\n');

    expect(rendered).toContain('[Planning] Inspecting the fixed fixture before writing a note.');
    expect(rendered).toContain('[Read] README.md');
    expect(rendered).toContain('→ live attach update');
    expect(rendered).toContain('[Write] notes.txt');
    expect(rendered).toContain('[Completed] Fixture replay complete.');
    expect(rendered).not.toContain('"type":"tool_call"');
  });

  it('derives semantic OpenCode steps and preserves tool result output from the same fixture', () => {
    const fixture = readJsonFixture<OpenCodeFixture>(openCodeFixturePath);
    const lines = Buffer.concat(decodeFixtureChunks(fixture.chunks)).toString('utf8').split('\n');
    const steps = lines
      .map((line: string) => parseVerboseLine(line))
      .filter((step: ReturnType<typeof parseVerboseLine>): step is ParsedStep => step !== null);

    expect(steps.map((step) => step.type)).toEqual(['plan', 'read', 'read', 'bash', 'bash', 'write', 'write', 'commit']);
    expect(steps[0]).toMatchObject({
      type: 'plan',
      label: 'Reasoning',
      detail: 'Inspecting the fixed fixture before writing a note.',
    });
    expect(steps[1]).toMatchObject({ type: 'read', label: 'Read README.md', toolName: 'read' });
    expect(steps[2]).toMatchObject({ type: 'read', label: 'read result', durationMs: 34, toolName: 'read' });
    expect(steps[4]).toMatchObject({
      type: 'bash',
      label: 'bash result',
      output: 'live attach update',
      durationMs: 28,
      toolName: 'bash',
    });
    expect(steps[5]).toMatchObject({ type: 'write', label: 'Write notes.txt', toolName: 'write' });
    expect(steps[7]).toMatchObject({ type: 'commit', label: 'Run completed' });
  });
});
