/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { AssuranceProfileV1Schema } from './assurance-profile';
import type { GateEvaluationTrace } from './evaluation/gate-evaluator';
import { MISSION_STAGES, type GateCompilation } from './gates/gate-compiler';
import type { LearnCandidate } from './learn/learn-loop';
import type { CanonicalLifecycleEvidence } from '../lib/ssdlc-evidence';
import { EntityRefV1Schema, RevisionRefV1Schema } from '../lib/mission-contracts';
import { OrchestrationEventV1Schema } from '../lib/omp-orchestration-events';
import { SourceBundleV1Schema } from '../lib/source-contracts';

export const FULL_INTEROPERABILITY_QUALIFICATION_VERSION = 'rorca.ssdlc-interoperability-qualification.v1' as const;

export interface QualifiedRunManifest {
  runId: number;
  sourceBundleHash: string;
  specId: string;
  specRevision: { kind: string; value: string };
  assuranceProfileId: string;
  assuranceCompilationReceiptHash: string;
}

export interface EvidenceMechanismResolution {
  controlId: string;
  requirementIndex: number;
  path: 'adapter' | 'governed-human-approval';
  locator: string;
  approvalReference?: string;
}

export interface FullInteroperabilityQualificationInput {
  sourceBundle: unknown;
  persistedEntityRef: unknown;
  persistedRevisionRef: unknown;
  assuranceProfile: unknown;
  gateCompilation: GateCompilation;
  runManifest: QualifiedRunManifest;
  mechanismResolutions: readonly EvidenceMechanismResolution[];
  orchestrationEvents: readonly unknown[];
  failureEvidence: CanonicalLifecycleEvidence;
  recoveryEvidence: CanonicalLifecycleEvidence;
  blockedGate: GateEvaluationTrace;
  recoveredGate: GateEvaluationTrace;
  hermesObservedEventIds: readonly string[];
  replayedEventIds: readonly string[];
  drift: {
    newSourceBundle: unknown;
    newPersistedEntityRef: unknown;
    newAssuranceProfile: unknown;
    reviewState: 'pending_re_review';
    oldEvidenceRejected: boolean;
  };
  learningCandidates: readonly LearnCandidate[];
}

export interface FullInteroperabilityQualificationReceipt {
  schemaVersion: typeof FULL_INTEROPERABILITY_QUALIFICATION_VERSION;
  sourceBundleHash: string;
  identityChain: {
    entityRevision: string;
    profileId: string;
    profileReceiptHash: string;
    runId: number;
    failureEvidenceHash: string;
    recoveryEvidenceHash: string;
    blockedStage: string;
    recoveredStage: string;
  };
  phaseGroupCount: 11;
  missionStages: readonly string[];
  maintenanceBlocking: false;
  mechanismResolutionCount: number;
  orchestration: { eventCount: number; failedAgentId: string; recoveredAgentId: string; replayIdempotent: true };
  driftInvalidationVerified: true;
  learningCandidateId: string;
  exactReceipt: true;
}

function fail(message: string): never {
  throw new TypeError(`INT-002 qualification failed: ${message}`);
}

function sameRevision(left: { kind: string; value: string }, right: { kind: string; value: string }): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function detail(evidence: CanonicalLifecycleEvidence, key: string): string | null {
  const value = evidence.details[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Validate the exact artifacts produced by each canonical provider. This coordinator performs no
 * execution or persistence itself, so the isolated harness can use production providers without
 * creating a second orchestration implementation.
 */
export function qualifyFullInteroperability(input: FullInteroperabilityQualificationInput): Readonly<FullInteroperabilityQualificationReceipt> {
  const bundle = SourceBundleV1Schema.parse(input.sourceBundle);
  const entity = EntityRefV1Schema.parse(input.persistedEntityRef);
  const revision = RevisionRefV1Schema.parse(input.persistedRevisionRef);
  const profile = AssuranceProfileV1Schema.parse(input.assuranceProfile);
  if (entity.kind !== 'spec' || !entity.revision || !sameRevision(entity.revision, revision)) fail('persisted EntityRefV1 and RevisionRefV1 are not exact');
  if (!sameRevision(profile.specRevision, revision) || profile.specRef.id !== entity.id
    || profile.sourceContext?.bundleHash !== bundle.bundleHash || !profile.compilationReceiptHash) fail('assurance profile does not preserve the frozen source revision');

  const manifest = input.runManifest;
  if (manifest.sourceBundleHash !== bundle.bundleHash || manifest.specId !== entity.id
    || !sameRevision(manifest.specRevision, revision) || manifest.assuranceProfileId !== profile.profileId
    || manifest.assuranceCompilationReceiptHash !== profile.compilationReceiptHash) fail('run manifest breaks the exact source/profile identity chain');

  if (input.gateCompilation.phaseGroups.length !== 7 || input.gateCompilation.missingFamilies.length !== 0
    || input.gateCompilation.phaseGroups.some((group) => group.missingFamilies.length > 0)) fail('US-004 did not compile all seven complete canonical phase groups');
  if (input.gateCompilation.readiness.map(({ stage }) => stage).join('|') !== MISSION_STAGES.join('|')) fail('US-004 did not project the seven canonical Mission stages');
  const maintenance = input.gateCompilation.readiness.find(({ stage }) => stage === 'maintenance');
  if (!maintenance || maintenance.blocking || maintenance.status !== 'non-blocking') fail('maintenance must remain non-blocking');

  const resolutions = new Map(input.mechanismResolutions.map((item) => [`${item.controlId}:${item.requirementIndex}`, item]));
  for (const instance of profile.controlInstances) {
    instance.evidenceRequirements.forEach((_requirement, requirementIndex) => {
      const resolution = resolutions.get(`${instance.controlId}:${requirementIndex}`);
      if (!resolution || !resolution.locator.trim()) fail(`active evidence requirement ${instance.controlId}:${requirementIndex} has no executable path`);
      const mechanism = instance.mechanismBindings.find(({ locator }) => locator === resolution.locator);
      if (!mechanism) fail(`evidence path ${instance.controlId}:${requirementIndex} is absent from the compiled repository mechanism inventory`);
      if (resolution.path === 'governed-human-approval' && (mechanism.kind !== 'review' || !resolution.approvalReference?.trim())) {
        fail(`human path ${instance.controlId}:${requirementIndex} lacks a governed review mechanism and approval authority`);
      }
      if (resolution.path === 'adapter' && mechanism.kind === 'review') fail(`adapter path ${instance.controlId}:${requirementIndex} resolves only to a human review`);
    });
  }

  for (const evidence of [input.failureEvidence, input.recoveryEvidence]) {
    if (evidence.schemaVersion !== 'rorca.lifecycle-evidence.v1' || evidence.subject.value !== bundle.bundleHash
      || detail(evidence, 'sourceBundleHash') !== bundle.bundleHash || detail(evidence, 'specRevision') !== `${revision.kind}:${revision.value}`
      || detail(evidence, 'profileId') !== profile.profileId || detail(evidence, 'compilationReceiptHash') !== profile.compilationReceiptHash) {
      fail('canonical evidence does not preserve bundle, revision, and assurance identity');
    }
  }
  const failedControlId = detail(input.failureEvidence, 'controlId');
  if (input.failureEvidence.status === 'passed' || !failedControlId || !detail(input.failureEvidence, 'actionableGap')
    || input.recoveryEvidence.status !== 'passed' || input.failureEvidence.payloadHash === input.recoveryEvidence.payloadHash) {
    fail('failure and recovery must produce distinct actionable blocked and passing canonical evidence');
  }

  const events = input.orchestrationEvents.map((event) => OrchestrationEventV1Schema.parse(event)).sort((a, b) => a.sequence - b.sequence);
  if (events.length === 0 || events.some((event, index) => index > 0 && event.sequence !== events[index - 1].sequence + 1)) fail('durable OMP sequence is empty or non-contiguous');
  if (events.some((event) => event.spec.id !== entity.id || event.specRevisionHash !== bundle.bundleHash)) {
    fail('OMP run events do not preserve the exact source-backed spec identity');
  }
  const failed = events.find(({ kind }) => kind === 'agent_failed');
  const recovered = events.find((event) => event.kind === 'agent_completed'
    && typeof event.omp.raw.retryOfAgentId === 'string' && event.omp.raw.retryOfAgentId === failed?.omp.agentId);
  if (!failed?.omp.agentId || !recovered?.omp.agentId) fail('forced OMP failure has no durable retry completion');
  if (input.blockedGate.status !== 'blocked' || !input.blockedGate.unresolvedControlIds.includes(failedControlId)
    || input.recoveredGate.stage !== input.blockedGate.stage || input.recoveredGate.status !== 'pass'
    || input.recoveredGate.unresolvedControlIds.length !== 0) fail('failure/recovery did not cause applicable-stage block and re-evaluation');

  const eventIds = events.map(({ idempotencyKey }) => idempotencyKey);
  if (new Set(eventIds).size !== eventIds.length
    || input.hermesObservedEventIds.join('|') !== eventIds.join('|')
    || input.replayedEventIds.join('|') !== eventIds.join('|')) fail('Hermes/refresh replay is not exact and idempotent');

  const changedBundle = SourceBundleV1Schema.parse(input.drift.newSourceBundle);
  const changedEntity = EntityRefV1Schema.parse(input.drift.newPersistedEntityRef);
  const changedProfile = AssuranceProfileV1Schema.parse(input.drift.newAssuranceProfile);
  if (changedBundle.bundleHash === bundle.bundleHash || input.recoveryEvidence.subject.value === changedBundle.bundleHash
    || changedEntity.kind !== 'spec' || changedEntity.id !== entity.id || !changedEntity.revision
    || sameRevision(changedEntity.revision, revision) || !sameRevision(changedProfile.specRevision, changedEntity.revision)
    || changedProfile.sourceContext?.bundleHash !== changedBundle.bundleHash
    || changedProfile.compilationReceiptHash === profile.compilationReceiptHash
    || input.drift.reviewState !== 'pending_re_review' || !input.drift.oldEvidenceRejected) {
    fail('source drift did not create a new exact revision/profile or invalidate review and old evidence');
  }

  const candidates = input.learningCandidates.filter((candidate) => candidate.status === 'pending-review'
    && candidate.evidenceRef === input.recoveryEvidence.rawReference);
  const candidateProvenance = candidates[0]?.provenance;
  if (candidates.length !== 1 || candidates[0].signalCount < 1 || !candidateProvenance
    || candidateProvenance.sourceBundleHash !== bundle.bundleHash
    || typeof candidateProvenance.sourceEventId !== 'string' || typeof candidateProvenance.recoveryEventId !== 'string') {
    fail('US-007 did not produce exactly one deduplicated pending-review candidate with exact recovery provenance');
  }

  return Object.freeze({
    schemaVersion: FULL_INTEROPERABILITY_QUALIFICATION_VERSION,
    sourceBundleHash: bundle.bundleHash,
    identityChain: Object.freeze({
      entityRevision: `${revision.kind}:${revision.value}`, profileId: profile.profileId,
      profileReceiptHash: profile.compilationReceiptHash, runId: manifest.runId,
      failureEvidenceHash: input.failureEvidence.payloadHash, recoveryEvidenceHash: input.recoveryEvidence.payloadHash,
      blockedStage: input.blockedGate.stage, recoveredStage: input.recoveredGate.stage,
    }),
    phaseGroupCount: 11, missionStages: Object.freeze([...MISSION_STAGES]), maintenanceBlocking: false,
    mechanismResolutionCount: resolutions.size,
    orchestration: Object.freeze({ eventCount: events.length, failedAgentId: failed.omp.agentId, recoveredAgentId: recovered.omp.agentId, replayIdempotent: true as const }),
    driftInvalidationVerified: true, learningCandidateId: candidates[0].candidateId, exactReceipt: true,
  });
}
