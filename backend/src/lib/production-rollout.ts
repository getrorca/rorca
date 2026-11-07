/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ReleaseHealthSignalSchema,
  ReleaseIntentSchema,
  ReleaseRollbackSchema,
  ReleaseRolloutCohortSchema,
  type ReleaseIntent,
} from './release-intent';

export const PRODUCTION_HEALTH_EVIDENCE_VERSION = 'rorca.production-health-evidence.v1' as const;
export const PRODUCTION_HEALTH_EVALUATION_VERSION = 'rorca.production-health-evaluation.v1' as const;
export const PRODUCTION_ROLLOUT_RECEIPT_VERSION = 'rorca.production-rollout-receipt.v1' as const;

const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SourceRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const SafeIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
const TimestampSchema = z.string().datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const ProductionRevisionSchema = z.object({
  sourceRevision: SourceRevisionSchema.nullable(),
  imageDigest: DigestSchema.nullable(),
  configurationBindingGeneration: z.number().int().positive(),
}).strict().refine(
  (revision) => revision.sourceRevision !== null || revision.imageDigest !== null,
  { message: 'A production revision requires an immutable source revision or image digest' },
);
export type ProductionRevision = z.infer<typeof ProductionRevisionSchema>;

export const ProductionProviderStateSchema = z.object({
  revision: ProductionRevisionSchema,
  authorityBindingGeneration: z.number().int().positive(),
  capturedAt: TimestampSchema,
}).strict();
export type ProductionProviderState = z.infer<typeof ProductionProviderStateSchema>;

export const ProductionRolloutPhaseSchema = z.enum(['canary', 'expansion', 'rollback']);
export type ProductionRolloutPhase = z.infer<typeof ProductionRolloutPhaseSchema>;

export const ProductionActionAcceptanceSchema = z.object({
  actionId: z.string().uuid(),
  phase: ProductionRolloutPhaseSchema,
  leaseId: z.string().uuid(),
  providerDeploymentId: z.string().min(1).max(255),
  acceptedAt: TimestampSchema,
  cohort: ReleaseRolloutCohortSchema,
  targetRevision: ProductionRevisionSchema,
}).strict();
export type ProductionActionAcceptance = z.infer<typeof ProductionActionAcceptanceSchema>;

export const ProductionTargetSchema = z.object({
  providerId: z.string().min(1).max(80),
  bindingId: z.string().uuid(),
  projectUuid: z.string().uuid(),
  applicationUuid: z.string().uuid(),
  environmentUuid: z.string().uuid(),
}).strict();
export type ProductionTarget = z.infer<typeof ProductionTargetSchema>;

export const ProductionCanaryAcceptanceSchema = z.object({
  action: ProductionActionAcceptanceSchema.extend({ phase: z.literal('canary') }).strict(),
  priorState: ProductionProviderStateSchema,
  target: ProductionTargetSchema,
}).strict();
export type ProductionCanaryAcceptance = z.infer<typeof ProductionCanaryAcceptanceSchema>;

export const ProductionRolloutAuthoritySchema = z.object({
  authorizationId: z.string().uuid(),
  operationId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  operationIntentId: z.string().uuid(),
  intentDigest: DigestSchema,
  ciEvidenceDigest: DigestSchema,
  grantId: z.string().uuid(),
  gateEvidenceId: z.string().uuid().nullable(),
  authorizedAt: TimestampSchema,
}).strict();
export type ProductionRolloutAuthority = z.infer<typeof ProductionRolloutAuthoritySchema>;

export const ProductionHealthSampleSchema = z.object({
  signalId: SafeIdentifierSchema,
  source: ReleaseHealthSignalSchema.shape.source,
  evidenceKey: SafeIdentifierSchema,
  value: z.number().finite(),
  sampledAt: TimestampSchema,
}).strict();
export type ProductionHealthSample = z.infer<typeof ProductionHealthSampleSchema>;

export const ProductionHealthEvidenceSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_HEALTH_EVIDENCE_VERSION),
  providerDeploymentId: z.string().min(1).max(255),
  rolloutCohort: ReleaseRolloutCohortSchema,
  revision: ProductionRevisionSchema,
  providerStatus: z.string().min(1).max(120),
  providerOutcome: z.enum(['pending', 'healthy', 'unhealthy']),
  samples: z.array(ProductionHealthSampleSchema).max(100_000),
  observedAt: TimestampSchema,
}).strict();
export type ProductionHealthEvidence = z.infer<typeof ProductionHealthEvidenceSchema>;

export const ProductionActionObservationSchema = z.object({
  actionId: z.string().uuid(),
  phase: ProductionRolloutPhaseSchema,
  evidence: ProductionHealthEvidenceSchema,
}).strict();
export type ProductionActionObservation = z.infer<typeof ProductionActionObservationSchema>;

const EvaluatedSignalSchema = ReleaseHealthSignalSchema.extend({
  inputSamples: z.array(ProductionHealthSampleSchema),
}).strict();

const EvaluatedAbortConditionSchema = z.object({
  conditionId: SafeIdentifierSchema,
  signalId: SafeIdentifierSchema,
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: z.number().finite(),
  observationWindowSeconds: z.number().int().min(1).max(86_400),
  requiredSamples: z.number().int().min(1).max(100_000),
  windowStartedAt: TimestampSchema,
  windowEndedAt: TimestampSchema,
  inputSamples: z.array(ProductionHealthSampleSchema),
  aggregatedValue: z.number().finite().nullable(),
  triggered: z.boolean().nullable(),
}).strict();

export const ProductionHealthEvaluationSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_HEALTH_EVALUATION_VERSION),
  evidenceDigest: DigestSchema,
  providerDeploymentId: z.string().min(1).max(255),
  rolloutCohort: ReleaseRolloutCohortSchema,
  providerStatus: z.string().min(1).max(120),
  providerOutcome: z.enum(['pending', 'healthy', 'unhealthy']),
  signals: z.array(EvaluatedSignalSchema),
  conditions: z.array(EvaluatedAbortConditionSchema),
  decision: z.enum(['pending', 'expand', 'abort']),
  evaluatedAt: TimestampSchema,
}).strict();
export type ProductionHealthEvaluation = z.infer<typeof ProductionHealthEvaluationSchema>;

export const ProductionRevokedLeaseSchema = z.object({
  actionId: z.string().uuid(),
  phase: ProductionRolloutPhaseSchema,
  leaseId: z.string().uuid(),
  providerDeploymentId: z.string().min(1).max(255),
  revokedAt: TimestampSchema,
}).strict();
export type ProductionRevokedLease = z.infer<typeof ProductionRevokedLeaseSchema>;

export interface ProductionRolloutAdapter {
  observeProductionAction(input: {
    authority: ProductionRolloutAuthority;
    action: ProductionActionAcceptance;
    releaseIntent: ReleaseIntent;
  }): Promise<ProductionActionObservation>;
  dispatchProductionAction(input: {
    authority: ProductionRolloutAuthority;
    actionId: string;
    phase: 'expansion' | 'rollback';
    releaseIntent: ReleaseIntent;
    priorState: ProductionProviderState;
  }): Promise<ProductionActionAcceptance>;
  reconcileProductionAction(input: {
    authority: ProductionRolloutAuthority;
    actionId: string;
    phase: ProductionRolloutPhase;
    releaseIntent: ReleaseIntent;
    priorState: ProductionProviderState;
  }): Promise<ProductionActionAcceptance | null>;
  revokeProductionActionLease(input: {
    authority: ProductionRolloutAuthority;
    action: ProductionActionAcceptance;
  }): Promise<ProductionRevokedLease>;
}

const ProductionReceiptActionSchema = ProductionActionAcceptanceSchema.extend({
  observedAt: TimestampSchema,
  providerStatus: z.string().min(1).max(120),
  providerOutcome: z.enum(['healthy', 'unhealthy']),
}).strict();

export const ProductionRolloutReceiptSchema = z.object({
  schemaVersion: z.literal(PRODUCTION_ROLLOUT_RECEIPT_VERSION),
  receiptId: z.string().uuid(),
  operationId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  capability: z.literal('deploy.production'),
  operationIntentId: z.string().uuid(),
  releaseIntentDigest: DigestSchema,
  ciEvidenceDigest: DigestSchema,
  authorizationId: z.string().uuid(),
  externalGateEvidenceId: z.string().uuid().nullable(),
  target: z.object({
    providerId: z.string().min(1).max(80),
    bindingId: z.string().uuid(),
    projectUuid: z.string().uuid(),
    applicationUuid: z.string().uuid(),
    environmentUuid: z.string().uuid(),
  }).strict(),
  revision: z.object({
    sourceRevision: SourceRevisionSchema,
    imageDigest: DigestSchema,
  }).strict(),
  configurationBindingGeneration: z.number().int().positive(),
  bindingGeneration: z.number().int().positive(),
  providerDeploymentId: z.string().min(1).max(255),
  rolloutCohort: ReleaseRolloutCohortSchema,
  priorState: ProductionProviderStateSchema,
  actions: z.array(ProductionReceiptActionSchema).min(1).max(3),
  health: z.object({
    outcome: z.enum(['healthy', 'unhealthy']),
    evaluation: ProductionHealthEvaluationSchema,
  }).strict(),
  rollback: z.object({
    owner: ReleaseRollbackSchema.shape.owner,
    procedure: ReleaseRollbackSchema.shape.procedure,
    providerDeploymentId: z.string().min(1).max(255),
    restoredRevision: ProductionRevisionSchema,
    healthVerified: z.literal(true),
    completedAt: TimestampSchema,
  }).strict().nullable(),
  lease: z.object({
    leaseId: z.string().uuid(),
    revoked: z.literal(true),
    revokedAt: TimestampSchema,
  }).strict(),
  revokedLeases: z.array(ProductionRevokedLeaseSchema).min(1).max(3),
  settledAt: TimestampSchema,
}).strict().superRefine((receipt, context) => {
  const actionLeaseIds = new Set(receipt.actions.map((action) => action.leaseId));
  const revokedLeaseIds = new Set(receipt.revokedLeases.map((lease) => lease.leaseId));
  if (receipt.actions.length !== actionLeaseIds.size
    || receipt.revokedLeases.length !== revokedLeaseIds.size
    || actionLeaseIds.size !== revokedLeaseIds.size
    || [...actionLeaseIds].some((leaseId) => !revokedLeaseIds.has(leaseId))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['revokedLeases'],
      message: 'Every production action lease must be revoked exactly once',
    });
  }
  if (!revokedLeaseIds.has(receipt.lease.leaseId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lease', 'leaseId'],
      message: 'Primary deployment lease must appear in revoked lease lineage',
    });
  }
  const rollbackAction = receipt.actions.find((action) => action.phase === 'rollback');
  const rollbackRequired = receipt.health.evaluation.decision === 'abort'
    || receipt.actions.some((action) =>
      action.phase === 'expansion' && action.providerOutcome === 'unhealthy');
  if (rollbackRequired !== (receipt.rollback !== null)
    || (receipt.rollback !== null
      && rollbackAction?.providerDeploymentId !== receipt.rollback.providerDeploymentId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['rollback'],
      message: 'Abort or failed expansion requires the exact rollback action',
    });
  }
});
export type ProductionRolloutReceipt = z.infer<typeof ProductionRolloutReceiptSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function evidenceDigest(evidence: ProductionHealthEvidence): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update('rorca.production-health-evidence.v1\0')
    .update(canonicalJson(evidence))
    .digest('hex')}`;
}

function sampleOrder(left: ProductionHealthSample, right: ProductionHealthSample): number {
  if (left.sampledAt !== right.sampledAt) return left.sampledAt < right.sampledAt ? -1 : 1;
  if (left.signalId !== right.signalId) return left.signalId < right.signalId ? -1 : 1;
  if (left.evidenceKey !== right.evidenceKey) return left.evidenceKey < right.evidenceKey ? -1 : 1;
  return left.value - right.value;
}

function aggregate(
  signal: ReleaseIntent['healthSignals'][number],
  samples: readonly ProductionHealthSample[],
): number {
  const values = samples.map((sample) => sample.value);
  switch (signal.aggregation) {
    case 'latest': return values[values.length - 1]!;
    case 'minimum': return Math.min(...values);
    case 'maximum': return Math.max(...values);
    case 'average': return values.reduce((sum, value) => sum + value, 0) / values.length;
    case 'sum': return values.reduce((sum, value) => sum + value, 0);
  }
}

function compare(value: number, operator: ReleaseIntent['abortConditions'][number]['operator'], threshold: number): boolean {
  switch (operator) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    case 'neq': return value !== threshold;
  }
}

export function productionCohortsMatch(
  left: ReleaseIntent['rolloutCohort'],
  right: ReleaseIntent['rolloutCohort'],
): boolean {
  const parsedLeft = ReleaseRolloutCohortSchema.parse(left);
  const parsedRight = ReleaseRolloutCohortSchema.parse(right);
  return parsedLeft.cohortId === parsedRight.cohortId
    && parsedLeft.percentage === parsedRight.percentage
    && parsedLeft.selectorDigest === parsedRight.selectorDigest;
}

/**
 * Evaluates only supplied immutable evidence. No wall clock or provider read is
 * consulted, sample order is canonicalized, and every threshold/window/value
 * used for the decision is retained in the result.
 */
export function evaluateProductionHealth(
  rawIntent: ReleaseIntent,
  rawEvidence: ProductionHealthEvidence,
): ProductionHealthEvaluation {
  const intent = ReleaseIntentSchema.parse(rawIntent);
  const parsedEvidence = ProductionHealthEvidenceSchema.parse(rawEvidence);
  const samples = [...parsedEvidence.samples].sort(sampleOrder);
  const signalById = new Map(intent.healthSignals.map((signal) => [signal.signalId, signal]));

  for (const sample of samples) {
    const signal = signalById.get(sample.signalId);
    if (!signal || signal.source !== sample.source || signal.evidenceKey !== sample.evidenceKey) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['samples'],
        message: `Health sample ${sample.signalId} does not match a declared signal`,
        input: sample,
      }]);
    }
    if (Date.parse(sample.sampledAt) > Date.parse(parsedEvidence.observedAt)) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['samples', sample.signalId, 'sampledAt'],
        message: 'Health samples cannot postdate the evidence observation',
        input: sample.sampledAt,
      }]);
    }
  }

  const conditions = intent.abortConditions.map((condition) => {
    const signal = signalById.get(condition.signalId)!;
    const windowEndedAt = parsedEvidence.observedAt;
    const windowStartedAt = new Date(
      Date.parse(windowEndedAt) - condition.observationWindowSeconds * 1000,
    ).toISOString();
    const inputSamples = samples.filter((sample) =>
      sample.signalId === condition.signalId
      && Date.parse(sample.sampledAt) >= Date.parse(windowStartedAt)
      && Date.parse(sample.sampledAt) <= Date.parse(windowEndedAt));
    const aggregatedValue = inputSamples.length >= condition.requiredSamples
      ? aggregate(signal, inputSamples)
      : null;
    return {
      ...condition,
      windowStartedAt,
      windowEndedAt,
      inputSamples,
      aggregatedValue,
      triggered: aggregatedValue === null
        ? null
        : compare(aggregatedValue, condition.operator, condition.threshold),
    };
  });
  const decision = parsedEvidence.providerOutcome === 'unhealthy'
    || conditions.some((condition) => condition.triggered === true)
    ? 'abort'
    : parsedEvidence.providerOutcome === 'pending'
      || conditions.some((condition) => condition.triggered === null)
      ? 'pending'
      : 'expand';

  return ProductionHealthEvaluationSchema.parse({
    schemaVersion: PRODUCTION_HEALTH_EVALUATION_VERSION,
    evidenceDigest: evidenceDigest({ ...parsedEvidence, samples }),
    providerDeploymentId: parsedEvidence.providerDeploymentId,
    rolloutCohort: parsedEvidence.rolloutCohort,
    providerStatus: parsedEvidence.providerStatus,
    providerOutcome: parsedEvidence.providerOutcome,
    signals: intent.healthSignals.map((signal) => ({
      ...signal,
      inputSamples: samples.filter((sample) => sample.signalId === signal.signalId),
    })),
    conditions,
    decision,
    evaluatedAt: parsedEvidence.observedAt,
  });
}
