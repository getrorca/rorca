/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  qualifyExecutorRecoveryMatrix,
  type ExecutorRecoveryMatrixInput,
} from '../../executor-recovery-compatibility';

const registryDigest = `sha256:${'9'.repeat(64)}`;
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'executor-recovery-matrix.v1.json');
function fixture(): ExecutorRecoveryMatrixInput {
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as ExecutorRecoveryMatrixInput;
}

describe('INT-003 executor and recovery compatibility matrix', () => {
  test('qualifies executor-agnostic identity, heterogeneous dispatch, fallback, replay, and cancellation', async () => {
    const receipt = await qualifyExecutorRecoveryMatrix(fixture(), registryDigest);

    assert.equal(receipt.registryReceipt.storyId, 'INT-001');
    assert.equal(receipt.registryReceipt.digest, registryDigest);
    assert.equal(receipt.run.id, '20260316000634');
    assert.deepEqual(receipt.spec.revision, receipt.revision);
    assert.deepEqual(receipt.matrixRows, ['omp-sequential', 'omp-wave-parallel']);
    assert.deepEqual(receipt.heterogeneousWave.map(({ executor }) => executor), ['omp', 'pi', 'claude']);
    assert.equal(new Set(receipt.heterogeneousWave.map(({ worktreeId }) => worktreeId)).size, 3);
    assert.deepEqual(receipt.piFallback, { qualification: 'MIG-003', originalExecutor: 'pi', retryExecutor: 'pi' });
    assert.match(receipt.providerFallbackEvidence.selectedModel, /openai\/alternate/);
    assert.equal(receipt.providerFallbackEvidence.originalReason, 'usage_limit');
    assert.deepEqual(receipt.recovery, [
      { executor: 'omp', eventCount: 2, terminalEventCount: 1, closed: true },
      { executor: 'pi', eventCount: 2, terminalEventCount: 1, closed: true },
    ]);
    assert.match(receipt.digest, /^sha256:[0-9a-f]{64}$/);
  });

  test('fails closed on executor identity, worktree, retry, evidence semantics, replay, and terminal drift', async () => {
    const mutations: Array<(input: ExecutorRecoveryMatrixInput) => void> = [
      (input) => { input.executions[0].identity.manifestHash = `sha256:${'8'.repeat(64)}`; },
      (input) => { input.heterogeneousWave[1].worktreeId = input.heterogeneousWave[0].worktreeId; },
      (input) => { input.piFallback.retryExecutor = 'omp'; },
      (input) => { input.providerFallback.gateSemanticsAfter = 'changed'; },
      (input) => { input.recovery[0].replaySequence = ['omp:start']; },
      (input) => { input.recovery[1].processClosed = false; },
    ];
    for (const mutate of mutations) {
      const input = fixture();
      mutate(input);
      await assert.rejects(qualifyExecutorRecoveryMatrix(input, registryDigest), /executor recovery compatibility/);
    }
  });
});
