/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import controlsArtifact from '../catalog/controls.json';
import { declareHermesAuthority } from '../../lib/hermes-authority';
import { projectOmpOrchestrationEvent } from '../../lib/omp-orchestration-events';
import type { ManagedEngineRequest } from '../../lib/rorca-managed-executor';
import { compileAssuranceProfile, getCanonicalControl } from '../assurance-profile';
import { evaluateGate } from '../evaluation/gate-evaluator';
import { parseControl } from '../schema/control-schema';
import { createHermesAssuranceAdapter } from '../hermes-assurance-adapter';
import { qualifyAavOmpParity } from '../aav-omp-parity-qualification';

const NOW = new Date('2026-03-16T00:06:34.000Z');
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const SPEC_HASH = hash('b');
const control = parseControl(controlsArtifact.find((item) => item.controlId === 'CTRL-REQUIREMENTS-TRACEABILITY'));
const canonical = getCanonicalControl(control.controlId)!;

function profile() {
  return compileAssuranceProfile({
    profileId: 'profile:omp-parity:17',
    specRef: {
      schemaVersion: 'rorca.entity-ref.v1', workspaceId: 'workspace-1', kind: 'spec', id: 'payment-api',
      label: 'Payment API', revision: { kind: 'spec_version', value: '17' },
    },
    specRevision: { kind: 'spec_version', value: '17' },
    repositoryContextHash: hash('a'),
    riskProfile: { level: 'high', tags: ['payments'], rationale: 'Payment integrity is material.' },
    controlInstances: [{
      controlId: canonical.controlId,
      mechanismBindings: [{ mechanismId: 'mechanism:omp-test', kind: 'command', locator: 'npm run test:payments' }],
      criteria: [{ criterionId: 'exit-zero', description: 'Mechanism exits successfully.', evaluator: 'exit-code', expected: '0' }],
      evidenceRequirements: structuredClone(canonical.requiredEvidence),
    }],
  });
}

const request = {
  requestHash: hash('d'), workspaceId: 'workspace-1', runId: 71, specId: 'payment-api', specVersion: 17,
  specHash: SPEC_HASH, storyId: 'AAV-010', storyVersion: 1, attemptId: 'attempt-1', generation: 1,
} as ManagedEngineRequest;

function event(sequence: number, value: Record<string, unknown>) {
  return projectOmpOrchestrationEvent({
    request, processIdentity: 'omp-process-71', sourceOrdinal: sequence, event: value,
    observedAt: new Date(NOW.getTime() + sequence * 100).toISOString(),
  }, sequence);
}

const orchestration = [
  event(1, { type: 'agent_start', eventId: 'root-start', agentId: 'root', name: 'Hermes' }),
  event(2, { type: 'agent_start', eventId: 'worker-start', agentId: 'worker', parentAgentId: 'root', name: 'Verifier' }),
  event(3, { type: 'tool_execution_start', eventId: 'worker-task', agentId: 'worker', parentAgentId: 'root', taskId: 'validate' }),
  event(4, { type: 'agent_settled', eventId: 'worker-done', agentId: 'worker', parentAgentId: 'root', evidence: ['receipt.json'] }),
  event(5, { type: 'agent_settled', eventId: 'root-done', agentId: 'root' }),
];

function compilation() {
  return {
    phaseGroups: [{
      phase: 'requirements' as const,
      controlIds: [control.controlId], families: {}, missingFamilies: [],
      evidenceRequirements: control.requiredEvidence.map((requirement) => ({
        ...structuredClone(requirement), controlId: control.controlId, sourceReferences: structuredClone(control.sourceReferences),
      })),
    }],
  };
}

async function execute(blocked: boolean) {
  const adapter = createHermesAssuranceAdapter({
    async runMechanism() {
      if (blocked) throw new Error('sandbox provider unavailable');
      return { summary: 'OMP validation passed', exitCode: 0, rawReference: 'terminal://run/71' };
    },
    async persistEvidence() {},
    async requestStageReevaluation() {},
  }, { now: () => NOW });
  return adapter.execute({
    profile: profile(),
    identity: { specHash: SPEC_HASH, commitSha: COMMIT, releaseIdentity: {} },
    scope: { workspaceId: 'workspace-1', specSlug: 'payment-api', runId: 71, storyId: 'AAV-010', phaseId: 'requirements', gateId: 'plan' },
    actor: 'hermes:assurance-service',
    auditAuthority: declareHermesAuthority('subscription', 'service-audit'),
    persistenceAuthority: declareHermesAuthority('persist', 'operator-dispatch'),
    reevaluationAuthority: declareHermesAuthority('dispatch', 'operator-dispatch'),
  });
}

function gate(evidence: Awaited<ReturnType<typeof execute>>['evidence']) {
  return evaluateGate({
    stage: 'requirements', compilation: compilation(), controls: [control], evidence,
    subject: {
      specHash: SPEC_HASH, commitSha: COMMIT, workspaceId: 'workspace-1', specSlug: 'payment-api', runId: 71,
      mutatedAt: new Date(NOW.getTime() - 1_000),
    },
    evaluatedAt: new Date(NOW.getTime() + 10_000),
  });
}

function qualify(evidence: Awaited<ReturnType<typeof execute>>['evidence'], events = orchestration) {
  return qualifyAavOmpParity({
    profile: profile(), persistedSpec: { id: 'payment-api', revision: { kind: 'spec_version', value: '17' }, specHash: SPEC_HASH },
    commitSha: COMMIT, orchestrationEvents: events, evidence, gate: gate(evidence), terminalMode: 'native-pty',
  });
}

test('qualifies exact persisted assurance revision through OMP and acceptable US-005 evidence', async () => {
  const execution = await execute(false);
  const receipt = qualify(execution.evidence);

  assert.equal(receipt.stageStatus, 'pass');
  assert.equal(receipt.specRevision, 'spec_version:17');
  assert.equal(receipt.commitSha, COMMIT);
  assert.equal(receipt.orchestration.eventCount, orchestration.length);
  assert.equal(receipt.orchestration.subagentCount, 1);
  assert.equal(receipt.rawTerminalAvailable, true);
  assert.match(receipt.qualificationBoundary, /ssdlc-interoperability/);
});

test('qualifies failed subagent as canonical blocked control, actionable gap, and visible continuation', async () => {
  const execution = await execute(true);
  const failedEvents = [
    ...orchestration.slice(0, 3),
    event(4, {
      type: 'agent_failed', eventId: 'worker-failed', agentId: 'worker', parentAgentId: 'root',
      error: 'provider unavailable',
    }),
    event(5, {
      type: 'agent_start', eventId: 'worker-retry-start', agentId: 'worker-retry', parentAgentId: 'root',
      retryOfAgentId: 'worker', continuationOfAgentId: 'checkpoint-1',
    }),
    event(6, { type: 'agent_settled', eventId: 'worker-retry-done', agentId: 'worker-retry', parentAgentId: 'root' }),
    event(7, { type: 'agent_settled', eventId: 'root-done-after-failure', agentId: 'root' }),
  ];
  const receipt = qualify(execution.evidence, failedEvents);

  assert.equal(receipt.stageStatus, 'blocked');
  assert.deepEqual(receipt.blockedControlIds, [control.controlId]);
  assert.deepEqual(receipt.orchestration.failedAgentIds, ['worker']);
  assert.equal(receipt.orchestration.retryOrContinuationCount, 1);
  assert.match(String(execution.evidence[0].details.actionableGap), /retry execution/i);
});

test('rejects replay receipts or evidence that drift from the exact spec and commit', async () => {
  const execution = await execute(false);
  const staleEvent = structuredClone(orchestration[0]);
  staleEvent.specRevisionHash = hash('f');
  assert.throws(() => qualify(execution.evidence, [staleEvent, ...orchestration.slice(1)]), /exact persisted spec revision/);

  const staleEvidence = structuredClone(execution.evidence);
  staleEvidence[0].details.commitSha = '1123456789abcdef0123456789abcdef01234567';
  assert.throws(() => qualify(staleEvidence), /exact profile, spec revision, hash, and commit/);
});
