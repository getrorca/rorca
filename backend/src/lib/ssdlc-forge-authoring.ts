/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Thin integration adapter between skill-first forge/persist and the pure SSDLC
 * authoring planner/compiler. It owns no model loop or execution behavior.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { ProviderHumanEventSchema } from './provider-human-authority';
import { execute, queryOne } from '../db/index';
import { UnprocessableError, ValidationError } from './errors';
import {
  AUTHORING_LIFECYCLE_PROFILES,
  AUTHORING_PLAN_JSON_SCHEMA,
  AUTHORING_PREFLIGHT_JSON_SCHEMA,
  AUTHORING_SPEC_LIMITS,
  AuthoringPlanSchema,
  AuthoringPlannerInputSchema,
  ProposedSpecDraftCandidateSchema,
  ProposedSpecDraftSchema,
  SPEC_BOUNDARY_SIGNAL_KINDS,
  SSDLC_AUTHORING_SCHEMA_VERSION,
  STORY_CAPABILITIES,
  type AuthoringDiagnostic,
  type AuthoringLifecycleProfileId,
  type AuthoringPlan,
  type AuthoringPreflightResult,
  type ProposedSpecDraft,
  type ProposedStory,
  type StoryCapability,
} from './ssdlc-authoring-contracts';
import {
  SSDLC_AUTHORING_PLANNER_VERSION,
  deriveAuthoringPreflightHash,
  normalizeAuthoringIntent,
  planAuthoring,
  preflightAuthoringDraft,
} from './ssdlc-authoring-planner';
import { normalizeAcceptanceCriterionText, normalizeSsdlcContractJson, SSDLC_SCHEMA_VERSION } from './ssdlc-contracts';
import { compileLifecyclePlan, SSDLC_PLAN_COMPILER_VERSION } from './ssdlc-plan-compiler';
import { createCompiledPlan } from './ssdlc-store';
import { stripAppendedContextBlock } from './spec-stage-fingerprints';

export const SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION = 'ssdlc-lifecycle-authoring-1' as const;
export const SSDLC_AUTHORING_POLICY_VERSION = 'ssdlc-authoring-policy-1' as const;
export const DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS = 3 as const;

const CallerSurfaceSchema = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9._:/-]{1,127}$/);
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const AttemptSummarySchema = z.object({
  attempt: z.number().int().min(1).max(DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS),
  accepted: z.boolean(),
  diagnosticCategories: z.array(z.string().trim().min(1)).max(64),
  materialRevisions: z.array(z.string().trim().min(1)).max(64),
}).strict();

export const AuthoringPreflightRequestSchema = z.object({
  schemaVersion: z.literal(SSDLC_AUTHORING_SCHEMA_VERSION),
  workspaceId: z.union([z.string().min(1), z.number()]),
  plannerInput: AuthoringPlannerInputSchema,
  // Preserve untrusted draft keys for the strict inner preflight validator.
  specs: z.array(ProposedSpecDraftCandidateSchema).min(1).max(AUTHORING_SPEC_LIMITS.maximum),
  attempt: z.number().int().min(1).max(DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS),
  priorAttempts: z.array(AttemptSummarySchema).max(DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS - 1).default([]),
  materialRevisions: z.array(z.string().trim().min(1)).max(64).default([]),
  callerSurface: CallerSurfaceSchema,
  model: z.string().trim().min(1).max(200).optional(),
}).strict();

export const AuthoringConfirmationRequestSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]),
  acceptedPlanHash: Sha256Schema,
  acceptedPreflightHash: Sha256Schema,
  confirmed: z.literal(true),
  attestation: ProviderHumanEventSchema.optional(),
}).strict();

export const PersistAuthoringBindingSchema = z.object({
  schemaVersion: z.literal(SSDLC_AUTHORING_SCHEMA_VERSION),
  profileVersion: z.literal(SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION),
  acceptedPlan: AuthoringPlanSchema,
  planHash: Sha256Schema,
  specs: z.array(ProposedSpecDraftSchema).min(1).max(AUTHORING_SPEC_LIMITS.maximum),
  acceptedPreflightHash: Sha256Schema,
  preflightAttemptCount: z.number().int().min(1).max(DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS),
  priorAttempts: z.array(AttemptSummarySchema).max(DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS - 1).default([]),
  materialRevisions: z.array(z.string().trim().min(1)).max(64).default([]),
  callerSurface: CallerSurfaceSchema,
  model: z.string().trim().min(1).max(200).optional(),
  preflightReceiptId: z.number().int().positive(),
  confirmationReceiptId: z.number().int().positive().optional(),
}).strict();

export type PersistAuthoringBinding = z.infer<typeof PersistAuthoringBindingSchema>;
export type AuthoringPreflightRequest = z.infer<typeof AuthoringPreflightRequestSchema>;

export interface LifecycleAuthoringSection {
  schemaVersion: typeof SSDLC_AUTHORING_SCHEMA_VERSION;
  profileVersion: typeof SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION;
  status: 'ready';
  normalizedIntentIdentity: ReturnType<typeof normalizeAuthoringIntent>;
  sourceContextIdentity: {
    contextId: string;
    version: typeof SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION;
    contentHash: `sha256:${string}`;
  };
  decompositionPolicy: {
    defaultDecision: 'one_spec_unless_independent_boundary_is_proven';
    minimumSpecs: number;
    maximumSpecs: number;
    acceptedBoundarySignals: readonly string[];
    exactRequirementOwnership: true;
    acyclicDependenciesRequired: true;
    confirmationRequiredWhen: readonly ['multi_spec', 'high_risk'];
  };
  lifecycleProfile: AuthoringPlan['lifecycleProfile'];
  requiredPhaseObligations: AuthoringPlan['lifecycleProfile']['phaseContributions'];
  requiredStoryCapabilities: StoryCapability[];
  evidenceExpectations: Array<{ phaseId: string; gateIds: string[]; expectation: string }>;
  draftScaffold: {
    schemaVersion: 'authoring-draft-scaffold.v1';
    planHash: string;
    recommendedTotalStoryCount: number;
    boundaries: Array<{
      specReference: string;
      slugSeed: string;
      storySlots: Array<{
        slotId: string;
        requirementReferences: string[];
        capabilities: StoryCapability[];
        phaseIds: string[];
        gateIds: string[];
        evidenceExpectations: string[];
      }>;
    }>;
  };
  wordingRules: {
    modelOwnsReadableProse: true;
    requireObservableAcceptanceCriteria: true;
    prohibitCannedProse: true;
    negativeAndRecoveryPathsRequiredWhenApplicable: true;
  };
  preflightContract: {
    endpoint: '/api/specs/authoring/preflight';
    confirmationEndpoint: '/api/specs/authoring/preflight/confirm';
    persistenceEndpoints: readonly ['/api/specs/persist', '/api/specs/persist/batch'];
    plannerVersion: typeof SSDLC_AUTHORING_PLANNER_VERSION;
    maximumRevisionAttempts: typeof DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS;
    acceptedPlanSchema: unknown;
    resultSchema: unknown;
    draftMutationAuthority: 'none';
  };
  authorityBoundary: {
    evaluatedLifecycleStatus: 'forbidden';
    completionEvidence: 'forbidden';
    gateWaiver: 'forbidden';
    dispositionApproval: 'forbidden';
    retryMergeDeployAuthorization: 'forbidden';
    productionMutation: 'forbidden';
    executionDispatch: 'forbidden';
  };
  plannerInputSeed: z.infer<typeof AuthoringPlannerInputSchema>;
}

export interface AuthoringPreflightEnvelope {
  state: 'accepted' | 'revision_required' | 'blocked';
  attempt: number;
  maximumAttempts: typeof DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS;
  acceptedPlan: AuthoringPlan | null;
  acceptedPlanHash: string | null;
  acceptedPreflightHash: string | null;
  preflight: AuthoringPreflightResult | null;
  diagnostics: AuthoringDiagnostic[];
  amendments: AuthoringPreflightResult['amendments'];
  clarificationQuestions: string[];
  attemptSummary: z.infer<typeof AttemptSummarySchema>;
  inspection: null | {
    exactSpecCount: number;
    boundaries: AuthoringPlan['specBoundaries'];
    requirementOwnership: Array<{ requirementReference: string; ownerSpecReference: string }>;
    dependencyDag: AuthoringPlan['crossSpecDependencies'];
    requiredStoryCapabilities: StoryCapability[];
    materialRevisions: string[];
  };
  confirmationRequired: boolean;
  authoritativePersistenceAllowed: boolean;
  executionAuthority: 'none';
}

export interface CanonicalAuthoringStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(value), 'utf8').digest('hex')}`;
}

function normalizedText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function classifyLifecycleProfile(brief: string, predictedFiles: string[]): AuthoringLifecycleProfileId {
  const signal = `${brief} ${predictedFiles.join(' ')}`.toLocaleLowerCase('en-US');
  if (/\b(release|deploy|deployment|production|canary|rollback)\b/.test(signal)) return 'release-operations';
  if (/\b(security|authentication|authorization|secret|tenant|privacy|compliance|vulnerabilit)/.test(signal)) return 'security-sensitive';
  if (/\b(database|postgres|schema|migration|storage|backfill)\b|\.sql\b/.test(signal)) return 'data-storage';
  if (/\b(integration|webhook|slack|chatops|third[- ]party|external api)\b/.test(signal)) return 'integration';
  if (/\b(docs?|documentation|readme|diagram)\b/.test(signal)
    && predictedFiles.length > 0
    && predictedFiles.every((file) => /(?:^|\/)(?:docs?|readme)(?:\/|\.|$)|\.mdx?$/.test(file.toLocaleLowerCase('en-US')))) {
    return 'docs-only';
  }
  return 'code-change';
}

function contextPredictedFiles(contextSummary: Record<string, unknown>): string[] {
  return Array.isArray(contextSummary.predictedFiles)
    ? contextSummary.predictedFiles.filter((value): value is string => typeof value === 'string').slice(0, 30)
    : [];
}

export function buildLifecycleAuthoringSection(input: {
  workspaceId: string;
  title: string;
  brief: string;
  contextUsed: unknown;
  contextSummary: Record<string, unknown>;
  invocationSurface?: string;
}): LifecycleAuthoringSection {
  const normalizedIntentIdentity = normalizeAuthoringIntent({
    outcome: input.title,
    brief: input.brief,
    requirements: [{ reference: 'REQ-001', sourceReference: 'brief:1', text: input.brief }],
  });
  const predictedFiles = contextPredictedFiles(input.contextSummary);
  const profileId = classifyLifecycleProfile(input.brief, predictedFiles);
  const sourceContentHash = hash({
    workspaceId: input.workspaceId,
    normalizedIntentHash: normalizedIntentIdentity.normalizedIntentHash,
    contextUsed: input.contextUsed,
    contextSummary: input.contextSummary,
    profileId,
  });
  const sourceContextIdentity = {
    contextId: `forge-context:${sourceContentHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    version: SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION,
    contentHash: sourceContentHash,
  } as const;
  const policyBody = {
    version: SSDLC_AUTHORING_POLICY_VERSION,
    maximumSpecs: AUTHORING_SPEC_LIMITS.maximum,
    allowedBoundarySignals: [...SPEC_BOUNDARY_SIGNAL_KINDS],
    requiredStoryCapabilities: [] as StoryCapability[],
    allowHumanOverrides: false,
    allowedOverrideKinds: [] as Array<'decomposition' | 'capabilities'>,
    storyQuality: {
      maximumRequirementsPerStory: 8,
      maximumAcceptanceCriteriaPerStory: 12,
      maximumCapabilitiesPerStory: 7,
    },
  };
  const plannerInputSeed = AuthoringPlannerInputSchema.parse({
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    sourceContext: sourceContextIdentity,
    intent: normalizedIntentIdentity,
    workspacePolicy: { ...policyBody, contentHash: hash(policyBody) },
    lifecycleProfile: profileId,
    boundaryCandidates: [],
    overrides: [],
    provenance: {
      invocationSurface: input.invocationSurface ?? 'api.specs.generation-context',
      generationContextId: sourceContextIdentity.contextId,
      specGenerationLogIds: [],
      walEventIds: [],
    },
    plannerVersion: SSDLC_AUTHORING_PLANNER_VERSION,
  });
  const planned = planAuthoring(plannerInputSeed);
  if (!planned.acceptedPlan) {
    throw new ValidationError('Lifecycle authoring profile could not produce a deterministic baseline plan', {
      state: 'authoring_profile_invalid',
      diagnostics: planned.diagnostics,
    });
  }
  const acceptedPlan = planned.acceptedPlan;

  return {
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    profileVersion: SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION,
    status: 'ready',
    normalizedIntentIdentity,
    sourceContextIdentity,
    decompositionPolicy: {
      defaultDecision: 'one_spec_unless_independent_boundary_is_proven',
      minimumSpecs: AUTHORING_SPEC_LIMITS.minimum,
      maximumSpecs: AUTHORING_SPEC_LIMITS.maximum,
      acceptedBoundarySignals: SPEC_BOUNDARY_SIGNAL_KINDS,
      exactRequirementOwnership: true,
      acyclicDependenciesRequired: true,
      confirmationRequiredWhen: ['multi_spec', 'high_risk'],
    },
    lifecycleProfile: planned.acceptedPlan.lifecycleProfile,
    requiredPhaseObligations: planned.acceptedPlan.lifecycleProfile.phaseContributions,
    requiredStoryCapabilities: planned.acceptedPlan.requiredStoryCapabilities,
    evidenceExpectations: planned.acceptedPlan.lifecycleProfile.phaseContributions.map((phase) => ({
      phaseId: phase.phaseId,
      gateIds: phase.gateIds,
      expectation: phase.evidenceExpectation,
    })),
    draftScaffold: {
      schemaVersion: 'authoring-draft-scaffold.v1',
      planHash: acceptedPlan.acceptedPlanHash,
      recommendedTotalStoryCount: Math.max(1, Math.min(20, acceptedPlan.lifecycleProfile.phaseContributions.length)),
      boundaries: acceptedPlan.specBoundaries.map((boundary) => ({
        specReference: boundary.specReference,
        slugSeed: boundary.slugSeed,
        storySlots: [{
          slotId: `${boundary.specReference}:slot:1`,
          requirementReferences: [...new Set([...boundary.ownedRequirementReferences, ...boundary.referencedRequirementReferences])],
          capabilities: acceptedPlan.requiredStoryCapabilities,
          phaseIds: acceptedPlan.lifecycleProfile.phaseContributions.map((phase) => phase.phaseId),
          gateIds: [...new Set(acceptedPlan.lifecycleProfile.phaseContributions.flatMap((phase) => phase.gateIds))],
          evidenceExpectations: acceptedPlan.lifecycleProfile.phaseContributions.map((phase) => phase.evidenceExpectation),
        }],
      })),
    },
    wordingRules: {
      modelOwnsReadableProse: true,
      requireObservableAcceptanceCriteria: true,
      prohibitCannedProse: true,
      negativeAndRecoveryPathsRequiredWhenApplicable: true,
    },
    preflightContract: {
      endpoint: '/api/specs/authoring/preflight',
      confirmationEndpoint: '/api/specs/authoring/preflight/confirm',
      persistenceEndpoints: ['/api/specs/persist', '/api/specs/persist/batch'],
      plannerVersion: SSDLC_AUTHORING_PLANNER_VERSION,
      maximumRevisionAttempts: DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS,
      acceptedPlanSchema: AUTHORING_PLAN_JSON_SCHEMA,
      resultSchema: AUTHORING_PREFLIGHT_JSON_SCHEMA,
      draftMutationAuthority: 'none',
    },
    authorityBoundary: {
      evaluatedLifecycleStatus: 'forbidden',
      completionEvidence: 'forbidden',
      gateWaiver: 'forbidden',
      dispositionApproval: 'forbidden',
      retryMergeDeployAuthorization: 'forbidden',
      productionMutation: 'forbidden',
      executionDispatch: 'forbidden',
    },
    plannerInputSeed,
  };
}

export function authoringConfirmationRequired(plan: AuthoringPlan): boolean {
  if (plan.recommendedSpecCount > 1) return true;
  if (['security-sensitive', 'data-storage', 'release-operations'].includes(plan.lifecycleProfile.profileId)) return true;
  return plan.specBoundaries.some((boundary) => boundary.riskHints.some((hint) => /\b(high|critical)\b/i.test(hint)));
}

export function runAuthoringPreflight(candidate: unknown): AuthoringPreflightEnvelope {
  const input = AuthoringPreflightRequestSchema.parse(candidate);
  if (input.plannerInput.workspaceId !== String(input.workspaceId)) {
    throw new ValidationError('Authoring planner workspace does not match request workspace', {
      requestWorkspaceId: String(input.workspaceId),
      plannerWorkspaceId: input.plannerInput.workspaceId,
    });
  }
  const planning = planAuthoring(input.plannerInput);
  const plan = planning.acceptedPlan;
  const preflight = plan ? preflightAuthoringDraft({
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    acceptedPlan: plan,
    planHash: plan.acceptedPlanHash,
    specs: input.specs,
  }) : null;
  const diagnostics = plan ? preflight!.diagnostics : planning.diagnostics;
  const accepted = Boolean(plan && preflight?.accepted);
  const materialRevisions = [
    ...input.priorAttempts.flatMap((attempt) => attempt.materialRevisions),
    ...input.materialRevisions,
  ].slice(-64);
  const exhausted = !accepted && input.attempt >= DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS;
  const state = accepted ? 'accepted' as const : exhausted ? 'blocked' as const : 'revision_required' as const;
  const attemptSummary = AttemptSummarySchema.parse({
    attempt: input.attempt,
    accepted,
    diagnosticCategories: [...new Set(diagnostics.map((item) => item.code))].sort(),
    materialRevisions: input.materialRevisions,
  });
  const ownership = plan?.specBoundaries.flatMap((boundary) => boundary.ownedRequirementReferences.map((reference) => ({
    requirementReference: reference,
    ownerSpecReference: boundary.specReference,
  }))) ?? [];

  return {
    state,
    attempt: input.attempt,
    maximumAttempts: DEFAULT_AUTHORING_PREFLIGHT_ATTEMPTS,
    acceptedPlan: plan,
    acceptedPlanHash: plan?.acceptedPlanHash ?? null,
    acceptedPreflightHash: preflight?.acceptedPreflightHash ?? null,
    preflight,
    diagnostics,
    amendments: preflight?.amendments ?? [],
    clarificationQuestions: diagnostics.filter((item) => item.severity === 'question').map((item) => item.message),
    attemptSummary,
    inspection: plan ? {
      exactSpecCount: plan.recommendedSpecCount,
      boundaries: plan.specBoundaries,
      requirementOwnership: ownership,
      dependencyDag: plan.crossSpecDependencies,
      requiredStoryCapabilities: plan.requiredStoryCapabilities,
      materialRevisions,
    } : null,
    confirmationRequired: plan ? authoringConfirmationRequired(plan) : false,
    authoritativePersistenceAllowed: accepted && !authoringConfirmationRequired(plan!),
    executionAuthority: 'none',
  };
}

const EVIDENCE_KIND_BY_CAPABILITY: Record<StoryCapability, ProposedStory['evidenceExpectations'][number]['kind']> = {
  contract: 'contract_review',
  migration: 'migration_check',
  implementation: 'change_review',
  validation: 'automated_test',
  security: 'security_assessment',
  qa: 'qa_assessment',
  journey: 'journey_observation',
  rollout: 'rollout_verification',
  recovery: 'recovery_exercise',
  operations: 'operational_observation',
  learning: 'learning_review',
};

/** Compatibility adapter for backend-owned forge clients that still return canonical story prose only. */
export function adaptCanonicalStoriesToAuthoringDraft(
  plan: AuthoringPlan,
  storiesBySpec: Array<{ specReference: string; stories: CanonicalAuthoringStory[] }>,
): ProposedSpecDraft[] {
  return storiesBySpec.map(({ specReference, stories }) => {
    const boundary = plan.specBoundaries.find((candidate) => candidate.specReference === specReference);
    if (!boundary) throw new ValidationError(`Unknown authoring boundary ${specReference}`);
    const storyCount = stories.length;
    if (storyCount === 0) throw new ValidationError(`Authoring boundary ${specReference} has no stories`);
    const phases = plan.lifecycleProfile.phaseContributions;
    return {
      specReference,
      stories: stories.map((story, storyIndex) => {
        const capabilities = boundary.requiredStoryCapabilities.filter((_, index) => index % storyCount === storyIndex);
        if (capabilities.length === 0) capabilities.push('implementation');
        const contributions = phases.filter((_, index) => index % storyCount === storyIndex);
        if (contributions.length === 0) contributions.push(phases[storyIndex % phases.length]);
        const requirementReferences = [...new Set([
          ...boundary.ownedRequirementReferences,
          ...boundary.referencedRequirementReferences,
        ])];
        const expectationId = `${story.id}:evidence`;
        return {
          id: story.id,
          title: story.title,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria.map((criterion, criterionIndex) => ({
            criterionId: `${story.id}:criterion:${criterionIndex + 1}`,
            text: criterion,
            observableOutcome: `A test or review reports whether: ${criterion}`,
            requirementReferences,
            evidenceExpectationIds: [expectationId],
          })),
          requirementReferences,
          dependsOn: [...story.dependsOn],
          capabilities,
          expectedContributions: {
            phaseIds: contributions.map((phase) => phase.phaseId),
            gateIds: contributions.flatMap((phase) => phase.gateIds),
          },
          evidenceExpectations: [{
            expectationId,
            kind: EVIDENCE_KIND_BY_CAPABILITY[capabilities[0]],
            description: `A test, review, or operator check reports the observable outcomes for ${story.id}; this is an expectation, not completion evidence.`,
            observable: true as const,
          }],
          negativeCoverage: capabilities.some((capability) => capability === 'security' || capability === 'migration')
            ? [`Denied, invalid, and integrity-failure paths for ${story.id} are observable.`]
            : [],
          recoveryCoverage: capabilities.includes('recovery')
            ? [`Rollback, retry, restore, or safe-degradation behavior for ${story.id} is observable.`]
            : [],
          crossSpecReferences: [...boundary.dependencySpecReferences],
        };
      }),
    };
  });
}

function storyMaterialIdentity(stories: CanonicalAuthoringStory[]): unknown {
  return stories.map((story) => ({
    id: story.id,
    title: normalizedText(story.title).toLocaleLowerCase('en-US'),
    description: normalizedText(stripAppendedContextBlock(story.description)).toLocaleLowerCase('en-US'),
    acceptanceCriteria: story.acceptanceCriteria.map(normalizeAcceptanceCriterionText).sort(),
    dependsOn: [...story.dependsOn].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

export function deriveCanonicalStoryMaterialHash(stories: CanonicalAuthoringStory[]): `sha256:${string}` {
  return hash(storyMaterialIdentity(stories));
}

function proposedCanonicalStories(spec: ProposedSpecDraft): CanonicalAuthoringStory[] {
  return spec.stories.map((story) => ({
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria.map((criterion) => criterion.text),
    dependsOn: story.dependsOn,
  }));
}

export function validatePersistAuthoringBinding(input: {
  workspaceId: string;
  slug: string;
  stories: CanonicalAuthoringStory[];
  binding: unknown;
}): { binding: PersistAuthoringBinding; spec: ProposedSpecDraft; preflight: AuthoringPreflightResult } {
  const binding = PersistAuthoringBindingSchema.parse(input.binding);
  if (binding.acceptedPlan.workspaceId !== input.workspaceId) {
    throw new ValidationError('Authoring plan workspace does not match persistence workspace');
  }
  if (binding.planHash !== binding.acceptedPlan.acceptedPlanHash) {
    throw new UnprocessableError('Authoring plan hash is stale', 'STALE_AUTHORING_PREFLIGHT', {
      suppliedPlanHash: binding.planHash,
      acceptedPlanHash: binding.acceptedPlan.acceptedPlanHash,
    });
  }
  const preflight = preflightAuthoringDraft({
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    acceptedPlan: binding.acceptedPlan,
    planHash: binding.planHash,
    specs: binding.specs,
  });
  if (!preflight.accepted || preflight.acceptedPreflightHash !== binding.acceptedPreflightHash) {
    throw new UnprocessableError('Authoring preflight is stale or no longer accepted', 'STALE_AUTHORING_PREFLIGHT', {
      accepted: preflight.accepted,
      expectedPreflightHash: preflight.acceptedPreflightHash,
      suppliedPreflightHash: binding.acceptedPreflightHash,
      diagnostics: preflight.diagnostics,
    });
  }
  const boundary = binding.acceptedPlan.specBoundaries.find((candidate) => candidate.slugSeed === input.slug);
  if (!boundary) {
    throw new UnprocessableError('Persisted slug does not identify an accepted authoring boundary', 'STALE_AUTHORING_PREFLIGHT', {
      slug: input.slug,
      acceptedSlugs: binding.acceptedPlan.specBoundaries.map((candidate) => candidate.slugSeed),
    });
  }
  const spec = binding.specs.find((candidate) => candidate.specReference === boundary.specReference);
  if (!spec) throw new UnprocessableError('Accepted authoring boundary has no draft', 'STALE_AUTHORING_PREFLIGHT');
  const submittedMaterialHash = deriveCanonicalStoryMaterialHash(input.stories);
  const preflightMaterialHash = deriveCanonicalStoryMaterialHash(proposedCanonicalStories(spec));
  if (submittedMaterialHash !== preflightMaterialHash) {
    throw new UnprocessableError('Canonical stories drifted after authoring preflight', 'STALE_AUTHORING_PREFLIGHT', {
      submittedMaterialHash,
      preflightMaterialHash,
      specReference: spec.specReference,
    });
  }
  return { binding, spec, preflight };
}

export async function assertAuthoritativePreflightReceipt(
  workspaceId: string,
  binding: PersistAuthoringBinding,
): Promise<void> {
  const receipt = await queryOne<{ id: number }>(
    `SELECT id FROM wal_events
     WHERE id = $1
       AND workspace_id = $2
       AND event_type = 'spec_authoring_preflight'
       AND payload::jsonb->>'state' = 'accepted'
       AND payload::jsonb->>'acceptedPlanHash' = $3
       AND payload::jsonb->>'acceptedPreflightHash' = $4`,
    [binding.preflightReceiptId, workspaceId, binding.planHash, binding.acceptedPreflightHash],
  );
  if (!receipt) {
    throw new UnprocessableError(
      'Accepted authoring preflight receipt is missing, stale, or belongs to another workspace',
      'STALE_AUTHORING_PREFLIGHT',
      { preflightReceiptId: binding.preflightReceiptId },
    );
  }
}

export async function assertAuthoringConfirmation(
  workspaceId: string,
  binding: PersistAuthoringBinding,
): Promise<void> {
  if (!authoringConfirmationRequired(binding.acceptedPlan)) return;
  if (!binding.confirmationReceiptId) {
    throw new UnprocessableError(
      'Explicit human confirmation is required before this multi-spec or high-risk plan can persist',
      'AUTHORING_CONFIRMATION_REQUIRED',
      {
        acceptedPlanHash: binding.planHash,
        acceptedPreflightHash: binding.acceptedPreflightHash,
      },
    );
  }
  const receipt = await queryOne<{ id: number }>(
    `SELECT id FROM wal_events
     WHERE id = $1
       AND workspace_id = $2
       AND event_type = 'spec_authoring_plan_confirmed'
       AND payload::jsonb->>'acceptedPlanHash' = $3
       AND payload::jsonb->>'acceptedPreflightHash' = $4`,
    [binding.confirmationReceiptId, workspaceId, binding.planHash, binding.acceptedPreflightHash],
  );
  if (!receipt) {
    throw new UnprocessableError(
      'Authoring confirmation receipt is missing, stale, or belongs to another workspace',
      'AUTHORING_CONFIRMATION_REQUIRED',
      { confirmationReceiptId: binding.confirmationReceiptId },
    );
  }
}

export function buildPersistedAuthoringMetadata(input: {
  binding?: PersistAuthoringBinding;
  spec?: ProposedSpecDraft;
  stories: CanonicalAuthoringStory[];
}): Record<string, unknown> {
  if (!input.binding || !input.spec) {
    return {
      schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
      state: 'needs_authoring_preflight',
      approvalReady: false,
      reasonCode: 'needs_authoring_preflight',
      action: 'Fetch generation-context, submit the unchanged draft to /api/specs/authoring/preflight, and persist an accepted binding.',
      storiesRewritten: false,
    };
  }
  const boundary = input.binding.acceptedPlan.specBoundaries.find((candidate) => (
    candidate.specReference === input.spec!.specReference
  ))!;
  const parentAuthoringPlan = {
    acceptedPlanHash: input.binding.planHash,
    acceptedPreflightHash: input.binding.acceptedPreflightHash,
    normalizedIntentHash: input.binding.acceptedPlan.normalizedIntentHash,
    proposedSpecCount: input.binding.specs.length,
    acceptedSpecCount: input.binding.acceptedPlan.recommendedSpecCount,
  };
  const requirements = input.binding.acceptedPlan.requirements.filter((requirement) => (
    boundary.ownedRequirementReferences.includes(requirement.reference)
    || boundary.referencedRequirementReferences.includes(requirement.reference)
  ));
  const authoringMaterialHash = hash({
    parentAuthoringPlan,
    specReference: input.spec.specReference,
    boundary,
    requirements,
    storyAnnotations: input.spec.stories,
  });
  return {
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    profileVersion: input.binding.profileVersion,
    state: 'validated',
    approvalReady: true,
    parentAuthoringPlan,
    specReference: input.spec.specReference,
    boundary,
    requirements,
    storyAnnotations: input.spec.stories,
    preflight: {
      attemptCount: input.binding.preflightAttemptCount,
      priorAttempts: input.binding.priorAttempts,
      materialRevisions: input.binding.materialRevisions,
      callerSurface: input.binding.callerSurface,
      model: input.binding.model ?? null,
      canonicalMaterialHash: deriveCanonicalStoryMaterialHash(input.stories),
      authoringMaterialHash,
      diagnosticCategories: [],
    },
    preflightReceiptId: input.binding.preflightReceiptId,
    confirmationReceiptId: input.binding.confirmationReceiptId ?? null,
    lifecycleCompiler: { state: 'pending_authoritative_compile' },
    executionAuthority: 'none',
  };
}

export function refreshAuthoringStateAfterEdit(content: Record<string, unknown>): boolean {
  const authoring = content.authoring;
  if (!authoring || typeof authoring !== 'object' || Array.isArray(authoring)) return false;
  const metadata = authoring as Record<string, unknown>;
  if (metadata.state !== 'validated') return false;
  const preflight = metadata.preflight;
  const preflightMetadata = preflight && typeof preflight === 'object' && !Array.isArray(preflight)
    ? preflight as Record<string, unknown>
    : {};
  const expected = preflightMetadata.canonicalMaterialHash;
  const expectedAuthoring = preflightMetadata.authoringMaterialHash;
  const stories = Array.isArray(content.userStories) ? content.userStories as CanonicalAuthoringStory[] : [];
  const current = deriveCanonicalStoryMaterialHash(stories);
  const currentAuthoring = hash({
    parentAuthoringPlan: metadata.parentAuthoringPlan,
    specReference: metadata.specReference,
    boundary: metadata.boundary,
    requirements: metadata.requirements,
    storyAnnotations: metadata.storyAnnotations,
  });
  if (expected === current && expectedAuthoring === currentAuthoring) return false;
  metadata.state = 'stale_authoring_preflight';
  metadata.approvalReady = false;
  metadata.reasonCode = 'stale_authoring_preflight';
  metadata.stale = {
    expectedMaterialHash: expected,
    currentMaterialHash: current,
    expectedAuthoringMaterialHash: expectedAuthoring,
    currentAuthoringMaterialHash: currentAuthoring,
  };
  metadata.lifecycleCompiler = { state: 'superseded_by_material_edit' };
  return true;
}

export async function supersedeCurrentLifecyclePlan(workspaceId: string, specSlug: string): Promise<void> {
  await execute(
    `UPDATE ssdlc_compiled_plans
     SET is_current = FALSE, updated_at = NOW()
     WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE`,
    [workspaceId, specSlug],
  );
}

function compilerProjection(input: {
  workspaceId: string;
  slug: string;
  version: number;
  content: Record<string, unknown>;
  binding: PersistAuthoringBinding;
  spec: ProposedSpecDraft;
}) {
  const stories = Array.isArray(input.content.userStories) ? input.content.userStories as CanonicalAuthoringStory[] : [];
  const contextSummary = input.content.contextSummary && typeof input.content.contextSummary === 'object'
    ? input.content.contextSummary as Record<string, unknown>
    : {};
  const predictedFiles = contextPredictedFiles(contextSummary).sort();
  const requirementStoryReferences = new Map<string, Set<string>>();
  for (const story of input.spec.stories) {
    for (const reference of story.requirementReferences) {
      const refs = requirementStoryReferences.get(reference) ?? new Set<string>();
      refs.add(story.id);
      requirementStoryReferences.set(reference, refs);
    }
  }
  const boundary = input.binding.acceptedPlan.specBoundaries.find((candidate) => candidate.specReference === input.spec.specReference)!;
  const requirements = input.binding.acceptedPlan.requirements
    .filter((requirement) => boundary.ownedRequirementReferences.includes(requirement.reference))
    .map((requirement) => ({
      id: requirement.reference,
      text: requirement.text,
      storyReferences: [...(requirementStoryReferences.get(requirement.reference) ?? [])].sort(),
      architectureDecisionReferences: [],
    }));
  const profileId = input.binding.acceptedPlan.lifecycleProfile.profileId;
  const projectedJson = {
    title: normalizedText(input.content.title ?? input.slug),
    userStories: stories.map((story) => ({
      id: story.id,
      title: story.title,
      description: stripAppendedContextBlock(story.description),
      acceptanceCriteria: story.acceptanceCriteria,
      tags: [],
      fileHints: [],
    })),
    tags: [profileId].sort(),
    fileHints: profileId === 'docs-only' && predictedFiles.length === 0 ? ['docs/authoring-spec.md'] : predictedFiles,
    ...(predictedFiles.length > 0 ? { contextSummary: { predictedFiles } } : {}),
    architectureDecisions: [],
    requirements,
  };
  return {
    schemaVersion: SSDLC_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    canonicalSpec: {
      specId: input.slug,
      version: String(input.version),
      contentHash: hash(projectedJson),
      json: projectedJson,
    },
    workspaceTags: [{ workspaceId: input.workspaceId, tag: profileId }],
    riskAssignments: authoringConfirmationRequired(input.binding.acceptedPlan) ? [{
      workspaceId: input.workspaceId,
      assignmentId: `authoring-risk:${input.slug}`,
      scopeReference: input.spec.specReference,
      risk: 'high' as const,
      rationale: 'Authoritative authoring policy classified this plan as confirmation-required.',
    }] : [],
    ownerAssignments: [],
    policyAnnotations: [],
    compilerAnnotations: [],
    compilerVersion: SSDLC_PLAN_COMPILER_VERSION,
    policyVersion: input.binding.acceptedPlan.workspacePolicyVersion,
    compiledAt: new Date().toISOString(),
  };
}

export async function compilePersistedAuthoringSpec(input: {
  workspaceId: string;
  slug: string;
  version: number;
  specPath: string;
  binding: PersistAuthoringBinding;
  spec: ProposedSpecDraft;
}): Promise<{ planId: string; inputHash: string; profiles: string[]; riskLevel: string }> {
  const content = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(input.specPath, 'utf8'))) as Record<string, unknown>;
  const currentStories = Array.isArray(content.userStories) ? content.userStories as CanonicalAuthoringStory[] : [];
  const currentMaterialHash = deriveCanonicalStoryMaterialHash(currentStories);
  const expectedMaterialHash = deriveCanonicalStoryMaterialHash(proposedCanonicalStories(input.spec));
  const preflightHash = deriveAuthoringPreflightHash({
    acceptedPlan: input.binding.acceptedPlan,
    planHash: input.binding.planHash,
    specs: input.binding.specs,
  });
  if (currentMaterialHash !== expectedMaterialHash || preflightHash !== input.binding.acceptedPreflightHash) {
    throw new UnprocessableError('Post-save canonical content is stale against accepted authoring preflight', 'STALE_AUTHORING_PREFLIGHT', {
      currentMaterialHash,
      expectedMaterialHash,
      computedPreflightHash: preflightHash,
      acceptedPreflightHash: input.binding.acceptedPreflightHash,
      specPath: input.specPath,
    });
  }
  const compilation = compileLifecyclePlan(compilerProjection({
    workspaceId: input.workspaceId,
    slug: input.slug,
    version: input.version,
    content,
    binding: input.binding,
    spec: input.spec,
  }));
  await createCompiledPlan({
    workspaceId: input.workspaceId,
    specSlug: input.slug,
    specVersion: input.version,
    compilerVersion: compilation.plan.compilerVersion,
    normalizedInputHash: compilation.plan.inputHash,
    schemaVersion: String(compilation.schemaVersion),
    plan: compilation.plan as unknown as Record<string, unknown>,
    validationStatus: 'validated',
  });
  return {
    planId: compilation.plan.planId,
    inputHash: compilation.plan.inputHash,
    profiles: compilation.profiles,
    riskLevel: compilation.riskLevel,
  };
}

export function markAuthoritativeCompilation(
  content: Record<string, unknown>,
  compilation: { planId: string; inputHash: string; profiles: string[]; riskLevel: string },
): void {
  const authoring = content.authoring as Record<string, unknown> | undefined;
  if (!authoring) return;
  authoring.lifecycleCompiler = {
    state: 'validated',
    compilerVersion: SSDLC_PLAN_COMPILER_VERSION,
    planId: compilation.planId,
    normalizedInputHash: compilation.inputHash,
    profiles: compilation.profiles,
    riskLevel: compilation.riskLevel,
    evaluatedStatusAuthority: 'none',
  };
}

export function authoringTelemetry(binding: PersistAuthoringBinding | undefined, outcome: string): Record<string, unknown> {
  if (!binding) {
    return {
      authoringProfileVersion: SSDLC_LIFECYCLE_AUTHORING_PROFILE_VERSION,
      authoringState: 'needs_authoring_preflight',
      proposedSpecCount: null,
      acceptedSpecCount: null,
      preflightAttemptCount: 0,
      diagnosticsCategories: ['needs_authoring_preflight'],
      acceptedPlanHash: null,
      acceptedPreflightHash: null,
      callerSurface: 'legacy-explicit-draft',
      model: null,
      persistenceOutcome: outcome,
    };
  }
  return {
    authoringProfileVersion: binding.profileVersion,
    authoringState: 'validated',
    proposedSpecCount: binding.specs.length,
    acceptedSpecCount: binding.acceptedPlan.recommendedSpecCount,
    preflightAttemptCount: binding.preflightAttemptCount,
    diagnosticsCategories: [],
    acceptedPlanHash: binding.planHash,
    acceptedPreflightHash: binding.acceptedPreflightHash,
    callerSurface: binding.callerSurface,
    model: binding.model ?? null,
    persistenceOutcome: outcome,
  };
}

export const AUTHORING_PROFILE_IDS = AUTHORING_LIFECYCLE_PROFILES;
export const AUTHORING_STORY_CAPABILITIES = STORY_CAPABILITIES;
