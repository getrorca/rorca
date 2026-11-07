/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { projectOmpOrchestrationEvent } from '../omp-orchestration-events';
import { resolveExecutionOptions } from '../resolve-execution-options';
import type { ManagedEngineRequest } from '../rorca-managed-executor';

interface QualificationScenario {
  receiptId: string;
  mode: 'sequential' | 'wave-parallel';
  selectedExecutor: 'omp' | 'pi';
  selectionSource?: string;
  invocationCount?: number;
  contractSha256: string;
  contracts: unknown;
}

interface QualificationFixture {
  schemaVersion: string;
  storyId: string;
  consumers: string[];
  executorAgnosticContract: unknown;
  scenarios: QualificationScenario[];
  durableFailureReceipt: {
    provider: 'omp'; requestHash: string; processIdentity: string; sourceOrdinal: number;
    sourceEventId: string; rpcType: string; mappedKind: string; runId: string;
    storyId: string; attemptId: string; generation: number; specRevisionHash: string;
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

const fixture = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mig-005-executor-parity.v1.json'), 'utf8',
)) as QualificationFixture;

describe('MIG-005 OMP executor parity and rollback qualification', () => {
  test('records byte-identical executor-agnostic contracts for sequential, wave-parallel, and Pi rollback receipts', () => {
    assert.equal(fixture.schemaVersion, 'rorca.executor-parity-qualification.v1');
    assert.deepEqual(fixture.consumers, ['AAV-007', 'AAV-010']);
    assert.equal(fixture.scenarios.filter(({ mode }) => mode === 'sequential').length, 2);
    assert.equal(fixture.scenarios.filter(({ mode }) => mode === 'wave-parallel').length, 2);
    assert.deepEqual(Object.keys(fixture.executorAgnosticContract as object).sort(), [
      'cancellation', 'retryLineage', 'runManifest', 'storyResult', 'walReleaseIntentIdentity',
    ]);
    assert.deepEqual(fixture.scenarios.map(({ receiptId }) => receiptId), [
      'mig-005:omp:sequential',
      'mig-005:omp:wave-parallel:story-1',
      'mig-005:omp:wave-parallel:story-2',
      'mig-005:pi:explicit-rollback',
    ]);

    const baselineBytes = stableJson(fixture.executorAgnosticContract);
    const baselineDigest = digest(fixture.executorAgnosticContract);
    for (const receipt of fixture.scenarios) {
      assert.equal(stableJson(receipt.contracts), baselineBytes, `${receipt.receiptId} contract drifted`);
      assert.equal(receipt.contractSha256, baselineDigest, `${receipt.receiptId} digest drifted`);
    }
  });

  test('selects the explicit Pi rollback once even while OMP is qualified', () => {
    const rollback = fixture.scenarios.find(({ receiptId }) => receiptId === 'mig-005:pi:explicit-rollback');
    assert.ok(rollback);
    let dispatches = 0;
    const resolved = resolveExecutionOptions({
      requestAgentOverride: 'pi',
      activeAgentFallback: 'omp',
      activeModelFallback: null,
      ompSandboxQualified: true,
      resolvePiModel: false,
    });
    if (resolved.resolvedAgentType === 'pi') dispatches += 1;
    assert.equal(resolved.agentSource, rollback.selectionSource);
    assert.equal(resolved.resolvedAgentType, rollback.selectedExecutor);
    assert.equal(dispatches, rollback.invocationCount);
  });

  test('projects a subagent failure into replay-stable durable executor identity without deciding a gate', () => {
    const receipt = fixture.durableFailureReceipt;
    const request = {
      requestHash: receipt.requestHash,
      workspaceId: 'workspace-mig-005', runId: Number(receipt.runId),
      specId: 'spec:mig-005', specVersion: 9, specHash: receipt.specRevisionHash,
      storyId: receipt.storyId, storyVersion: 5,
      storyHash: `sha256:${'c'.repeat(64)}`,
      attemptId: receipt.attemptId, generation: receipt.generation,
    } as ManagedEngineRequest;
    const input = {
      request, processIdentity: receipt.processIdentity, sourceOrdinal: receipt.sourceOrdinal,
      event: { type: receipt.rpcType, id: receipt.sourceEventId, agentId: 'subagent:mig-005' },
      observedAt: '2026-03-16T00:06:34.000Z',
    };
    const failure = projectOmpOrchestrationEvent(input, receipt.sourceOrdinal);
    const replay = projectOmpOrchestrationEvent(input, receipt.sourceOrdinal);

    assert.equal(failure.kind, receipt.mappedKind);
    assert.equal(failure.omp.provider, receipt.provider);
    assert.equal(failure.omp.sourceEventId, receipt.sourceEventId);
    assert.equal(failure.run.id, receipt.runId);
    assert.equal(failure.story.id, receipt.storyId);
    assert.equal(failure.attempt.id, receipt.attemptId);
    assert.equal(failure.attempt.revision?.value, String(receipt.generation));
    assert.equal(failure.process.id, receipt.processIdentity);
    assert.equal(failure.specRevisionHash, receipt.specRevisionHash);
    assert.deepEqual(replay, failure);
    assert.match(failure.eventId, /^sha256:[0-9a-f]{64}$/);
    assert.match(failure.idempotencyKey, /^sha256:[0-9a-f]{64}$/);
    assert.equal('gateDecision' in failure, false);
    assert.equal('lifecycleStatus' in failure, false);
  });
});
