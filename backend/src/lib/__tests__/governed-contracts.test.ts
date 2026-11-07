/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  assertNoForbiddenGovernedFields, contextEpochProjectionId, CONTINUATION_TRIGGER_TYPES,
  ContextPolicyDefinitionV1Schema, governedCanonicalBytes, governedHash, isGovernedTransitionAllowed,
  MissionContractV1Schema, negotiateGovernedContractVersion, TriggerMaterialSchema,
} from '../governed-contracts';

const h = `sha256:${'a'.repeat(64)}`;
const id = 'artifact:one';
const header = { contractVersion: '1.0.0', artifactId: id, contentHash: h, createdAt: '2026-07-29T00:00:00.000Z', createdBy: 'human:one' };
const spec = { specId: 'spec:one', specVersion: 1, specHash: h, canonicalSpecPath: 'forge/specs/pending/spec.json', storyId: 'W2-001', storyVersion: 1, storyHash: h, criteriaManifestHash: h };
const repository = { repositoryId: 'repo:one', remoteAuthorityHash: h, gitObjectFormat: 'sha1' as const, baseSha: 'a'.repeat(40), currentSha: 'b'.repeat(40), expectedHeadSha: 'b'.repeat(40), worktreeId: 'worktree:one', allowedPathManifestHash: h, requiredPathManifestHash: h, changedPathManifestHash: h, forbiddenPathManifestHash: h };

const triggers: Record<string, unknown> = {
  initial_dispatch: { type: 'initial_dispatch', launchRequestId: id, launchRequestHash: h, engineRequestId: 'engine:one', engineRequestHash: h, sourceManifestHash: h },
  successful_compaction: { type: 'successful_compaction', compactionId: 'compaction:one', startEventId: 'event:start', startEventHash: h, endEventId: 'event:end', endEventHash: h, status: 'success', aborted: false, willRetry: false, resultHash: h, summaryHash: h, originatingTurnId: 'turn:one', originatingTurnAttempt: 1, originatingGeneration: 1, settledEventId: 'event:settled', settledEventHash: h, retry: { retryCycleId: 'not_applicable', phase: 'none', attempt: 0, maximum: 0, startEventHash: 'not_applicable', endEventHash: 'not_applicable', settledEventHash: 'not_applicable', generation: 1 }, candidate: { state: 'absent', hash: 'not_applicable' } },
  generation_restart: { type: 'generation_restart', priorControllerGeneration: 1, newControllerGeneration: 2, priorRuntimeGeneration: 1, newRuntimeGeneration: 2, processGroupHash: h, reasonCode: 'restart', evidenceHash: h, priorWriterDeathReceiptHash: h },
  story_wave_transition: { type: 'story_wave_transition', fromStoryHash: h, toStoryHash: h, fromWaveHash: h, toWaveHash: h, authorityReceiptHash: h },
  material_file_scope_change: { type: 'material_file_scope_change', priorAllowedHash: h, currentAllowedHash: h, priorRequiredHash: h, currentRequiredHash: h, priorChangedHash: h, currentChangedHash: h, priorForbiddenHash: h, currentForbiddenHash: h, gitStatusHash: h, diffHash: h },
  validation_root_cause_change: { type: 'validation_root_cause_change', priorValidationHash: h, currentValidationHash: h, priorRootCauseClass: 'unknown', currentRootCauseClass: 'code', priorRootCauseHash: h, currentRootCauseHash: h, changedReferencesHash: h },
  meaningful_retry: { type: 'meaningful_retry', previewHash: h, receiptHash: h, priorAttempt: 1, newAttempt: 2, priorGeneration: 1, newGeneration: 2, failedScopeHash: h, changedSourceVectorHash: h },
  ttl_or_source_staleness: { type: 'ttl_or_source_staleness', priorBundleId: 'bundle:one', priorBundleHash: h, priorExpiry: '2026-07-29T00:00:00.000Z', observedAt: '2026-07-29T00:01:00.000Z', requiredSourceManifestHash: h, advisorySourceManifestHash: h },
  explicit_missing_context: { type: 'explicit_missing_context', requestId: 'request:one', requestHash: h, eventId: 'event:one', eventHash: h, reasonCode: 'missing', missingRequiredManifestHash: h },
};

test('LP1 is deterministic, byte-length prefixed, Unicode-normalized, and collision resistant', () => {
  const first = governedHash('test', { b: 'x:y', a: ['é', 2, true, null] });
  const second = governedHash('test', { a: ['e\u0301', 2, true, null], b: 'x:y' });
  expect(first).toBe(second);
  expect(governedHash('test', { a: 'b:c' })).not.toBe(governedHash('test', { a: 'b', c: '' }));
  expect(governedCanonicalBytes('test', { a: 'é' }).toString()).toContain('2:é');
  expect(() => governedHash('test', { amount: 1.5 })).toThrow('safe integers');
});

test('forbidden epoch, secret, prompt, transcript, and authority payloads reject recursively', () => {
  for (const candidate of [
    { contextEpoch: 'legacy' }, { nested: { legacyEpochId: 'ctxe_x' } },
    { password: 'value' }, { value: 'api_key=canary-secret' }, { rawPrompt: 'do work' }, { humanSignature: 'bytes' },
  ]) expect(() => assertNoForbiddenGovernedFields(candidate)).toThrow(/forbidden/);
  expect(() => assertNoForbiddenGovernedFields({ checkpointId: 'safe', advisoryMemory: [], tokenAccounting: { total: 12 },
    authorizationExpiresAt: '2026-07-29T00:01:00.000Z' })).not.toThrow();
  expect(() => assertNoForbiddenGovernedFields({ authorization: 'Bearer canary' })).toThrow(/forbidden/);
});

test('MissionContract is strict, full-SHA-bound, duplicate-safe, and non-authoritative inputs are excluded', () => {
  const mission = {
    ...header, schemaVersion: 'rorca.mission-contract.v1', contractId: 'rorca.mission-contract.v1',
    missionId: 'mission:one', missionRevision: 1, missionHash: h, workspaceId: 'workspace:one', canonicalSpec: spec,
    requirements: { ids: ['REQ-001'], hash: h }, criteria: { ids: ['W2-001:criterion:1'], hash: h },
    objectivesHash: h, invariantsHash: h, constraintsHash: h, prohibitedOutcomesHash: h, evidenceObligationsHash: h,
    completionDefinitionHash: h, repository, compiler: { id: 'compiler:one', revision: 1, hash: h },
    policy: { id: 'policy:one', revision: 1, hash: h }, contextPolicyDefinition: { id: 'context-policy:one', revision: 1, hash: h },
    approvedDecisionReferences: ['decision:one'], allowedExecutionPosture: { sequential: true, branchOnly: true, autoMerge: false, deployment: false, providerMutation: false, execution: 'execute_bounded' },
    directionLayerHashes: [h], sourceManifestHash: h, creationProvenanceHash: h,
  };
  expect(MissionContractV1Schema.parse(mission).missionId).toBe('mission:one');
  expect(MissionContractV1Schema.safeParse({ ...mission, memorySaysApproved: true }).success).toBe(false);
  expect(MissionContractV1Schema.safeParse({ ...mission, repository: { ...repository, baseSha: 'abc' } }).success).toBe(false);
  expect(MissionContractV1Schema.safeParse({ ...mission, requirements: { ids: ['REQ-001', 'REQ-001'], hash: h } }).success).toBe(false);
});

test('all nine typed triggers parse and cross-trigger/compaction ambiguity fails closed', () => {
  expect(Object.keys(triggers).sort()).toEqual([...CONTINUATION_TRIGGER_TYPES].sort());
  for (const type of CONTINUATION_TRIGGER_TYPES) expect(TriggerMaterialSchema.safeParse(triggers[type]).success).toBe(true);
  expect(TriggerMaterialSchema.safeParse({ ...triggers.successful_compaction as object, aborted: true }).success).toBe(false);
  expect(TriggerMaterialSchema.safeParse({ ...triggers.successful_compaction as object, willRetry: true }).success).toBe(false);
  expect(TriggerMaterialSchema.safeParse({ ...triggers.successful_compaction as object, candidate: { state: 'controller_validated', hash: h } }).success).toBe(false);
  expect(TriggerMaterialSchema.safeParse({ ...triggers.initial_dispatch as object, retryPreviewHash: h }).success).toBe(false);
});

test('policy definition is immutable-scope only and enforces hard maxima', () => {
  const policy = { schemaVersion: 'rorca.context-continuation-policy-definition.v1', contractId: 'rorca.context-continuation-policy-definition.v1', contractVersion: '1.0.0', policyDefinitionId: 'policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: h, issuerAuthorityRef: 'human:one', supportedVersions: ['1.0.0'], triggerRulesHash: h, sourceAllowlistHash: h, redactionPolicyHash: h, limits: { totalTokens: 64000, requiredTokens: 48000, advisoryTokens: 8000, instructionTokens: 8000, requiredSources: 500, advisoryItems: 50, serializedBytes: 4194304, ttlMinutes: 60, deltaChain: 8, retrievalAttempts: 5, transportReconciliations: 3 }, lifecycleState: 'published', createdAt: '2026-07-29T00:00:00.000Z', createdBy: 'human:one' };
  expect(ContextPolicyDefinitionV1Schema.safeParse(policy).success).toBe(true);
  expect(ContextPolicyDefinitionV1Schema.safeParse({ ...policy, cursor: 1 }).success).toBe(false);
  expect(ContextPolicyDefinitionV1Schema.safeParse({ ...policy, limits: { ...policy.limits, totalTokens: 64001 } }).success).toBe(false);
});

test('version negotiation and state transitions are explicit and fail closed', () => {
  expect(negotiateGovernedContractVersion({ readerVersion: '1.2.0', artifactVersion: '1.1.0', currentWriterVersion: '1.2.0' })).toMatchObject({ accepted: true, mode: 'read_older_minor' });
  expect(negotiateGovernedContractVersion({ readerVersion: '1.0.0', artifactVersion: '1.1.0' })).toEqual({ accepted: false, reason: 'reader_too_old' });
  expect(negotiateGovernedContractVersion({ readerVersion: '2.0.0', artifactVersion: '1.0.0' })).toEqual({ accepted: false, reason: 'unsupported_major' });
  expect(isGovernedTransitionAllowed('lease', 'active', 'expired')).toBe(true);
  expect(isGovernedTransitionAllowed('lease', 'expired', 'active')).toBe(false);
});

test('public governed contract has an independently buildable non-private package entry', () => {
  const packageRoot = path.resolve(__dirname, '../../../../packages/rorca-public-contract');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as any;
  expect(manifest).toEqual(expect.objectContaining({ version: '1.0.0', private: false, main: expect.stringContaining('dist/') }));
  expect(manifest.exports['.'].types).toContain('governed-execution.d.ts');
  expect(fs.readFileSync(path.join(packageRoot, 'tsconfig.build.json'), 'utf8')).toContain('CommonJS');
  expect(fs.readFileSync(path.join(packageRoot, 'src/governed-execution.ts'), 'utf8')).toContain("backend/src/lib/governed-contracts");
});

test('ContextEpoch identity is exact projection-only and component changes alter it', () => {
  const fields = { checkpointId: 'checkpoint:one', checkpointVersion: 1, checkpointHash: h, policyDefinitionId: 'policy:one', policyDefinitionVersion: '1.0.0', policyDefinitionHash: h, policyActivationId: 'activation:one', policyActivationRevision: 1, policyActivationHash: h, retrievalReceiptId: 'receipt:one', retrievalReceiptVersion: 1, retrievalReceiptHash: h, contextBundleId: 'bundle:one', contextBundleVersion: 1, contextBundleHash: h, continuationDispatchId: 'not_applicable' as const, continuationDispatchVersion: 'not_applicable' as const, continuationDispatchHash: 'not_applicable' as const };
  const first = contextEpochProjectionId(fields);
  expect(first).toMatch(/^ctxe_[a-f0-9]{64}$/);
  expect(contextEpochProjectionId({ ...fields, contextBundleVersion: 2 })).not.toBe(first);
});
