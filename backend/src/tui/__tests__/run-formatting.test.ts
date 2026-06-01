/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  formatRawOutputLine,
  formatSemanticStepLine,
  formatWalLifecycleLine,
  isStructuredAgentLine,
} from '../runFormatting';

describe('runFormatting', () => {
  test('formats story_started with exact FORGE vocabulary', () => {
    const line = formatWalLifecycleLine(
      {
        event_type: 'story_started',
        spec_id: 'demo-spec',
        story_id: 'US-001',
        payload: JSON.stringify({ run_id: 42, story_id: 'US-001', story_title: 'Build CLI harness' }),
      },
      { run_id: 42, story_id: 'US-001', story_title: 'Build CLI harness' },
      new Date('2026-05-02T12:34:56Z'),
    );

    expect(line).toEqual({
      text: '[12:34:56] ▶ FORGE  US-001: Build CLI harness',
      color: 'yellow',
    });
  });

  test('formats pass, fail, and retry lifecycle lines', () => {
    const ts = new Date('2026-05-02T12:34:56Z');

    expect(formatWalLifecycleLine(
      { event_type: 'story_passed', spec_id: 'demo', story_id: 'US-001', payload: null },
      { story_id: 'US-001', elapsed_ms: 47_000 },
      ts,
    )).toEqual({
      text: '[12:34:56] ✓ PASS   US-001 (47s)',
      color: 'green',
    });

    expect(formatWalLifecycleLine(
      { event_type: 'story_failed', spec_id: 'demo', story_id: 'US-001', payload: null },
      { story_id: 'US-001', reason: 'max_retries' },
      ts,
    )).toEqual({
      text: '[12:34:56] ✗ FAIL   US-001 — max_retries',
      color: 'red',
    });

    expect(formatWalLifecycleLine(
      { event_type: 'story_retry', spec_id: 'demo', story_id: 'US-001', payload: null },
      { story_id: 'US-001', attempt: 2, max_attempts: 3 },
      ts,
    )).toEqual({
      text: '[12:34:56] ↻ RETRY  US-001 (attempt 2/3)',
      color: 'yellow',
    });
  });

  test('formats semantic steps into readable tool lines', () => {
    expect(formatSemanticStepLine({
      type: 'read',
      label: 'Read src/routes/billing.ts',
      ts: '2026-05-02T12:34:56Z',
    })).toEqual({
      text: '│ [read]  src/routes/billing.ts',
      color: 'gray',
      dimColor: true,
    });

    expect(formatSemanticStepLine({
      type: 'bash',
      label: 'npm test',
      detail: 'npm test -- run',
      ts: '2026-05-02T12:34:56Z',
    })).toEqual({
      text: '│ [bash]  npm test -- run',
      color: 'gray',
      dimColor: true,
    });
  });

  test('recognizes structured agent output and keeps raw pi lines dimmed', () => {
    expect(isStructuredAgentLine('{"type":"assistant","message":{"content":[]}}')).toBe(true);
    expect(isStructuredAgentLine('plain stdout line')).toBe(false);
    expect(formatRawOutputLine('hello from pi')).toEqual({
      text: '│ hello from pi',
      color: 'gray',
      dimColor: true,
    });
  });
});
