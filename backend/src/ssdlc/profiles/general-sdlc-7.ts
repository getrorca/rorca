/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * GENERAL-SDLC-7: the single source of the 7-stage SSDLC stage projection.
 *
 * Every compiled lifecycle plan embeds this profile (id, version, stages,
 * blockingStages, and the canonical contentHash). The content hash is derived
 * from the profile's own mapping fields, so editing the mapping — splitting or
 * merging a stage, moving a phase, or changing labels — deterministically
 * changes `contentHash` and thereby invalidates plans compiled under the
 * previous mapping (see ssdlc_compiled_plans.profile_hash).
 */

import { createHash } from 'node:crypto';
import { CANONICAL_PHASE_IDS, normalizeSsdlcContractJson } from '../../lib/ssdlc-contracts';

export const GENERAL_SDLC_7_PROFILE_ID = 'general-sdlc-7';
export const GENERAL_SDLC_7_PROFILE_VERSION = 2;

export interface GeneralSdlc7Stage {
  id: string;
  label: string;
  phaseIds: readonly string[];
}

export const GENERAL_SDLC_7_STAGES = Object.freeze([
  { id: 'planning', label: 'Planning', phaseIds: Object.freeze(['planning']) },
  { id: 'requirements', label: 'Requirements', phaseIds: Object.freeze(['requirements']) },
  { id: 'design', label: 'Design', phaseIds: Object.freeze(['design']) },
  { id: 'development', label: 'Development', phaseIds: Object.freeze(['development']) },
  { id: 'testing', label: 'Testing', phaseIds: Object.freeze(['testing']) },
  { id: 'deployment', label: 'Deployment', phaseIds: Object.freeze(['deployment']) },
  { id: 'maintenance', label: 'Maintenance', phaseIds: Object.freeze(['maintenance']) },
] as const) satisfies readonly GeneralSdlc7Stage[];

/**
 * Stages whose gates must be satisfied before delivery may proceed. The
 * maintenance stage stays traceable but never blocks.
 */
export const GENERAL_SDLC_7_BLOCKING_STAGES = Object.freeze([
  'planning',
  'requirements',
  'design',
  'development',
  'testing',
  'deployment',
] as const);

function assertCompleteProjection(): void {
  const counts = new Map<string, number>();
  for (const stage of GENERAL_SDLC_7_STAGES) {
    for (const phase of stage.phaseIds) counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  const invalid = CANONICAL_PHASE_IDS.filter((phase) => counts.get(phase) !== 1);
  if (invalid.length > 0) {
    throw new Error(
      `general-sdlc-7 stage projection must project every canonical phase exactly once; invalid: ${invalid.join(', ')}`,
    );
  }
}

assertCompleteProjection();

export const GENERAL_SDLC_7_PROFILE = Object.freeze({
  profileId: GENERAL_SDLC_7_PROFILE_ID,
  version: GENERAL_SDLC_7_PROFILE_VERSION,
  stages: GENERAL_SDLC_7_STAGES,
  blockingStages: GENERAL_SDLC_7_BLOCKING_STAGES,
  contentHash: `sha256:${createHash('sha256')
    .update(normalizeSsdlcContractJson({
      profileId: GENERAL_SDLC_7_PROFILE_ID,
      version: GENERAL_SDLC_7_PROFILE_VERSION,
      stages: GENERAL_SDLC_7_STAGES,
      blockingStages: GENERAL_SDLC_7_BLOCKING_STAGES,
    }), 'utf8')
    .digest('hex')}`,
} as const);

export type GeneralSdlc7Profile = typeof GENERAL_SDLC_7_PROFILE;
export type GeneralSdlc7StageId = (typeof GENERAL_SDLC_7_STAGES)[number]['id'];
