/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export const DEFAULT_ENABLED_GRAPH_SCORING_WEIGHT = 0.35;

export interface GraphScoringRollout {
  enabled: boolean;
  weight: number;
  source: 'explicit' | 'env' | 'workspace-config' | 'default';
}

export function parseGraphScoringWeight(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.min(1, raw));
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(1, parsed));
    }
  }
  return undefined;
}

function parseBooleanFlag(raw: unknown): boolean | undefined {
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

export function resolveGraphScoringRollout(input: {
  explicitWeight?: unknown;
  configWeight?: unknown;
  env?: NodeJS.ProcessEnv;
} = {}): GraphScoringRollout {
  const env = input.env ?? process.env;
  const explicitWeight = parseGraphScoringWeight(input.explicitWeight);
  if (explicitWeight != null) {
    return {
      enabled: explicitWeight > 0,
      weight: explicitWeight,
      source: 'explicit',
    };
  }

  const configWeight = parseGraphScoringWeight(input.configWeight);
  const envEnabled = parseBooleanFlag(env.RORCA_GRAPH_SCORING_ENABLED);
  const envWeight = parseGraphScoringWeight(env.RORCA_GRAPH_SCORING_WEIGHT ?? env.RORCA_GRAPH_SCORE_WEIGHT);

  if (envEnabled === false) {
    return {
      enabled: false,
      weight: 0,
      source: envWeight != null ? 'env' : 'default',
    };
  }

  if (envEnabled === true) {
    if (envWeight != null) {
      return {
        enabled: envWeight > 0,
        weight: envWeight,
        source: 'env',
      };
    }
    if (configWeight != null) {
      return {
        enabled: configWeight > 0,
        weight: configWeight,
        source: 'workspace-config',
      };
    }
    return {
      enabled: true,
      weight: DEFAULT_ENABLED_GRAPH_SCORING_WEIGHT,
      source: 'default',
    };
  }

  return {
    enabled: false,
    weight: 0,
    source: 'default',
  };
}
