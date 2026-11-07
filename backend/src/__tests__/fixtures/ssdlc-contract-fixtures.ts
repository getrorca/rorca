/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import {
  CANONICAL_PHASE_IDS,
  COMPLETE_PRODUCT_CONTRACT,
  LifecycleCompilerInputSchema,
  LifecyclePlanSchema,
  deriveAcceptanceCriterionReferences,
  type LifecycleCompilerInput,
  type LifecyclePlan,
  type PhaseId,
  type PhaseDisposition,
  type ReleaseSubjectType,
} from '../../lib/ssdlc-contracts';
import { GENERAL_SDLC_7_PROFILE } from '../../ssdlc/profiles/general-sdlc-7';

export const SSDLC_FIXTURE_TIME = '2026-06-15T12:00:00.000Z';

export const SSDLC_FIXTURE_PROFILES = [
  'code-change',
  'docs-only',
  'security-sensitive',
  'data-storage',
  'release-operations',
] as const;

export type SsdlcFixtureProfile = (typeof SSDLC_FIXTURE_PROFILES)[number];

export interface SsdlcContractFixture {
  profile: SsdlcFixtureProfile;
  compilerInput: LifecycleCompilerInput;
  plan: LifecyclePlan;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function required(reason: string): PhaseDisposition {
  return { disposition: 'required', rationale: reason };
}

function notApplicable(reason: string): PhaseDisposition {
  return { disposition: 'not_applicable', rationale: reason };
}

function phaseDisposition(profile: SsdlcFixtureProfile, phaseId: PhaseId): PhaseDisposition {
  if (profile === 'docs-only' && ['design', 'testing', 'deployment'].includes(phaseId)) {
    return notApplicable(`The docs-only profile does not alter ${phaseId} runtime behavior.`);
  }
  return required(`${phaseId} is required for the ${profile} delivery profile.`);
}

function acceptedSubjectTypes(phaseId: PhaseId): ReleaseSubjectType[] {
  if (['planning', 'requirements', 'design'].includes(phaseId)) return ['spec_hash'];
  if (['development', 'testing'].includes(phaseId)) return ['commit_sha'];
  if (phaseId === 'deployment') return ['commit_sha', 'artifact_digest'];
  return ['spec_hash', 'deployment_id'];
}

function fixtureCriterion(profile: SsdlcFixtureProfile): string | { text: string; requirementId: string } {
  if (profile === 'security-sensitive') {
    return {
      text: 'Authorization and redaction checks reject cross-tenant secret disclosure.',
      requirementId: 'SEC-101',
    };
  }
  const criteria: Record<Exclude<SsdlcFixtureProfile, 'security-sensitive'>, string> = {
    'code-change': 'The implementation passes focused and broad regression validation.',
    'docs-only': 'The documented contract is accurate, linked, and reviewable.',
    'data-storage': 'Storage changes preserve integrity, recovery, and tenant isolation.',
    'release-operations': 'The immutable release subject is coherent through production verification.',
  };
  return criteria[profile];
}

function fixtureClassification(profile: SsdlcFixtureProfile):
  'code_change' | 'documentation' | 'security_finding' | 'data_storage' | 'release_operation' {
  switch (profile) {
    case 'code-change': return 'code_change';
    case 'docs-only': return 'documentation';
    case 'security-sensitive': return 'security_finding';
    case 'data-storage': return 'data_storage';
    case 'release-operations': return 'release_operation';
  }
}

function buildCompilerInput(profile: SsdlcFixtureProfile): LifecycleCompilerInput {
  const storyId = `FIX-${profile.replace(/[^a-z]/g, '-').toUpperCase()}-001`;
  const workspaceId = `workspace-${profile}`;
  const optionalSources = profile === 'docs-only' ? {} : {
    workspaceTags: [{ workspaceId, tag: profile }],
    riskAssignments: [{
      workspaceId,
      assignmentId: `risk-${profile}`,
      scopeReference: storyId,
      risk: profile === 'security-sensitive' ? 'high' as const : 'medium' as const,
      rationale: `Deterministic ${profile} fixture risk.`,
    }],
    ownerAssignments: [{
      workspaceId,
      assignmentId: `owner-${profile}`,
      scopeReference: storyId,
      ownerReference: 'owner-platform',
    }],
    policyAnnotations: [{
      workspaceId,
      annotationId: `policy-${profile}`,
      scopeReference: storyId,
      policyReference: 'policy-default',
      value: true,
    }],
  };

  return LifecycleCompilerInputSchema.parse({
    schemaVersion: 1,
    workspaceId,
    canonicalSpec: {
      specId: `fixture-${profile}`,
      version: '17',
      contentHash: sha256(`canonical-spec:${profile}`),
      json: {
        title: `${profile} fixture`,
        userStories: [{
          id: storyId,
          title: `Validate ${profile} lifecycle`,
          acceptanceCriteria: [fixtureCriterion(profile)],
        }],
      },
    },
    ...optionalSources,
    compilerVersion: 'ssdlc-compiler-fixture-1',
    policyVersion: 'ssdlc-policy-fixture-1',
    compiledAt: SSDLC_FIXTURE_TIME,
  });
}

function buildPlan(profile: SsdlcFixtureProfile, compilerInput: LifecycleCompilerInput): LifecyclePlan {
  const requirementReferences = deriveAcceptanceCriterionReferences(compilerInput)
    .map((criterion) => criterion.requirementReference);
  const storyReferences = compilerInput.canonicalSpec.json.userStories.map((story) => story.id);
  const gates = CANONICAL_PHASE_IDS.map((phaseId) => ({
    gateId: `gate-${phaseId}`,
    phaseId,
    title: `${phaseId} fixture gate`,
    evidenceKind: 'automated_validation' as const,
    subjectRevisionRequirement: 'current_spec_revision' as const,
    approvalRequirement: 'none' as const,
    expirationPolicy: 'when_subject_changes' as const,
    blockingSeverity: 'blocking' as const,
    evidenceRequirementIds: [`evidence-requirement-${phaseId}`],
    acceptedSubjectTypes: acceptedSubjectTypes(phaseId),
    downstreamSubjectCoherence: {
      testing: phaseId === 'testing' ? 'same_subject' : 'derived_from_subject',
      deployment: phaseId === 'deployment' ? 'same_subject' : 'derived_from_subject',
    },
  }));
  const evidenceRequirements = CANONICAL_PHASE_IDS.map((phaseId) => ({
    evidenceRequirementId: `evidence-requirement-${phaseId}`,
    gateId: `gate-${phaseId}`,
    description: `Immutable ${profile} evidence for ${phaseId}.`,
    classification: fixtureClassification(profile),
    minimumTrustLevel: 'verified' as const,
  }));

  return LifecyclePlanSchema.parse({
    schemaVersion: 1,
    planId: `plan-${profile}`,
    planVersion: 1,
    inputHash: sha256(`compiler-input:${profile}`),
    workspaceId: compilerInput.workspaceId,
    specId: compilerInput.canonicalSpec.specId,
    compilerVersion: compilerInput.compilerVersion,
    policyVersion: compilerInput.policyVersion,
    compiledAt: SSDLC_FIXTURE_TIME,
    phaseOrder: [...CANONICAL_PHASE_IDS],
    phases: CANONICAL_PHASE_IDS.map((phaseId) => ({
      phaseId,
      disposition: phaseDisposition(profile, phaseId),
      gateIds: [`gate-${phaseId}`],
    })),
    profile: {
      profileId: GENERAL_SDLC_7_PROFILE.profileId,
      profileVersion: GENERAL_SDLC_7_PROFILE.version,
      profileHash: GENERAL_SDLC_7_PROFILE.contentHash,
      stages: GENERAL_SDLC_7_PROFILE.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        phaseIds: [...stage.phaseIds],
      })),
      blockingStages: [...GENERAL_SDLC_7_PROFILE.blockingStages],
    },
    requirementReferences,
    storyReferences,
    architectureDecisionReferences: [],
    requirementMappings: requirementReferences.map((requirementReference) => ({
      requirementReference,
      targetReferences: [{ type: 'story' as const, reference: storyReferences[0] }],
      gateIds: gates.map((gate) => gate.gateId),
      evidenceRequirementIds: evidenceRequirements.map((requirement) => requirement.evidenceRequirementId),
    })),
    gates,
    evidenceRequirements,
    completeness: COMPLETE_PRODUCT_CONTRACT,
  });
}

export function buildSsdlcContractFixtures(): SsdlcContractFixture[] {
  return SSDLC_FIXTURE_PROFILES.map((profile) => {
    const compilerInput = buildCompilerInput(profile);
    return { profile, compilerInput, plan: buildPlan(profile, compilerInput) };
  });
}

export const SSDLC_CONTRACT_FIXTURES = buildSsdlcContractFixtures();
