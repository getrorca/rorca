/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import controlsArtifact from '../catalog/controls.json';
import { compileGates } from '../gates/gate-compiler';
import { compileAssuranceProfile } from '../assurance-profile';
import { parseControl } from '../schema/control-schema';
import { qualifyFullInteroperability } from '../full-interoperability-qualification';
import { createCanonicalEvidence } from '../../lib/ssdlc-evidence';
import { projectOmpOrchestrationEvent } from '../../lib/omp-orchestration-events';
import type { ManagedEngineRequest } from '../../lib/rorca-managed-executor';
import { deriveSourceBundleHash, SOURCE_CONTRACT_VERSIONS, type SourceBundleV1 } from '../../lib/source-contracts';
import { consumeProductionOutcome, listCandidates, resetLearnLoopForTests } from '../learn/learn-loop';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const NOW = new Date('2026-03-16T00:06:34.000Z');
const controls = controlsArtifact.map(parseControl);
const activeControlIds = controls.map(({ controlId }) => controlId);
const compilation = compileGates(controls, {
  activeControlIds,
  evidenceDepthByControlId: Object.fromEntries(activeControlIds.map((id) => [id, 'independent-verification' as const])),
});
const revision = { kind: 'artifact_digest' as const, value: hash('2') };
const entity = {
  schemaVersion: 'rorca.entity-ref.v1' as const, workspaceId: 'qualification-workspace', kind: 'spec' as const,
  id: 'source-verified-delivery', label: 'Source Verified Delivery', revision,
};

function sourceBundle(contentHashCharacter = '1', bundleId = 'qualification-bundle-v1'): SourceBundleV1 {
  const source = {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceRef, sourceId: 'frozen-brief', kind: 'inline' as const,
    locator: 'qualification/brief.md', title: 'Qualification brief', contentHash: hash(contentHashCharacter), sourceVersion: contentHashCharacter,
    reviewStatus: 'approved' as const, sensitivity: 'internal' as const, authority: 'user_mandated' as const,
    selectedSections: ['all'],
  };
  const citations = [{
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceCitation, citationId: 'brief-all', sourceId: source.sourceId,
    section: 'all', excerptHash: hash('3'), rationale: 'Frozen qualification source.',
  }];
  const core = { userIntent: 'Qualify source-to-learning delivery.', includedSources: [source], citations };
  return {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceBundle, bundleId,
    bundleHash: deriveSourceBundleHash(core), ...core, workspaceRef: {
      schemaVersion: 'rorca.entity-ref.v1', workspaceId: entity.workspaceId, kind: 'workspace', id: entity.workspaceId, label: 'Qualification Workspace',
    }, excludedSources: [], conflicts: [], assumptions: [], truncations: [], compiledAt: NOW.toISOString(),
  };
}

function gate(status: 'pass' | 'blocked', unresolvedControlIds: string[]) {
  return {
    stage: 'testing' as const, status, blocking: status === 'blocked', evaluatedAt: NOW.toISOString(),
    phaseResults: [], controlResults: [], unresolvedControlIds,
    stageProjection: {
      stage: 'testing' as const, phases: ['testing' as const], controlIds: activeControlIds,
      unresolvedControlIds, blocking: status === 'blocked', status: status === 'blocked' ? 'blocked' as const : 'ready' as const,
    },
  };
}

function evidence(bundle: SourceBundleV1, profileReceipt: string, eventId: string, status: 'passed' | 'story_caused_failure', rawReference: string) {
  return createCanonicalEvidence({
    sourceType: 'wal_validation', sourceSystem: 'omp-qualification', sourceEventId: eventId,
    observedAt: new Date(NOW.getTime() + (status === 'passed' ? 2_000 : 1_000)),
    scope: { workspaceId: entity.workspaceId, specSlug: entity.id, runId: 20260316000634, storyId: 'INT-002', phaseId: 'testing', gateId: 'verify' },
    subject: { type: 'spec_hash', value: bundle.bundleHash }, classification: 'testing', status,
    trustLevel: 'host_observed', confidence: 1, rawReference,
    details: {
      sourceBundleHash: bundle.bundleHash, specRevision: `${revision.kind}:${revision.value}`,
      profileId: 'profile:int-002:v1', compilationReceiptHash: profileReceipt, controlId: activeControlIds[0],
      ...(status === 'passed' ? {} : { actionableGap: 'Retry the failed OMP verifier through Hermes healing.' }),
    },
  });
}

test('qualifies success, forced OMP recovery, refresh replay, source drift, and deduplicated learning', () => {
  resetLearnLoopForTests();
  const bundle = sourceBundle();
  const instances = compilation.phaseGroups.flatMap((group) => group.controlIds.map((controlId) => ({
    controlId, mechanismBindings: [{ mechanismId: 'governed-review', kind: 'review' as const, locator: 'rorca://approvals/int-002' }],
    criteria: [{ criterionId: `${controlId}-approval`, description: 'A governed reviewer approves exact evidence.', evaluator: 'human-decision' as const, expected: 'approved' }],
    evidenceRequirements: group.evidenceRequirements.filter((item) => item.controlId === controlId).map(({ controlId: _id, sourceReferences: _refs, ...requirement }) => requirement),
    enforcement: 'required' as const,
  })));
  const selectionContext = { applicabilityControlIds: activeControlIds, phaseGroups: compilation.phaseGroups.map(({ phase, controlIds }) => ({ phase, controlIds })), stageProjection: compilation.readiness.map(({ stage, phases, controlIds }) => ({ stage, phases, controlIds })) };
  const riskProfile = { level: 'high' as const, tags: ['qualification'], rationale: 'Whole-program release proof.' };
  const profile = compileAssuranceProfile({
    profileId: 'profile:int-002:v1', specRef: entity, specRevision: revision, repositoryContextHash: hash('4'),
    persistedSourceContext: { bundle, specRevision: revision }, riskProfile, selectionContext, controlInstances: instances,
  });
  const changedBundle = sourceBundle('9', 'qualification-bundle-v2');
  const changedRevision = { kind: 'artifact_digest' as const, value: hash('8') };
  const changedEntity = { ...entity, revision: changedRevision };
  const changedProfile = compileAssuranceProfile({
    profileId: 'profile:int-002:v2', specRef: changedEntity, specRevision: changedRevision, repositoryContextHash: hash('4'),
    persistedSourceContext: { bundle: changedBundle, specRevision: changedRevision }, riskProfile, selectionContext, controlInstances: instances,
  });
  const failedEvidence = evidence(bundle, profile.compilationReceiptHash!, 'omp-failed', 'story_caused_failure', 'evidence://int-002/failure');
  const recoveredEvidence = evidence(bundle, profile.compilationReceiptHash!, 'omp-recovered', 'passed', 'evidence://int-002/recovery');

  const request = { requestHash: hash('5'), workspaceId: entity.workspaceId, runId: 20260316000634, specId: entity.id, specVersion: 1,
    specHash: bundle.bundleHash, storyId: 'INT-002', storyVersion: 1, attemptId: 'attempt:int-002', generation: 1 } as ManagedEngineRequest;
  const rawEvents = [
    { type: 'agent_start', eventId: 'root-start', agentId: 'hermes-root' },
    { type: 'agent_start', eventId: 'worker-start', agentId: 'omp-worker', parentAgentId: 'hermes-root' },
    { type: 'agent_failed', eventId: 'worker-failed', agentId: 'omp-worker', parentAgentId: 'hermes-root', error: 'forced qualification failure' },
    { type: 'agent_start', eventId: 'recovery-start', agentId: 'omp-worker-retry', parentAgentId: 'hermes-root', retryOfAgentId: 'omp-worker' },
    { type: 'agent_settled', eventId: 'recovery-done', agentId: 'omp-worker-retry', parentAgentId: 'hermes-root', retryOfAgentId: 'omp-worker', evidence: [recoveredEvidence.rawReference] },
    { type: 'agent_settled', eventId: 'root-done', agentId: 'hermes-root' },
  ];
  const events = rawEvents.map((event, index) => projectOmpOrchestrationEvent({ request, processIdentity: 'omp:int-002', sourceOrdinal: index + 1, event, observedAt: new Date(NOW.getTime() + index * 100).toISOString() }, index + 1));
  const eventIds = events.map(({ idempotencyKey }) => idempotencyKey);

  consumeProductionOutcome({ source: 'aav-heal', candidateType: 'exception-caused-rework', outcomeType: 'healing', controlId: activeControlIds[0], phase: 'testing', evidenceRef: recoveredEvidence.rawReference!, provenance: { sourceEventId: 'worker-failed', recoveryEventId: 'recovery-done', sourceBundleHash: bundle.bundleHash } });
  consumeProductionOutcome({ source: 'aav-heal', candidateType: 'exception-caused-rework', outcomeType: 'healing', controlId: activeControlIds[0], phase: 'testing', evidenceRef: recoveredEvidence.rawReference!, provenance: { sourceEventId: 'worker-failed', recoveryEventId: 'recovery-done', sourceBundleHash: bundle.bundleHash } });

  const receipt = qualifyFullInteroperability({
    sourceBundle: bundle, persistedEntityRef: entity, persistedRevisionRef: revision, assuranceProfile: profile, gateCompilation: compilation,
    runManifest: { runId: request.runId, sourceBundleHash: bundle.bundleHash, specId: entity.id, specRevision: revision, assuranceProfileId: profile.profileId, assuranceCompilationReceiptHash: profile.compilationReceiptHash! },
    mechanismResolutions: instances.flatMap((instance) => instance.evidenceRequirements.map((_requirement, requirementIndex) => ({ controlId: instance.controlId, requirementIndex, path: 'governed-human-approval' as const, locator: instance.mechanismBindings[0].locator, approvalReference: 'approval://int-002/operator' }))),
    orchestrationEvents: events, failureEvidence: failedEvidence, recoveryEvidence: recoveredEvidence,
    blockedGate: gate('blocked', [activeControlIds[0]]), recoveredGate: gate('pass', []),
    hermesObservedEventIds: eventIds, replayedEventIds: eventIds,
    drift: { newSourceBundle: changedBundle, newPersistedEntityRef: changedEntity, newAssuranceProfile: changedProfile, reviewState: 'pending_re_review', oldEvidenceRejected: true },
    learningCandidates: listCandidates(),
  });

  assert.equal(receipt.exactReceipt, true);
  assert.equal(receipt.sourceBundleHash, bundle.bundleHash);
  assert.equal(receipt.phaseGroupCount, 11);
  assert.deepEqual(receipt.missionStages, ['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance']);
  assert.equal(receipt.maintenanceBlocking, false);
  assert.equal(receipt.orchestration.replayIdempotent, true);
  assert.equal(listCandidates().length, 1);
  assert.equal(listCandidates()[0].signalCount, 2);
  assert.deepEqual(listCandidates()[0].provenance, { sourceEventId: 'worker-failed', recoveryEventId: 'recovery-done', sourceBundleHash: bundle.bundleHash });
});
