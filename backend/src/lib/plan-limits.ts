/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Plan limits configuration.
 *
 * Static in-memory config — no DB round-trip per request.
 * The plan_quotas table in the DB is the source of truth for requirePlan()
 * middleware. This module provides a typed, code-accessible version of the
 * same limits for use in route logic (e.g. capping story counts).
 */

export type PlanTier = 'free' | 'solo' | 'pro' | 'team';

export interface PlanLimits {
  /** Maximum number of workspaces. Infinity = unlimited. */
  maxWorkspaces: number;
  /** Whether the plan allows pipeline execution (POST /api/pipeline/trigger). */
  canExecutePipeline: boolean;
  /** Whether the plan allows third-party integrations (GitHub, Linear, Vercel, Slack). */
  canUseIntegrations: boolean;
  /** Maximum stories per spec. Infinity = unlimited. */
  maxStoriesPerSpec: number;
  /** Maximum specs generated per calendar month. Infinity = unlimited. */
  maxSpecsPerMonth: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    maxWorkspaces: 1,
    canExecutePipeline: false,
    canUseIntegrations: false,
    maxStoriesPerSpec: 10,
    maxSpecsPerMonth: 5,
  },
  solo: {
    maxWorkspaces: 3,
    canExecutePipeline: true,
    canUseIntegrations: true,
    maxStoriesPerSpec: Infinity,
    maxSpecsPerMonth: Infinity,
  },
  pro: {
    maxWorkspaces: Infinity,
    canExecutePipeline: true,
    canUseIntegrations: true,
    maxStoriesPerSpec: Infinity,
    maxSpecsPerMonth: Infinity,
  },
  team: {
    maxWorkspaces: Infinity,
    canExecutePipeline: true,
    canUseIntegrations: true,
    maxStoriesPerSpec: Infinity,
    maxSpecsPerMonth: Infinity,
  },
};

export function getPlanLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}
