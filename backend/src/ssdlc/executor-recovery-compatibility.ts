/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { EntityRefV1Schema, RevisionRefV1Schema, type EntityRefV1, type RevisionRefV1 } from '../lib/mission-contracts';
import { preserveDeclaredExecutorAcrossRetry } from '../lib/omp-executor-selection';
import {
  runOmpProviderFallback,
  type ProviderFallbackEvidence,
  type ProviderFallbackPolicy,
} from '../lib/provider-fallback-policy';

export const EXECUTOR_RECOVERY_MATRIX_VERSION = 'rorca.executor-recovery-matrix.v1' as const;
type MatrixExecutor = 'omp' | 'pi' | 'claude';
type ContractIdentity = { manifestHash: string; resultIdentity: string; walReleaseIntentHash: string };

export interface ExecutorRecoveryMatrixInput {
  schemaVersion: typeof EXECUTOR_RECOVERY_MATRIX_VERSION;
  run: EntityRefV1;
  spec: EntityRefV1;
  revision: RevisionRefV1;
  executorAgnosticIdentity: ContractIdentity;
  executions: ReadonlyArray<{
    scenario: 'omp-sequential' | 'omp-wave-parallel'; executor: 'omp'; identity: ContractIdentity;
  }>;
  heterogeneousWave: ReadonlyArray<{
    storyId: string; declaredExecutor: MatrixExecutor; dispatchedExecutor: MatrixExecutor;
    worktreeId: string; merged: boolean; mergePolicy: string;
  }>;
  piFallback: {
    reliabilityQualification: 'MIG-003'; qualificationStatus: 'passed';
    declaredExecutor: 'pi'; retryExecutor: MatrixExecutor; completed: boolean;
  };
  providerFallback: {
    policy: ProviderFallbackPolicy; currentModel: string; selectedAlternate: string;
    originalReason: 'usage_limit' | 'connection_error' | 'terminalized_authority'; originalMessage: string;
    controlSemanticsBefore: string; controlSemanticsAfter: string;
    gateSemanticsBefore: string; gateSemanticsAfter: string;
  };
  recovery: ReadonlyArray<{
    executor: 'omp' | 'pi'; eventSequence: readonly string[]; replaySequence: readonly string[];
    terminalEventId: string; processClosed: boolean; worktreeClosed: boolean;
  }>;
}

export interface ExecutorRecoveryMatrixReceipt {
  schemaVersion: typeof EXECUTOR_RECOVERY_MATRIX_VERSION;
  storyId: 'INT-003'; registryReceipt: { storyId: 'INT-001'; digest: string };
  run: EntityRefV1; spec: EntityRefV1; revision: RevisionRefV1;
  matrixRows: readonly string[]; executorAgnosticIdentity: ContractIdentity;
  heterogeneousWave: readonly { storyId: string; executor: MatrixExecutor; worktreeId: string }[];
  piFallback: { qualification: 'MIG-003'; originalExecutor: 'pi'; retryExecutor: 'pi' };
  providerFallbackEvidence: ProviderFallbackEvidence;
  recovery: readonly { executor: 'omp' | 'pi'; eventCount: number; terminalEventCount: 1; closed: true }[];
  digest: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function fail(message: string): never {
  throw new TypeError(`executor recovery compatibility: ${message}`);
}

/** Database-free release qualification. It consumes production identity, executor-selection,
 * and provider-fallback contracts and grants no execution, gate, merge, or release authority. */
export async function qualifyExecutorRecoveryMatrix(
  input: ExecutorRecoveryMatrixInput,
  registryDigest: string,
): Promise<ExecutorRecoveryMatrixReceipt> {
  if (input.schemaVersion !== EXECUTOR_RECOVERY_MATRIX_VERSION) fail('unsupported matrix version');
  const run = EntityRefV1Schema.parse(input.run);
  const spec = EntityRefV1Schema.parse(input.spec);
  const revision = RevisionRefV1Schema.parse(input.revision);
  if (run.kind !== 'run' || spec.kind !== 'spec' || run.workspaceId !== spec.workspaceId
      || !spec.revision || !same(spec.revision, revision)) fail('run/spec exact revision identity drifted');
  if (!/^sha256:[0-9a-f]{64}$/.test(registryDigest)) fail('INT-001 registry digest is invalid');

  const required = new Set(['omp-sequential', 'omp-wave-parallel']);
  for (const execution of input.executions) {
    required.delete(execution.scenario);
    if (execution.executor !== 'omp' || !same(execution.identity, input.executorAgnosticIdentity)) {
      fail(`${execution.scenario} manifest/result/WAL identity drifted`);
    }
  }
  if (required.size) fail(`missing matrix rows: ${[...required].join(', ')}`);

  const storyIds = new Set<string>();
  const worktrees = new Set<string>();
  const executors = new Set<MatrixExecutor>();
  for (const story of input.heterogeneousWave) {
    if (!story.storyId || storyIds.has(story.storyId) || !story.worktreeId || worktrees.has(story.worktreeId)) {
      fail('heterogeneous wave story/worktree isolation drifted');
    }
    if (story.declaredExecutor !== story.dispatchedExecutor || !story.merged || story.mergePolicy !== 'normal-wave') {
      fail(`heterogeneous wave policy drifted for ${story.storyId}`);
    }
    storyIds.add(story.storyId); worktrees.add(story.worktreeId); executors.add(story.declaredExecutor);
  }
  if (!executors.has('omp') || (!executors.has('pi') && !executors.has('claude'))) {
    fail('heterogeneous wave lacks an explicit Pi or Claude story');
  }

  const pi = input.piFallback;
  if (pi.reliabilityQualification !== 'MIG-003' || pi.qualificationStatus !== 'passed' || !pi.completed
      || preserveDeclaredExecutorAcrossRetry(pi.declaredExecutor) !== pi.retryExecutor) {
    fail('explicit Pi fallback reliability or retry executor drifted');
  }

  if (input.providerFallback.controlSemanticsBefore !== input.providerFallback.controlSemanticsAfter
      || input.providerFallback.gateSemanticsBefore !== input.providerFallback.gateSemanticsAfter) {
    fail('provider fallback changed control or gate semantics');
  }
  const evidence: ProviderFallbackEvidence[] = [];
  const selected = await runOmpProviderFallback({
    policy: input.providerFallback.policy,
    currentModel: input.providerFallback.currentModel,
    originalReason: input.providerFallback.originalReason,
    originalMessage: input.providerFallback.originalMessage,
    attempt: { runId: run.id, storyId: 'INT-003', attemptId: `attempt:${run.id}:1`, generation: 1 },
    evidence: { appendCanonicalStoryAndLifecycleEvidence: async (item) => { evidence.push(item); } },
    runWithModel: async (model) => model,
    classifyFailure: () => null,
    now: () => '2026-03-16T00:06:34.000Z',
  });
  if (selected !== input.providerFallback.selectedAlternate || evidence.length !== 1
      || evidence[0].selectedModel !== input.providerFallback.selectedAlternate
      || evidence[0].originalReason !== input.providerFallback.originalReason) {
    fail('OMP alternate or original-reason evidence drifted');
  }

  const recovery = input.recovery.map((row) => {
    if (!same(row.eventSequence, row.replaySequence)) fail(`${row.executor} restart/replay is not idempotent`);
    const unique = new Set(row.replaySequence);
    if (unique.size !== row.replaySequence.length || !row.processClosed || !row.worktreeClosed
        || row.replaySequence.filter((event) => event === row.terminalEventId).length !== 1) {
      fail(`${row.executor} cancellation closure or terminal event drifted`);
    }
    return { executor: row.executor, eventCount: row.eventSequence.length, terminalEventCount: 1 as const, closed: true as const };
  });
  if (!new Set(recovery.map(({ executor }) => executor)).has('omp')
      || !new Set(recovery.map(({ executor }) => executor)).has('pi')) fail('recovery must cover OMP and Pi');

  const body = {
    schemaVersion: EXECUTOR_RECOVERY_MATRIX_VERSION, storyId: 'INT-003' as const,
    registryReceipt: { storyId: 'INT-001' as const, digest: registryDigest }, run, spec, revision,
    matrixRows: input.executions.map(({ scenario }) => scenario),
    executorAgnosticIdentity: input.executorAgnosticIdentity,
    heterogeneousWave: input.heterogeneousWave.map(({ storyId, declaredExecutor: executor, worktreeId }) => ({ storyId, executor, worktreeId })),
    piFallback: { qualification: 'MIG-003' as const, originalExecutor: 'pi' as const, retryExecutor: 'pi' as const },
    providerFallbackEvidence: evidence[0], recovery,
  };
  return { ...body, digest: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}` };
}
