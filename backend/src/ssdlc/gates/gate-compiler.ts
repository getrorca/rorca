/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import type { ApplicabilityResolution, EvidenceDepth as ResolvedEvidenceDepth } from '../applicability/resolver';
import {
  MISSION_STAGE_BY_PHASE,
  PHASES,
  type ControlRecord,
  type EvidenceRequirement,
  type MissionStage,
  type Phase,
  type SourceReference,
} from '../schema/control-schema';

export const MISSION_STAGES = ['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance'] as const;

/** Mandatory assurance concerns. Controls may satisfy more than one family. */
export const FAMILY_MAP = Object.freeze({
  planning: ['need-validity', 'scope-boundaries', 'risk-classification'],
  requirements: ['completeness', 'verifiability', 'traceability', 'quality-attributes'],
  design: ['architecture-decisions', 'quality-attribute-design', 'threat-model', 'dependency-boundaries'],
  development: ['secure-coding', 'code-review', 'change-traceability', 'unit-verification'],
  testing: [
    'requirements-verification', 'regression-testing', 'quality-attribute-verification',
    'threat-control-verification', 'authz-boundaries', 'secrets', 'supply-chain', 'vulnerability-response',
    'acceptance-validation', 'independent-evidence-review',
  ],
  deployment: [
    'deployment-readiness', 'environment-parity', 'release-evidence',
    'change-approval', 'protected-integration', 'evidence-completeness',
    'release-approval', 'deployment-verification', 'rollback-readiness', 'observability',
  ],
  maintenance: ['incident-analysis', 'prediction-vs-outcome', 'delivery-metrics', 'control-effectiveness', 'improvement-candidates'],
} satisfies Readonly<Record<Phase, readonly string[]>>);

export interface CompiledEvidenceRequirement extends EvidenceRequirement {
  controlId: string;
  /** US-001 Genesis provenance retained with each compiled requirement. */
  sourceReferences: SourceReference[];
}

export interface PhaseControlGroup {
  phase: Phase;
  controlIds: string[];
  families: Record<string, string[]>;
  evidenceRequirements: CompiledEvidenceRequirement[];
  missingFamilies: string[];
}

export interface StageReadiness {
  stage: MissionStage;
  phases: Phase[];
  controlIds: string[];
  unresolvedControlIds: string[];
  approvalControlIds: string[];
  blocking: boolean;
  status: 'ready' | 'blocked' | 'non-blocking';
}

export interface GateCompilation {
  phaseGroups: PhaseControlGroup[];
  readiness: StageReadiness[];
  missingFamilies: Array<{ phase: Phase; family: string }>;
}

export interface CompileGateOptions {
  /** Omit to conservatively treat every selected control as unresolved. */
  unresolvedControlIds?: readonly string[];
  /** Convenience inverse of unresolvedControlIds. Ignored when unresolvedControlIds is supplied. */
  resolvedControlIds?: readonly string[];
}

export interface CompileGatesInput extends CompileGateOptions {
  controls: readonly ControlRecord[];
  applicability: Pick<ApplicabilityResolution, 'activeControlIds' | 'evidenceDepthByControlId'>;
}

const SCHEMA_DEPTH_BY_RESOLVED_DEPTH: Readonly<Record<ResolvedEvidenceDepth, EvidenceRequirement['evidenceDepth']>> = {
  'self-attestation': 'declaration',
  artifact: 'demonstrated',
  'independent-verification': 'independent-verification',
};

function normalizedTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function controlMatchesFamily(control: ControlRecord, family: string): boolean {
  const exactRef = `family:${control.phase}/${family}`;
  if (control.skillRefs.includes(exactRef) || control.skillRefs.includes(`family:${family}`)) return true;

  // Canonical catalogs predating family refs remain consumable when their id/objective/skill
  // vocabulary names every family token. Explicit family refs are preferred because they avoid
  // accidental partial matches.
  const haystack = new Set(normalizedTokens([control.controlId, control.objective, ...control.skillRefs].join(' ')));
  return normalizedTokens(family).every((token) => haystack.has(token));
}

function evidenceDepthFor(
  controlId: string,
  requirement: EvidenceRequirement,
  depths: Readonly<Record<string, ResolvedEvidenceDepth>>,
): EvidenceRequirement['evidenceDepth'] {
  const resolvedDepth = depths[controlId];
  return resolvedDepth ? SCHEMA_DEPTH_BY_RESOLVED_DEPTH[resolvedDepth] : requirement.evidenceDepth;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function controlRequiresApproval(control: ControlRecord): boolean {
  const evidenceApproval = control.requiredEvidence.some((requirement) => requirement.classification === 'approval');
  return control.exceptionPolicy.approvalRequired || evidenceApproval;
}

function normalizeInput(
  inputOrControls: CompileGatesInput | readonly ControlRecord[],
  applicability?: Pick<ApplicabilityResolution, 'activeControlIds' | 'evidenceDepthByControlId'>,
  options: CompileGateOptions = {},
): CompileGatesInput {
  if (!Array.isArray(inputOrControls)) return inputOrControls as CompileGatesInput;
  if (!applicability) throw new TypeError('compileGates requires an applicability resolution');
  return { controls: inputOrControls, applicability, ...options };
}

/**
 * Compile US-003-selected controls into canonical phase gates and Mission readiness stages.
 * Selection is fail-closed: unknown active ids cannot silently become an ungoverned gate.
 */
export function compileGates(input: CompileGatesInput): GateCompilation;
export function compileGates(
  controls: readonly ControlRecord[],
  applicability: Pick<ApplicabilityResolution, 'activeControlIds' | 'evidenceDepthByControlId'>,
  options?: CompileGateOptions,
): GateCompilation;
export function compileGates(
  inputOrControls: CompileGatesInput | readonly ControlRecord[],
  applicability?: Pick<ApplicabilityResolution, 'activeControlIds' | 'evidenceDepthByControlId'>,
  options: CompileGateOptions = {},
): GateCompilation {
  const input = normalizeInput(inputOrControls, applicability, options);
  const controlsById = new Map(input.controls.map((control) => [control.controlId, control]));
  const unknownIds = input.applicability.activeControlIds.filter((controlId) => !controlsById.has(controlId));
  if (unknownIds.length > 0) throw new TypeError(`Active controls are absent from the catalog: ${unknownIds.join(', ')}`);

  const active = new Set(input.applicability.activeControlIds);
  const activeControls = input.controls.filter((control) => active.has(control.controlId));
  const phaseGroups = PHASES.map((phase): PhaseControlGroup => {
    const controls = activeControls.filter((control) => control.phase === phase);
    const families = Object.fromEntries(FAMILY_MAP[phase].map((family) => [
      family,
      controls.filter((control) => controlMatchesFamily(control, family)).map((control) => control.controlId),
    ]));
    const familyControlIds = new Set(Object.values(families).flat());
    const missingFamilies = FAMILY_MAP[phase].filter((family) => families[family].length === 0);

    return {
      phase,
      // A selected control that maps to no mandatory family is not silently promoted into a gate.
      controlIds: controls.filter((control) => familyControlIds.has(control.controlId)).map((control) => control.controlId),
      families,
      evidenceRequirements: controls
        .filter((control) => familyControlIds.has(control.controlId))
        .flatMap((control) => control.requiredEvidence.map((requirement) => ({
          ...structuredClone(requirement),
          controlId: control.controlId,
          sourceReferences: structuredClone(control.sourceReferences),
          evidenceDepth: evidenceDepthFor(
            control.controlId,
            requirement,
            input.applicability.evidenceDepthByControlId,
          ),
        }))),
      missingFamilies,
    };
  });

  const selectedControlIds = phaseGroups.flatMap((group) => group.controlIds);
  const selected = new Set(selectedControlIds);
  const unmappedIds = input.applicability.activeControlIds.filter((controlId) => !selected.has(controlId));
  if (unmappedIds.length > 0) {
    throw new TypeError(`Active controls do not map to a mandatory family: ${unmappedIds.join(', ')}`);
  }
  const unresolved = input.unresolvedControlIds
    ? new Set(input.unresolvedControlIds.filter((id) => selected.has(id)))
    : new Set(selectedControlIds.filter((id) => !new Set(input.resolvedControlIds ?? []).has(id)));

  const readiness = MISSION_STAGES.map((stage): StageReadiness => {
    const groups = phaseGroups.filter((group) => MISSION_STAGE_BY_PHASE[group.phase] === stage);
    const controlIds = unique(groups.flatMap((group) => group.controlIds));
    const unresolvedControlIds = controlIds.filter((controlId) => unresolved.has(controlId));
    const approvalControlIds = controlIds.filter((controlId) => {
      const control = controlsById.get(controlId);
      return control !== undefined && controlRequiresApproval(control);
    });
    const blocking = stage !== 'maintenance' && unresolvedControlIds.length > 0;
    return {
      stage,
      phases: groups.map((group) => group.phase),
      controlIds,
      unresolvedControlIds,
      approvalControlIds,
      blocking,
      status: stage === 'maintenance' ? 'non-blocking' : blocking ? 'blocked' : 'ready',
    };
  });

  return {
    phaseGroups,
    readiness,
    missingFamilies: phaseGroups.flatMap((group) => group.missingFamilies.map((family) => ({ phase: group.phase, family }))),
  };
}
