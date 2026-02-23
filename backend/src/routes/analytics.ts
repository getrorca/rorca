import { Router, Request, Response } from 'express';
import { db } from '../db/index';

const router = Router();

// ─── Types ───────────────────────────────────────────────────────────────────

interface UsageRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  count: number;
}

interface TimeSeriesRow {
  date: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

// ─── GET /api/analytics/usage — Aggregated token usage ───────────────────────
// Query params:
//   from    — ISO date string (inclusive), default 30 days ago
//   to      — ISO date string (inclusive), default now
//   group_by — 'spec' | 'story' | 'model' | 'user', default 'model'
//   workspace_id — optional filter

router.get('/usage', (req: Request, res: Response) => {
  try {
    const groupBy = (req.query.group_by as string) || 'model';
    const workspaceId = req.query.workspace_id as string | undefined;

    // Default date range: last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const validGroupBy = ['spec', 'story', 'model', 'user'];
    if (!validGroupBy.includes(groupBy)) {
      res.status(400).json({ error: `group_by must be one of: ${validGroupBy.join(', ')}` });
      return;
    }

    // Map group_by to SQL column
    const groupColumn: Record<string, string> = {
      spec: "REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '')",
      story: 'tu.story_id',
      model: 'tu.model',
      user: "COALESCE(tu.user_id, 'system')",
    };

    const groupCol = groupColumn[groupBy];
    const needsJoin = groupBy === 'spec';

    let sql = `
      SELECT
        ${groupCol} AS group_key,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        SUM(tu.cost_usd) AS total_cost_usd,
        COUNT(*) AS count
      FROM token_usage tu
    `;
    if (needsJoin) {
      sql += ' JOIN pipeline_runs pr ON tu.run_id = pr.id';
    }

    const params: (string | number)[] = [];
    sql += ' WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?';
    params.push(from, to);

    if (workspaceId) {
      sql += ' AND tu.workspace_id = ?';
      params.push(workspaceId);
    }

    sql += ` GROUP BY group_key ORDER BY total_cost_usd DESC`;

    const grouped = db.prepare(sql).all(...params) as UsageRow[];

    // Time series: daily aggregation
    let timeSeriesSql = `
      SELECT
        DATE(tu.recorded_at) AS date,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        SUM(tu.cost_usd) AS total_cost_usd
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
    `;
    const tsParams: (string | number)[] = [from, to];
    if (workspaceId) {
      timeSeriesSql += ' AND tu.workspace_id = ?';
      tsParams.push(workspaceId);
    }
    timeSeriesSql += ' GROUP BY DATE(tu.recorded_at) ORDER BY date ASC';

    const timeSeries = db.prepare(timeSeriesSql).all(...tsParams) as TimeSeriesRow[];

    // Summary totals
    let totalSql = `
      SELECT
        COALESCE(SUM(tu.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(tu.cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS total_records
      FROM token_usage tu
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
    `;
    const totParams: (string | number)[] = [from, to];
    if (workspaceId) {
      totalSql += ' AND tu.workspace_id = ?';
      totParams.push(workspaceId);
    }

    const totals = db.prepare(totalSql).get(...totParams) as {
      total_input_tokens: number;
      total_output_tokens: number;
      total_cost_usd: number;
      total_records: number;
    };

    // Active runs check (for auto-refresh hint)
    const activeRuns = db.prepare(
      `SELECT COUNT(*) AS count FROM pipeline_runs WHERE status = 'running'`
    ).get() as { count: number };

    res.json({
      grouped,
      timeSeries,
      totals,
      hasActiveRuns: activeRuns.count > 0,
      dateRange: { from, to },
      groupBy,
    });
  } catch (error: any) {
    console.error('[Analytics] Usage query error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
