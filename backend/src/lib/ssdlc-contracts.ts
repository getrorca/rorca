/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Canonical, side-effect-free SSDLC wire contracts.
 *
 * `schemaVersion` is only a wire-compatibility discriminant. Version 1 is the
 * complete production contract, not an MVP or permission to defer journeys.
 * Plans contain requirements for evidence; immutable evidence and evaluated
 * status are deliberately separate DTOs.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { GitShaSchema } from './git-sha';

export const SSDLC_SCHEMA_VERSION = 1 as const;
export const schemaVersion = SSDLC_SCHEMA_VERSION;

export const CANONICAL_PHASES = [
  { id: 'intake', displayName: 'Intake' },
  { id: 'requirements', displayName: 'Requirements' },
  { id: 'architecture', displayName: 'Architecture' },
  { id: 'implementation', displayName: 'Implementation' },
  { id: 'validation', displayName: 'Validation' },
  { id: 'security', displayName: 'Security' },
  { id: 'staging', displayName: 'Staging' },
  { id: 'qa', displayName: 'QA' },
  { id: 'merge', displayName: 'Merge' },
  { id: 'production', displayName: 'Production' },
  { id: 'learn', displayName: 'Learn' },
] as const;

export const CANONICAL_PHASE_IDS = CANONICAL_PHASES.map((phase) => phase.id) as [
  'intake',
  'requirements',
  'architecture',
  'implementation',
  'validation',
  'security',
  'staging',
  'qa',
  'merge',
  'production',
  'learn',
];

export const PHASE_DISPOSITIONS = ['required', 'deferred', 'not_applicable'] as const;
export const EVALUATED_STATUSES = [
  'not_started',
  'in_progress',
  'blocked',
  'awaiting_approval',
  'passed',
  'deferred',
  'not_applicable',
  'stale',
] as const;

/**
 * Evaluators apply the first matching status in this strongest-first order.
 * `stale` wins when an input changed; then hard blockers; then an approval-only
 * wait; partial work; completed gates; and governed completion exclusions.
 * `not_started` remains a wire status for historical compatibility.
 */
export const STATUS_PRECEDENCE = [
  'stale',
  'blocked',
  'awaiting_approval',
  'in_progress',
  'passed',
  'deferred',
  'not_applicable',
  'not_started',
] as const satisfies readonly (typeof EVALUATED_STATUSES)[number][];

export const RELEASE_SUBJECT_TYPES = [
  'spec_hash',
  'commit_sha',
  'artifact_digest',
  'deployment_id',
] as const;

export const EXECUTION_MODES = ['implementation', 'qa', 'journey'] as const;
export const COMPILER_PROFILES = [
  'docs-only',
  'code-change',
  'data-storage',
  'security-sensitive',
  'integration',
  'release-operations',
] as const;
export const COMPILER_ANNOTATION_SOURCES = ['caller', 'pi', 'hermes'] as const;

export const PhaseIdSchema = z.enum(CANONICAL_PHASE_IDS).describe('One of the 11 fixed SSDLC phase IDs.');
export const PhaseDispositionValueSchema = z.enum(PHASE_DISPOSITIONS);
export const EvaluatedStatusSchema = z.enum(EVALUATED_STATUSES);
export const ReleaseSubjectTypeSchema = z.enum(RELEASE_SUBJECT_TYPES);
export const ExecutionModeSchema = z.enum(EXECUTION_MODES);
export const CompilerProfileSchema = z.enum(COMPILER_PROFILES);
export const CompilerAnnotationSourceSchema = z.enum(COMPILER_ANNOTATION_SOURCES);

const NonEmptyStringSchema = z.string().trim().min(1, 'Value must be non-empty');
const StableIdSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9._:/-]{1,127}$/, 'Reference must be a stable 2-128 character identifier');
const Sha256Schema = z.string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Value must be a lowercase sha256:<64 hex> digest');
const IsoTimestampSchema = z.string().datetime({ offset: true });

export const StoryReferenceSchema = z.string()
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/, 'Story reference must be a stable uppercase ID such as LFC-001');
export const ArchitectureDecisionReferenceSchema = z.string()
  .regex(/^ADR-[A-Z0-9][A-Z0-9._-]*$/, 'Architecture decision reference must start with ADR-');
export const ExplicitRequirementIdSchema = z.string()
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/, 'Explicit requirement ID must be stable and uppercase, such as REQ-002');
export const DerivedRequirementReferenceSchema = z.string()
  .regex(
    /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+:ac:sha256:[a-f0-9]{64}$/,
    'Derived requirement reference must contain story ID and normalized acceptance-criterion SHA-256',
  );
export const RequirementReferenceSchema = z.union([
  DerivedRequirementReferenceSchema,
  ExplicitRequirementIdSchema,
]);
export const EvidenceReferenceSchema = z.string()
  .regex(/^EVD-sha256:[a-f0-9]{64}$/, 'Evidence reference must be EVD-sha256:<64 hex>');
export const DecisionReferenceSchema = z.string()
  .regex(/^DEC-sha256:[a-f0-9]{64}$/, 'Decision reference must be DEC-sha256:<64 hex>');
export const CompletionReferenceSchema = z.string()
  .regex(/^CMP-sha256:[a-f0-9]{64}$/, 'Completion reference must be CMP-sha256:<64 hex>');

export type PhaseId = z.infer<typeof PhaseIdSchema>;
export type PhaseDispositionValue = z.infer<typeof PhaseDispositionValueSchema>;
export type EvaluatedStatus = z.infer<typeof EvaluatedStatusSchema>;
export type ReleaseSubjectType = z.infer<typeof ReleaseSubjectTypeSchema>;
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export type CompilerProfile = z.infer<typeof CompilerProfileSchema>;
export type RequirementReference = z.infer<typeof RequirementReferenceSchema>;

export function normalizeAcceptanceCriterionText(criterion: string): string {
  return criterion.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

export function fingerprintAcceptanceCriterion(criterion: string): string {
  return crypto.createHash('sha256').update(normalizeAcceptanceCriterionText(criterion), 'utf8').digest('hex');
}

export function deriveRequirementReference(storyId: string, criterion: string): RequirementReference {
  const parsedStoryId = StoryReferenceSchema.parse(storyId);
  const normalized = normalizeAcceptanceCriterionText(criterion);
  if (!normalized) throw new Error('Acceptance criterion must be non-empty after normalization');
  return `${parsedStoryId}:ac:sha256:${fingerprintAcceptanceCriterion(criterion)}` as RequirementReference;
}

export const AcceptanceCriterionSchema = z.union([
  NonEmptyStringSchema,
  z.object({
    text: NonEmptyStringSchema,
    requirementId: ExplicitRequirementIdSchema.optional(),
  }).strict(),
]);

const SortedStringArraySchema = z.array(NonEmptyStringSchema)
  .transform((items) => [...items].sort((left, right) => left.localeCompare(right)))
  .default([]);

export const CompilerStorySchema = z.object({
  id: StoryReferenceSchema,
  title: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1, 'A story needs at least one acceptance criterion'),
  tags: SortedStringArraySchema,
  fileHints: SortedStringArraySchema,
}).passthrough();

export const CompilerArchitectureDecisionSchema = z.object({
  id: ArchitectureDecisionReferenceSchema,
  title: NonEmptyStringSchema,
}).passthrough();

export const CompilerRequirementSchema = z.object({
  id: ExplicitRequirementIdSchema,
  text: NonEmptyStringSchema,
  storyReferences: z.array(StoryReferenceSchema).default([]),
  architectureDecisionReferences: z.array(ArchitectureDecisionReferenceSchema).default([]),
}).strict();

export const CanonicalSpecJsonSchema = z.object({
  userStories: z.array(CompilerStorySchema).min(1, 'Canonical spec JSON needs at least one userStory'),
  tags: SortedStringArraySchema,
  fileHints: SortedStringArraySchema,
  contextSummary: z.object({ predictedFiles: SortedStringArraySchema }).passthrough().optional(),
  architectureDecisions: z.array(CompilerArchitectureDecisionSchema).default([]),
  requirements: z.array(CompilerRequirementSchema).default([]),
  executionMode: ExecutionModeSchema.optional(),
}).passthrough();

export const CanonicalSpecSourceSchema = z.object({
  specId: StableIdSchema,
  version: NonEmptyStringSchema.describe('Canonical persisted spec version, revision, or immutable version ID.'),
  contentHash: Sha256Schema,
  json: CanonicalSpecJsonSchema.describe('The canonical persisted Rorca spec JSON, not a model-owned shadow copy.'),
}).strict();

const WorkspaceTagSchema = z.object({
  workspaceId: StableIdSchema,
  tag: NonEmptyStringSchema,
}).strict();

const RiskAssignmentSchema = z.object({
  workspaceId: StableIdSchema,
  assignmentId: StableIdSchema,
  scopeReference: StableIdSchema,
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: NonEmptyStringSchema,
}).strict();

const OwnerAssignmentSchema = z.object({
  workspaceId: StableIdSchema,
  assignmentId: StableIdSchema,
  scopeReference: StableIdSchema,
  ownerReference: StableIdSchema,
}).strict();

const PolicyAnnotationSchema = z.object({
  workspaceId: StableIdSchema,
  annotationId: StableIdSchema,
  scopeReference: StableIdSchema,
  policyReference: StableIdSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
}).strict();

function sortedDefaultArray<T extends { [key: string]: unknown }>(
  schema: z.ZodType<T>,
  key: keyof T,
): z.ZodDefault<z.ZodPipe<z.ZodArray<z.ZodType<T>>, z.ZodTransform<T[], T[]>>> {
  return z.array(schema)
    .transform((items) => [...items].sort((a, b) => String(a[key]).localeCompare(String(b[key]))))
    .default([]);
}

/** Optional compiler inputs always normalize to these empty, sorted arrays. */
export const COMPILER_OPTIONAL_SOURCE_DEFAULTS = Object.freeze({
  workspaceTags: [] as const,
  riskAssignments: [] as const,
  ownerAssignments: [] as const,
  policyAnnotations: [] as const,
  compilerAnnotations: [] as const,
});

/** Annotation payloads remain unknown here so each proposal can be accepted or rejected independently. */
export const CompilerAnnotationEnvelopeSchema = z.object({
  annotationId: StableIdSchema,
  source: CompilerAnnotationSourceSchema,
  payload: z.unknown(),
}).strict();

export const LifecycleCompilerInputSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  workspaceId: StableIdSchema,
  canonicalSpec: CanonicalSpecSourceSchema,
  workspaceTags: sortedDefaultArray(WorkspaceTagSchema, 'tag'),
  riskAssignments: sortedDefaultArray(RiskAssignmentSchema, 'assignmentId'),
  ownerAssignments: sortedDefaultArray(OwnerAssignmentSchema, 'assignmentId'),
  policyAnnotations: sortedDefaultArray(PolicyAnnotationSchema, 'annotationId'),
  compilerAnnotations: z.array(CompilerAnnotationEnvelopeSchema).default([]),
  compilerVersion: NonEmptyStringSchema,
  policyVersion: NonEmptyStringSchema,
  compiledAt: IsoTimestampSchema.describe('Caller-owned timestamp copied by the pure compiler.'),
}).strict().superRefine((input, context) => {
  const storyIds = new Set<string>();
  const explicitRequirementIds = new Set<string>();

  input.canonicalSpec.json.userStories.forEach((story, storyIndex) => {
    if (storyIds.has(story.id)) {
      context.addIssue({
        code: 'custom',
        path: ['canonicalSpec', 'json', 'userStories', storyIndex, 'id'],
        message: `Duplicate story reference ${story.id}`,
      });
    }
    storyIds.add(story.id);

    const normalizedCriteria = new Set<string>();
    story.acceptanceCriteria.forEach((criterion, criterionIndex) => {
      const text = typeof criterion === 'string' ? criterion : criterion.text;
      const normalized = normalizeAcceptanceCriterionText(text);
      if (normalizedCriteria.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['canonicalSpec', 'json', 'userStories', storyIndex, 'acceptanceCriteria', criterionIndex],
          message: `Duplicate acceptance criterion after normalization in story ${story.id}`,
        });
      }
      normalizedCriteria.add(normalized);

      if (typeof criterion !== 'string' && criterion.requirementId) {
        if (explicitRequirementIds.has(criterion.requirementId)) {
          context.addIssue({
            code: 'custom',
            path: ['canonicalSpec', 'json', 'userStories', storyIndex, 'acceptanceCriteria', criterionIndex, 'requirementId'],
            message: `Duplicate explicit requirement ID ${criterion.requirementId}`,
          });
        }
        explicitRequirementIds.add(criterion.requirementId);
      }
    });
  });

  const architectureDecisionIds = new Set<string>();
  input.canonicalSpec.json.architectureDecisions.forEach((decision, decisionIndex) => {
    if (architectureDecisionIds.has(decision.id)) {
      context.addIssue({
        code: 'custom',
        path: ['canonicalSpec', 'json', 'architectureDecisions', decisionIndex, 'id'],
        message: `Duplicate architecture decision reference ${decision.id}`,
      });
    }
    architectureDecisionIds.add(decision.id);
  });

  input.canonicalSpec.json.requirements.forEach((requirement, requirementIndex) => {
    if (explicitRequirementIds.has(requirement.id)) {
      context.addIssue({
        code: 'custom',
        path: ['canonicalSpec', 'json', 'requirements', requirementIndex, 'id'],
        message: `Duplicate explicit requirement ID ${requirement.id}`,
      });
    }
    explicitRequirementIds.add(requirement.id);
  });

  const workspaceSources: Array<[string, Array<{ workspaceId: string }>]> = [
    ['workspaceTags', input.workspaceTags],
    ['riskAssignments', input.riskAssignments],
    ['ownerAssignments', input.ownerAssignments],
    ['policyAnnotations', input.policyAnnotations],
  ];
  for (const [sourceName, records] of workspaceSources) {
    records.forEach((record, index) => {
      if (record.workspaceId !== input.workspaceId) {
        context.addIssue({
          code: 'custom',
          path: [sourceName, index, 'workspaceId'],
          message: `${sourceName} must be scoped to compiler workspace ${input.workspaceId}`,
        });
      }
    });
  }
});

export type LifecycleCompilerInput = z.infer<typeof LifecycleCompilerInputSchema>;

export interface CompiledAcceptanceCriterionReference {
  storyReference: string;
  criterionText: string;
  requirementReference: RequirementReference;
}

/**
 * Produces order-independent references and validates the same duplicate rules
 * as LifecycleCompilerInputSchema. Explicit IDs remain authoritative only after
 * schema validation; otherwise the story ID + normalized text hash is used.
 */
export function deriveAcceptanceCriterionReferences(
  input: z.input<typeof LifecycleCompilerInputSchema>,
): CompiledAcceptanceCriterionReference[] {
  const parsed = LifecycleCompilerInputSchema.parse(input);
  return parsed.canonicalSpec.json.userStories.flatMap((story) => story.acceptanceCriteria.map((criterion) => {
    const criterionText = typeof criterion === 'string' ? criterion : criterion.text;
    return {
      storyReference: story.id,
      criterionText,
      requirementReference: typeof criterion === 'string' || !criterion.requirementId
        ? deriveRequirementReference(story.id, criterionText)
        : criterion.requirementId,
    };
  }));
}

export const PhaseDispositionSchema = z.object({
  disposition: PhaseDispositionValueSchema,
  rationale: NonEmptyStringSchema.describe('Why this phase is required, deferred, or not applicable.'),
  approvalReference: DecisionReferenceSchema.optional(),
  expiryPolicy: NonEmptyStringSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.disposition === 'deferred') {
    if (!value.approvalReference) {
      context.addIssue({
        code: 'custom',
        path: ['approvalReference'],
        message: 'Deferred disposition requires an approval reference',
      });
    }
    if (!value.expiryPolicy) {
      context.addIssue({
        code: 'custom',
        path: ['expiryPolicy'],
        message: 'Deferred disposition requires a non-empty expiry policy',
      });
    }
  } else if (value.disposition === 'required') {
    if (value.approvalReference !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['approvalReference'],
        message: 'approvalReference is not valid for a required disposition',
      });
    }
    if (value.expiryPolicy !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['expiryPolicy'],
        message: 'expiryPolicy is not valid for a required disposition',
      });
    }
  } else if (value.expiryPolicy !== undefined && !value.approvalReference) {
    context.addIssue({
      code: 'custom',
      path: ['expiryPolicy'],
      message: 'A not-applicable expiry policy requires an approval reference',
    });
  }
});

export type PhaseDisposition = z.infer<typeof PhaseDispositionSchema>;

export const ReleaseSubjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('spec_hash'), value: Sha256Schema }).strict(),
  z.object({ type: z.literal('commit_sha'), value: GitShaSchema }).strict(),
  z.object({ type: z.literal('artifact_digest'), value: Sha256Schema }).strict(),
  z.object({ type: z.literal('deployment_id'), value: StableIdSchema }).strict(),
]);
export type ReleaseSubject = z.infer<typeof ReleaseSubjectSchema>;

export const EvidenceClassificationSchema = z.enum([
  'code_change',
  'documentation',
  'test_result',
  'security_finding',
  'data_storage',
  'release_operation',
  'approval',
  'runtime_observation',
]);
export const EvidenceTrustLevelSchema = z.enum(['untrusted', 'local', 'verified', 'privileged']);
export const EvidenceSourceSchema = z.enum([
  'rorca',
  'execution_engine',
  'git',
  'ci',
  'github',
  'linear',
  'slack',
  'gitreins',
  'deployment',
  'operator',
  'external',
]);

export const EvidenceProvenanceSchema = z.object({
  capturedBy: NonEmptyStringSchema,
  adapterVersion: NonEmptyStringSchema,
  originalReference: NonEmptyStringSchema.optional(),
  contentHash: Sha256Schema,
  redactionPolicyVersion: NonEmptyStringSchema,
  immutable: z.literal(true),
}).strict();

export const RedactedPayloadSchema = z.object({
  redacted: z.literal(true),
  content: z.unknown(),
  contentHash: Sha256Schema,
  redactionPolicyVersion: NonEmptyStringSchema,
}).strict();

const ObservationEnvelopeSchema = z.object({
  workspaceId: StableIdSchema,
  specId: StableIdSchema,
  phaseId: PhaseIdSchema,
  gateId: StableIdSchema,
  source: EvidenceSourceSchema,
  stableSourceId: NonEmptyStringSchema,
  observedAt: IsoTimestampSchema,
  subject: ReleaseSubjectSchema,
  classification: EvidenceClassificationSchema,
  redactedPayload: RedactedPayloadSchema,
  trustLevel: EvidenceTrustLevelSchema,
  provenance: EvidenceProvenanceSchema,
});

function hashStableValue(value: unknown): string {
  return crypto.createHash('sha256').update(normalizeSsdlcContractJson(value), 'utf8').digest('hex');
}

export function deriveEvidenceReference(input: {
  workspaceId: string;
  source: z.infer<typeof EvidenceSourceSchema>;
  stableSourceId: string;
  subject: ReleaseSubject;
}): z.infer<typeof EvidenceReferenceSchema> {
  const identity = {
    workspaceId: input.workspaceId,
    source: input.source,
    stableSourceId: input.stableSourceId,
    subject: input.subject,
  };
  return `EVD-sha256:${hashStableValue(identity)}`;
}

export const EvidenceRecordSchema = ObservationEnvelopeSchema.extend({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  evidenceReference: EvidenceReferenceSchema,
  recordedAt: IsoTimestampSchema,
}).strict().superRefine((evidence, context) => {
  const expected = deriveEvidenceReference(evidence);
  if (evidence.evidenceReference !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceReference'],
      message: `Evidence reference must be derived from workspace, source, stable source ID, and subject (${expected})`,
    });
  }
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const AgentProcessOutcomeSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'timed_out', 'cancelled']),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
}).strict().superRefine((outcome, context) => {
  if (outcome.outcome === 'succeeded' && outcome.exitCode !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['exitCode'],
      message: 'A succeeded agent process outcome requires exitCode 0',
    });
  }
});

export const StoryCloseoutDecisionSchema = z.object({
  outcome: z.enum(['accepted', 'rejected']),
  decisionReference: DecisionReferenceSchema,
  decidedAt: IsoTimestampSchema,
  decidedBy: z.literal('execution_engine'),
  rationale: NonEmptyStringSchema,
}).strict();

export const StoryCompletionPacketSchema = ObservationEnvelopeSchema.extend({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  completionReference: CompletionReferenceSchema,
  storyReference: StoryReferenceSchema,
  executionMode: ExecutionModeSchema,
  processOutcome: AgentProcessOutcomeSchema,
  closeoutDecision: StoryCloseoutDecisionSchema,
  evidenceReferences: z.array(EvidenceReferenceSchema).min(1, 'Accepted story closeout requires immutable evidence references'),
  completedAt: IsoTimestampSchema,
}).strict().superRefine((packet, context) => {
  if (packet.closeoutDecision.outcome === 'accepted' && packet.processOutcome.outcome !== 'succeeded') {
    context.addIssue({
      code: 'custom',
      path: ['closeoutDecision', 'outcome'],
      message: 'Story closeout cannot be accepted when the agent process did not succeed',
    });
  }
});
export type StoryCompletionPacket = z.infer<typeof StoryCompletionPacketSchema>;

export const GovernedDecisionSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  decisionReference: DecisionReferenceSchema,
  workspaceId: StableIdSchema,
  specId: StableIdSchema,
  phaseId: PhaseIdSchema,
  gateId: StableIdSchema,
  subject: ReleaseSubjectSchema,
  decisionType: z.enum(['approve', 'reject', 'defer', 'not_applicable', 'authorize_retry']),
  outcome: z.enum(['approved', 'rejected']),
  rationale: NonEmptyStringSchema,
  policyReference: StableIdSchema,
  evidenceReferences: z.array(EvidenceReferenceSchema),
  decidedBy: StableIdSchema,
  decidedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema.optional(),
  provenance: EvidenceProvenanceSchema,
}).strict().superRefine((decision, context) => {
  if (decision.decisionType === 'defer' && decision.outcome === 'approved' && !decision.expiresAt) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Approved deferral decision requires an expiry timestamp',
    });
  }
});
export type GovernedDecision = z.infer<typeof GovernedDecisionSchema>;

export const SubjectCoherenceRuleSchema = z.enum(['same_subject', 'derived_from_subject', 'not_applicable']);
export const DownstreamSubjectCoherenceSchema = z.object({
  qa: SubjectCoherenceRuleSchema,
  merge: SubjectCoherenceRuleSchema,
  production: SubjectCoherenceRuleSchema,
}).strict().describe('Required QA, Merge, and Production identity relationship for this gate subject.');

export const EvidenceRequirementSchema = z.object({
  evidenceRequirementId: StableIdSchema,
  gateId: StableIdSchema,
  description: NonEmptyStringSchema,
  classification: EvidenceClassificationSchema,
  minimumTrustLevel: EvidenceTrustLevelSchema,
}).strict();

export const GateEvidenceKindSchema = z.enum([
  'spec_review',
  'architecture_review',
  'change_review',
  'automated_validation',
  'security_assessment',
  'deployment_verification',
  'qa_assessment',
  'merge_authorization',
  'production_verification',
  'learning_review',
]);
export const SubjectRevisionRequirementSchema = z.enum([
  'current_spec_revision',
  'current_commit',
  'current_artifact',
  'current_deployment',
]);
export const GateApprovalRequirementSchema = z.enum(['none', 'policy', 'human']);
export const GateExpirationPolicySchema = z.enum([
  'when_spec_changes',
  'when_subject_changes',
  'after_30_days',
  'never',
]);
export const GateBlockingSeveritySchema = z.enum(['advisory', 'blocking', 'release_blocking']);

export const GateDefinitionSchema = z.object({
  gateId: StableIdSchema,
  phaseId: PhaseIdSchema,
  title: NonEmptyStringSchema,
  evidenceKind: GateEvidenceKindSchema,
  subjectRevisionRequirement: SubjectRevisionRequirementSchema,
  approvalRequirement: GateApprovalRequirementSchema,
  expirationPolicy: GateExpirationPolicySchema,
  blockingSeverity: GateBlockingSeveritySchema,
  evidenceRequirementIds: z.array(StableIdSchema).min(1, 'A gate needs at least one evidence requirement'),
  acceptedSubjectTypes: z.array(ReleaseSubjectTypeSchema)
    .min(1, 'A gate must declare accepted release-subject types')
    .superRefine((types, context) => {
      if (new Set(types).size !== types.length) {
        context.addIssue({ code: 'custom', message: 'Gate acceptedSubjectTypes must not contain duplicates' });
      }
    }),
  downstreamSubjectCoherence: DownstreamSubjectCoherenceSchema,
}).strict();

export const RequirementTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('story'), reference: StoryReferenceSchema }).strict(),
  z.object({ type: z.literal('architecture_decision'), reference: ArchitectureDecisionReferenceSchema }).strict(),
]);

export const RequirementMappingSchema = z.object({
  requirementReference: RequirementReferenceSchema,
  targetReferences: z.array(RequirementTargetSchema)
    .min(1, 'Requirement must map to at least one story or architecture decision'),
  gateIds: z.array(StableIdSchema).min(1, 'Requirement must map to at least one gate'),
  evidenceRequirementIds: z.array(StableIdSchema)
    .min(1, 'Requirement must map to declarative evidence requirements, never mutable evidence records'),
}).strict();

export const CompletenessContractSchema = z.object({
  placeholderUiForbidden: z.literal(true),
  todoBackedPrimaryFlowsForbidden: z.literal(true),
  fakeSuccessStatesForbidden: z.literal(true),
  unspecifiedLaterReleaseDeferralForbidden: z.literal(true),
  requiredJourneyClasses: z.tuple([
    z.literal('normal'),
    z.literal('negative'),
    z.literal('recovery'),
    z.literal('responsive'),
    z.literal('accessibility'),
    z.literal('light_theme'),
  ]),
}).strict();

export const COMPLETE_PRODUCT_CONTRACT = Object.freeze({
  placeholderUiForbidden: true,
  todoBackedPrimaryFlowsForbidden: true,
  fakeSuccessStatesForbidden: true,
  unspecifiedLaterReleaseDeferralForbidden: true,
  requiredJourneyClasses: [
    'normal',
    'negative',
    'recovery',
    'responsive',
    'accessibility',
    'light_theme',
  ],
} as const);

export const PhasePlanSchema = z.object({
  phaseId: PhaseIdSchema,
  disposition: PhaseDispositionSchema,
  gateIds: z.array(StableIdSchema),
}).strict();

export const CanonicalPhaseOrderSchema = z.tuple([
  z.literal('intake'),
  z.literal('requirements'),
  z.literal('architecture'),
  z.literal('implementation'),
  z.literal('validation'),
  z.literal('security'),
  z.literal('staging'),
  z.literal('qa'),
  z.literal('merge'),
  z.literal('production'),
  z.literal('learn'),
]);

function addDuplicateIdIssues(
  values: string[],
  path: string,
  context: z.RefinementCtx,
): Set<string> {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [path, index],
        message: `Duplicate ${path} reference ${value}`,
      });
    }
    seen.add(value);
  });
  return seen;
}

export const LifecyclePlanSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  planId: StableIdSchema,
  planVersion: z.number().int().positive(),
  inputHash: Sha256Schema,
  workspaceId: StableIdSchema,
  specId: StableIdSchema,
  compilerVersion: NonEmptyStringSchema,
  policyVersion: NonEmptyStringSchema,
  compiledAt: IsoTimestampSchema,
  phaseOrder: CanonicalPhaseOrderSchema,
  phases: z.array(PhasePlanSchema).length(CANONICAL_PHASE_IDS.length),
  requirementReferences: z.array(RequirementReferenceSchema).min(1),
  storyReferences: z.array(StoryReferenceSchema).min(1),
  architectureDecisionReferences: z.array(ArchitectureDecisionReferenceSchema),
  requirementMappings: z.array(RequirementMappingSchema).min(1),
  gates: z.array(GateDefinitionSchema).min(1),
  evidenceRequirements: z.array(EvidenceRequirementSchema).min(1),
  completeness: CompletenessContractSchema,
}).strict().superRefine((plan, context) => {
  const phaseIds = plan.phases.map((phase) => phase.phaseId);
  addDuplicateIdIssues(phaseIds, 'phases', context);
  phaseIds.forEach((phaseId, index) => {
    const expected = CANONICAL_PHASE_IDS[index];
    if (phaseId !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['phases', index, 'phaseId'],
        message: `Phase at display position ${index} must be ${expected}, received ${phaseId}`,
      });
    }
  });

  const requirementReferences = addDuplicateIdIssues(plan.requirementReferences, 'requirementReferences', context);
  const storyReferences = addDuplicateIdIssues(plan.storyReferences, 'storyReferences', context);
  const architectureReferences = addDuplicateIdIssues(
    plan.architectureDecisionReferences,
    'architectureDecisionReferences',
    context,
  );
  const gateIds = addDuplicateIdIssues(plan.gates.map((gate) => gate.gateId), 'gates', context);
  const evidenceRequirementIds = addDuplicateIdIssues(
    plan.evidenceRequirements.map((requirement) => requirement.evidenceRequirementId),
    'evidenceRequirements',
    context,
  );
  const mappedRequirements = addDuplicateIdIssues(
    plan.requirementMappings.map((mapping) => mapping.requirementReference),
    'requirementMappings',
    context,
  );

  plan.requirementReferences.forEach((reference, index) => {
    if (!mappedRequirements.has(reference)) {
      context.addIssue({
        code: 'custom',
        path: ['requirementReferences', index],
        message: `Requirement ${reference} has no traceability mapping`,
      });
    }
  });

  plan.requirementMappings.forEach((mapping, mappingIndex) => {
    if (!requirementReferences.has(mapping.requirementReference)) {
      context.addIssue({
        code: 'custom',
        path: ['requirementMappings', mappingIndex, 'requirementReference'],
        message: `Unknown requirement reference ${mapping.requirementReference}`,
      });
    }
    mapping.targetReferences.forEach((target, targetIndex) => {
      const exists = target.type === 'story'
        ? storyReferences.has(target.reference)
        : architectureReferences.has(target.reference);
      if (!exists) {
        context.addIssue({
          code: 'custom',
          path: ['requirementMappings', mappingIndex, 'targetReferences', targetIndex, 'reference'],
          message: `Unknown ${target.type} reference ${target.reference}`,
        });
      }
    });
    mapping.gateIds.forEach((gateId, gateIndex) => {
      if (!gateIds.has(gateId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirementMappings', mappingIndex, 'gateIds', gateIndex],
          message: `Unknown gate reference ${gateId}`,
        });
      }
    });
    mapping.evidenceRequirementIds.forEach((requirementId, requirementIndex) => {
      if (!evidenceRequirementIds.has(requirementId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirementMappings', mappingIndex, 'evidenceRequirementIds', requirementIndex],
          message: `Unknown evidence requirement reference ${requirementId}`,
        });
      }
    });
  });

  plan.gates.forEach((gate, gateIndex) => {
    gate.evidenceRequirementIds.forEach((requirementId, requirementIndex) => {
      const requirement = plan.evidenceRequirements.find(
        (candidate) => candidate.evidenceRequirementId === requirementId,
      );
      if (!requirement) {
        context.addIssue({
          code: 'custom',
          path: ['gates', gateIndex, 'evidenceRequirementIds', requirementIndex],
          message: `Unknown evidence requirement reference ${requirementId}`,
        });
      } else if (requirement.gateId !== gate.gateId) {
        context.addIssue({
          code: 'custom',
          path: ['gates', gateIndex, 'evidenceRequirementIds', requirementIndex],
          message: `Evidence requirement ${requirementId} belongs to gate ${requirement.gateId}, not ${gate.gateId}`,
        });
      }
    });
  });

  plan.evidenceRequirements.forEach((requirement, requirementIndex) => {
    const gate = plan.gates.find((candidate) => candidate.gateId === requirement.gateId);
    if (!gate) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceRequirements', requirementIndex, 'gateId'],
        message: `Unknown gate reference ${requirement.gateId}`,
      });
    } else if (!gate.evidenceRequirementIds.includes(requirement.evidenceRequirementId)) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceRequirements', requirementIndex, 'gateId'],
        message: `Gate ${requirement.gateId} does not declare evidence requirement ${requirement.evidenceRequirementId}`,
      });
    }
  });

  plan.requirementMappings.forEach((mapping, mappingIndex) => {
    mapping.evidenceRequirementIds.forEach((requirementId, requirementIndex) => {
      const requirement = plan.evidenceRequirements.find(
        (candidate) => candidate.evidenceRequirementId === requirementId,
      );
      if (requirement && !mapping.gateIds.includes(requirement.gateId)) {
        context.addIssue({
          code: 'custom',
          path: ['requirementMappings', mappingIndex, 'evidenceRequirementIds', requirementIndex],
          message: `Evidence requirement ${requirementId} belongs to unmapped gate ${requirement.gateId}`,
        });
      }
    });
  });

  plan.phases.forEach((phase, phaseIndex) => {
    phase.gateIds.forEach((gateId, gateIndex) => {
      const gate = plan.gates.find((candidate) => candidate.gateId === gateId);
      if (!gate) {
        context.addIssue({
          code: 'custom',
          path: ['phases', phaseIndex, 'gateIds', gateIndex],
          message: `Unknown gate reference ${gateId}`,
        });
      } else if (gate.phaseId !== phase.phaseId) {
        context.addIssue({
          code: 'custom',
          path: ['phases', phaseIndex, 'gateIds', gateIndex],
          message: `Gate ${gateId} belongs to ${gate.phaseId}, not ${phase.phaseId}`,
        });
      }
    });
  });

  plan.gates.forEach((gate, gateIndex) => {
    const ownerPhase = plan.phases.find((phase) => phase.phaseId === gate.phaseId);
    if (ownerPhase && !ownerPhase.gateIds.includes(gate.gateId)) {
      context.addIssue({
        code: 'custom',
        path: ['gates', gateIndex, 'phaseId'],
        message: `Phase ${gate.phaseId} does not declare gate ${gate.gateId}`,
      });
    }
  });
});

/** The single version-1 production plan wire contract. */
export const SsdlcWireContractSchema = LifecyclePlanSchema;
export const SSDLCWireContractSchema = SsdlcWireContractSchema;
export type LifecyclePlan = z.infer<typeof LifecyclePlanSchema>;
export type SsdlcWireContract = z.infer<typeof SsdlcWireContractSchema>;

export const EvaluationSnapshotInputSchema = z.object({
  planId: StableIdSchema,
  planVersion: z.number().int().positive(),
  inputHash: Sha256Schema,
  evidenceHighWaterMark: NonEmptyStringSchema,
  decisionHighWaterMark: NonEmptyStringSchema,
  activeReleaseSubject: ReleaseSubjectSchema,
  policyVersion: NonEmptyStringSchema,
  compilerVersion: NonEmptyStringSchema,
  evaluatedAt: IsoTimestampSchema,
}).strict();

export type EvaluationSnapshotInput = z.infer<typeof EvaluationSnapshotInputSchema>;

function evaluationSnapshotHash(input: EvaluationSnapshotInput): string {
  return `sha256:${hashStableValue(input)}`;
}

export const EvaluationSnapshotIdentitySchema = EvaluationSnapshotInputSchema.extend({
  snapshotId: Sha256Schema,
}).strict().superRefine((snapshot, context) => {
  const { snapshotId: _snapshotId, ...identityInput } = snapshot;
  const expected = evaluationSnapshotHash(identityInput);
  if (snapshot.snapshotId !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['snapshotId'],
      message: `Evaluation snapshot ID does not match its versioned inputs (${expected})`,
    });
  }
});

export type EvaluationSnapshotIdentity = z.infer<typeof EvaluationSnapshotIdentitySchema>;

export function deriveEvaluationSnapshotIdentity(input: EvaluationSnapshotInput): EvaluationSnapshotIdentity {
  const parsed = EvaluationSnapshotInputSchema.parse(input);
  return EvaluationSnapshotIdentitySchema.parse({
    ...parsed,
    snapshotId: evaluationSnapshotHash(parsed),
  });
}

export const GateEvaluationSchema = z.object({
  gateId: StableIdSchema,
  status: EvaluatedStatusSchema,
  subject: ReleaseSubjectSchema,
  evidenceReferences: z.array(EvidenceReferenceSchema),
  decisionReferences: z.array(DecisionReferenceSchema),
  rationale: NonEmptyStringSchema,
}).strict();

export const PhaseEvaluationSchema = z.object({
  phaseId: PhaseIdSchema,
  disposition: PhaseDispositionSchema,
  evaluatedStatus: EvaluatedStatusSchema,
  rationale: NonEmptyStringSchema,
  gates: z.array(GateEvaluationSchema),
}).strict().superRefine((phase, context) => {
  const status = phase.evaluatedStatus;
  const disposition = phase.disposition.disposition;
  const valid = disposition === 'required'
    ? !['deferred', 'not_applicable'].includes(status)
    : disposition === 'deferred'
      ? ['deferred', 'stale'].includes(status)
      : ['not_applicable', 'stale'].includes(status);
  if (!valid) {
    context.addIssue({
      code: 'custom',
      path: ['evaluatedStatus'],
      message: `Status ${status} is invalid for ${disposition} phase disposition`,
    });
  }
});

export const LifecycleReadModelSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  snapshot: EvaluationSnapshotIdentitySchema,
  workspaceId: StableIdSchema,
  specId: StableIdSchema,
  planId: StableIdSchema,
  planVersion: z.number().int().positive(),
  phases: z.array(PhaseEvaluationSchema).length(CANONICAL_PHASE_IDS.length),
}).strict().superRefine((model, context) => {
  if (model.snapshot.planId !== model.planId || model.snapshot.planVersion !== model.planVersion) {
    context.addIssue({
      code: 'custom',
      path: ['snapshot'],
      message: 'Read-model snapshot plan identity must match read-model plan identity',
    });
  }
  const phaseIds = model.phases.map((phase) => phase.phaseId);
  addDuplicateIdIssues(phaseIds, 'phases', context);
  phaseIds.forEach((phaseId, index) => {
    if (phaseId !== CANONICAL_PHASE_IDS[index]) {
      context.addIssue({
        code: 'custom',
        path: ['phases', index, 'phaseId'],
        message: `Read-model phase at position ${index} must be ${CANONICAL_PHASE_IDS[index]}`,
      });
    }
  });
});
export type LifecycleReadModel = z.infer<typeof LifecycleReadModelSchema>;

// Versioned API boundary DTOs. Routes may expose these later without inventing
// route-local lifecycle types or allowing a model/executor to claim authority.
export const CompileLifecyclePlanRequestSchema = LifecycleCompilerInputSchema;
export const CompileLifecyclePlanResponseSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  plan: LifecyclePlanSchema,
}).strict();
export const AppendEvidenceRequestSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  evidence: EvidenceRecordSchema,
}).strict();
export const RecordGovernedDecisionRequestSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  decision: GovernedDecisionSchema,
}).strict();
export const SubmitStoryCompletionRequestSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  completion: StoryCompletionPacketSchema,
}).strict();
export const GetLifecycleReadModelResponseSchema = z.object({
  schemaVersion: z.literal(SSDLC_SCHEMA_VERSION),
  readModel: LifecycleReadModelSchema,
}).strict();

export type CompileLifecyclePlanRequest = z.input<typeof CompileLifecyclePlanRequestSchema>;
export type CompileLifecyclePlanResponse = z.infer<typeof CompileLifecyclePlanResponseSchema>;
export type AppendEvidenceRequest = z.infer<typeof AppendEvidenceRequestSchema>;
export type RecordGovernedDecisionRequest = z.infer<typeof RecordGovernedDecisionRequestSchema>;
export type SubmitStoryCompletionRequest = z.infer<typeof SubmitStoryCompletionRequestSchema>;
export type GetLifecycleReadModelResponse = z.infer<typeof GetLifecycleReadModelResponseSchema>;

/** Sorts object keys and strips undefined object fields for byte-stable fixtures. */
export function normalizeSsdlcContractJson(value: unknown): string {
  const sort = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(sort);
    if (child && typeof child === 'object') {
      return Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, sort(item)]),
      );
    }
    return child;
  };
  return JSON.stringify(value, (_key, child) => child === undefined ? undefined : sort(child));
}

/** Structural JSON Schema projection; Zod remains authoritative for cross-field refinements. */
export const SSDLC_WIRE_JSON_SCHEMA = z.toJSONSchema(SsdlcWireContractSchema);
