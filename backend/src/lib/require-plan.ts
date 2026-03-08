/**
 * PR-051: Plan-based feature gating middleware.
 *
 * Checks the current user's plan against plan_quotas.
 * Returns 402 if the feature is disabled (quota_limit = 0) or usage exceeds quota.
 */
import { Request, Response, NextFunction } from 'express';
import { db } from '../db/index';
import { getEffectiveUser } from './get-user';
import type { PlanId } from '../routes/billing';

interface QuotaRow {
  plan_name: string;
  feature: string;
  quota_limit: number;
}

/** Plan hierarchy — higher index = higher tier */
const PLAN_TIER: Record<string, number> = { free: 0, solo: 1, pro: 2, team: 3 };

function getUserPlan(userId: string): PlanId {
  const row = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId) as { plan: string } | undefined;
  return (row?.plan as PlanId) || 'free';
}

function getQuotaLimit(plan: PlanId, feature: string): number {
  const row = db.prepare(
    'SELECT quota_limit FROM plan_quotas WHERE plan_name = ? AND feature = ?'
  ).get(plan, feature) as QuotaRow | undefined;
  // Default to unlimited if no row exists (graceful fallback)
  return row?.quota_limit ?? -1;
}

/** Count current usage for a feature. */
function getCurrentUsage(userId: string, feature: string): number {
  switch (feature) {
    case 'workspaces': {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM workspaces').get() as { cnt: number };
      return row.cnt;
    }
    case 'specs_per_month': {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM wal_events
         WHERE event_type = 'generate' AND ts >= datetime('now', '-30 days')`
      ).get() as { cnt: number };
      return row.cnt;
    }
    case 'team_members': {
      const row = db.prepare(
        `SELECT COUNT(DISTINCT tm.user_id) as cnt
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id
         WHERE t.owner_id = ?`
      ).get(userId) as { cnt: number };
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
function findRequiredPlan(feature: string): PlanId {
  const rows = db.prepare(
    'SELECT plan_name, quota_limit FROM plan_quotas WHERE feature = ? ORDER BY quota_limit ASC'
  ).all(feature) as QuotaRow[];

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
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getEffectiveUser(req);
    const userId = user?.id || 'local-admin';
    const plan = getUserPlan(userId);
    const limit = getQuotaLimit(plan, feature);

    // -1 = unlimited
    if (limit === -1) {
      next();
      return;
    }

    // 0 = feature disabled for this plan
    if (limit === 0) {
      const requiredPlan = findRequiredPlan(feature);
      res.status(402).json({
        error: 'Upgrade required',
        feature,
        currentPlan: plan,
        requiredPlan,
      });
      return;
    }

    // Counted quota — check current usage
    const usage = getCurrentUsage(userId, feature);
    if (usage >= limit) {
      const requiredPlan = findRequiredPlan(feature);
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
  };
}
