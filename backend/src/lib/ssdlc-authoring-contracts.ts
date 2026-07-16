/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Versioned, side-effect-free contracts for intent decomposition and story
 * authoring preflight. These DTOs describe proposals and validated plans only;
 * they deliberately contain no evaluated phase status, evidence facts,
 * execution-mode selection, gate waiver, persistence instruction, or approval.
 */

import { z } from 'zod';
import {
  CANONICAL_PHASE_IDS,
  ExplicitRequirementIdSchema,
  PhaseIdSchema,
  RequirementReferenceSchema,
  StoryReferenceSchema,
} from './ssdlc-contracts';

export const SSDLC_AUTHORING_SCHEMA_VERSION = 1 as const;
export const AUTHORING_SPEC_LIMITS = Object.freeze({ minimum: 1, maximum: 12 });

export const STORY_CAPABILITIES = [
  'contract',
  'migration',
  'implementation',
  'validation',
  'security',
  'qa',
  'journey',
  'rollout',
  'recovery',
  'operations',
  'learning',
] as const;

export const AUTHORING_LIFECYCLE_PROFILES = [
  'docs-only',
  'code-change',
  'data-storage',
  'security-sensitive',
  'integration',
  'release-operations',
] as const;

export const SPEC_BOUNDARY_SIGNAL_KINDS = [
  'independent_acceptance',
  'independent_release',
  'independent_rollback',
  'distinct_ownership',
  'security_isolation',
  'data_migration_isolation',
  'different_risk_approval_policy',
] as const;

export const AUTHORING_DIAGNOSTIC_CODES = [
  'AMBIGUOUS_DECOMPOSITION',
  'BOUNDARY_NOT_INDEPENDENT',
  'CONFLICTING_REQUIREMENTS',
  'CONTRADICTORY_BOUNDARY',
  'CROSS_SPEC_CYCLE',
  'DUPLICATE_ACCEPTANCE_CRITERION',
  'DUPLICATE_REQUIREMENT_OWNER',
  'DUPLICATE_STORY_ID',
  'EXCESSIVE_SPLITTING',
  'GIANT_UMBRELLA_STORY',
  'HIDDEN_CROSS_SPEC_WORK',
  'IMPLEMENTATION_ONLY_STORY',
  'IMPOSSIBLE_SEQUENCE',
  'INTENT_HASH_MISMATCH',
  'INVALID_AUTHORING_INPUT',
  'INVALID_OVERRIDE',
  'MISSING_CAPABILITY_COVERAGE',
  'MISSING_EVIDENCE_EXPECTATION',
  'MISSING_NEGATIVE_COVERAGE',
  'MISSING_RECOVERY_COVERAGE',
  'NON_AUTHORITATIVE_FIELD',
  'NON_OBSERVABLE_CRITERION',
  'ORPHAN_REQUIREMENT',
  'OVERLAPPING_BOUNDARY',
  'PLAN_HASH_MISMATCH',
  'PLANNER_VERSION_MISMATCH',
  'RECOMMENDED_SINGLE_SPEC',
  'STORY_DEPENDENCY_CYCLE',
  'UNKNOWN_DEPENDENCY',
  'UNKNOWN_GATE_CONTRIBUTION',
  'UNKNOWN_PHASE_CONTRIBUTION',
  'UNKNOWN_REQUIREMENT_REFERENCE',
  'UNKNOWN_SPEC_REFERENCE',
  'VAGUE_WORDING',
] as const;

const NonEmptyStringSchema = z.string().trim().min(1, 'Value must be non-empty');
const StableReferenceSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9._:/-]{1,127}$/, 'Value must be a stable 2-128 character reference');
const Sha256Schema = z.string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Value must be a lowercase sha256:<64 hex> digest');
const SlugSeedSchema = z.string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug seed must use lowercase words separated by hyphens')
  .min(2)
  .max(80);
const SortedUniqueStringsSchema = z.array(NonEmptyStringSchema).transform((values) => (
  [...new Set(values)].sort((left, right) => left.localeCompare(right))
));

export const StoryCapabilitySchema = z.enum(STORY_CAPABILITIES);
export const AuthoringLifecycleProfileIdSchema = z.enum(AUTHORING_LIFECYCLE_PROFILES);
export const SpecBoundarySignalKindSchema = z.enum(SPEC_BOUNDARY_SIGNAL_KINDS);
export const AuthoringDiagnosticCodeSchema = z.enum(AUTHORING_DIAGNOSTIC_CODES);

export type StoryCapability = z.infer<typeof StoryCapabilitySchema>;
export type AuthoringLifecycleProfileId = z.infer<typeof AuthoringLifecycleProfileIdSchema>;
export type SpecBoundarySignalKind = z.infer<typeof SpecBoundarySignalKindSchema>;

export const AuthoringDiagnosticSchema = z.object({
  code: AuthoringDiagnosticCodeSchema,
  severity: z.enum(['blocker', 'warning', 'question', 'info']),
  path: NonEmptyStringSchema,
  message: NonEmptyStringSchema,
  references: SortedUniqueStringsSchema.default([]),
  amendment: NonEmptyStringSchema.optional(),
}).strict();

export type AuthoringDiagnostic = z.infer<typeof AuthoringDiagnosticSchema>;

export const NormalizedAuthoringRequirementSchema = z.object({
  reference: ExplicitRequirementIdSchema,
  sourceReference: StableReferenceSchema,
  text: NonEmptyStringSchema,
  normalizedText: NonEmptyStringSchema,
  conflictsWith: z.array(ExplicitRequirementIdSchema).default([]),
}).strict();

export const NormalizedAuthoringIntentSchema = z.object({
  outcome: NonEmptyStringSchema,
  normalizedBrief: NonEmptyStringSchema,
  normalizedIntentHash: Sha256Schema,
  requirements: z.array(NormalizedAuthoringRequirementSchema).min(1),
  ambiguities: SortedUniqueStringsSchema.default([]),
}).strict();

export type NormalizedAuthoringIntent = z.infer<typeof NormalizedAuthoringIntentSchema>;

export const BoundarySignalSchema = z.object({
  kind: SpecBoundarySignalKindSchema,
  rationale: NonEmptyStringSchema,
  sourceContextReference: StableReferenceSchema,
}).strict();

export const BoundaryDependencyCandidateSchema = z.object({
  onBoundaryKey: SlugSeedSchema,
  rationale: NonEmptyStringSchema,
  sharedContractRequirementReferences: z.array(ExplicitRequirementIdSchema).min(1),
  integrationEvidenceExpectation: NonEmptyStringSchema,
}).strict();

export const AuthoringBoundaryCandidateSchema = z.object({
  boundaryKey: SlugSeedSchema,
  outcome: NonEmptyStringSchema,
  inScope: z.array(NonEmptyStringSchema).min(1),
  outOfScope: z.array(NonEmptyStringSchema).min(1),
  ownerHints: SortedUniqueStringsSchema.default([]),
  riskHints: SortedUniqueStringsSchema.default([]),
  ownsRequirementReferences: z.array(ExplicitRequirementIdSchema).min(1),
  referencesRequirementReferences: z.array(ExplicitRequirementIdSchema).default([]),
  coordination: z.enum(['independently_deliverable', 'coordinated_change']),
  releaseBoundary: NonEmptyStringSchema,
  rollbackBoundary: NonEmptyStringSchema,
  signals: z.array(BoundarySignalSchema).min(1),
  splitRationale: NonEmptyStringSchema,
  dependencies: z.array(BoundaryDependencyCandidateSchema).default([]),
}).strict();

export type AuthoringBoundaryCandidate = z.infer<typeof AuthoringBoundaryCandidateSchema>;

export const AuthoringWorkspacePolicySchema = z.object({
  version: NonEmptyStringSchema,
  contentHash: Sha256Schema,
  maximumSpecs: z.number().int().min(AUTHORING_SPEC_LIMITS.minimum).max(AUTHORING_SPEC_LIMITS.maximum).default(12),
  allowedBoundarySignals: z.array(SpecBoundarySignalKindSchema)
    .min(1)
    .default([...SPEC_BOUNDARY_SIGNAL_KINDS]),
  requiredStoryCapabilities: z.array(StoryCapabilitySchema).default([]),
  allowHumanOverrides: z.boolean().default(false),
  allowedOverrideKinds: z.array(z.enum(['decomposition', 'capabilities'])).default([]),
  overridePolicyReference: StableReferenceSchema.optional(),
  storyQuality: z.object({
    maximumRequirementsPerStory: z.number().int().positive().max(50).default(8),
    maximumAcceptanceCriteriaPerStory: z.number().int().positive().max(50).default(12),
    maximumCapabilitiesPerStory: z.number().int().positive().max(STORY_CAPABILITIES.length).default(7),
  }).strict().default({
    maximumRequirementsPerStory: 8,
    maximumAcceptanceCriteriaPerStory: 12,
    maximumCapabilitiesPerStory: 7,
  }),
}).strict();

export const AuthoringSourceContextIdentitySchema = z.object({
  contextId: StableReferenceSchema,
  version: NonEmptyStringSchema,
  contentHash: Sha256Schema,
}).strict();

export const AuthoringProvenanceInputSchema = z.object({
  invocationSurface: StableReferenceSchema,
  generationContextId: StableReferenceSchema.optional(),
  specGenerationLogIds: z.array(z.number().int().positive()).default([]),
  walEventIds: z.array(z.number().int().positive()).default([]),
  batchForgeId: StableReferenceSchema.optional(),
}).strict();

export const AuthoringOverrideSchema = z.object({
  overrideId: StableReferenceSchema,
  kinds: z.array(z.enum(['decomposition', 'capabilities'])).min(1),
  actor: z.object({
    type: z.literal('human'),
    identity: StableReferenceSchema,
  }).strict(),
  rationale: NonEmptyStringSchema,
  policyReference: StableReferenceSchema,
  recommendedSpecCount: z.number().int().min(1).max(12).optional(),
  boundaryCandidates: z.array(AuthoringBoundaryCandidateSchema).min(1).max(12).optional(),
  requiredStoryCapabilities: z.array(StoryCapabilitySchema).min(1).optional(),
}).strict();

export const AuthoringPlannerInputSchema = z.object({
  schemaVersion: z.literal(SSDLC_AUTHORING_SCHEMA_VERSION),
  workspaceId: StableReferenceSchema,
  sourceContext: AuthoringSourceContextIdentitySchema,
  intent: NormalizedAuthoringIntentSchema,
  workspacePolicy: AuthoringWorkspacePolicySchema,
  lifecycleProfile: AuthoringLifecycleProfileIdSchema,
  boundaryCandidates: z.array(AuthoringBoundaryCandidateSchema).max(12).default([]),
  overrides: z.array(AuthoringOverrideSchema).default([]),
  provenance: AuthoringProvenanceInputSchema,
  plannerVersion: NonEmptyStringSchema,
}).strict();

export type AuthoringPlannerInput = z.infer<typeof AuthoringPlannerInputSchema>;
export type AuthoringPlannerInputCandidate = z.input<typeof AuthoringPlannerInputSchema>;

export const AcceptedAuthoringOverrideSchema = z.object({
  overrideId: StableReferenceSchema,
  kinds: z.array(z.enum(['decomposition', 'capabilities'])).min(1),
  actorIdentity: StableReferenceSchema,
  rationale: NonEmptyStringSchema,
  policyReference: StableReferenceSchema,
  validatedBy: z.literal('rorca-authoring-policy'),
  grantsDownstreamApproval: z.literal(false),
}).strict();

export const AuthoringSpecBoundarySchema = z.object({
  specReference: StableReferenceSchema,
  slugSeed: SlugSeedSchema,
  outcome: NonEmptyStringSchema,
  inScope: z.array(NonEmptyStringSchema).min(1),
  outOfScope: z.array(NonEmptyStringSchema).min(1),
  ownerHints: z.array(NonEmptyStringSchema),
  riskHints: z.array(NonEmptyStringSchema),
  ownedRequirementReferences: z.array(ExplicitRequirementIdSchema).min(1),
  referencedRequirementReferences: z.array(ExplicitRequirementIdSchema),
  dependencySpecReferences: z.array(StableReferenceSchema),
  requiredStoryCapabilities: z.array(StoryCapabilitySchema).min(1),
  releaseRollbackBoundary: z.object({
    release: NonEmptyStringSchema,
    rollback: NonEmptyStringSchema,
    independentlyReleasable: z.boolean(),
    independentlyRollbackable: z.boolean(),
  }).strict(),
  boundaryDecision: z.object({
    decision: z.enum(['keep_together', 'split']),
    validatedSignals: z.array(SpecBoundarySignalKindSchema),
    rationale: NonEmptyStringSchema,
  }).strict(),
}).strict();

export const CrossSpecDependencySchema = z.object({
  dependentSpecReference: StableReferenceSchema,
  prerequisiteSpecReference: StableReferenceSchema,
  rationale: NonEmptyStringSchema,
  sharedContractRequirementReferences: z.array(ExplicitRequirementIdSchema).min(1),
  integrationEvidenceExpectation: NonEmptyStringSchema,
}).strict();

export const AuthoringPhaseContributionSchema = z.object({
  phaseId: PhaseIdSchema,
  gateIds: z.array(StableReferenceSchema).min(1),
  expectedCapabilities: z.array(StoryCapabilitySchema).min(1),
  evidenceExpectation: NonEmptyStringSchema,
}).strict();

export const AuthoringLifecycleProfileSchema = z.object({
  profileId: AuthoringLifecycleProfileIdSchema,
  requiredStoryCapabilities: z.array(StoryCapabilitySchema).min(1),
  phaseContributions: z.array(AuthoringPhaseContributionSchema).length(CANONICAL_PHASE_IDS.length),
  runtimeSemantics: z.literal('none'),
  evaluatedPhaseStatusAuthority: z.literal('none'),
}).strict();

export const StoryQualityPolicySchema = z.object({
  maximumRequirementsPerStory: z.number().int().positive(),
  maximumAcceptanceCriteriaPerStory: z.number().int().positive(),
  maximumCapabilitiesPerStory: z.number().int().positive(),
  requireOutcomeTitle: z.literal(true),
  requireObservableCriteria: z.literal(true),
  prohibitHiddenCrossSpecWork: z.literal(true),
}).strict();

export const AuthoringPlanProvenanceSchema = AuthoringProvenanceInputSchema.extend({
  plannerVersion: NonEmptyStringSchema,
  sourceContextIdentity: AuthoringSourceContextIdentitySchema,
  reusedExistingDurableSurfaces: z.literal(true),
}).strict();

export const AuthoringPlanSchema = z.object({
  schemaVersion: z.literal(SSDLC_AUTHORING_SCHEMA_VERSION),
  validationStatus: z.literal('accepted'),
  acceptedPlanHash: Sha256Schema,
  workspaceId: StableReferenceSchema,
  normalizedIntentHash: Sha256Schema,
  sourceContextIdentity: AuthoringSourceContextIdentitySchema,
  workspacePolicyVersion: NonEmptyStringSchema,
  plannerVersion: NonEmptyStringSchema,
  recommendedSpecCount: z.number().int().min(1).max(12),
  requirements: z.array(NormalizedAuthoringRequirementSchema).min(1),
  specBoundaries: z.array(AuthoringSpecBoundarySchema).min(1).max(12),
  crossSpecDependencies: z.array(CrossSpecDependencySchema),
  requiredStoryCapabilities: z.array(StoryCapabilitySchema).min(1),
  lifecycleProfile: AuthoringLifecycleProfileSchema,
  storyQualityPolicy: StoryQualityPolicySchema,
  diagnostics: z.array(AuthoringDiagnosticSchema),
  acceptedOverrides: z.array(AcceptedAuthoringOverrideSchema),
  provenance: AuthoringPlanProvenanceSchema,
}).strict();

export type AuthoringPlan = z.infer<typeof AuthoringPlanSchema>;

export const StoryEvidenceExpectationSchema = z.object({
  expectationId: StableReferenceSchema,
  kind: z.enum([
    'contract_review',
    'migration_check',
    'change_review',
    'automated_test',
    'security_assessment',
    'qa_assessment',
    'journey_observation',
    'rollout_verification',
    'recovery_exercise',
    'operational_observation',
    'learning_review',
  ]),
  description: NonEmptyStringSchema,
  observable: z.literal(true),
}).strict();

export const ProposedAcceptanceCriterionSchema = z.object({
  criterionId: StableReferenceSchema,
  text: NonEmptyStringSchema,
  observableOutcome: NonEmptyStringSchema,
  requirementReferences: z.array(RequirementReferenceSchema).min(1),
  evidenceExpectationIds: z.array(StableReferenceSchema).min(1),
}).strict();

export const ProposedStorySchema = z.object({
  id: StoryReferenceSchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema,
  acceptanceCriteria: z.array(ProposedAcceptanceCriterionSchema).min(1),
  requirementReferences: z.array(RequirementReferenceSchema).min(1),
  dependsOn: z.array(StoryReferenceSchema),
  capabilities: z.array(StoryCapabilitySchema).min(1),
  expectedContributions: z.object({
    phaseIds: z.array(PhaseIdSchema).min(1),
    gateIds: z.array(StableReferenceSchema).min(1),
  }).strict(),
  evidenceExpectations: z.array(StoryEvidenceExpectationSchema).min(1),
  negativeCoverage: z.array(NonEmptyStringSchema),
  recoveryCoverage: z.array(NonEmptyStringSchema),
  crossSpecReferences: z.array(StableReferenceSchema),
}).strict();

export type ProposedStory = z.infer<typeof ProposedStorySchema>;

export const ProposedSpecDraftSchema = z.object({
  specReference: StableReferenceSchema,
  stories: z.array(ProposedStorySchema).min(1),
}).strict();

export type ProposedSpecDraft = z.infer<typeof ProposedSpecDraftSchema>;

/**
 * Key-preserving transport contract for an untrusted authored draft candidate.
 * The request envelope must retain every model-authored field so the strict
 * ProposedSpecDraftSchema can reject it with preflight diagnostics rather than
 * letting an outer object parser strip it or short-circuit diagnostic handling.
 */
export const ProposedSpecDraftCandidateSchema = z.record(z.string(), z.unknown());

export const AuthoringPreflightInputSchema = z.object({
  schemaVersion: z.literal(SSDLC_AUTHORING_SCHEMA_VERSION),
  acceptedPlan: AuthoringPlanSchema,
  planHash: Sha256Schema,
  specs: z.array(ProposedSpecDraftSchema).min(1).max(12),
}).strict();

export type AuthoringPreflightInput = z.infer<typeof AuthoringPreflightInputSchema>;
export type AuthoringPreflightInputCandidate = Omit<
  z.input<typeof AuthoringPreflightInputSchema>,
  'specs'
> & {
  specs: Array<z.infer<typeof ProposedSpecDraftCandidateSchema>>;
};

export const RequirementCoverageRowSchema = z.object({
  requirementReference: ExplicitRequirementIdSchema,
  ownerSpecReferences: z.array(StableReferenceSchema),
  dependentSpecReferences: z.array(StableReferenceSchema),
  storyReferences: z.array(StoryReferenceSchema),
  criterionReferences: z.array(StableReferenceSchema),
  status: z.enum(['covered', 'missing', 'duplicate', 'conflict']),
}).strict();

export const CapabilityCoverageRowSchema = z.object({
  specReference: StableReferenceSchema,
  capability: StoryCapabilitySchema,
  storyReferences: z.array(StoryReferenceSchema),
  status: z.enum(['covered', 'missing']),
}).strict();

export const PhaseGateCoverageRowSchema = z.object({
  specReference: StableReferenceSchema,
  phaseId: PhaseIdSchema,
  gateId: StableReferenceSchema,
  storyReferences: z.array(StoryReferenceSchema),
  evidenceExpectationIds: z.array(StableReferenceSchema),
  status: z.enum(['covered', 'missing']),
}).strict();

export const AuthoringCoverageMatrixSchema = z.object({
  requirements: z.array(RequirementCoverageRowSchema),
  capabilities: z.array(CapabilityCoverageRowSchema),
  phaseGates: z.array(PhaseGateCoverageRowSchema),
}).strict();

export const AuthoringAmendmentCandidateSchema = z.object({
  amendmentId: StableReferenceSchema,
  targetReference: StableReferenceSchema,
  reasonCode: AuthoringDiagnosticCodeSchema,
  instruction: NonEmptyStringSchema,
  requiresCallerResubmission: z.literal(true),
}).strict();

export const AuthoringPreflightResultSchema = z.object({
  schemaVersion: z.literal(SSDLC_AUTHORING_SCHEMA_VERSION),
  accepted: z.boolean(),
  planHash: Sha256Schema,
  acceptedPreflightHash: Sha256Schema.nullable(),
  diagnostics: z.array(AuthoringDiagnosticSchema),
  amendments: z.array(AuthoringAmendmentCandidateSchema),
  coverageMatrix: AuthoringCoverageMatrixSchema,
  draftMutationCount: z.literal(0),
  authoritativePersistenceAllowed: z.boolean(),
}).strict();

export type AuthoringPreflightResult = z.infer<typeof AuthoringPreflightResultSchema>;

/** Structural projections only; Zod refinements and planner policy remain authoritative. */
export const AUTHORING_PLAN_JSON_SCHEMA = z.toJSONSchema(AuthoringPlanSchema, { unrepresentable: 'any' });
export const AUTHORING_PREFLIGHT_JSON_SCHEMA = z.toJSONSchema(AuthoringPreflightResultSchema, { unrepresentable: 'any' });
