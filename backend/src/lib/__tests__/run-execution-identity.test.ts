/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assertFrozenRunExecutionIdentity } from '../run-git-authority';

let root: string;
let workspace: string;
let worktree: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-frozen-execution-'));
  workspace = path.join(root, 'workspace');
  worktree = path.join(root, 'worktree');
  fs.mkdirSync(workspace);
  fs.mkdirSync(worktree);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('accepts exact DB-frozen workspace and worktree realpaths', () => {
  expect(assertFrozenRunExecutionIdentity({
    payloadWorkspacePath: workspace,
    payloadWorktreePath: worktree,
    frozenWorkspacePath: fs.realpathSync(workspace),
    frozenWorktreePath: fs.realpathSync(worktree),
  })).toEqual({ workspacePath: fs.realpathSync(workspace), worktreePath: fs.realpathSync(worktree) });
});

test.each(['workspace', 'worktree'])('%s payload mismatch fails before spawn/finalization', (field) => {
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  expect(() => assertFrozenRunExecutionIdentity({
    payloadWorkspacePath: field === 'workspace' ? other : workspace,
    payloadWorktreePath: field === 'worktree' ? other : worktree,
    frozenWorkspacePath: fs.realpathSync(workspace),
    frozenWorktreePath: fs.realpathSync(worktree),
  })).toThrow(/differs from DB-frozen/);
});
