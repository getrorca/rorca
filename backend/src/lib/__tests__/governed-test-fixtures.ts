/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { governedHash } from '../governed-contracts';

export const H = `sha256:${'a'.repeat(64)}`;
export const GOVERNED_PATHS=['backend/src/lib/governed-mission-service.ts'];
export const EVIDENCE_OBLIGATION_MANIFEST=[{kind:'automated-test',minimumTrust:'host_observed',requiredStatus:'passed',obligationHash:H}];
export const EVIDENCE_OBLIGATION_MANIFEST_HASH=governedHash('rorca.evidence-obligation-manifest.v1',EVIDENCE_OBLIGATION_MANIFEST);
export const SPEC = { specId: 'spec:wave-two', specVersion: 1, specHash: H, canonicalSpecPath: 'forge/specs/pending/wave-two.json', storyId: 'W2-001', storyVersion: 1, storyHash: H, criteriaManifestHash: H };
export const REPOSITORY = { repositoryId: 'repo:one', remoteAuthorityHash: H, gitObjectFormat: 'sha1' as const, baseSha: 'a'.repeat(40), currentSha: 'b'.repeat(40), expectedHeadSha: 'b'.repeat(40), worktreeId: 'worktree:one', allowedPathManifestHash: H, requiredPathManifestHash: H, changedPathManifestHash: H, forbiddenPathManifestHash: H };
const header = { contractVersion: '1.0.0', contentHash: H, createdAt: '2026-07-29T00:00:00.000Z', createdBy: 'human:one' };
const MISSION_SEED = { ...header, schemaVersion: 'rorca.mission-contract.v1', contractId: 'rorca.mission-contract.v1', artifactId: 'mission-artifact:one', missionId: 'mission:one', missionRevision: 1, missionHash: H, workspaceId: 'workspace:wave-two', canonicalSpec: SPEC,
  requirements: { ids: ['REQ-001'], hash: H }, criteria: { ids: ['W2-001:criterion:1'], hash: H }, objectivesHash: H,
  invariantsHash: H, constraintsHash: H, prohibitedOutcomesHash: H, evidenceObligationsHash: EVIDENCE_OBLIGATION_MANIFEST_HASH, completionDefinitionHash: H,
  repository: REPOSITORY, compiler: { id: 'compiler:one', revision: 1, hash: H }, policy: { id: 'policy:one', revision: 1, hash: H },
  contextPolicyDefinition: { id: 'context-policy:one', revision: 1, hash: H }, approvedDecisionReferences: ['decision:one'],
  allowedExecutionPosture: { sequential: true, branchOnly: true, autoMerge: false, deployment: false, providerMutation: false, execution: 'execute_bounded' as const },
  directionLayerHashes: [H], sourceManifestHash: H, creationProvenanceHash: H };
export function withMissionIntegrity<T extends typeof MISSION_SEED>(value: T): T {
  const canonicalHash = governedHash('rorca.mission-contract.integrity.v1',
    Object.fromEntries(Object.entries(value).filter(([key]) => !['contentHash', 'missionHash'].includes(key))));
  return { ...value, contentHash: canonicalHash, missionHash: canonicalHash };
}
export const MISSION = withMissionIntegrity(MISSION_SEED);
const WORK_PACKAGE_SEED = { ...header, schemaVersion: 'rorca.work-package.v1', contractId: 'rorca.work-package.v1', artifactId: 'work-package-artifact:one', workspaceId: MISSION.workspaceId,
  missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash, workPackageId: 'work-package:one', workPackageRevision: 1,
  workPackageHash: H, spec: SPEC, objectiveHash: H, dependencies: [], repository: REPOSITORY,
  allowedPaths: GOVERNED_PATHS, requiredPaths: GOVERNED_PATHS,
  validationObligationsHash: H, evidenceObligationsHash: EVIDENCE_OBLIGATION_MANIFEST_HASH,
  executionPostureHash: governedHash('rorca.mission-execution-posture.v1',MISSION.allowedExecutionPosture), lifecycleProjectionRef: 'lifecycle:one',
  authorityCeilings: { delivery: 'none' as const, operational: 'none' as const, knowledge: 'observe' as const, interactive: 'none' as const },
  resourceLimitsHash: H, retryLimit: 2, planRevision: 1, state: 'accepted' as const, proposalId: 'proposal:initial' };
export function withWorkPackageIntegrity<T extends typeof WORK_PACKAGE_SEED>(value: T): T {
  const canonicalHash = governedHash('rorca.work-package.integrity.v1',
    Object.fromEntries(Object.entries(value).filter(([key]) => !['contentHash', 'workPackageHash'].includes(key))));
  return { ...value, contentHash: canonicalHash, workPackageHash: canonicalHash };
}
export const WORK_PACKAGE = withWorkPackageIntegrity(WORK_PACKAGE_SEED);
export function lease(leaseId: string, runtimeId: string) { return { ...header, schemaVersion: 'rorca.execution-lease.v1', contractId: 'rorca.execution-lease.v1', artifactId: `lease-artifact:${leaseId.split(':').pop()}`,
  workspaceId: MISSION.workspaceId, missionId: MISSION.missionId, missionRevision: 1, missionHash: MISSION.missionHash,
  workPackageId: WORK_PACKAGE.workPackageId, workPackageRevision: 1, workPackageHash: WORK_PACKAGE.workPackageHash, spec: SPEC,
  leaseId, attemptId: 'attempt:one', runId: 1, fencingToken: 1, runtimeId, runtimeCapabilityRevision: 1, repository: REPOSITORY,
  policyDefinitionId: 'context-policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H,
  policyActivationId: 'activation:one', policyActivationRevision: 1, policyActivationHash: H,
  checkpointId: 'checkpoint:one', checkpointHash: H, bundleId: 'bundle:one', bundleHash: H, cancellationId: 'cancellation:one',
  issuedAt: '2026-07-29T00:00:00.000Z', observedAt: '2026-07-29T00:00:00.000Z', expiresAt: '2026-07-29T00:10:00.000Z',
  resourceLimitsHash: H, evidenceObligationDigest: EVIDENCE_OBLIGATION_MANIFEST_HASH,
  authorityCeilings: { mutation: 'execute_bounded' as const, delivery: 'none' as const, operational: 'none' as const, knowledge: 'observe' as const, interactive: 'none' as const },
  state: 'proposed' as const, reasonCode: 'requested' }; }
export const CONTEXT = { principalId: 'human:one', authoritySource: 'local_admin' as const, idempotencyKey: 'idempotency:one', correlationId: 'correlation:one' };
