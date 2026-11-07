// SPDX-License-Identifier: Apache-2.0

import { parseStreamJsonLine, parseOpenCodeLine, parseLine } from '../semantic-log-parser';

function claudeAssistant(...content: Array<Record<string, unknown>>): string {
  return JSON.stringify({ type: 'assistant', message: { content } });
}

function claudeTool(name: string, input: Record<string, unknown>): string {
  return claudeAssistant({ type: 'tool_use', name, input });
}

describe('parseStreamJsonLine', () => {
  test.each([
    ['Read', { file_path: '/src/index.ts' }, 'read', 'Read /src/index.ts', undefined],
    ['Edit', { file_path: '/src/app.tsx' }, 'edit', 'Edit /src/app.tsx', undefined],
    ['Write', { file_path: '/new-file.ts', content: 'hello' }, 'write', 'Write /new-file.ts', undefined],
    ['Bash', { command: 'npm test', description: 'Run tests' }, 'bash', 'Run tests', 'npm test'],
    ['Glob', { pattern: '**/*.ts', path: '/src' }, 'search', 'Glob **/*.ts', '/src'],
    ['Grep', { pattern: 'TODO', path: '/src' }, 'search', 'Grep TODO', '/src'],
    ['Task', { description: 'Explore codebase structure', prompt: 'Find all routes' }, 'plan', 'Task: Explore codebase structure', undefined],
    ['CustomTool', {}, 'unknown', 'CustomTool', undefined],
  ])('%s tool_use emits the canonical semantic step', (name, input, type, label, detail) => {
    const steps = parseStreamJsonLine(claudeTool(name, input));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type, label, toolName: name });
    expect(steps[0].detail).toBe(detail);
    expect(steps[0].ts).toBeTruthy();
  });

  test('one assistant event preserves every tool block in order', () => {
    const steps = parseStreamJsonLine(claudeAssistant(
      { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ));
    expect(steps.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: 'read', label: 'Read /a.ts' },
      { type: 'edit', label: 'Edit /a.ts' },
      { type: 'bash', label: 'npm test' },
    ]);
  });

  test('long assistant text emits reasoning while short text is ignored', () => {
    const long = parseStreamJsonLine(claudeAssistant({
      type: 'text',
      text: 'Let me analyze the codebase structure to understand the patterns used here.',
    }));
    expect(long).toHaveLength(1);
    expect(long[0]).toMatchObject({ type: 'plan', label: 'Reasoning' });
    expect(parseStreamJsonLine(claudeAssistant({ type: 'text', text: 'OK' }))).toEqual([]);
  });

  test('successful result extracts a commit identity', () => {
    const steps = parseStreamJsonLine(JSON.stringify({
      type: 'result', subtype: 'success', result: 'All changes committed. commit abc1234 feat: add dark mode toggle',
    }));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: 'commit', label: 'abc1234' });
  });

  test('successful result without a commit emits generic completion', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: 'result', subtype: 'success', result: 'Task completed successfully',
    }))[0]).toMatchObject({ type: 'commit', label: 'Run completed' });
  });

  test('error result is marked as an error semantic step', () => {
    expect(parseStreamJsonLine(JSON.stringify({
      type: 'result', subtype: 'error', error: 'Process timed out',
    }))[0]).toMatchObject({
      type: 'unknown', label: 'Error', detail: 'Process timed out', isError: true,
    });
  });

  test.each([
    ['malformed JSON', 'not json at all'],
    ['empty line', ''],
    ['whitespace', '   '],
    ['SSE comment', ': heartbeat'],
    ['unrecognized event', JSON.stringify({ type: 'content_block_delta', delta: { text: 'hi' } })],
    ['legacy standalone tool event', JSON.stringify({ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } })],
  ])('%s emits no semantic steps', (_label, line) => {
    expect(parseStreamJsonLine(line)).toEqual([]);
  });
});

describe('parseOpenCodeLine', () => {
  test.each([
    ['read', { file_path: '/src/main.ts' }, 'read', 'Read /src/main.ts', undefined],
    ['write', { path: '/new.ts' }, 'write', 'Write /new.ts', undefined],
    ['edit', { file_path: '/src/component.tsx' }, 'edit', 'Edit /src/component.tsx', undefined],
    ['bash', { command: 'npm run build', description: 'Build project' }, 'bash', 'Build project', 'npm run build'],
    ['glob', { pattern: '*.json' }, 'search', 'glob *.json', undefined],
    ['grep', { pattern: 'import', path: '/src' }, 'search', 'grep import', '/src'],
    ['sometool', {}, 'unknown', 'sometool', undefined],
  ])('%s tool_call emits the canonical semantic step', (tool, args, type, label, detail) => {
    const steps = parseOpenCodeLine(JSON.stringify({ type: 'tool_call', tool, args }));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type, label, toolName: tool });
    expect(steps[0].detail).toBe(detail);
  });

  test('uses the event timestamp verbatim', () => {
    const ts = '2026-01-15T08:30:00Z';
    const steps = parseOpenCodeLine(JSON.stringify({
      type: 'tool_call', tool: 'read', args: { path: '/a.ts' }, timestamp: ts,
    }));
    expect(steps[0].ts).toBe(ts);
  });

  test('assistant reasoning is emitted only above the minimum length', () => {
    const long = parseOpenCodeLine(JSON.stringify({
      type: 'assistant', content: 'I need to understand the authentication flow before making changes.',
    }));
    expect(long[0]).toMatchObject({ type: 'plan', label: 'Reasoning' });
    expect(parseOpenCodeLine(JSON.stringify({ type: 'assistant', content: 'OK' }))).toEqual([]);
  });

  test('completion and error events preserve terminal meaning', () => {
    const completion = parseOpenCodeLine(JSON.stringify({
      type: 'completion', content: 'Implementation complete. All tests passing.',
    }))[0];
    expect(completion).toMatchObject({ type: 'commit', label: 'Run completed' });
    expect(completion.isError).toBeFalsy();
    expect(parseOpenCodeLine(JSON.stringify({
      type: 'error', message: 'Rate limit exceeded',
    }))[0]).toMatchObject({
      type: 'unknown', label: 'Error', detail: 'Rate limit exceeded', isError: true,
    });
  });

  test('tool results retain bounded output and duration evidence', () => {
    const steps = parseOpenCodeLine(JSON.stringify({
      type: 'tool_result', tool: 'bash', content: 'tests passed', duration_ms: 42,
    }));
    expect(steps[0]).toMatchObject({
      type: 'bash', label: 'bash result', detail: 'tests passed', output: 'tests passed', durationMs: 42,
    });
  });

  test.each([
    ['malformed JSON', '{not valid'],
    ['empty line', ''],
    ['SSE comment', ': heartbeat'],
    ['unknown event', JSON.stringify({ type: 'unknown_event' })],
  ])('%s emits no semantic steps', (_label, line) => {
    expect(parseOpenCodeLine(line)).toEqual([]);
  });
});

describe('parseLine', () => {
  test('dispatches to the OpenCode parser', () => {
    expect(parseLine(JSON.stringify({
      type: 'tool_call', tool: 'bash', args: { command: 'ls' },
    }), 'opencode')[0]).toMatchObject({ type: 'bash', detail: 'ls' });
  });

  test('dispatches to the Claude parser', () => {
    expect(parseLine(claudeTool('Bash', { command: 'ls' }), 'claude')[0])
      .toMatchObject({ type: 'bash', detail: 'ls' });
  });

  test('defaults unknown agents to the Claude parser', () => {
    expect(parseLine(claudeTool('Read', { file_path: '/a.ts' }), 'unknown')[0])
      .toMatchObject({ type: 'read', label: 'Read /a.ts' });
  });
});
