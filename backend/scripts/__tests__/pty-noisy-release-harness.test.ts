/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runNoisyRecoveryHarness } from '../lib/pty-noisy-release-harness';

const FAST_OPTIONS = {
  bytesPerGeneration: 512 * 1024,
  checkpointIntervalBytes: 128 * 1024,
  archiveSegmentBytes: 128 * 1024,
  enforceReleaseScale: false,
} as const;

test('deterministic noisy harness covers the complete recovery and negative-drill matrix', async () => {
  const first = await runNoisyRecoveryHarness(FAST_OPTIONS);
  const second = await runNoisyRecoveryHarness(FAST_OPTIONS);

  assert.equal(first.generationCount, 4);
  assert.equal(first.distinctStoryCount, 3);
  assert.ok(Object.values(first.releaseMatrix).every(Boolean));
  assert.equal(first.trueDroppedBytes, 0);
  assert.equal(first.committedFixtureBytes, 0);
  assert.ok(first.generations.every((generation) => generation.checkpoints >= 3));
  assert.ok(first.generations.every((generation) => (
    generation.compactionEquivalenceChecks === generation.reconnectEquivalenceChecks
    && generation.reconnectEquivalenceChecks === generation.checkpoints
  )));
  assert.deepEqual(
    first.generations.map(({ storyId, attempt, observedBytes, archiveSha256, finalMarker }) => ({
      storyId, attempt, observedBytes, archiveSha256, finalMarker,
    })),
    second.generations.map(({ storyId, attempt, observedBytes, archiveSha256, finalMarker }) => ({
      storyId, attempt, observedBytes, archiveSha256, finalMarker,
    })),
  );
});

test('harness source stays bounded instead of committing generated output or archives', async () => {
  const harnessPath = path.resolve(__dirname, '..', 'lib', 'pty-noisy-release-harness.ts');
  const metadata = await stat(harnessPath);
  assert.ok(metadata.size < 32 * 1024, `harness source grew to ${metadata.size} bytes`);
});
