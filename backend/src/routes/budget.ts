/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { queryOne, execute } from '../db/index';
import { withUserClient } from '../db/user-client';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';

const router = Router({ mergeParams: true });

// ─── Types ───────────────────────────────────────────────────────────────────

interface BudgetConfigRow {
  id: number;
  workspace_id: string;
  alert_threshold_usd: number | null;
  hard_cap_usd: number | null;
  period: 'daily' | 'weekly' | 'monthly';
  notify_emails: string;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the ISO date string for the start of the current budget period */
function periodStart(period: 'daily' | 'weekly' | 'monthly'): string {
  const now = new Date();
  if (period === 'daily') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
  if (period === 'weekly') {
    const day = now.getDay(); // 0=Sun
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    return new Date(now.getFullYear(), now.getMonth(), diff).toISOString();
  }
  // monthly
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

/** Calculate total spending for a workspace since a given date */
async function getSpendingSince(workspaceId: string, since: string): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM token_usage
     WHERE workspace_id = $1 AND recorded_at >= $2`,
    [workspaceId, since]
  );
  return row?.total ?? 0;
}

/**
 * Check budget thresholds and emit WAL events if needed.
 * Called after recording token usage and after budget config changes.
 */
export async function checkBudgetThresholds(workspaceId: string): Promise<{
  alertTriggered: boolean;
  capExceeded: boolean;
  spending: number;
  config: BudgetConfigRow | null;
}> {
  const config = await queryOne<BudgetConfigRow>(
    'SELECT * FROM budget_config WHERE workspace_id = $1',
    [workspaceId]
  );

  if (!config) {
    return { alertTriggered: false, capExceeded: false, spending: 0, config: null };
  }

  const since = periodStart(config.period);
  const spending = await getSpendingSince(workspaceId, since);

  let alertTriggered = false;
  let capExceeded = false;

  // Check alert threshold
  if (config.alert_threshold_usd != null && spending >= config.alert_threshold_usd) {
    alertTriggered = true;

    // Only emit if we haven't already emitted an alert this period
    const existingAlert = await queryOne(
      `SELECT id FROM wal_events
       WHERE event_type = 'budget_alert'
         AND workspace_id = $1
         AND ts >= $2
       LIMIT 1`,
      [workspaceId, since]
    );

    if (!existingAlert) {
      const emails = JSON.parse(config.notify_emails) as string[];
      const walResult = await queryOne<{ id: number }>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('budget_alert', $1, $2) RETURNING id`,
        [workspaceId, JSON.stringify({
          alert_threshold_usd: config.alert_threshold_usd,
          spending_usd: Math.round(spending * 1_000_000) / 1_000_000,
          period: config.period,
          period_start: since,
          notify_emails: emails,
        })]
      );

      if (walResult) {
        const walEvent = await queryOne<WalEvent>(
          'SELECT * FROM wal_events WHERE id = $1',
          [walResult.id]
        );
        if (walEvent) broadcastAll(walEvent);
      }
    }
  }

  // Check hard cap
  if (config.hard_cap_usd != null && spending >= config.hard_cap_usd) {
    capExceeded = true;
  }

  return { alertTriggered, capExceeded, spending, config };
}

/**
 * @swagger
 * /api/workspaces/{workspaceId}/budget:
 *   post:
 *     tags: [Budget]
 *     summary: Create or update budget configuration
 *     operationId: upsertBudgetConfig
 *     description: Creates or updates the budget configuration for a workspace. Immediately checks spending against new thresholds and emits WAL events if thresholds are exceeded.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               alert_threshold_usd: { type: number, nullable: true }
 *               hard_cap_usd: { type: number, nullable: true }
 *               period: { type: string, enum: [daily, weekly, monthly], default: monthly }
 *               notify_emails: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Budget config saved with current spending status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config: { type: object }
 *                 spending_usd: { type: number }
 *                 alert_triggered: { type: boolean }
 *                 cap_exceeded: { type: boolean }
 *       400:
 *         description: Invalid thresholds or period
 *       404:
 *         description: Workspace not found
 */
router.post('/', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.id);
    const { alert_threshold_usd, hard_cap_usd, period, notify_emails } = req.body as {
      alert_threshold_usd?: number | null;
      hard_cap_usd?: number | null;
      period?: string;
      notify_emails?: string[];
    };

    // Validate period
    const validPeriods = ['daily', 'weekly', 'monthly'];
    const budgetPeriod = period || 'monthly';
    if (!validPeriods.includes(budgetPeriod)) {
      throw new ValidationError(`period must be one of: ${validPeriods.join(', ')}`);
      return;
    }

    // Validate thresholds
    if (alert_threshold_usd != null && alert_threshold_usd < 0) {
      throw new ValidationError('alert_threshold_usd cannot be negative');
      return;
    }
    if (hard_cap_usd != null && hard_cap_usd < 0) {
      throw new ValidationError('hard_cap_usd cannot be negative');
      return;
    }
    if (alert_threshold_usd != null && hard_cap_usd != null && alert_threshold_usd >= hard_cap_usd) {
      throw new ValidationError('alert_threshold_usd must be less than hard_cap_usd');
      return;
    }

    const emailsJson = JSON.stringify(notify_emails || []);

    // Upsert
    await withUserClient(req, async (client) => {
      const workspace = await client.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
      if (workspace.rows.length === 0) {
        throw new NotFoundError('Workspace not found');
      }
      await client.query(`
        INSERT INTO budget_config (workspace_id, alert_threshold_usd, hard_cap_usd, period, notify_emails)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(workspace_id) DO UPDATE SET
          alert_threshold_usd = excluded.alert_threshold_usd,
          hard_cap_usd = excluded.hard_cap_usd,
          period = excluded.period,
          notify_emails = excluded.notify_emails,
          updated_at = NOW()
      `, [workspaceId, alert_threshold_usd ?? null, hard_cap_usd ?? null, budgetPeriod, emailsJson]);
    });

    // Emit WAL event for budget config change
    const walResult = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('budget_config_updated', $1, $2) RETURNING id`,
      [workspaceId, JSON.stringify({
        alert_threshold_usd: alert_threshold_usd ?? null,
        hard_cap_usd: hard_cap_usd ?? null,
        period: budgetPeriod,
        notify_emails: notify_emails || [],
      })]
    );
    if (walResult) {
      const walEvent = await queryOne<WalEvent>(
        'SELECT * FROM wal_events WHERE id = $1',
        [walResult.id]
      );
      if (walEvent) broadcastAll(walEvent);
    }

    // Check thresholds immediately (in case spending already exceeds new config)
    const budgetStatus = await checkBudgetThresholds(workspaceId);

    const config = await withUserClient(req, async (client) => {
      const result = await client.query<BudgetConfigRow>('SELECT * FROM budget_config WHERE workspace_id = $1', [workspaceId]);
      return result.rows[0];
    });

    res.json({
      config: config ? {
        ...config,
        notify_emails: JSON.parse(config.notify_emails),
      } : null,
      spending_usd: Math.round(budgetStatus.spending * 1_000_000) / 1_000_000,
      alert_triggered: budgetStatus.alertTriggered,
      cap_exceeded: budgetStatus.capExceeded,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Budget] Config update');
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/budget:
 *   get:
 *     tags: [Budget]
 *     summary: Get budget configuration and current spending
 *     operationId: getBudgetConfig
 *     description: Returns the budget configuration for a workspace along with current spending, remaining budget, and threshold status.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Budget config and spending status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config: { type: object, nullable: true }
 *                 spending_usd: { type: number }
 *                 remaining_usd: { type: number, nullable: true }
 *                 period_start: { type: string, nullable: true }
 *                 alert_triggered: { type: boolean }
 *                 cap_exceeded: { type: boolean }
 *       404:
 *         description: Workspace not found
 */
router.get('/', requireWorkspaceMember(), async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.id);

    const config = await withUserClient(req, async (client) => {
      const workspace = await client.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
      if (workspace.rows.length === 0) {
        throw new NotFoundError('Workspace not found');
      }
      const result = await client.query<BudgetConfigRow>('SELECT * FROM budget_config WHERE workspace_id = $1', [workspaceId]);
      return result.rows[0];
    });

    if (!config) {
      res.json({
        config: null,
        spending_usd: 0,
        remaining_usd: null,
        period_start: null,
        alert_triggered: false,
        cap_exceeded: false,
      });
      return;
    }

    const since = periodStart(config.period);
    const spending = await getSpendingSince(workspaceId, since);
    const remaining = config.hard_cap_usd != null
      ? Math.max(0, config.hard_cap_usd - spending)
      : null;

    const alertTriggered = config.alert_threshold_usd != null && spending >= config.alert_threshold_usd;
    const capExceeded = config.hard_cap_usd != null && spending >= config.hard_cap_usd;

    res.json({
      config: {
        ...config,
        notify_emails: JSON.parse(config.notify_emails),
      },
      spending_usd: Math.round(spending * 1_000_000) / 1_000_000,
      remaining_usd: remaining != null ? Math.round(remaining * 1_000_000) / 1_000_000 : null,
      period_start: since,
      alert_triggered: alertTriggered,
      cap_exceeded: capExceeded,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Budget] Get config');
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/budget:
 *   delete:
 *     tags: [Budget]
 *     summary: Remove budget configuration
 *     operationId: deleteBudgetConfig
 *     description: Permanently removes the budget configuration for a workspace. Emits a WAL event for the deletion.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Budget config deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *       404:
 *         description: No budget config found for this workspace
 */
router.delete('/', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.id);
    const result = await withUserClient(req, async (client) => {
      const workspace = await client.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
      if (workspace.rows.length === 0) {
        throw new NotFoundError('Workspace not found');
      }
      const deletion = await client.query('DELETE FROM budget_config WHERE workspace_id = $1', [workspaceId]);
      return { rowCount: deletion.rowCount ?? 0 };
    });

    if (result.rowCount === 0) {
      throw new NotFoundError('No budget config found for this workspace');
      return;
    }

    const walResult = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('budget_config_deleted', $1, $2) RETURNING id`,
      [workspaceId, JSON.stringify({})]
    );
    if (walResult) {
      const walEvent = await queryOne<WalEvent>(
        'SELECT * FROM wal_events WHERE id = $1',
        [walResult.id]
      );
      if (walEvent) broadcastAll(walEvent);
    }

    res.json({ deleted: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Budget] Delete config');
  }
});

export default router;
