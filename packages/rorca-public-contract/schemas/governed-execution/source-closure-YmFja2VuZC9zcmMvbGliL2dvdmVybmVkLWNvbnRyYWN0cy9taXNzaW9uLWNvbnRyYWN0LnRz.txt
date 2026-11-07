/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { z } from 'zod';
import {
  ArtifactHeaderSchema, AuthorityCeilingSchema, CanonicalSpecScopeSchema, ExactRevisionRefSchema,
  FullGitShaSchema, RepositoryScopeSchema, Sha256Schema, StableIdSchema,
} from './primitives';

const TextManifestSchema = z.object({
  ids: z.array(StableIdSchema).min(1).max(500), hash: Sha256Schema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.ids).size !== value.ids.length) ctx.addIssue({ code: 'custom', path: ['ids'], message: 'duplicate identifiers are forbidden' });
});

export const MissionContractV1Schema = ArtifactHeaderSchema.extend({
  schemaVersion: z.literal('rorca.mission-contract.v1'), contractId: z.literal('rorca.mission-contract.v1'),
  missionId: StableIdSchema, missionRevision: z.number().int().positive(), missionHash: Sha256Schema,
  workspaceId: StableIdSchema, canonicalSpec: CanonicalSpecScopeSchema,
  requirements: TextManifestSchema, criteria: TextManifestSchema,
  objectivesHash: Sha256Schema, invariantsHash: Sha256Schema, constraintsHash: Sha256Schema,
  prohibitedOutcomesHash: Sha256Schema, evidenceObligationsHash: Sha256Schema,
  completionDefinitionHash: Sha256Schema,
  repository: RepositoryScopeSchema,
  compiler: ExactRevisionRefSchema, policy: ExactRevisionRefSchema,
  contextPolicyDefinition: ExactRevisionRefSchema,
  approvedDecisionReferences: z.array(StableIdSchema).max(100),
  allowedExecutionPosture: z.object({
    sequential: z.literal(true), branchOnly: z.literal(true), autoMerge: z.literal(false),
    deployment: z.literal(false), providerMutation: z.literal(false),
    execution: AuthorityCeilingSchema,
  }).strict(),
  directionLayerHashes: z.array(Sha256Schema).max(5), sourceManifestHash: Sha256Schema,
  creationProvenanceHash: Sha256Schema,
}).strict();

export const MissionVersionNegotiationSchema = z.object({
  readerSupportedMajors: z.array(z.number().int().positive()).min(1),
  readerSupportedMinorByMajor: z.record(z.string(), z.number().int().nonnegative()),
  writerVersion: z.string().regex(/^1\.[0-9]+\.[0-9]+$/),
  readOldWriteCurrent: z.literal(true), unsupportedMajorBehavior: z.literal('fail_closed'),
}).strict();

export const MissionAmendmentSchema = z.object({
  workspaceId: StableIdSchema, missionId: StableIdSchema, expectedRevision: z.number().int().positive(),
  expectedMissionHash: Sha256Schema, nextRevision: z.number().int().positive(),
  canonicalSpecHash: Sha256Schema, baseSha: FullGitShaSchema, amendmentReason: z.string().min(1).max(2000),
  compatibilityDecision: z.enum(['stale_all', 'explicit_compatible_subset']),
  compatibleEvidenceIds: z.array(StableIdSchema).max(500), authorityReceiptId: StableIdSchema,
}).strict().refine((value) => value.nextRevision === value.expectedRevision + 1, { path: ['nextRevision'], message: 'next revision must increment by one' });

export type MissionContractV1 = z.infer<typeof MissionContractV1Schema>;
