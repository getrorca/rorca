/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import {
  validateAssuranceCandidate,
  type AssuranceCandidateInput,
  type AssuranceCandidateValidation,
} from './assurance-candidate';
import type { LifecyclePlan } from './ssdlc-contracts';

export const DEVELOPMENT_ASSURANCE_COMPILER_VERSION = 'development-assurance.v1' as const;

export const DEVELOPMENT_ASSURANCE_DISPOSITIONS = [
  'required', 'not_applicable', 'unresolved', 'blocked',
] as const;
export type DevelopmentAssuranceDisposition = typeof DEVELOPMENT_ASSURANCE_DISPOSITIONS[number];
export type DevelopmentAssuranceState = 'pending' | 'not_applicable' | 'unresolved' | 'blocked';
export type DevelopmentAssuranceSelection = 'selected' | 'excluded';
export type DevelopmentAssuranceChangeKind = 'added' | 'modified' | 'deleted' | 'boundary';
export type DevelopmentAssuranceCheckKind =
  | 'scope-conformance'
  | 'requirement-implementation'
  | 'risk-mitigation'
  | 'architecture-conformance'
  | 'boundary-contract'
  | 'deletion-regression';

export interface DevelopmentAssuranceRequirementInput {
  requirementId: string;
  text: string;
}

export interface DevelopmentAssuranceRiskInput {
  riskId: string;
  title: string;
  componentOrBoundary: string;
  requirementIds: readonly string[];
  rationale: string;
}

export interface DevelopmentAssuranceArchitectureDecisionInput {
  decisionId: string;
  title: string;
  componentOrBoundary: string;
  requirementIds: readonly string[];
  rationale: string;
}

export interface DevelopmentAssuranceChangeInput {
  changeId: string;
  path: string;
  kind: DevelopmentAssuranceChangeKind;
  componentOrBoundary: string;
  requirementIds: readonly string[];
  rationale: string;
}

type AssuranceLifecyclePlan = Pick<LifecyclePlan,
  'planId' | 'planVersion' | 'requirementReferences' | 'requirementMappings' | 'gates' | 'evidenceRequirements'>;

export interface DevelopmentAssuranceCompilerInput {
  feature: {
    featureId: string;
    revision: string;
  };
  candidate: AssuranceCandidateInput | null;
  lifecyclePlan: AssuranceLifecyclePlan | null;
  requirements?: readonly DevelopmentAssuranceRequirementInput[];
  risks?: readonly DevelopmentAssuranceRiskInput[];
  architectureDecisions?: readonly DevelopmentAssuranceArchitectureDecisionInput[];
  changes?: readonly DevelopmentAssuranceChangeInput[];
}

export interface DevelopmentAssuranceExpectedEvidence {
  evidenceRequirementId: string;
  gateId: string;
  kind: string;
  description: string;
  minimumTrustLevel: string;
}

export interface DevelopmentAssuranceCheck {
  checkId: string;
  checkKind: DevelopmentAssuranceCheckKind;
  selection: DevelopmentAssuranceSelection;
  disposition: DevelopmentAssuranceDisposition;
  state: DevelopmentAssuranceState;
  requirement: DevelopmentAssuranceRequirementInput | null;
  change: Pick<DevelopmentAssuranceChangeInput, 'changeId' | 'path' | 'kind'> | null;
  componentOrBoundary: string | null;
  expectedEvidence: DevelopmentAssuranceExpectedEvidence[];
  riskId: string | null;
  architectureDecisionId: string | null;
  rationale: string;
  reasonCodes: string[];
}

export interface DevelopmentAssuranceCompilation {
  compilerVersion: typeof DEVELOPMENT_ASSURANCE_COMPILER_VERSION;
  obligationSetId: string;
  obligationSetHash: `sha256:${string}`;
  binding: {
    featureId: string;
    revision: string;
    candidateId: string | null;
    planId: string | null;
    planVersion: number | null;
    workPackageId: string | null;
    workPackageRevision: number | null;
    workPackageHash: string | null;
    scopeIdentity: string | null;
  };
  obligations: DevelopmentAssuranceCheck[];
  excludedChecks: DevelopmentAssuranceCheck[];
  checks: DevelopmentAssuranceCheck[];
  summary: {
    required: number;
    notApplicable: number;
    unresolved: number;
    blocked: number;
    readyForEvidence: boolean;
  };
}

export interface DevelopmentAssuranceCompilationValidation {
  valid: boolean;
  findings: string[];
  expectedObligationSetHash: `sha256:${string}`;
  observedObligationSetHash: string;
}

type NormalizedRequirement = DevelopmentAssuranceRequirementInput & { conflict: boolean };
type NormalizedRisk = DevelopmentAssuranceRiskInput & { conflict: boolean };
type NormalizedDecision = DevelopmentAssuranceArchitectureDecisionInput & { conflict: boolean };
type NormalizedChange = DevelopmentAssuranceChangeInput & { conflict: boolean };
type CheckDraft = Omit<DevelopmentAssuranceCheck, 'checkId'>;

const IMPLEMENTATION_EVIDENCE: Readonly<Record<string, true>> = {
  change_review: true, automated_validation: true, qa_assessment: true,
};
const RISK_EVIDENCE: Readonly<Record<string, true>> = { security_assessment: true, automated_validation: true };
const ARCHITECTURE_EVIDENCE: Readonly<Record<string, true>> = { architecture_review: true };
const BOUNDARY_EVIDENCE: Readonly<Record<string, true>> = { architecture_review: true, automated_validation: true };
const DELETION_EVIDENCE: Readonly<Record<string, true>> = { automated_validation: true, change_review: true };
const SCOPE_EVIDENCE: Readonly<Record<string, true>> = { change_review: true };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort(lexical).filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function sortedUnique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(text).filter(Boolean))].sort(lexical);
}

function normalizeByIdentity<T extends object>(
  values: readonly T[] | undefined,
  identity: (value: T) => string,
  normalize: (value: T) => T,
): Array<T & { conflict: boolean }> {
  const grouped = new Map<string, T[]>();
  for (const value of values ?? []) {
    const normalized = normalize(value);
    const id = identity(normalized);
    const key = id || `missing:${digest(normalized)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), normalized]);
  }
  return [...grouped.entries()].sort(([left], [right]) => lexical(left, right)).map(([, group]) => {
    const canonicalGroup = group.map((value) => ({ value, json: canonicalJson(value) }))
      .sort((left, right) => lexical(left.json, right.json));
    return { ...canonicalGroup[0].value, conflict: new Set(canonicalGroup.map(({ json }) => json)).size > 1 };
  });
}

function normalizeRequirements(values: readonly DevelopmentAssuranceRequirementInput[] | undefined): NormalizedRequirement[] {
  return normalizeByIdentity(values, (value) => value.requirementId, (value) => ({
    requirementId: text(value.requirementId),
    text: text(value.text),
  }));
}

function normalizeRisks(values: readonly DevelopmentAssuranceRiskInput[] | undefined): NormalizedRisk[] {
  return normalizeByIdentity(values, (value) => value.riskId, (value) => ({
    riskId: text(value.riskId),
    title: text(value.title),
    componentOrBoundary: text(value.componentOrBoundary),
    requirementIds: sortedUnique(value.requirementIds),
    rationale: text(value.rationale),
  }));
}

function normalizeDecisions(
  values: readonly DevelopmentAssuranceArchitectureDecisionInput[] | undefined,
): NormalizedDecision[] {
  return normalizeByIdentity(values, (value) => value.decisionId, (value) => ({
    decisionId: text(value.decisionId),
    title: text(value.title),
    componentOrBoundary: text(value.componentOrBoundary),
    requirementIds: sortedUnique(value.requirementIds),
    rationale: text(value.rationale),
  }));
}

function normalizeChanges(values: readonly DevelopmentAssuranceChangeInput[] | undefined): NormalizedChange[] {
  return normalizeByIdentity(values, (value) => value.changeId, (value) => ({
    changeId: text(value.changeId),
    path: text(value.path),
    kind: value.kind,
    componentOrBoundary: text(value.componentOrBoundary),
    requirementIds: sortedUnique(value.requirementIds),
    rationale: text(value.rationale),
  }));
}


function exactBindingProblems(
  input: DevelopmentAssuranceCompilerInput,
  candidate: AssuranceCandidateValidation | null,
): string[] {
  if (!candidate) return ['candidate-absent'];
  const problems = candidate.findings.map((finding) => `candidate:${finding.kind}`);
  const identity = candidate.identity;
  if (identity.specificationRevision?.specId !== text(input.feature.featureId)
    || identity.specificationRevision?.revision !== text(input.feature.revision)) {
    problems.push('candidate-feature-mismatch');
  }
  if (!input.lifecyclePlan) problems.push('lifecycle-plan-absent');
  else if (identity.plan?.planId !== input.lifecyclePlan.planId || identity.plan?.planVersion !== input.lifecyclePlan.planVersion) {
    problems.push('candidate-plan-mismatch');
  }
  return sortedUnique(problems);
}

function expectedEvidence(
  plan: AssuranceLifecyclePlan | null,
  requirementId: string | null,
  allowedKinds: Readonly<Record<string, true>>,
): DevelopmentAssuranceExpectedEvidence[] {
  if (!plan) return [];
  const mappings = requirementId
    ? plan.requirementMappings.filter((mapping) => mapping.requirementReference === requirementId)
    : plan.requirementMappings;
  const evidenceIds = new Set(mappings.flatMap((mapping) => mapping.evidenceRequirementIds));
  const gateById = new Map(plan.gates.map((gate) => [gate.gateId, gate]));
  return plan.evidenceRequirements.filter((evidence) => {
    const gate = gateById.get(evidence.gateId);
    return evidenceIds.has(evidence.evidenceRequirementId) && Boolean(gate && allowedKinds[gate.evidenceKind]);
  }).map((evidence) => ({
    evidenceRequirementId: evidence.evidenceRequirementId,
    gateId: evidence.gateId,
    kind: gateById.get(evidence.gateId)?.evidenceKind ?? 'unresolved',
    description: evidence.description,
    minimumTrustLevel: evidence.minimumTrustLevel,
  })).sort((left, right) => lexical(left.evidenceRequirementId, right.evidenceRequirementId));
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function appliesToChange(
  componentOrBoundary: string,
  requirementIds: readonly string[],
  change: NormalizedChange,
): boolean {
  return componentOrBoundary === '*'
    || componentOrBoundary === change.componentOrBoundary
    || intersects(requirementIds, change.requirementIds);
}

function disposition(input: {
  selected: boolean;
  blockingReasons?: readonly string[];
  unresolvedReasons?: readonly string[];
}): Pick<CheckDraft, 'selection' | 'disposition' | 'state' | 'reasonCodes'> {
  if (!input.selected) {
    return { selection: 'excluded', disposition: 'not_applicable', state: 'not_applicable', reasonCodes: ['check-not-applicable'] };
  }
  const blockingReasons = sortedUnique(input.blockingReasons);
  if (blockingReasons.length) {
    return { selection: 'selected', disposition: 'blocked', state: 'blocked', reasonCodes: blockingReasons };
  }
  const unresolvedReasons = sortedUnique(input.unresolvedReasons);
  if (unresolvedReasons.length) {
    return { selection: 'selected', disposition: 'unresolved', state: 'unresolved', reasonCodes: unresolvedReasons };
  }
  return { selection: 'selected', disposition: 'required', state: 'pending', reasonCodes: ['evidence-pending'] };
}

function withEvidenceDisposition(
  selected: boolean,
  evidence: DevelopmentAssuranceExpectedEvidence[],
  blockingReasons: readonly string[],
  unresolvedReasons: readonly string[],
): Pick<CheckDraft, 'selection' | 'disposition' | 'state' | 'reasonCodes'> {
  return disposition({
    selected,
    blockingReasons,
    unresolvedReasons: selected && evidence.length === 0
      ? [...unresolvedReasons, 'expected-evidence-unresolved']
      : unresolvedReasons,
  });
}

function requirementFor(
  requirementId: string,
  requirements: ReadonlyMap<string, NormalizedRequirement>,
): DevelopmentAssuranceRequirementInput | null {
  const requirement = requirements.get(requirementId);
  return requirement ? { requirementId: requirement.requirementId, text: requirement.text } : null;
}

function changeBinding(change: NormalizedChange | null): DevelopmentAssuranceCheck['change'] {
  return change ? { changeId: change.changeId, path: change.path, kind: change.kind } : null;
}

function makeCheck(draft: CheckDraft): DevelopmentAssuranceCheck {
  const identity = {
    checkKind: draft.checkKind,
    requirementId: draft.requirement?.requirementId ?? null,
    changeId: draft.change?.changeId ?? null,
    path: draft.change?.path ?? null,
    componentOrBoundary: draft.componentOrBoundary,
    riskId: draft.riskId,
    architectureDecisionId: draft.architectureDecisionId,
  };
  return { checkId: `DAC-${digest(identity).slice(7, 23)}`, ...draft };
}

function conflictReasons(change: NormalizedChange, requirement: NormalizedRequirement | undefined): string[] {
  const reasons: string[] = [];
  if (change.conflict) reasons.push('conflicting-change-input');
  if (!change.changeId || !change.path || !change.componentOrBoundary) reasons.push('incomplete-change-binding');
  if (!change.rationale) reasons.push('change-rationale-missing');
  if (requirement?.conflict) reasons.push('conflicting-requirement-input');
  return reasons;
}

/**
 * Compile read-only Development Assurance obligations from an exact AFM candidate.
 * The output contains no passing state and has no authority to mutate lifecycle facts.
 */
export function compileDevelopmentAssurance(
  input: DevelopmentAssuranceCompilerInput,
): DevelopmentAssuranceCompilation {
  const requirements = normalizeRequirements(input.requirements);
  const risks = normalizeRisks(input.risks);
  const decisions = normalizeDecisions(input.architectureDecisions);
  const changes = normalizeChanges(input.changes);
  const requirementById = new Map(requirements.map((requirement) => [requirement.requirementId, requirement]));
  const candidate = input.candidate ? validateAssuranceCandidate(input.candidate) : null;
  const bindingProblems = exactBindingProblems(input, candidate);
  const scopePaths = candidate?.scope.changedPaths ?? [];
  const changePaths = sortedUnique(changes.map((change) => change.path));
  const scopeDrift = canonicalJson(scopePaths) !== canonicalJson(changePaths);
  const scopeBlocking = sortedUnique([
    ...bindingProblems,
    ...(scopeDrift ? ['scope-drift'] : []),
  ]);
  const checks: DevelopmentAssuranceCheck[] = [];
  const scopeEvidence = expectedEvidence(input.lifecyclePlan, null, SCOPE_EVIDENCE);
  const scopeChange = changes[0] ?? null;
  const scopeRequirement = requirementFor(scopeChange?.requirementIds[0] ?? '', requirementById);
  checks.push(makeCheck({
    checkKind: 'scope-conformance',
    ...withEvidenceDisposition(true, scopeEvidence, scopeBlocking, []),
    requirement: scopeRequirement,
    change: changeBinding(scopeChange),
    componentOrBoundary: scopeChange?.componentOrBoundary
      || candidate?.scope.workPackage.workPackageId
      || null,
    expectedEvidence: scopeEvidence,
    riskId: null,
    architectureDecisionId: null,
    rationale: scopeBlocking.length
      ? `The bound work-package and candidate scope cannot be used until ${scopeBlocking.join(', ')} is resolved.`
      : 'The exact candidate path manifests match the implementation change set; host evidence must confirm scope conformance.',
  }));

  if (changes.length === 0) {
    checks.push(makeCheck({
      checkKind: 'requirement-implementation',
      ...disposition({ selected: false }),
      requirement: null,
      change: null,
      componentOrBoundary: null,
      expectedEvidence: [],
      riskId: null,
      architectureDecisionId: null,
      rationale: 'No implementation changes were supplied, so a requirement implementation check is not applicable.',
    }));
  }

  for (const change of changes) {
    const requirementIds = change.requirementIds.length ? change.requirementIds : [''];
    for (const requirementId of requirementIds) {
      const requirement = requirementById.get(requirementId);
      const evidence = expectedEvidence(input.lifecyclePlan, requirementId || null, IMPLEMENTATION_EVIDENCE);
      const unresolved = [
        ...(!requirementId ? ['change-requirement-binding-missing'] : []),
        ...(requirementId && !requirement ? ['requirement-unresolved'] : []),
        ...(requirement && !requirement.text ? ['requirement-text-missing'] : []),
        ...(input.lifecyclePlan && requirementId && !input.lifecyclePlan.requirementReferences.includes(requirementId)
          ? ['requirement-not-in-lifecycle-plan'] : []),
      ];
      checks.push(makeCheck({
        checkKind: 'requirement-implementation',
        ...withEvidenceDisposition(true, evidence, [...scopeBlocking, ...conflictReasons(change, requirement)], unresolved),
        requirement: requirementFor(requirementId, requirementById),
        change: changeBinding(change),
        componentOrBoundary: change.componentOrBoundary || null,
        expectedEvidence: evidence,
        riskId: null,
        architectureDecisionId: null,
        rationale: requirement
          ? `Change ${change.changeId || change.path} must preserve requirement ${requirement.requirementId} for ${change.componentOrBoundary || 'an unresolved component'}; ${change.rationale || 'the change rationale is missing'}.`
          : `Change ${change.changeId || change.path || 'with missing identity'} has no resolvable requirement binding and cannot be treated as assured.`,
      }));
    }

    const matchingBoundaryDecisions = decisions.filter((decision) => appliesToChange(
      decision.componentOrBoundary,
      decision.requirementIds,
      change,
    ));
    const boundaryEvidence = expectedEvidence(input.lifecyclePlan, change.requirementIds[0] ?? null, BOUNDARY_EVIDENCE);
    const boundarySelected = change.kind === 'boundary';
    checks.push(makeCheck({
      checkKind: 'boundary-contract',
      ...withEvidenceDisposition(boundarySelected, boundaryEvidence, [
        ...(boundarySelected ? scopeBlocking : []),
        ...(boundarySelected ? conflictReasons(change, undefined) : []),
      ], boundarySelected && matchingBoundaryDecisions.length === 0 ? ['architecture-decision-unresolved'] : []),
      requirement: requirementFor(change.requirementIds[0] ?? '', requirementById),
      change: changeBinding(change),
      componentOrBoundary: change.componentOrBoundary || null,
      expectedEvidence: boundarySelected ? boundaryEvidence : [],
      riskId: null,
      architectureDecisionId: null,
      rationale: boundarySelected
        ? `The changed boundary ${change.componentOrBoundary || 'is unresolved'} requires contract and architecture evidence before satisfaction can be evaluated.`
        : `Change ${change.changeId || change.path} does not alter a declared component boundary.`,
    }));

    const deletionEvidence = expectedEvidence(input.lifecyclePlan, change.requirementIds[0] ?? null, DELETION_EVIDENCE);
    const deletionSelected = change.kind === 'deleted';
    checks.push(makeCheck({
      checkKind: 'deletion-regression',
      ...withEvidenceDisposition(deletionSelected, deletionEvidence, [
        ...(deletionSelected ? scopeBlocking : []),
        ...(deletionSelected ? conflictReasons(change, undefined) : []),
      ], []),
      requirement: requirementFor(change.requirementIds[0] ?? '', requirementById),
      change: changeBinding(change),
      componentOrBoundary: change.componentOrBoundary || null,
      expectedEvidence: deletionSelected ? deletionEvidence : [],
      riskId: null,
      architectureDecisionId: null,
      rationale: deletionSelected
        ? `Deleted behavior in ${change.componentOrBoundary || change.path} requires regression evidence proving the bound requirement was intentionally removed or preserved elsewhere.`
        : `Change ${change.changeId || change.path} does not delete behavior, so deletion regression is not applicable.`,
    }));
  }

  if (risks.length === 0) {
    checks.push(makeCheck({
      checkKind: 'risk-mitigation',
      ...disposition({ selected: false }),
      requirement: null,
      change: null,
      componentOrBoundary: null,
      expectedEvidence: [],
      riskId: null,
      architectureDecisionId: null,
      rationale: 'No risk inputs were declared for the bound feature; no risk-specific check was selected.',
    }));
  }
  for (const risk of risks) {
    const matchingChanges = changes.filter((change) => appliesToChange(risk.componentOrBoundary, risk.requirementIds, change));
    const targetChanges: Array<NormalizedChange | null> = matchingChanges.length > 0 ? matchingChanges : [null];
    for (const change of targetChanges) {
      const selected = change !== null || risk.conflict;
      const requirementId = risk.requirementIds[0] ?? change?.requirementIds[0] ?? null;
      const evidence = expectedEvidence(input.lifecyclePlan, requirementId, RISK_EVIDENCE);
      checks.push(makeCheck({
        checkKind: 'risk-mitigation',
        ...withEvidenceDisposition(selected, evidence, selected ? [
          ...scopeBlocking,
          ...(risk.conflict ? ['conflicting-risk-input'] : []),
          ...(!risk.riskId || !risk.title || !risk.componentOrBoundary ? ['incomplete-risk-input'] : []),
          ...(!risk.rationale ? ['risk-rationale-missing'] : []),
        ] : [], selected && !requirementId ? ['risk-requirement-binding-missing'] : []),
        requirement: requirementFor(requirementId ?? '', requirementById),
        change: changeBinding(change),
        componentOrBoundary: risk.componentOrBoundary || null,
        expectedEvidence: selected ? evidence : [],
        riskId: risk.riskId || null,
        architectureDecisionId: null,
        rationale: change
          ? `Risk ${risk.riskId || 'with missing identity'} applies to ${risk.componentOrBoundary || 'an unresolved component'} through change ${change.changeId || change.path}; ${risk.rationale || 'its mitigation rationale is missing'}.`
          : risk.conflict
            ? `Conflicting definitions for risk ${risk.riskId || 'with missing identity'} prevent deterministic applicability resolution.`
            : `Risk ${risk.riskId || 'with missing identity'} does not apply to any bound implementation change.`,
      }));
    }
  }

  if (decisions.length === 0 && !changes.some((change) => change.kind === 'boundary')) {
    checks.push(makeCheck({
      checkKind: 'architecture-conformance',
      ...disposition({ selected: false }),
      requirement: null,
      change: null,
      componentOrBoundary: null,
      expectedEvidence: [],
      riskId: null,
      architectureDecisionId: null,
      rationale: 'No architecture decisions or boundary changes were supplied, so architecture conformance is not applicable.',
    }));
  }
  for (const decision of decisions) {
    const matchingChanges = changes.filter((change) => appliesToChange(
      decision.componentOrBoundary,
      decision.requirementIds,
      change,
    ));
    const targetChanges: Array<NormalizedChange | null> = matchingChanges.length > 0 ? matchingChanges : [null];
    for (const change of targetChanges) {
      const selected = change !== null || decision.conflict;
      const requirementId = decision.requirementIds[0] ?? change?.requirementIds[0] ?? null;
      const evidence = expectedEvidence(input.lifecyclePlan, requirementId, ARCHITECTURE_EVIDENCE);
      checks.push(makeCheck({
        checkKind: 'architecture-conformance',
        ...withEvidenceDisposition(selected, evidence, selected ? [
          ...scopeBlocking,
          ...(decision.conflict ? ['conflicting-architecture-input'] : []),
          ...(!decision.decisionId || !decision.title || !decision.componentOrBoundary
            ? ['incomplete-architecture-input']
            : []),
          ...(!decision.rationale ? ['architecture-rationale-missing'] : []),
        ] : [], selected && !requirementId ? ['architecture-requirement-binding-missing'] : []),
        requirement: requirementFor(requirementId ?? '', requirementById),
        change: changeBinding(change),
        componentOrBoundary: decision.componentOrBoundary || null,
        expectedEvidence: selected ? evidence : [],
        riskId: null,
        architectureDecisionId: decision.decisionId || null,
        rationale: change
          ? `Architecture decision ${decision.decisionId || 'with missing identity'} governs ${decision.componentOrBoundary || 'an unresolved boundary'} through change ${change.changeId || change.path}; ${decision.rationale || 'its rationale is missing'}.`
          : decision.conflict
            ? `Conflicting definitions for architecture decision ${decision.decisionId || 'with missing identity'} prevent deterministic applicability resolution.`
            : `Architecture decision ${decision.decisionId || 'with missing identity'} does not govern any bound implementation change.`,
      }));
    }
  }

  checks.sort((left, right) => lexical(left.checkId, right.checkId));
  const binding = {
    featureId: text(input.feature.featureId),
    revision: text(input.feature.revision),
    candidateId: candidate?.candidateId ?? null,
    planId: input.lifecyclePlan?.planId ?? null,
    planVersion: input.lifecyclePlan?.planVersion ?? null,
    workPackageId: candidate?.scope.workPackage.workPackageId ?? null,
    workPackageRevision: candidate?.scope.workPackage.workPackageRevision ?? null,
    workPackageHash: candidate?.scope.workPackage.workPackageHash ?? null,
    scopeIdentity: candidate?.scope.scopeIdentity ?? null,
  };
  const artifactBody = { compilerVersion: DEVELOPMENT_ASSURANCE_COMPILER_VERSION, binding, checks };
  const obligationSetHash = digest(artifactBody);
  const obligations = checks.filter((check) => check.selection === 'selected');
  const excludedChecks = checks.filter((check) => check.selection === 'excluded');
  const summary = {
    required: checks.filter((check) => check.disposition === 'required').length,
    notApplicable: checks.filter((check) => check.disposition === 'not_applicable').length,
    unresolved: checks.filter((check) => check.disposition === 'unresolved').length,
    blocked: checks.filter((check) => check.disposition === 'blocked').length,
    readyForEvidence: obligations.length > 0
      && obligations.every((check) => check.disposition === 'required' && check.state === 'pending'),
  };
  return {
    compilerVersion: DEVELOPMENT_ASSURANCE_COMPILER_VERSION,
    obligationSetId: `development-assurance:${obligationSetHash.slice(7, 23)}`,
    obligationSetHash,
    binding,
    obligations,
    excludedChecks,
    checks,
    summary,
  };
}

/** Detect stale or edited obligation sets by exact deterministic recompilation. */
export function validateDevelopmentAssuranceCompilation(
  input: DevelopmentAssuranceCompilerInput,
  observed: DevelopmentAssuranceCompilation,
): DevelopmentAssuranceCompilationValidation {
  const expected = compileDevelopmentAssurance(input);
  const findings: string[] = [];
  if (observed.compilerVersion !== DEVELOPMENT_ASSURANCE_COMPILER_VERSION) findings.push('compiler-version-mismatch');
  if (observed.obligationSetHash !== expected.obligationSetHash) findings.push('obligation-set-hash-mismatch');
  if (observed.obligationSetId !== expected.obligationSetId) findings.push('obligation-set-id-mismatch');
  if (canonicalJson(observed.binding) !== canonicalJson(expected.binding)) findings.push('binding-mismatch');
  if (canonicalJson(observed.checks) !== canonicalJson(expected.checks)) findings.push('check-set-mismatch');
  if (canonicalJson(observed.obligations) !== canonicalJson(expected.obligations)) {
    findings.push('obligation-projection-mismatch');
  }
  if (canonicalJson(observed.excludedChecks) !== canonicalJson(expected.excludedChecks)) {
    findings.push('excluded-check-set-mismatch');
  }
  if (canonicalJson(observed.summary) !== canonicalJson(expected.summary)) findings.push('summary-mismatch');
  return {
    valid: findings.length === 0,
    findings,
    expectedObligationSetHash: expected.obligationSetHash,
    observedObligationSetHash: observed.obligationSetHash,
  };
}
