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

// ─── GET /api/analytics/costs — Cost breakdowns by spec, run, model, time ────
// Query params:
//   from         — ISO date (inclusive), default 30 days ago
//   to           — ISO date (inclusive), default now
//   workspace_id — optional filter
//   group_by     — 'spec' | 'run' | 'model' | 'period', default 'spec'

interface CostRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  story_count: number;
}

interface PeriodCostRow {
  period: string;
  total_input_tokens: number;
  total_output_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  story_count: number;
}

router.get('/costs', (req: Request, res: Response) => {
  try {
    const groupBy = (req.query.group_by as string) || 'spec';
    const workspaceId = req.query.workspace_id as string | undefined;

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const from = (req.query.from as string) || thirtyDaysAgo.toISOString();
    const to = (req.query.to as string) || now.toISOString();

    const validGroupBy = ['spec', 'run', 'model', 'period'];
    if (!validGroupBy.includes(groupBy)) {
      res.status(400).json({ error: `group_by must be one of: ${validGroupBy.join(', ')}` });
      return;
    }

    // Cost calculation uses model_pricing join for actual provider rates
    // Formula: (input_tokens / 1,000,000) * input_cost_per_1m + (output_tokens / 1,000,000) * output_cost_per_1m

    const wsFilter = workspaceId ? 'AND tu.workspace_id = ?' : '';
    const wsParams: (string | number)[] = workspaceId ? [from, to, workspaceId] : [from, to];

    if (groupBy === 'period') {
      // Group by week
      const sql = `
        SELECT
          strftime('%Y-W%W', tu.recorded_at) AS period,
          SUM(tu.input_tokens) AS total_input_tokens,
          SUM(tu.output_tokens) AS total_output_tokens,
          SUM(CASE WHEN mp.input_cost_per_1m IS NOT NULL
            THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
            ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
          END) AS input_cost_usd,
          SUM(CASE WHEN mp.output_cost_per_1m IS NOT NULL
            THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
            ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
          END) AS output_cost_usd,
          SUM(tu.cost_usd) AS total_cost_usd,
          COUNT(*) AS story_count
        FROM token_usage tu
        LEFT JOIN model_pricing mp ON tu.model = mp.model_id
        WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
        ${wsFilter}
        GROUP BY period
        ORDER BY period ASC
      `;

      const periods = db.prepare(sql).all(...wsParams) as PeriodCostRow[];

      res.json({ groupBy, periods, dateRange: { from, to } });
      return;
    }

    // Non-period groupings (spec, run, model)
    const groupColumn: Record<string, string> = {
      spec: "REPLACE(REPLACE(pr.spec_path, 'ralph/specs/approved/', ''), '.json', '')",
      run: 'tu.run_id',
      model: 'tu.model',
    };
    const groupCol = groupColumn[groupBy];
    const needsRunJoin = groupBy === 'spec' || groupBy === 'run';

    const sql = `
      SELECT
        ${groupCol} AS group_key,
        SUM(tu.input_tokens) AS total_input_tokens,
        SUM(tu.output_tokens) AS total_output_tokens,
        SUM(CASE WHEN mp.input_cost_per_1m IS NOT NULL
          THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
          ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
        END) AS input_cost_usd,
        SUM(CASE WHEN mp.output_cost_per_1m IS NOT NULL
          THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
          ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
        END) AS output_cost_usd,
        SUM(tu.cost_usd) AS total_cost_usd,
        COUNT(*) AS story_count
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      ${needsRunJoin ? 'JOIN pipeline_runs pr ON tu.run_id = pr.id' : ''}
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
      ${wsFilter}
      GROUP BY group_key
      ORDER BY total_cost_usd DESC
    `;

    const breakdown = db.prepare(sql).all(...wsParams) as CostRow[];

    // Summary totals
    const totalSql = `
      SELECT
        COALESCE(SUM(tu.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(tu.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(CASE WHEN mp.input_cost_per_1m IS NOT NULL
          THEN (tu.input_tokens * 1.0 / 1000000) * mp.input_cost_per_1m
          ELSE (tu.input_tokens * 1.0 / 1000) * COALESCE(mp.input_cost_per_1k, 0)
        END), 0) AS total_input_cost_usd,
        COALESCE(SUM(CASE WHEN mp.output_cost_per_1m IS NOT NULL
          THEN (tu.output_tokens * 1.0 / 1000000) * mp.output_cost_per_1m
          ELSE (tu.output_tokens * 1.0 / 1000) * COALESCE(mp.output_cost_per_1k, 0)
        END), 0) AS total_output_cost_usd,
        COALESCE(SUM(tu.cost_usd), 0) AS total_cost_usd,
        COUNT(*) AS total_stories
      FROM token_usage tu
      LEFT JOIN model_pricing mp ON tu.model = mp.model_id
      WHERE tu.recorded_at >= ? AND tu.recorded_at <= ?
      ${wsFilter}
    `;

    const totals = db.prepare(totalSql).get(...wsParams) as {
      total_input_tokens: number;
      total_output_tokens: number;
      total_input_cost_usd: number;
      total_output_cost_usd: number;
      total_cost_usd: number;
      total_stories: number;
    };

    res.json({ groupBy, breakdown, totals, dateRange: { from, to } });
  } catch (error: any) {
    console.error('[Analytics] Costs query error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/analytics/pricing — List all model pricing entries ─────────────

interface ModelPricingFullRow {
  model_id: string;
  provider: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  effective_date: string;
  updated_at: string;
}

router.get('/pricing', (_req: Request, res: Response) => {
  try {
    const rows = db.prepare(
      'SELECT * FROM model_pricing ORDER BY model_id'
    ).all() as ModelPricingFullRow[];

    // Normalize to per-1M for display (use per-1M if available, else compute from per-1k)
    const pricing = rows.map(r => ({
      model_id: r.model_id,
      provider: r.provider || 'anthropic',
      input_cost_per_1m_tokens: r.input_cost_per_1m ?? r.input_cost_per_1k * 1000,
      output_cost_per_1m_tokens: r.output_cost_per_1m ?? r.output_cost_per_1k * 1000,
      effective_date: r.effective_date || r.updated_at,
      updated_at: r.updated_at,
    }));

    res.json({ pricing });
  } catch (error: any) {
    console.error('[Analytics] Pricing list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/analytics/pricing/:modelId — Update or create model pricing ────

router.put('/pricing/:modelId', (req: Request, res: Response) => {
  try {
    const modelId = req.params.modelId;
    const {
      provider,
      input_cost_per_1m_tokens,
      output_cost_per_1m_tokens,
      effective_date,
    } = req.body as {
      provider?: string;
      input_cost_per_1m_tokens: number;
      output_cost_per_1m_tokens: number;
      effective_date?: string;
    };

    if (input_cost_per_1m_tokens == null || output_cost_per_1m_tokens == null) {
      res.status(400).json({ error: 'input_cost_per_1m_tokens and output_cost_per_1m_tokens are required' });
      return;
    }

    if (input_cost_per_1m_tokens < 0 || output_cost_per_1m_tokens < 0) {
      res.status(400).json({ error: 'Costs cannot be negative' });
      return;
    }

    // Convert per-1M to per-1K for backward compat with existing cost-estimator
    const inputPer1k = input_cost_per_1m_tokens / 1000;
    const outputPer1k = output_cost_per_1m_tokens / 1000;
    const effDate = effective_date || new Date().toISOString();
    const prov = provider || 'anthropic';

    const existing = db.prepare(
      'SELECT model_id FROM model_pricing WHERE model_id = ?'
    ).get(modelId);

    if (existing) {
      db.prepare(`
        UPDATE model_pricing
        SET provider = ?,
            input_cost_per_1k = ?,
            output_cost_per_1k = ?,
            input_cost_per_1m = ?,
            output_cost_per_1m = ?,
            effective_date = ?,
            updated_at = datetime('now')
        WHERE model_id = ?
      `).run(prov, inputPer1k, outputPer1k, input_cost_per_1m_tokens, output_cost_per_1m_tokens, effDate, modelId);
    } else {
      db.prepare(`
        INSERT INTO model_pricing (model_id, provider, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m, effective_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(modelId, prov, inputPer1k, outputPer1k, input_cost_per_1m_tokens, output_cost_per_1m_tokens, effDate);
    }

    res.json({
      model_id: modelId,
      provider: prov,
      input_cost_per_1m_tokens,
      output_cost_per_1m_tokens,
      effective_date: effDate,
    });
  } catch (error: any) {
    console.error('[Analytics] Pricing update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/analytics/pricing/:modelId — Remove model pricing ───────────

router.delete('/pricing/:modelId', (req: Request, res: Response) => {
  try {
    const modelId = req.params.modelId;
    const result = db.prepare('DELETE FROM model_pricing WHERE model_id = ?').run(modelId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Model pricing not found' });
      return;
    }

    res.json({ deleted: modelId });
  } catch (error: any) {
    console.error('[Analytics] Pricing delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
