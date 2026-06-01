/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getClaudeAuthState } from '../../lib/claude-auth';
import { detectCodex } from '../../lib/codex-detector';
import { detectOpenCode } from '../../lib/opencode-detector';
import { detectPi, listPiModels } from '../../lib/pi-detector';

export type GoldenEngine = 'claude' | 'codex' | 'opencode' | 'pi';

export interface GoldenEngineManifestEntry {
  engine: GoldenEngine;
  agentType: GoldenEngine;
  captureFormat: 'stream-json' | 'raw' | 'json' | 'jsonl';
  fixturePath: string;
  pinnedVersion: string;
  terminal: {
    cols: number;
    rows: number;
  };
  availability: {
    requiresAuth: boolean;
    skipReason: string;
  };
  byteLength: number;
  chunkCount: number;
  normalizedSha256: string;
  eventOrderSha256: string;
  terminalStateSha256: string;
}

export interface GoldenManifest {
  version: number;
  updateMode: string;
  engines: Record<GoldenEngine, GoldenEngineManifestEntry>;
}

export interface GoldenFixtureData {
  engine: GoldenEngine;
  manifest: GoldenEngineManifestEntry;
  fixtureAbsolutePath: string;
  directBytes: Buffer;
  replayChunks: Array<{ sequence: number; chunk: Buffer }>;
  normalizedText: string;
  eventOrderTokens: string[];
  terminalStateTokens: string[];
}

export interface GoldenAvailability {
  available: boolean;
  reason: string | null;
  installedVersion: string | null;
}

export interface GoldenComparison {
  directNormalizedSha256: string;
  replayNormalizedSha256: string;
  replayEventOrderSha256: string;
  replayTerminalStateSha256: string;
  chunkIds: string[];
  expectedChunkIds: string[];
  rawMatches: boolean;
  contracts: {
    version: boolean;
    layout: boolean;
    eventOrder: boolean;
    terminalState: boolean;
    byteOrder: boolean;
  };
}

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
export const GOLDEN_MANIFEST_PATH = path.join(BACKEND_ROOT, 'src', '__tests__', 'golden', 'v1', 'terminal-parity.manifest.json');
export const GOLDEN_ENGINES: GoldenEngine[] = ['claude', 'codex', 'opencode', 'pi'];

const CONTROL_SEQUENCE_PATTERN = /(\\u001b\[[0-?]*[ -/]*[@-~]|\x1b\[[0-?]*[ -/]*[@-~]|\r)/g;

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extractSemver(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return match ? match[1] : null;
}

function normalizeJsonLine(line: string): string {
  return line
    .replace(/"timestamp":"[^"]+"/g, '"timestamp":"<timestamp>"')
    .replace(/"started_at":"[^"]+"/g, '"started_at":"<timestamp>"')
    .replace(/"finished_at":"[^"]+"/g, '"finished_at":"<timestamp>"')
    .replace(/"runId":\d+/g, '"runId":<runId>')
    .replace(/"run_id":\d+/g, '"run_id":<runId>')
    .replace(/"id":"run-[^"]+"/g, '"id":"<run-id>"')
    .replace(/"session_id":"[^"]+"/g, '"session_id":"<session-id>"')
    .replace(/"duration_ms":\d+/g, '"duration_ms":<duration_ms>')
    .replace(/"durationMs":\d+/g, '"durationMs":<durationMs>')
    .replace(/"wallClockMs":\d+/g, '"wallClockMs":<wallClockMs>')
    .replace(/"input_tokens":\d+/g, '"input_tokens":<input_tokens>')
    .replace(/"output_tokens":\d+/g, '"output_tokens":<output_tokens>')
    .replace(/"inputTokens":\d+/g, '"inputTokens":<inputTokens>')
    .replace(/"outputTokens":\d+/g, '"outputTokens":<outputTokens>')
    .replace(/"reasoning_tokens":\d+/g, '"reasoning_tokens":<reasoning_tokens>')
    .replace(/"reasoningTokens":\d+/g, '"reasoningTokens":<reasoningTokens>')
    .replace(/"costUsd":-?\d+(?:\.\d+)?/g, '"costUsd":<costUsd>')
    .replace(/"cost_usd":-?\d+(?:\.\d+)?/g, '"cost_usd":<cost_usd>')
    .replace(/"gitSha":"[0-9a-f]{7,40}"/gi, '"gitSha":"<git-sha>"')
    .replace(/"commit":"[0-9a-f]{7,40}"/gi, '"commit":"<git-sha>"')
    .replace(/"model":"(?:claude|gpt|o[0-9]|openai\/|anthropic\/)[^"]+"/gi, '"model":"<model>"');
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (value) => value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (value) => value)
    .replace(/\b[0-9a-f]{40}\b/gi, '<git-sha>');
}

export function normalizeGoldenText(engine: GoldenEngine, directBytes: Buffer): string {
  const raw = directBytes.toString('utf8');
  const normalized = normalizeText(raw)
    .split('\n')
    .map((line) => {
      if (engine === 'codex' || engine === 'claude') return line;
      return normalizeJsonLine(line);
    })
    .join('\n')
    .trimEnd();

  return normalized;
}

function extractClaudeTextBlocks(lines: string[]): string {
  const parts: string[] = [];

  for (const line of lines.slice(1)) {
    const event = JSON.parse(line) as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (event.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
    }
  }

  return parts.join('');
}

function extractClaudeEventOrder(lines: string[]): string[] {
  return lines.slice(1).flatMap((line) => {
    const event = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      message?: { content?: Array<{ type?: string; name?: string }> };
    };

    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      return event.message.content.map((block) => {
        if (block.type === 'tool_use') return `assistant:tool_use:${block.name ?? 'unknown'}`;
        return `assistant:${block.type ?? 'unknown'}`;
      });
    }

    return [`${event.type ?? 'unknown'}:${event.subtype ?? 'default'}`];
  });
}

function extractJsonEventOrder(text: string): string[] {
  return text
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as { type?: string; tool?: string; subtype?: string };
      return [event.type ?? 'unknown', event.tool ?? event.subtype ?? 'default'].join(':');
    });
}

function extractCodexEventOrder(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /^(Task:|Read |Write )/.test(line))
    .map((line) => line.replace(/\s+/g, ' '));
}

function extractTerminalStateTokens(text: string): string[] {
  return Array.from(text.matchAll(CONTROL_SEQUENCE_PATTERN), (match) => match[0]);
}

function loadClaudeFixture(entry: GoldenEngineManifestEntry, fixtureAbsolutePath: string): GoldenFixtureData {
  const lines = fs.readFileSync(fixtureAbsolutePath, 'utf8').trimEnd().split('\n');
  const directBytes = Buffer.from(extractClaudeTextBlocks(lines), 'utf8');
  const replayChunks = [
    { sequence: 2, chunk: directBytes.subarray(Math.ceil(directBytes.length / 3), Math.ceil((directBytes.length / 3) * 2)) },
    { sequence: 1, chunk: directBytes.subarray(0, Math.ceil(directBytes.length / 3)) },
    { sequence: 3, chunk: directBytes.subarray(Math.ceil((directBytes.length / 3) * 2)) },
  ];
  const normalizedText = normalizeGoldenText('claude', directBytes);
  const eventOrderTokens = extractClaudeEventOrder(lines);
  const terminalStateTokens = extractTerminalStateTokens(normalizedText);

  return {
    engine: 'claude',
    manifest: entry,
    fixtureAbsolutePath,
    directBytes,
    replayChunks,
    normalizedText,
    eventOrderTokens,
    terminalStateTokens,
  };
}

function loadChunkFixture(
  engine: Extract<GoldenEngine, 'codex' | 'opencode'>,
  entry: GoldenEngineManifestEntry,
  fixtureAbsolutePath: string,
): GoldenFixtureData {
  const fixture = JSON.parse(fs.readFileSync(fixtureAbsolutePath, 'utf8')) as {
    chunks: Array<{ sequence: number; base64: string }>;
  };
  const orderedChunks = fixture.chunks
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => ({ sequence: chunk.sequence, chunk: Buffer.from(chunk.base64, 'base64') }));
  const replayChunks = orderedChunks.slice().reverse();
  const directBytes = Buffer.concat(orderedChunks.map((chunk) => chunk.chunk));
  const normalizedText = normalizeGoldenText(engine, directBytes);
  const eventOrderTokens = engine === 'opencode'
    ? extractJsonEventOrder(directBytes.toString('utf8'))
    : extractCodexEventOrder(directBytes.toString('utf8'));
  const terminalStateTokens = extractTerminalStateTokens(normalizedText);

  return {
    engine,
    manifest: entry,
    fixtureAbsolutePath,
    directBytes,
    replayChunks,
    normalizedText,
    eventOrderTokens,
    terminalStateTokens,
  };
}

function loadPiFixture(entry: GoldenEngineManifestEntry, fixtureAbsolutePath: string): GoldenFixtureData {
  const directBytes = fs.readFileSync(fixtureAbsolutePath);
  const segmentSize = Math.ceil(directBytes.length / 3);
  const replayChunks = [
    { sequence: 3, chunk: directBytes.subarray(segmentSize * 2) },
    { sequence: 1, chunk: directBytes.subarray(0, segmentSize) },
    { sequence: 2, chunk: directBytes.subarray(segmentSize, segmentSize * 2) },
  ];
  const normalizedText = normalizeGoldenText('pi', directBytes);
  const eventOrderTokens = extractJsonEventOrder(directBytes.toString('utf8'));
  const terminalStateTokens = extractTerminalStateTokens(normalizedText);

  return {
    engine: 'pi',
    manifest: entry,
    fixtureAbsolutePath,
    directBytes,
    replayChunks,
    normalizedText,
    eventOrderTokens,
    terminalStateTokens,
  };
}

export function readGoldenManifest(): GoldenManifest {
  return JSON.parse(fs.readFileSync(GOLDEN_MANIFEST_PATH, 'utf8')) as GoldenManifest;
}

export function loadGoldenFixture(engine: GoldenEngine): GoldenFixtureData {
  const manifest = readGoldenManifest();
  const entry = manifest.engines[engine];
  const fixtureAbsolutePath = path.resolve(BACKEND_ROOT, entry.fixturePath);

  switch (engine) {
    case 'claude':
      return loadClaudeFixture(entry, fixtureAbsolutePath);
    case 'codex':
      return loadChunkFixture('codex', entry, fixtureAbsolutePath);
    case 'opencode':
      return loadChunkFixture('opencode', entry, fixtureAbsolutePath);
    case 'pi':
      return loadPiFixture(entry, fixtureAbsolutePath);
  }
}

export function getGoldenAvailability(engine: GoldenEngine): GoldenAvailability {
  switch (engine) {
    case 'claude': {
      const status = getClaudeAuthState();
      return {
        available: status.cliInstalled,
        reason: status.cliInstalled ? null : 'claude CLI unavailable',
        installedVersion: status.cliVersion ?? null,
      };
    }
    case 'codex': {
      const status = detectCodex();
      return {
        available: status.codexInstalled,
        reason: status.codexInstalled ? null : 'codex CLI unavailable',
        installedVersion: status.codexVersion ? `codex ${status.codexVersion}` : null,
      };
    }
    case 'opencode': {
      const status = detectOpenCode();
      return {
        available: status.opencodeInstalled,
        reason: status.opencodeInstalled ? null : 'opencode CLI unavailable',
        installedVersion: status.opencodeVersion ? `opencode ${status.opencodeVersion}` : null,
      };
    }
    case 'pi': {
      const status = detectPi();
      if (!status.piInstalled || !status.piBinPath) {
        return {
          available: false,
          reason: 'pi CLI unavailable',
          installedVersion: status.piVersion ? `pi ${status.piVersion}` : null,
        };
      }

      const models = listPiModels(status.piBinPath);
      if (models.length === 0) {
        return {
          available: false,
          reason: 'pi installed but no provider auth available (run: pi auth login)',
          installedVersion: status.piVersion ? `pi ${status.piVersion}` : null,
        };
      }

      return {
        available: true,
        reason: null,
        installedVersion: status.piVersion ? `pi ${status.piVersion}` : null,
      };
    }
  }
}

export function shouldUpdateGolden(): boolean {
  return process.argv.includes('--update-golden')
    || process.env.RORCA_UPDATE_GOLDEN === '1'
    || process.env.npm_config_update_golden === 'true';
}

export function buildGoldenManifestEntry(current: GoldenFixtureData): GoldenEngineManifestEntry {
  return {
    ...current.manifest,
    byteLength: current.directBytes.length,
    chunkCount: current.replayChunks.length,
    normalizedSha256: sha256(current.normalizedText),
    eventOrderSha256: sha256(current.eventOrderTokens.join('\n')),
    terminalStateSha256: sha256(current.terminalStateTokens.join('\n')),
  };
}

export function syncGoldenManifestEntry(engine: GoldenEngine, current: GoldenFixtureData): GoldenEngineManifestEntry {
  const manifest = readGoldenManifest();
  const nextEntry = buildGoldenManifestEntry(current);

  if (shouldUpdateGolden()) {
    const nextManifest: GoldenManifest = {
      ...manifest,
      engines: {
        ...manifest.engines,
        [engine]: nextEntry,
      },
    };
    fs.writeFileSync(GOLDEN_MANIFEST_PATH, `${JSON.stringify(nextManifest, null, 2)}\n`);
    return nextEntry;
  }

  return manifest.engines[engine];
}

function firstDifference(left: string, right: string): string {
  const leftLines = left.split('\n');
  const rightLines = right.split('\n');
  const total = Math.max(leftLines.length, rightLines.length);

  for (let index = 0; index < total; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return `line ${index + 1}\nexpected: ${leftLines[index] ?? '<missing>'}\nreceived: ${rightLines[index] ?? '<missing>'}`;
    }
  }

  return 'no textual diff available';
}

export function compareGoldenReplay(
  fixture: GoldenFixtureData,
  replayBytes: Buffer,
  chunkIds: string[],
  availability: GoldenAvailability,
): GoldenComparison {
  const entry = syncGoldenManifestEntry(fixture.engine, fixture);
  const replayNormalizedText = normalizeGoldenText(fixture.engine, replayBytes);
  const expectedChunkIds = fixture.replayChunks
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => String(chunk.sequence));
  const pinnedVersion = extractSemver(entry.pinnedVersion);
  const installedVersion = extractSemver(availability.installedVersion);

  return {
    directNormalizedSha256: sha256(fixture.normalizedText),
    replayNormalizedSha256: sha256(replayNormalizedText),
    replayEventOrderSha256: sha256(fixture.eventOrderTokens.join('\n')),
    replayTerminalStateSha256: sha256(extractTerminalStateTokens(replayNormalizedText).join('\n')),
    chunkIds,
    expectedChunkIds,
    rawMatches: fixture.directBytes.equals(replayBytes),
    contracts: {
      version: !availability.available || !installedVersion || !pinnedVersion || installedVersion === pinnedVersion,
      layout: sha256(fixture.normalizedText) === entry.normalizedSha256
        && sha256(replayNormalizedText) === entry.normalizedSha256,
      eventOrder: sha256(fixture.eventOrderTokens.join('\n')) === entry.eventOrderSha256
        && JSON.stringify(chunkIds) === JSON.stringify(expectedChunkIds),
      terminalState: sha256(extractTerminalStateTokens(replayNormalizedText).join('\n')) === entry.terminalStateSha256,
      byteOrder: fixture.directBytes.equals(replayBytes),
    },
  };
}

export function buildGoldenDiffReport(
  fixture: GoldenFixtureData,
  replayBytes: Buffer,
  chunkIds: string[],
  availability: GoldenAvailability,
): string {
  const entry = syncGoldenManifestEntry(fixture.engine, fixture);
  const replayNormalizedText = normalizeGoldenText(fixture.engine, replayBytes);
  const replayTerminalTokens = extractTerminalStateTokens(replayNormalizedText);
  const expectedChunkIds = fixture.replayChunks
    .slice()
    .sort((left, right) => left.sequence - right.sequence)
    .map((chunk) => String(chunk.sequence));
  const pinnedVersion = entry.pinnedVersion;
  const installedVersion = availability.installedVersion ?? '<unavailable>';
  const contracts: string[] = [];

  if (extractSemver(pinnedVersion) !== null && extractSemver(installedVersion) !== null && extractSemver(pinnedVersion) !== extractSemver(installedVersion)) {
    contracts.push(`version mismatch: pinned=${pinnedVersion} installed=${installedVersion}`);
  }

  if (sha256(fixture.normalizedText) !== entry.normalizedSha256 || sha256(replayNormalizedText) !== entry.normalizedSha256) {
    contracts.push(`layout mismatch: ${firstDifference(fixture.normalizedText, replayNormalizedText)}`);
  }

  if (!fixture.directBytes.equals(replayBytes)) {
    contracts.push(`byte order mismatch: expected ${fixture.directBytes.length} bytes, received ${replayBytes.length} bytes`);
  }

  if (JSON.stringify(chunkIds) !== JSON.stringify(expectedChunkIds)) {
    contracts.push(`event-order mismatch: expected chunk ids [${expectedChunkIds.join(', ')}] but received [${chunkIds.join(', ')}]`);
  }

  if (sha256(replayTerminalTokens.join('\n')) !== entry.terminalStateSha256) {
    contracts.push(`terminal-state mismatch: expected ${entry.terminalStateSha256} but received ${sha256(replayTerminalTokens.join('\n'))}`);
  }

  if (contracts.length === 0) {
    contracts.push('no contract failures recorded');
  }

  return [
    `Golden parity report for ${fixture.engine}`,
    `fixture: ${path.relative(BACKEND_ROOT, fixture.fixtureAbsolutePath)}`,
    `terminal: ${entry.terminal.cols}x${entry.terminal.rows}`,
    `pinned version: ${pinnedVersion}`,
    `installed version: ${installedVersion}`,
    ...contracts.map((contract) => `- ${contract}`),
  ].join('\n');
}

export function assertGoldenReplay(
  fixture: GoldenFixtureData,
  replayBytes: Buffer,
  chunkIds: string[],
  availability: GoldenAvailability,
): void {
  const comparison = compareGoldenReplay(fixture, replayBytes, chunkIds, availability);
  if (comparison.contracts.layout
    && comparison.contracts.eventOrder
    && comparison.contracts.terminalState
    && comparison.contracts.byteOrder) {
    return;
  }

  throw new Error(buildGoldenDiffReport(fixture, replayBytes, chunkIds, availability));
}
