/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { parseStreamJsonLine, parseOpenCodeLine, parseLine } from '../semantic-log-parser';

// ─── Claude stream-json tests ────────────────────────────────────────────────

describe('parseStreamJsonLine', () => {
  test('Read tool_use → type read with file path', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/src/index.ts' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('read');
    expect(step!.label).toBe('Read /src/index.ts');
    expect(step!.ts).toBeTruthy();
  });

  test('Edit tool_use → type edit with file path', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Edit',
      input: { file_path: '/src/app.tsx' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('edit');
    expect(step!.label).toBe('Edit /src/app.tsx');
  });

  test('Bash tool_use → type bash with description', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'npm test', description: 'Run tests' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('bash');
    expect(step!.label).toBe('Run tests');
    expect(step!.detail).toBe('npm test');
  });

  test('Write tool_use → type write', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Write',
      input: { file_path: '/new-file.ts', content: 'hello' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('write');
    expect(step!.label).toBe('Write /new-file.ts');
  });

  test('Glob tool_use → type search', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Glob',
      input: { pattern: '**/*.ts', path: '/src' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('search');
    expect(step!.label).toBe('Glob **/*.ts');
    expect(step!.detail).toBe('/src');
  });

  test('Grep tool_use → type search', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Grep',
      input: { pattern: 'TODO', path: '/src' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('search');
    expect(step!.label).toBe('Grep TODO');
  });

  test('assistant message → type plan', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: 'Let me analyze the codebase structure to understand the patterns used here.',
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('plan');
    expect(step!.label).toBe('Reasoning');
  });

  test('short assistant message → null (below threshold)', () => {
    const line = JSON.stringify({ type: 'assistant', message: 'OK' });
    expect(parseStreamJsonLine(line)).toBeNull();
  });

  test('result with success subtype → type commit', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'All changes committed. commit abc1234 feat: add dark mode toggle',
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('commit');
    expect(step!.label).toBe('abc1234');
  });

  test('result with success but no commit → commit with generic label', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Task completed successfully',
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('commit');
    expect(step!.label).toBe('Run completed');
  });

  test('result with error subtype → type unknown', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error',
      error: 'Process timed out',
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('unknown');
    expect(step!.label).toBe('Error');
    expect(step!.detail).toBe('Process timed out');
  });

  test('Task tool_use → type plan', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Task',
      input: { description: 'Explore codebase structure', prompt: 'Find all routes' },
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('plan');
    expect(step!.label).toContain('Task:');
  });

  test('unknown tool → type unknown', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'CustomTool',
      input: {},
    });
    const step = parseStreamJsonLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('unknown');
    expect(step!.label).toBe('CustomTool');
  });

  test('malformed JSON → null', () => {
    expect(parseStreamJsonLine('not json at all')).toBeNull();
  });

  test('empty line → null', () => {
    expect(parseStreamJsonLine('')).toBeNull();
    expect(parseStreamJsonLine('   ')).toBeNull();
  });

  test('SSE comment line → null', () => {
    expect(parseStreamJsonLine(': heartbeat')).toBeNull();
  });

  test('unrecognized type field → null', () => {
    const line = JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } });
    expect(parseStreamJsonLine(line)).toBeNull();
  });
});

// ─── OpenCode --format json tests ────────────────────────────────────────────

describe('parseOpenCodeLine', () => {
  test('read tool_call → type read', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'read',
      args: { file_path: '/src/main.ts' },
      timestamp: '2026-02-26T10:00:00Z',
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('read');
    expect(step!.label).toBe('Read /src/main.ts');
    expect(step!.ts).toBe('2026-02-26T10:00:00Z');
  });

  test('write tool_call → type write', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'write',
      args: { path: '/new.ts' },
      timestamp: '2026-02-26T10:01:00Z',
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('write');
    expect(step!.label).toBe('Write /new.ts');
  });

  test('edit tool_call → type edit', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'edit',
      args: { file_path: '/src/component.tsx' },
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('edit');
    expect(step!.label).toBe('Edit /src/component.tsx');
  });

  test('bash tool_call → type bash with command detail', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'bash',
      args: { command: 'npm run build', description: 'Build project' },
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('bash');
    expect(step!.label).toBe('Build project');
    expect(step!.detail).toBe('npm run build');
  });

  test('glob tool_call → type search', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'glob',
      args: { pattern: '*.json' },
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('search');
    expect(step!.label).toContain('*.json');
  });

  test('grep tool_call → type search', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'grep',
      args: { pattern: 'import', path: '/src' },
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('search');
    expect(step!.detail).toBe('/src');
  });

  test('assistant message → type plan', () => {
    const line = JSON.stringify({
      type: 'assistant',
      content: 'I need to understand the authentication flow before making changes.',
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('plan');
    expect(step!.label).toBe('Reasoning');
  });

  test('short assistant content → null', () => {
    const line = JSON.stringify({ type: 'assistant', content: 'OK' });
    expect(parseOpenCodeLine(line)).toBeNull();
  });

  test('completion → type commit', () => {
    const line = JSON.stringify({
      type: 'completion',
      content: 'Implementation complete. All tests passing.',
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('commit');
    expect(step!.label).toBe('Run completed');
  });

  test('error event → type unknown', () => {
    const line = JSON.stringify({
      type: 'error',
      message: 'Rate limit exceeded',
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('unknown');
    expect(step!.label).toBe('Error');
    expect(step!.detail).toBe('Rate limit exceeded');
  });

  test('malformed JSON → null', () => {
    expect(parseOpenCodeLine('{not valid')).toBeNull();
  });

  test('empty line → null', () => {
    expect(parseOpenCodeLine('')).toBeNull();
  });

  test('unknown tool → type unknown', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'sometool',
      args: {},
    });
    const step = parseOpenCodeLine(line);
    expect(step).not.toBeNull();
    expect(step!.type).toBe('unknown');
  });

  test('uses timestamp from event', () => {
    const ts = '2026-01-15T08:30:00Z';
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'read',
      args: { path: '/a.ts' },
      timestamp: ts,
    });
    const step = parseOpenCodeLine(line);
    expect(step!.ts).toBe(ts);
  });
});

// ─── parseLine dispatcher tests ──────────────────────────────────────────────

describe('parseLine', () => {
  test('dispatches to opencode parser when agent is opencode', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      tool: 'bash',
      args: { command: 'ls' },
    });
    const step = parseLine(line, 'opencode');
    expect(step).not.toBeNull();
    expect(step!.type).toBe('bash');
  });

  test('dispatches to claude parser when agent is claude', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'ls' },
    });
    const step = parseLine(line, 'claude');
    expect(step).not.toBeNull();
    expect(step!.type).toBe('bash');
  });

  test('defaults to claude parser for unknown agent', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/a.ts' },
    });
    const step = parseLine(line, 'unknown');
    expect(step).not.toBeNull();
    expect(step!.type).toBe('read');
  });
});
