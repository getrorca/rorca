/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';
import { collectStoryFileTouches } from './knowledge-graph';

export function extractSpecIdFromPath(specPath: string): string {
  if (!specPath) return '';
  const basename = specPath.split('/').pop() || '';
  return basename.replace(/\.json$/, '');
}

export async function resolveStoryMemoryProvenance(
  runId?: number | null,
  storyId?: string | null,
): Promise<{ sourceSpecId: string | null; relatedFiles: string[] }> {
  let sourceSpecId: string | null = null;

  if (runId != null) {
    const run = await queryOne<{ spec_path: string }>(
      'SELECT spec_path FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    sourceSpecId = extractSpecIdFromPath(run?.spec_path || '') || null;
  }

  const relatedFiles = runId != null && storyId
    ? await collectStoryFileTouches(runId, storyId)
    : [];

  return {
    sourceSpecId,
    relatedFiles: [...new Set(relatedFiles.filter(Boolean))],
  };
}
