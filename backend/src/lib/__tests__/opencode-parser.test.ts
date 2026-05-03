/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
  parseOpenCodeEvent,
  OpenCodeStreamParser,
  parseOpenCodeStream,
  aggregateSignals,
  type OpenCodeEvent,
} from '../opencode-parser';

// ─── parseOpenCodeEvent ──────────────────────────────────────────────────────

describe('parseOpenCodeEvent', () => {
  // ── tool_call events ───────────────────────────────────────────────

  test('read tool_call → semantic type read + terminal output', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'read',
      args: { file_path: '/src/index.ts' },
      timestamp: '2026-02-27T10:00:00Z',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic).not.toBeNull();
    expect(result.semantic!.type).toBe('read');
    expect(result.semantic!.label).toBe('Read /src/index.ts');
    expect(result.semantic!.ts).toBe('2026-02-27T10:00:00Z');
    expect(result.terminal).toContain('[Read]');
    expect(result.terminal).toContain('/src/index.ts');
    expect(result.signal.completed).toBe(false);
    expect(result.signal.failed).toBe(false);
  });

  test('write tool_call → semantic type write', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'write',
      args: { path: '/new-file.ts' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('write');
    expect(result.semantic!.label).toBe('Write /new-file.ts');
    expect(result.terminal).toContain('[Write]');
  });

  test('edit tool_call → semantic type edit', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'edit',
      args: { file_path: '/src/app.tsx' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('edit');
    expect(result.semantic!.label).toBe('Edit /src/app.tsx');
    expect(result.terminal).toContain('[Edit]');
  });

  test('bash tool_call → semantic type bash with command detail', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'bash',
      args: { command: 'npm run build', description: 'Build project' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('bash');
    expect(result.semantic!.label).toBe('Build project');
    expect(result.semantic!.detail).toBe('npm run build');
    expect(result.terminal).toContain('[Bash]');
    expect(result.terminal).toContain('npm run build');
  });

  test('bash tool_call without description uses command', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'bash',
      args: { command: 'npx tsc --noEmit' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.label).toBe('npx tsc --noEmit');
  });

  test('glob tool_call → semantic type search', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'glob',
      args: { pattern: '**/*.ts', path: '/src' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('search');
    expect(result.semantic!.label).toContain('**/*.ts');
    expect(result.semantic!.detail).toBe('/src');
    expect(result.terminal).toContain('[Search]');
  });

  test('grep tool_call → semantic type search', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'grep',
      args: { pattern: 'TODO', path: '/src' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('search');
    expect(result.terminal).toContain('[Search]');
    expect(result.terminal).toContain('/src');
  });

  test('webfetch tool_call → semantic type read', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'webfetch',
      args: { url: 'https://example.com' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('read');
    expect(result.semantic!.label).toContain('https://example.com');
  });

  test('websearch tool_call → semantic type search', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'websearch',
      args: { query: 'react hooks' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('search');
    expect(result.semantic!.label).toContain('react hooks');
  });

  test('unknown tool → semantic type unknown', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'sometool',
      args: {},
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('unknown');
    expect(result.terminal).toContain('[Tool]');
  });

  test('tool_call with name field instead of tool field', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      name: 'read',
      input: { file_path: '/a.ts' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('read');
    expect(result.semantic!.label).toBe('Read /a.ts');
  });

  // ── tool_result events ─────────────────────────────────────────────

  test('tool_result → no semantic step, has terminal output', () => {
    const event: OpenCodeEvent = {
      type: 'tool_result',
      content: 'File contents here...',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic).toBeNull();
    expect(result.terminal).toContain('→');
    expect(result.terminal).toContain('File contents here');
  });

  test('tool_result truncates long output', () => {
    const event: OpenCodeEvent = {
      type: 'tool_result',
      content: 'x'.repeat(300),
    };
    const result = parseOpenCodeEvent(event);
    expect(result.terminal).toContain('...');
  });

  // ── assistant events ───────────────────────────────────────────────

  test('assistant with content → semantic type plan', () => {
    const event: OpenCodeEvent = {
      type: 'assistant',
      content: 'I need to analyze the codebase structure before making changes.',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('plan');
    expect(result.semantic!.label).toBe('Reasoning');
    expect(result.terminal).toContain('[Planning]');
  });

  test('assistant with message field → semantic type plan', () => {
    const event: OpenCodeEvent = {
      type: 'assistant',
      message: 'Let me check the existing patterns in this directory.',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('plan');
  });

  test('short assistant content → null semantic, empty terminal', () => {
    const event: OpenCodeEvent = {
      type: 'assistant',
      content: 'OK',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic).toBeNull();
    expect(result.terminal).toBe('');
  });

  // ── completion events ──────────────────────────────────────────────

  test('completion → semantic type commit + completed signal', () => {
    const event: OpenCodeEvent = {
      type: 'completion',
      content: 'All tasks completed successfully.',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('commit');
    expect(result.semantic!.label).toBe('Run completed');
    expect(result.signal.completed).toBe(true);
    expect(result.signal.failed).toBe(false);
    expect(result.terminal).toContain('[Completed]');
  });

  test('completion with non-zero exitCode → failed signal', () => {
    const event: OpenCodeEvent = {
      type: 'completion',
      content: 'Process exited with error.',
      exitCode: 1,
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('unknown');
    expect(result.semantic!.label).toBe('Failed');
    expect(result.signal.completed).toBe(false);
    expect(result.signal.failed).toBe(true);
    expect(result.signal.error).toContain('Exit code: 1');
  });

  test('completion with exit_code (underscore variant) → failed signal', () => {
    const event: OpenCodeEvent = {
      type: 'completion',
      exit_code: 2,
    };
    const result = parseOpenCodeEvent(event);
    expect(result.signal.failed).toBe(true);
    expect(result.signal.error).toContain('Exit code: 2');
  });

  test('completion with exitCode 0 → completed signal', () => {
    const event: OpenCodeEvent = {
      type: 'completion',
      content: 'Done.',
      exitCode: 0,
    };
    const result = parseOpenCodeEvent(event);
    expect(result.signal.completed).toBe(true);
    expect(result.signal.failed).toBe(false);
  });

  // ── error events ───────────────────────────────────────────────────

  test('error event with message → failed signal', () => {
    const event: OpenCodeEvent = {
      type: 'error',
      message: 'Rate limit exceeded',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.type).toBe('unknown');
    expect(result.semantic!.label).toBe('Error');
    expect(result.semantic!.detail).toBe('Rate limit exceeded');
    expect(result.signal.failed).toBe(true);
    expect(result.signal.error).toBe('Rate limit exceeded');
    expect(result.terminal).toContain('[Error]');
    expect(result.terminal).toContain('Rate limit exceeded');
  });

  test('error event with error field → failed signal', () => {
    const event: OpenCodeEvent = {
      type: 'error',
      error: 'Connection timeout',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.signal.error).toBe('Connection timeout');
  });

  test('error event without message → generic error', () => {
    const event: OpenCodeEvent = {
      type: 'error',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.signal.error).toBe('Unknown error');
  });

  // ── status events ──────────────────────────────────────────────────

  test('status event → no semantic, has terminal output', () => {
    const event: OpenCodeEvent = {
      type: 'status',
      status: 'Connecting to server...',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic).toBeNull();
    expect(result.terminal).toContain('[Status]');
    expect(result.terminal).toContain('Connecting to server');
  });

  // ── unknown/system events ──────────────────────────────────────────

  test('unknown event type → null semantic, empty terminal', () => {
    const event: OpenCodeEvent = {
      type: 'heartbeat',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic).toBeNull();
    expect(result.terminal).toBe('');
    expect(result.signal.completed).toBe(false);
    expect(result.signal.failed).toBe(false);
  });

  // ── timestamp handling ─────────────────────────────────────────────

  test('uses event timestamp when provided', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'read',
      args: { path: '/a.ts' },
      timestamp: '2026-01-15T08:30:00Z',
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.ts).toBe('2026-01-15T08:30:00Z');
  });

  test('generates timestamp when not provided', () => {
    const event: OpenCodeEvent = {
      type: 'tool_call',
      tool: 'read',
      args: { path: '/a.ts' },
    };
    const result = parseOpenCodeEvent(event);
    expect(result.semantic!.ts).toBeTruthy();
    // Should be a valid ISO date
    expect(new Date(result.semantic!.ts).toISOString()).toBeTruthy();
  });
});

// ─── OpenCodeStreamParser ────────────────────────────────────────────────────

describe('OpenCodeStreamParser', () => {
  let parser: OpenCodeStreamParser;

  beforeEach(() => {
    parser = new OpenCodeStreamParser();
  });

  test('parses single complete JSON line', () => {
    const line = JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n';
    const results = parser.push(line);
    expect(results).toHaveLength(1);
    expect(results[0].semantic!.type).toBe('read');
  });

  test('parses multiple JSON lines in one chunk', () => {
    const chunk =
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n' +
      JSON.stringify({ type: 'tool_call', tool: 'write', args: { path: '/b.ts' } }) + '\n';
    const results = parser.push(chunk);
    expect(results).toHaveLength(2);
    expect(results[0].semantic!.type).toBe('read');
    expect(results[1].semantic!.type).toBe('write');
  });

  test('handles partial line across two chunks', () => {
    const fullLine = JSON.stringify({ type: 'tool_call', tool: 'bash', args: { command: 'npm test' } });
    const firstHalf = fullLine.slice(0, 20);
    const secondHalf = fullLine.slice(20) + '\n';

    const results1 = parser.push(firstHalf);
    expect(results1).toHaveLength(0); // No complete line yet

    const results2 = parser.push(secondHalf);
    expect(results2).toHaveLength(1);
    expect(results2[0].semantic!.type).toBe('bash');
  });

  test('handles partial line split across three chunks', () => {
    const fullLine = JSON.stringify({ type: 'tool_call', tool: 'edit', args: { file_path: '/component.tsx' } });
    const part1 = fullLine.slice(0, 15);
    const part2 = fullLine.slice(15, 40);
    const part3 = fullLine.slice(40) + '\n';

    expect(parser.push(part1)).toHaveLength(0);
    expect(parser.push(part2)).toHaveLength(0);

    const results = parser.push(part3);
    expect(results).toHaveLength(1);
    expect(results[0].semantic!.type).toBe('edit');
  });

  test('flush processes remaining buffer', () => {
    const line = JSON.stringify({ type: 'completion', content: 'Done' });
    parser.push(line); // No trailing newline

    const results = parser.flush();
    expect(results).toHaveLength(1);
    expect(results[0].signal.completed).toBe(true);
  });

  test('flush returns empty for empty buffer', () => {
    const results = parser.flush();
    expect(results).toHaveLength(0);
  });

  test('flush returns empty for whitespace-only buffer', () => {
    parser.push('   \t  ');
    const results = parser.flush();
    expect(results).toHaveLength(0);
  });

  test('skips empty lines', () => {
    const chunk = '\n\n' +
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n\n';
    const results = parser.push(chunk);
    expect(results).toHaveLength(1);
  });

  test('skips SSE comment lines', () => {
    const chunk =
      ': heartbeat\n' +
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n' +
      ': keepalive\n';
    const results = parser.push(chunk);
    expect(results).toHaveLength(1);
  });

  test('handles non-JSON lines as raw terminal output', () => {
    const chunk = 'Some plain text output\n';
    const results = parser.push(chunk);
    expect(results).toHaveLength(1);
    expect(results[0].semantic).toBeNull();
    expect(results[0].terminal).toBe('Some plain text output');
    expect(results[0].raw.type).toBe('raw');
  });

  test('mixed JSON and non-JSON lines', () => {
    const chunk =
      'Starting opencode...\n' +
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n' +
      'Warning: something happened\n';
    const results = parser.push(chunk);
    expect(results).toHaveLength(3);
    expect(results[0].raw.type).toBe('raw');
    expect(results[1].semantic!.type).toBe('read');
    expect(results[2].raw.type).toBe('raw');
  });

  test('reset clears buffer', () => {
    parser.push('{"type":"tool_call","tool":"re'); // partial
    parser.reset();

    const results = parser.push(
      JSON.stringify({ type: 'tool_call', tool: 'write', args: { path: '/b.ts' } }) + '\n'
    );
    expect(results).toHaveLength(1);
    expect(results[0].semantic!.type).toBe('write');
  });

  test('handles chunked delivery simulating real stdio', () => {
    // Simulate: event1 fully delivered, then event2 split across two reads
    const event1 = JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } });
    const event2 = JSON.stringify({ type: 'tool_call', tool: 'bash', args: { command: 'npm test' } });

    const chunk1 = event1 + '\n' + event2.slice(0, 30);
    const chunk2 = event2.slice(30) + '\n';

    const results1 = parser.push(chunk1);
    expect(results1).toHaveLength(1);
    expect(results1[0].semantic!.type).toBe('read');

    const results2 = parser.push(chunk2);
    expect(results2).toHaveLength(1);
    expect(results2[0].semantic!.type).toBe('bash');
  });
});

// ─── parseOpenCodeStream (bulk) ──────────────────────────────────────────────

describe('parseOpenCodeStream', () => {
  test('parses complete event stream', () => {
    const stream = [
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }),
      JSON.stringify({ type: 'assistant', content: 'Analyzing the code structure and patterns here.' }),
      JSON.stringify({ type: 'tool_call', tool: 'edit', args: { file_path: '/a.ts' } }),
      JSON.stringify({ type: 'completion', content: 'Done' }),
    ].join('\n') + '\n';

    const results = parseOpenCodeStream(stream);
    expect(results).toHaveLength(4);
    expect(results[0].semantic!.type).toBe('read');
    expect(results[1].semantic!.type).toBe('plan');
    expect(results[2].semantic!.type).toBe('edit');
    expect(results[3].semantic!.type).toBe('commit');
  });

  test('parses stream without trailing newline', () => {
    const stream = JSON.stringify({ type: 'completion', content: 'Done' });
    const results = parseOpenCodeStream(stream);
    expect(results).toHaveLength(1);
    expect(results[0].signal.completed).toBe(true);
  });

  test('empty stream returns empty array', () => {
    expect(parseOpenCodeStream('')).toHaveLength(0);
  });
});

// ─── aggregateSignals ────────────────────────────────────────────────────────

describe('aggregateSignals', () => {
  test('no events → no signals', () => {
    const signal = aggregateSignals([]);
    expect(signal.completed).toBe(false);
    expect(signal.failed).toBe(false);
    expect(signal.error).toBeUndefined();
  });

  test('completion event → completed signal', () => {
    const events = parseOpenCodeStream(
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n' +
      JSON.stringify({ type: 'completion', content: 'Done' }) + '\n'
    );
    const signal = aggregateSignals(events);
    expect(signal.completed).toBe(true);
    expect(signal.failed).toBe(false);
  });

  test('error event → failed signal', () => {
    const events = parseOpenCodeStream(
      JSON.stringify({ type: 'error', message: 'Something went wrong' }) + '\n'
    );
    const signal = aggregateSignals(events);
    expect(signal.completed).toBe(false);
    expect(signal.failed).toBe(true);
    expect(signal.error).toBe('Something went wrong');
  });

  test('failure overrides completion', () => {
    const events = parseOpenCodeStream(
      JSON.stringify({ type: 'completion', content: 'Done' }) + '\n' +
      JSON.stringify({ type: 'error', message: 'But then failed' }) + '\n'
    );
    const signal = aggregateSignals(events);
    expect(signal.completed).toBe(false); // overridden by failure
    expect(signal.failed).toBe(true);
    expect(signal.error).toBe('But then failed');
  });

  test('only tool calls → no signals', () => {
    const events = parseOpenCodeStream(
      JSON.stringify({ type: 'tool_call', tool: 'read', args: { path: '/a.ts' } }) + '\n' +
      JSON.stringify({ type: 'tool_call', tool: 'write', args: { path: '/b.ts' } }) + '\n'
    );
    const signal = aggregateSignals(events);
    expect(signal.completed).toBe(false);
    expect(signal.failed).toBe(false);
  });

  test('completion with non-zero exit code → failed', () => {
    const events = parseOpenCodeStream(
      JSON.stringify({ type: 'completion', content: 'Exited', exitCode: 1 }) + '\n'
    );
    const signal = aggregateSignals(events);
    expect(signal.completed).toBe(false);
    expect(signal.failed).toBe(true);
  });
});
