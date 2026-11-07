/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { z } from 'zod';
import { governedHash } from './primitives';
import { ContextEpochProjectionV0Schema } from './context-continuation';

export * from './primitives';
export * from './mission-contract';
export * from './work-package';
export * from './context-continuation';
export * from './completion-protocol';
export * from './runtime-event';
export * from './run-stream';
export * from './version-negotiation';

import { MissionContractV1Schema } from './mission-contract';
import { WorkPackageV1Schema, ExecutionLeaseV1Schema, CancellationV1Schema, PlanChangeProposalV1Schema } from './work-package';
import {
  ContextPolicyDefinitionV1Schema, ContextPolicyActivationV1Schema, ContextCheckpointV1Schema,
  RetrievalReceiptV1Schema, ContextBundleV1Schema, ContextBundleDeltaV1Schema,
  ContinuationDispatchV1Schema, ContinuationRetryBudgetV1Schema,
} from './context-continuation';
import {
  AttemptTaskPlanV1Schema, CanonicalObligationSetV1Schema, CompletionGateDecisionV1Schema,
  ContinuationDirectiveV1Schema, FinalCompletionReportV1Schema, ProgressLedgerEntryV1Schema,
  ResultProposalV1Schema,
} from './completion-protocol';
import { RuntimeEventV1Schema, EvidenceEnvelopeV1Schema, CloseoutEvaluationV1Schema } from './runtime-event';
import {
  RunStreamEnvelopeV1Schema,
  RuntimeNeutralObservationV1Schema,
  RuntimeTelemetryBatchV1Schema,
} from './run-stream';

export const GOVERNED_CONTRACT_SCHEMAS = Object.freeze({
  'mission-contract': MissionContractV1Schema,
  'work-package': WorkPackageV1Schema,
  'execution-lease': ExecutionLeaseV1Schema,
  'context-policy-definition': ContextPolicyDefinitionV1Schema,
  'context-policy-activation': ContextPolicyActivationV1Schema,
  'context-checkpoint': ContextCheckpointV1Schema,
  'retrieval-receipt': RetrievalReceiptV1Schema,
  'context-bundle': ContextBundleV1Schema,
  'context-bundle-delta': ContextBundleDeltaV1Schema,
  'continuation-dispatch': ContinuationDispatchV1Schema,
  'continuation-retry-budget': ContinuationRetryBudgetV1Schema,
  'completion-obligation-set': CanonicalObligationSetV1Schema,
  'attempt-task-plan': AttemptTaskPlanV1Schema,
  'completion-result-proposal': ResultProposalV1Schema,
  'completion-gate-decision': CompletionGateDecisionV1Schema,
  'completion-continuation-directive': ContinuationDirectiveV1Schema,
  'completion-progress-entry': ProgressLedgerEntryV1Schema,
  'completion-final-report': FinalCompletionReportV1Schema,
  'runtime-event': RuntimeEventV1Schema,
  'evidence-envelope': EvidenceEnvelopeV1Schema,
  'closeout-evaluation': CloseoutEvaluationV1Schema,
  'run-stream-envelope': RunStreamEnvelopeV1Schema,
  'runtime-neutral-observation': RuntimeNeutralObservationV1Schema,
  'runtime-telemetry-batch': RuntimeTelemetryBatchV1Schema,
  cancellation: CancellationV1Schema,
  'plan-change-proposal': PlanChangeProposalV1Schema,
  'context-epoch-projection': ContextEpochProjectionV0Schema,
} satisfies Record<string, z.ZodType>);

export function contextEpochProjectionId(input: {
  checkpointId: string; checkpointVersion: number; checkpointHash: string;
  policyDefinitionId: string; policyDefinitionVersion: string; policyDefinitionHash: string;
  policyActivationId: string; policyActivationRevision: number; policyActivationHash: string;
  retrievalReceiptId: string; retrievalReceiptVersion: number; retrievalReceiptHash: string;
  contextBundleId: string; contextBundleVersion: number; contextBundleHash: string;
  continuationDispatchId: string | 'not_applicable'; continuationDispatchVersion: number | 'not_applicable'; continuationDispatchHash: string | 'not_applicable';
}): string {
  return `ctxe_${governedHash('rorca.context-epoch-projection.v0', input).slice(7)}`;
}
