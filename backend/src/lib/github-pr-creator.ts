/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Legacy compatibility surface.
 *
 * PR creation is a release effect and is implemented only by
 * release-authority.ts. Keeping this fail-closed export avoids silently
 * reintroducing an unfenced provider actuator through an old import.
 */
export interface AutoPrOptions {
  runId: number;
  workspaceId: number | string;
  branchName: string;
  workspacePath: string;
  force?: boolean;
}

export async function createOrUpdateAutoPr(_opts: AutoPrOptions): Promise<void> {
  throw new Error('PR creation requires the host-owned exact-SHA release seam');
}
