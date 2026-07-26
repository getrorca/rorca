/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Legacy compatibility surface. Draft creation/finalization and progress
 * mutation are terminal provider effects owned exclusively by
 * release-authority.ts. These exports fail closed so an old caller cannot
 * recover ambient authority.
 */
export async function createDraftPr(_opts: {
  runId: number;
  workspaceId: string | number;
  branchName: string;
  workspacePath: string;
  specTitle: string;
  totalStories: number;
  force?: boolean;
}): Promise<void> {
  throw new Error('Draft PR creation requires the host-owned exact-SHA release seam');
}

export function updateDraftPrProgress(_runId: number, _workspaceId: string | number): void {
  // Intentionally inert: pre-terminal story progress has no provider authority.
}

export async function finalizeDraftPr(_opts: {
  runId: number;
  workspaceId: string | number;
  branchName: string;
  workspacePath: string;
  status: string;
}): Promise<void> {
  throw new Error('PR finalization requires the host-owned exact-SHA release seam');
}
