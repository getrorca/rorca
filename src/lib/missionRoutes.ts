/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Mission OS route helpers. The Mission Workspace is one URL-addressable
 * object: `/missions/:specId` (Overview) plus one path segment per lens.
 * Workspace-qualified variants mirror the existing deep-link convention.
 *
 * Server-authored hrefs (e.g. `/delivery-cases/:specId`) are routed directly;
 * `App.tsx` owns redirect routes that land them on the canonical surfaces.
 */

import { DELIVERY_STAGES } from '../../shared/contracts/mission';

export const MISSION_LENSES = DELIVERY_STAGES;
export type MissionLens = (typeof MISSION_LENSES)[number];

export const MISSION_LENS_LABELS: Record<MissionLens, string> = {
  planning: 'Planning',
  requirements: 'Requirements',
  design: 'Design',
  development: 'Development',
  testing: 'Testing',
  deployment: 'Deployment',
  maintenance: 'Maintenance',
};

/** Type guard for URL lens segments; preserves narrowing. */
export function isMissionLens(value: string | undefined | null): value is MissionLens {
  return !!value && (MISSION_LENSES as readonly string[]).includes(value);
}

const enc = encodeURIComponent;

/** Canonical mission workspace path. `overview` (or omitted) is the base path. */
export function missionCasePath(specId: string, lens?: MissionLens | 'overview' | null): string {
  const base = `/missions/${enc(specId)}`;
  return lens && lens !== 'overview' && isMissionLens(lens) ? `${base}/${lens}` : base;
}

/** Workspace-qualified variant used by canonical deep links. */
export function workspaceMissionCasePath(
  workspaceId: string,
  specId: string,
  lens?: MissionLens | 'overview' | null,
): string {
  return `/workspaces/${enc(workspaceId)}${missionCasePath(specId, lens)}`;
}
