/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { GitReinsJudgeResult } from './gitreins-runner';

/** Pure retry decision shared by the canonical execution engine and tests. */
export function decideGitReinsGateAction(
  result: Pick<GitReinsJudgeResult, 'shouldBlock'>,
  completedAttempts: number,
  maxAttempts: number,
): 'proceed' | 'retry' | 'fail' {
  if (!result.shouldBlock) return 'proceed';
  return completedAttempts < maxAttempts ? 'retry' : 'fail';
}
