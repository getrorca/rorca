/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ProgressLedgerEntryV1Schema,
  completionContinuationKey,
  completionProgressEntryHash,
  governedHash,
  type AttemptTaskPlanV1,
  type CompletionGateDecisionV1,
  type ContinuationDirectiveV1,
  type ContinuationScope,
  type ProgressLedgerEntryV1,
  type ResultProposalV1,
} from '../governed-contracts';
import {
  CompletionProgressLedgerError,
  verifyCompletionLedger,
} from '../completion-progress-ledger';
import {
  createCompletionRunnerPersistence,
  type CompletionAttemptProgressState,
  type CompletionRunnerPersistence,
  type CompletionRunnerPersistenceServices,
} from '../completion-runner-persistence';
import type {
  CompletionExecutionReceipt,
  CompletionRunnerDurableEvent,
  CompletionSelfReviewReceipt,
  CompletionTaskOperation,
  CompletionValidationReceipt,
} from '../completion-runner';
import {
  completionContinuationConsumptionHash,
  type CanonicalCompletionContinuationLifecycle,
  type CanonicalCompletionProgressRecord,
  type CompletionContinuationConsumptionInput,
  type CompletionMutationResult,
} from '../completion-protocol-service';
import { evaluateStoryCloseout, LEGACY_CLOSEOUT_RULE_NAME } from '../story-closeout';

const NOW = '2026-08-04T12:00:00.000Z';
const hash = (seed: number): string => `sha256:${(seed % 16).toString(16).repeat(64)}`;
const git = (seed: number): string => (seed % 16).toString(16).repeat(40);

const SCOPE: ContinuationScope = {
  workspaceId: 'workspace:adapter', missionId: 'mission:adapter', missionRevision: 1, missionHash: hash(1),
  workPackageId: 'package:adapter', workPackageRevision: 1, workPackageHash: hash(2),
  spec: {
    specId: 'spec:adapter', specVersion: 1, specHash: hash(3), canonicalSpecPath: 'forge/specs/adapter.json',
    storyId: 'story:adapter', storyVersion: 1, storyHash: hash(4), criteriaManifestHash: hash(5),
  },
  runId: 77, attemptId: 'attempt:adapter', leaseId: 'lease:adapter', fencingToken: 9,
  leaseExpiresAt: '2026-08-05T00:00:00.000Z', cancellationId: 'cancel:adapter', runtimeId: 'runtime:adapter',
  controllerGeneration: 1, runtimeGeneration: 1, sessionId: 'session:adapter', sessionFileHash: hash(6),
  turnId: 'turn:adapter', turnAttempt: 1, originatingGeneration: 1, cursor: 3, cursorHash: hash(7),
  priorEntryId: 'entry:prior', repository: {
    repositoryId: 'repo:adapter', remoteAuthorityHash: hash(8), gitObjectFormat: 'sha1', baseSha: git(1),
    currentSha: git(2), expectedHeadSha: git(2), worktreeId: 'worktree:adapter', allowedPathManifestHash: hash(9),
    requiredPathManifestHash: hash(10), changedPathManifestHash: hash(11), forbiddenPathManifestHash: hash(12),
  },
  validationStateHash: hash(13), rootCauseClassification: 'root:none', rootCauseHash: hash(14),
  policyDefinitionId: 'policy:adapter', policyDefinitionVersion: '1.0.0', policyDefinitionHash: hash(15),
  policyActivationId: 'activation:adapter', policyActivationRevision: 1, policyActivationHash: hash(1),
};
const SCOPE_HASH = governedHash('rorca.continuation-scope.v1', SCOPE as never);

const PLAN: AttemptTaskPlanV1 = {
  schemaVersion: 'rorca.attempt-task-plan.v1', contractId: 'rorca.attempt-task-plan.v1', contractVersion: '1.0.0',
  artifactId: 'artifact:adapter-plan', contentHash: hash(2), createdAt: NOW, createdBy: SCOPE.runtimeId, scope: SCOPE,
  planId: 'plan:adapter', planRevision: 1, planHash: hash(2), priorPlanHash: 'not_applicable',
  obligationSetId: 'obligations:adapter', obligationSetRevision: 1, obligationSetHash: hash(3), batches: [{
    batchId: 'batch:adapter', ordinal: 0, tasks: [{
      taskId: 'task:adapter', ordinal: 0, objectiveHash: hash(4), coveredObligationIds: ['obligation:adapter'],
      allowedPaths: ['src/adapter.ts'], commandHashes: [hash(5)], state: 'pending',
    }],
  }], totalBatches: 1, totalTasks: 1, totalMutablePaths: 1, totalValidationCommands: 1, serializedBytes: 1_024,
};

function execution(): CompletionExecutionReceipt {
  return {
    operationKey: hash(6), executionNonce: hash(7), scopeHash: SCOPE_HASH, fencingToken: SCOPE.fencingToken,
    planId: PLAN.planId, planRevision: PLAN.planRevision, planHash: PLAN.planHash, batchId: 'batch:adapter',
    taskIds: ['task:adapter'], baseSha: SCOPE.repository.baseSha, resultSha: SCOPE.repository.currentSha,
    treeHash: git(3), diffHash: hash(8), changedPathManifestHash: SCOPE.repository.changedPathManifestHash,
    changedPaths: ['src/adapter.ts'], sourceVectorHash: hash(9), mutation: 'material', settledAt: NOW,
  };
}

function operation(state: CompletionTaskOperation['state']): CompletionTaskOperation {
  const receipt = execution();
  return {
    operationKey: receipt.operationKey, executionNonce: receipt.executionNonce, scopeHash: receipt.scopeHash,
    fencingToken: receipt.fencingToken, planId: receipt.planId, planRevision: receipt.planRevision,
    planHash: receipt.planHash, batchId: receipt.batchId, taskIds: receipt.taskIds,
    repositorySha: SCOPE.repository.currentSha, state, receipt: state === 'settled' ? receipt : null,
  };
}

function validation(): CompletionValidationReceipt {
  const receipt = execution();
  return {
    validationId: 'validation:adapter', validationHash: hash(10), operationKey: receipt.operationKey,
    resultSha: receipt.resultSha, treeHash: receipt.treeHash, commandHashes: [hash(5)], complete: true,
    outcome: 'passed', failedObligationIds: [], issueCodes: [], validatedAt: NOW,
  };
}

function review(): CompletionSelfReviewReceipt {
  const receipt = execution();
  return {
    reviewId: 'review:adapter', reviewHash: hash(11), operationKey: receipt.operationKey,
    validationHash: hash(10), resultSha: receipt.resultSha, complete: true, outcome: 'ready', issueCodes: [], reviewedAt: NOW,
  };
}

function proposal(ledgerHighWaterHash: string): ResultProposalV1 {
  return {
    schemaVersion: 'rorca.completion-result-proposal.v1', contractId: 'rorca.completion-result-proposal.v1',
    contractVersion: '1.0.0', artifactId: 'artifact:adapter-proposal', contentHash: hash(12), createdAt: NOW,
    createdBy: SCOPE.runtimeId, scope: SCOPE, proposalId: 'proposal:adapter', proposalRevision: 1,
    proposalHash: hash(12), planId: PLAN.planId, planRevision: PLAN.planRevision, planHash: PLAN.planHash,
    ledgerHighWaterHash, baseSha: SCOPE.repository.baseSha, resultSha: SCOPE.repository.currentSha,
    treeHash: git(3), diffHash: hash(8), changedPathManifestHash: SCOPE.repository.changedPathManifestHash,
    taskResultManifestHash: hash(13), criterionResultManifestHash: hash(14), disposition: 'ready', summaryRef: {
      referenceId: 'summary:adapter', kind: 'artifact', hash: hash(15), sensitivity: 'internal',
      retentionClass: 'retention:adapter', accessTier: 'auth', rawPayloadIncluded: false,
    },
  };
}

function gate(currentProposal: ResultProposalV1, stage: CompletionGateDecisionV1['stage'], outcome: CompletionGateDecisionV1['outcome'], nextAction: CompletionGateDecisionV1['nextAction']): CompletionGateDecisionV1 {
  const decisionHash = stage === 'controller_preflight' ? hash(3) : hash(4);
  return {
    schemaVersion: 'rorca.completion-gate-decision.v1', contractId: 'rorca.completion-gate-decision.v1',
    contractVersion: '1.0.0', artifactId: `artifact:gate:${stage}`, contentHash: decisionHash, createdAt: NOW,
    createdBy: stage === 'controller_preflight' ? 'controller:adapter' : 'host:adapter', scope: SCOPE,
    decisionId: `decision:${stage}`, decisionRevision: 1, decisionHash,
    proposalId: currentProposal.proposalId, proposalRevision: currentProposal.proposalRevision,
    proposalHash: currentProposal.proposalHash, planId: PLAN.planId, planRevision: PLAN.planRevision,
    planHash: PLAN.planHash, obligationSetId: PLAN.obligationSetId, obligationSetRevision: PLAN.obligationSetRevision,
    obligationSetHash: PLAN.obligationSetHash, stage, outcome,
    reasonCodes: outcome === 'validated' ? ['VALIDATED'] : ['FIX_REQUIRED'],
    failedObligationIds: outcome === 'validated' ? [] : ['obligation:adapter'], nextAction,
    hostEvidenceHash: hash(5), establishesStoryCompletion: false,
  };
}

function directive(decision: CompletionGateDecisionV1): ContinuationDirectiveV1 {
  const seed = {
    schemaVersion: 'rorca.completion-continuation-directive.v1' as const,
    contractId: 'rorca.completion-continuation-directive.v1' as const,
    contractVersion: '1.0.0', artifactId: 'artifact:adapter-directive', contentHash: hash(6), createdAt: NOW,
    createdBy: 'controller:adapter', scope: SCOPE, directiveId: 'directive:adapter', directiveRevision: 1,
    directiveHash: hash(6), continuationKey: hash(7), priorDecisionId: decision.decisionId,
    priorDecisionRevision: decision.decisionRevision, priorDecisionHash: decision.decisionHash,
    targetPlanId: PLAN.planId, targetPlanRevision: PLAN.planRevision, targetPlanHash: PLAN.planHash,
    targetBatchId: 'batch:adapter', failedObligationIds: decision.failedObligationIds,
    checkpointId: 'checkpoint:adapter', checkpointHash: hash(8), receiptId: 'receipt:adapter', receiptHash: hash(9),
    bundleId: 'bundle:adapter', bundleHash: hash(10), policyActivationHash: SCOPE.policyActivationHash,
    trigger: {
      type: 'meaningful_retry' as const, previewHash: hash(11), receiptHash: hash(12), priorAttempt: 1, newAttempt: 2,
      priorGeneration: 1, newGeneration: 2, failedScopeHash: hash(13), changedSourceVectorHash: hash(14),
    },
    targetCursor: SCOPE.cursor, expectedCursorAdvance: 1, retryBudgetId: 'retry:adapter', retryFence: SCOPE.fencingToken,
    retrySpent: 0, retryMaximum: 2, authorizationExpiresAt: '2026-08-05T00:00:00.000Z', state: 'authorized' as const,
  };
  const continuationKey = completionContinuationKey({
    decision, scope: SCOPE, targetPlanId: seed.targetPlanId, targetPlanRevision: seed.targetPlanRevision,
    targetPlanHash: seed.targetPlanHash, targetBatchId: seed.targetBatchId,
    failedObligationIds: seed.failedObligationIds, checkpointHash: seed.checkpointHash, receiptHash: seed.receiptHash,
    bundleHash: seed.bundleHash, policyActivationHash: seed.policyActivationHash, trigger: seed.trigger,
    targetCursor: seed.targetCursor, expectedCursorAdvance: seed.expectedCursorAdvance, retryBudgetId: seed.retryBudgetId,
    retryFence: seed.retryFence, retrySpent: seed.retrySpent, retryMaximum: seed.retryMaximum,
  });
  return { ...seed, continuationKey: continuationKey! };
}

class FakeCanonicalService {
  readonly records: CanonicalCompletionProgressRecord[] = [];
  readonly lifecycles: CanonicalCompletionContinuationLifecycle[] = [];
  readonly calls: string[] = [];
  readonly nextStates: Array<CompletionAttemptProgressState | undefined> = [];
  currentPlan: AttemptTaskPlanV1 | null = null;
  attempt: Record<string, unknown> = {
    workspace_id: SCOPE.workspaceId,
    attempt_id: SCOPE.attemptId,
    writer_fence: String(SCOPE.fencingToken),
    state_version: '1',
    retry_spent: '0',
    state: 'planning',
  };
  private readonly artifacts = new Map<string, string>();

  readonly services: CompletionRunnerPersistenceServices = {
    persistProgressEntry: async (entry, event, expectedStateVersion, nextState) => {
      this.calls.push(`progress:${String(event.eventType)}`);
      this.nextStates.push(nextState);
      expect(expectedStateVersion).toBe(Number(this.attempt.state_version));
      expect(entry.payloadHash).toBe(governedHash('rorca.completion-durable-event.v1', event as never));
      const existing = this.records[entry.sequence];
      if (existing) {
        if (existing.entry.entryHash !== entry.entryHash) throw new Error('progress conflict');
        return this.result(`progress:${entry.entryHash}`, entry.entryHash, 'duplicate');
      }
      expect(entry.sequence).toBe(this.records.length);
      expect(entry.priorEntryHash).toBe(this.records.at(-1)?.entry.entryHash ?? 'not_applicable');
      this.records.push({ entry, event });
      this.attempt.state_version = String(Number(this.attempt.state_version) + 1);
      if (nextState) this.attempt.state = nextState;
      return this.result(`progress:${entry.entryHash}`, entry.entryHash, 'accepted');
    },
    loadProgressRecords: async () => this.records,
    loadProgressEntries: async () => this.records.map((record) => record.entry),
    loadContinuationLifecycles: async () => this.lifecycles,
    loadCurrentPlan: async () => this.currentPlan,
    loadAttempt: async () => this.attempt,
    persistPlan: async (value) => {
      this.calls.push('artifact:plan');
      const result = this.persistArtifact('plan', value.planHash);
      this.currentPlan = value;
      if (result.disposition === 'accepted') {
        this.attempt.state_version = String(Number(this.attempt.state_version) + 2);
        this.attempt.state = 'planning';
      }
      return result;
    },
    persistProposal: async (value) => {
      this.calls.push('artifact:proposal');
      return this.persistArtifact('proposal', value.proposalHash);
    },
    persistGate: async (value) => {
      this.calls.push(`artifact:gate:${value.stage}`);
      return this.persistArtifact(`gate:${value.decisionId}`, value.decisionHash);
    },
    persistContinuation: async (value) => {
      this.calls.push('artifact:continuation');
      const result = this.persistArtifact('continuation', value.directiveHash);
      if (result.disposition === 'accepted') {
        this.lifecycles.push({
          directive: value,
          state: 'authorized',
          dispatchId: null,
          dispatchReceiptHash: null,
          consumptionId: null,
          consumptionHash: null,
          consumedAt: null,
        });
      }
      return result;
    },
    dispatchContinuation: async (value) => {
      const lifecycle = this.requireLifecycle(value);
      lifecycle.state = 'dispatched';
      lifecycle.dispatchId = value.dispatchId;
      return this.persistArtifact('continuation-dispatch', value.directiveHash);
    },
    settleContinuation: async (value) => {
      const lifecycle = this.requireLifecycle(value);
      lifecycle.state = 'settled';
      lifecycle.dispatchId = value.dispatchId;
      lifecycle.dispatchReceiptHash = value.dispatchReceiptHash;
      return this.persistArtifact('continuation-settle', value.directiveHash);
    },
    consumeContinuation: async (value) => {
      const lifecycle = this.requireLifecycle(value);
      const duplicate = lifecycle.consumptionId !== null;
      if (duplicate && lifecycle.consumptionId !== value.consumptionId) throw new Error('continuation already consumed');
      lifecycle.consumptionId = value.consumptionId;
      lifecycle.consumptionHash = completionContinuationConsumptionHash(value);
      lifecycle.consumedAt = NOW;
      return {
        ...this.result('continuation-consume', value.directiveHash, duplicate ? 'duplicate' : 'accepted'),
        directive: lifecycle.directive,
      };
    },
  };

  private requireLifecycle(value: Pick<CompletionContinuationConsumptionInput, 'directiveId' | 'directiveRevision' | 'directiveHash' | 'continuationKey'>): CanonicalCompletionContinuationLifecycle {
    const lifecycle = this.lifecycles.find((candidate) => candidate.directive.directiveId === value.directiveId
      && candidate.directive.directiveRevision === value.directiveRevision
      && candidate.directive.directiveHash === value.directiveHash
      && candidate.directive.continuationKey === value.continuationKey);
    if (!lifecycle) throw new Error('continuation lifecycle missing');
    return lifecycle;
  }

  private persistArtifact(kind: string, artifactHash: string): CompletionMutationResult {
    const existing = this.artifacts.get(kind);
    if (existing && existing !== artifactHash) throw new Error(`${kind} conflict`);
    this.artifacts.set(kind, artifactHash);
    return this.result(kind, artifactHash, existing ? 'duplicate' : 'accepted');
  }

  private result(kind: string, artifactHash: string, disposition: CompletionMutationResult['disposition']): CompletionMutationResult {
    return {
      disposition,
      operationKey: governedHash('rorca.test-completion-operation.v1', { kind, artifactHash } as never),
      artifactHash,
    };
  }

  injectDatabaseAhead(event: CompletionRunnerDurableEvent, entryType: ProgressLedgerEntryV1['entryType']): ProgressLedgerEntryV1 {
    const sequence = this.records.length;
    const payloadHash = governedHash('rorca.completion-durable-event.v1', event as never);
    const append = {
      schemaVersion: 'rorca.completion-progress-entry.v1' as const,
      contractId: 'rorca.completion-progress-entry.v1' as const,
      contractVersion: '1.0.0', artifactId: `progress:injected:${sequence}`, createdAt: event.observedAt,
      createdBy: SCOPE.runtimeId, scope: SCOPE, sequence,
      priorEntryHash: this.records.at(-1)?.entry.entryHash ?? 'not_applicable' as const,
      writerFence: SCOPE.fencingToken, planId: PLAN.planId, planRevision: PLAN.planRevision, planHash: PLAN.planHash,
      repositorySha: SCOPE.repository.currentSha, entryType, payloadHash, databaseReceiptRefs: [], recordedAt: event.observedAt,
    };
    const entryHash = completionProgressEntryHash(append);
    const entry = ProgressLedgerEntryV1Schema.parse({ ...append, contentHash: entryHash, entryHash });
    this.records.push({ entry, event: event as unknown as Record<string, unknown> });
    this.attempt.state_version = String(Number(this.attempt.state_version) + 1);
    return entry;
  }

  dropLastCanonicalRecord(): void {
    this.records.pop();
  }
}

interface TestContext {
  stateRoot: string;
  checkoutRoot: string;
  service: FakeCanonicalService;
  persistence: CompletionRunnerPersistence;
}

const roots: string[] = [];
const openPersistence: CompletionRunnerPersistence[] = [];

afterEach(() => {
  for (const persistence of openPersistence.splice(0)) persistence.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function context(service = new FakeCanonicalService()): Promise<TestContext> {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-completion-runner-state-'));
  const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-completion-runner-checkout-'));
  roots.push(stateRoot, checkoutRoot);
  const persistence = await createCompletionRunnerPersistence({
    stateRoot,
    checkoutRoot,
    scope: SCOPE,
    writerFence: SCOPE.fencingToken,
    clock: () => new Date(NOW),
    services: service.services,
  });
  openPersistence.push(persistence);
  return { stateRoot, checkoutRoot, service, persistence };
}

function reservationEvent(): Extract<CompletionRunnerDurableEvent, { eventType: 'operation_reserved' }> {
  return { eventType: 'operation_reserved', observedAt: NOW, operation: operation('reserved') };
}

describe('completion runner durable persistence adapter', () => {
  test('persists DB first, reduces full durable semantics, closes, and restarts exactly', async () => {
    const value = await context();
    await value.persistence.persistPlan(PLAN);
    await value.persistence.durable.record({ scope: SCOPE, event: reservationEvent() });
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'operation_settled', observedAt: NOW, operation: operation('settled'), receipt: execution() },
    });
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'validation_recorded', observedAt: NOW, validation: validation() },
    });
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'review_recorded', observedAt: NOW, review: review() },
    });
    const closeout = evaluateStoryCloseout({
      manifest: null,
      attempt: null,
      host: null,
      legacyCompatibility: {
        ruleName: LEGACY_CLOSEOUT_RULE_NAME,
        manifestVersion: 0,
        runCreatedAt: '2026-01-01T00:00:00.000Z',
        cutoff: '2026-02-01T00:00:00.000Z',
        auditReference: 'audit:adapter',
        workspaceId: SCOPE.workspaceId,
        specId: SCOPE.spec.specId,
        runId: 77,
        storyId: SCOPE.spec.storyId,
        activeSubjectRevision: { commitSha: SCOPE.repository.currentSha, worktreePath: 'checkout', branch: 'adapter' },
        hostEvidenceReferences: ['evidence:adapter'],
      },
    });
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'closeout_recorded', observedAt: NOW, decision: closeout },
    });

    const reduced = await value.persistence.durable.reloadAndReconcile({ scope: SCOPE });
    expect(reduced.plan?.planHash).toBe(PLAN.planHash);
    expect(reduced.settledTaskIds).toEqual(['task:adapter']);
    expect(reduced.operations.map((item) => item.state)).toEqual(['reserved', 'settled']);
    expect(reduced.validations).toHaveLength(1);
    expect(reduced.reviews).toHaveLength(1);
    expect(reduced.closeoutDecisions[0]?.status).toBe('accepted');
    expect(value.service.nextStates).toEqual([undefined, 'executing', undefined, 'validating', 'self_reviewing', 'submitted']);
    for (let index = 0; index < value.service.records.length; index += 1) {
      expect(value.service.calls.indexOf(`progress:${String(value.service.records[index]!.event.eventType)}`)).toBeGreaterThanOrEqual(0);
    }

    value.persistence.close();
    openPersistence.splice(openPersistence.indexOf(value.persistence), 1);
    const restarted = await createCompletionRunnerPersistence({
      stateRoot: value.stateRoot,
      checkoutRoot: value.checkoutRoot,
      scope: SCOPE,
      writerFence: SCOPE.fencingToken,
      clock: () => new Date(NOW),
      services: value.service.services,
    });
    openPersistence.push(restarted);
    const afterRestart = await restarted.durable.reloadAndReconcile({ scope: SCOPE });
    expect(afterRestart).toMatchObject({
      ledgerHighWaterHash: reduced.ledgerHighWaterHash,
      settledTaskIds: ['task:adapter'],
      reconciliation: 'clean',
    });
    expect(afterRestart.closeoutDecisions[0]?.decisionId).toBe(closeout.decisionId);
  });

  test('recovers DB-ahead entries and rebuilds a missing external ledger only from canonical records', async () => {
    const value = await context();
    await value.persistence.persistPlan(PLAN);
    const injectedValidation: CompletionRunnerDurableEvent = {
      eventType: 'validation_recorded', observedAt: NOW, validation: validation(),
    };
    value.service.injectDatabaseAhead(injectedValidation, 'validation_recorded');

    const recovered = await value.persistence.durable.reloadAndReconcile({ scope: SCOPE });
    expect(recovered.reconciliation).toBe('rebuilt_from_canonical_receipts');
    expect(recovered.validations).toHaveLength(1);
    expect(value.service.records.at(-1)?.entry.entryType).toBe('recovery_recorded');
    value.persistence.close();
    openPersistence.splice(openPersistence.indexOf(value.persistence), 1);
    expect(verifyCompletionLedger({
      stateRoot: value.stateRoot,
      checkoutRoot: value.checkoutRoot,
      scope: SCOPE,
      writerFence: SCOPE.fencingToken,
      clock: () => new Date(NOW),
    }).entries).toHaveLength(value.service.records.length);

    fs.rmSync(path.join(value.stateRoot, 'completion-protocol'), { recursive: true, force: true });
    const rebuilt = await createCompletionRunnerPersistence({
      stateRoot: value.stateRoot,
      checkoutRoot: value.checkoutRoot,
      scope: SCOPE,
      writerFence: SCOPE.fencingToken,
      clock: () => new Date(NOW),
      services: value.service.services,
    });
    openPersistence.push(rebuilt);
    const rebuiltState = await rebuilt.durable.reloadAndReconcile({ scope: SCOPE });
    expect(rebuiltState.reconciliation).toBe('rebuilt_from_canonical_receipts');
    expect(rebuiltState.validations).toHaveLength(1);
  });

  test('returns exact duplicate versus conflict and enforces exclusive writer fences', async () => {
    const value = await context();
    await value.persistence.persistPlan(PLAN);
    const event = reservationEvent();
    expect(await value.persistence.durable.record({ scope: SCOPE, event })).toMatchObject({ outcome: 'appended' });
    expect(await value.persistence.durable.record({ scope: SCOPE, event })).toMatchObject({ outcome: 'exact_duplicate' });
    expect(await value.persistence.durable.record({
      scope: SCOPE,
      event: { ...event, operation: { ...event.operation, executionNonce: hash(15) } },
    })).toMatchObject({ outcome: 'conflict' });

    await expect(createCompletionRunnerPersistence({
      stateRoot: value.stateRoot,
      checkoutRoot: value.checkoutRoot,
      scope: SCOPE,
      writerFence: SCOPE.fencingToken,
      services: value.service.services,
    })).rejects.toBeInstanceOf(CompletionProgressLedgerError);
    await expect(createCompletionRunnerPersistence({
      stateRoot: value.stateRoot,
      checkoutRoot: value.checkoutRoot,
      scope: SCOPE,
      writerFence: SCOPE.fencingToken + 1,
      services: value.service.services,
    })).rejects.toMatchObject({ code: 'WRITER_FENCE_CONFLICT' });
  });

  test('persists proposal, both gates, and continuation artifacts before exact durable events', async () => {
    const value = await context();
    await value.persistence.persistPlan(PLAN);
    const initialState = await value.persistence.durable.reloadAndReconcile({ scope: SCOPE });
    const currentProposal = proposal(initialState.ledgerHighWaterHash);
    await value.persistence.stageProposal(currentProposal);
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'proposal_recorded', observedAt: NOW, proposal: currentProposal },
    });
    const controller = gate(currentProposal, 'controller_preflight', 'validated', 'none');
    await value.persistence.stageGate(controller);
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'gate_recorded', observedAt: NOW, decision: controller },
    });
    const host = gate(currentProposal, 'host_semantic', 'rejected_gate', 'continue_fix');
    await value.persistence.stageGate(host);
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'gate_recorded', observedAt: NOW, decision: host },
    });
    const continuation = directive(host);
    await value.persistence.stageContinuation(continuation);
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'continuation_recorded', observedAt: NOW, directive: continuation, backoffMs: 1_000 },
    });

    expect(value.service.calls).toEqual([
      'artifact:plan', 'progress:plan_persisted',
      'artifact:proposal', 'progress:proposal_recorded',
      'artifact:gate:controller_preflight', 'progress:gate_recorded',
      'artifact:gate:host_semantic', 'progress:gate_recorded',
      'artifact:continuation', 'progress:continuation_recorded',
    ]);
    const reduced = await value.persistence.durable.reloadAndReconcile({ scope: SCOPE });
    expect(reduced.proposals).toHaveLength(1);
    expect(reduced.gateDecisions.map((decision) => decision.stage)).toEqual(['controller_preflight', 'host_semantic']);
    expect(reduced.directives).toHaveLength(1);
    expect(value.service.attempt.state).toBe('planning');
    for (const record of value.service.records.slice(1)) {
      expect(record.entry.databaseReceiptRefs).toHaveLength(1);
    }
  });

  test('projects canonical continuation lifecycle and admits only the one-use consumption CAS winner', async () => {
    const value = await context();
    await value.persistence.persistPlan(PLAN);
    const currentDirective = directive(gate(proposal(hash(1)), 'host_semantic', 'rejected_gate', 'continue_fix'));
    await value.persistence.stageContinuation(currentDirective);
    await value.persistence.durable.record({
      scope: SCOPE,
      event: { eventType: 'continuation_recorded', observedAt: NOW, directive: currentDirective, backoffMs: 1_000 },
    });
    const dispatch = {
      workspaceId: SCOPE.workspaceId,
      attemptId: SCOPE.attemptId,
      directiveId: currentDirective.directiveId,
      directiveRevision: currentDirective.directiveRevision,
      directiveHash: currentDirective.directiveHash,
      continuationKey: currentDirective.continuationKey,
      dispatchId: 'dispatch:adapter',
      leaseId: SCOPE.leaseId,
      fencingToken: SCOPE.fencingToken,
    };
    await value.persistence.dispatchContinuation(dispatch);
    expect((await value.persistence.durable.reloadAndReconcile({ scope: SCOPE })).directives.at(-1)?.state).toBe('dispatched');
    const settlement = { ...dispatch, dispatchReceiptHash: hash(15) };
    await value.persistence.settleContinuation(settlement);
    const settled = await value.persistence.durable.reloadAndReconcile({ scope: SCOPE });
    expect(settled.directives.at(-1)?.state).toBe('settled');
    expect(settled.continuationLifecycles.at(-1)).toMatchObject({
      state: 'settled',
      dispatchId: dispatch.dispatchId,
      dispatchReceiptHash: settlement.dispatchReceiptHash,
      consumptionId: null,
    });

    const claim = { ...settlement, consumptionId: 'consumption:adapter' };
    const outcomes = await Promise.allSettled([
      value.persistence.consumeContinuation(claim),
      value.persistence.consumeContinuation(claim),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    await expect(value.persistence.consumeContinuation({ ...claim, consumptionId: 'consumption:reuse' }))
      .rejects.toThrow(/already consumed/);
    await expect(value.persistence.consumeContinuation({ ...claim, fencingToken: SCOPE.fencingToken + 1 }))
      .rejects.toMatchObject({ code: 'CONTINUATION_TRANSITION_SCOPE_CONFLICT' });
  });

  test('fails closed when a ledger-ahead entry has no canonical event payload', async () => {
    const value = await context();
    await value.persistence.persistPlan(PLAN);
    await value.persistence.durable.record({ scope: SCOPE, event: reservationEvent() });
    value.persistence.close();
    openPersistence.splice(openPersistence.indexOf(value.persistence), 1);
    value.service.dropLastCanonicalRecord();

    const reopened = await createCompletionRunnerPersistence({
      stateRoot: value.stateRoot,
      checkoutRoot: value.checkoutRoot,
      scope: SCOPE,
      writerFence: SCOPE.fencingToken,
      clock: () => new Date(NOW),
      services: value.service.services,
    });
    openPersistence.push(reopened);
    await expect(reopened.durable.reloadAndReconcile({ scope: SCOPE })).rejects.toMatchObject({
      code: 'COMPLETION_LEDGER_IO_FAILED',
    });
  });
});
