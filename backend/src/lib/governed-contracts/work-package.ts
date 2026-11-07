/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { z } from 'zod';
import {
  ArtifactHeaderSchema, AuthorityCeilingSchema, CanonicalSpecScopeSchema, CanonicalTimestampSchema,
  RepositoryScopeSchema, SafeRelativePathSchema, Sha256Schema, StableIdSchema,
} from './primitives';

export const WorkPackageV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.work-package.v1'), contractId: z.literal('rorca.work-package.v1'),
  workspaceId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(), missionHash: Sha256Schema,
  workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(), workPackageHash: Sha256Schema,
  spec: CanonicalSpecScopeSchema, objectiveHash: Sha256Schema,
  dependencies: z.array(z.object({ workPackageId: StableIdSchema, revision: z.number().int().positive(), hash: Sha256Schema }).strict()).max(100),
  repository: RepositoryScopeSchema,
  allowedPaths: z.array(SafeRelativePathSchema).max(500), requiredPaths: z.array(SafeRelativePathSchema).max(500),
  validationObligationsHash: Sha256Schema, evidenceObligationsHash: Sha256Schema,
  executionPostureHash: Sha256Schema, lifecycleProjectionRef: StableIdSchema,
  authorityCeilings: z.object({
    delivery: AuthorityCeilingSchema, operational: AuthorityCeilingSchema,
    knowledge: AuthorityCeilingSchema, interactive: AuthorityCeilingSchema,
  }).strict(),
  resourceLimitsHash: Sha256Schema, retryLimit: z.number().int().min(0).max(5), planRevision: z.number().int().positive(),
  state: z.enum(['proposed', 'accepted', 'active', 'superseded', 'cancelled']), proposalId: StableIdSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.dependencies.map((item) => item.workPackageId)).size !== value.dependencies.length) ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'duplicate dependency' });
  if (value.dependencies.some((item) => item.workPackageId === value.workPackageId)) ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'self dependency' });
});

export const ExecutionLeaseV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.execution-lease.v1'), contractId: z.literal('rorca.execution-lease.v1'),
  workspaceId: StableIdSchema, missionId: StableIdSchema, missionRevision: z.number().int().positive(), missionHash: Sha256Schema,
  workPackageId: StableIdSchema, workPackageRevision: z.number().int().positive(), workPackageHash: Sha256Schema,
  spec: CanonicalSpecScopeSchema, leaseId: StableIdSchema, attemptId: StableIdSchema,
  runId: z.union([z.number().int().positive(), StableIdSchema]), fencingToken: z.number().int().positive(),
  runtimeId: StableIdSchema, runtimeCapabilityRevision: z.number().int().positive(), repository: RepositoryScopeSchema,
  policyDefinitionId: StableIdSchema, policyDefinitionVersion: z.string(), policyDefinitionHash: Sha256Schema,
  policyActivationId: StableIdSchema, policyActivationRevision: z.number().int().positive(), policyActivationHash: Sha256Schema,
  checkpointId: StableIdSchema, checkpointHash: Sha256Schema, bundleId: StableIdSchema, bundleHash: Sha256Schema,
  cancellationId: StableIdSchema, issuedAt: CanonicalTimestampSchema, observedAt: CanonicalTimestampSchema,
  expiresAt: CanonicalTimestampSchema, resourceLimitsHash: Sha256Schema, evidenceObligationDigest: Sha256Schema,
  authorityCeilings: z.object({
    mutation: AuthorityCeilingSchema, delivery: AuthorityCeilingSchema, operational: AuthorityCeilingSchema,
    knowledge: AuthorityCeilingSchema, interactive: AuthorityCeilingSchema,
  }).strict(),
  state: z.enum(['proposed', 'active', 'released', 'expired', 'cancelled', 'superseded']), reasonCode: StableIdSchema,
}).strict().refine((value) => Date.parse(value.expiresAt) > Date.parse(value.issuedAt), { path: ['expiresAt'], message: 'lease must expire after issue' });

export const CancellationV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.cancellation.v1'), contractId: z.literal('rorca.cancellation.v1'),
  workspaceId: StableIdSchema, cancellationId: StableIdSchema, requesterAuthorityRef: StableIdSchema,
  reasonCode: StableIdSchema, attemptId: StableIdSchema, leaseId: StableIdSchema, fencingToken: z.number().int().positive(),
  requestedAt: CanonicalTimestampSchema, deadlineAt: CanonicalTimestampSchema,
  acknowledgementId: StableIdSchema.nullable(), acknowledgedAt: CanonicalTimestampSchema.nullable(),
  disposition: z.enum(['requested', 'acknowledged', 'graceful', 'forced_expiry', 'lost_runtime', 'conflicted']),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.deadlineAt) <= Date.parse(value.requestedAt)) ctx.addIssue({ code: 'custom', path: ['deadlineAt'], message: 'cancellation deadline must follow request time' });
  const acknowledgementPresent = Boolean(value.acknowledgementId && value.acknowledgedAt);
  if ((value.disposition === 'requested' && acknowledgementPresent) || (value.disposition !== 'requested' && !acknowledgementPresent)) ctx.addIssue({ code: 'custom', path: ['acknowledgementId'], message: 'acknowledgement identity/time must match disposition' });
});

export const PlanChangeProposalV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.plan-change-proposal.v1'), contractId: z.literal('rorca.plan-change-proposal.v1'),
  workspaceId: StableIdSchema, missionId: StableIdSchema, workPackageId: StableIdSchema,
  attemptId: StableIdSchema, leaseId: StableIdSchema, fencingToken: z.number().int().positive(), policyActivationHash: Sha256Schema,
  baseRevision: z.number().int().positive(), baseHash: Sha256Schema, proposalId: StableIdSchema,
  diffHash: Sha256Schema, rationale: z.string().min(1).max(4000), impactHash: Sha256Schema,
  requestedPaths: z.array(SafeRelativePathSchema).max(500), dependencyManifestHash: Sha256Schema,
  validationManifestHash: Sha256Schema, proposerRuntimeId: StableIdSchema,
  requestsMergeAuthority: z.literal(false), requestsDeploymentAuthority: z.literal(false),
  state: z.enum(['proposed', 'under_review', 'accepted', 'rejected', 'stale']),
}).strict();

export type WorkPackageV1 = z.infer<typeof WorkPackageV1Schema>;
export type ExecutionLeaseV1 = z.infer<typeof ExecutionLeaseV1Schema>;
