/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import controlsArtifact from '../catalog/controls.json';
import { parseControl, type Applicability, type ControlRecord } from '../schema/control-schema';

export const PRODUCT_PROFILES = [
  'cli',
  'library',
  'web-frontend',
  'api-service',
  'mobile',
  'data-pipeline',
  'ai-ml',
  'infrastructure',
] as const;

export type ProductProfile = (typeof PRODUCT_PROFILES)[number];
export type EvidenceDepth = 'self-attestation' | 'artifact' | 'independent-verification';
export type OverrideAction = 'include' | 'exclude';

export interface SpecTaskOverride {
  controlId: string;
  action: OverrideAction;
  evidenceDepthOverride?: EvidenceDepth;
  requirementId: string;
}

export interface ApplicabilityProfile {
  productProfile: ProductProfile | null;
  riskProfile: string[];
  domainRegulatory: string[];
  /** Ordered L4 overrides: `include:CONTROL_ID`, `exclude:CONTROL_ID`, or a bare ID to include. */
  workspaceConventions?: string[];
  /** Ordered L5 overrides; later entries take precedence for the same control. */
  specTaskOverrides?: SpecTaskOverride[];
}

export interface ApplicabilityControl {
  controlId: string;
  applicability: Applicability;
  requiredEvidence?: ControlRecord['requiredEvidence'];
}

export type ResolutionLayer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';

export interface ResolutionLogEntry {
  controlId: string;
  action: OverrideAction;
  layer: ResolutionLayer;
  source: string;
  evidenceDepthOverride?: EvidenceDepth;
  requirementId?: string;
}

export interface ApplicabilityResolution {
  activeControlIds: string[];
  evidenceDepthByControlId: Record<string, EvidenceDepth>;
  resolutionLog: ResolutionLogEntry[];
}

const INDEPENDENT_VERIFICATION_TAGS = new Set(['safety-critical', 'aviation', 'privacy-regulated']);
const ARTIFACT_TAGS = new Set(['data-modifying', 'financial-side-effects', 'external-integration', 'privileged-admin']);
const EVIDENCE_DEPTH_RANK: Record<EvidenceDepth, number> = {
  'self-attestation': 0,
  artifact: 1,
  'independent-verification': 2,
};

const RESOLVED_DEPTH_BY_CANONICAL_DEPTH: Record<ControlRecord['requiredEvidence'][number]['evidenceDepth'], EvidenceDepth> = {
  declaration: 'self-attestation',
  demonstrated: 'artifact',
  'independent-verification': 'independent-verification',
};
const canonicalControls: readonly ControlRecord[] = controlsArtifact.map((control) => parseControl(control));

function tagsFor(control: ApplicabilityControl): readonly string[] {
  return [
    ...control.applicability.productProfiles,
    ...control.applicability.riskProfiles,
    ...control.applicability.domainRegulatory,
  ];
}

function derivedEvidenceDepth(control: ApplicabilityControl | undefined): EvidenceDepth {
  if (!control) return 'self-attestation';
  const tags = tagsFor(control);
  if (tags.some((tag) => INDEPENDENT_VERIFICATION_TAGS.has(tag))) return 'independent-verification';
  if (tags.some((tag) => ARTIFACT_TAGS.has(tag))) return 'artifact';
  return 'self-attestation';
}

function baselineEvidenceDepth(control: ApplicabilityControl | undefined): EvidenceDepth {
  if (!control?.requiredEvidence?.length) return derivedEvidenceDepth(control);
  const canonical = control.requiredEvidence.reduce<EvidenceDepth>((strongest, requirement) => {
    const candidate = RESOLVED_DEPTH_BY_CANONICAL_DEPTH[requirement.evidenceDepth];
    return EVIDENCE_DEPTH_RANK[candidate] > EVIDENCE_DEPTH_RANK[strongest] ? candidate : strongest;
  }, 'self-attestation');
  const derived = derivedEvidenceDepth(control);
  return EVIDENCE_DEPTH_RANK[derived] > EVIDENCE_DEPTH_RANK[canonical] ? derived : canonical;
}

function parseWorkspaceConvention(value: string): { controlId: string; action: OverrideAction } | undefined {
  const convention = value.trim();
  if (!convention) return undefined;
  if (convention.startsWith('include:')) return { controlId: convention.slice('include:'.length).trim(), action: 'include' };
  if (convention.startsWith('exclude:')) return { controlId: convention.slice('exclude:'.length).trim(), action: 'exclude' };
  return { controlId: convention, action: 'include' };
}

/**
 * Resolve L0-L5 applicability in stable catalog/override order.
 *
 * The optional catalog argument is intended for isolated catalog validation and tests; normal
 * callers resolve against the canonical SSDLC control catalog.
 */
export function resolveActiveControls(
  profile: ApplicabilityProfile,
  controls: readonly ApplicabilityControl[] = canonicalControls,
): ApplicabilityResolution {
  const active = new Set<string>();
  const controlsById = new Map(controls.map((control) => [control.controlId, control]));
  const resolutionLog: ResolutionLogEntry[] = [];
  const explicitDepth = new Map<string, EvidenceDepth>();
  const risks = new Set(profile.riskProfile);
  const domains = new Set(profile.domainRegulatory);

  for (const control of controls) {
    const { applicability } = control;
    const matches: Array<{ layer: ResolutionLayer; source: string }> = [];
    if (applicability.universal) matches.push({ layer: 'L0', source: 'universal' });
    if (profile.productProfile && applicability.productProfiles.includes(profile.productProfile)) {
      matches.push({ layer: 'L1', source: profile.productProfile });
    }
    for (const risk of applicability.riskProfiles) {
      if (risks.has(risk)) matches.push({ layer: 'L2', source: risk });
    }
    for (const domain of applicability.domainRegulatory) {
      if (domains.has(domain)) matches.push({ layer: 'L3', source: domain });
    }
    if (matches.length > 0) {
      active.add(control.controlId);
      for (const match of matches) resolutionLog.push({ controlId: control.controlId, action: 'include', ...match });
    }
  }

  for (const rawConvention of profile.workspaceConventions ?? []) {
    const convention = parseWorkspaceConvention(rawConvention);
    if (!convention?.controlId) continue;
    if (convention.action === 'include') active.add(convention.controlId);
    else active.delete(convention.controlId);
    explicitDepth.delete(convention.controlId);
    resolutionLog.push({
      controlId: convention.controlId,
      action: convention.action,
      layer: 'L4',
      source: rawConvention,
    });
  }

  for (const override of profile.specTaskOverrides ?? []) {
    if (override.action === 'include') active.add(override.controlId);
    else active.delete(override.controlId);
    explicitDepth.delete(override.controlId);
    if (override.action === 'include' && override.evidenceDepthOverride) {
      explicitDepth.set(override.controlId, override.evidenceDepthOverride);
    }
    resolutionLog.push({
      controlId: override.controlId,
      action: override.action,
      layer: 'L5',
      source: override.requirementId,
      requirementId: override.requirementId,
      ...(override.evidenceDepthOverride ? { evidenceDepthOverride: override.evidenceDepthOverride } : {}),
    });
  }

  const activeControlIds = [
    ...controls.filter((control) => active.has(control.controlId)).map((control) => control.controlId),
    ...[...active].filter((controlId) => !controlsById.has(controlId)),
  ];
  const evidenceDepthByControlId: Record<string, EvidenceDepth> = {};
  for (const controlId of activeControlIds) {
    evidenceDepthByControlId[controlId] = explicitDepth.get(controlId) ?? baselineEvidenceDepth(controlsById.get(controlId));
  }

  return { activeControlIds, evidenceDepthByControlId, resolutionLog };
}
