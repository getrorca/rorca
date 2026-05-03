/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PR-051: Plan-based feature gating middleware.
 *
 * Checks the current user's plan against plan_quotas.
 * Returns 402 if the feature is disabled (quota_limit = 0) or usage exceeds quota.
 *
 * BL-013: Self-hosted instances can activate via RORCA_LICENSE_KEY env var.
 * Env var check happens FIRST — if valid, the request is allowed without DB lookup.
 * If invalid/expired, falls through to the normal DB-based check (does not hard-reject).
 */
import { Request, Response, NextFunction } from 'express';
import { queryOne, query } from '../db/index';
import { getEffectiveUser } from './get-user';
import { verifyLicense } from './license-verifier';
import { logger } from './logger';
import type { PlanId } from '../routes/billing';

interface QuotaRow {
  plan_name: string;
  feature: string;
  quota_limit: number;
}

/** Plan hierarchy — higher index = higher tier */
const _PLAN_TIER: Record<string, number> = { free: 0, solo: 1, pro: 2, team: 3 };

async function getUserPlan(userId: string): Promise<PlanId> {
  // BL-002: Check for active trial first
  const trial = await queryOne<{ plan: string; trial_ends_at: string }>(
    `SELECT plan, trial_ends_at FROM subscriptions
     WHERE user_id = $1 AND status = 'trialing' AND trial_ends_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (trial) return (trial.plan as PlanId) || 'pro';

  const row = await queryOne<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [userId]);
  return (row?.plan as PlanId) || 'free';
}

async function getQuotaLimit(plan: PlanId, feature: string): Promise<number> {
  const row = await queryOne<QuotaRow>(
    'SELECT quota_limit FROM plan_quotas WHERE plan_name = $1 AND feature = $2',
    [plan, feature]
  );
  // Default to unlimited if no row exists (graceful fallback)
  return row?.quota_limit ?? -1;
}

/** Count current usage for a feature. */
async function getCurrentUsage(userId: string, feature: string): Promise<number> {
  switch (feature) {
    case 'workspaces': {
      const row = await queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM workspaces');
      return row!.cnt;
    }
    case 'specs_per_month': {
      const row = await queryOne<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM wal_events
         WHERE event_type = 'generate' AND ts >= NOW() - INTERVAL '30 days'`
      );
      return row!.cnt;
    }
    case 'team_members': {
      const row = await queryOne<{ cnt: number }>(
        `SELECT COUNT(DISTINCT tm.user_id) as cnt
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE t.owner_id = $1`,
        [userId]
      );
      return (row?.cnt ?? 0) + 1; // +1 for owner
    }
    // Binary features (0 = disabled, -1 = unlimited): no usage count needed
    case 'marketplace_publish':
    case 'exa_search':
      return 0;
    default:
      return 0;
  }
}

/** Find the minimum plan that allows this feature. */
async function findRequiredPlan(feature: string): Promise<PlanId> {
  const rows = await query<QuotaRow>(
    'SELECT plan_name, quota_limit FROM plan_quotas WHERE feature = $1 ORDER BY quota_limit ASC',
    [feature]
  );

  // Find first plan with non-zero quota
  for (const row of rows) {
    if (row.quota_limit !== 0) {
      return row.plan_name as PlanId;
    }
  }
  return 'pro'; // Default fallback
}

/**
 * Express middleware factory.
 *
 * Usage: `router.post('/publish', requirePlan('marketplace_publish'), handler)`
 *
 * For binary features (marketplace_publish, exa_search): blocks if quota_limit = 0.
 * For counted features (workspaces, specs_per_month): blocks if current usage >= quota_limit.
 */
export function requirePlan(feature: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // BL-013: Check RORCA_LICENSE_KEY env var FIRST — env var wins over DB
      const envLicenseKey = process.env.RORCA_LICENSE_KEY;
      if (envLicenseKey) {
        const license = verifyLicense(envLicenseKey);
        if (license.valid && license.plan !== 'free') {
          // Valid self-hosted license — allow the request
          logger.debug({ plan: license.plan, feature }, '[requirePlan] Self-hosted license valid via RORCA_LICENSE_KEY');
          next();
          return;
        }

        // Invalid/expired env var license — fall through to DB check (does not hard-reject)
        logger.debug({ feature, error: license.error }, '[requirePlan] RORCA_LICENSE_KEY invalid/expired — falling through to DB check');
      }

      const user = await getEffectiveUser(req);
      const userId = user?.id || 'local-admin';

      // BL-002: Check for expired trial before plan resolution
      const expiredTrial = await queryOne<{ trial_ends_at: string }>(
        `SELECT trial_ends_at FROM subscriptions
         WHERE user_id = $1 AND status = 'trialing' AND trial_ends_at <= NOW()
         LIMIT 1`,
        [userId]
      );
      if (expiredTrial) {
        res.status(402).json({
          error: 'Trial expired',
          feature,
          currentPlan: 'free',
          requiredPlan: 'pro',
          trialExpired: true,
        });
        return;
      }

      const plan = await getUserPlan(userId);
      const limit = await getQuotaLimit(plan, feature);

      // -1 = unlimited
      if (limit === -1) {
        next();
        return;
      }

      // 0 = feature disabled for this plan
      if (limit === 0) {
        const requiredPlan = await findRequiredPlan(feature);
        res.status(402).json({
          error: 'Upgrade required',
          feature,
          currentPlan: plan,
          requiredPlan,
        });
        return;
      }

      // Counted quota — check current usage
      const usage = await getCurrentUsage(userId, feature);
      if (usage >= limit) {
        const requiredPlan = await findRequiredPlan(feature);
        res.status(402).json({
          error: 'Upgrade required',
          feature,
          currentPlan: plan,
          requiredPlan,
          currentUsage: usage,
          quotaLimit: limit,
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
