import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';

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
function getSpendingSince(workspaceId: string, since: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total
     FROM token_usage
     WHERE workspace_id = ? AND recorded_at >= ?`
  ).get(workspaceId, since) as { total: number };
  return row.total;
}

/**
 * Check budget thresholds and emit WAL events if needed.
 * Called after recording token usage and after budget config changes.
 */
export function checkBudgetThresholds(workspaceId: string): {
  alertTriggered: boolean;
  capExceeded: boolean;
  spending: number;
  config: BudgetConfigRow | null;
} {
  const config = db.prepare(
    'SELECT * FROM budget_config WHERE workspace_id = ?'
  ).get(workspaceId) as BudgetConfigRow | undefined;

  if (!config) {
    return { alertTriggered: false, capExceeded: false, spending: 0, config: null };
  }

  const since = periodStart(config.period);
  const spending = getSpendingSince(workspaceId, since);

  let alertTriggered = false;
  let capExceeded = false;

  // Check alert threshold
  if (config.alert_threshold_usd != null && spending >= config.alert_threshold_usd) {
    alertTriggered = true;

    // Only emit if we haven't already emitted an alert this period
    const existingAlert = db.prepare(
      `SELECT id FROM wal_events
       WHERE event_type = 'budget_alert'
         AND workspace_id = ?
         AND ts >= ?
       LIMIT 1`
    ).get(workspaceId, since);

    if (!existingAlert) {
      const emails = JSON.parse(config.notify_emails) as string[];
      const walResult = db.prepare(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('budget_alert', ?, ?)`
      ).run(workspaceId, JSON.stringify({
        alert_threshold_usd: config.alert_threshold_usd,
        spending_usd: Math.round(spending * 1_000_000) / 1_000_000,
        period: config.period,
        period_start: since,
        notify_emails: emails,
      }));

      const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
        walResult.lastInsertRowid
      ) as WalEvent;
      broadcastAll(walEvent);
    }
  }

  // Check hard cap
  if (config.hard_cap_usd != null && spending >= config.hard_cap_usd) {
    capExceeded = true;
  }

  return { alertTriggered, capExceeded, spending, config };
}

// ─── POST /api/workspaces/:id/budget — Create or update budget config ────────

router.post('/', (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.id);
    const { alert_threshold_usd, hard_cap_usd, period, notify_emails } = req.body as {
      alert_threshold_usd?: number | null;
      hard_cap_usd?: number | null;
      period?: string;
      notify_emails?: string[];
    };

    // Validate workspace exists
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Validate period
    const validPeriods = ['daily', 'weekly', 'monthly'];
    const budgetPeriod = period || 'monthly';
    if (!validPeriods.includes(budgetPeriod)) {
      res.status(400).json({ error: `period must be one of: ${validPeriods.join(', ')}` });
      return;
    }

    // Validate thresholds
    if (alert_threshold_usd != null && alert_threshold_usd < 0) {
      res.status(400).json({ error: 'alert_threshold_usd cannot be negative' });
      return;
    }
    if (hard_cap_usd != null && hard_cap_usd < 0) {
      res.status(400).json({ error: 'hard_cap_usd cannot be negative' });
      return;
    }
    if (alert_threshold_usd != null && hard_cap_usd != null && alert_threshold_usd >= hard_cap_usd) {
      res.status(400).json({ error: 'alert_threshold_usd must be less than hard_cap_usd' });
      return;
    }

    const emailsJson = JSON.stringify(notify_emails || []);

    // Upsert
    db.prepare(`
      INSERT INTO budget_config (workspace_id, alert_threshold_usd, hard_cap_usd, period, notify_emails)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET
        alert_threshold_usd = excluded.alert_threshold_usd,
        hard_cap_usd = excluded.hard_cap_usd,
        period = excluded.period,
        notify_emails = excluded.notify_emails,
        updated_at = datetime('now')
    `).run(workspaceId, alert_threshold_usd ?? null, hard_cap_usd ?? null, budgetPeriod, emailsJson);

    // Emit WAL event for budget config change
    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('budget_config_updated', ?, ?)`
    ).run(workspaceId, JSON.stringify({
      alert_threshold_usd: alert_threshold_usd ?? null,
      hard_cap_usd: hard_cap_usd ?? null,
      period: budgetPeriod,
      notify_emails: notify_emails || [],
    }));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    // Check thresholds immediately (in case spending already exceeds new config)
    const budgetStatus = checkBudgetThresholds(workspaceId);

    const config = db.prepare(
      'SELECT * FROM budget_config WHERE workspace_id = ?'
    ).get(workspaceId) as BudgetConfigRow;

    res.json({
      config: {
        ...config,
        notify_emails: JSON.parse(config.notify_emails),
      },
      spending_usd: Math.round(budgetStatus.spending * 1_000_000) / 1_000_000,
      alert_triggered: budgetStatus.alertTriggered,
      cap_exceeded: budgetStatus.capExceeded,
    });
  } catch (error: any) {
    console.error('[Budget] Config update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/workspaces/:id/budget — Get budget config + current spending ───

router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.id);

    // Validate workspace exists
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const config = db.prepare(
      'SELECT * FROM budget_config WHERE workspace_id = ?'
    ).get(workspaceId) as BudgetConfigRow | undefined;

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
    const spending = getSpendingSince(workspaceId, since);
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
    console.error('[Budget] Get config error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/workspaces/:id/budget — Remove budget config ────────────────

router.delete('/', (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.params.id);
    const result = db.prepare('DELETE FROM budget_config WHERE workspace_id = ?').run(workspaceId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'No budget config found for this workspace' });
      return;
    }

    const walResult = db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('budget_config_deleted', ?, ?)`
    ).run(workspaceId, JSON.stringify({}));
    const walEvent = db.prepare('SELECT * FROM wal_events WHERE id = ?').get(
      walResult.lastInsertRowid
    ) as WalEvent;
    broadcastAll(walEvent);

    res.json({ deleted: true });
  } catch (error: any) {
    console.error('[Budget] Delete config error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
