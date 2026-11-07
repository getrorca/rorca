/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import controlsArtifact from '../../catalog/controls.json';
import { deriveSourceBundleHash } from '../../../lib/source-contracts';
import { createCanonicalEvidence } from '../../../lib/ssdlc-evidence';
import { compileGates } from '../../gates/gate-compiler';
import { parseControl } from '../../schema/control-schema';

export const hash = (character: string): string => `sha256:${character.repeat(64)}`;
export const revisionFixture = Object.freeze({ kind: 'spec_version' as const, value: '7' });
export const workspaceRefFixture = Object.freeze({
  schemaVersion: 'rorca.entity-ref.v1' as const,
  workspaceId: 'workspace-cdc', kind: 'workspace' as const, id: 'workspace-cdc', label: 'CDC workspace',
});
export const specRefFixture = Object.freeze({
  schemaVersion: 'rorca.entity-ref.v1' as const,
  workspaceId: 'workspace-cdc', kind: 'spec' as const, id: 'interop-spec', label: 'Interop spec', revision: revisionFixture,
});

const source = Object.freeze({
  schemaVersion: 'rorca.source-ref.v1' as const,
  sourceId: 'source-1', kind: 'inline' as const, locator: 'fixtures/source-1', title: 'Verified brief',
  contentHash: hash('1'), sourceVersion: '1', reviewStatus: 'approved' as const,
  sensitivity: 'internal' as const, authority: 'user_mandated' as const, selectedSections: ['brief'],
});
const citation = Object.freeze({
  schemaVersion: 'rorca.source-citation.v1' as const,
  citationId: 'citation-1', sourceId: source.sourceId, section: 'brief', excerptHash: hash('2'), rationale: 'Defines delivery intent.',
});
const sourceBundleCore = {
  schemaVersion: 'rorca.source-bundle.v1' as const, bundleId: 'bundle-1', userIntent: 'Verify shared SSDLC contracts.',
  workspaceRef: workspaceRefFixture, includedSources: [source], excludedSources: [], conflicts: [], assumptions: [], truncations: [],
  citations: [citation], compiledAt: '2026-03-16T00:06:34.000Z',
};
export const sourceBundleFixture = Object.freeze({
  ...sourceBundleCore,
  bundleHash: deriveSourceBundleHash(sourceBundleCore),
});
export const intentEnvelopeFixture = Object.freeze({
  schemaVersion: 'rorca.intent-envelope.v1' as const, intentId: 'intent-1', idempotencyKey: 'intent:fixture:1',
  userIntent: sourceBundleFixture.userIntent, workspaceRef: workspaceRefFixture, missionRef: null,
  sourceBundle: sourceBundleFixture, receivedAt: '2026-03-16T00:06:34.000Z',
});

export const controlFixture = Object.freeze(parseControl(controlsArtifact[0]));
export const controlsCatalogFixture = Object.freeze(controlsArtifact.map((control) => Object.freeze(parseControl(control))));
const activeControlIds = controlsCatalogFixture.map(({ controlId }) => controlId);
export const stageProjectionFixture = Object.freeze(compileGates({
  controls: controlsCatalogFixture,
  applicability: {
    activeControlIds,
    evidenceDepthByControlId: Object.fromEntries(activeControlIds.map((controlId) => [controlId, 'artifact' as const])),
  },
  unresolvedControlIds: activeControlIds,
}));

export const assuranceProfileFixture = Object.freeze({
  schemaVersion: 'rorca.assurance-profile.v1' as const, profileKind: 'default' as const, profileId: 'default:interop-spec',
  specRef: specRefFixture, specRevision: revisionFixture, repositoryContextHash: hash('3'), sourceContext: null,
  riskProfile: { level: 'none' as const, tags: [], rationale: 'Explicit compatibility profile.' },
  controlInstances: [], compilationReceiptHash: null,
});

export const lifecycleEvidenceFixture = Object.freeze(createCanonicalEvidence({
  sourceType: 'wal_validation', sourceSystem: 'aav-kernel', sourceEventId: 'event-1', observedAt: '2026-03-16T00:06:34.000Z',
  scope: { workspaceId: 'workspace-cdc', specSlug: 'interop-spec', runId: 7, storyId: 'AAV-006', phaseId: 'testing', gateId: 'verify' },
  subject: { type: 'commit_sha', value: '0123456789abcdef0123456789abcdef01234567' },
  releaseIdentity: { commitSha: '0123456789abcdef0123456789abcdef01234567' },
  classification: 'testing', status: 'passed', trustLevel: 'host_observed', confidence: 1,
  rawReference: 'wal://7/1', details: { evidenceDepth: 'demonstrated' },
}));
export const hermesEvidenceFixture = Object.freeze({
  schemaVersion: 'hermes.evidence.v1' as const, kind: 'staging_result' as const, sourceSystem: 'hermes', sourceEventId: 'hermes-1',
  observedAt: '2026-03-16T00:06:34.000Z',
  scope: { workspaceId: 'workspace-cdc', specSlug: 'interop-spec', runId: 7, storyId: 'HMG-010', phaseId: 'deployment', gateId: 'release' },
  subject: { type: 'artifact_digest' as const, value: hash('4') }, status: 'passed' as const, confidence: 1,
  payloadHash: '5'.repeat(64), provenanceChain: [{ system: 'hermes', eventId: 'upstream-1', observedAt: '2026-03-16T00:06:33.000Z' }],
});

const entity = (kind: 'mission' | 'run' | 'story' | 'attempt', id: string) => ({
  schemaVersion: 'rorca.entity-ref.v1' as const, workspaceId: 'workspace-cdc', kind, id, label: id,
});
export const orchestrationFixture = Object.freeze({
  schemaVersion: 'rorca.orchestration-event.v1' as const, eventId: hash('6'), idempotencyKey: hash('7'), kind: 'agent_completed' as const,
  sequence: 1, observedAt: '2026-03-16T00:06:34.000Z', run: entity('run', '7'), story: entity('story', 'AAV-007'),
  attempt: entity('attempt', 'attempt-1'), process: { ...entity('attempt', 'process-1'), kind: 'process' as const },
  spec: specRefFixture, specRevisionHash: hash('8'), parentEventId: null,
  omp: { provider: 'omp' as const, rpcType: 'agent_completed', sourceEventId: 'omp-1', parentEventId: null, agentId: 'agent-1', parentAgentId: null, taskId: null, raw: {} },
});
export const gatewayFixture = Object.freeze({
  schemaVersion: 'rorca.gateway-event.v1' as const, eventId: hash('9'), idempotencyKey: hash('a'), sourceEventId: 'gateway-1',
  sequence: 1, occurredAt: '2026-03-16T00:06:34.000Z', kind: 'run_completed' as const,
  identity: { workspaceId: 'workspace-cdc', mission: entity('mission', 'mission-1'), spec: specRefFixture,
    specRevisionHash: hash('8'), run: entity('run', '7'), story: entity('story', 'HMG-010'), attempt: entity('attempt', 'attempt-1') },
  summary: 'Run completed.', details: { outcome: 'succeeded' as const, evidenceBundleId: 'evidence-1' },
});
export const findingFixture = Object.freeze({
  findingId: 'finding-1', controlId: controlFixture.controlId, skillId: controlFixture.skillRefs[0], status: 'pass' as const,
  evidenceRefs: ['evidence-1'], message: 'Canonical control expectation passed.',
});
export const learnOutcomeFixture = Object.freeze({
  source: 'aav-heal' as const, candidateType: 'exception-caused-rework' as const, controlId: controlFixture.controlId,
  phase: controlFixture.phase, evidenceRef: 'evidence://interop/learn-1', reworkCausedByGrantedException: true,
});
