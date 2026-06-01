/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  classifyStoryWorkingTreeChanges,
  isMeaningfulStoryChange,
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
});
