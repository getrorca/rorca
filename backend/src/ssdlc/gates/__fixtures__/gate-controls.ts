/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ApplicabilityResolution, EvidenceDepth } from '../../applicability/resolver';
import type { ControlRecord, Phase } from '../../schema/control-schema';
import { FAMILY_MAP } from '../gate-compiler';

const DEPTHS: EvidenceDepth[] = ['self-attestation', 'artifact', 'independent-verification'];

function controlFor(phase: Phase, family: string, index: number): ControlRecord {
  const controlId = `CTRL-${phase.toUpperCase()}-${family.toUpperCase()}`;
  return {
    schemaVersion: 'rorca.ssdlc-control-record.v1',
    version: '1.0.0',
    controlId,
    phase,
    objective: `Verify ${family} for ${phase}.`,
    applicability: { universal: true, productProfiles: [], riskProfiles: [], domainRegulatory: [] },
    sourceReferences: [{ genesisEvidenceId: `GEN-GATE-${index}`, citation: `Gate source ${index}, section 1` }],
    sourceStrength: 'primary',
    requiredEvidence: [{
      classification: 'artifact',
      allowedSourceTypes: [`${family}-evidence`],
      requiredBindings: { subject: true, release: phase !== 'planning' },
      minimumTrust: 'tool-verified',
      evidenceDepth: 'declaration',
      freshness: { maxAgeSeconds: 3600 },
    }],
    failureSeverity: phase === 'maintenance' ? 'advisory' : 'blocking',
    exceptionPolicy: {
      allowed: true,
      approvalRequired: phase === 'testing',
      justificationRequired: true,
      maxDurationDays: 14,
    },
    skillRefs: [`family:${phase}/${family}`],
  };
}

export const completeGateControls: ControlRecord[] = Object.entries(FAMILY_MAP).flatMap(([phase, families]) =>
  families.map((family, index) => controlFor(phase as Phase, family, index)),
);

export const completeApplicability: ApplicabilityResolution = {
  activeControlIds: completeGateControls.map(({ controlId }) => controlId),
  evidenceDepthByControlId: Object.fromEntries(completeGateControls.map(({ controlId }, index) => [
    controlId,
    DEPTHS[index % DEPTHS.length],
  ])),
  resolutionLog: [],
};
