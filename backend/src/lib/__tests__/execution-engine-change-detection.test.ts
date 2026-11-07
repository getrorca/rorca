/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

import {
  classifyStoryWorkingTreeChanges,
  getCommittedStoryChangesSince,
  getStoriesFromStart,
  isMeaningfulStoryChange,
  resolveClaudeCliModelId,
} from '../execution-engine';

describe('execution-engine meaningful change detection', () => {
  test('filters runtime and bookkeeping files out of story output', () => {
    const changes = classifyStoryWorkingTreeChanges([
      '.rorca/run-state.json',
      '.rorca/memory/runs/20260316000259.json',
      '.rorca-results.jsonl',
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
      '.rorca-results.jsonl',
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

  test('detects meaningful files from agent-created commits even when the worktree is clean', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-story-commit-detection-'));
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const before = true;\n');
      execSync('git add -A && git commit -m initial', { cwd: dir, stdio: 'pipe' });
      const baseHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();

      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const after = true;\n');
      fs.mkdirSync(path.join(dir, '.rorca'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.rorca', 'run-state.json'), '{}\n');
      execSync('git add -A && git commit -m "agent committed story output"', { cwd: dir, stdio: 'pipe' });

      const status = execSync('git status --porcelain=v1', { cwd: dir, encoding: 'utf8' }).trim();
      expect(status).toBe('');
      expect(getCommittedStoryChangesSince(dir, baseHead).meaningfulFiles).toEqual(['src/index.ts']);
      expect(getCommittedStoryChangesSince(dir, baseHead).metadataFiles).toEqual(['.rorca/run-state.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  test('normalizes dotted Claude model aliases to dash-delimited CLI model IDs', () => {
    expect(resolveClaudeCliModelId('claude-opus-4.8')).toBe('claude-opus-4-8');
    expect(resolveClaudeCliModelId('claude-opus-4.7')).toBe('claude-opus-4-7');
    expect(resolveClaudeCliModelId('claude-sonnet-4.8')).toBe('claude-sonnet-4-8');
    expect(resolveClaudeCliModelId('claude-haiku-4.5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(resolveClaudeCliModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(resolveClaudeCliModelId('openrouter/anthropic/claude-opus-4.6')).toBeNull();
  });
});
