/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Pure deterministic compiler from an assembled canonical spec to SSDLC v1.
 *
 * This module intentionally has no persistence, I/O, clock, or model dependency.
 * The caller owns assembly, timestamping, and atomic persistence of the returned
 * complete plan.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { UnprocessableError, ValidationError } from './errors';
import {
  CANONICAL_PHASE_IDS,
  COMPLETE_PRODUCT_CONTRACT,
  COMPILER_OPTIONAL_SOURCE_DEFAULTS,
  CompilerProfileSchema,
  DecisionReferenceSchema,
  ExecutionModeSchema,
  LifecycleCompilerInputSchema,
  LifecyclePlanSchema,
  PhaseDispositionValueSchema,
  PhaseIdSchema,
  SSDLC_SCHEMA_VERSION,
  deriveAcceptanceCriterionReferences,
  normalizeAcceptanceCriterionText,
  normalizeSsdlcContractJson,
  type CompilerProfile,
  type ExecutionMode,
  type LifecycleCompilerInput,
  type LifecyclePlan,
  type PhaseDisposition,
  type PhaseId,
  type ReleaseSubjectType,
  type RequirementReference,
} from './ssdlc-contracts';

export const SSDLC_PLAN_COMPILER_VERSION = 'ssdlc-plan-compiler-2' as const;

export type AssembledLifecycleCompileInput = z.input<typeof LifecycleCompilerInputSchema>;
export type AnnotationReviewStatus = 'accepted' | 'rejected';

export interface CompilerAnnotationReview {
  annotationId: string;
  source: 'caller' | 'pi' | 'hermes';
  status: AnnotationReviewStatus;
  reason: string;
  normalizedType?: 'execution_mode' | 'phase_disposition' | 'profile_hint';
}

export interface ExecutionCapabilityHint {
  mode: ExecutionMode;
  source: 'canonical_spec' | 'compiler_annotation';
  requiresEvidenceEvaluation: true;
  phaseMapping: 'none';
  rationale: string;
}

export interface LifecycleCompilationResult {
  schemaVersion: typeof SSDLC_SCHEMA_VERSION;
  plan: LifecyclePlan;
  profiles: CompilerProfile[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  annotationReviews: CompilerAnnotationReview[];
  defaultedInputs: Array<keyof typeof COMPILER_OPTIONAL_SOURCE_DEFAULTS>;
  capabilityHint: ExecutionCapabilityHint | null;
}

const StablePolicyReferenceSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9._:/-]{1,127}$/, 'Policy reference must be a stable 2-128 character identifier');

const ExecutionModeAnnotationSchema = z.object({
  type: z.literal('execution_mode'),
  mode: ExecutionModeSchema,
}).strict();

const ProfileHintAnnotationSchema = z.object({
  type: z.literal('profile_hint'),
  profile: CompilerProfileSchema,
}).strict();

const PhaseDispositionAnnotationSchema = z.object({
  type: z.literal('phase_disposition'),
  phaseId: PhaseIdSchema,
  disposition: PhaseDispositionValueSchema,
  rationale: z.string().trim().min(1),
  policyReference: StablePolicyReferenceSchema.optional(),
  policyValid: z.literal(true).optional(),
  approvalReference: DecisionReferenceSchema.optional(),
  expiryPolicy: z.string().trim().min(1).optional(),
}).strict();

const CompilerAnnotationPayloadSchema = z.discriminatedUnion('type', [
  ExecutionModeAnnotationSchema,
  ProfileHintAnnotationSchema,
  PhaseDispositionAnnotationSchema,
]);

type CompilerAnnotationPayload = z.infer<typeof CompilerAnnotationPayloadSchema>;
type PhaseDispositionAnnotation = z.infer<typeof PhaseDispositionAnnotationSchema>;

type GateTemplate = {
  title: string;
  evidenceKind: 'spec_review' | 'architecture_review' | 'change_review' | 'automated_validation'
    | 'security_assessment' | 'deployment_verification' | 'qa_assessment' | 'merge_authorization'
    | 'production_verification' | 'learning_review';
  subjectRevisionRequirement: 'current_spec_revision' | 'current_commit' | 'current_artifact' | 'current_deployment';
  approvalRequirement: 'none' | 'policy' | 'human';
  expirationPolicy: 'when_spec_changes' | 'when_subject_changes' | 'after_30_days' | 'never';
  blockingSeverity: 'advisory' | 'blocking' | 'release_blocking';
  acceptedSubjectTypes: ReleaseSubjectType[];
};

const GATE_TEMPLATES: Record<PhaseId, GateTemplate> = {
  intake: {
    title: 'Canonical intake is complete',
    evidenceKind: 'spec_review',
    subjectRevisionRequirement: 'current_spec_revision',
    approvalRequirement: 'none',
    expirationPolicy: 'when_spec_changes',
    blockingSeverity: 'blocking',
    acceptedSubjectTypes: ['spec_hash'],
  },
  requirements: {
    title: 'Requirements are complete and traceable',
    evidenceKind: 'spec_review',
    subjectRevisionRequirement: 'current_spec_revision',
    approvalRequirement: 'none',
    expirationPolicy: 'when_spec_changes',
    blockingSeverity: 'blocking',
    acceptedSubjectTypes: ['spec_hash'],
  },
  architecture: {
    title: 'Architecture impact is reviewed',
    evidenceKind: 'architecture_review',
    subjectRevisionRequirement: 'current_spec_revision',
    approvalRequirement: 'human',
    expirationPolicy: 'when_spec_changes',
    blockingSeverity: 'blocking',
    acceptedSubjectTypes: ['spec_hash'],
  },
  implementation: {
    title: 'Implementation matches the canonical requirements',
    evidenceKind: 'change_review',
    subjectRevisionRequirement: 'current_commit',
    approvalRequirement: 'none',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'blocking',
    acceptedSubjectTypes: ['commit_sha'],
  },
  validation: {
    title: 'Required validation is proven for the current revision',
    evidenceKind: 'automated_validation',
    subjectRevisionRequirement: 'current_commit',
    approvalRequirement: 'none',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'blocking',
    acceptedSubjectTypes: ['commit_sha'],
  },
  security: {
    title: 'Security assessment is complete',
    evidenceKind: 'security_assessment',
    subjectRevisionRequirement: 'current_commit',
    approvalRequirement: 'policy',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'release_blocking',
    acceptedSubjectTypes: ['commit_sha'],
  },
  staging: {
    title: 'Staging deployment is verified',
    evidenceKind: 'deployment_verification',
    subjectRevisionRequirement: 'current_artifact',
    approvalRequirement: 'none',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'release_blocking',
    acceptedSubjectTypes: ['commit_sha', 'artifact_digest'],
  },
  qa: {
    title: 'QA assessment covers the required journeys',
    evidenceKind: 'qa_assessment',
    subjectRevisionRequirement: 'current_artifact',
    approvalRequirement: 'human',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'release_blocking',
    acceptedSubjectTypes: ['commit_sha', 'artifact_digest'],
  },
  merge: {
    title: 'Merge is authorized for the validated revision',
    evidenceKind: 'merge_authorization',
    subjectRevisionRequirement: 'current_commit',
    approvalRequirement: 'human',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'release_blocking',
    acceptedSubjectTypes: ['commit_sha'],
  },
  production: {
    title: 'Production release is verified',
    evidenceKind: 'production_verification',
    subjectRevisionRequirement: 'current_deployment',
    approvalRequirement: 'policy',
    expirationPolicy: 'when_subject_changes',
    blockingSeverity: 'release_blocking',
    acceptedSubjectTypes: ['artifact_digest', 'deployment_id'],
  },
  learn: {
    title: 'Delivery outcomes are reviewed',
    evidenceKind: 'learning_review',
    subjectRevisionRequirement: 'current_deployment',
    approvalRequirement: 'none',
    expirationPolicy: 'after_30_days',
    blockingSeverity: 'advisory',
    acceptedSubjectTypes: ['spec_hash', 'deployment_id'],
  },
};

const HIGH_RISK_PROTECTED_PHASES = new Set<PhaseId>(['security', 'staging', 'qa', 'merge', 'production']);
const ALWAYS_REQUIRED_PHASES = new Set<PhaseId>(['intake', 'requirements', 'implementation', 'validation', 'learn']);
const OPTIONAL_INPUT_NAMES = Object.keys(COMPILER_OPTIONAL_SOURCE_DEFAULTS) as Array<keyof typeof COMPILER_OPTIONAL_SOURCE_DEFAULTS>;

function hashStableValue(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(value), 'utf8').digest('hex')}`;
}

function formatIssues(issues: z.core.$ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join('.') : 'input',
    message: issue.message,
  }));
}

function isReadinessIssue(issue: z.core.$ZodIssue): boolean {
  return /duplicate (?:acceptance criterion|explicit requirement|story reference|architecture decision)/i.test(issue.message)
    || issue.path.includes('compilerAnnotations');
}

function parseInput(input: AssembledLifecycleCompileInput): LifecycleCompilerInput {
  const result = LifecycleCompilerInputSchema.safeParse(input);
  if (!result.success) {
    const blockers = formatIssues(result.error.issues);
    const first = blockers[0];
    const details = { phase: 'input-validation', blockers };
    if (result.error.issues.some(isReadinessIssue)) {
      throw new UnprocessableError(
        `SSDLC compilation blocked during input-validation at ${first.path}: ${first.message}`,
        'SSDLC_READINESS_BLOCKED',
        details,
      );
    }
    throw new ValidationError(
      `SSDLC compiler input is invalid at ${first.path}: ${first.message}`,
      details,
    );
  }
  if (result.data.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION) {
    throw new ValidationError(
      `SSDLC compiler input is invalid at compilerVersion: expected ${SSDLC_PLAN_COMPILER_VERSION}, received ${result.data.compilerVersion}`,
      { phase: 'input-validation', compilerVersion: result.data.compilerVersion },
    );
  }
  return result.data;
}

function normalizeCriterionForHash(
  criterion: LifecycleCompilerInput['canonicalSpec']['json']['userStories'][number]['acceptanceCriteria'][number],
): string | { text: string; requirementId?: string } {
  const text = normalizeAcceptanceCriterionText(typeof criterion === 'string' ? criterion : criterion.text);
  return typeof criterion === 'string'
    ? text
    : { text, ...(criterion.requirementId ? { requirementId: criterion.requirementId } : {}) };
}

/** Semantic requirement order and whitespace do not perturb the compiler input identity. */
function normalizedInputIdentity(input: LifecycleCompilerInput): unknown {
  const json = input.canonicalSpec.json;
  const normalizedStories = json.userStories
    .map((story) => ({
      ...story,
      title: story.title.normalize('NFKC').trim().replace(/\s+/g, ' '),
      ...(story.description
        ? { description: story.description.normalize('NFKC').trim().replace(/\s+/g, ' ') }
        : {}),
      tags: [...story.tags].sort(),
      fileHints: [...story.fileHints].sort(),
      acceptanceCriteria: story.acceptanceCriteria
        .map(normalizeCriterionForHash)
        .sort((left, right) => normalizeSsdlcContractJson(left).localeCompare(normalizeSsdlcContractJson(right))),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const normalizedRequirements = json.requirements
    .map((requirement) => ({
      ...requirement,
      text: normalizeAcceptanceCriterionText(requirement.text),
      storyReferences: [...requirement.storyReferences].sort(),
      architectureDecisionReferences: [...requirement.architectureDecisionReferences].sort(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: input.schemaVersion,
    workspaceId: input.workspaceId,
    canonicalSpec: {
      specId: input.canonicalSpec.specId,
      version: input.canonicalSpec.version,
      json: {
        ...json,
        tags: [...json.tags].sort(),
        fileHints: [...json.fileHints].sort(),
        ...(json.contextSummary
          ? { contextSummary: { ...json.contextSummary, predictedFiles: [...json.contextSummary.predictedFiles].sort() } }
          : {}),
        userStories: normalizedStories,
        requirements: normalizedRequirements,
        architectureDecisions: [...json.architectureDecisions].sort((left, right) => left.id.localeCompare(right.id)),
      },
    },
    workspaceTags: input.workspaceTags,
    riskAssignments: input.riskAssignments,
    ownerAssignments: input.ownerAssignments,
    policyAnnotations: input.policyAnnotations,
    compilerAnnotations: [...input.compilerAnnotations]
      .sort((left, right) => left.annotationId.localeCompare(right.annotationId)),
    compilerVersion: input.compilerVersion,
    policyVersion: input.policyVersion,
  };
}

function collectSignals(input: LifecycleCompilerInput): { tags: string[]; fileHints: string[]; text: string } {
  const spec = input.canonicalSpec.json;
  const tags = [
    ...input.workspaceTags.map((entry) => entry.tag),
    ...spec.tags,
    ...spec.userStories.flatMap((story) => story.tags),
  ].map((tag) => tag.toLocaleLowerCase('en-US'));
  const fileHints = [
    ...spec.fileHints,
    ...(spec.contextSummary?.predictedFiles ?? []),
    ...spec.userStories.flatMap((story) => story.fileHints),
  ].map((file) => file.toLocaleLowerCase('en-US'));
  const criterionText = spec.userStories.flatMap((story) => story.acceptanceCriteria.map((criterion) => (
    typeof criterion === 'string' ? criterion : criterion.text
  )));
  const title = typeof spec.title === 'string' ? spec.title : '';
  const text = [
    title,
    ...tags,
    ...fileHints,
    ...spec.userStories.flatMap((story) => [story.title, story.description ?? '']),
    ...criterionText,
  ].join(' ').normalize('NFKC').toLocaleLowerCase('en-US');
  return { tags, fileHints, text };
}

function classifyProfiles(input: LifecycleCompilerInput): CompilerProfile[] {
  const { tags, fileHints, text } = collectSignals(input);
  const hasTag = (pattern: RegExp): boolean => tags.some((tag) => pattern.test(tag));
  const hasFile = (pattern: RegExp): boolean => fileHints.some((file) => pattern.test(file));
  const profiles = new Set<CompilerProfile>();

  const securitySensitive = hasTag(/security|auth|tenant|privacy|compliance/)
    || hasFile(/auth|security|secret|permission|redact|encrypt/)
    || /authentication|cross-tenant|secret disclosure|vulnerabilit|redaction|encryption|authorization (?:check|boundary|policy)/.test(text);
  const dataStorage = hasTag(/database|data-storage|postgres|storage|migration/)
    || hasFile(/(?:^|\/)db(?:\/|$)|migration|\.sql$/)
    || /database|postgres|schema migration|data storage|tenant isolation|rollback and recovery/.test(text);
  const integration = hasTag(/integration|chatops|slack|webhook|adapter/)
    || hasFile(/webhook|adapter|integration|slack/)
    || /chatops|slack|webhook|external api|third-party integration/.test(text);
  const releaseOperations = hasTag(/release|production|deployment|release-operations/)
    || hasFile(/(?:^|\/)(?:deploy|deployment|helm|terraform|kubernetes)(?:\/|$)|\.github\/workflows|(?:^|\/)scripts\/release/)
    || /immutable artifact|artifact digest|deploy to production|production release|rollback checks/.test(text);
  const docsMarker = hasTag(/^(?:docs|documentation|docs-only)$/)
    || fileHints.some((file) => /(?:^|\/)(?:docs?|readme)(?:\/|\.|$)|\.mdx?$/.test(file));
  const allFilesAreDocs = fileHints.length > 0
    && fileHints.every((file) => /(?:^|\/)(?:docs?|readme)(?:\/|\.|$)|\.mdx?$/.test(file));
  const docsOnly = docsMarker && allFilesAreDocs
    && !securitySensitive && !dataStorage && !integration && !releaseOperations;

  if (docsOnly) profiles.add('docs-only');
  else profiles.add('code-change');
  if (dataStorage) profiles.add('data-storage');
  if (securitySensitive) profiles.add('security-sensitive');
  if (integration) profiles.add('integration');
  if (releaseOperations) profiles.add('release-operations');

  return [...profiles].sort((left, right) => (
    CompilerProfileSchema.options.indexOf(left) - CompilerProfileSchema.options.indexOf(right)
  ));
}

function highestRisk(input: LifecycleCompilerInput): LifecycleCompilationResult['riskLevel'] {
  const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
  return input.riskAssignments.reduce<LifecycleCompilationResult['riskLevel']>(
    (highest, assignment) => rank[assignment.risk] > rank[highest] ? assignment.risk : highest,
    'low',
  );
}

function requiredDisposition(phaseId: PhaseId, profiles: CompilerProfile[]): PhaseDisposition {
  return {
    disposition: 'required',
    rationale: `${phaseId} is required by the fixed ${profiles.join(', ')} compiler profile.`,
  };
}

function initialDispositions(
  profiles: CompilerProfile[],
  riskLevel: LifecycleCompilationResult['riskLevel'],
): Map<PhaseId, PhaseDisposition> {
  const dispositions = new Map<PhaseId, PhaseDisposition>();
  const highRiskOrRelease = riskLevel === 'high' || riskLevel === 'critical'
    || profiles.includes('security-sensitive') || profiles.includes('release-operations');
  for (const phaseId of CANONICAL_PHASE_IDS) {
    if (!highRiskOrRelease && profiles.length === 1 && profiles[0] === 'docs-only'
      && ['architecture', 'security', 'staging', 'qa', 'production'].includes(phaseId)) {
      dispositions.set(phaseId, {
        disposition: 'not_applicable',
        rationale: `The low-risk docs-only profile changes no ${phaseId} runtime subject.`,
      });
    } else {
      dispositions.set(phaseId, requiredDisposition(phaseId, profiles));
    }
  }
  return dispositions;
}

function annotationIssueReason(error: z.ZodError): string {
  const first = error.issues[0];
  const path = first.path.length > 0 ? first.path.map(String).join('.') : 'payload';
  return `Rejected annotation schema at ${path}: ${first.message}; annotations cannot set evaluated status or evidence.`;
}

function hasValidPolicyInput(input: LifecycleCompilerInput, policyReference: string | undefined): boolean {
  return policyReference !== undefined && input.policyAnnotations.some((annotation) => (
    annotation.policyReference === policyReference && annotation.value === true
  ));
}

function validatePhaseAnnotation(
  annotation: PhaseDispositionAnnotation,
  source: CompilerAnnotationReview['source'],
  profiles: CompilerProfile[],
  riskLevel: LifecycleCompilationResult['riskLevel'],
  input: LifecycleCompilerInput,
): string | null {
  if (ALWAYS_REQUIRED_PHASES.has(annotation.phaseId) && annotation.disposition !== 'required') {
    return `Phase ${annotation.phaseId} is a mandatory traceability phase and defaults to required.`;
  }
  if (annotation.disposition === 'required') return null;
  if (source !== 'caller') {
    return `${source} may propose annotations but cannot supply governed phase disposition authority.`;
  }
  if (!annotation.policyValid || !hasValidPolicyInput(input, annotation.policyReference)) {
    return `Phase ${annotation.phaseId} ${annotation.disposition} requires a matching policy-valid caller input.`;
  }
  if (annotation.disposition === 'deferred' && (!annotation.approvalReference || !annotation.expiryPolicy)) {
    return `Phase ${annotation.phaseId} deferred requires explicit approvalReference and expiryPolicy.`;
  }
  const highRiskOrRelease = riskLevel === 'high' || riskLevel === 'critical'
    || profiles.includes('security-sensitive') || profiles.includes('release-operations');
  if (annotation.disposition === 'not_applicable' && highRiskOrRelease
    && HIGH_RISK_PROTECTED_PHASES.has(annotation.phaseId) && !annotation.approvalReference) {
    return `High-risk/release phase ${annotation.phaseId} cannot be not-applicable without explicit approval input.`;
  }
  return null;
}

function toDisposition(annotation: PhaseDispositionAnnotation): PhaseDisposition {
  if (annotation.disposition === 'required') {
    return { disposition: 'required', rationale: annotation.rationale };
  }
  return {
    disposition: annotation.disposition,
    rationale: annotation.rationale,
    ...(annotation.approvalReference ? { approvalReference: annotation.approvalReference } : {}),
    ...(annotation.expiryPolicy ? { expiryPolicy: annotation.expiryPolicy } : {}),
  };
}

function reviewAnnotations(
  input: LifecycleCompilerInput,
  profiles: CompilerProfile[],
  riskLevel: LifecycleCompilationResult['riskLevel'],
  dispositions: Map<PhaseId, PhaseDisposition>,
): { reviews: CompilerAnnotationReview[]; capabilityHint: ExecutionCapabilityHint | null } {
  const reviews: CompilerAnnotationReview[] = [];
  const duplicateIds = new Set(
    input.compilerAnnotations
      .filter((candidate, index, all) => all.findIndex((item) => item.annotationId === candidate.annotationId) !== index)
      .map((candidate) => candidate.annotationId),
  );
  let capabilityHint: ExecutionCapabilityHint | null = input.canonicalSpec.json.executionMode
    ? {
      mode: input.canonicalSpec.json.executionMode,
      source: 'canonical_spec',
      requiresEvidenceEvaluation: true,
      phaseMapping: 'none',
      rationale: `${input.canonicalSpec.json.executionMode} is a capability hint only and does not pass or map one-to-one to a lifecycle phase.`,
    }
    : null;

  const annotations = [...input.compilerAnnotations].sort((left, right) => (
    left.annotationId.localeCompare(right.annotationId) || left.source.localeCompare(right.source)
  ));
  for (const envelope of annotations) {
    if (duplicateIds.has(envelope.annotationId)) {
      reviews.push({
        annotationId: envelope.annotationId,
        source: envelope.source,
        status: 'rejected',
        reason: `Duplicate compiler annotation reference ${envelope.annotationId} is a readiness blocker.`,
      });
      continue;
    }
    const parsed = CompilerAnnotationPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      reviews.push({
        annotationId: envelope.annotationId,
        source: envelope.source,
        status: 'rejected',
        reason: annotationIssueReason(parsed.error),
      });
      continue;
    }

    const payload: CompilerAnnotationPayload = parsed.data;
    if (payload.type === 'profile_hint') {
      if (!profiles.includes(payload.profile)) {
        reviews.push({
          annotationId: envelope.annotationId,
          source: envelope.source,
          status: 'rejected',
          normalizedType: payload.type,
          reason: `Profile hint ${payload.profile} is unsupported by canonical tags, stories, criteria, and file hints.`,
        });
      } else {
        reviews.push({
          annotationId: envelope.annotationId,
          source: envelope.source,
          status: 'accepted',
          normalizedType: payload.type,
          reason: `Profile hint ${payload.profile} agrees with authoritative fixed-profile classification.`,
        });
      }
      continue;
    }

    if (payload.type === 'execution_mode') {
      if (capabilityHint && capabilityHint.mode !== payload.mode) {
        reviews.push({
          annotationId: envelope.annotationId,
          source: envelope.source,
          status: 'rejected',
          normalizedType: payload.type,
          reason: `Execution mode ${payload.mode} conflicts with authoritative capability hint ${capabilityHint.mode}.`,
        });
      } else {
        capabilityHint ??= {
          mode: payload.mode,
          source: 'compiler_annotation',
          requiresEvidenceEvaluation: true,
          phaseMapping: 'none',
          rationale: `${payload.mode} is a validated capability hint only and does not pass or map one-to-one to a lifecycle phase.`,
        };
        reviews.push({
          annotationId: envelope.annotationId,
          source: envelope.source,
          status: 'accepted',
          normalizedType: payload.type,
          reason: `Validated ${payload.mode} as a capability hint; normal gate evidence evaluation remains required.`,
        });
      }
      continue;
    }

    const rejectionReason = validatePhaseAnnotation(payload, envelope.source, profiles, riskLevel, input);
    if (rejectionReason) {
      reviews.push({
        annotationId: envelope.annotationId,
        source: envelope.source,
        status: 'rejected',
        normalizedType: payload.type,
        reason: rejectionReason,
      });
      continue;
    }
    dispositions.set(payload.phaseId, toDisposition(payload));
    reviews.push({
      annotationId: envelope.annotationId,
      source: envelope.source,
      status: 'accepted',
      normalizedType: payload.type,
      reason: `Validated governed ${payload.phaseId} disposition ${payload.disposition}; no evaluated status or evidence was inferred.`,
    });
  }

  return { reviews, capabilityHint };
}

function evidenceClassification(
  phaseId: PhaseId,
  profiles: CompilerProfile[],
): 'code_change' | 'documentation' | 'test_result' | 'security_finding' | 'data_storage'
  | 'release_operation' | 'approval' | 'runtime_observation' {
  if (['intake', 'requirements', 'architecture'].includes(phaseId)) return 'documentation';
  if (phaseId === 'implementation') {
    if (profiles.includes('docs-only')) return 'documentation';
    if (profiles.includes('data-storage')) return 'data_storage';
    if (profiles.includes('release-operations')) return 'release_operation';
    return 'code_change';
  }
  if (phaseId === 'validation' || phaseId === 'qa') return 'test_result';
  if (phaseId === 'security') return 'security_finding';
  if (phaseId === 'merge') return 'approval';
  if (phaseId === 'production') return 'release_operation';
  return 'runtime_observation';
}

function buildGates(
  profiles: CompilerProfile[],
  riskLevel: LifecycleCompilationResult['riskLevel'],
  hasExplicitRisk: boolean,
) {
  const standingPolicyEligible = hasExplicitRisk
    && !['high', 'critical'].includes(riskLevel)
    && !profiles.includes('security-sensitive')
    && !profiles.includes('release-operations');
  const gates = CANONICAL_PHASE_IDS.map((phaseId) => {
    const template = GATE_TEMPLATES[phaseId];
    return {
      gateId: `gate-${phaseId}`,
      phaseId,
      title: template.title,
      evidenceKind: template.evidenceKind,
      subjectRevisionRequirement: template.subjectRevisionRequirement,
      approvalRequirement: phaseId === 'merge' && standingPolicyEligible
        ? 'policy' as const
        : template.approvalRequirement,
      expirationPolicy: template.expirationPolicy,
      blockingSeverity: template.blockingSeverity,
      evidenceRequirementIds: [`evidence-requirement-${phaseId}`],
      acceptedSubjectTypes: template.acceptedSubjectTypes,
      downstreamSubjectCoherence: {
        qa: phaseId === 'qa' ? 'same_subject' as const : 'derived_from_subject' as const,
        merge: phaseId === 'merge' ? 'same_subject' as const : 'derived_from_subject' as const,
        production: phaseId === 'production' ? 'same_subject' as const : 'derived_from_subject' as const,
      },
    };
  });
  const evidenceRequirements = CANONICAL_PHASE_IDS.map((phaseId) => ({
    evidenceRequirementId: `evidence-requirement-${phaseId}`,
    gateId: `gate-${phaseId}`,
    description: `${GATE_TEMPLATES[phaseId].evidenceKind} evidence is required for the current ${GATE_TEMPLATES[phaseId].subjectRevisionRequirement}; this template does not claim evidence exists.`,
    classification: evidenceClassification(phaseId, profiles),
    minimumTrustLevel: ['security', 'staging', 'qa', 'merge', 'production'].includes(phaseId)
      ? 'verified' as const
      : 'local' as const,
  }));
  return { gates, evidenceRequirements };
}

type RequirementEntry = {
  requirementReference: RequirementReference;
  targetReferences: Array<
    { type: 'story'; reference: string }
    | { type: 'architecture_decision'; reference: string }
  >;
};

function buildRequirementEntries(input: LifecycleCompilerInput): RequirementEntry[] {
  const storyReferences = new Set(input.canonicalSpec.json.userStories.map((story) => story.id));
  const architectureReferences = new Set(input.canonicalSpec.json.architectureDecisions.map((decision) => decision.id));
  const entries: RequirementEntry[] = deriveAcceptanceCriterionReferences(input).map((criterion) => ({
    requirementReference: criterion.requirementReference,
    targetReferences: [{ type: 'story', reference: criterion.storyReference }],
  }));

  for (const requirement of input.canonicalSpec.json.requirements) {
    const targets: RequirementEntry['targetReferences'] = [];
    for (const storyReference of requirement.storyReferences) {
      if (!storyReferences.has(storyReference)) {
        throw new UnprocessableError(
          `SSDLC compilation blocked during requirement-mapping: requirement ${requirement.id} references unknown story ${storyReference}`,
          'SSDLC_READINESS_BLOCKED',
          { phase: 'requirement-mapping', requirement: requirement.id, story: storyReference },
        );
      }
      targets.push({ type: 'story', reference: storyReference });
    }
    for (const decisionReference of requirement.architectureDecisionReferences) {
      if (!architectureReferences.has(decisionReference)) {
        throw new UnprocessableError(
          `SSDLC compilation blocked during requirement-mapping: requirement ${requirement.id} references unknown architecture decision ${decisionReference}`,
          'SSDLC_READINESS_BLOCKED',
          { phase: 'requirement-mapping', requirement: requirement.id, architectureDecision: decisionReference },
        );
      }
      targets.push({ type: 'architecture_decision', reference: decisionReference });
    }
    if (targets.length === 0) {
      throw new UnprocessableError(
        `SSDLC compilation blocked during requirement-mapping: requirement ${requirement.id} is unmapped to a story or architecture decision`,
        'SSDLC_READINESS_BLOCKED',
        { phase: 'requirement-mapping', requirement: requirement.id },
      );
    }
    entries.push({ requirementReference: requirement.id, targetReferences: targets });
  }

  return entries.sort((left, right) => left.requirementReference.localeCompare(right.requirementReference));
}

function outputError(error: z.ZodError): UnprocessableError {
  const blockers = formatIssues(error.issues);
  const first = blockers[0];
  const gate = first.path.match(/gates\.(\d+)/)?.[1];
  const requirement = first.path.match(/requirementMappings\.(\d+)/)?.[1];
  return new UnprocessableError(
    `SSDLC compilation produced an invalid atomic plan during output-validation at ${first.path}: ${first.message}`,
    'SSDLC_COMPILER_OUTPUT_INVALID',
    {
      phase: 'output-validation',
      ...(gate ? { gate } : {}),
      ...(requirement ? { requirementMapping: requirement } : {}),
      blockers,
    },
  );
}

/**
 * Compile a complete lifecycle plan or throw one AppError. No partial plan is
 * returned, persisted, timestamped, or evaluated by this function.
 */
export function compileLifecyclePlan(input: AssembledLifecycleCompileInput): LifecycleCompilationResult {
  const defaultedInputs = OPTIONAL_INPUT_NAMES.filter((name) => (
    !input || typeof input !== 'object' || !(name in input)
  ));
  const parsed = parseInput(input);
  const profiles = classifyProfiles(parsed);
  const riskLevel = highestRisk(parsed);
  const dispositions = initialDispositions(profiles, riskLevel);
  const annotationReview = reviewAnnotations(parsed, profiles, riskLevel, dispositions);
  const inputHash = hashStableValue(normalizedInputIdentity(parsed));
  const { gates, evidenceRequirements } = buildGates(profiles, riskLevel, parsed.riskAssignments.length > 0);
  const requirementEntries = buildRequirementEntries(parsed);
  const mappingGateIds = ['gate-requirements', 'gate-validation'];
  const mappingEvidenceIds = ['evidence-requirement-requirements', 'evidence-requirement-validation'];

  const candidate = {
    schemaVersion: SSDLC_SCHEMA_VERSION,
    planId: `plan-${inputHash.slice('sha256:'.length)}`,
    planVersion: 1,
    inputHash,
    workspaceId: parsed.workspaceId,
    specId: parsed.canonicalSpec.specId,
    compilerVersion: parsed.compilerVersion,
    policyVersion: parsed.policyVersion,
    compiledAt: parsed.compiledAt,
    phaseOrder: [...CANONICAL_PHASE_IDS],
    phases: CANONICAL_PHASE_IDS.map((phaseId) => ({
      phaseId,
      disposition: dispositions.get(phaseId) ?? requiredDisposition(phaseId, profiles),
      gateIds: [`gate-${phaseId}`],
    })),
    requirementReferences: requirementEntries.map((entry) => entry.requirementReference),
    storyReferences: parsed.canonicalSpec.json.userStories.map((story) => story.id).sort(),
    architectureDecisionReferences: parsed.canonicalSpec.json.architectureDecisions
      .map((decision) => decision.id).sort(),
    requirementMappings: requirementEntries.map((entry) => ({
      requirementReference: entry.requirementReference,
      targetReferences: entry.targetReferences.sort((left, right) => (
        `${left.type}:${left.reference}`.localeCompare(`${right.type}:${right.reference}`)
      )),
      gateIds: mappingGateIds,
      evidenceRequirementIds: mappingEvidenceIds,
    })),
    gates,
    evidenceRequirements,
    completeness: COMPLETE_PRODUCT_CONTRACT,
  };
  const planResult = LifecyclePlanSchema.safeParse(candidate);
  if (!planResult.success) throw outputError(planResult.error);

  return {
    schemaVersion: SSDLC_SCHEMA_VERSION,
    plan: planResult.data,
    profiles,
    riskLevel,
    annotationReviews: annotationReview.reviews,
    defaultedInputs,
    capabilityHint: annotationReview.capabilityHint,
  };
}

/** Old requirement mappings missing from the next plan are the only stale mappings. */
export function findStaleRequirementMappings(
  previousPlan: Pick<LifecyclePlan, 'requirementMappings'>,
  nextPlan: Pick<LifecyclePlan, 'requirementMappings'>,
): RequirementReference[] {
  const nextReferences = new Set(nextPlan.requirementMappings.map((mapping) => mapping.requirementReference));
  return previousPlan.requirementMappings
    .map((mapping) => mapping.requirementReference)
    .filter((reference) => !nextReferences.has(reference))
    .sort();
}
