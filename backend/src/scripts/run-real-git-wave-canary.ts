/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { runGitWaveCanary } from '../lib/wave-git-canary';

export async function main(): Promise<void> {
  const signingKey = process.env.RORCA_WAVE_CANARY_SIGNING_KEY;
  const issuer = process.env.RORCA_WAVE_CANARY_ISSUER;
  const workspaceId = process.env.RORCA_WAVE_CANARY_WORKSPACE_ID;
  if (!signingKey || !issuer || !workspaceId) {
    throw new Error('RORCA_WAVE_CANARY_SIGNING_KEY, RORCA_WAVE_CANARY_ISSUER, and RORCA_WAVE_CANARY_WORKSPACE_ID are required');
  }
  const repositoryRoot = process.cwd();
  const result = await runGitWaveCanary({ repositoryRoot, signingKey, issuer, workspaceId });
  const { measurement } = result.evidence;
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    workspaceId: measurement.workspaceId,
    sourceRevision: measurement.sourceRevision,
    sourceTree: measurement.sourceTree,
    sourceMaterialRevision: measurement.sourceMaterialRevision,
    sourceMaterialTree: measurement.sourceMaterialTree,
    storyCount: measurement.storyCount,
    parallelism: measurement.effectiveParallelism,
    mergeCommitCount: measurement.mergeCommitCount,
    idempotentReplayCount: measurement.idempotentReplayCount,
    cleanup: {
      cleanTarget: measurement.cleanTarget,
      remainingWorktreeCount: measurement.remainingWorktreeCount,
      remainingStoryRefCount: measurement.remainingStoryRefCount,
      temporaryRootRemoved: measurement.temporaryRootRemoved,
    },
    evidencePath: result.evidencePath,
    evidenceDigest: result.evidenceDigest,
    evidenceFileDigest: result.evidenceFileDigest,
    receiptPath: result.receiptPath,
    receiptFileDigest: result.receiptFileDigest,
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`[wave-git-canary] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
