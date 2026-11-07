/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type {
  FeatureAssuranceAcceptanceCriterion,
  FeatureAssuranceChain,
  FeatureAssuranceChainNode,
  FeatureAssuranceControl,
  FeatureAssuranceEvidenceBinding,
  FeatureAssuranceGap,
  FeatureAssuranceIdentity,
  FeatureAssuranceIdentityState,
  FeatureAssuranceMapInput,
  FeatureAssuranceMapProjection,
  FeatureAssuranceRequirement,
  FeatureAssuranceStatus,
  FeatureAssuranceStory,
} from '../types/feature-assurance-map';

const TRUSTED_EVIDENCE_LEVELS = new Set(['host_observed', 'provider_verified', 'authenticated_manual']);

function sameIdentity(left: FeatureAssuranceIdentity, right: FeatureAssuranceIdentity): boolean {
  return left.revision === right.revision
    && left.planId === right.planId
    && left.planVersion === right.planVersion;
}

export function identityState(
  row: FeatureAssuranceIdentity | null | undefined,
  source: FeatureAssuranceIdentity | null | undefined,
): FeatureAssuranceIdentityState {
  if (!row || !source) return { row: row ?? null, source: source ?? null, status: 'unavailable' };
  return { row, source, status: sameIdentity(row, source) ? 'current' : 'stale' };
}

function node<T extends { id: string; identity: FeatureAssuranceIdentity; sourceIdentity?: FeatureAssuranceIdentity | null }>(
  value: T | null,
  expectedId: string | null = value?.id ?? null,
): FeatureAssuranceChainNode<T> {
  return {
    value,
    expectedId,
    identity: identityState(value?.identity, value?.sourceIdentity),
  };
}

interface CompleteChainBinding {
  requirementId: string;
  acceptanceCriterionId: string;
  storyId: string;
  controlId: string;
  workPackageId: string | null;
}

interface ChainSiblingIds {
  acceptanceCriterionIds: readonly string[];
  storyIds: readonly string[];
  controlIds: readonly string[];
}

type BindingRelationship = 'exact' | 'sibling' | 'conflict';

function bindingRelationship(
  binding: FeatureAssuranceEvidenceBinding,
  chain: CompleteChainBinding,
  siblings: ChainSiblingIds,
): BindingRelationship {
  if (binding.requirementId !== chain.requirementId) return 'sibling';
  if (binding.acceptanceCriterionId !== chain.acceptanceCriterionId) {
    return binding.acceptanceCriterionId != null
      && siblings.acceptanceCriterionIds.includes(binding.acceptanceCriterionId)
      ? 'sibling'
      : 'conflict';
  }
  if (binding.storyId !== chain.storyId) {
    return binding.storyId != null && siblings.storyIds.includes(binding.storyId)
      ? 'sibling'
      : 'conflict';
  }
  if (binding.controlId !== chain.controlId) {
    return binding.controlId != null && siblings.controlIds.includes(binding.controlId)
      ? 'sibling'
      : 'conflict';
  }
  return binding.workPackageId === chain.workPackageId ? 'exact' : 'conflict';
}

function addGap(gaps: FeatureAssuranceGap[], gap: FeatureAssuranceGap): void {
  if (!gaps.some((existing) => existing.kind === gap.kind && existing.relatedId === gap.relatedId && existing.message === gap.message)) {
    gaps.push(gap);
  }
}

function identityGaps(
  gaps: FeatureAssuranceGap[],
  label: string,
  state: FeatureAssuranceIdentityState,
  relatedId: string,
): void {
  if (state.status === 'stale') {
    addGap(gaps, {
      kind: 'stale_identity',
      status: 'stale',
      relatedId,
      message: `${label} revision or plan identity differs from its source.`,
    });
  } else if (state.status === 'unavailable') {
    addGap(gaps, {
      kind: 'unavailable_source',
      status: 'unavailable',
      relatedId,
      message: `${label} source identity is unavailable.`,
    });
  }
}

function chainStatus(gaps: FeatureAssuranceGap[]): FeatureAssuranceStatus {
  if (gaps.some((gap) => gap.status === 'blocked')) return 'blocked';
  if (gaps.some((gap) => gap.status === 'stale')) return 'stale';
  if (gaps.some((gap) => gap.status === 'unavailable')) return 'unavailable';
  if (gaps.some((gap) => gap.status === 'pending')) return 'pending';
  return 'verified';
}

interface FeatureAssuranceIndexes {
  acceptanceCriteria: ReadonlyMap<string, FeatureAssuranceAcceptanceCriterion>;
  stories: ReadonlyMap<string, FeatureAssuranceStory>;
  controls: ReadonlyMap<string, FeatureAssuranceControl>;
}

interface ResolvedReference<T> {
  value: T | null;
  expectedId: string | null;
}

function resolveReferences<T>(
  index: ReadonlyMap<string, T>,
  ids: string[],
): Array<ResolvedReference<T>> {
  if (ids.length === 0) return [{ value: null, expectedId: null }];
  return ids.map((expectedId) => ({ value: index.get(expectedId) ?? null, expectedId }));
}

function buildChain(
  input: FeatureAssuranceMapInput,
  requirement: FeatureAssuranceRequirement,
  criterion: FeatureAssuranceAcceptanceCriterion | null,
  story: FeatureAssuranceStory | null,
  control: FeatureAssuranceControl | null,
  expectedIds: {
    acceptanceCriterionId: string | null;
    storyId: string | null;
    controlId: string | null;
  },
): FeatureAssuranceChain {
  const gaps: FeatureAssuranceGap[] = [];
  const requirementNode = node(requirement);
  const criterionNode = node(criterion, expectedIds.acceptanceCriterionId);
  const storyNode = node(story, expectedIds.storyId);
  const controlNode = node(control, expectedIds.controlId);
  const declaredWorkPackage = story?.workPackageId
    ? input.workPackages.find((candidate) => candidate.id === story.workPackageId) ?? null
    : null;
  const workPackage = declaredWorkPackage?.storyId === story?.id ? declaredWorkPackage : null;
  const workPackageNode = node(workPackage, story?.workPackageId ?? null);

  identityGaps(gaps, 'Requirement', requirementNode.identity, requirement.id);
  if (!criterion) {
    const missingId = criterionNode.expectedId ? ` ${criterionNode.expectedId}` : '';
    addGap(gaps, { kind: 'missing_link', status: 'unavailable', relatedId: criterionNode.expectedId ?? undefined, message: `Requirement ${requirement.id} has no available acceptance criterion${missingId}.` });
  } else {
    identityGaps(gaps, 'Acceptance criterion', criterionNode.identity, criterion.id);
    if (criterion.requirementId !== requirement.id) {
      addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: criterion.id, message: `Acceptance criterion ${criterion.id} is bound to ${criterion.requirementId}, not ${requirement.id}.` });
    }
  }
  if (!story) {
    const criterionId = criterion?.id ?? criterionNode.expectedId ?? requirement.id;
    const missingId = storyNode.expectedId ? ` ${storyNode.expectedId}` : '';
    addGap(gaps, { kind: 'missing_link', status: 'unavailable', relatedId: storyNode.expectedId ?? undefined, message: `Acceptance criterion ${criterionId} has no available implementation story${missingId}.` });
  } else {
    identityGaps(gaps, 'Story', storyNode.identity, story.id);
    if (!criterion?.storyIds.includes(story.id)) {
      addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: story.id, message: `Story ${story.id} is not bound from acceptance criterion ${criterion?.id ?? 'missing'}.` });
    }
    if (criterion && !story.acceptanceCriterionIds.includes(criterion.id)) {
      addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: story.id, message: `Story ${story.id} does not bind back to acceptance criterion ${criterion.id}.` });
    }
  }
  if (!control) {
    const missingId = controlNode.expectedId ? ` ${controlNode.expectedId}` : '';
    addGap(gaps, { kind: 'missing_link', status: 'unavailable', relatedId: controlNode.expectedId ?? undefined, message: `Story ${story?.id ?? storyNode.expectedId ?? criterion?.id ?? requirement.id} has no available control${missingId}.` });
  } else {
    identityGaps(gaps, 'Control', controlNode.identity, control.id);
    if (!story?.controlIds.includes(control.id) && !requirement.controlIds.includes(control.id)) {
      addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: control.id, message: `Control ${control.id} is not bound to story ${story?.id ?? 'missing'}.` });
    }
  }
  if (!workPackage) {
    if (declaredWorkPackage && story) {
      addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: declaredWorkPackage.id, message: `Work package ${declaredWorkPackage.id} is bound to story ${declaredWorkPackage.storyId}, not ${story.id}.` });
    } else {
      addGap(gaps, { kind: 'missing_link', status: 'unavailable', relatedId: story?.workPackageId ?? undefined, message: `No work package is bound to story ${story?.id ?? storyNode.expectedId ?? 'missing'}.` });
    }
  } else {
    identityGaps(gaps, 'Work package', workPackageNode.identity, workPackage.id);
  }

  const bindingKey = {
    requirementId: requirement.id,
    acceptanceCriterionId: criterion?.id ?? criterionNode.expectedId ?? '',
    storyId: story?.id ?? storyNode.expectedId ?? '',
    controlId: control?.id ?? controlNode.expectedId ?? '',
    // Preserve evidence bound to the story's declared package even when the
    // package record itself is missing; report that gap without hiding source
    // provenance or treating the observation as a different chain.
    workPackageId: story?.workPackageId ?? null,
  };
  const siblings: ChainSiblingIds = {
    acceptanceCriterionIds: requirement.acceptanceCriterionIds,
    storyIds: criterion?.storyIds ?? [],
    controlIds: story?.controlIds.length ? story.controlIds : requirement.controlIds,
  };
  const evidence: FeatureAssuranceMapInput['evidence'] = [];
  const conflictingEvidence: FeatureAssuranceMapInput['evidence'] = [];
  for (const item of input.evidence) {
    const relationship = bindingRelationship(item.binding, bindingKey, siblings);
    if (relationship === 'exact') evidence.push(item);
    else if (relationship === 'conflict') conflictingEvidence.push(item);
  }
  const decisions: FeatureAssuranceMapInput['decisions'] = [];
  const conflictingDecisions: FeatureAssuranceMapInput['decisions'] = [];
  for (const item of input.decisions) {
    const relationship = bindingRelationship(item.binding, bindingKey, siblings);
    if (relationship === 'exact') decisions.push(item);
    else if (relationship === 'conflict') conflictingDecisions.push(item);
  }

  if (conflictingEvidence.length > 0) {
    addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: conflictingEvidence[0].id, message: 'Evidence exists for this area but its binding does not match the complete chain.' });
  } else if (evidence.length === 0) {
    addGap(gaps, { kind: 'missing_link', status: 'unavailable', message: 'No evidence record is bound to the complete chain.' });
  }
  if (conflictingDecisions.length > 0) {
    addGap(gaps, { kind: 'mismatched_binding', status: 'blocked', relatedId: conflictingDecisions[0].id, message: 'A decision exists for this area but its binding does not match the complete chain.' });
  } else if (decisions.length === 0) {
    addGap(gaps, { kind: 'missing_link', status: 'pending', message: 'No decision is bound to the complete chain.' });
  }

  for (const item of [...evidence, ...decisions, ...(workPackage ? [workPackage] : [])]) {
    const state = identityState(item.identity, item.sourceIdentity);
    identityGaps(gaps, item.id === workPackage?.id ? 'Work package' : 'Record', state, item.id);
  }
  if (evidence.some((item) => item.outcome === 'failed')) {
    addGap(gaps, { kind: 'failed_evidence', status: 'blocked', relatedId: evidence.find((item) => item.outcome === 'failed')?.id, message: 'A bound evidence record failed.' });
  }
  if (evidence.some((item) => item.outcome === 'pending' || item.outcome === 'unknown')) {
    addGap(gaps, { kind: 'untrusted_evidence', status: 'pending', message: 'Bound evidence has no final outcome.' });
  }
  const trustedPassedEvidence = evidence.filter((item) => (
    item.outcome === 'passed'
    && item.lineageVerified !== false
    && TRUSTED_EVIDENCE_LEVELS.has(item.trustLevel)
  ));
  if (evidence.length > 0 && trustedPassedEvidence.length === 0) {
    addGap(gaps, { kind: 'untrusted_evidence', status: 'pending', message: 'No lineage-verified host observation or independent verification proves this chain.' });
  }
  const satisfiedEvidenceRequirements = new Set<string>();
  for (const item of trustedPassedEvidence) {
    for (const evidenceRequirementId of item.binding.evidenceRequirementIds ?? []) {
      satisfiedEvidenceRequirements.add(evidenceRequirementId);
    }
  }
  const missingEvidenceRequirements = control?.evidenceRequirementIds.filter((id) => !satisfiedEvidenceRequirements.has(id)) ?? [];
  if (missingEvidenceRequirements.length > 0) {
    addGap(gaps, {
      kind: 'untrusted_evidence',
      status: 'pending',
      relatedId: control?.id,
      message: `Trusted evidence does not cover control requirements: ${missingEvidenceRequirements.join(', ')}.`,
    });
  }
  if (decisions.some((item) => item.outcome === 'revoked')) {
    addGap(gaps, { kind: 'failed_evidence', status: 'blocked', relatedId: decisions.find((item) => item.outcome === 'revoked')?.id, message: 'A bound decision was revoked.' });
  }
  if (decisions.some((item) => item.outcome === 'pending' || item.outcome === 'unknown')) {
    addGap(gaps, { kind: 'pending_decision', status: 'pending', message: 'No final approved decision exists for every bound decision record.' });
  }

  return {
    key: [requirement.id, criterion?.id ?? criterionNode.expectedId ?? 'missing-ac', story?.id ?? storyNode.expectedId ?? 'missing-story', control?.id ?? controlNode.expectedId ?? 'missing-control'].join(':'),
    requirement: requirementNode,
    acceptanceCriterion: criterionNode,
    story: storyNode,
    control: controlNode,
    evidence,
    decisions,
    workPackage: workPackageNode,
    status: chainStatus(gaps),
    gaps,
  };
}

function buildRequirementChains(
  input: FeatureAssuranceMapInput,
  requirement: FeatureAssuranceRequirement,
  indexes: FeatureAssuranceIndexes,
): FeatureAssuranceChain[] {
  const criteria = resolveReferences(indexes.acceptanceCriteria, requirement.acceptanceCriterionIds);
  return criteria.flatMap(({ value: criterion, expectedId: acceptanceCriterionId }) => {
    const stories = criterion
      ? resolveReferences(indexes.stories, criterion.storyIds)
      : [{ value: null, expectedId: null }];
    return stories.flatMap(({ value: story, expectedId: storyId }) => {
      // A story can implement criteria from several requirements. Restrict
      // controls to the current requirement/story relationship instead of
      // letting a story-wide union create unrelated chains.
      const relatedControlIds = story
        ? requirement.controlIds.filter((controlId) => story.controlIds.includes(controlId))
        : [];
      const controlIds = relatedControlIds.length > 0 ? relatedControlIds : requirement.controlIds;
      const controls = resolveReferences(indexes.controls, controlIds);
      return controls.map(({ value: control, expectedId: controlId }) => buildChain(
        input,
        requirement,
        criterion,
        story,
        control,
        { acceptanceCriterionId, storyId, controlId },
      ));
    });
  });
}

export function projectFeatureAssuranceMap(input: FeatureAssuranceMapInput): FeatureAssuranceMapProjection {
  const indexes: FeatureAssuranceIndexes = {
    acceptanceCriteria: new Map(input.acceptanceCriteria.map((item) => [item.id, item])),
    stories: new Map(input.stories.map((item) => [item.id, item])),
    controls: new Map(input.controls.map((item) => [item.id, item])),
  };
  const chains = input.requirements.flatMap((requirement) => buildRequirementChains(input, requirement, indexes));
  const usedEvidence = new Set(chains.flatMap((chain) => chain.evidence));
  const usedDecisions = new Set(chains.flatMap((chain) => chain.decisions));
  const summary = {
    verified: chains.filter((chain) => chain.status === 'verified').length,
    pending: chains.filter((chain) => chain.status === 'pending').length,
    stale: chains.filter((chain) => chain.status === 'stale').length,
    blocked: chains.filter((chain) => chain.status === 'blocked').length,
    unavailable: chains.filter((chain) => chain.status === 'unavailable').length,
  } satisfies Record<FeatureAssuranceStatus, number>;
  return {
    feature: input.feature,
    chains,
    unlinkedEvidence: input.evidence.filter((item) => !usedEvidence.has(item)),
    unlinkedDecisions: input.decisions.filter((item) => !usedDecisions.has(item)),
    summary,
    developmentAssurance: input.developmentAssurance ?? null,
    reviewView: input.reviewView ?? null,
    readOnly: true,
  };
}
