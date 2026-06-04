/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  classifyStoryWorkingTreeChanges,
  getStoriesFromStart,
  isMeaningfulStoryChange,
  resolveClaudeCliModelId,
} from '../execution-engine';

describe('execution-engine meaningful change detection', () => {
  test('filters runtime and bookkeeping files out of story output', () => {
    const changes = classifyStoryWorkingTreeChanges([
      '.rorca/run-state.json',
      '.rorca/memory/runs/20260316000259.json',
      'progress.txt',
      'forge/specs/approved/rorca-pi-native-execution-runtime-and-embedded-tui.json',
      'forge/specs/logs/US-019_2026-05-04T0731.log',
      'forge/logs/run-20260316000259.log',
      'MEMORY.md',
      'backend/src/lib/execution-engine.ts',
      'src/components/RunView.tsx',
    ]);

    expect(changes.metadataFiles).toEqual([
      '.rorca/run-state.json',
      '.rorca/memory/runs/20260316000259.json',
      'progress.txt',
      'forge/specs/approved/rorca-pi-native-execution-runtime-and-embedded-tui.json',
      'forge/specs/logs/US-019_2026-05-04T0731.log',
      'forge/logs/run-20260316000259.log',
      'MEMORY.md',
    ]);

    expect(changes.meaningfulFiles).toEqual([
      'backend/src/lib/execution-engine.ts',
      'src/components/RunView.tsx',
    ]);
  });

  test('treats project-local pi extension source as meaningful code', () => {
    expect(isMeaningfulStoryChange('.pi/agent/extensions/rorca/lib/story-executor.ts')).toBe(true);
    expect(isMeaningfulStoryChange('.pi/extensions/rorca-mcp/index.ts')).toBe(true);
  });

  test('restricts sequential continuation to the requested start story and following stories', () => {
    const stories = [
      { id: 'CTM-001', title: 'One', description: 'One' },
      { id: 'CTM-002', title: 'Two', description: 'Two' },
      { id: 'CTM-003', title: 'Three', description: 'Three' },
      { id: 'CTM-004', title: 'Four', description: 'Four' },
    ];

    expect(getStoriesFromStart(stories, 'CTM-003').map((story) => story.id)).toEqual(['CTM-003', 'CTM-004']);
    expect(getStoriesFromStart(stories, 'CTM-999').map((story) => story.id)).toEqual(['CTM-001', 'CTM-002', 'CTM-003', 'CTM-004']);
    expect(getStoriesFromStart(stories).map((story) => story.id)).toEqual(['CTM-001', 'CTM-002', 'CTM-003', 'CTM-004']);
  });

  test('normalizes unsupported dotted Claude Opus model aliases to the supported CLI model', () => {
    expect(resolveClaudeCliModelId('claude-opus-4.8')).toBe('claude-opus-4-6');
    expect(resolveClaudeCliModelId('claude-opus-4-8')).toBe('claude-opus-4-6');
    expect(resolveClaudeCliModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveClaudeCliModelId('openrouter/anthropic/claude-opus-4.6')).toBeNull();
  });
});
