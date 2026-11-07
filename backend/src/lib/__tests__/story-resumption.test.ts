/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRetainedStoryResumption } from '../story-resumption';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, subject: string): string {
  fs.writeFileSync(path.join(cwd, file), `${subject}\n`);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-m', subject]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

describe('retained explicit-story resumption', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-story-resumption-'));
    git(cwd, ['init']);
    git(cwd, ['config', 'user.email', 'test@rorca.local']);
    git(cwd, ['config', 'user.name', 'Rorca Test']);
    commit(cwd, 'baseline.txt', 'chore: baseline');
  });

  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  test('uses only the contiguous exact-story suffix and its parent baseline', () => {
    const baseline = git(cwd, ['rev-parse', 'HEAD']);
    const first = commit(cwd, 'router.ts', 'feat(BBM-010): add route selection');
    const second = commit(cwd, 'router.test.ts', 'fix(BBM-010): preserve route reasons');

    expect(resolveRetainedStoryResumption(cwd, 'BBM-010')).toEqual({
      startHead: baseline,
      commitShas: [first, second],
    });
  });

  test('does not resume a preceding story after a different story reaches HEAD', () => {
    commit(cwd, 'router.ts', 'feat(BBM-010): add route selection');
    const bbm10Head = git(cwd, ['rev-parse', 'HEAD']);
    const bbm18Head = commit(cwd, 'worker.ts', 'feat(BBM-018): add worker boundary');

    expect(resolveRetainedStoryResumption(cwd, 'BBM-010')).toBeNull();
    expect(resolveRetainedStoryResumption(cwd, 'BBM-018')).toEqual({
      startHead: bbm10Head,
      commitShas: [bbm18Head],
    });
  });

  test('rejects invalid story identifiers and unmarked commits', () => {
    commit(cwd, 'router.ts', 'feat: unmarked work');

    expect(resolveRetainedStoryResumption(cwd, '../../BBM-010')).toBeNull();
    expect(resolveRetainedStoryResumption(cwd, 'BBM-010')).toBeNull();
  });
});
