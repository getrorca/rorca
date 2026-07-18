/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PipelineRetryJobPayload, PipelineRunJobPayload } from '../pg-boss-schemas';
import { deriveRunSpecPath, prepareRunSpecSnapshot } from '../run-spec-snapshot';

describe('prepareRunSpecSnapshot', () => {
  test('copies worktree runs to an isolated mutable artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-run-spec-'));
    try {
      const source = path.join(root, 'approved.json');
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree);
      fs.writeFileSync(source, JSON.stringify({ userStories: [{ id: 'US-1', passes: false }] }));

      const snapshot = prepareRunSpecSnapshot({ runId: 42, sourceSpecPath: source, worktreePath: worktree });
      expect(snapshot).toBe(path.join(worktree, '.rorca', 'run-specs', 'run-42.json'));
      expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toEqual({ userStories: [{ id: 'US-1', passes: false }] });

      fs.writeFileSync(snapshot, JSON.stringify({ userStories: [{ id: 'US-1', passes: true }] }));
      expect(JSON.parse(fs.readFileSync(source, 'utf8'))).toEqual({ userStories: [{ id: 'US-1', passes: false }] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps non-worktree non-retry runs on the canonical path', () => {
    expect(deriveRunSpecPath({
      runId: 7,
      sourceSpecPath: '/tmp/spec.json',
      workspacePath: '/tmp',
      worktreePath: null,
    })).toBe('/tmp/spec.json');
  });

  test('queue payloads require the exact host-selected run snapshot', () => {
    expect(() => PipelineRunJobPayload.parse({
      runId: 42,
      specPath: '/workspace/spec.json',
      workspacePath: '/workspace',
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    })).toThrow();
    expect(() => PipelineRetryJobPayload.parse({
      runId: 43,
      originalRunId: 42,
      storyIds: ['US-1'],
      scopeHash: `sha256:${'a'.repeat(64)}`,
      previewHash: `sha256:${'b'.repeat(64)}`,
      approvedPreview: {},
      generatedPlanHash: `sha256:${'c'.repeat(64)}`,
      workspacePath: '/workspace',
      specPath: '/workspace/spec.json',
      retrySpecPath: '/workspace/.rorca/run-specs/run-43.json',
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      terminalMode: 'ansi-html',
      sequenceOffset: 0,
      envOverrides: {},
    })).toThrow();
  });

  test.each([
    ['worktree sequential', 8, '/worktree', false, '/worktree'],
    ['parallel wave worktree', 9, '/parallel-worktree', false, '/parallel-worktree'],
    ['PTY worktree', 10, '/pty-worktree', false, '/pty-worktree'],
    ['native PTY worktree', 11, '/native-pty-worktree', false, '/native-pty-worktree'],
    ['worktree retry', 12, '/retry-worktree', true, '/retry-worktree'],
    ['direct retry', 13, null, true, '/workspace'],
  ])('uses one deterministic snapshot contract for %s', (_name, runId, worktreePath, retry, root) => {
    expect(deriveRunSpecPath({
      runId,
      sourceSpecPath: '/workspace/forge/specs/approved/spec.json',
      workspacePath: '/workspace',
      worktreePath,
      retry,
    })).toBe(path.join(root, '.rorca', 'run-specs', `run-${runId}.json`));
  });
});
