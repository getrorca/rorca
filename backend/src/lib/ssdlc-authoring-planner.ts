/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Pure deterministic SSDLC authoring planner and draft preflight.
 *
 * The planner has no model, clock, persistence, scheduler, runtime-mode, gate
 * evaluation, or evidence-writing dependency. A caller may provide readable
 * outcomes, boundaries, and story prose. Rorca accepts only policy-valid
 * decomposition and returns amendments rather than mutating that prose.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import {
  CANONICAL_PHASE_IDS,
  ExplicitRequirementIdSchema,
  normalizeAcceptanceCriterionText,
  normalizeSsdlcContractJson,
} from './ssdlc-contracts';
import {
  AuthoringPlanSchema,
  AuthoringPlannerInputSchema,
  AuthoringPreflightInputSchema,
  AuthoringPreflightResultSchema,
  NormalizedAuthoringIntentSchema,
  SSDLC_AUTHORING_SCHEMA_VERSION,
  STORY_CAPABILITIES,
  type AuthoringBoundaryCandidate,
  type AuthoringDiagnostic,
  type AuthoringLifecycleProfileId,
  type AuthoringPlan,
  type AuthoringPlannerInput,
  type AuthoringPlannerInputCandidate,
  type AuthoringPreflightInput,
  type AuthoringPreflightInputCandidate,
  type AuthoringPreflightResult,
  type NormalizedAuthoringIntent,
  type StoryCapability,
} from './ssdlc-authoring-contracts';

export const SSDLC_AUTHORING_PLANNER_VERSION = 'ssdlc-authoring-planner-1' as const;

const PROFILE_CAPABILITIES: Record<AuthoringLifecycleProfileId, readonly StoryCapability[]> = {
  'docs-only': ['contract', 'validation', 'learning'],
  'code-change': [
    'contract', 'implementation', 'validation', 'qa', 'journey', 'rollout', 'recovery', 'operations', 'learning',
  ],
  'data-storage': [
    'contract', 'migration', 'implementation', 'validation', 'security', 'qa', 'journey', 'rollout', 'recovery',
    'operations', 'learning',
  ],
  'security-sensitive': [
    'contract', 'implementation', 'validation', 'security', 'qa', 'journey', 'rollout', 'recovery', 'operations',
    'learning',
  ],
  integration: [
    'contract', 'implementation', 'validation', 'security', 'qa', 'journey', 'rollout', 'recovery', 'operations',
    'learning',
  ],
  'release-operations': ['contract', 'validation', 'qa', 'journey', 'rollout', 'recovery', 'operations', 'learning'],
};

const CAPABILITY_ORDER = new Map(STORY_CAPABILITIES.map((capability, index) => [capability, index]));
const TESTABLE_LANGUAGE = /\b(rejects?|returns?|records?|emits?|displays?|persists?|preserves?|prevents?|produces?|reports?|passes?|fails?|contains?|equals?|remains?|recovers?|rolls? back|observ(?:e|es|able)|verif(?:y|ies|iable))\b/i;
const VAGUE_LANGUAGE = /\b(works? as expected|works? correctly|properly|as needed|appropriate(?:ly)?|good|nice|stuff|things|should work|etc\.)\b/i;
const IMPLEMENTATION_TASK_TITLE = /^(implement|build|create|add|update|refactor|change|modify)\b/i;
const OUTCOME_LANGUAGE = /\b(so that|allows?|enables?|prevents?|preserves?|ensures?|users?|operators?|customers?|callers?|system|service|workflow|outcome|recovery|contract)\b/i;
const UMBRELLA_LANGUAGE = /\b(everything|entire system|all phases|whole platform|end[- ]to[- ]end implementation)\b/i;
const STABLE_REFERENCE = /^[A-Za-z][A-Za-z0-9._:/-]{1,127}$/;

export interface AuthoringIntentRequirementCandidate {
  reference: string;
  sourceReference: string;
  text: string;
  conflictsWith?: string[];
}

export interface AuthoringIntentCandidate {
  outcome: string;
  brief: string;
  requirements: AuthoringIntentRequirementCandidate[];
  ambiguities?: string[];
}

export interface AuthoringPlanningResult {
  acceptedPlan: AuthoringPlan | null;
  diagnostics: AuthoringDiagnostic[];
}

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(value), 'utf8').digest('hex')}`;
}

function normalizedProse(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function normalizedIntentIdentity(intent: Omit<NormalizedAuthoringIntent, 'normalizedIntentHash'>): unknown {
  return {
    outcome: normalizedProse(intent.outcome).toLocaleLowerCase('en-US'),
    normalizedBrief: normalizedProse(intent.normalizedBrief).toLocaleLowerCase('en-US'),
    requirements: [...intent.requirements]
      .map((requirement) => ({
        reference: requirement.reference,
        sourceReference: requirement.sourceReference,
        normalizedText: requirement.normalizedText,
        conflictsWith: [...requirement.conflictsWith].sort(),
      }))
      .sort((left, right) => left.reference.localeCompare(right.reference)),
    ambiguities: [...intent.ambiguities].map(normalizedProse).sort((left, right) => left.localeCompare(right)),
  };
}

export function deriveNormalizedIntentHash(
  intent: Omit<NormalizedAuthoringIntent, 'normalizedIntentHash'>,
): `sha256:${string}` {
  return hash(normalizedIntentIdentity(intent));
}

/** Normalize caller-extracted requirements before authoritative planning. */
export function normalizeAuthoringIntent(candidate: AuthoringIntentCandidate): NormalizedAuthoringIntent {
  const requirements = candidate.requirements.map((requirement) => ({
    reference: ExplicitRequirementIdSchema.parse(requirement.reference),
    sourceReference: normalizedProse(requirement.sourceReference),
    text: normalizedProse(requirement.text),
    normalizedText: normalizeAcceptanceCriterionText(requirement.text),
    conflictsWith: [...new Set(requirement.conflictsWith ?? [])].sort(),
  })).sort((left, right) => left.reference.localeCompare(right.reference));
  const withoutHash = {
    outcome: normalizedProse(candidate.outcome),
    normalizedBrief: normalizedProse(candidate.brief),
    requirements,
    ambiguities: [...new Set((candidate.ambiguities ?? []).map(normalizedProse))]
      .sort((left, right) => left.localeCompare(right)),
  };
  return NormalizedAuthoringIntentSchema.parse({
    ...withoutHash,
    normalizedIntentHash: deriveNormalizedIntentHash(withoutHash),
  });
}

function sortCapabilities(capabilities: Iterable<StoryCapability>): StoryCapability[] {
  return [...new Set(capabilities)].sort((left, right) => (
    (CAPABILITY_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) - (CAPABILITY_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function diagnostic(input: AuthoringDiagnostic): AuthoringDiagnostic {
  return {
    ...input,
    references: [...new Set(input.references)].sort((left, right) => left.localeCompare(right)),
  };
}

const SEVERITY_ORDER: Record<AuthoringDiagnostic['severity'], number> = {
  blocker: 0,
  question: 1,
  warning: 2,
  info: 3,
};

function sortDiagnostics(diagnostics: AuthoringDiagnostic[]): AuthoringDiagnostic[] {
  return diagnostics.map(diagnostic).sort((left, right) => (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.code.localeCompare(right.code)
    || left.path.localeCompare(right.path)
    || left.references.join('|').localeCompare(right.references.join('|'))
    || left.message.localeCompare(right.message)
  ));
}

function zodDiagnostics(error: z.ZodError, root: string): AuthoringDiagnostic[] {
  return error.issues.map((issue) => {
    const isUnknownField = issue.code === 'unrecognized_keys';
    const unknownFields = isUnknownField ? issue.keys.map(String) : [];
    const path = [
      root,
      ...issue.path.map(String),
      ...(unknownFields.length === 1 ? unknownFields : []),
    ].join('.');
    return diagnostic({
      code: isUnknownField ? 'NON_AUTHORITATIVE_FIELD' : 'INVALID_AUTHORING_INPUT',
      severity: 'blocker',
      path,
      message: isUnknownField
        ? `Caller proposal contains unsupported authority-bearing or unknown fields: ${issue.message}`
        : `Authoring input is invalid: ${issue.message}`,
      references: [...issue.path.map(String), ...unknownFields],
      amendment: 'Remove unsupported fields or correct the contract value, then resubmit the unchanged draft explicitly.',
    });
  });
}

function slugSeed(value: string): string {
  const normalized = value.normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return normalized.length >= 2 ? normalized : 'authoring-intent';
}

function specReference(intentHash: string, key: string): string {
  return `SPEC-${hash({ intentHash, key }).slice('sha256:'.length, 'sha256:'.length + 16).toUpperCase()}`;
}

function phaseCapability(phaseId: (typeof CANONICAL_PHASE_IDS)[number], capabilities: StoryCapability[]): StoryCapability {
  const preferred: Record<(typeof CANONICAL_PHASE_IDS)[number], StoryCapability> = {
    intake: 'contract',
    requirements: 'contract',
    architecture: 'contract',
    implementation: 'implementation',
    validation: 'validation',
    security: 'security',
    staging: 'rollout',
    qa: 'qa',
    merge: 'rollout',
    production: 'operations',
    learn: 'learning',
  };
  return capabilities.includes(preferred[phaseId]) ? preferred[phaseId] : 'validation';
}

function lifecycleProfile(profileId: AuthoringLifecycleProfileId, capabilities: StoryCapability[]) {
  return {
    profileId,
    requiredStoryCapabilities: capabilities,
    phaseContributions: CANONICAL_PHASE_IDS.map((phaseId) => ({
      phaseId,
      gateIds: [`gate-${phaseId}`],
      expectedCapabilities: [phaseCapability(phaseId, capabilities)],
      evidenceExpectation: `A story contribution must declare observable evidence for ${phaseId}/gate-${phaseId}; authoring does not claim that evidence exists or that the phase passed.`,
    })),
    runtimeSemantics: 'none' as const,
    evaluatedPhaseStatusAuthority: 'none' as const,
  };
}

function acceptedHashIdentity(plan: Omit<AuthoringPlan, 'acceptedPlanHash'>): unknown {
  return {
    schemaVersion: plan.schemaVersion,
    validationStatus: plan.validationStatus,
    workspaceId: plan.workspaceId,
    normalizedIntentHash: plan.normalizedIntentHash,
    sourceContextIdentity: plan.sourceContextIdentity,
    workspacePolicyVersion: plan.workspacePolicyVersion,
    plannerVersion: plan.plannerVersion,
    recommendedSpecCount: plan.recommendedSpecCount,
    requirements: plan.requirements,
    specBoundaries: plan.specBoundaries,
    crossSpecDependencies: plan.crossSpecDependencies,
    requiredStoryCapabilities: plan.requiredStoryCapabilities,
    lifecycleProfile: plan.lifecycleProfile,
    storyQualityPolicy: plan.storyQualityPolicy,
    diagnostics: plan.diagnostics,
    acceptedOverrides: plan.acceptedOverrides,
  };
}

export function deriveAcceptedAuthoringPlanHash(
  plan: Omit<AuthoringPlan, 'acceptedPlanHash'>,
): `sha256:${string}` {
  return hash(acceptedHashIdentity(plan));
}

export function verifyAcceptedAuthoringPlanHash(plan: AuthoringPlan): boolean {
  const { acceptedPlanHash, ...withoutHash } = plan;
  return acceptedPlanHash === deriveAcceptedAuthoringPlanHash(withoutHash);
}

function detectRequirementProblems(input: AuthoringPlannerInput, diagnostics: AuthoringDiagnostic[]): void {
  const references = new Set(input.intent.requirements.map((requirement) => requirement.reference));
  const seenReferences = new Set<string>();
  const textOwners = new Map<string, string>();
  for (const requirement of input.intent.requirements) {
    if (seenReferences.has(requirement.reference)) {
      diagnostics.push(diagnostic({
        code: 'DUPLICATE_REQUIREMENT_OWNER',
        severity: 'blocker',
        path: 'intent.requirements',
        message: `Requirement ${requirement.reference} is declared more than once in the normalized registry.`,
        references: [requirement.reference],
        amendment: 'Retain one stable registry entry for the requirement and resubmit.',
      }));
    }
    seenReferences.add(requirement.reference);
    const priorTextOwner = textOwners.get(requirement.normalizedText);
    if (priorTextOwner && priorTextOwner !== requirement.reference) {
      diagnostics.push(diagnostic({
        code: 'OVERLAPPING_BOUNDARY',
        severity: 'blocker',
        path: 'intent.requirements',
        message: `Requirements ${priorTextOwner} and ${requirement.reference} duplicate the same normalized obligation.`,
        references: [priorTextOwner, requirement.reference],
        amendment: 'Consolidate the duplicate registry entries while preserving source traceability.',
      }));
    }
    textOwners.set(requirement.normalizedText, requirement.reference);
    for (const conflict of requirement.conflictsWith) {
      diagnostics.push(diagnostic({
        code: references.has(conflict) ? 'CONFLICTING_REQUIREMENTS' : 'UNKNOWN_REQUIREMENT_REFERENCE',
        severity: 'blocker',
        path: `intent.requirements.${requirement.reference}.conflictsWith`,
        message: references.has(conflict)
          ? `Requirements ${requirement.reference} and ${conflict} conflict and need an explicit resolution before decomposition.`
          : `Requirement ${requirement.reference} conflicts with unknown requirement ${conflict}.`,
        references: [requirement.reference, conflict],
        amendment: 'Resolve the conflict in the normalized requirement registry, then recompute the intent hash.',
      }));
    }
  }
}

function validateOverrides(
  input: AuthoringPlannerInput,
  diagnostics: AuthoringDiagnostic[],
): {
  boundaries: AuthoringBoundaryCandidate[];
  capabilities: StoryCapability[];
  acceptedOverrides: AuthoringPlan['acceptedOverrides'];
} {
  let boundaries = input.boundaryCandidates;
  let capabilities = sortCapabilities([
    ...PROFILE_CAPABILITIES[input.lifecycleProfile],
    ...input.workspacePolicy.requiredStoryCapabilities,
  ]);
  const acceptedOverrides: AuthoringPlan['acceptedOverrides'] = [];
  const appliedKinds = new Set<string>();

  for (const override of [...input.overrides].sort((left, right) => left.overrideId.localeCompare(right.overrideId))) {
    const problems: string[] = [];
    if (!input.workspacePolicy.allowHumanOverrides) problems.push('workspace policy disables human overrides');
    if (!input.workspacePolicy.overridePolicyReference) problems.push('workspace policy has no override policy reference');
    if (override.policyReference !== input.workspacePolicy.overridePolicyReference) problems.push('policy reference does not match workspace policy');
    for (const kind of override.kinds) {
      if (!input.workspacePolicy.allowedOverrideKinds.includes(kind)) problems.push(`override kind ${kind} is not allowed`);
      if (appliedKinds.has(kind)) problems.push(`another accepted override already changes ${kind}`);
    }
    if (override.kinds.includes('decomposition')) {
      if (!override.boundaryCandidates || override.recommendedSpecCount === undefined) {
        problems.push('decomposition override requires boundaryCandidates and recommendedSpecCount');
      } else if (override.recommendedSpecCount !== override.boundaryCandidates.length) {
        problems.push('recommendedSpecCount must equal the submitted boundary count');
      }
    } else if (override.boundaryCandidates || override.recommendedSpecCount !== undefined) {
      problems.push('boundary fields require the decomposition override kind');
    }
    if (override.kinds.includes('capabilities')) {
      if (!override.requiredStoryCapabilities) {
        problems.push('capabilities override requires requiredStoryCapabilities');
      } else {
        const missingBaseline = capabilities.filter((capability) => !override.requiredStoryCapabilities!.includes(capability));
        if (missingBaseline.length > 0) problems.push(`capabilities override cannot remove required capabilities: ${missingBaseline.join(', ')}`);
      }
    } else if (override.requiredStoryCapabilities) {
      problems.push('requiredStoryCapabilities requires the capabilities override kind');
    }

    if (problems.length > 0) {
      diagnostics.push(diagnostic({
        code: 'INVALID_OVERRIDE',
        severity: 'blocker',
        path: `overrides.${override.overrideId}`,
        message: `Human override ${override.overrideId} failed policy validation: ${problems.join('; ')}.`,
        references: [override.overrideId, override.actor.identity, override.policyReference],
        amendment: 'Have an identified human submit a complete override allowed by the current workspace policy.',
      }));
      continue;
    }

    if (override.boundaryCandidates) boundaries = override.boundaryCandidates;
    if (override.requiredStoryCapabilities) capabilities = sortCapabilities(override.requiredStoryCapabilities);
    override.kinds.forEach((kind) => appliedKinds.add(kind));
    acceptedOverrides.push({
      overrideId: override.overrideId,
      kinds: [...override.kinds].sort(),
      actorIdentity: override.actor.identity,
      rationale: override.rationale,
      policyReference: override.policyReference,
      validatedBy: 'rorca-authoring-policy',
      grantsDownstreamApproval: false,
    });
  }

  return { boundaries, capabilities, acceptedOverrides };
}

function findBoundaryCycle(boundaries: AuthoringBoundaryCandidate[]): string[] | null {
  const byKey = new Map(boundaries.map((boundary) => [boundary.boundaryKey, boundary]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    if (active.has(key)) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    if (visited.has(key)) return null;
    visited.add(key);
    active.add(key);
    stack.push(key);
    const boundary = byKey.get(key);
    for (const dependency of [...(boundary?.dependencies ?? [])]
      .sort((left, right) => left.onBoundaryKey.localeCompare(right.onBoundaryKey))) {
      if (!byKey.has(dependency.onBoundaryKey)) continue;
      const cycle = visit(dependency.onBoundaryKey);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(key);
    return null;
  };

  for (const key of [...byKey.keys()].sort()) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}

function validateBoundaries(
  input: AuthoringPlannerInput,
  boundaries: AuthoringBoundaryCandidate[],
  diagnostics: AuthoringDiagnostic[],
): void {
  if (boundaries.length === 0) return;
  if (boundaries.length > input.workspacePolicy.maximumSpecs) {
    diagnostics.push(diagnostic({
      code: 'EXCESSIVE_SPLITTING',
      severity: 'blocker',
      path: 'boundaryCandidates',
      message: `Proposed count ${boundaries.length} exceeds workspace maximum ${input.workspacePolicy.maximumSpecs}.`,
      references: boundaries.map((boundary) => boundary.boundaryKey),
      amendment: 'Keep coordinated outcomes together or submit a governed policy override without exceeding the hard 12-spec limit.',
    }));
  }

  const requirements = new Set(input.intent.requirements.map((requirement) => requirement.reference));
  const ownership = new Map<string, string[]>();
  const boundaryByKey = new Map<string, AuthoringBoundaryCandidate>();
  for (const boundary of boundaries) {
    if (boundaryByKey.has(boundary.boundaryKey)) {
      diagnostics.push(diagnostic({
        code: 'OVERLAPPING_BOUNDARY',
        severity: 'blocker',
        path: `boundaryCandidates.${boundary.boundaryKey}`,
        message: `Boundary key ${boundary.boundaryKey} is duplicated.`,
        references: [boundary.boundaryKey],
        amendment: 'Use one unique stable boundary key for each independently justified outcome.',
      }));
    }
    boundaryByKey.set(boundary.boundaryKey, boundary);
    if (boundaries.length > 1 && boundary.coordination !== 'independently_deliverable') {
      diagnostics.push(diagnostic({
        code: 'BOUNDARY_NOT_INDEPENDENT',
        severity: 'blocker',
        path: `boundaryCandidates.${boundary.boundaryKey}.coordination`,
        message: `Boundary ${boundary.boundaryKey} requires coordinated changes and must remain in one spec.`,
        references: [boundary.boundaryKey, ...boundary.ownsRequirementReferences],
        amendment: 'Combine coordinated work into one boundary or supply validated independent delivery facts.',
      }));
    }
    const acceptedSignals = boundary.signals.filter((signal) => input.workspacePolicy.allowedBoundarySignals.includes(signal.kind));
    if (boundaries.length > 1 && acceptedSignals.length === 0) {
      diagnostics.push(diagnostic({
        code: 'CONTRADICTORY_BOUNDARY',
        severity: 'blocker',
        path: `boundaryCandidates.${boundary.boundaryKey}.signals`,
        message: `Boundary ${boundary.boundaryKey} has no split signal accepted by workspace policy.`,
        references: [boundary.boundaryKey, ...boundary.signals.map((signal) => signal.kind)],
        amendment: 'Keep the work in one spec or cite an allowed independent acceptance/release/rollback, ownership, security, data, or risk-policy boundary.',
      }));
    }
    for (const reference of boundary.ownsRequirementReferences) {
      if (!requirements.has(reference)) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_REQUIREMENT_REFERENCE',
          severity: 'blocker',
          path: `boundaryCandidates.${boundary.boundaryKey}.ownsRequirementReferences`,
          message: `Boundary ${boundary.boundaryKey} owns unknown requirement ${reference}.`,
          references: [boundary.boundaryKey, reference],
          amendment: 'Use a stable reference from the normalized requirement registry.',
        }));
      }
      ownership.set(reference, [...(ownership.get(reference) ?? []), boundary.boundaryKey]);
    }
    for (const reference of boundary.referencesRequirementReferences) {
      if (!requirements.has(reference)) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_REQUIREMENT_REFERENCE',
          severity: 'blocker',
          path: `boundaryCandidates.${boundary.boundaryKey}.referencesRequirementReferences`,
          message: `Boundary ${boundary.boundaryKey} references unknown requirement ${reference}.`,
          references: [boundary.boundaryKey, reference],
          amendment: 'Use a stable reference from the normalized requirement registry.',
        }));
      }
      if (boundary.ownsRequirementReferences.includes(reference)) {
        diagnostics.push(diagnostic({
          code: 'DUPLICATE_REQUIREMENT_OWNER',
          severity: 'blocker',
          path: `boundaryCandidates.${boundary.boundaryKey}.referencesRequirementReferences`,
          message: `Boundary ${boundary.boundaryKey} both owns and imports requirement ${reference}.`,
          references: [boundary.boundaryKey, reference],
          amendment: 'Keep one owning declaration and remove the redundant dependent reference.',
        }));
      }
    }
  }

  for (const requirement of input.intent.requirements) {
    const owners = ownership.get(requirement.reference) ?? [];
    if (owners.length === 0) {
      diagnostics.push(diagnostic({
        code: 'ORPHAN_REQUIREMENT',
        severity: 'blocker',
        path: 'boundaryCandidates',
        message: `Requirement ${requirement.reference} has no owning spec boundary.`,
        references: [requirement.reference],
        amendment: 'Assign the requirement to exactly one submitted boundary and resubmit.',
      }));
    } else if (owners.length > 1) {
      diagnostics.push(diagnostic({
        code: 'DUPLICATE_REQUIREMENT_OWNER',
        severity: 'blocker',
        path: 'boundaryCandidates',
        message: `Requirement ${requirement.reference} is owned by multiple boundaries: ${owners.sort().join(', ')}.`,
        references: [requirement.reference, ...owners],
        amendment: 'Choose exactly one owning boundary; dependent boundaries may reference it through a justified DAG edge.',
      }));
    }
  }

  for (const boundary of boundaries) {
    for (const dependency of boundary.dependencies) {
      const prerequisite = boundaryByKey.get(dependency.onBoundaryKey);
      if (!prerequisite) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_DEPENDENCY',
          severity: 'blocker',
          path: `boundaryCandidates.${boundary.boundaryKey}.dependencies`,
          message: `Boundary ${boundary.boundaryKey} depends on unknown boundary ${dependency.onBoundaryKey}.`,
          references: [boundary.boundaryKey, dependency.onBoundaryKey],
          amendment: 'Reference an existing prerequisite boundary and state the directional contract/evidence handoff.',
        }));
        continue;
      }
      if (prerequisite.boundaryKey === boundary.boundaryKey) {
        diagnostics.push(diagnostic({
          code: 'IMPOSSIBLE_SEQUENCE',
          severity: 'blocker',
          path: `boundaryCandidates.${boundary.boundaryKey}.dependencies`,
          message: `Boundary ${boundary.boundaryKey} cannot depend on itself.`,
          references: [boundary.boundaryKey],
          amendment: 'Remove the self-edge and express only prerequisite-to-dependent sequencing.',
        }));
      }
      for (const requirementReference of dependency.sharedContractRequirementReferences) {
        if (!prerequisite.ownsRequirementReferences.includes(requirementReference)) {
          diagnostics.push(diagnostic({
            code: 'IMPOSSIBLE_SEQUENCE',
            severity: 'blocker',
            path: `boundaryCandidates.${boundary.boundaryKey}.dependencies`,
            message: `Dependency ${boundary.boundaryKey} -> ${prerequisite.boundaryKey} cites ${requirementReference}, but the prerequisite does not own it.`,
            references: [boundary.boundaryKey, prerequisite.boundaryKey, requirementReference],
            amendment: 'Point the edge to the contract-owning prerequisite or correct requirement ownership.',
          }));
        }
        if (!boundary.referencesRequirementReferences.includes(requirementReference)) {
          diagnostics.push(diagnostic({
            code: 'OVERLAPPING_BOUNDARY',
            severity: 'blocker',
            path: `boundaryCandidates.${boundary.boundaryKey}.referencesRequirementReferences`,
            message: `Dependent boundary ${boundary.boundaryKey} does not expose imported contract ${requirementReference}.`,
            references: [boundary.boundaryKey, prerequisite.boundaryKey, requirementReference],
            amendment: 'Declare the prerequisite-owned requirement as a dependent reference without duplicating ownership.',
          }));
        }
      }
    }

    for (const referencedRequirement of boundary.referencesRequirementReferences) {
      const ownerKey = (ownership.get(referencedRequirement) ?? [])[0];
      const matchingDependency = boundary.dependencies.some((edge) => (
        edge.onBoundaryKey === ownerKey && edge.sharedContractRequirementReferences.includes(referencedRequirement)
      ));
      if (ownerKey && !matchingDependency) {
        diagnostics.push(diagnostic({
          code: 'OVERLAPPING_BOUNDARY',
          severity: 'blocker',
          path: `boundaryCandidates.${boundary.boundaryKey}.referencesRequirementReferences`,
          message: `Boundary ${boundary.boundaryKey} imports ${referencedRequirement} from ${ownerKey} without a justified dependency edge.`,
          references: [boundary.boundaryKey, ownerKey, referencedRequirement],
          amendment: 'Add a directional dependency with shared contract and integration evidence, or remove the boundary crossing.',
        }));
      }
    }
  }

  const cycle = findBoundaryCycle(boundaries);
  if (cycle) {
    diagnostics.push(diagnostic({
      code: 'CROSS_SPEC_CYCLE',
      severity: 'blocker',
      path: 'boundaryCandidates.dependencies',
      message: `Cross-spec dependency cycle detected: ${cycle.join(' -> ')}.`,
      references: cycle,
      amendment: 'Remove or reverse an edge so shared contracts flow from one prerequisite to dependents in an acyclic order.',
    }));
  }
}

function defaultBoundary(input: AuthoringPlannerInput, capabilities: StoryCapability[]): AuthoringPlan['specBoundaries'][number] {
  const key = slugSeed(input.intent.outcome);
  return {
    specReference: specReference(input.intent.normalizedIntentHash, key),
    slugSeed: key,
    outcome: input.intent.outcome,
    inScope: input.intent.requirements.map((requirement) => requirement.text),
    outOfScope: ['Work not represented by the normalized requirement registry.'],
    ownerHints: [],
    riskHints: [],
    ownedRequirementReferences: input.intent.requirements.map((requirement) => requirement.reference).sort(),
    referencedRequirementReferences: [],
    dependencySpecReferences: [],
    requiredStoryCapabilities: capabilities,
    releaseRollbackBoundary: {
      release: 'Release the normalized outcome as one coordinated unit.',
      rollback: 'Roll back the normalized outcome as one coordinated unit.',
      independentlyReleasable: false,
      independentlyRollbackable: false,
    },
    boundaryDecision: {
      decision: 'keep_together',
      validatedSignals: [],
      rationale: 'One spec is the conservative default; no independently validated split boundary was supplied.',
    },
  };
}

function buildBoundaries(
  input: AuthoringPlannerInput,
  candidates: AuthoringBoundaryCandidate[],
  capabilities: StoryCapability[],
): { specBoundaries: AuthoringPlan['specBoundaries']; crossSpecDependencies: AuthoringPlan['crossSpecDependencies'] } {
  if (candidates.length === 0) {
    return { specBoundaries: [defaultBoundary(input, capabilities)], crossSpecDependencies: [] };
  }
  const referenceByKey = new Map(candidates.map((candidate) => [
    candidate.boundaryKey,
    specReference(input.intent.normalizedIntentHash, candidate.boundaryKey),
  ]));
  const split = candidates.length > 1;
  const specBoundaries = [...candidates]
    .sort((left, right) => left.boundaryKey.localeCompare(right.boundaryKey))
    .map((candidate) => ({
      specReference: referenceByKey.get(candidate.boundaryKey)!,
      slugSeed: candidate.boundaryKey,
      outcome: candidate.outcome,
      inScope: [...candidate.inScope],
      outOfScope: [...candidate.outOfScope],
      ownerHints: [...candidate.ownerHints].sort(),
      riskHints: [...candidate.riskHints].sort(),
      ownedRequirementReferences: [...candidate.ownsRequirementReferences].sort(),
      referencedRequirementReferences: [...candidate.referencesRequirementReferences].sort(),
      dependencySpecReferences: candidate.dependencies
        .map((dependency) => referenceByKey.get(dependency.onBoundaryKey)!)
        .sort(),
      requiredStoryCapabilities: capabilities,
      releaseRollbackBoundary: {
        release: candidate.releaseBoundary,
        rollback: candidate.rollbackBoundary,
        independentlyReleasable: split && candidate.coordination === 'independently_deliverable',
        independentlyRollbackable: split && candidate.signals.some((signal) => signal.kind === 'independent_rollback'),
      },
      boundaryDecision: {
        decision: split ? 'split' as const : 'keep_together' as const,
        validatedSignals: [...new Set(candidate.signals
          .filter((signal) => input.workspacePolicy.allowedBoundarySignals.includes(signal.kind))
          .map((signal) => signal.kind))].sort(),
        rationale: candidate.splitRationale,
      },
    }));
  const crossSpecDependencies = candidates.flatMap((candidate) => candidate.dependencies.map((dependency) => ({
    dependentSpecReference: referenceByKey.get(candidate.boundaryKey)!,
    prerequisiteSpecReference: referenceByKey.get(dependency.onBoundaryKey)!,
    rationale: dependency.rationale,
    sharedContractRequirementReferences: [...dependency.sharedContractRequirementReferences].sort(),
    integrationEvidenceExpectation: dependency.integrationEvidenceExpectation,
  }))).sort((left, right) => (
    `${left.dependentSpecReference}:${left.prerequisiteSpecReference}`
      .localeCompare(`${right.dependentSpecReference}:${right.prerequisiteSpecReference}`)
  ));
  return { specBoundaries, crossSpecDependencies };
}

/**
 * Build an accepted plan only after deterministic contract, policy, coverage,
 * and DAG validation. Blocked proposals never receive an authoritative hash.
 */
export function planAuthoring(inputCandidate: AuthoringPlannerInputCandidate): AuthoringPlanningResult {
  const parsed = AuthoringPlannerInputSchema.safeParse(inputCandidate);
  if (!parsed.success) {
    const diagnostics = sortDiagnostics(zodDiagnostics(parsed.error, 'input'));
    return { acceptedPlan: null, diagnostics };
  }
  const input = parsed.data;
  const diagnostics: AuthoringDiagnostic[] = [];

  if (input.plannerVersion !== SSDLC_AUTHORING_PLANNER_VERSION) {
    diagnostics.push(diagnostic({
      code: 'PLANNER_VERSION_MISMATCH',
      severity: 'blocker',
      path: 'plannerVersion',
      message: `Planner version ${input.plannerVersion} is unsupported; expected ${SSDLC_AUTHORING_PLANNER_VERSION}.`,
      references: [input.plannerVersion, SSDLC_AUTHORING_PLANNER_VERSION],
      amendment: 'Refresh authoring context and resubmit against the current planner version.',
    }));
  }
  const expectedIntentHash = deriveNormalizedIntentHash({
    outcome: input.intent.outcome,
    normalizedBrief: input.intent.normalizedBrief,
    requirements: input.intent.requirements,
    ambiguities: input.intent.ambiguities,
  });
  if (expectedIntentHash !== input.intent.normalizedIntentHash) {
    diagnostics.push(diagnostic({
      code: 'INTENT_HASH_MISMATCH',
      severity: 'blocker',
      path: 'intent.normalizedIntentHash',
      message: `Normalized intent hash does not match the submitted brief and requirement registry (${expectedIntentHash}).`,
      references: [input.intent.normalizedIntentHash, expectedIntentHash],
      amendment: 'Re-normalize the material brief and requirement registry before resubmitting decomposition.',
    }));
  }
  detectRequirementProblems(input, diagnostics);
  const overrideResult = validateOverrides(input, diagnostics);
  validateBoundaries(input, overrideResult.boundaries, diagnostics);

  if (overrideResult.boundaries.length === 0) {
    diagnostics.push(diagnostic({
      code: 'RECOMMENDED_SINGLE_SPEC',
      severity: 'info',
      path: 'boundaryCandidates',
      message: 'No independently validated split boundary was supplied; the authoritative recommendation is one spec.',
      references: input.intent.requirements.map((requirement) => requirement.reference),
    }));
  }
  for (const [index, ambiguity] of input.intent.ambiguities.entries()) {
    diagnostics.push(diagnostic({
      code: 'AMBIGUOUS_DECOMPOSITION',
      severity: 'question',
      path: `intent.ambiguities.${index}`,
      message: `Bounded authoring question: ${ambiguity}`,
      references: input.intent.requirements.map((requirement) => requirement.reference),
      amendment: 'Clarify this material input and resubmit if it should change boundaries; required lifecycle coverage remains intact meanwhile.',
    }));
  }

  const sortedDiagnostics = sortDiagnostics(diagnostics);
  if (sortedDiagnostics.some((item) => item.severity === 'blocker')) {
    return { acceptedPlan: null, diagnostics: sortedDiagnostics };
  }

  const { specBoundaries, crossSpecDependencies } = buildBoundaries(
    input,
    overrideResult.boundaries,
    overrideResult.capabilities,
  );
  const withoutHash: Omit<AuthoringPlan, 'acceptedPlanHash'> = {
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    validationStatus: 'accepted',
    workspaceId: input.workspaceId,
    normalizedIntentHash: input.intent.normalizedIntentHash,
    sourceContextIdentity: input.sourceContext,
    workspacePolicyVersion: input.workspacePolicy.version,
    plannerVersion: input.plannerVersion,
    recommendedSpecCount: specBoundaries.length,
    requirements: input.intent.requirements,
    specBoundaries,
    crossSpecDependencies,
    requiredStoryCapabilities: overrideResult.capabilities,
    lifecycleProfile: lifecycleProfile(input.lifecycleProfile, overrideResult.capabilities),
    storyQualityPolicy: {
      ...input.workspacePolicy.storyQuality,
      requireOutcomeTitle: true,
      requireObservableCriteria: true,
      prohibitHiddenCrossSpecWork: true,
    },
    diagnostics: sortedDiagnostics,
    acceptedOverrides: overrideResult.acceptedOverrides,
    provenance: {
      ...input.provenance,
      plannerVersion: input.plannerVersion,
      sourceContextIdentity: input.sourceContext,
      reusedExistingDurableSurfaces: true,
    },
  };
  const acceptedPlan = AuthoringPlanSchema.parse({
    ...withoutHash,
    acceptedPlanHash: deriveAcceptedAuthoringPlanHash(withoutHash),
  });
  return { acceptedPlan, diagnostics: acceptedPlan.diagnostics };
}

function planGateIds(plan: AuthoringPlan): Set<string> {
  return new Set(plan.lifecycleProfile.phaseContributions.flatMap((phase) => phase.gateIds));
}

function findStoryCycle(stories: Array<{ id: string; dependsOn: string[] }>): string[] | null {
  const ids = new Set(stories.map((story) => story.id));
  const byId = new Map(stories.map((story) => [story.id, story]));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (active.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const dependency of [...(byId.get(id)?.dependsOn ?? [])].sort()) {
      if (!ids.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(id);
    return null;
  };
  for (const id of [...ids].sort()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function amendmentCandidates(diagnostics: AuthoringDiagnostic[]): AuthoringPreflightResult['amendments'] {
  return diagnostics.filter((item) => item.severity !== 'info').map((item) => ({
    amendmentId: `AMEND-${hash({ code: item.code, path: item.path, references: item.references })
      .slice('sha256:'.length, 'sha256:'.length + 16).toUpperCase()}`,
    targetReference: item.references.find((reference) => STABLE_REFERENCE.test(reference)) ?? 'authoring-draft',
    reasonCode: item.code,
    instruction: item.amendment ?? item.message,
    requiresCallerResubmission: true as const,
  }));
}

function emptyCoverageMatrix(): AuthoringPreflightResult['coverageMatrix'] {
  return { requirements: [], capabilities: [], phaseGates: [] };
}

/**
 * Stable identity for an accepted plan plus the complete caller-authored draft
 * set. Cosmetic whitespace/case and list ordering do not stale preflight, while
 * semantic story, requirement, dependency, capability, phase, gate, boundary,
 * risk, or evidence changes do.
 */
export function deriveAuthoringPreflightHash(
  input: Pick<AuthoringPreflightInput, 'acceptedPlan' | 'planHash' | 'specs'>,
): `sha256:${string}` {
  const normalizeList = (values: string[]): string[] => values.map(normalizedProse).sort();
  const specs = input.specs.map((spec) => ({
    specReference: spec.specReference,
    stories: spec.stories.map((story) => ({
      id: story.id,
      title: normalizedProse(story.title).toLocaleLowerCase('en-US'),
      description: normalizedProse(story.description).toLocaleLowerCase('en-US'),
      requirementReferences: [...story.requirementReferences].sort(),
      dependsOn: [...story.dependsOn].sort(),
      capabilities: sortCapabilities(story.capabilities),
      expectedContributions: {
        phaseIds: [...story.expectedContributions.phaseIds].sort(),
        gateIds: [...story.expectedContributions.gateIds].sort(),
      },
      acceptanceCriteria: story.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        text: normalizeAcceptanceCriterionText(criterion.text),
        observableOutcome: normalizeAcceptanceCriterionText(criterion.observableOutcome),
        requirementReferences: [...criterion.requirementReferences].sort(),
        evidenceExpectationIds: [...criterion.evidenceExpectationIds].sort(),
      })).sort((left, right) => (
        `${left.text}:${left.criterionId}`.localeCompare(`${right.text}:${right.criterionId}`)
      )),
      evidenceExpectations: story.evidenceExpectations.map((expectation) => ({
        expectationId: expectation.expectationId,
        kind: expectation.kind,
        description: normalizeAcceptanceCriterionText(expectation.description),
        observable: expectation.observable,
      })).sort((left, right) => left.expectationId.localeCompare(right.expectationId)),
      negativeCoverage: normalizeList(story.negativeCoverage),
      recoveryCoverage: normalizeList(story.recoveryCoverage),
      crossSpecReferences: [...story.crossSpecReferences].sort(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  })).sort((left, right) => left.specReference.localeCompare(right.specReference));

  return hash({
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    planHash: input.planHash,
    normalizedIntentHash: input.acceptedPlan.normalizedIntentHash,
    specs,
  });
}

/**
 * Validate caller-authored story prose against a fixed accepted plan. This
 * function returns diagnostics, amendment candidates, and coverage only. It
 * never rewrites, adds, deletes, splits, merges, or persists caller content.
 */
export function preflightAuthoringDraft(inputCandidate: AuthoringPreflightInputCandidate): AuthoringPreflightResult {
  const parsed = AuthoringPreflightInputSchema.safeParse(inputCandidate);
  if (!parsed.success) {
    const diagnostics = sortDiagnostics(zodDiagnostics(parsed.error, 'preflight'));
    return AuthoringPreflightResultSchema.parse({
      schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
      accepted: false,
      planHash: typeof inputCandidate?.planHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(inputCandidate.planHash)
        ? inputCandidate.planHash
        : `sha256:${'0'.repeat(64)}`,
      acceptedPreflightHash: null,
      diagnostics,
      amendments: amendmentCandidates(diagnostics),
      coverageMatrix: emptyCoverageMatrix(),
      draftMutationCount: 0,
      authoritativePersistenceAllowed: false,
    });
  }

  const input = parsed.data;
  const plan = input.acceptedPlan;
  const diagnostics: AuthoringDiagnostic[] = [];
  const expectedHash = deriveAcceptedAuthoringPlanHash((({ acceptedPlanHash: _hash, ...rest }) => rest)(plan));
  if (input.planHash !== plan.acceptedPlanHash || !verifyAcceptedAuthoringPlanHash(plan)) {
    diagnostics.push(diagnostic({
      code: 'PLAN_HASH_MISMATCH',
      severity: 'blocker',
      path: 'planHash',
      message: `Draft plan hash does not identify the validated authoritative plan (expected ${expectedHash}).`,
      references: [input.planHash, plan.acceptedPlanHash, expectedHash],
      amendment: 'Refresh the accepted authoring plan and resubmit the draft against its exact hash.',
    }));
  }

  const boundaryByRef = new Map(plan.specBoundaries.map((boundary) => [boundary.specReference, boundary]));
  const draftByRef = new Map<string, (typeof input.specs)[number]>();
  for (const spec of input.specs) {
    if (draftByRef.has(spec.specReference)) {
      diagnostics.push(diagnostic({
        code: 'UNKNOWN_SPEC_REFERENCE',
        severity: 'blocker',
        path: `specs.${spec.specReference}`,
        message: `Spec draft ${spec.specReference} is submitted more than once.`,
        references: [spec.specReference],
        amendment: 'Submit exactly one draft for each authoritative spec boundary.',
      }));
    }
    draftByRef.set(spec.specReference, spec);
    if (!boundaryByRef.has(spec.specReference)) {
      diagnostics.push(diagnostic({
        code: 'UNKNOWN_SPEC_REFERENCE',
        severity: 'blocker',
        path: `specs.${spec.specReference}`,
        message: `Draft targets unknown spec boundary ${spec.specReference}.`,
        references: [spec.specReference],
        amendment: 'Use the exact spec references from the accepted plan; preflight will not add a boundary.',
      }));
    }
  }
  for (const boundary of plan.specBoundaries) {
    if (!draftByRef.has(boundary.specReference)) {
      diagnostics.push(diagnostic({
        code: 'UNKNOWN_SPEC_REFERENCE',
        severity: 'blocker',
        path: 'specs',
        message: `Accepted boundary ${boundary.specReference} has no submitted spec draft.`,
        references: [boundary.specReference],
        amendment: 'Author and submit the missing spec without changing accepted boundaries.',
      }));
    }
  }
  if (input.specs.length !== plan.recommendedSpecCount) {
    diagnostics.push(diagnostic({
      code: 'UNKNOWN_SPEC_REFERENCE',
      severity: 'blocker',
      path: 'specs',
      message: `Submitted spec count ${input.specs.length} does not match authoritative count ${plan.recommendedSpecCount}.`,
      references: plan.specBoundaries.map((boundary) => boundary.specReference),
      amendment: 'Submit exactly one draft per accepted boundary; request a governed authoring override to change count.',
    }));
  }

  const allStories = input.specs.flatMap((spec) => spec.stories.map((story) => ({ specReference: spec.specReference, story })));
  const storyLocations = new Map<string, string[]>();
  for (const { specReference: location, story } of allStories) {
    storyLocations.set(story.id, [...(storyLocations.get(story.id) ?? []), location]);
  }
  for (const [storyId, locations] of storyLocations) {
    if (locations.length > 1) {
      diagnostics.push(diagnostic({
        code: 'DUPLICATE_STORY_ID',
        severity: 'blocker',
        path: 'specs.stories',
        message: `Story ID ${storyId} appears in multiple locations: ${locations.sort().join(', ')}.`,
        references: [storyId, ...locations],
        amendment: 'Assign a globally stable unique story ID and update dependency references explicitly.',
      }));
    }
  }

  const knownRequirementRefs = new Set(plan.requirements.map((requirement) => requirement.reference));
  const knownPhaseIds = new Set<string>(CANONICAL_PHASE_IDS);
  const knownGateIds = planGateIds(plan);
  const edgeSet = new Set(plan.crossSpecDependencies.map((edge) => (
    `${edge.dependentSpecReference}->${edge.prerequisiteSpecReference}`
  )));

  for (const { specReference: location, story } of allStories) {
    const boundary = boundaryByRef.get(location);
    const storyPath = `specs.${location}.stories.${story.id}`;
    const uniqueRequirements = new Set(story.requirementReferences);
    const uniqueCapabilities = new Set(story.capabilities);
    if (uniqueRequirements.size > plan.storyQualityPolicy.maximumRequirementsPerStory
      || story.acceptanceCriteria.length > plan.storyQualityPolicy.maximumAcceptanceCriteriaPerStory
      || uniqueCapabilities.size > plan.storyQualityPolicy.maximumCapabilitiesPerStory
      || story.description.length > 2000
      || UMBRELLA_LANGUAGE.test(`${story.title} ${story.description}`)) {
      diagnostics.push(diagnostic({
        code: 'GIANT_UMBRELLA_STORY',
        severity: 'blocker',
        path: storyPath,
        message: `Story ${story.id} exceeds a bounded story-quality limit or claims an umbrella outcome.`,
        references: [location, story.id, ...story.requirementReferences],
        amendment: 'Propose smaller outcome-verifiable stories without changing authoritative spec boundaries.',
      }));
    }
    if (VAGUE_LANGUAGE.test(`${story.title} ${story.description}`)) {
      diagnostics.push(diagnostic({
        code: 'VAGUE_WORDING',
        severity: 'blocker',
        path: `${storyPath}.description`,
        message: `Story ${story.id} uses vague or non-verifiable wording.`,
        references: [story.id],
        amendment: 'State a bounded user/operator/system outcome with observable conditions.',
      }));
    }
    if (IMPLEMENTATION_TASK_TITLE.test(story.title)
      && !OUTCOME_LANGUAGE.test(`${story.title} ${story.description} ${story.acceptanceCriteria.map((criterion) => criterion.observableOutcome).join(' ')}`)) {
      diagnostics.push(diagnostic({
        code: 'IMPLEMENTATION_ONLY_STORY',
        severity: 'blocker',
        path: `${storyPath}.title`,
        message: `Story ${story.id} is framed as an implementation task list without an outcome.`,
        references: [story.id],
        amendment: 'Rewrite the title and description around the observable outcome; retain implementation details only as context.',
      }));
    }

    const expectationIds = new Set(story.evidenceExpectations.map((expectation) => expectation.expectationId));
    const criterionTexts = new Map<string, string>();
    for (const criterion of story.acceptanceCriteria) {
      const criterionPath = `${storyPath}.acceptanceCriteria.${criterion.criterionId}`;
      const normalized = normalizeAcceptanceCriterionText(criterion.text);
      const priorCriterion = criterionTexts.get(normalized);
      if (priorCriterion) {
        diagnostics.push(diagnostic({
          code: 'DUPLICATE_ACCEPTANCE_CRITERION',
          severity: 'blocker',
          path: criterionPath,
          message: `Criteria ${priorCriterion} and ${criterion.criterionId} are duplicates after normalization.`,
          references: [story.id, priorCriterion, criterion.criterionId],
          amendment: 'Remove the duplicate criterion or make each criterion prove a distinct observable outcome.',
        }));
      }
      criterionTexts.set(normalized, criterion.criterionId);
      if (VAGUE_LANGUAGE.test(`${criterion.text} ${criterion.observableOutcome}`)) {
        diagnostics.push(diagnostic({
          code: 'VAGUE_WORDING',
          severity: 'blocker',
          path: criterionPath,
          message: `Criterion ${criterion.criterionId} uses vague verification language.`,
          references: [story.id, criterion.criterionId],
          amendment: 'Replace subjective language with a condition and observable expected result.',
        }));
      }
      if (!TESTABLE_LANGUAGE.test(`${criterion.text} ${criterion.observableOutcome}`)) {
        diagnostics.push(diagnostic({
          code: 'NON_OBSERVABLE_CRITERION',
          severity: 'blocker',
          path: criterionPath,
          message: `Criterion ${criterion.criterionId} does not state an observable result.`,
          references: [story.id, criterion.criterionId],
          amendment: 'State what a test, review, command, user, or operator can observe and compare.',
        }));
      }
      for (const evidenceId of criterion.evidenceExpectationIds) {
        if (!expectationIds.has(evidenceId)) {
          diagnostics.push(diagnostic({
            code: 'MISSING_EVIDENCE_EXPECTATION',
            severity: 'blocker',
            path: `${criterionPath}.evidenceExpectationIds`,
            message: `Criterion ${criterion.criterionId} references unknown evidence expectation ${evidenceId}.`,
            references: [story.id, criterion.criterionId, evidenceId],
            amendment: 'Declare an observable evidence expectation and reference its stable ID.',
          }));
        }
      }
      for (const requirementReference of criterion.requirementReferences) {
        if (!story.requirementReferences.includes(requirementReference)) {
          diagnostics.push(diagnostic({
            code: 'UNKNOWN_REQUIREMENT_REFERENCE',
            severity: 'blocker',
            path: `${criterionPath}.requirementReferences`,
            message: `Criterion ${criterion.criterionId} references ${requirementReference}, which is absent from story ${story.id}.`,
            references: [story.id, criterion.criterionId, requirementReference],
            amendment: 'Align criterion and story requirement references without inventing requirements.',
          }));
        }
      }
    }

    for (const requirementReference of story.requirementReferences) {
      if (!knownRequirementRefs.has(requirementReference)) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_REQUIREMENT_REFERENCE',
          severity: 'blocker',
          path: `${storyPath}.requirementReferences`,
          message: `Story ${story.id} references unknown requirement ${requirementReference}.`,
          references: [location, story.id, requirementReference],
          amendment: 'Reference only requirements from the accepted registry; revise and resubmit to add material intent.',
        }));
        continue;
      }
      if (boundary && !boundary.ownedRequirementReferences.includes(requirementReference)
        && !boundary.referencedRequirementReferences.includes(requirementReference)) {
        diagnostics.push(diagnostic({
          code: 'HIDDEN_CROSS_SPEC_WORK',
          severity: 'blocker',
          path: `${storyPath}.requirementReferences`,
          message: `Story ${story.id} pulls requirement ${requirementReference} across accepted boundary ${location}.`,
          references: [location, story.id, requirementReference],
          amendment: 'Move the story to the owning spec or request an explicit dependency/boundary amendment.',
        }));
      }
    }
    for (const phaseId of story.expectedContributions.phaseIds) {
      if (!knownPhaseIds.has(phaseId)) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_PHASE_CONTRIBUTION',
          severity: 'blocker',
          path: `${storyPath}.expectedContributions.phaseIds`,
          message: `Story ${story.id} names unknown lifecycle phase ${phaseId}.`,
          references: [story.id, phaseId],
          amendment: 'Use the fixed canonical phase contribution identifiers from the accepted authoring profile.',
        }));
      }
    }
    for (const gateId of story.expectedContributions.gateIds) {
      if (!knownGateIds.has(gateId)) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_GATE_CONTRIBUTION',
          severity: 'blocker',
          path: `${storyPath}.expectedContributions.gateIds`,
          message: `Story ${story.id} names unknown lifecycle gate ${gateId}.`,
          references: [story.id, gateId],
          amendment: 'Use declared gate contribution identifiers; authoring cannot invent or waive lifecycle gates.',
        }));
      }
    }
    if (story.capabilities.some((capability) => capability === 'security' || capability === 'migration')
      && story.negativeCoverage.length === 0) {
      diagnostics.push(diagnostic({
        code: 'MISSING_NEGATIVE_COVERAGE',
        severity: 'blocker',
        path: `${storyPath}.negativeCoverage`,
        message: `Story ${story.id} needs explicit negative coverage for its security or migration capability.`,
        references: [story.id, ...story.capabilities],
        amendment: 'Add bounded failure/denial/integrity scenarios and their evidence expectations.',
      }));
    }
    if (story.capabilities.includes('recovery') && story.recoveryCoverage.length === 0) {
      diagnostics.push(diagnostic({
        code: 'MISSING_RECOVERY_COVERAGE',
        severity: 'blocker',
        path: `${storyPath}.recoveryCoverage`,
        message: `Story ${story.id} needs explicit recovery coverage.`,
        references: [story.id, 'recovery'],
        amendment: 'Declare rollback, retry, restore, or safe-degradation behavior with observable evidence.',
      }));
    }

    for (const dependencyId of story.dependsOn) {
      const dependencyLocations = storyLocations.get(dependencyId) ?? [];
      if (dependencyLocations.length === 0) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_DEPENDENCY',
          severity: 'blocker',
          path: `${storyPath}.dependsOn`,
          message: `Story ${story.id} depends on unknown story ${dependencyId}.`,
          references: [story.id, dependencyId],
          amendment: 'Reference an existing stable story ID and preserve an acyclic dependency graph.',
        }));
        continue;
      }
      for (const dependencyLocation of dependencyLocations) {
        if (dependencyLocation !== location
          && (!story.crossSpecReferences.includes(dependencyLocation)
            || !edgeSet.has(`${location}->${dependencyLocation}`))) {
          diagnostics.push(diagnostic({
            code: 'HIDDEN_CROSS_SPEC_WORK',
            severity: 'blocker',
            path: `${storyPath}.dependsOn`,
            message: `Story ${story.id} depends on ${dependencyId} in ${dependencyLocation} without the accepted cross-spec edge.`,
            references: [location, story.id, dependencyLocation, dependencyId],
            amendment: 'Align the story dependency with the accepted shared-contract DAG or request a boundary amendment.',
          }));
        }
      }
    }
    for (const crossSpecReference of story.crossSpecReferences) {
      if (!boundaryByRef.has(crossSpecReference)) {
        diagnostics.push(diagnostic({
          code: 'UNKNOWN_SPEC_REFERENCE',
          severity: 'blocker',
          path: `${storyPath}.crossSpecReferences`,
          message: `Story ${story.id} names unknown cross-spec boundary ${crossSpecReference}.`,
          references: [story.id, crossSpecReference],
          amendment: 'Use only an accepted dependency boundary reference.',
        }));
      }
    }
  }

  const cycle = findStoryCycle(allStories.map(({ story }) => story));
  if (cycle) {
    diagnostics.push(diagnostic({
      code: 'STORY_DEPENDENCY_CYCLE',
      severity: 'blocker',
      path: 'specs.stories.dependsOn',
      message: `Story dependency cycle detected: ${cycle.join(' -> ')}.`,
      references: cycle,
      amendment: 'Remove or reverse an edge to preserve an acyclic, deliverable story DAG.',
    }));
  }

  const requirementCoverage: AuthoringPreflightResult['coverageMatrix']['requirements'] = plan.requirements.map((requirement) => {
    const owners = plan.specBoundaries
      .filter((boundary) => boundary.ownedRequirementReferences.includes(requirement.reference))
      .map((boundary) => boundary.specReference).sort();
    const dependents = plan.specBoundaries
      .filter((boundary) => boundary.referencedRequirementReferences.includes(requirement.reference))
      .map((boundary) => boundary.specReference).sort();
    const stories = allStories
      .filter(({ story }) => story.requirementReferences.includes(requirement.reference))
      .map(({ story }) => story.id).sort();
    const criteria = allStories.flatMap(({ story }) => story.acceptanceCriteria
      .filter((criterion) => criterion.requirementReferences.includes(requirement.reference))
      .map((criterion) => criterion.criterionId)).sort();
    const status = requirement.conflictsWith.length > 0
      ? 'conflict' as const
      : owners.length > 1
        ? 'duplicate' as const
        : stories.length > 0 && criteria.length > 0
          ? 'covered' as const
          : 'missing' as const;
    if (status === 'missing') {
      diagnostics.push(diagnostic({
        code: 'ORPHAN_REQUIREMENT',
        severity: 'blocker',
        path: `coverage.requirements.${requirement.reference}`,
        message: `Requirement ${requirement.reference} lacks both story and criterion coverage.`,
        references: [requirement.reference, ...owners],
        amendment: 'Add a bounded story and observable criterion in the owning spec, then resubmit.',
      }));
    }
    return {
      requirementReference: requirement.reference,
      ownerSpecReferences: owners,
      dependentSpecReferences: dependents,
      storyReferences: stories,
      criterionReferences: criteria,
      status,
    };
  });

  const capabilityCoverage: AuthoringPreflightResult['coverageMatrix']['capabilities'] = plan.specBoundaries
    .flatMap((boundary) => boundary.requiredStoryCapabilities.map((capability) => {
      const stories = (draftByRef.get(boundary.specReference)?.stories ?? [])
        .filter((story) => story.capabilities.includes(capability)).map((story) => story.id).sort();
      if (stories.length === 0) {
        diagnostics.push(diagnostic({
          code: 'MISSING_CAPABILITY_COVERAGE',
          severity: 'blocker',
          path: `coverage.capabilities.${boundary.specReference}.${capability}`,
          message: `Spec ${boundary.specReference} has no story covering required ${capability} capability.`,
          references: [boundary.specReference, capability],
          amendment: 'Revise story capability assignments or add a bounded outcome story; do not create one story merely for each phase.',
        }));
      }
      return {
        specReference: boundary.specReference,
        capability,
        storyReferences: stories,
        status: stories.length > 0 ? 'covered' as const : 'missing' as const,
      };
    }));

  const phaseGateCoverage: AuthoringPreflightResult['coverageMatrix']['phaseGates'] = plan.specBoundaries
    .flatMap((boundary) => plan.lifecycleProfile.phaseContributions.flatMap((phase) => phase.gateIds.map((gateId) => {
      const matchingStories = (draftByRef.get(boundary.specReference)?.stories ?? []).filter((story) => (
        story.expectedContributions.phaseIds.includes(phase.phaseId)
        && story.expectedContributions.gateIds.includes(gateId)
      ));
      const evidenceExpectationIds = matchingStories.flatMap((story) => (
        story.evidenceExpectations.map((expectation) => expectation.expectationId)
      )).sort();
      if (matchingStories.length === 0 || evidenceExpectationIds.length === 0) {
        diagnostics.push(diagnostic({
          code: 'MISSING_EVIDENCE_EXPECTATION',
          severity: 'blocker',
          path: `coverage.phaseGates.${boundary.specReference}.${phase.phaseId}.${gateId}`,
          message: `Spec ${boundary.specReference} does not expose a story/evidence contribution for ${phase.phaseId}/${gateId}.`,
          references: [boundary.specReference, phase.phaseId, gateId],
          amendment: 'Map one or more existing outcome stories to the phase/gate and observable evidence; this does not mark the gate passed.',
        }));
      }
      return {
        specReference: boundary.specReference,
        phaseId: phase.phaseId,
        gateId,
        storyReferences: matchingStories.map((story) => story.id).sort(),
        evidenceExpectationIds,
        status: matchingStories.length > 0 && evidenceExpectationIds.length > 0 ? 'covered' as const : 'missing' as const,
      };
    })));

  const sorted = sortDiagnostics(diagnostics);
  const accepted = !sorted.some((item) => item.severity === 'blocker');
  return AuthoringPreflightResultSchema.parse({
    schemaVersion: SSDLC_AUTHORING_SCHEMA_VERSION,
    accepted,
    planHash: input.planHash,
    acceptedPreflightHash: accepted ? deriveAuthoringPreflightHash(input) : null,
    diagnostics: sorted,
    amendments: amendmentCandidates(sorted),
    coverageMatrix: {
      requirements: requirementCoverage,
      capabilities: capabilityCoverage,
      phaseGates: phaseGateCoverage,
    },
    draftMutationCount: 0,
    authoritativePersistenceAllowed: accepted,
  });
}
