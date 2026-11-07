/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createAutonomousGitState } from '../../autonomous-git-state';

const [runIdValue, worktree, branchName] = process.argv.slice(2);
const runId = Number(runIdValue);
const root = createAutonomousGitState(runId, worktree, branchName);
process.stdout.write(`${JSON.stringify({ root, pid: process.pid })}\n`);
setInterval(() => undefined, 60_000);
