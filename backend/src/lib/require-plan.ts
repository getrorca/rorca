/**
 * PR-051: Plan-based feature gating middleware.
 *
 * Checks the current user's plan against plan_quotas.
 * Returns 402 if the feature is disabled (quota_limit = 0) or usage exceeds quota.
 *
 * BL-009: 3-day grace period after trial expiry — allows requests during grace
 * but sets X-Rorca-Grace-Period: true response header. After 3 days, returns 402.
 */
import { Request, Response, NextFunction } from 'express';
import { queryOne, query } from '../db/index';
import { getEffectiveUser } from './get-user';
import type { PlanId } from '../routes/billing';

interface QuotaRow {
  plan_name: string;
  feature: string;
  quota_limit: number;
}

interface TrialGraceRow {
  trial_ends_at: string | null;
  status: string;
}

/** Plan hierarchy — higher index = higher tier */
const _PLAN_TIER: Record<string, number> = { free: 0, solo: 1, pro: 2, team: 3 };

/** Grace period duration in days after trial expiry */
const GRACE_PERIOD_DAYS = 3;

async function getUserPlan(userId: string): Promise<PlanId> {
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
 * Check if a user is in the post-trial grace period.
 * Returns: { inGrace: true } if trial expired 0–3 days ago, { inGrace: false } otherwise.
 */
export async function checkTrialGrace(userId: string): Promise<{ inGrace: boolean }> {
  const sub = await queryOne<TrialGraceRow>(
    `SELECT trial_ends_at, status FROM subscriptions
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );

  if (!sub?.trial_ends_at) return { inGrace: false };

  const trialEnd = new Date(sub.trial_ends_at);
  const now = new Date();
  const daysSinceExpiry = (now.getTime() - trialEnd.getTime()) / (1000 * 60 * 60 * 24);

  // Trial hasn't expired yet or subscription is active — not in grace
  if (daysSinceExpiry <= 0 || sub.status === 'active') return { inGrace: false };

  // Within grace period
  if (daysSinceExpiry <= GRACE_PERIOD_DAYS) return { inGrace: true };

  return { inGrace: false };
}

/**
 * Express middleware factory.
 *
 * Usage: `router.post('/publish', requirePlan('marketplace_publish'), handler)`
 *
 * For binary features (marketplace_publish, exa_search): blocks if quota_limit = 0.
 * For counted features (workspaces, specs_per_month): blocks if current usage >= quota_limit.
 *
 * Trial grace period: if user's trial expired 0–3 days ago, allows the request
 * but sets X-Rorca-Grace-Period: true header. After 3 days, returns 402.
 */
export function requirePlan(feature: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await getEffectiveUser(req);
      const userId = user?.id || 'local-admin';
      const plan = await getUserPlan(userId);
      const limit = await getQuotaLimit(plan, feature);

      // -1 = unlimited
      if (limit === -1) {
        next();
        return;
      }

      // 0 = feature disabled for this plan
      if (limit === 0) {
        // Check grace period before returning 402
        const { inGrace } = await checkTrialGrace(userId);
        if (inGrace) {
          res.setHeader('X-Rorca-Grace-Period', 'true');
          next();
          return;
        }

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
        // Check grace period before returning 402
        const { inGrace } = await checkTrialGrace(userId);
        if (inGrace) {
          res.setHeader('X-Rorca-Grace-Period', 'true');
          next();
          return;
        }

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
