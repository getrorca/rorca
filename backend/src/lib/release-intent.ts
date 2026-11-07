/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ForbiddenError } from './errors';

export const RELEASE_INTENT_SCHEMA_VERSION = 'rorca.release-intent.v1' as const;
export const RELEASE_INTENT_PROVENANCE_VERSION = 'rorca.release-intent-provenance.v1' as const;
export const OPERATION_INTENT_PROJECTION_VERSION = 'rorca.operation-intent-projection.v1' as const;
export const OPERATION_INTENT_GRANT_VERSION = 'rorca.operation-intent-grant.v1' as const;
export const RELEASE_INTENT_VALIDATION_VERSION = 'rorca.release-intent-validation.v1' as const;

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SourceRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const SafeIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/);
const UtcTimestampSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}


function sortCanonical<T>(values: T[]): T[] {
  return values.sort((left, right) => {
    const leftCanonical = canonicalJson(left);
    const rightCanonical = canonicalJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
}

function digestSetSchema(minimum = 0) {
  return z.array(Sha256DigestSchema).min(minimum).max(128).superRefine((values, context) => {
    if (!unique(values)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Digest entries must be unique' });
    }
  }).transform((values) => values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
}

export const ReleaseArtifactSetSchema = z.object({
  artifactDigests: digestSetSchema(1),
  imageDigests: digestSetSchema(1),
}).strict();

export const ReleaseRolloutCohortSchema = z.object({
  cohortId: SafeIdentifierSchema,
  percentage: z.number().int().min(1).max(100),
  selectorDigest: Sha256DigestSchema,
}).strict();

export const ReleaseChangeWindowSchema = z.object({
  startsAt: UtcTimestampSchema,
  endsAt: UtcTimestampSchema,
}).strict().superRefine((window, context) => {
  if (Date.parse(window.endsAt) <= Date.parse(window.startsAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'Change window must end after it starts',
    });
  }
});

export const ProviderApprovalReferenceSchema = z.object({
  provider: SafeIdentifierSchema,
  approvalId: SafeIdentifierSchema,
  environment: SafeIdentifierSchema,
  evidenceDigest: Sha256DigestSchema,
}).strict();

export const ReleaseRollbackSchema = z.object({
  owner: SafeIdentifierSchema,
  procedure: z.object({
    procedureId: SafeIdentifierSchema,
    procedureDigest: Sha256DigestSchema,
  }).strict(),
}).strict();

export const ReleaseHealthSignalSchema = z.object({
  signalId: SafeIdentifierSchema,
  source: z.enum(['deployment', 'application', 'metrics']),
  evidenceKey: SafeIdentifierSchema,
  aggregation: z.enum(['latest', 'minimum', 'maximum', 'average', 'sum']),
  unit: SafeIdentifierSchema,
}).strict();

export const ReleaseAbortConditionSchema = z.object({
  conditionId: SafeIdentifierSchema,
  signalId: SafeIdentifierSchema,
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']),
  threshold: z.number().finite(),
  observationWindowSeconds: z.number().int().min(1).max(86_400),
  requiredSamples: z.number().int().min(1).max(100_000),
}).strict();

export const ReleaseIntentSchema = z.object({
  schemaVersion: z.literal(RELEASE_INTENT_SCHEMA_VERSION),
  sourceRevision: SourceRevisionSchema,
  artifacts: ReleaseArtifactSetSchema,
  migrationSetDigest: Sha256DigestSchema,
  configurationBindingGeneration: z.number().int().positive(),
  featureFlagDigest: Sha256DigestSchema,
  rolloutCohort: ReleaseRolloutCohortSchema,
  changeWindow: ReleaseChangeWindowSchema,
  providerApprovalReference: ProviderApprovalReferenceSchema,
  rollback: ReleaseRollbackSchema,
  healthSignals: z.array(ReleaseHealthSignalSchema).min(1).max(64).transform(sortCanonical),
  abortConditions: z.array(ReleaseAbortConditionSchema).min(1).max(128).transform(sortCanonical),
}).strict().superRefine((intent, context) => {
  const signalIds = intent.healthSignals.map((signal) => signal.signalId);
  if (!unique(signalIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['healthSignals'],
      message: 'Health signal ids must be unique',
    });
  }
  const conditionIds = intent.abortConditions.map((condition) => condition.conditionId);
  if (!unique(conditionIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['abortConditions'],
      message: 'Abort condition ids must be unique',
    });
  }
  for (const [index, condition] of intent.abortConditions.entries()) {
    if (!signalIds.includes(condition.signalId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['abortConditions', index, 'signalId'],
        message: 'Abort conditions must reference a declared health signal',
      });
    }
  }
});
export type ReleaseIntent = z.infer<typeof ReleaseIntentSchema>;

export const CiReleaseEvidenceSchema = z.object({
  provider: SafeIdentifierSchema,
  pipelineId: SafeIdentifierSchema,
  jobId: SafeIdentifierSchema,
  sourceRevision: SourceRevisionSchema,
  artifactDigest: Sha256DigestSchema,
  result: z.literal('passed'),
  evidenceDigest: Sha256DigestSchema,
  observedAt: UtcTimestampSchema,
}).strict();

export const ReleaseIntentProvenanceSchema = z.object({
  schemaVersion: z.literal(RELEASE_INTENT_PROVENANCE_VERSION),
  ciEvidence: z.array(CiReleaseEvidenceSchema).min(1).max(64).transform(sortCanonical),
  stagingReceiptDigests: digestSetSchema(1),
  attestationDigests: digestSetSchema(),
}).strict().superRefine((provenance, context) => {
  const evidenceKeys = provenance.ciEvidence.map((evidence) => [
    evidence.provider,
    evidence.pipelineId,
    evidence.jobId,
    evidence.evidenceDigest,
  ].join('\0'));
  if (!unique(evidenceKeys)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ciEvidence'],
      message: 'CI evidence entries must be unique',
    });
  }
});
export type ReleaseIntentProvenance = z.infer<typeof ReleaseIntentProvenanceSchema>;

export const CreateReleaseIntentSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  releaseIntent: ReleaseIntentSchema,
  provenance: ReleaseIntentProvenanceSchema,
}).strict();
export type CreateReleaseIntent = z.infer<typeof CreateReleaseIntentSchema>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Canonical JSON for a validated ReleaseIntent. Object keys and logical set
 * members sort lexically, timestamps are UTC-normalized, and the strict schemas
 * make absent or secret-bearing extension fields unrepresentable.
 */
export function canonicalReleaseIntent(input: CreateReleaseIntent): string {
  return canonicalJson(CreateReleaseIntentSchema.parse(input));
}

export function canonicalReleaseIntentCiEvidence(
  provenance: ReleaseIntentProvenance,
): string {
  return canonicalJson(ReleaseIntentProvenanceSchema.parse(provenance).ciEvidence);
}

function releaseDigest(domain: 'intent' | 'ci-evidence', value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(`rorca:${RELEASE_INTENT_SCHEMA_VERSION}:${domain}\n`, 'utf8')
    .update(value, 'utf8')
    .digest('hex')}`;
}

export function releaseIntentDigest(input: CreateReleaseIntent): `sha256:${string}` {
  return releaseDigest('intent', canonicalReleaseIntent(input));
}

export function releaseIntentCiEvidenceDigest(
  provenance: ReleaseIntentProvenance,
): `sha256:${string}` {
  return releaseDigest('ci-evidence', canonicalReleaseIntentCiEvidence(provenance));
}

export const OperationIntentProjectionSchema = z.object({
  schemaVersion: z.literal(OPERATION_INTENT_PROJECTION_VERSION),
  operationIntentId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  intentKind: z.literal('release'),
  intentDigest: Sha256DigestSchema,
  ciEvidenceDigest: Sha256DigestSchema,
  releaseIntent: ReleaseIntentSchema,
  provenance: ReleaseIntentProvenanceSchema,
  immutable: z.literal(true),
  createdBy: z.string().min(1).max(255),
  createdAt: UtcTimestampSchema,
}).strict();
export type OperationIntentProjection = z.infer<typeof OperationIntentProjectionSchema>;

export const OperationIntentGrantSchema = z.object({
  schemaVersion: z.literal(OPERATION_INTENT_GRANT_VERSION),
  grantId: z.string().uuid(),
  operationIntentId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  intentDigest: Sha256DigestSchema,
  ciEvidenceDigest: Sha256DigestSchema,
  issuedAt: UtcTimestampSchema,
  expiresAt: UtcTimestampSchema,
}).strict().superRefine((grant, context) => {
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Grant expiry must follow issuance',
    });
  }
});
export type OperationIntentGrant = z.infer<typeof OperationIntentGrantSchema>;

export const ReleaseIntentValidationSchema = z.object({
  schemaVersion: z.literal(RELEASE_INTENT_VALIDATION_VERSION),
  valid: z.literal(true),
  operationIntentId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  intentDigest: Sha256DigestSchema,
  ciEvidenceDigest: Sha256DigestSchema,
  grantId: z.string().uuid(),
  grantExpiresAt: UtcTimestampSchema,
}).strict();
export type ReleaseIntentValidation = z.infer<typeof ReleaseIntentValidationSchema>;

export function validateReleaseIntentGrant(
  projectionInput: OperationIntentProjection,
  grantInput: OperationIntentGrant,
  now = new Date(),
): ReleaseIntentValidation {
  const projection = OperationIntentProjectionSchema.parse(projectionInput);
  const grant = OperationIntentGrantSchema.parse(grantInput);
  const matches = grant.operationIntentId === projection.operationIntentId
    && grant.workspaceId === projection.workspaceId
    && grant.intentDigest === projection.intentDigest
    && grant.ciEvidenceDigest === projection.ciEvidenceDigest;
  if (!matches) {
    throw new ForbiddenError('Authorization grant does not bind the exact release intent and CI evidence');
  }
  if (Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new ForbiddenError('Authorization grant has expired');
  }
  return ReleaseIntentValidationSchema.parse({
    schemaVersion: RELEASE_INTENT_VALIDATION_VERSION,
    valid: true,
    operationIntentId: projection.operationIntentId,
    workspaceId: projection.workspaceId,
    intentDigest: projection.intentDigest,
    ciEvidenceDigest: projection.ciEvidenceDigest,
    grantId: grant.grantId,
    grantExpiresAt: grant.expiresAt,
  });
}
