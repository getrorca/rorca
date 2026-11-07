/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { deriveRequirementReference, type LifecyclePlan } from './ssdlc-contracts';
import type { DevelopmentAssuranceCompilation } from './development-assurance-compiler';

interface Identity {
  revision: string | null;
  planId: string | null;
  planVersion: number | null;
}

interface EvidenceSourceRow {
  id: string;
  source_type: string;
  source_system: string;
  source_idempotency_key: string;
  spec_version: string | null;
  revision: string | null;
  compiled_plan_id: string | null;
  story_id: string | null;
  gate_id: string | null;
  observed_at: Date | string;
  evidence_status: string;
  trust_level: string;
  subject_type: string;
  subject_value: string;
  revision_mismatch: boolean;
  lineage_verified: boolean;
  metadata: Record<string, unknown> | null;
}

interface DecisionSourceRow {
  id: string;
  decision_type: string;
  spec_version: string | null;
  created_at: Date | string;
  gate_id: string | null;
  story_id: string | null;
  rationale: string;
  revoked_at: Date | string | null;
  compiled_plan_id: string | null;
  plan_id: string | null;
}

interface StorySource {
  id: string;
  title: string;
  acceptanceCriteria: unknown[];
  workPackage?: unknown;
  workPackageId?: unknown;
}
export interface AssuranceMapInput {
  feature: { id: string; title: string; identity: Identity };
  requirements: Array<Record<string, unknown>>;
  acceptanceCriteria: Array<Record<string, unknown>>;
  stories: Array<Record<string, unknown>>;
  controls: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  workPackages: Array<Record<string, unknown>>;
  developmentAssurance: DevelopmentAssuranceCompilation | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function criterionId(storyId: string, value: unknown): { id: string; text: string } | null {
  const criterion = record(value);
  const criterionText = text(typeof value === 'string' ? value : criterion.text);
  if (!criterionText) return null;
  const explicitId = text(criterion.requirementId);
  if (explicitId) return { id: explicitId, text: criterionText };
  try {
    return { id: deriveRequirementReference(storyId, criterionText), text: criterionText };
  } catch {
    return null;
  }
}

function controlId(gateId: string): string {
  return gateId.startsWith('gate-') ? gateId.slice(5).toUpperCase() : gateId.toUpperCase();
}

function sourceIdentity(identity: Identity): Identity {
  return { ...identity };
}

function rowIdentity(
  identity: Identity,
  stale: boolean,
  observed?: Partial<Identity>,
): Identity {
  if (!stale) return { ...identity };
  return {
    revision: observed?.revision ?? 'stale:unresolved',
    planId: observed?.planId ?? null,
    planVersion: observed?.planVersion ?? null,
  };
}

function evidenceOutcome(status: string): 'passed' | 'failed' | 'pending' | 'unknown' {
  if (status === 'passed') return 'passed';
  if (status === 'failed' || status === 'story_caused_failure') return 'failed';
  if (status === 'unknown' || status === 'environment_credential_blocker') return 'unknown';
  return 'pending';
}

function evidenceDetails(row: EvidenceSourceRow): Record<string, unknown> {
  return record(record(row.metadata).details);
}

function bindingFromEvidence(row: EvidenceSourceRow): Record<string, unknown> {
  const details = evidenceDetails(row);
  return {
    requirementId: text(details.requirementReference) || text(details.requirementId) || null,
    acceptanceCriterionId: text(details.acceptanceCriterionId) || text(details.acceptanceCriterionReference) || null,
    storyId: text(details.storyId) || null,
    controlId: text(details.controlId) || null,
    workPackageId: text(details.workPackageId) || null,
    evidenceRequirementIds: Array.isArray(details.evidenceRequirementIds)
      ? details.evidenceRequirementIds.filter((item): item is string => typeof item === 'string')
      : [],
    subject: { type: row.subject_type, value: row.subject_value },
  };
}

function facts(value: unknown): Array<{ label: string; value: string }> {
  const packageRecord = record(value);
  return Object.entries(packageRecord)
    .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
    .map(([label, item]) => ({ label, value: String(item) }))
    .slice(0, 12);
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function evidenceIdentity(
  row: EvidenceSourceRow,
  details: Record<string, unknown>,
  identity: Identity,
  compiledPlanId: string | null,
): Identity {
  const storedRevision = text(details.specRevision) || text(details.specVersion) || text(details.revision) || text(row.spec_version);
  const storedPlanId = text(details.planId) || text(details.planIdentifier);
  const storedPlanVersion = numeric(details.planVersion);
  const compiledPlanMismatch = Boolean(row.compiled_plan_id && compiledPlanId && row.compiled_plan_id !== compiledPlanId);
  const storedPlanVersionMismatch = storedPlanVersion != null && storedPlanVersion !== identity.planVersion;
  const planMismatch = Boolean(
    (storedPlanId && storedPlanId !== identity.planId)
    || compiledPlanMismatch
    || storedPlanVersionMismatch,
  );
  const revisionMismatch = Boolean(storedRevision && storedRevision !== identity.revision);
  const stale = row.revision_mismatch || planMismatch || revisionMismatch;
  return rowIdentity(identity, stale, {
    revision: storedRevision || (row.revision_mismatch ? text(row.revision) || undefined : undefined),
    planId: compiledPlanMismatch
      ? `compiled-plan:${row.compiled_plan_id}`
      : storedPlanId || undefined,
    planVersion: storedPlanVersion ?? undefined,
  });
}

function decisionIdentity(
  row: DecisionSourceRow,
  identity: Identity,
  compiledPlanId: string | null,
): Identity {
  const storedRevision = text(row.spec_version);
  const storedPlanId = text(row.plan_id);
  const compiledPlanMismatch = Boolean(row.compiled_plan_id && compiledPlanId && row.compiled_plan_id !== compiledPlanId);
  const planMismatch = Boolean((storedPlanId && storedPlanId !== identity.planId) || compiledPlanMismatch);
  const revisionMismatch = Boolean(storedRevision && storedRevision !== identity.revision);
  return rowIdentity(identity, planMismatch || revisionMismatch, {
    revision: storedRevision || undefined,
    planId: compiledPlanMismatch
      ? `compiled-plan:${row.compiled_plan_id}`
      : storedPlanId || undefined,
  });
}

export function buildFeatureAssuranceMapInput(input: {
  specId: string;
  title: string;
  specRevision: string | null;
  compiledPlanId: string | null;
  plan: LifecyclePlan;
  content: Record<string, unknown> | null;
  evidenceRows: EvidenceSourceRow[];
  decisionRows: DecisionSourceRow[];
  developmentAssurance?: DevelopmentAssuranceCompilation | null;
}): AssuranceMapInput {
  const identity: Identity = { revision: input.specRevision, planId: input.plan.planId, planVersion: input.plan.planVersion };
  const content = input.content ?? {};
  const sourceStories = (Array.isArray(content.userStories) ? content.userStories : Array.isArray(content.stories) ? content.stories : [])
    .map((value): StorySource | null => {
      const story = record(value);
      const id = text(story.id);
      if (!id) return null;
      return {
        id,
        title: text(story.title, id),
        acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
        workPackage: story.workPackage,
        workPackageId: story.workPackageId,
      };
    })
    .filter((story): story is StorySource => Boolean(story));
  const criteria = sourceStories.flatMap((story) => story.acceptanceCriteria.map((value) => {
    const criterion = criterionId(story.id, value);
    return criterion ? { ...criterion, storyId: story.id } : null;
  }).filter((value): value is { id: string; text: string; storyId: string } => Boolean(value)));
  const controlByGate = new Map(input.plan.gates.map((gate) => [gate.gateId, controlId(gate.gateId)]));
  const mappingByRequirement = new Map(input.plan.requirementMappings.map((mapping) => [mapping.requirementReference, mapping]));
  const sourceRequirements = Array.isArray(content.requirements) ? content.requirements : [];
  const requirements = input.plan.requirementReferences.map((id) => {
    const mapping = mappingByRequirement.get(id);
    const declared = sourceRequirements.map(record).find((item) => text(item.id) === id);
    // Requirement references are canonical criterion identities. Never widen
    // one requirement to every criterion on its story: that would make a
    // partial mapping appear complete and can create a false-green chain.
    const criterionIds = criteria.filter((criterion) => criterion.id === id).map((criterion) => criterion.id);
    const gateIds = mapping?.gateIds ?? [];
    return {
      id,
      text: text(declared?.text, id),
      identity,
      sourceIdentity: sourceIdentity(identity),
      acceptanceCriterionIds: criterionIds,
      controlIds: gateIds.map((gateId) => controlByGate.get(gateId)).filter((value): value is string => Boolean(value)),
    };
  });
  const storyControlIds = new Map<string, string[]>();
  for (const mapping of input.plan.requirementMappings) {
    const controls = mapping.gateIds.map((gateId) => controlByGate.get(gateId)).filter((value): value is string => Boolean(value));
    for (const target of mapping.targetReferences) {
      if (target.type !== 'story') continue;
      storyControlIds.set(target.reference, [...new Set([...(storyControlIds.get(target.reference) ?? []), ...controls])]);
    }
  }
  const stories = sourceStories.map((story) => ({
    id: story.id,
    title: story.title,
    acceptanceCriterionIds: criteria.filter((criterion) => criterion.storyId === story.id).map((criterion) => criterion.id),
    controlIds: storyControlIds.get(story.id) ?? [],
    workPackageId: text(story.workPackageId) || null,
    identity,
    sourceIdentity: sourceIdentity(identity),
  }));
  const acceptanceCriteria = criteria.map((criterion) => ({
    id: criterion.id,
    text: criterion.text,
    requirementId: criterion.id,
    storyIds: [criterion.storyId],
    identity,
    sourceIdentity: sourceIdentity(identity),
  }));
  const controls = input.plan.gates.map((gate) => ({
    id: controlByGate.get(gate.gateId) ?? controlId(gate.gateId),
    title: gate.title,
    evidenceRequirementIds: [...gate.evidenceRequirementIds],
    identity,
    sourceIdentity: sourceIdentity(identity),
  }));
  const workPackages = sourceStories.flatMap((story) => {
    const workPackageId = text(story.workPackageId);
    if (!workPackageId || !story.workPackage) return [];
    return [{ id: workPackageId, storyId: story.id, facts: facts(story.workPackage), identity, sourceIdentity: sourceIdentity(identity) }];
  });
  const sourceBinding = (
    direct: Record<string, unknown>,
    storyId: string | null,
    gateId: string | null,
  ): Record<string, unknown> => {
    const candidates = input.plan.requirementMappings.filter((mapping) => (
      (!storyId || mapping.targetReferences.some((target) => target.type === 'story' && target.reference === storyId))
      && (!gateId || mapping.gateIds.includes(gateId))
    ));
    const requirementId = text(direct.requirementId) || (candidates.length === 1 ? candidates[0].requirementReference : '');
    const criterionCandidates = criteria.filter((criterion) => criterion.id === requirementId && (!storyId || criterion.storyId === storyId));
    // Persisted row columns are authoritative. Metadata remains a fallback for
    // older rows, but must not rewrite a row's story or gate relationship.
    const story = storyId || text(direct.storyId) || '';
    const storySource = sourceStories.find((candidate) => candidate.id === story);
    const mappedControlId = gateId ? controlByGate.get(gateId) ?? controlId(gateId) : null;
    return {
      ...direct,
      requirementId: requirementId || null,
      acceptanceCriterionId: text(direct.acceptanceCriterionId) || (criterionCandidates.length === 1 ? criterionCandidates[0].id : null),
      storyId: story || null,
      controlId: mappedControlId ?? (text(direct.controlId) || null),
      workPackageId: text(direct.workPackageId) || text(storySource?.workPackageId) || null,
    };
  };

  const decisions = input.decisionRows.map((row) => ({
    id: row.id,
    source: 'governed_decision',
    decisionType: row.decision_type,
    createdAt: iso(row.created_at),
    binding: sourceBinding({}, row.story_id, row.gate_id),
    outcome: row.revoked_at ? 'revoked' as const : 'approved' as const,
    identity: decisionIdentity(row, identity, input.compiledPlanId),
    sourceIdentity: sourceIdentity(identity),
    rationale: row.rationale,
  }));
  const evidence = input.evidenceRows.map((row) => {
    const details = evidenceDetails(row);
    const gateId = text(row.gate_id) || text(details.gateId) || null;
    return {
      id: row.id,
      source: row.source_type,
      sourceSystem: row.source_system,
      observedAt: iso(row.observed_at),
      binding: sourceBinding(bindingFromEvidence(row), row.story_id, gateId),
      trustLevel: row.trust_level,
      lineageVerified: row.lineage_verified,
      outcome: evidenceOutcome(row.evidence_status),
      identity: evidenceIdentity(row, details, identity, input.compiledPlanId),
      sourceIdentity: sourceIdentity(identity),
      detail: text(row.source_idempotency_key) || null,
    };
  });
  return {
    feature: { id: input.specId, title: input.title, identity },
    requirements,
    acceptanceCriteria,
    stories,
    controls,
    evidence,
    decisions,
    workPackages,
    developmentAssurance: input.developmentAssurance ?? null,
  };
}
