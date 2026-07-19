/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { resolveOperatorInputTerminalMode } from '../terminal-mode';
import {
  createPiPromptFile,
  createPiSessionDirectory,
  detectPiStructuredCapability,
  mapPiStructuredEvent,
  resolvePiExecutionProfile,
} from '../pi-structured-profile';

function mode(path: string): number {
  return fs.statSync(path).mode & 0o777;
}

describe('Pi structured autonomous profile', () => {
  test.each([
    ['0.80.4', true],
    ['0.80.6', true],
    ['0.80.3', false],
    ['0.67.0', false],
    [null, false],
    ['development', false],
  ])('capability detection gates version %s', (version, supported) => {
    expect(detectPiStructuredCapability(version).supported).toBe(supported);
  });

  test('routes operator PTY modes to interactive and semantic runs to structured RPC', () => {
    expect(resolvePiExecutionProfile('ansi-html')).toBe('structured');
    expect(resolvePiExecutionProfile('pty')).toBe('interactive');
    expect(resolvePiExecutionProfile('native-pty')).toBe('interactive');
    expect(resolvePiExecutionProfile('ansi-html', true)).toBe('interactive');
    expect(resolveOperatorInputTerminalMode('ansi-html', true)).toBe('native-pty');
    expect(resolveOperatorInputTerminalMode('ansi-html', false)).toBe('ansi-html');
  });

  test('contains session state in a private directory and removes it at closeout', () => {
    const directory = createPiSessionDirectory(17, 'PTY/004');
    fs.writeFileSync(path.join(directory.path, 'session.jsonl'), '{}\n');

    expect(mode(directory.path)).toBe(0o700);
    directory.cleanup();
    directory.cleanup();
    expect(fs.existsSync(directory.path)).toBe(false);
  });

  test('stores very large prompts exactly in a private file and cleanup is idempotent', () => {
    const prompt = `${'x'.repeat(2 * 1024 * 1024)}\nEOF\n$HOME\n$(touch should-not-run)`;
    const file = createPiPromptFile(17, 'PTY/004', prompt);

    expect(file.path).toContain('rorca-pi-17-PTY_004-');
    expect(file.bytes).toBe(Buffer.byteLength(prompt));
    expect(mode(file.path)).toBe(0o600);
    expect(fs.readFileSync(file.path, 'utf8')).toBe(prompt);

    file.cleanup();
    file.cleanup();
    expect(fs.existsSync(file.path)).toBe(false);
  });

  test('replays the reviewed Pi 0.80.6 RPC fixture in stable event order', () => {
    const fixturePath = path.join(__dirname, '..', '..', '__tests__', 'fixtures', 'pi', 'pi-rpc-0.80.6.jsonl');
    const events = fs.readFileSync(fixturePath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const [metadata, ...protocolEvents] = events;
    const mapped = protocolEvents.map(mapPiStructuredEvent);

    expect(metadata).toMatchObject({ piVersion: '0.80.6', protocol: 'strict LF-delimited JSONL' });
    expect(protocolEvents.map(event => event.type)).toEqual([
      'agent_start', 'turn_start', 'message_start', 'message_update',
      'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
      'message_end', 'turn_end', 'agent_end', 'agent_settled',
    ]);
    expect(mapped.flatMap(event => event.transcripts).map(event => event.eventType)).toEqual([
      'host_notice', 'host_notice', 'model_message', 'model_message',
      'tool_call', 'tool_result', 'tool_result', 'model_message',
      'model_message', 'host_notice', 'host_notice',
    ]);
  });

  test('maps model deltas losslessly while keeping presentation concise', () => {
    const event = {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    };
    const mapped = mapPiStructuredEvent(event);

    expect(mapped.transcript).toMatchObject({
      eventType: 'model_message',
      eventSource: 'structured',
      authoritative: false,
      payload: { piEvent: event },
    });
    expect(mapped.presentation).toBe('hello');
  });

  test('maps tool calls/results with stable correlation and preserves full payloads', () => {
    const start = { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'edit', args: { path: 'a.ts' } };
    const partial = { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'edit', partialResult: { bytes: 4 } };
    const end = { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'edit', result: { ok: true }, isError: false };

    expect([start, partial, end].map(mapPiStructuredEvent).map(item => item.transcript)).toEqual([
      expect.objectContaining({ eventType: 'tool_call', correlationId: 'call-1', payload: { piEvent: start } }),
      expect.objectContaining({ eventType: 'tool_result', correlationId: 'call-1', payload: { piEvent: partial } }),
      expect.objectContaining({ eventType: 'tool_result', correlationId: 'call-1', payload: { piEvent: end } }),
    ]);
  });

  test('chunks very large structured results without loss or reordering', () => {
    const event = {
      type: 'tool_execution_end',
      toolCallId: 'call-large',
      toolName: 'read',
      result: { content: 'λ'.repeat(40_000) },
      isError: false,
    };
    const mapped = mapPiStructuredEvent(event);
    const reconstructed = Buffer.concat(mapped.transcripts.map((record) => {
      const payload = record.payload as { piEventChunk: { bytes: string; index: number } };
      return Buffer.from(payload.piEventChunk.bytes, 'base64');
    })).toString('utf8');

    expect(mapped.transcripts.length).toBeGreaterThan(1);
    expect(mapped.transcripts.map(record => record.correlationId)).toEqual(
      Array(mapped.transcripts.length).fill('call-large'),
    );
    expect(JSON.parse(reconstructed)).toEqual(event);
  });

  test('maps errors and cumulative token/cost usage without granting completion authority', () => {
    const error = { type: 'extension_error', extensionPath: '/tmp/ext.ts', error: 'broken' };
    const turn = {
      type: 'turn_end',
      message: { usage: { input: 123, output: 45, cost: { total: 0.25 } } },
      toolResults: [],
    };

    expect(mapPiStructuredEvent(error).transcript).toMatchObject({ eventType: 'error', authoritative: false });
    expect(mapPiStructuredEvent(turn)).toMatchObject({
      transcript: { eventType: 'model_message', authoritative: false },
      usage: { inputTokens: 123, outputTokens: 45, costUsd: 0.25 },
    });
  });

  test('retains malformed or partial values as non-authoritative records', () => {
    expect(mapPiStructuredEvent('{partial').transcript).toMatchObject({
      eventType: 'host_notice',
      eventSource: 'structured',
      authoritative: false,
      payload: { piEvent: { type: 'malformed_event', value: '{partial' } },
    });
  });
});
